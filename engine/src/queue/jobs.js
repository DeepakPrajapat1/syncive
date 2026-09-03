import PgBoss from 'pg-boss'
import { config } from '../config.js'
import { runBackfillChunk } from '../hubspot/backfill.js'
import { applyEvent } from '../hubspot/webhooks.js'
import { reconcileAll } from '../reconcile.js'
import { logEvent } from '../db/meta.js'

export const QUEUES = {
  backfill: 'sync.backfill',
  webhook: 'sync.webhook',
  reconcile: 'sync.reconcile',
}

let boss

export async function getBoss() {
  if (boss) return boss
  // pg-boss keeps its own pool. Left at its default it alone can eat most of a
  // pooler's per-project connection budget, starving the very jobs it dispatches.
  boss = new PgBoss({ connectionString: config.metaDatabaseUrl, schema: 'syncive_queue', max: 3 })
  boss.on('error', (err) => console.error('[pg-boss]', err.message))
  await boss.start()
  return boss
}

// The singleton key stops a chain of chunk jobs from fanning out. But it also
// means send() quietly returns null when an older job for the same sync is still
// sitting in the queue — including a dead one nobody will ever run. `force`
// skips the key, which is what a human asking for a re-sync means.
export async function enqueueBackfill(syncId, { force = false } = {}) {
  const b = await getBoss()
  const opts = { retryLimit: 3 }
  if (!force) opts.singletonKey = `backfill:${syncId}`
  const jobId = await b.send(QUEUES.backfill, { syncId }, opts)
  if (!jobId) console.warn(`[queue] backfill for ${syncId} collapsed into an existing job`)
  return jobId
}

export const WEBHOOK_RETRY_LIMIT = 5

export async function enqueueWebhookEvents(events) {
  const b = await getBoss()
  return Promise.all(
    events.map((event) =>
      b.send(QUEUES.webhook, event, {
        retryLimit: WEBHOOK_RETRY_LIMIT,
        retryDelay: 10,
        retryBackoff: true,
      })
    )
  )
}

// pg-boss hands a worker a single job object, but hands a *batch* worker an
// array. Destructuring one shape when you get the other throws before the
// handler body ever runs — silently, into pg-boss's retry machinery. Normalise
// so the handlers work either way and survive a pg-boss upgrade.
export const jobOf = (arg) => (Array.isArray(arg) ? arg[0] : arg)

export async function startWorkers() {
  const b = await getBoss()

  await b.work(QUEUES.backfill, { teamSize: 2, teamConcurrency: 1 }, async (arg) => {
    const job = jobOf(arg)
    const { syncId } = job.data
    console.log(`[backfill] ${syncId} starting chunk`)
    try {
      const result = await runBackfillChunk(syncId)
      console.log(`[backfill] ${syncId} chunk done:`, JSON.stringify(result))
      // Not finished? Queue the next chunk. Backfills survive restarts this way.
      if (!result.done) await enqueueBackfill(syncId)
      return result
    } catch (err) {
      // pg-boss records the failure but shows it nowhere we look, so a job that
      // dies here just repeats forever, silently. Say what happened.
      console.error(`[backfill] ${syncId} FAILED:`, err.message)
      if (err.stack) console.error(err.stack.split('\n').slice(1, 4).join('\n'))
      throw err
    }
  })

  // A 500-row CSV import fires 500 webhooks at once. Each one needs a meta client
  // and a destination client, so a wide worker pool doesn't go faster — it just
  // exhausts the connection budget and fails jobs that would have succeeded.
  await b.work(QUEUES.webhook, { teamSize: 2, teamConcurrency: 1 }, async (arg) => {
    const job = jobOf(arg)
    // Only park a payload for manual retry once pg-boss has given up on it.
    // Dead-lettering on the first error turns every transient blip into an entry
    // in a queue a human has to drain by hand.
    const isFinalAttempt = (job.retryCount ?? 0) >= WEBHOOK_RETRY_LIMIT
    try {
      return await applyEvent(job.data, { isFinalAttempt })
    } catch (err) {
      console.error(`[webhook] FAILED (attempt ${(job.retryCount ?? 0) + 1}):`, err.message)
      throw err
    }
  })

  await b.work(QUEUES.reconcile, async () => reconcileAll())

  // Hourly drift check for every live sync.
  await b.schedule(QUEUES.reconcile, '0 * * * *')

  console.log('[worker] queues running:', Object.values(QUEUES).join(', '))
  return b
}

export async function onJobFailure(syncId, message) {
  await logEvent(syncId, { kind: 'error', status: 'failed', message })
}
