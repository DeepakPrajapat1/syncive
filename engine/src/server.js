import express from 'express'
import { config } from './config.js'
import { oauthRouter } from './routes/oauth.js'
import { webhookRouter } from './routes/webhooks.js'
import { apiRouter } from './routes/api.js'
import { pool } from './db/meta.js'

const app = express()

// Webhooks need the raw body for signature checks, so they mount before json().
app.use('/webhooks', webhookRouter)
app.use(express.json({ limit: '1mb' }))
app.use('/oauth', oauthRouter)
app.use('/api', apiRouter)

app.get('/healthz', async (_req, res) => {
  try {
    await pool.query('select 1')
    res.json({ ok: true, uptime: Math.round(process.uptime()) })
  } catch (err) {
    res.status(503).json({ ok: false, error: err.message })
  }
})

app.use((err, _req, res, _next) => {
  console.error('[http]', err)
  res.status(500).json({ error: 'internal error' })
})

app.listen(config.port, () => {
  console.log(`[server] listening on :${config.port}`)
  console.log(`[server] install URL: ${config.publicUrl}/oauth/install?account_id=<uuid>`)
})
