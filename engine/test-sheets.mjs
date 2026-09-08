import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { encrypt } from './src/config.js'
import { pool, query } from './src/db/meta.js'

// Google is stubbed, but everything below it is the real writer: the header
// diff, the row map, the append-offset arithmetic and the A1 ranges. Those are
// where a sync silently writes a customer's contact into the wrong row.

const calls = []
let sheetHeader = []
let nextAppendRow = 2

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url)
  let body = null
  try { body = opts.body ? JSON.parse(opts.body) : null } catch { body = null }
  calls.push({ url: u, method: opts.method || 'GET', body })

  if (u.includes('oauth2.googleapis.com/token')) {
    return json({ access_token: 'tok', expires_in: 3600 })
  }
  if (u.includes('/values:batchUpdate')) {
    for (const range of body.data) {
      if (/!A1:[A-Z]+1$/.test(range.range)) sheetHeader = range.values[0]
    }
    return json({ totalUpdatedCells: 1 })
  }
  if (u.includes(':append')) {
    const start = nextAppendRow
    nextAppendRow += body.values.length
    return json({ updates: { updatedRange: `contacts!A${start}:Z${nextAppendRow - 1}` } })
  }
  if (u.includes('/values/')) {
    return json({ values: sheetHeader.map((h) => [h]) })
  }
  // spreadsheets.get
  return json({ properties: { title: 'Test' }, sheets: [{ properties: { title: 'contacts', sheetId: 0 } }] })
}
const json = (o) => ({ ok: true, status: 200, json: async () => o, text: async () => JSON.stringify(o) })

const { provision, upsert, markDeletedRow, count } = await import('./src/sheets/writer.js')

const results = []
const check = async (name, fn) => {
  try { await fn(); results.push(`PASS  ${name}`) }
  catch (err) { results.push(`FAIL  ${name}\n      ${err.message}`) }
}

// Real rows in a real database — only Google is fake.
await query(`create schema if not exists syncive`)
await query(`create table if not exists syncive.destinations (
  id uuid primary key default gen_random_uuid(), account_id uuid, kind text default 'postgres',
  dsn_enc text, config_enc text, schema_name text, status text, created_at timestamptz default now())`)
await query(`create table if not exists syncive.syncs (id uuid primary key default gen_random_uuid())`)
await query(`create table if not exists syncive.sheet_rows (
  sync_id uuid not null, hubspot_id text not null, row_number integer not null,
  primary key (sync_id, hubspot_id))`)

const SYNC = crypto.randomUUID()
await query(`insert into syncive.syncs (id) values ($1) on conflict do nothing`, [SYNC])
const { rows: d } = await query(
  `insert into syncive.destinations (kind, config_enc, schema_name, status)
   values ('sheets', $1, 'sheets', 'ready') returning id`,
  [encrypt(JSON.stringify({ refreshToken: 'r', spreadsheetId: 'SHEET1' }))]
)
const DEST = d[0].id

const props = [
  { name: 'email', type: 'string' },
  { name: 'firstname', type: 'string' },
]
const rec = (id, p) => ({ id, properties: p })

await check('provision writes a header with our fixed columns first and last', async () => {
  await provision(DEST, 'contacts', props)
  assert.deepEqual(sheetHeader, ['hs_object_id', 'email', 'firstname', '_synced_at', '_deleted'])
})

await check('new records are appended and their row numbers remembered', async () => {
  await upsert(DEST, 'contacts', props, [rec('1', { email: 'a@b.c' }), rec('2', { email: 'd@e.f' })], SYNC)
  const { rows } = await query(
    `select hubspot_id, row_number from syncive.sheet_rows where sync_id = $1 order by row_number`, [SYNC])
  assert.deepEqual(rows, [{ hubspot_id: '1', row_number: 2 }, { hubspot_id: '2', row_number: 3 }])
})

await check('a record we have seen updates its own row, and does not append', async () => {
  calls.length = 0
  await upsert(DEST, 'contacts', props, [rec('2', { email: 'changed@e.f' })], SYNC)
  assert.equal(calls.filter((c) => c.url.includes(':append')).length, 0, 'must not append a known record')
  const write = calls.find((c) => c.url.includes('/values:batchUpdate'))
  assert.equal(write.body.data[0].range, 'contacts!A3:E3', 'writes exactly that row')
  assert.equal(write.body.valueInputOption, 'RAW', 'RAW, so a value starting with = is not executed')
})

await check('a value that looks like a formula is written as text', async () => {
  calls.length = 0
  await upsert(DEST, 'contacts', props, [rec('2', { email: '=IMPORTRANGE("evil","A1")' })], SYNC)
  const write = calls.find((c) => c.url.includes('/values:batchUpdate'))
  assert.equal(write.body.valueInputOption, 'RAW')
  assert.ok(write.body.data[0].values[0].includes('=IMPORTRANGE("evil","A1")'))
})

await check('a new HubSpot property is appended to the header, never inserted', async () => {
  const drifted = [...props, { name: 'jobtitle', type: 'string' }]
  await upsert(DEST, 'contacts', drifted, [rec('3', { jobtitle: 'CTO' })], SYNC)
  assert.deepEqual(sheetHeader, ['hs_object_id', 'email', 'firstname', '_synced_at', '_deleted', 'jobtitle'])
})

await check('a column the customer added is left untouched', async () => {
  sheetHeader = [...sheetHeader, 'my_own_notes']
  calls.length = 0
  await upsert(DEST, 'contacts', props, [rec('1', { email: 'a@b.c' })], SYNC)
  const write = calls.find((c) => c.url.includes('/values:batchUpdate'))
  const row = write.body.data[0].values[0]
  assert.equal(row[sheetHeader.indexOf('my_own_notes')], '', 'writes blank, not a value')
})

await check('deleting flags the row instead of removing it', async () => {
  calls.length = 0
  await markDeletedRow(DEST, 'contacts', '1', SYNC)
  const write = calls.find((c) => c.url.includes('/values:batchUpdate'))
  const flag = write.body.data.find((r) => r.values[0][0] === 'TRUE')
  assert.ok(flag, 'sets _deleted TRUE')
  assert.match(flag.range, /^contacts!E2$/, 'on that row, in the _deleted column')
})

await check('count reflects what we have written', async () => {
  assert.equal(await count(DEST, 'contacts', SYNC), 3)
})

await query(`delete from syncive.sheet_rows where sync_id = $1`, [SYNC])
await pool.end()
console.log(results.join('\n'))
const failed = results.filter((r) => r.startsWith('FAIL')).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)
