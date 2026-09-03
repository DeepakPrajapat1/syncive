import pg from 'pg'
import { decrypt } from '../config.js'
import { query } from './meta.js'

// Customer databases are strangers: short timeouts, small pools, and TLS when the
// server actually speaks it. Managed Postgres wants SSL; a self-hosted box behind a
// VPN often has none. Hard-coding either one strands half our customers, so we probe.
const poolCache = new Map()

const NO_SSL_ERRORS = ['does not support SSL', 'server does not support SSL connections']

function baseConfig(dsn) {
  // An explicit sslmode in the DSN is the customer telling us what they want.
  const explicit = /[?&]sslmode=/i.test(dsn)
  return { connectionString: dsn, explicitSslMode: explicit }
}

// Returns the ssl option this server accepts, or null if it speaks plaintext only.
export async function negotiateSsl(dsn) {
  const { explicitSslMode } = baseConfig(dsn)
  if (explicitSslMode) return undefined // let pg honour the DSN verbatim

  const attempt = async (ssl) => {
    const client = new pg.Client({ connectionString: dsn, connectionTimeoutMillis: 8_000, ssl })
    try {
      await client.connect()
      return true
    } finally {
      await client.end().catch(() => {})
    }
  }

  try {
    await attempt({ rejectUnauthorized: false })
    return { rejectUnauthorized: false }
  } catch (err) {
    if (NO_SSL_ERRORS.some((m) => String(err.message).includes(m))) return false
    throw err
  }
}

export async function getDestPool(destinationId) {
  if (poolCache.has(destinationId)) return poolCache.get(destinationId)

  const { rows } = await query(`select dsn_enc, schema_name from syncive.destinations where id = $1`, [
    destinationId,
  ])
  if (!rows[0]) throw new Error(`No destination ${destinationId}`)

  const dsn = decrypt(rows[0].dsn_enc)
  const ssl = await negotiateSsl(dsn)

  const pool = new pg.Pool({
    connectionString: dsn,
    max: 3,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 20_000,
    ...(ssl === undefined ? {} : { ssl }),
  })
  pool.on('error', (err) => console.error(`[dest ${destinationId}] idle client error`, err.message))

  const entry = { pool, schema: rows[0].schema_name }
  poolCache.set(destinationId, entry)
  return entry
}

// Removing a destination has to hand its connections back. The pool cache would
// otherwise keep a pool open to a destination nobody can reach any more, which
// on a pooler with a fixed client budget is a slow leak that ends as
// EMAXCONNSESSION somewhere unrelated.
export function closeDestPool(destinationId) {
  const entry = poolCache.get(destinationId)
  if (!entry) return false
  poolCache.delete(destinationId)
  entry.pool.end().catch((err) => console.error(`[dest ${destinationId}] close failed`, err.message))
  return true
}

export async function testConnection(dsn) {
  let ssl
  try {
    ssl = await negotiateSsl(dsn)
  } catch (err) {
    return { ok: false, error: err.message }
  }

  const client = new pg.Client({
    connectionString: dsn,
    connectionTimeoutMillis: 8_000,
    ...(ssl === undefined ? {} : { ssl }),
  })
  try {
    await client.connect()
    const { rows } = await client.query('select current_database() as db, version() as version')
    return {
      ok: true,
      database: rows[0].db,
      version: rows[0].version.split(' ').slice(0, 2).join(' '),
      tls: ssl !== false,
    }
  } catch (err) {
    return { ok: false, error: err.message }
  } finally {
    await client.end().catch(() => {})
  }
}

// ---- schema provisioning ----------------------------------------------------

// HubSpot property types -> Postgres column types. Anything unknown becomes text:
// a wrong-but-present column beats a failed sync.
const TYPE_MAP = {
  string: 'text',
  enumeration: 'text',
  phone_number: 'text',
  date: 'timestamptz',
  datetime: 'timestamptz',
  number: 'numeric',
  bool: 'boolean',
}

export const columnFor = (prop) => ({
  name: sanitize(prop.name),
  type: TYPE_MAP[prop.type] || 'text',
})

// Columns this table owns. HubSpot ships a property literally called
// hs_object_id, and two different property names can sanitize to the same
// column, so a naive properties -> columns map produces duplicates and Postgres
// rejects the whole insert. Provisioning and writing must agree on one list.
const RESERVED = new Set(['hs_object_id', '_raw', '_synced_at', '_deleted'])

