import { listPage, listProperties } from './client.js'
import { provisionTable, upsertRecords } from '../db/dest.js'
import { logEvent, query } from '../db/meta.js'

const PAGE_SIZE = 100
// Pages per job run. We stop and re-queue instead of running forever, so a crash
// costs one page, not the whole backfill.
const PAGES_PER_RUN = 25

export async function runBackfillChunk(syncId) {
  const { rows } = await query(
    `select s.id, s.object_type, s.backfill_cursor, s.connection_id, s.destination_id
       from syncive.syncs s where s.id = $1`,
    [syncId]
  )
  const sync = rows[0]
  if (!sync) throw new Error(`No sync ${syncId}`)

  // The first chunk of a backfill is where a customer expects new HubSpot fields
  // to show up as new columns, so that one bypasses the cache.
  const properties = await listProperties(sync.connection_id, sync.object_type, {
    fresh: !sync.backfill_cursor,
  })
  await provisionTable(sync.destination_id, sync.object_type, properties)
  const propNames = properties.map((p) => p.name)

  await query(`update syncive.syncs set state = 'backfilling' where id = $1 and state <> 'backfilling'`, [syncId])

  let cursor = sync.backfill_cursor
  let total = 0

  for (let page = 0; page < PAGES_PER_RUN; page++) {
    const data = await listPage(sync.connection_id, sync.object_type, {
      after: cursor,
      limit: PAGE_SIZE,
      properties: propNames,
    })
    const records = data.results || []

    if (records.length) {
      const written = await upsertRecords(sync.destination_id, sync.object_type, properties, records)
      total += written
      await logEvent(syncId, { kind: 'backfill_page', status: 'ok', recordCount: written })
    }

    cursor = data.paging?.next?.after || null

    // Checkpoint after every page: resume, never restart.
    await query(`update syncive.syncs set backfill_cursor = $1, last_success_at = now() where id = $2`, [
      cursor,
      syncId,
    ])

    if (!cursor) {
      await query(
        `update syncive.syncs set state = 'live', backfilled_at = now(), backfill_cursor = null where id = $1`,
        [syncId]
      )
      return { done: true, written: total }
    }
  }

  return { done: false, written: total, cursor }
}
