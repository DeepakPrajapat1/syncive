import express from 'express'
import { encrypt } from '../config.js'
import { query } from '../db/meta.js'
import { closeDestPool, countRows, testConnection } from '../db/dest.js'
import { enqueueBackfill } from '../queue/jobs.js'
import { OBJECT_TYPES } from '../hubspot/client.js'
import { requireAccountApi, requireOwnAccount, requireOwnSync } from '../auth.js'

export const apiRouter = express.Router()

// Every route below needs a signed session. Knowing an id is no longer enough:
// the account comes from the cookie, and routes keyed by a sync id check that
// the sync belongs to it before doing anything.
apiRouter.use(requireAccountApi)

// Express 4 does not catch rejections from async handlers — an unhandled one
// takes the whole process down. Every handler below goes through this.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)

// --- destinations ------------------------------------------------------------

apiRouter.post('/destinations', wrap(async (req, res) => {
  const account_id = req.accountId
  const { dsn, schema_name = 'hubspot' } = req.body || {}
  if (!dsn) return res.status(400).json({ error: 'dsn is required' })

  const probe = await testConnection(dsn)
  if (!probe.ok) return res.status(400).json({ error: `Could not connect: ${probe.error}` })

  const { rows } = await query(
    `insert into syncive.destinations (account_id, dsn_enc, schema_name, status)
     values ($1, $2, $3, 'ready') returning id, schema_name, status, created_at`,
    [account_id, encrypt(dsn), schema_name]
  )
  res.json({ destination: rows[0], database: probe.database, server: probe.version })
}))

// Every destination this account has, with the syncs hanging off each one. A
// mis-click during setup can leave a second destination quietly writing the same
// rows into the same schema, and until you can see them you cannot tell.
apiRouter.get('/destinations', wrap(async (req, res) => {
  const { rows } = await query(
    `select d.id, d.schema_name, d.status, d.created_at,
            coalesce(json_agg(json_build_object(
              'id', s.id, 'object_type', s.object_type, 'state', s.state,
              'last_success_at', s.last_success_at
            ) order by s.object_type) filter (where s.id is not null), '[]') as syncs
       from syncive.destinations d
       left join syncive.syncs s on s.destination_id = d.id
      where d.account_id = $1
      group by d.id
      order by d.created_at`,
    [req.accountId]
  )
  res.json({ destinations: rows })
}))

// Remove a destination and the syncs that write through it. Nothing in the
// customer's own database is touched — their tables and rows stay exactly where
// they are; this only stops Syncive writing to them.
apiRouter.delete('/destinations/:destinationId', wrap(async (req, res) => {
  const { destinationId } = req.params

  const { rows: found } = await query(
    `select d.id, d.schema_name, count(s.id)::int as syncs
       from syncive.destinations d
       left join syncive.syncs s on s.destination_id = d.id
      where d.id = $1 and d.account_id = $2
      group by d.id`,
    [destinationId, req.accountId]
  )
  if (!found.length) return res.status(404).json({ error: 'not found' })

  // Refusing to delete the last one is not paternalism: an account with zero
  // destinations has no way back except support, and the mistake this endpoint
  // exists to fix is always "I have one too many".
  const { rows: total } = await query(
    `select count(*)::int as n from syncive.destinations where account_id = $1`,
    [req.accountId]
  )
  if (total[0].n <= 1) {
    return res.status(409).json({
      error: 'This is your only destination — connect another one before removing it.',
    })
  }

  // syncs, sync_events and dead_letters all cascade from destinations.
  await query(`delete from syncive.destinations where id = $1 and account_id = $2`, [
    destinationId,
    req.accountId,
  ])
  closeDestPool(destinationId)

  res.json({ removed: found[0].id, schema: found[0].schema_name, syncsRemoved: found[0].syncs })
}))

// --- syncs -------------------------------------------------------------------

apiRouter.post('/syncs', wrap(async (req, res) => {
  const account_id = req.accountId
  const { connection_id, destination_id, object_types = OBJECT_TYPES } = req.body || {}
  if (!connection_id || !destination_id) {
    return res.status(400).json({ error: 'connection_id and destination_id are required' })
  }

  // The connection and the destination are named by the caller, so check both
  // belong to the session's account before wiring one to the other — otherwise
  // a signed-in customer could point their own sync at someone else's database.
  const { rows: owned } = await query(
    `select
       (select count(*) from syncive.hubspot_connections where id = $1 and account_id = $3) as conns,
       (select count(*) from syncive.destinations       where id = $2 and account_id = $3) as dests`,
    [connection_id, destination_id, account_id]
  )
  if (Number(owned[0].conns) !== 1 || Number(owned[0].dests) !== 1) {
    return res.status(404).json({ error: 'not found' })
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
}))

// --- the health dashboard's data source --------------------------------------

// Which HubSpot portals this account has connected. Needed to create a sync,
// and to show a customer what they actually authorised.
apiRouter.get('/accounts/:accountId/connections', requireOwnAccount, wrap(async (req, res) => {
  const { accountId } = req.params
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(accountId)) {
    return res.status(400).json({ error: 'account_id must be a UUID' })
  }
  const { rows } = await query(
    `select id, portal_id, scopes, expires_at, created_at
       from syncive.hubspot_connections
      where account_id = $1
      order by created_at`,
    [accountId]
  )
  res.json({ connections: rows })
}))

apiRouter.get('/accounts/:accountId/health', requireOwnAccount, wrap(async (req, res) => {
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
}))

apiRouter.get('/syncs/:syncId/rows', requireOwnSync(), wrap(async (req, res) => {
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
}))

// Retry everything we couldn't deliver. One button, no support ticket.
// Re-run a backfill for one sync. Needed whenever a queued job died for reasons
// outside the sync itself — a bad deploy, a queue outage — and there was no way
// back other than editing the database by hand.
apiRouter.post('/syncs/:syncId/backfill', requireOwnSync(), wrap(async (req, res) => {
  const { syncId } = req.params
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(syncId)) {
    return res.status(400).json({ error: 'sync id must be a UUID' })
  }
  const { rows } = await query(
    `select id, object_type, enabled from syncive.syncs where id = $1`,
    [syncId]
  )
  if (!rows.length) return res.status(404).json({ error: 'no such sync' })
  if (!rows[0].enabled) return res.status(409).json({ error: 'sync is disabled' })

  // Start from the top: clear the checkpoint so this is a full re-read.
  await query(`update syncive.syncs set state = 'backfilling', backfill_cursor = null where id = $1`, [syncId])
  const jobId = await enqueueBackfill(syncId, { force: true })
  res.json({ queued: Boolean(jobId), jobId, sync: rows[0].object_type })
}))

apiRouter.post('/syncs/:syncId/retry-failures', requireOwnSync(), wrap(async (req, res) => {
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
}))
