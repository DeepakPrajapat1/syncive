import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { config, encrypt, decrypt } from './src/config.js'
import { query, pool, logEvent, deadLetter } from './src/db/meta.js'
import { provisionTable, upsertRecords, markDeleted, countRows, testConnection } from './src/db/dest.js'
import { buildInstallUrl, verifyState } from './src/hubspot/oauth.js'
import { verifySignature, parseEvents, dedupe } from './src/hubspot/webhooks.js'

const results = []
const check = async (name, fn) => {
  try { await fn(); results.push(`PASS  ${name}`) }
  catch (err) { results.push(`FAIL  ${name}\n      ${err.message}`) }
}

// 1. encryption round-trip
await check('encrypt/decrypt round-trip', () => {
  const secret = 'postgres://user:p@ss w0rd@host:5432/db?sslmode=require'
  const enc = encrypt(secret)
  assert.notEqual(enc, secret)
  assert.equal(decrypt(enc), secret)
  assert.notEqual(encrypt(secret), enc, 'IV should differ per call')
})

await check('decrypt rejects tampered ciphertext', () => {
  const enc = encrypt('sensitive')
  const [iv, tag, data] = enc.split('.')
  const flipped = Buffer.from(data, 'base64'); flipped[0] ^= 0xff
  assert.throws(() => decrypt(`${iv}.${tag}.${flipped.toString('base64')}`))
})

// 2. OAuth state
await check('oauth state signs and verifies', () => {
  const accountId = crypto.randomUUID()
  const url = new URL(buildInstallUrl(accountId))
  const state = url.searchParams.get('state')
  assert.equal(verifyState(state), accountId)
  assert.ok(url.searchParams.get('scope').includes('crm.objects.contacts.read'))
})

await check('oauth state rejects forgery', () => {
  const state = Buffer.from(`${crypto.randomUUID()}.${Date.now()}.abc.deadbeef`).toString('base64url')
  assert.throws(() => verifyState(state), /Invalid OAuth state/)
})

// 3. webhook signature
await check('webhook signature verifies', () => {
  const body = JSON.stringify([{ objectId: 1 }])
  const ts = String(Date.now())
  const uri = 'http://localhost:8080/webhooks/hubspot'
  const sig = crypto.createHmac('sha256', config.hubspot.clientSecret)
    .update(`POST${uri}${body}${ts}`, 'utf8').digest('base64')
  assert.equal(verifySignature({ signature: sig, timestamp: ts, method: 'POST', uri, body }), true)
  assert.equal(verifySignature({ signature: 'wrong', timestamp: ts, method: 'POST', uri, body }), false)
})

await check('webhook signature rejects replay', () => {
  const body = '[]', uri = 'http://x', ts = String(Date.now() - 10 * 60_000)
  const sig = crypto.createHmac('sha256', config.hubspot.clientSecret)
    .update(`POST${uri}${body}${ts}`, 'utf8').digest('base64')
  assert.equal(verifySignature({ signature: sig, timestamp: ts, method: 'POST', uri, body }), false)
})

// 4. event parsing + dedupe
await check('parses and dedupes webhook events', () => {
  const events = parseEvents([
    { portalId: 1, subscriptionType: 'contact.propertyChange', objectId: 100, occurredAt: 1 },
    { portalId: 1, subscriptionType: 'contact.propertyChange', objectId: 100, occurredAt: 5 },
    { portalId: 1, subscriptionType: 'deal.creation', objectId: 200, occurredAt: 2 },
    { portalId: 1, subscriptionType: 'ticket.creation', objectId: 300, occurredAt: 3 },
  ])
  assert.equal(events.length, 3, 'unsupported object types filtered out')
  const deduped = dedupe(events)
  assert.equal(deduped.length, 2)
  assert.equal(deduped.find(e => e.hubspotId === '100').occurredAt, 5, 'keeps newest')
})

await check('marks deletions', () => {
  const [e] = parseEvents([{ portalId: 1, subscriptionType: 'company.deletion', objectId: 7 }])
  assert.equal(e.isDelete, true)
  assert.equal(e.objectType, 'companies')
})

// 5. destination provisioning + writes (real Postgres)
const DEST_DSN = 'postgres://postgres@localhost:5433/customer_db'

// Fresh slate so the suite is repeatable.
{
  const pg = (await import('pg')).default
  const p = new pg.Pool({ connectionString: DEST_DSN })
  await p.query('drop schema if exists hubspot cascade')
  await p.end()
}
let destinationId, accountId, syncId

await check('destination connection probe', async () => {
  const probe = await testConnection(DEST_DSN)
  assert.equal(probe.ok, true, probe.error)
  assert.equal(probe.database, 'customer_db')
  const bad = await testConnection('postgres://postgres@localhost:5433/nope_db')
  assert.equal(bad.ok, false)
})

const PROPS = [
  { name: 'email', type: 'string' },
  { name: 'firstname', type: 'string' },
  { name: 'annualrevenue', type: 'number' },
  { name: 'createdate', type: 'datetime' },
  { name: 'is_customer', type: 'bool' },
  { name: 'Weird Prop-Name!', type: 'string' },
]

