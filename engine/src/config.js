import crypto from 'node:crypto'

const required = (name) => {
  const v = process.env[name]
  if (!v) throw new Error(`Missing required env var: ${name}`)
  return v
}

const port = Number(process.env.PORT || 8080)
// RENDER_EXTERNAL_URL is set by Render automatically, so a deploy knows its own
// address without anyone configuring it. PUBLIC_URL overrides it (custom domain).
const publicUrl = (
  process.env.PUBLIC_URL ||
  process.env.RENDER_EXTERNAL_URL ||
  `http://localhost:${port}`
).replace(/\/+$/, '')

export const config = {
  port,
  publicUrl,
  metaDatabaseUrl: required('META_DATABASE_URL'),
  // Run the queue workers inside the web process. Needed on single-service
  // hosts (Render free tier) where a separate worker dyno isn't available.
  workerInProcess: process.env.RUN_WORKER_IN_PROCESS === 'true',
  hubspot: {
    // Optional at boot: the service must be deployable *before* the HubSpot app
    // exists, because the app's config needs this deployment's public URL.
    // Anything that actually talks to HubSpot calls requireHubspot() first.
    clientId: process.env.HUBSPOT_CLIENT_ID || '',
    clientSecret: process.env.HUBSPOT_CLIENT_SECRET || '',
    redirectUri: process.env.HUBSPOT_REDIRECT_URI || `${publicUrl}/oauth/callback`,
    webhookUrl: `${publicUrl}/webhooks/hubspot`,
    scopes: [
      'oauth',
      'crm.objects.contacts.read',
      'crm.objects.companies.read',
      'crm.objects.deals.read',
      'crm.schemas.contacts.read',
      'crm.schemas.companies.read',
      'crm.schemas.deals.read',
    ],
  },
}

export const hubspotConfigured = () =>
  Boolean(config.hubspot.clientId && config.hubspot.clientSecret)

export function requireHubspot() {
  if (!hubspotConfigured()) {
    const err = new Error(
      'HubSpot app is not configured yet. Set HUBSPOT_CLIENT_ID and HUBSPOT_CLIENT_SECRET.'
    )
    err.status = 503
    throw err
  }
  return config.hubspot
}

// ---- credential encryption (AES-256-GCM) ------------------------------------
// Tokens and DSNs are encrypted before they touch disk. The key never leaves env.

// Accept either 64 hex chars (an explicit 32-byte key) or any other secret,
// which we stretch to 32 bytes. That lets the host generate the value for us
// instead of a human copying a key around.
const rawKey = required('ENCRYPTION_KEY')
const key = /^[0-9a-fA-F]{64}$/.test(rawKey)
  ? Buffer.from(rawKey, 'hex')
  : crypto.createHash('sha256').update(rawKey, 'utf8').digest()

export function encrypt(plaintext) {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join('.')
}

export function decrypt(payload) {
  const [ivB64, tagB64, dataB64] = String(payload).split('.')
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'))
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8')
}
