import crypto from 'node:crypto'
import { config, encrypt } from '../config.js'
import { query, tx } from '../db/meta.js'

const API = 'https://api.hubapi.com'

// Short-lived signed state, so the callback can't be replayed or forged.
export function buildInstallUrl(accountId) {
  const nonce = crypto.randomBytes(16).toString('hex')
  const issued = Date.now()
  const payload = `${accountId}.${issued}.${nonce}`
  const sig = crypto.createHmac('sha256', config.hubspot.clientSecret).update(payload).digest('hex')
  const state = Buffer.from(`${payload}.${sig}`).toString('base64url')

  const params = new URLSearchParams({
    client_id: config.hubspot.clientId,
    redirect_uri: config.hubspot.redirectUri,
    scope: config.hubspot.scopes.join(' '),
    state,
  })
  return `https://app.hubspot.com/oauth/authorize?${params}`
}

export function verifyState(state) {
  const raw = Buffer.from(String(state), 'base64url').toString('utf8')
  const [accountId, issued, nonce, sig] = raw.split('.')
  const expected = crypto
    .createHmac('sha256', config.hubspot.clientSecret)
    .update(`${accountId}.${issued}.${nonce}`)
    .digest('hex')
  const ok =
    sig &&
    sig.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
  if (!ok) throw new Error('Invalid OAuth state signature')
  if (Date.now() - Number(issued) > 10 * 60_000) throw new Error('OAuth state expired')
  return accountId
}

export async function exchangeCode(code) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: config.hubspot.clientId,
    client_secret: config.hubspot.clientSecret,
    redirect_uri: config.hubspot.redirectUri,
    code,
  })
  const res = await fetch(`${API}/oauth/v1/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  if (!res.ok) throw new Error(`Code exchange failed (${res.status}): ${await res.text()}`)
  return res.json()
}

export async function tokenInfo(accessToken) {
  const res = await fetch(`${API}/oauth/v1/access-tokens/${accessToken}`)
  if (!res.ok) throw new Error(`Token introspection failed (${res.status})`)
  return res.json()
}

export async function saveConnection(accountId, tokens) {
  const info = await tokenInfo(tokens.access_token)
  return tx(async (client) => {
    const { rows } = await client.query(
      `insert into syncive.hubspot_connections
         (account_id, portal_id, access_token_enc, refresh_token_enc, expires_at, scopes)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (account_id, portal_id) do update
         set access_token_enc  = excluded.access_token_enc,
             refresh_token_enc = excluded.refresh_token_enc,
             expires_at        = excluded.expires_at,
             scopes            = excluded.scopes
       returning id, portal_id`,
      [
        accountId,
        info.hub_id,
        encrypt(tokens.access_token),
        encrypt(tokens.refresh_token),
        new Date(Date.now() + tokens.expires_in * 1000),
        info.scopes || [],
      ]
    )
    return rows[0]
  })
}

export async function findAccountByPortal(portalId) {
  const { rows } = await query(
    `select account_id, id as connection_id from syncive.hubspot_connections where portal_id = $1`,
    [portalId]
  )
  return rows[0] || null
}
