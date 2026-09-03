import assert from 'node:assert/strict'
import PgBoss from 'pg-boss'
import { jobOf } from './src/queue/jobs.js'

// The unit tests call runBackfillChunk() and applyEvent() directly, so for a long
// while nothing exercised the path a job actually takes: enqueue -> pg-boss ->
// handler. That gap hid a bug where every job threw before its first line,
// because the handler destructured `[job]` while pg-boss passes one job object.
// This file tests the seam itself against a real pg-boss.

const results = []
const check = async (name, fn) => {
  try { await fn(); results.push(`PASS  ${name}`) }
  catch (err) { results.push(`FAIL  ${name}\n      ${err.message}`) }
}

const SCHEMA = `queue_test_${Date.now().toString(36)}`
const boss = new PgBoss({ connectionString: process.env.META_DATABASE_URL, schema: SCHEMA })
boss.on('error', (err) => console.error('[pg-boss]', err.message))
await boss.start()

await check('jobOf unwraps both shapes pg-boss can hand a worker', () => {
  const job = { id: 'x', data: { syncId: 's1' } }
  assert.deepEqual(jobOf(job), job, 'single job object')
  assert.deepEqual(jobOf([job]), job, 'batch array')
})

await check('a queued job actually reaches its handler with its payload', async () => {
  let seen = null
  let threw = null
  await boss.work('probe', { teamSize: 2, teamConcurrency: 1 }, async (arg) => {
    try { seen = jobOf(arg).data } catch (err) { threw = err }
  })
  await boss.send('probe', { syncId: 'abc-123' })

  for (let i = 0; i < 40 && !seen && !threw; i++) await new Promise((r) => setTimeout(r, 250))
  assert.equal(threw, null, `handler threw: ${threw && threw.message}`)
  assert.deepEqual(seen, { syncId: 'abc-123' }, 'payload arrives intact')
})

// The old code, pinned so nobody reintroduces it.
await check('destructuring the job as an array is what used to break', async () => {
  let threw = null
  await boss.work('probe_old', { teamSize: 1 }, async (arg) => {
    try { const [job] = arg; void job } catch (err) { threw = err }
  })
  await boss.send('probe_old', { syncId: 'abc-123' })
  for (let i = 0; i < 40 && !threw; i++) await new Promise((r) => setTimeout(r, 250))
  assert.ok(threw, 'pg-boss passes an object, so array destructuring must throw')
  assert.match(threw.message, /is not iterable/)
})

await boss.stop({ graceful: false })

// Leave no test schemas behind.
const { Pool } = (await import('pg')).default
const pool = new Pool({ connectionString: process.env.META_DATABASE_URL })
await pool.query(`drop schema if exists ${SCHEMA} cascade`)
await pool.end()

console.log(results.join('\n'))
const failed = results.filter((r) => r.startsWith('FAIL')).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)
