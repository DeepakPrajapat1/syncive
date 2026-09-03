import crypto from 'node:crypto'
import express from 'express'
import { buildInstallUrl, exchangeCode, saveConnection, verifyState } from '../hubspot/oauth.js'
import { query } from '../db/meta.js'
import { requireHubspot } from '../config.js'
import { issueSession } from '../auth.js'

export const oauthRouter = express.Router()

// Step 1 — send the user to HubSpot.
oauthRouter.get('/install', async (req, res) => {
  try { requireHubspot() } catch (err) { return res.status(503).json({ error: err.message }) }
  // A first-time visitor has no account yet, and asking them to invent a UUID
  // was never a real step — it just moved the problem to whoever sent the link.
  // Mint one here; the state parameter carries it through HubSpot and back.
  const accountId = req.query.account_id || crypto.randomUUID()
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

    // The account row has to exist first: hubspot_connections.account_id is a
    // foreign key onto it, so saving the connection before this fails the very
    // first time an account installs.
    await query(
      `insert into syncive.accounts (id, email) values ($1, $2) on conflict (id) do nothing`,
      [accountId, `account-${accountId}@pending.local`]
    )

    await saveConnection(accountId, tokens)

    // Everything after this point knows who you are from the cookie, so the
    // account id never has to appear in a URL or be copied by hand again.
    issueSession(res, accountId)
    res.redirect('/connect')
  } catch (err) {
    console.error('[oauth] callback failed', err)
    res.status(400).send(`Could not finish the install: ${err.message}`)
  }
})
