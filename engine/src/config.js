import crypto from 'node:crypto'

const required = (name) => {
  const v = process.env[name]
  if (!v) throw new Error(`Missing required env var: ${name}`)
  return v
}

export const config = {
  port: Number(process.env.PORT || 8080),
  publicUrl: process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 8080}`,
  metaDatabaseUrl: required('META_DATABASE_URL'),
  hubspot: {
    clientId: required('HUBSPOT_CLIENT_ID'),
    clientSecret: required('HUBSPOT_CLIENT_SECRET'),
    redirectUri: required('HUBSPOT_REDIRECT_URI'),
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

// ---- credential encryption (AES-256-GCM) ------------------------------------
// Tokens and DSNs are encrypted before they touch disk. The key never leaves env.

const key = Buffer.from(required('ENCRYPTION_KEY'), 'hex')
if (key.length !== 32) throw new Error('ENCRYPTION_KEY must be 32 bytes of hex (64 chars)')

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
