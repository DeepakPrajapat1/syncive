import crypto from 'node:crypto'
import express from 'express'
import { buildInstallUrl, exchangeCode, saveConnection, tokenInfo, verifyState } from '../hubspot/oauth.js'
import { query } from '../db/meta.js'
import { requireHubspot } from '../config.js'
import { accountOf, clearSession, issueSession } from '../auth.js'

export const oauthRouter = express.Router()

// Step 1 — send the user to HubSpot.
oauthRouter.get('/install', async (req, res) => {
  try { requireHubspot() } catch (err) { return res.status(503).json({ error: err.message }) }
  // Already signed in? Adding a portal belongs to the account you are in.
  // Otherwise mint an id and mark it provisional: if the portal turns out to be
  // one we already know, the callback throws this id away and signs the customer
  // back into the account that owns it.
  const signedIn = accountOf(req)
  const accountId = signedIn || req.query.account_id || crypto.randomUUID()
  res.redirect(buildInstallUrl(accountId, { provisional: !signedIn && !req.query.account_id }))
})

// Drop the session. Needed on a shared machine, and needed by us: while a stale
// cookie is present the install flow treats you as signed in and will not adopt
// the account that already owns the portal.
oauthRouter.get('/signout', (req, res) => {
  clearSession(res)
  res.redirect('/oauth/install')
})

// Step 2 — HubSpot sends them back with a code.
oauthRouter.get('/callback', async (req, res) => {
  try { requireHubspot() } catch (err) { return res.status(503).send(err.message) }
  const { code, state, error } = req.query
  if (error) return res.status(400).send(`HubSpot denied the install: ${error}`)
  if (!code || !state) return res.status(400).send('Missing code or state')

  try {
    const { accountId: stateAccountId, provisional } = verifyState(state)
    const tokens = await exchangeCode(code)

    // Reinstalling is how a customer signs back in — from a new browser, or
    // after the cookie expired. Minting a fresh account for a portal we already
    // sync would hand them an empty dashboard and no sign their data still
    // exists, which is the most alarming thing this product could do.
    const info = await tokenInfo(tokens.access_token)
    const accountId = provisional ? await accountForPortal(info.hub_id, stateAccountId) : stateAccountId

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

    // A returning customer already has a database attached; dropping them back
    // on the setup form reads as "start over".
    const { rows: existing } = await query(
      `select 1 from syncive.syncs where account_id = $1 limit 1`,
      [accountId]
    )
    res.redirect(existing.length ? '/dashboard' : '/connect')
  } catch (err) {
    console.error('[oauth] callback failed', err)
    res.status(400).send(`Could not finish the install: ${err.message}`)
  }
})

// The account that already owns this portal, or the provisional one if nobody
// does. Oldest wins: a portal can legitimately be connected by more than one
// account (an agency and their client), and the first is the one that has been
// syncing.
async function accountForPortal(portalId, fallbackAccountId) {
  const { rows } = await query(
    `select account_id from syncive.hubspot_connections
      where portal_id = $1 order by created_at limit 1`,
    [String(portalId)]
  )
  return rows[0]?.account_id || fallbackAccountId
}
