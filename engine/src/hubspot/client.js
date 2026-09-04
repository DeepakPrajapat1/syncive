import { config, decrypt, encrypt } from '../config.js'
import { query } from '../db/meta.js'

const API = 'https://api.hubapi.com'

// HubSpot allows ~110 requests / 10s on Pro portals. We stay well under, per portal,
// because getting rate-limited mid-backfill is how sync tools earn their bad reviews.
const LIMIT_PER_WINDOW = 90
const WINDOW_MS = 10_000
const buckets = new Map() // portalId -> { count, resetAt }

async function throttle(portalId) {
  const now = Date.now()
  let b = buckets.get(portalId)
  if (!b || now >= b.resetAt) {
    b = { count: 0, resetAt: now + WINDOW_MS }
    buckets.set(portalId, b)
  }
  if (b.count >= LIMIT_PER_WINDOW) {
    await sleep(b.resetAt - now)
    return throttle(portalId)
  }
  b.count += 1
}

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)))

// ---- token lifecycle --------------------------------------------------------

// Distinguishable so callers can stop rather than retry: nothing about a
// revoked connection gets better by trying again.
export class RevokedError extends Error {
  constructor(message) {
    super(message)
    this.name = 'RevokedError'
    this.revoked = true
  }
}

// Mark the connection dead and stop its syncs. Destinations and the customer's
// own tables are left alone — reinstalling should pick up where it left off.
export async function revokeConnection(connectionId, reason) {
  await query(
    `update syncive.hubspot_connections
        set revoked_at = coalesce(revoked_at, now()), revoked_reason = $2
      where id = $1`,
    [connectionId, String(reason).slice(0, 500)]
  )
  const { rowCount } = await query(
    `update syncive.syncs set enabled = false where connection_id = $1 and enabled`,
    [connectionId]
  )
  console.warn(`[oauth] connection ${connectionId} revoked (${reason}); disabled ${rowCount} sync(s)`)
  return rowCount
}

