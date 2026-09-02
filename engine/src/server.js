import express from 'express'
import { config, hubspotConfigured } from './config.js'
import { oauthRouter } from './routes/oauth.js'
import { webhookRouter } from './routes/webhooks.js'
import { apiRouter } from './routes/api.js'
import { dashboardRouter } from './routes/dashboard.js'
import { pool } from './db/meta.js'
import { applySchema } from './migrate.js'
import { startWorkers } from './queue/jobs.js'

const app = express()

// Webhooks need the raw body for signature checks, so they mount before json().
app.use('/webhooks', webhookRouter)
app.use(express.json({ limit: '1mb' }))
app.use('/oauth', oauthRouter)
app.use('/api', apiRouter)
app.use('/dashboard', dashboardRouter)

app.get('/healthz', async (_req, res) => {
  try {
    await pool.query('select 1')
    res.json({
      ok: true,
      uptime: Math.round(process.uptime()),
      hubspotConfigured: hubspotConfigured(),
      workerInProcess: config.workerInProcess,
    })
  } catch (err) {
    res.status(503).json({ ok: false, error: err.message })
  }
})

// What the HubSpot app config needs to point at. Handy during setup: hit this
// and paste the values straight into app-hsmeta.json / webhooks-hsmeta.json.
app.get('/setup', (_req, res) => {
  res.json({
    redirectUrl: config.hubspot.redirectUri,
    webhookTargetUrl: config.hubspot.webhookUrl,
    requiredScopes: config.hubspot.scopes,
    hubspotConfigured: hubspotConfigured(),
  })
})

app.use((err, _req, res, _next) => {
  console.error('[http]', err)
  res.status(err.status || 500).json({ error: err.status ? err.message : 'internal error' })
})

// The schema is idempotent (create ... if not exists), so applying it on boot
// keeps a fresh deploy one step instead of two.
await applySchema()

app.listen(config.port, () => {
  console.log(`[server] listening on :${config.port}`)
  console.log(`[server] public url: ${config.publicUrl}`)
  if (!hubspotConfigured()) {
    console.warn('[server] HubSpot app not configured yet — /oauth returns 503 until you set HUBSPOT_CLIENT_ID/SECRET')
  }
})

// Single-service hosts (Render free tier) have no separate worker process.
if (config.workerInProcess) {
  startWorkers()
    .then(() => console.log('[server] queue workers running in-process'))
    .catch((err) => console.error('[server] worker failed to start', err))
}
