import crypto from 'node:crypto'
import { config } from '../config.js'
import { getRecord, listProperties, revokeConnection } from './client.js'
import { markDeleted, upsertRecords } from '../db/dest.js'
import { deadLetter, logEvent, query } from '../db/meta.js'

// HubSpot v3 signature: sha256 over method + uri + body + timestamp, base64.
// Reject anything older than 5 minutes to kill replays.
export function verifySignature({ signature, timestamp, method, uri, body }) {
  if (!signature || !timestamp) return false
  // No client secret yet (app not created) => nothing can be trusted.
  if (!config.hubspot.clientSecret) return false
  if (Math.abs(Date.now() - Number(timestamp)) > 5 * 60_000) return false

  const raw = `${method}${uri}${body}${timestamp}`
  const expected = crypto
    .createHmac('sha256', config.hubspot.clientSecret)
    .update(raw, 'utf8')
    .digest('base64')

  const a = Buffer.from(signature)
  const b = Buffer.from(expected)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

const OBJECT_FROM_SUBSCRIPTION = {
  'contact.propertyChange': 'contacts',
  'contact.creation': 'contacts',
  'contact.deletion': 'contacts',
  'company.propertyChange': 'companies',
  'company.creation': 'companies',
  'company.deletion': 'companies',
  'deal.propertyChange': 'deals',
  'deal.creation': 'deals',
  'deal.deletion': 'deals',
}

// HubSpot does NOT publish an uninstall webhook — it silently drops the account's
// subscriptions and revokes the tokens. The real detection is a 401 or a refused
// refresh, handled in client.js. This stays as a belt-and-braces path in case a
// portal ever does send one; do not rely on it.
export const UNINSTALL_TYPES = new Set(['app.uninstalled', 'app.deauthorized'])

export function parseUninstalls(payload) {
  const events = Array.isArray(payload) ? payload : [payload]
  return [
    ...new Set(
      events
        .filter((e) => UNINSTALL_TYPES.has(e.subscriptionType))
        .map((e) => String(e.portalId))
        .filter(Boolean)
    ),
  ]
}

export async function revokePortal(portalId, reason) {
  const { rows } = await query(
    `select id from syncive.hubspot_connections where portal_id = $1 and revoked_at is null`,
    [String(portalId)]
  )
  for (const row of rows) await revokeConnection(row.id, reason)
  return rows.length
}

export function parseEvents(payload) {
  const events = Array.isArray(payload) ? payload : [payload]
  return events
    .map((e) => ({
      portalId: e.portalId,
      objectType: OBJECT_FROM_SUBSCRIPTION[e.subscriptionType],
      hubspotId: String(e.objectId),
      isDelete: String(e.subscriptionType || '').endsWith('.deletion'),
      occurredAt: e.occurredAt,
    }))
    .filter((e) => e.objectType && e.hubspotId)
}

// Collapse a burst of property changes on one record into a single fetch.
export function dedupe(events) {
  const seen = new Map()
  for (const e of events) {
    const key = `${e.portalId}:${e.objectType}:${e.hubspotId}`
    const prev = seen.get(key)
    if (!prev || e.isDelete || (e.occurredAt || 0) > (prev.occurredAt || 0)) seen.set(key, e)
  }
  return [...seen.values()]
}

// `isFinalAttempt` comes from the queue: false while pg-boss still has retries
// left. A failure that will be retried is logged but not dead-lettered, so the
// dead-letter table means "a human needs to look at this", not "something was
// briefly busy".
export async function applyEvent(event, { isFinalAttempt = true } = {}) {
  // A portal can legitimately be connected by more than one account — an agency and
  // their client, say — so fan the event out to every sync watching it.
  const { rows: syncs } = await query(
    `select s.id, s.connection_id, s.destination_id, s.object_type
       from syncive.syncs s
       join syncive.hubspot_connections c on c.id = s.connection_id
      where c.portal_id = $1 and s.object_type = $2 and s.enabled
      order by s.created_at`,
    [event.portalId, event.objectType]
  )
  if (!syncs.length) return { skipped: 'no matching sync' }

  const outcomes = []
  for (const sync of syncs) outcomes.push(await applyEventToSync(event, sync, isFinalAttempt))

  const failure = outcomes.find((o) => o.error)
  if (failure) throw new Error(failure.error)
  return { applied: true, syncs: outcomes.length }
}

async function applyEventToSync(event, sync, isFinalAttempt) {
  try {
    if (event.isDelete) {
      await markDeleted(sync.destination_id, sync.object_type, event.hubspotId)
      await logEvent(sync.id, { kind: 'webhook', status: 'ok', recordCount: 1, hubspotId: event.hubspotId, message: 'deleted' })
      return { syncId: sync.id, applied: true }
    }

    const properties = await listProperties(sync.connection_id, sync.object_type)
    const record = await getRecord(
      sync.connection_id,
      sync.object_type,
      event.hubspotId,
      properties.map((p) => p.name)
    )

    if (!record) {
      // Record vanished between the event and our fetch — treat as a delete.
      await markDeleted(sync.destination_id, sync.object_type, event.hubspotId)
      return { syncId: sync.id, applied: true, note: 'gone' }
    }

    await upsertRecords(sync.destination_id, sync.object_type, properties, [record])
    await query(`update syncive.syncs set last_event_at = now(), last_success_at = now() where id = $1`, [sync.id])
    await logEvent(sync.id, { kind: 'webhook', status: 'ok', recordCount: 1, hubspotId: event.hubspotId })
    return { syncId: sync.id, applied: true }
  } catch (err) {
    // Record it and let the other syncs still run. Park the payload only once
    // the queue is out of retries.
    await logEvent(sync.id, { kind: 'webhook', status: 'failed', hubspotId: event.hubspotId, message: err.message })
    if (isFinalAttempt) await deadLetter(sync.id, event.hubspotId, event, err.message)
    return { syncId: sync.id, error: err.message }
  }
}
