import express from 'express'
import { decrypt, encrypt, googleConfigured, requireGoogle } from '../config.js'
import { query } from '../db/meta.js'
import { requireAccountPage } from '../auth.js'
import { buildAuthUrl, exchangeCode, verifyState } from '../sheets/oauth.js'
import { createSpreadsheet } from '../sheets/client.js'
import { enqueueBackfill } from '../queue/jobs.js'
import { OBJECT_TYPES } from '../hubspot/client.js'

export const googleRouter = express.Router()

googleRouter.use(express.urlencoded({ extended: false, limit: '64kb' }))

const esc = (v) =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

googleRouter.get('/connect', requireAccountPage, (req, res) => {
  if (!googleConfigured()) return res.status(503).type('html').send(renderMissing())
  res.redirect(buildAuthUrl(req.accountId))
})

// Google sends the customer back here. The tokens are stored against a
// destination that has no spreadsheet yet; the next page names and creates one.
googleRouter.get('/callback', async (req, res) => {
  try { requireGoogle() } catch (err) { return res.status(503).send(err.message) }
  const { code, state, error } = req.query
  if (error) return res.status(400).send(`Google denied the connection: ${error}`)
  if (!code || !state) return res.status(400).send('Missing code or state')

  try {
    const accountId = verifyState(state)
    const tokens = await exchangeCode(code)

    const config = {
      refreshToken: tokens.refresh_token,
      accessToken: tokens.access_token,
      expiresAt: Date.now() + tokens.expires_in * 1000,
      spreadsheetId: null,
    }

    // Reuse the account's pending Sheets destination if there is one, so a
    // customer who abandons this halfway and comes back does not collect
    // half-finished destinations.
    const { rows: existing } = await query(
      `select id from syncive.destinations
        where account_id = $1 and kind = 'sheets' and config_enc is not null
        order by created_at desc limit 1`,
      [accountId]
    )
    const { rows } = existing.length
      ? await query(
          `update syncive.destinations set config_enc = $2, status = 'pending' where id = $1 returning id`,
          [existing[0].id, encrypt(JSON.stringify(config))]
        )
      : await query(
          `insert into syncive.destinations (account_id, kind, config_enc, schema_name, status)
           values ($1, 'sheets', $2, 'sheets', 'pending') returning id`,
          [accountId, encrypt(JSON.stringify(config))]
        )

    res.redirect(`/google/pick?destination=${rows[0].id}`)
  } catch (err) {
    console.error('[google] callback failed', err)
    res.status(400).send(`Could not finish connecting Google: ${err.message}`)
  }
})

googleRouter.get('/pick', requireAccountPage, async (req, res) => {
  const destinationId = String(req.query.destination || '')
  const { rows } = await query(
    `select id from syncive.destinations
      where id = $1 and account_id = $2 and kind = 'sheets'`,
    [destinationId, req.accountId]
  )
  if (!rows.length) return res.status(404).type('html').send(renderMissing('That connection no longer exists.'))
  res.type('html').send(renderPick({ destinationId, error: req.query.error }))
})

googleRouter.post('/pick', requireAccountPage, async (req, res) => {
  const destinationId = String(req.body.destination || '')
  const title = String(req.body.title || '').trim() || 'HubSpot — Syncive'
  const chosen = OBJECT_TYPES.filter((t) => req.body[`obj_${t}`])

  const back = (message) =>
    res.status(400).type('html').send(renderPick({ destinationId, error: message }))

  if (!chosen.length) return back('Pick at least one object to sync.')

  const { rows } = await query(
    `select id, config_enc from syncive.destinations
      where id = $1 and account_id = $2 and kind = 'sheets'`,
    [destinationId, req.accountId]
  )
  if (!rows.length) return back('That connection no longer exists.')

  const { rows: conns } = await query(
    `select id from syncive.hubspot_connections
      where account_id = $1 and revoked_at is null order by created_at limit 1`,
    [req.accountId]
  )
  if (!conns.length) return back('No HubSpot portal is connected for this account yet.')

  let sheet
  try {
    // Reuse the spreadsheet if this destination already has one, so a customer
    // who comes back through this page does not end up with a Drive full of
    // half-used sheets.
    const existing = JSON.parse(decrypt(rows[0].config_enc))
    sheet = existing.spreadsheetId
      ? { spreadsheetId: existing.spreadsheetId, url: existing.spreadsheetUrl }
      : await createSpreadsheet(destinationId, title)

    await query(`update syncive.destinations set config_enc = $2, status = 'ready' where id = $1`, [
      destinationId,
      encrypt(JSON.stringify({ ...existing, spreadsheetId: sheet.spreadsheetId, spreadsheetUrl: sheet.url })),
    ])
  } catch (err) {
    console.error('[google] could not create the spreadsheet', err)
    return back(`Could not create the spreadsheet: ${err.message}`)
  }

  const created = []
  for (const objectType of chosen) {
    const { rows: sync } = await query(
      `insert into syncive.syncs (account_id, connection_id, destination_id, object_type)
       values ($1, $2, $3, $4)
       on conflict (destination_id, object_type) do update set enabled = true
       returning id, object_type`,
      [req.accountId, conns[0].id, destinationId, objectType]
    )
    created.push(sync[0])
    await enqueueBackfill(sync[0].id, { force: true })
  }

  res.type('html').send(renderDone(created, sheet.url))
})