export function mappableColumns(properties) {
  const seen = new Set()
  const out = []
  for (const prop of properties) {
    const col = columnFor(prop)
    if (RESERVED.has(col.name) || col.name.startsWith('_') || seen.has(col.name)) continue
    seen.add(col.name)
    out.push({ ...col, property: prop.name })
  }
  return out
}

// Postgres folds unquoted identifiers to lowercase and caps them at 63 bytes.
function sanitize(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/^([0-9])/, '_$1')
    .slice(0, 63)
}

export async function provisionTable(destinationId, objectType, properties) {
  const { pool, schema } = await getDestPool(destinationId)
  const table = `${schema}.${sanitize(objectType)}`
  const client = await pool.connect()

  try {
    await client.query(`create schema if not exists ${ident(schema)}`)
    await client.query(`
      create table if not exists ${table} (
        hs_object_id  text primary key,
        _synced_at    timestamptz not null default now(),
        _deleted      boolean     not null default false,
        _raw          jsonb
      )
    `)

    // Add any column we don't have yet. Schema drift is the #1 silent breakage
    // in hand-rolled pipelines, so we reconcile columns on every provision.
    const { rows: existing } = await client.query(
      `select column_name from information_schema.columns
        where table_schema = $1 and table_name = $2`,
      [schema, sanitize(objectType)]
    )
    const have = new Set(existing.map((r) => r.column_name))

    for (const col of mappableColumns(properties)) {
      if (have.has(col.name)) continue
      await client.query(`alter table ${table} add column if not exists ${ident(col.name)} ${col.type}`)
    }

    await client.query(
      `create index if not exists ${ident(sanitize(objectType) + '_synced_at_idx')}
         on ${table} (_synced_at desc)`
    )
    return table
  } finally {
    client.release()
  }
}

const ident = (name) => `"${String(name).replace(/"/g, '""')}"`

// ---- writes -----------------------------------------------------------------

export async function upsertRecords(destinationId, objectType, properties, records) {
  if (!records.length) return 0
  const { pool, schema } = await getDestPool(destinationId)
  const table = `${schema}.${sanitize(objectType)}`
  const cols = mappableColumns(properties)

  const columnNames = ['hs_object_id', ...cols.map((c) => c.name), '_raw', '_synced_at', '_deleted']
  const client = await pool.connect()

  try {
    await client.query('begin')
    for (const rec of records) {
      const values = [
        rec.id,
        ...cols.map((c) => coerce(rec.properties?.[c.property], c.type)),
        JSON.stringify(rec),
        new Date(),
        false,
      ]
      const placeholders = values.map((_, i) => `$${i + 1}`).join(', ')
      const updates = columnNames
        .filter((c) => c !== 'hs_object_id')
        .map((c) => `${ident(c)} = excluded.${ident(c)}`)
        .join(', ')

      await client.query(
        `insert into ${table} (${columnNames.map(ident).join(', ')})
         values (${placeholders})
         on conflict (hs_object_id) do update set ${updates}`,
        values
      )
    }
    await client.query('commit')
    return records.length
  } catch (err) {
    await client.query('rollback')
    throw err
  } finally {
    client.release()
  }
}

export async function markDeleted(destinationId, objectType, hubspotId) {
  const { pool, schema } = await getDestPool(destinationId)
  const table = `${schema}.${sanitize(objectType)}`
  // Soft delete: the customer decides what a removed CRM record means for them.
  await pool.query(
    `update ${table} set _deleted = true, _synced_at = now() where hs_object_id = $1`,
    [hubspotId]
  )
}

export async function countRows(destinationId, objectType) {
  const { pool, schema } = await getDestPool(destinationId)
  const table = `${schema}.${sanitize(objectType)}`
  const { rows } = await pool.query(`select count(*)::int as n from ${table} where not _deleted`)
  return rows[0].n
}

function coerce(value, type) {
  if (value === undefined || value === '' || value === null) return null
  if (type === 'boolean') return value === 'true' || value === true
  if (type === 'numeric') {
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }
  if (type === 'timestamptz') {
    const d = new Date(Number.isNaN(Number(value)) ? value : Number(value))
    return Number.isNaN(d.getTime()) ? null : d
  }
  return String(value)
}
