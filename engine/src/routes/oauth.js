import express from 'express'
import { buildInstallUrl, exchangeCode, saveConnection, verifyState } from '../hubspot/oauth.js'
import { query } from '../db/meta.js'
import { requireHubspot } from '../config.js'

export const oauthRouter = express.Router()

// Step 1 — send the user to HubSpot.
oauthRouter.get('/install', async (req, res) => {
  try { requireHubspot() } catch (err) { return res.status(503).json({ error: err.message }) }
  const accountId = req.query.account_id
  if (!accountId) return res.status(400).json({ error: 'account_id is required' })
  res.redirect(buildInstallUrl(accountId))
})

// Step 2 — HubSpot sends them back with a code.
oauthRouter.get('/callback', async (req, res) => {
  try { requireHubspot() } catch (err) { return res.status(503).send(err.message) }
  const { code, state, error } = req.query
  if (error) return res.status(400).send(`HubSpot denied the install: ${error}`)
  if (!code || !state) return res.status(400).send('Missing code or state')

  try {
    const accountId = verifyState(state)
    const tokens = await exchangeCode(code)
    const connection = await saveConnection(accountId, tokens)

    await query(
      `insert into syncive.accounts (id, email) values ($1, $2) on conflict (id) do nothing`,
      [accountId, `account-${accountId}@pending.local`]
    )

    res.send(renderSuccess(connection.portal_id))
  } catch (err) {
    console.error('[oauth] callback failed', err)
    res.status(400).send(`Could not finish the install: ${err.message}`)
  }
})

const renderSuccess = (portalId) => `<!doctype html>
<meta charset="utf-8"><title>Connected — Syncive</title>
<style>
  body{font:16px/1.6 system-ui,sans-serif;background:#0b0e13;color:#e9eef5;display:grid;place-items:center;height:100vh;margin:0}
  .card{max-width:420px;padding:32px;border:1px solid #222a36;border-radius:12px;background:#131822}
  h1{font-size:20px;margin:0 0 8px}p{color:#9fb0c3;margin:0}
  code{color:#4c8dff}
</style>
<div class="card">
  <h1>HubSpot connected</h1>
  <p>Portal <code>${portalId}</code> is linked. Next: point Syncive at your database and we'll start the backfill.</p>
</div>`
import express from 'express'
import { buildInstallUrl, exchangeCode, saveConnection, verifyState } from '../hubspot/oauth.js'
import { query } from '../db/meta.js'

export const oauthRouter = express.Router()

// Step 1 — send the user to HubSpot.
oauthRouter.get('/install', async (req, res) => {
  const accountId = req.query.account_id
  if (!accountId) return res.status(400).json({ error: 'account_id is required' })
  res.redirect(buildInstallUrl(accountId))
})

// Step 2 — HubSpot sends them back with a code.
oauthRouter.get('/callback', async (req, res) => {
  const { code, state, error } = req.query
  if (error) return res.status(400).send(`HubSpot denied the install: ${error}`)
  if (!code || !state) return res.status(400).send('Missing code or state')

  try {
    const accountId = verifyState(state)
    const tokens = await exchangeCode(code)
    const connection = await saveConnection(accountId, tokens)

    await query(
      `insert into syncive.accounts (id, email) values ($1, $2) on conflict (id) do nothing`,
      [accountId, `account-${accountId}@pending.local`]
    )

    res.send(renderSuccess(connection.portal_id))
  } catch (err) {
    console.error('[oauth] callback failed', err)
    res.status(400).send(`Could not finish the install: ${err.message}`)
  }
})

const renderSuccess = (portalId) => `<!doctype html>
<meta charset="utf-8"><title>Connected — Syncive</title>
<style>
  body{font:16px/1.6 system-ui,sans-serif;background:#0b0e13;color:#e9eef5;display:grid;place-items:center;height:100vh;margin:0}
  .card{max-width:420px;padding:32px;border:1px solid #222a36;border-radius:12px;background:#131822}
  h1{font-size:20px;margin:0 0 8px}p{color:#9fb0c3;margin:0}
  code{color:#4c8dff}
</style>
<div class="card">
  <h1>HubSpot connected</h1>
  <p>Portal <code>${portalId}</code> is linked. Next: point Syncive at your database and we'll start the backfill.</p>
</div>`
