import pg from 'pg'
import { config } from '../config.js'

export const pool = new pg.Pool({
  connectionString: config.metaDatabaseUrl,
  max: 8,
  idleTimeoutMillis: 30_000,
})

export const query = (text, params) => pool.query(text, params)

export async function tx(fn) {
  const client = await pool.connect()
  try {
    await client.query('begin')
    const out = await fn(client)
    await client.query('commit')
    return out
  } catch (err) {
    await client.query('rollback')
    throw err
  } finally {
    client.release()
  }
}

// --- event log: the source of truth behind the health dashboard --------------

export async function logEvent(syncId, { kind, status, recordCount = 0, hubspotId = null, message = null }) {
  await query(
    `insert into syncive.sync_events (sync_id, kind, status, record_count, hubspot_id, message)
     values ($1, $2, $3, $4, $5, $6)`,
    [syncId, kind, status, recordCount, hubspotId, message ? String(message).slice(0, 2000) : null]
  )
}

export async function deadLetter(syncId, hubspotId, payload, error) {
  await query(
    `insert into syncive.dead_letters (sync_id, hubspot_id, payload, error, attempts)
     values ($1, $2, $3, $4, 1)`,
    [syncId, hubspotId, payload ? JSON.stringify(payload) : null, String(error).slice(0, 2000)]
  )
}
