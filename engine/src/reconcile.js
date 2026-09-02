import { listPage, listProperties } from './hubspot/client.js'
import { upsertRecords } from './db/dest.js'
import { logEvent, query } from './db/meta.js'

// The safety net. Webhooks get dropped — by us, by them, by the network — and the
// usual result is a table that silently drifts for weeks. Every hour we re-pull
// everything HubSpot says changed recently and re-apply it. Cheap, boring, and the
// reason we can put "we'll tell you when something breaks" on the website.
export async function reconcileSync(syncId, { lookbackMinutes = 90 } = {}) {
  const { rows } = await query(
    `select id, object_type, connection_id, destination_id from syncive.syncs
      where id = $1 and enabled and state = 'live'`,
    [syncId]
  )
  const sync = rows[0]
  if (!sync) return { skipped: true }

  const since = Date.now() - lookbackMinutes * 60_000
  const properties = await listProperties(sync.connection_id, sync.object_type)
  const propNames = properties.map((p) => p.name)

  let after
  let repaired = 0
  let scanned = 0

  // Search is ordered by lastmodifieddate desc, so we can stop as soon as we
  // fall out of the window instead of walking the whole portal.
  do {
    const data = await listPage(sync.connection_id, sync.object_type, {
      after,
      limit: 100,
      properties: propNames,
    })
    const records = data.results || []
    if (!records.length) break

    const stale = records.filter((r) => {
      const modified = new Date(r.updatedAt || r.properties?.lastmodifieddate || 0).getTime()
      return modified >= since
    })
    scanned += records.length

    if (stale.length) {
      repaired += await upsertRecords(sync.destination_id, sync.object_type, properties, stale)
    }
    if (stale.length < records.length) break // past the window

    after = data.paging?.next?.after
  } while (after && scanned < 2000)

  await logEvent(sync.id, {
    kind: 'reconcile',
    status: 'ok',
    recordCount: repaired,
    message: `scanned ${scanned}, repaired ${repaired}`,
  })
  await query(`update syncive.syncs set last_success_at = now() where id = $1`, [sync.id])
  return { scanned, repaired }
}

export async function reconcileAll() {
  const { rows } = await query(`select id from syncive.syncs where enabled and state = 'live'`)
  const results = []
  for (const row of rows) {
    try {
      results.push({ syncId: row.id, ...(await reconcileSync(row.id)) })
    } catch (err) {
      await logEvent(row.id, { kind: 'reconcile', status: 'failed', message: err.message })
      results.push({ syncId: row.id, error: err.message })
    }
  }
  return results
}
