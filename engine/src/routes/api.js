import express from 'express'
import { encrypt } from '../config.js'
import { query } from '../db/meta.js'
import { countRows, testConnection } from '../db/dest.js'
import { enqueueBackfill } from '../queue/jobs.js'
import { OBJECT_TYPES } from '../hubspot/client.js'

export const apiRouter = express.Router()

// --- destinations ------------------------------------------------------------

apiRouter.post('/destinations', async (req, res) => {
  const { account_id, dsn, schema_name = 'hubspot' } = req.body || {}
  if (!account_id || !dsn) return res.status(400).json({ error: 'account_id and dsn are required' })

  const probe = await testConnection(dsn)
  if (!probe.ok) return res.status(400).json({ error: `Could not connect: ${probe.error}` })

  const { rows } = await query(
    `insert into syncive.destinations (account_id, dsn_enc, schema_name, status)
     values ($1, $2, $3, 'ready') returning id, schema_name, status, created_at`,
    [account_id, encrypt(dsn), schema_name]
  )
  res.json({ destination: rows[0], database: probe.database, server: probe.version })
})

// --- syncs -------------------------------------------------------------------

apiRouter.post('/syncs', async (req, res) => {
  const { account_id, connection_id, destination_id, object_types = OBJECT_TYPES } = req.body || {}
  if (!account_id || !connection_id || !destination_id) {
    return res.status(400).json({ error: 'account_id, connection_id and destination_id are required' })
  }

  const created = []
  for (const objectType of object_types) {
    if (!OBJECT_TYPES.includes(objectType)) continue
    const { rows } = await query(
      `insert into syncive.syncs (account_id, connection_id, destination_id, object_type)
       values ($1, $2, $3, $4)
       on conflict (destination_id, object_type) do update set enabled = true
       returning id, object_type, state`,
      [account_id, connection_id, destination_id, objectType]
    )
    created.push(rows[0])
    await enqueueBackfill(rows[0].id)
  }
  res.json({ syncs: created, message: 'Backfill queued' })
})

// --- the health dashboard's data source --------------------------------------

apiRouter.get('/accounts/:accountId/health', async (req, res) => {
  const { accountId } = req.params

  const { rows: syncs } = await query(
    `select s.id, s.object_type, s.state, s.backfilled_at, s.last_event_at, s.last_success_at,
            c.portal_id, d.schema_name
       from syncive.syncs s
       join syncive.hubspot_connections c on c.id = s.connection_id
       join syncive.destinations d on d.id = s.destination_id
      where s.account_id = $1
      order by s.object_type`,
    [accountId]
  )

  const detailed = await Promise.all(
    syncs.map(async (sync) => {
      const [{ rows: counts }, { rows: open }, { rows: recent }] = await Promise.all([
        query(
          `select
             count(*) filter (where status = 'ok'     and created_at > now() - interval '24 hours') as ok_24h,
             count(*) filter (where status = 'failed' and created_at > now() - interval '24 hours') as failed_24h,
             coalesce(sum(record_count) filter (where created_at > now() - interval '24 hours'), 0) as records_24h
           from syncive.sync_events where sync_id = $1`,
          [sync.id]
        ),
        query(
          `select count(*)::int as n from syncive.dead_letters where sync_id = $1 and resolved_at is null`,
          [sync.id]
        ),
        query(
          `select kind, status, record_count, message, created_at
             from syncive.sync_events where sync_id = $1
            order by created_at desc limit 5`,
          [sync.id]
        ),
      ])

      const stats = counts[0]
      const failed = Number(stats.failed_24h)
      const stuck = sync.last_success_at && Date.now() - new Date(sync.last_success_at).getTime() > 3 * 3600_000

      return {
        ...sync,
        health: failed > 0 || open[0].n > 0 ? 'degraded' : stuck ? 'stale' : 'healthy',
        events_ok_24h: Number(stats.ok_24h),
        events_failed_24h: failed,
        records_synced_24h: Number(stats.records_24h),
        unresolved_failures: open[0].n,
        recent: recent,
      }
    })
  )

  res.json({
    account_id: accountId,
    overall: detailed.some((s) => s.health !== 'healthy') ? 'attention' : 'healthy',
    syncs: detailed,
  })
})

apiRouter.get('/syncs/:syncId/rows', async (req, res) => {
  const { rows } = await query(
    `select destination_id, object_type from syncive.syncs where id = $1`,
    [req.params.syncId]
  )
  if (!rows[0]) return res.status(404).json({ error: 'not found' })
  try {
    const n = await countRows(rows[0].destination_id, rows[0].object_type)
    res.json({ rows: n })
  } catch (err) {
    res.status(502).json({ error: err.message })
  }
})

// Retry everything we couldn't deliver. One button, no support ticket.
apiRouter.post('/syncs/:syncId/retry-failures', async (req, res) => {
  const { rows } = await query(
    `select id, hubspot_id, payload from syncive.dead_letters
      where sync_id = $1 and resolved_at is null limit 500`,
    [req.params.syncId]
  )
  const { enqueueWebhookEvents } = await import('../queue/jobs.js')
  const events = rows.map((r) => r.payload).filter(Boolean)
  if (events.length) await enqueueWebhookEvents(events)
  await query(`update syncive.dead_letters set resolved_at = now() where id = any($1)`, [rows.map((r) => r.id)])
  res.json({ requeued: events.length })
})