await check('provisions schema and tables', async () => {
  accountId = (await query(`insert into syncive.accounts (email) values ($1) returning id`, [`t-${Date.now()}@e.com`])).rows[0].id
  destinationId = (await query(
    `insert into syncive.destinations (account_id, dsn_enc, schema_name, status) values ($1,$2,'hubspot','ready') returning id`,
    [accountId, encrypt(DEST_DSN)]
  )).rows[0].id

  const table = await provisionTable(destinationId, 'contacts', PROPS)
  assert.equal(table, 'hubspot.contacts')
})

await check('sanitizes hostile column names', async () => {
  const { rows } = await new (await import('pg')).default.Pool({ connectionString: DEST_DSN })
    .query(`select column_name from information_schema.columns where table_schema='hubspot' and table_name='contacts' order by 1`)
  const cols = rows.map(r => r.column_name)
  assert.ok(cols.includes('weird_prop_name_'), `got ${cols.join(',')}`)
  assert.ok(cols.includes('hs_object_id') && cols.includes('_synced_at') && cols.includes('_deleted'))
})

await check('upserts records with type coercion', async () => {
  const written = await upsertRecords(destinationId, 'contacts', PROPS, [
    { id: '1', properties: { email: 'a@b.com', firstname: 'Ada', annualrevenue: '50000', createdate: '2026-01-15T10:00:00Z', is_customer: 'true', 'Weird Prop-Name!': 'ok' } },
    { id: '2', properties: { email: 'c@d.com', firstname: null, annualrevenue: 'not-a-number', createdate: '', is_customer: 'false' } },
  ])
  assert.equal(written, 2)

  const pg = (await import('pg')).default
  const p = new pg.Pool({ connectionString: DEST_DSN })
  const { rows } = await p.query(`select hs_object_id, email, annualrevenue, is_customer, createdate from hubspot.contacts order by hs_object_id`)
  assert.equal(rows[0].email, 'a@b.com')
  assert.equal(Number(rows[0].annualrevenue), 50000)
  assert.equal(rows[0].is_customer, true)
  assert.ok(rows[0].createdate instanceof Date)
  assert.equal(rows[1].annualrevenue, null, 'garbage number becomes null, not a crash')
  assert.equal(rows[1].createdate, null)
  await p.end()
})

await check('upsert is idempotent (re-sync same record)', async () => {
  await upsertRecords(destinationId, 'contacts', PROPS, [
    { id: '1', properties: { email: 'updated@b.com', firstname: 'Ada L' } },
  ])
  assert.equal(await countRows(destinationId, 'contacts'), 2, 'still 2 rows, not 3')
  const pg = (await import('pg')).default
  const p = new pg.Pool({ connectionString: DEST_DSN })
  const { rows } = await p.query(`select email from hubspot.contacts where hs_object_id='1'`)
  assert.equal(rows[0].email, 'updated@b.com')
  await p.end()
})

await check('handles schema drift (new property appears later)', async () => {
  const extended = [...PROPS, { name: 'lifecyclestage', type: 'enumeration' }]
  await provisionTable(destinationId, 'contacts', extended)
  await upsertRecords(destinationId, 'contacts', extended, [
    { id: '3', properties: { email: 'e@f.com', lifecyclestage: 'customer' } },
  ])
  const pg = (await import('pg')).default
  const p = new pg.Pool({ connectionString: DEST_DSN })
  const { rows } = await p.query(`select lifecyclestage from hubspot.contacts where hs_object_id='3'`)
  assert.equal(rows[0].lifecyclestage, 'customer')
  await p.end()
})

await check('soft-deletes records', async () => {
  await markDeleted(destinationId, 'contacts', '2')
  assert.equal(await countRows(destinationId, 'contacts'), 2, 'deleted row excluded from count')
})

// 6. health rollup
await check('health endpoint query aggregates correctly', async () => {
  const connId = (await query(
    `insert into syncive.hubspot_connections (account_id, portal_id, access_token_enc, refresh_token_enc, expires_at)
     values ($1, 12345, $2, $3, now() + interval '1 hour') returning id`,
    [accountId, encrypt('at'), encrypt('rt')]
  )).rows[0].id
  syncId = (await query(
    `insert into syncive.syncs (account_id, connection_id, destination_id, object_type, state)
     values ($1,$2,$3,'contacts','live') returning id`,
    [accountId, connId, destinationId]
  )).rows[0].id

  await logEvent(syncId, { kind: 'webhook', status: 'ok', recordCount: 3 })
  await logEvent(syncId, { kind: 'webhook', status: 'failed', message: 'boom' })
  await deadLetter(syncId, '999', { objectId: 999 }, 'destination unreachable')

  const { rows } = await query(
    `select count(*) filter (where status='ok') ok, count(*) filter (where status='failed') failed,
            coalesce(sum(record_count),0) recs from syncive.sync_events where sync_id=$1`, [syncId])
  assert.equal(Number(rows[0].ok), 1)
  assert.equal(Number(rows[0].failed), 1)
  assert.equal(Number(rows[0].recs), 3)

  const { rows: dl } = await query(`select count(*)::int n from syncive.dead_letters where sync_id=$1 and resolved_at is null`, [syncId])
  assert.equal(dl[0].n, 1, 'failed record is recoverable, not lost')
})

await pool.end()
console.log(results.join('\n'))
const failed = results.filter(r => r.startsWith('FAIL')).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)
