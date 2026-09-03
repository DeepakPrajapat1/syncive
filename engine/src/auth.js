import crypto from 'node:crypto'
import { config, sessionSecret } from './config.js'
import { query } from './db/meta.js'

// Until now the account id in the URL *was* the security model: anyone who saw a
// dashboard link — in a support ticket, a screen share, a browser history on a
// shared laptop — could read that account's sync health and trigger backfills
// against their database. It was also the worst part of the setup flow, because
// a human had to copy a UUID between two pages.
//
// One change fixes both. Finishing the HubSpot install mints a signed session
// cookie; every page and API route reads the account from that cookie, and the
// id never appears in a URL again.

const COOKIE = 'syncive_session'
const MAX_AGE_MS = 30 * 24 * 3600_000

const b64url = (buf) => Buffer.from(buf).toString('base64url')

const sign = (payload) => b64url(crypto.createHmac('sha256', sessionSecret).update(payload).digest())

export function mintSession(accountId) {
  const payload = `${accountId}.${Date.now() + MAX_AGE_MS}`
  return `${payload}.${sign(payload)}`
}

// Returns the account id, or null for anything we did not sign or that expired.
export function readSessionToken(token) {
  if (typeof token !== 'string') return null
  const cut = token.lastIndexOf('.')
  if (cut < 0) return null

  const payload = token.slice(0, cut)
  const provided = Buffer.from(token.slice(cut + 1))
  const expected = Buffer.from(sign(payload))
  // Comparing HMACs with === leaks their contents one byte at a time.
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) return null

  const [accountId, expiresAt] = payload.split('.')
  if (!accountId || Number(expiresAt) < Date.now()) return null
  return accountId
}

function parseCookies(header) {
  const out = {}
  for (const part of String(header || '').split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim())
  }
  return out
}

export function issueSession(res, accountId) {
  const secure = config.publicUrl.startsWith('https://')
  res.setHeader('Set-Cookie', [
    `${COOKIE}=${mintSession(accountId)}`,
    'Path=/',
    'HttpOnly',
    // Lax, not Strict: HubSpot finishes the install with a top-level redirect
    // back to us, and Strict would drop the cookie on exactly that request.
    'SameSite=Lax',
    `Max-Age=${Math.floor(MAX_AGE_MS / 1000)}`,
    ...(secure ? ['Secure'] : []),
  ].join('; '))
}

export function clearSession(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`)
}

export const accountOf = (req) => readSessionToken(parseCookies(req.headers.cookie)[COOKIE])

// For pages: no session means "you have not installed the app yet", which is a
// thing to explain, not a 401 to stare at.
export function requireAccountPage(req, res, next) {
  const accountId = accountOf(req)
  if (!accountId) return res.status(401).type('html').send(renderSignedOut())
  req.accountId = accountId
  next()
}

export function requireAccountApi(req, res, next) {
  const accountId = accountOf(req)
  if (!accountId) return res.status(401).json({ error: 'not signed in' })
  req.accountId = accountId
  next()
}

// A signed cookie says which account you are, not which rows you may touch.
// Routes keyed by something other than the account have to prove the link.
export function requireOwnAccount(req, res, next) {
  if (req.params.accountId !== req.accountId) return res.status(404).json({ error: 'not found' })
  next()
}

export const requireOwnSync = (paramName = 'syncId') =>
  async function ownsSync(req, res, next) {
    try {
      const { rows } = await query(`select 1 from syncive.syncs where id = $1 and account_id = $2`, [
        req.params[paramName],
        req.accountId,
      ])
      // 404 rather than 403: a wrong-account id and a nonexistent one should be
      // indistinguishable, or the error itself confirms which syncs exist.
      if (!rows.length) return res.status(404).json({ error: 'not found' })
      next()
    } catch (err) {
      next(err)
    }
  }

const renderSignedOut = () => `<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><meta name="robots" content="noindex,nofollow">
<title>Sign in — Syncive</title>
<style>
  body{font:16px/1.6 system-ui,-apple-system,sans-serif;background:#0b0e13;color:#e9eef5;
       display:grid;place-items:center;min-height:100vh;margin:0;padding:1rem}
  .card{max-width:26rem;padding:2rem;border:1px solid #222a36;border-radius:.75rem;background:#131822}
  h1{font-size:1.25rem;margin:0 0 .5rem}
  p{color:#9fb0c3;margin:0 0 1rem;font-size:.95rem}
  a{display:inline-block;background:#4c8dff;color:#fff;text-decoration:none;
    padding:.6rem 1rem;border-radius:.5rem;font-weight:600}
</style>
<div class="card">
  <h1>Sign in with HubSpot</h1>
  <p>Syncive knows who you are from the HubSpot portal you installed it into.
     Installing again signs you back in — it will not duplicate anything.</p>
  <a href="/oauth/install">Continue with HubSpot &rarr;</a>
</div>`