const HEAD = `<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><meta name="robots" content="noindex,nofollow">
<title>Connect Google Sheets — Syncive</title>
<style>
  :root{--bg:#0b0e13;--panel:#131822;--border:#222a36;--text:#e9eef5;
        --muted:#9fb0c3;--accent:#4c8dff;--ok:#3ddc97;--bad:#ff6b6b}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--text);
       font:16px/1.55 system-ui,-apple-system,Segoe UI,sans-serif}
  .wrap{max-width:38rem;margin:0 auto;padding:2rem 1rem 3rem}
  h1{font-size:1.25rem;margin:0 0 .35rem}
  .sub{color:var(--muted);font-size:.85rem;margin:0 0 1.25rem}
  .card{background:var(--panel);border:1px solid var(--border);
        border-radius:.75rem;padding:1.1rem;margin-bottom:.75rem}
  label{display:block;font-size:.85rem;color:var(--muted);margin:0 0 .3rem}
  input[type=text]{width:100%;padding:.6rem .7rem;border-radius:.5rem;
    border:1px solid var(--border);background:#0f141d;color:var(--text);
    font:inherit;font-size:.95rem}
  .hint{color:var(--muted);font-size:.78rem;margin:.35rem 0 0}
  .field{margin-bottom:1rem}
  .objs{display:flex;flex-wrap:wrap;gap:.5rem .9rem}
  .objs label{display:flex;align-items:center;gap:.35rem;color:var(--text);font-size:.9rem;margin:0}
  button,a.btn{display:inline-block;background:var(--accent);color:#fff;border:0;border-radius:.5rem;
         padding:.6rem 1rem;font:inherit;font-weight:600;cursor:pointer;text-decoration:none}
  .err{border-left:4px solid var(--bad);color:var(--bad);font-size:.9rem}
  .ok{border-left:4px solid var(--ok)}
  a{color:var(--accent)}
  code{background:#0f141d;border:1px solid var(--border);border-radius:.3rem;
       padding:.05rem .3rem;font-size:.85em;word-break:break-all}
  ul{margin:.5rem 0 0;padding-left:1.1rem}
</style>`

const renderMissing = (message) => `${HEAD}
<div class="wrap">
  <h1>Google Sheets is not set up yet</h1>
  <div class="card err">${esc(message || 'This Syncive instance has no Google credentials configured.')}</div>
</div>`

const renderPick = ({ destinationId, error }) => `${HEAD}
<div class="wrap">
  <h1>Name the spreadsheet</h1>
  <p class="sub">Syncive creates a new sheet in your Google Drive and syncs into it. It can see
     that one file and nothing else you have.</p>
  ${error ? `<div class="card err">${esc(error)}</div>` : ''}
  <form method="post" class="card">
    <input type="hidden" name="destination" value="${esc(destinationId)}">
    <div class="field">
      <label for="t">Spreadsheet name</label>
      <input id="t" name="title" type="text" value="HubSpot &mdash; Syncive" spellcheck="false">
      <p class="hint">It appears in your Drive straight away. Rename or move it whenever you like —
         Syncive keeps writing to the same file.</p>
    </div>
    <div class="field">
      <label>Objects to sync</label>
      <div class="objs">${OBJECT_TYPES.map(
        (t) => `<label><input type="checkbox" name="obj_${esc(t)}" value="1" checked> ${esc(t)}</label>`
      ).join('')}</div>
    </div>
    <button type="submit">Create it and start syncing</button>
  </form>
  <div class="card">
    <p class="hint" style="margin:0">One tab per object. Syncive never clears the sheet: it updates
      its own rows and appends new ones, so anything you add to the right of its columns — formulas,
      notes, filters — survives every sync.</p>
  </div>
</div>`

const renderDone = (created, url) => `${HEAD}
<div class="wrap">
  <h1>Connected</h1>
  <div class="card ok">
    <strong>Backfill queued</strong>
    <ul>${created.map((s) => `<li>${esc(s.object_type)} &rarr; a tab named <code>${esc(s.object_type)}</code></li>`).join('')}</ul>
  </div>
  <div class="card">
    <p style="margin:0">First rows appear within a minute or two.</p>
    ${url ? `<p style="margin:.5rem 0 0"><a href="${esc(url)}" target="_blank" rel="noreferrer">Open the spreadsheet &rarr;</a></p>` : ''}
    <p style="margin:.5rem 0 0"><a href="/dashboard">Open the sync dashboard &rarr;</a></p>
  </div>
</div>`
