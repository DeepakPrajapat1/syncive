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
  boss = new PgBoss({ connectionString: config.metaDatabaseUrl, schema: 'syncive_queue' })
  boss.on('error', (err) => console.error('[pg-boss]', err.message))
  await boss.start()
  return boss
}

export async function enqueueBackfill(syncId) {
  const b = await getBoss()
  return b.send(QUEUES.backfill, { syncId }, { singletonKey: `backfill:${syncId}`, retryLimit: 3 })
}

export async function enqueueWebhookEvents(events) {
  const b = await getBoss()
  return Promise.all(
    events.map((event) =>
      b.send(QUEUES.webhook, event, {
        retryLimit: 5,
        retryDelay: 10,
        retryBackoff: true,
      })
    )
  )
}

export async function startWorkers() {
  const b = await getBoss()

  await b.work(QUEUES.backfill, { teamSize: 2, teamConcurrency: 1 }, async ([job]) => {
    const { syncId } = job.data
    const result = await runBackfillChunk(syncId)
    // Not finished? Queue the next chunk. Backfills survive restarts this way.
    if (!result.done) await enqueueBackfill(syncId)
    return result
  })

  await b.work(QUEUES.webhook, { teamSize: 4, teamConcurrency: 2 }, async ([job]) => {
    return applyEvent(job.data)
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
