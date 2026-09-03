import express from 'express'
import { encrypt } from '../config.js'
import { query } from '../db/meta.js'
import { testConnection } from '../db/dest.js'
import { enqueueBackfill } from '../queue/jobs.js'
import { OBJECT_TYPES } from '../hubspot/client.js'

export const connectRouter = express.Router()

// Setting up a sync used to mean three curl calls with a password on the command
// line. This is the same three steps as a form: the connection string is posted
// straight to the engine over HTTPS, encrypted before it touches the database,
// and never echoed back into the page.
connectRouter.use(express.urlencoded({ extended: false, limit: '64kb' }))

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
const SCHEMA_OK = /^[a-z_][a-z0-9_]{0,62}$/

const esc = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

connectRouter.get('/', (req, res) => {
  const accountId = typeof req.query.account === 'string' ? req.query.account.trim() : ''
  if (!accountId) return res.type('html').send(renderAsk())
  if (!UUID.test(accountId)) {
    return res.status(400).type('html').send(renderAsk("That doesn't look like an account id — it should be a UUID."))
  }
  res.type('html').send(renderForm({ accountId }))
})

connectRouter.post('/', async (req, res) => {
  const accountId = String(req.body.account || '').trim()
  const dsn = String(req.body.dsn || '').trim()
  const schema = String(req.body.schema || 'hubspot').trim().toLowerCase()
  const chosen = OBJECT_TYPES.filter((t) => req.body[`obj_${t}`])

  // Driver errors can quote the connection string back at us. Scrub it before
  // anything reaches the page or a log line.
  const redact = (message) => {
    let out = String(message ?? '')
    if (dsn) out = out.split(dsn).join('[connection string]')
    return out.replace(/\/\/[^\s/@]*:[^\s/@]*@/g, '//[redacted]@')
  }
  const fail = (message, status = 400) =>
    res.status(status).type('html').send(renderForm({ accountId, schema, chosen, error: redact(message) }))

  try {
    if (!UUID.test(accountId)) return fail('Account id must be a UUID.')
    if (!dsn) return fail('Paste your Postgres connection string.')
    if (!SCHEMA_OK.test(schema)) {
      return fail('Schema name must be lowercase letters, digits and underscores, starting with a letter.')
    }
    if (!chosen.length) return fail('Pick at least one object to sync.')

    // Fail here rather than halfway through a backfill: a bad password or an
    // unreachable host is the most common setup mistake by a mile.
    const probe = await testConnection(dsn)
    if (!probe.ok) return fail(`Could not connect to that database: ${probe.error}`)

    const { rows: conns } = await query(
      `select id, portal_id from syncive.hubspot_connections where account_id = $1 order by created_at limit 1`,
      [accountId]
    )
    if (!conns.length) {
      return fail('No HubSpot portal is connected for this account yet — install the app first.')
    }

    // Submitting twice must not fan out into two destinations writing the same
    // rows into the same schema. Reuse the row for this account+schema and just
    // refresh the credentials.
    const { rows: existing } = await query(
      `select id from syncive.destinations where account_id = $1 and schema_name = $2 order by created_at limit 1`,
      [accountId, schema]
    )
    const { rows: dests } = existing.length
      ? await query(
          `update syncive.destinations set dsn_enc = $2, status = 'ready' where id = $1 returning id`,
          [existing[0].id, encrypt(dsn)]
        )
      : await query(
          `insert into syncive.destinations (account_id, dsn_enc, schema_name, status)
           values ($1, $2, $3, 'ready') returning id`,
          [accountId, encrypt(dsn), schema]
        )
    const destinationId = dests[0].id

    const created = []
    for (const objectType of chosen) {
      const { rows } = await query(
        `insert into syncive.syncs (account_id, connection_id, destination_id, object_type)
         values ($1, $2, $3, $4)
         on conflict (destination_id, object_type) do update set enabled = true
         returning id, object_type`,
        [accountId, conns[0].id, destinationId, objectType]
      )
      created.push(rows[0])
      await enqueueBackfill(rows[0].id)
    }

    res.type('html').send(
      renderDone({ accountId, portalId: conns[0].portal_id, database: probe.database, schema, created })
    )
  } catch (err) {
    // Never let the connection string reach a log line or the page.
    console.error('[connect] setup failed:', redact(err.message))
    fail(`Setup failed: ${err.message}`, 500)
  }
})