export async function getAccessToken(connectionId) {
  const { rows } = await query(
    `select id, portal_id, access_token_enc, refresh_token_enc, expires_at,
            revoked_at, revoked_reason
       from syncive.hubspot_connections where id = $1`,
    [connectionId]
  )
  const conn = rows[0]
  if (!conn) throw new Error(`No HubSpot connection ${connectionId}`)
  if (conn.revoked_at) throw new RevokedError(conn.revoked_reason || 'HubSpot access was revoked')

  // Refresh a minute early — clock skew has ruined better systems than ours.
  if (new Date(conn.expires_at).getTime() - Date.now() > 60_000) {
    return { token: decrypt(conn.access_token_enc), portalId: Number(conn.portal_id) }
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: config.hubspot.clientId,
    client_secret: config.hubspot.clientSecret,
    refresh_token: decrypt(conn.refresh_token_enc),
  })
  const res = await fetch(`${API}/oauth/v1/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  if (!res.ok) {
    const detail = await res.text()
    // A refresh token is long-lived; HubSpot rejecting it outright means the
    // customer uninstalled the app or revoked our access. That is a decision,
    // not an outage, so stop retrying it forever and record why.
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      await revokeConnection(connectionId, 'HubSpot rejected the refresh token — the app was most likely uninstalled')
      throw new RevokedError('HubSpot access was revoked')
    }
    throw new Error(`Token refresh failed (${res.status}): ${detail}`)
  }
  const data = await res.json()

  await query(
    `update syncive.hubspot_connections
        set access_token_enc = $1, refresh_token_enc = $2, expires_at = $3
      where id = $4`,
    [
      encrypt(data.access_token),
      encrypt(data.refresh_token),
      new Date(Date.now() + data.expires_in * 1000),
      connectionId,
    ]
  )
  return { token: data.access_token, portalId: Number(conn.portal_id) }
}

// ---- request with retry -----------------------------------------------------

export async function hubspotRequest(connectionId, path, { method = 'GET', body, retries = 4 } = {}) {
  const { token, portalId } = await getAccessToken(connectionId)
  await throttle(portalId)

  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  })

  if (res.status === 429 || res.status >= 500) {
    if (retries <= 0) throw new Error(`HubSpot ${res.status} after retries: ${await res.text()}`)
    const retryAfter = Number(res.headers.get('retry-after')) * 1000
    const backoff = retryAfter || (5 - retries) ** 2 * 1000 + Math.random() * 500
    await sleep(backoff)
    return hubspotRequest(connectionId, path, { method, body, retries: retries - 1 })
  }

  if (res.status === 401) {
    // The token was valid enough to send; HubSpot refusing it means access is gone.
    await revokeConnection(connectionId, 'HubSpot returned 401 — the app was most likely uninstalled')
    throw new RevokedError('HubSpot access was revoked')
  }
  if (!res.ok) throw new Error(`HubSpot ${res.status} on ${path}: ${await res.text()}`)
  // A DELETE answers 204 with no body, and res.json() on an empty body throws.
  if (res.status === 204) return null
  return res.json()
}

// ---- object helpers ---------------------------------------------------------

export const OBJECT_TYPES = ['contacts', 'companies', 'deals']

// A portal's property definitions change when someone edits them in HubSpot —
// minutes-to-months apart, not seconds. But every webhook was re-fetching the
// whole list (hundreds of properties) before touching the record it actually
// came for: two API calls and a large response per event, which is what made a
// 500-record import take the better part of an hour to drain. A short TTL keeps
// schema drift getting picked up while collapsing a burst into one fetch.
const PROPERTIES_TTL_MS = 5 * 60_000
const propertiesCache = new Map()

// Remove the app from the customer's portal. Without this, "Disconnect" only
// stopped our side: the app stayed installed in HubSpot with its scopes still
// granted, which is not what the button says and not what the customer meant.
// HubSpot emails the portal's admins when this succeeds.
export async function uninstallApp(connectionId) {
  await hubspotRequest(connectionId, '/appinstalls/2026-03/external-install', { method: 'DELETE' })
}

export async function listProperties(connectionId, objectType, { fresh = false } = {}) {
  const key = `${connectionId}:${objectType}`
  const hit = propertiesCache.get(key)
  if (!fresh && hit && hit.expires > Date.now()) return hit.value

  // Concurrent callers share one in-flight request rather than each firing their own.
  if (!fresh && hit?.pending) return hit.pending

  const pending = hubspotRequest(connectionId, `/crm/v3/properties/${objectType}`)
    .then((data) => {
      const value = data.results.filter((p) => !p.calculated && !p.hidden)
      propertiesCache.set(key, { value, expires: Date.now() + PROPERTIES_TTL_MS })
      return value
    })
    .catch((err) => {
      propertiesCache.delete(key)
      throw err
    })

  propertiesCache.set(key, { ...hit, pending })
  return pending
}

export async function listPage(connectionId, objectType, { after, limit = 100, properties }) {
  const params = new URLSearchParams({ limit: String(limit) })
  if (after) params.set('after', after)
  if (properties?.length) params.set('properties', properties.join(','))
  return hubspotRequest(connectionId, `/crm/v3/objects/${objectType}?${params}`)
}

// HubSpot spells "when was this last touched" differently per object.
const MODIFIED_PROPERTY = {
  contacts: 'lastmodifieddate',
  companies: 'hs_lastmodifieddate',
  deals: 'hs_lastmodifieddate',
}

// The plain list endpoint returns records in ascending object-id order, which is
// useless for "what changed recently" — the first page is the oldest records in
// the portal. Search is the only endpoint that can filter and sort by modified
// date, so reconciliation has to go through it.
export async function searchModifiedSince(connectionId, objectType, { since, after, limit = 100, properties }) {
  const propertyName = MODIFIED_PROPERTY[objectType] || 'hs_lastmodifieddate'
  return hubspotRequest(connectionId, `/crm/v3/objects/${objectType}/search`, {
    method: 'POST',
    body: {
      filterGroups: [{ filters: [{ propertyName, operator: 'GTE', value: String(since) }] }],
      sorts: [{ propertyName, direction: 'DESCENDING' }],
      properties,
      limit,
      ...(after ? { after } : {}),
    },
  })
}

export async function getRecord(connectionId, objectType, id, properties) {
  const params = new URLSearchParams()
  if (properties?.length) params.set('properties', properties.join(','))
  try {
    return await hubspotRequest(connectionId, `/crm/v3/objects/${objectType}/${id}?${params}`)
  } catch (err) {
    if (String(err.message).includes('404')) return null // deleted between event and fetch
    throw err
  }
}
