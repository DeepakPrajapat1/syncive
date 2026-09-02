// End-to-end backfill test against a stubbed HubSpot API and a real Postgres.
import assert from 'node:assert/strict'
import { encrypt } from './src/config.js'
import { query, pool } from './src/db/meta.js'
import { runBackfillChunk } from './src/hubspot/backfill.js'
import { applyEvent } from './src/hubspot/webhooks.js'
import { countRows } from './src/db/dest.js'

const DEST_DSN = 'postgres://postgres@localhost:5433/customer_db'
const TOTAL_CONTACTS = 512   // spans 6 pages at 100/page

// ---- fake HubSpot -----------------------------------------------------------
const PROPS = [
  { name: 'email', type: 'string' },
  { name: 'firstname', type: 'string' },
  { name: 'annualrevenue', type: 'number' },
]
const contact = (i) => ({
  id: String(i),
  updatedAt: new Date().toISOString(),
  properties: { email: `user${i}@example.com`, firstname: `User ${i}`, annualrevenue: String(i * 10) },
})

const PORTAL = 90000 + (Date.now() % 9000)
let apiCalls = 0
globalThis.fetch = async (url, opts) => {
  apiCalls++
  const u = new URL(url)
  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

  if (u.pathname === '/oauth/v1/token')
    return json({ access_token: 'new-at', refresh_token: 'new-rt', expires_in: 1800 })

  if (u.pathname.startsWith('/crm/v3/properties/')) return json({ results: PROPS })

  if (u.pathname.startsWith('/crm/v3/objects/')) {
    const parts = u.pathname.split('/')   // ['', 'crm', 'v3', 'objects', <type>, <id?>]
    const recordId = parts[5]
    if (recordId) return json(contact(Number(recordId)))
    const after = Number(u.searchParams.get('after') || 0)
    const limit = Number(u.searchParams.get('limit') || 100)
    const slice = []
    for (let i = after; i < Math.min(after + limit, TOTAL_CONTACTS); i++) slice.push(contact(i))
    const next = after + limit < TOTAL_CONTACTS ? { next: { after: String(after + limit) } } : {}
    return json({ results: slice, paging: next })
  }
  return json({ error: `unstubbed ${u.pathname}` }, 404)
}

// ---- fixtures ---------------------------------------------------------------
{
  const pg = (await import('pg')).default
  const p = new pg.Pool({ connectionString: DEST_DSN })
  await p.query('drop schema if exists hubspot cascade')
  await p.end()
}

const accountId = (await query(`insert into syncive.accounts (email) values ($1) returning id`, [`e2e-${Date.now()}@x.com`])).rows[0].id
const destId = (await query(
  `insert into syncive.destinations (account_id, dsn_enc, schema_name, status) values ($1,$2,'hubspot','ready') returning id`,
  [accountId, encrypt(DEST_DSN)]
)).rows[0].id
const connId = (await query(
  `insert into syncive.hubspot_connections (account_id, portal_id, access_token_enc, refresh_token_enc, expires_at)
   values ($1, $4, $2, $3, now() + interval '1 hour') returning id`,
  [accountId, encrypt('at'), encrypt('rt'), PORTAL]
)).rows[0].id
const syncId = (await query(
  `insert into syncive.syncs (account_id, connection_id, destination_id, object_type) values ($1,$2,$3,'contacts') returning id`,
  [accountId, connId, destId]
)).rows[0].id

const results = []
const check = async (name, fn) => {
  try { await fn(); results.push(`PASS  ${name}`) }
  catch (err) { results.push(`FAIL  ${name}\n      ${err.message}`) }
}

// ---- the actual run ---------------------------------------------------------
let runs = 0
await check('backfill paginates to completion across chunked runs', async () => {
  let done = false
  while (!done && runs < 10) {
    const r = await runBackfillChunk(syncId)
    done = r.done
    runs++
  }
  assert.equal(done, true, 'backfill finished')
  assert.equal(await countRows(destId, 'contacts'), TOTAL_CONTACTS)
})

await check('sync flips to live and clears its cursor', async () => {
  const { rows } = await query(`select state, backfill_cursor, backfilled_at from syncive.syncs where id=$1`, [syncId])
  assert.equal(rows[0].state, 'live')
  assert.equal(rows[0].backfill_cursor, null)
  assert.ok(rows[0].backfilled_at)
})

await check('every page was logged for the health dashboard', async () => {
  const { rows } = await query(
    `select count(*)::int pages, sum(record_count)::int recs from syncive.sync_events
      where sync_id=$1 and kind='backfill_page' and status='ok'`, [syncId])
  assert.equal(rows[0].pages, Math.ceil(TOTAL_CONTACTS / 100))
  assert.equal(rows[0].recs, TOTAL_CONTACTS)
})

await check('resumes from checkpoint instead of restarting', async () => {
  // Simulate a crash mid-backfill: rewind the cursor, run one chunk, confirm it
  // picks up from there rather than re-walking the portal from zero.
  await query(`update syncive.syncs set state='backfilling', backfill_cursor='500' where id=$1`, [syncId])
  const before = apiCalls
  const r = await runBackfillChunk(syncId)
  assert.equal(r.done, true)
  assert.ok(apiCalls - before < 5, `resumed cheaply (${apiCalls - before} calls, not a full re-walk)`)
})

await check('webhook update lands in the destination', async () => {
  await query(`update syncive.syncs set state='live' where id=$1`, [syncId])
  const out = await applyEvent({ portalId: PORTAL, objectType: 'contacts', hubspotId: '7', isDelete: false })
  assert.equal(out.applied, true)
  const pg = (await import('pg')).default
  const p = new pg.Pool({ connectionString: DEST_DSN })
  const { rows } = await p.query(`select email from hubspot.contacts where hs_object_id='7'`)
  assert.equal(rows[0].email, 'user7@example.com')
  await p.end()
})

await check('webhook delete soft-deletes', async () => {
  await applyEvent({ portalId: PORTAL, objectType: 'contacts', hubspotId: '7', isDelete: true })
  assert.equal(await countRows(destId, 'contacts'), TOTAL_CONTACTS - 1)
})

await pool.end()
console.log(results.join('\n'))
console.log(`\n${results.filter(r => r.startsWith('PASS')).length}/${results.length} passed  ·  ${apiCalls} HubSpot API calls, ${runs} chunk runs`)
process.exit(results.some(r => r.startsWith('FAIL')) ? 1 : 0)
