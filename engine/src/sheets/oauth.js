import crypto from 'node:crypto'
import { decrypt, encrypt, requireGoogle } from '../config.js'
import { query } from '../db/meta.js'

const TOKEN_URL = 'https://oauth2.googleapis.com/token'

// Same signed-state shape as the HubSpot install: the account id has to survive a
// round trip through a service we do not control, and nothing coming back from
// that service is trusted until the signature checks out.
export function buildAuthUrl(accountId) {
  const g = requireGoogle()
  const nonce = crypto.randomBytes(16).toString('hex')
  const payload = `${accountId}.${Date.now()}.${nonce}`
  const sig = crypto.createHmac('sha256', g.clientSecret).update(payload).digest('hex')

  const params = new URLSearchParams({
    client_id: g.clientId,
    redirect_uri: g.redirectUri,
    response_type: 'code',
    scope: g.scopes.join(' '),
    // Without offline we get no refresh token and the sync dies in an hour.
    access_type: 'offline',
    // Google only issues a refresh token on the first consent unless we insist.
    // A customer reconnecting would otherwise land us with an access token and
    // no way to renew it.
    prompt: 'consent',
    include_granted_scopes: 'true',
    state: Buffer.from(`${payload}.${sig}`).toString('base64url'),
  })
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`
}

export function verifyState(state) {
  const g = requireGoogle()
  const raw = Buffer.from(String(state), 'base64url').toString('utf8')
  const [accountId, issued, nonce, sig] = raw.split('.')
  const expected = crypto
    .createHmac('sha256', g.clientSecret)
    .update(`${accountId}.${issued}.${nonce}`)
    .digest('hex')
  const ok =
    sig &&
    sig.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
  if (!ok) throw new Error('Invalid Google OAuth state signature')
  if (Date.now() - Number(issued) > 10 * 60_000) throw new Error('Google OAuth state expired')
  return accountId
}

export async function exchangeCode(code) {
  const g = requireGoogle()
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: g.clientId,
      client_secret: g.clientSecret,
      redirect_uri: g.redirectUri,
      grant_type: 'authorization_code',
    }),
  })
  if (!res.ok) throw new Error(`Google code exchange failed (${res.status}): ${await res.text()}`)
  const data = await res.json()
  if (!data.refresh_token) {
    // Happens when the user has consented before and Google decides not to
    // re-issue. Better to stop here than to store a credential that expires in
    // an hour and looks fine until it doesn't.
    throw new Error('Google did not return a refresh token — revoke Syncive at myaccount.google.com and try again')
  }
  return data
}

// A destination's Google credentials, refreshed if the access token is stale.
// The refresh token is the only durable secret; access tokens live an hour.
export async function getSheetsToken(destinationId) {
  const { rows } = await query(`select id, config_enc from syncive.destinations where id = $1`, [
    destinationId,
  ])
  if (!rows[0]?.config_enc) throw new Error(`No Google credentials for destination ${destinationId}`)
  const config = JSON.parse(decrypt(rows[0].config_enc))

  if (config.accessToken && config.expiresAt && config.expiresAt - Date.now() > 60_000) {
    return { token: config.accessToken, config }
  }

  const g = requireGoogle()
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: config.refreshToken,
      client_id: g.clientId,
      client_secret: g.clientSecret,
      grant_type: 'refresh_token',
    }),
  })
  if (!res.ok) {
    const detail = await res.text()
    // Google says invalid_grant for a revoked or expired refresh token. Like
    // HubSpot's 401, that is the customer's decision, not an outage.
    if (res.status === 400 || res.status === 401) {
      const err = new Error('Google access was revoked — reconnect the spreadsheet')
      err.revoked = true
      throw err
    }
    throw new Error(`Google token refresh failed (${res.status}): ${detail}`)
  }
  const data = await res.json()

  const next = {
    ...config,
    accessToken: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  }
  await query(`update syncive.destinations set config_enc = $2 where id = $1`, [
    destinationId,
    encrypt(JSON.stringify(next)),
  ])
  return { token: data.access_token, config: next }
}