const HEAD = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex,nofollow">
<title>Connect your database — Syncive</title>
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
  input[type=text],input[type=password]{width:100%;padding:.6rem .7rem;border-radius:.5rem;
    border:1px solid var(--border);background:#0f141d;color:var(--text);
    font:inherit;font-size:.95rem}
  input:focus{outline:2px solid var(--accent);outline-offset:1px}
  .hint{color:var(--muted);font-size:.78rem;margin:.35rem 0 0}
  .field{margin-bottom:1rem}
  .objs{display:flex;flex-wrap:wrap;gap:.5rem .9rem}
  .objs label{display:flex;align-items:center;gap:.35rem;color:var(--text);font-size:.9rem;margin:0}
  button{background:var(--accent);color:#fff;border:0;border-radius:.5rem;
         padding:.6rem 1rem;font:inherit;font-weight:600;cursor:pointer}
  button:hover{filter:brightness(1.08)}
  .err{border-left:4px solid var(--bad);color:var(--bad);font-size:.9rem}
  .ok{border-left:4px solid var(--ok)}
  a{color:var(--accent)}
  code{background:#0f141d;border:1px solid var(--border);border-radius:.3rem;
       padding:.05rem .3rem;font-size:.85em;word-break:break-all}
  ul{margin:.5rem 0 0;padding-left:1.1rem}
  footer{color:var(--muted);font-size:.78rem;margin-top:1.25rem;
         border-top:1px solid var(--border);padding-top:.9rem}
</style>`

const renderAsk = (message) => `${HEAD}
<div class="wrap">
  <h1>Connect your database</h1>
  <p class="sub">Enter the account id you got when you installed the HubSpot app.</p>
  ${message ? `<div class="card err">${esc(message)}</div>` : ''}
  <form method="get" class="card">
    <div class="field">
      <label for="a">Account id</label>
      <input id="a" name="account" type="text" autocomplete="off" spellcheck="false"
             placeholder="00000000-0000-0000-0000-000000000000" required>
    </div>
    <button type="submit">Continue</button>
  </form>
</div>`

function renderForm({ accountId, schema = 'hubspot', chosen = OBJECT_TYPES, error }) {
  const checks = OBJECT_TYPES.map(
    (t) => `<label><input type="checkbox" name="obj_${esc(t)}" value="1"${
      chosen.includes(t) ? ' checked' : ''
    }> ${esc(t)}</label>`
  ).join('')

  return `${HEAD}
<div class="wrap">
  <h1>Connect your database</h1>
  <p class="sub">Syncive will mirror your HubSpot records into a schema in your own Postgres.</p>
  ${error ? `<div class="card err">${esc(error)}</div>` : ''}
  <form method="post" class="card" autocomplete="off">
    <input type="hidden" name="account" value="${esc(accountId)}">
    <div class="field">
      <label for="dsn">Postgres connection string</label>
      <input id="dsn" name="dsn" type="password" required spellcheck="false"
             placeholder="postgresql://user:password@host:5432/database">
      <p class="hint">Stored encrypted, never shown again. On Supabase use the
         <strong>session pooler</strong> URI — the direct one is IPv6-only.</p>
    </div>
    <div class="field">
      <label for="schema">Schema to write into</label>
      <input id="schema" name="schema" type="text" value="${esc(schema)}" spellcheck="false">
      <p class="hint">Created if it doesn't exist. Nothing outside this schema is touched.</p>
    </div>
    <div class="field">
      <label>Objects to sync</label>
      <div class="objs">${checks}</div>
    </div>
    <button type="submit" id="go">Connect and start backfill</button>
    <p class="hint" id="status" hidden>Testing the connection and provisioning tables&hellip;
       this can take up to a minute the first time.</p>
  </form>
  <script>
    // A slow first request (cold start plus a connection probe) looks like a dead
    // button, so people click it again — and used to get a second destination.
    // The server tolerates that now; this stops it happening in the first place.
    (function () {
      var form = document.currentScript.previousElementSibling;
      var go = form.querySelector('#go');
      var status = form.querySelector('#status');
      form.addEventListener('submit', function (e) {
        if (form.dataset.sent) { e.preventDefault(); return; }
        form.dataset.sent = '1';
        go.textContent = 'Connecting\u2026';
        status.hidden = false;
        // Disable after the form has been serialised, never before.
        setTimeout(function () { go.disabled = true; }, 0);
      });
    })();
  </script>
  <footer>
    This link contains your account id — treat it like a password. Syncive needs
    write access to create the schema and its tables; it never reads anything else
    in your database.
  </footer>
</div>`
}

const renderDone = ({ accountId, portalId, database, schema, created }) => `${HEAD}
<div class="wrap">
  <h1>Connected</h1>
  <p class="sub">Portal ${esc(portalId)} is now syncing into <code>${esc(database)}</code>.</p>
  <div class="card ok">
    <strong>Backfill queued</strong>
    <ul>${created.map((s) => `<li>${esc(s.object_type)} &rarr; <code>${esc(schema)}.${esc(s.object_type)}</code></li>`).join('')}</ul>
  </div>
  <div class="card">
    <p style="margin:0">First rows land within a minute or two. Watch it here:</p>
    <p style="margin:.5rem 0 0"><a href="/dashboard?account=${esc(accountId)}">Open the sync dashboard &rarr;</a></p>
  </div>
</div>`
