import express from 'express'
import { encrypt } from '../config.js'
import { query } from '../db/meta.js'
import { verifyDestination } from '../db/dest.js'
import { enqueueBackfill } from '../queue/jobs.js'
import { OBJECT_TYPES } from '../hubspot/client.js'
import { requireAccountPage } from '../auth.js'

export const connectRouter = express.Router()

// This asked for a whole connection string in one box, which is a nudge in the
// wrong direction: the easiest thing to put in it is the superuser URI copied
// out of a provider dashboard. Separate fields push toward a scoped user, and
// the page shows the grant script that creates one — the same shape every
// established product in this category uses.
connectRouter.use(express.urlencoded({ extended: false, limit: '64kb' }))
// Who you are comes from the session the HubSpot install minted, never from the
// request. A form field naming someone else's account is simply not read.
connectRouter.use(requireAccountPage)

const SCHEMA_OK = /^[a-z_][a-z0-9_]{0,62}$/

const esc = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

connectRouter.get('/', (req, res) => {
  res.type('html').send(renderForm({}))
})

// Postgres takes the password from the URI, so every character that means
// something in a URI has to be escaped rather than trusted.
//
// `sslmode=require` is deliberately NOT written into the string. node-postgres
// treats require as verify-full, so putting it here rejects every self-signed
// or private-CA certificate — which is Supabase, RDS and most managed Postgres.
// Leaving it out lets the driver negotiate TLS and encrypt without demanding a
// public CA, which is what libpq's `require` actually means. Only verify-full,
// where the customer has asked for certificate checking, goes in the URI.
const buildDsn = ({ host, port, database, user, password, sslmode }) =>
  `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}` +
  `@${host}:${port}/${encodeURIComponent(database)}` +
  (sslmode === 'verify-full' ? '?sslmode=verify-full' : '')

const SSL_MODES = ['require', 'verify-full']

connectRouter.post('/', async (req, res) => {
  const accountId = req.accountId
  const form = {
    host: String(req.body.host || '').trim(),
    port: String(req.body.port || '5432').trim(),
    database: String(req.body.database || '').trim(),
    user: String(req.body.user || '').trim(),
    password: String(req.body.password || ''),
    // Two products in this category let a customer turn TLS off. Offering the
    // choice at all is the mistake; there is no option here that disables it.
    sslmode: SSL_MODES.includes(req.body.sslmode) ? req.body.sslmode : 'require',
  }
  const schema = String(req.body.schema || 'hubspot').trim().toLowerCase()
  const chosen = OBJECT_TYPES.filter((t) => req.body[`obj_${t}`])
  const dsn = form.host && form.database && form.user ? buildDsn({ ...form, database: form.database }) : ''

  // Driver errors can quote the connection string back at us. Scrub it before
  // anything reaches the page or a log line.
  const redact = (message) => {
    let out = String(message ?? '')
    if (dsn) out = out.split(dsn).join('[connection string]')
    return out.replace(/\/\/[^\s/@]*:[^\s/@]*@/g, '//[redacted]@')
  }
  const fail = (message, status = 400, steps = null) =>
    res
      .status(status)
      .type('html')
      .send(renderForm({ schema, chosen, form, error: redact(message), steps }))

  try {
    if (!form.host) return fail('Enter the database host.')
    if (!/^\d{1,5}$/.test(form.port)) return fail('Port must be a number.')
    if (!form.database) return fail('Enter the database name.')
    if (!form.user) return fail('Enter the database user.')
    if (!form.password) return fail('Enter the password for that user.')
    if (!SCHEMA_OK.test(schema)) {
      return fail('Schema name must be lowercase letters, digits and underscores, starting with a letter.')
    }
    if (!chosen.length) return fail('Pick at least one object to sync.')

    // Fail here rather than halfway through a backfill, and fail specifically:
    // the checks run in order and the page shows which one stopped.
    const probe = await verifyDestination(dsn, schema)
    if (!probe.ok) {
      const failed = probe.steps.find((step) => !step.ok)
      return fail(
        failed ? `${failed.name} — ${failed.detail || 'failed'}` : 'Could not connect to that database',
        400,
        probe.steps
      )
    }

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
      renderDone({ portalId: conns[0].portal_id, database: probe.database, schema, created })
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
  .row2{display:flex;gap:.75rem;flex-wrap:wrap}
  .row2 .field{flex:1 1 12rem}
  .row2 .field.narrow{flex:0 0 6rem}
  select{width:100%;padding:.6rem .7rem;border-radius:.5rem;border:1px solid var(--border);
         background:#0f141d;color:var(--text);font:inherit;font-size:.95rem}
  pre{background:#0f141d;border:1px solid var(--border);border-radius:.5rem;
      padding:.7rem;overflow-x:auto;font-size:.82rem;margin:.6rem 0 .5rem;
      white-space:pre;color:#cfe0f5}
  button.ghost{background:transparent;color:var(--accent);border:1px solid var(--border);
               font-weight:500;padding:.4rem .7rem;font-size:.85rem}
  .card.inner{background:#0f141d;margin:.25rem 0 1rem}
  .steps{list-style:none;padding:0;margin:.5rem 0 0}
  .steps li{font-size:.88rem;padding:.15rem 0}
  .steps li.ok{color:var(--ok)} .steps li.bad{color:var(--bad)}
  .steps .sub{color:var(--muted)}
  #plan{margin:.4rem 0 .6rem;padding-left:1.1rem}
  #plan li{font-size:.88rem;padding:.1rem 0}
</style>`

function renderForm({ schema = 'hubspot', chosen = OBJECT_TYPES, form = {}, error, steps } = {}) {
  const v = (k, d = '') => esc(form[k] ?? d)
  const checks = OBJECT_TYPES.map(
    (t) => `<label><input type="checkbox" name="obj_${esc(t)}" value="1"${
      chosen.includes(t) ? ' checked' : ''
    }> ${esc(t)}</label>`
  ).join('')

  const results = steps
    ? `<div class="card"><strong>Connection check</strong><ul class="steps">${steps
        .map(
          (step) =>
            `<li class="${step.ok ? 'ok' : 'bad'}">${step.ok ? '&check;' : '&times;'} ${esc(step.name)}` +
            `${step.detail ? ` <span class="sub">${esc(step.detail)}</span>` : ''}</li>`
        )
        .join('')}</ul></div>`
    : ''

  return `${HEAD}
<div class="wrap">
  <h1>Connect your database</h1>
  <p class="sub">Syncive mirrors your HubSpot records into a schema in your own Postgres.</p>
  ${error ? `<div class="card err">${esc(error)}</div>` : ''}
  ${results}

  <div class="card">
    <strong>Make a user for Syncive first</strong>
    <p class="hint">Don't give Syncive your admin login. Run this in your database — it
      creates a user that can reach one schema and nothing else. Change the password.</p>
    <pre id="grant"></pre>
    <button type="button" class="ghost" id="copy">Copy</button>
  </div>

  <form method="post" class="card" autocomplete="off">
    <div class="row2">
      <div class="field">
        <label for="host">Host</label>
        <input id="host" name="host" type="text" required spellcheck="false"
               value="${v('host')}" placeholder="db.example.com">
      </div>
      <div class="field narrow">
        <label for="port">Port</label>
        <input id="port" name="port" type="text" inputmode="numeric" value="${v('port', '5432')}">
      </div>
    </div>
    <div class="field">
      <label for="database">Database</label>
      <input id="database" name="database" type="text" required spellcheck="false" value="${v('database')}">
    </div>
    <div class="row2">
      <div class="field">
        <label for="user">User</label>
        <input id="user" name="user" type="text" required spellcheck="false"
               value="${v('user', 'syncive')}">
      </div>
      <div class="field">
        <label for="password">Password</label>
        <input id="password" name="password" type="password" required spellcheck="false">
      </div>
    </div>
    <div class="row2">
      <div class="field">
        <label for="schema">Schema to write into</label>
        <input id="schema" name="schema" type="text" value="${esc(schema)}" spellcheck="false">
      </div>
      <div class="field">
        <label for="sslmode">Encryption</label>
        <select id="sslmode" name="sslmode">
          <option value="require"${form.sslmode === 'verify-full' ? '' : ' selected'}>Required</option>
          <option value="verify-full"${form.sslmode === 'verify-full' ? ' selected' : ''}>Required, verify certificate</option>
        </select>
        <p class="hint">There is no option to turn this off.</p>
      </div>
    </div>
    <div class="field">
      <label>Objects to sync</label>
      <div class="objs">${checks}</div>
    </div>

    <div class="card inner">
      <strong>What Syncive will create</strong>
      <ul id="plan"></ul>
      <p class="hint">Nothing outside this schema is read or written. Syncive stores your
        HubSpot tokens and this password encrypted, and never keeps your CRM records.</p>
    </div>

    <button type="submit" id="go">Test connection and start backfill</button>
    <p class="hint" id="status" hidden>Running the checks and provisioning tables&hellip;
       this can take up to a minute the first time.</p>
  </form>

  <script>
    (function () {
      var form = document.currentScript.previousElementSibling;
      var go = form.querySelector('#go');
      var status = form.querySelector('#status');
      var schema = form.querySelector('#schema');
      var user = form.querySelector('#user');
      var db = form.querySelector('#database');
      var grant = document.getElementById('grant');
      var plan = document.getElementById('plan');
      var objs = form.querySelectorAll('.objs input');

      function ident(v, fallback) {
        v = (v || '').trim().toLowerCase();
        return /^[a-z_][a-z0-9_]*$/.test(v) ? v : fallback;
      }

      // Show the exact statements, filled in with what they typed. A snippet the
      // customer has to edit is a snippet they will get wrong.
      function paint() {
        var s = ident(schema.value, 'hubspot');
        var u = ident(user.value, 'syncive');
        var d = ident(db.value, 'your_database');
        grant.textContent =
          "create user " + u + " with password 'choose-a-strong-one';\\n" +
          "create schema " + s + " authorization " + u + ";\\n" +
          "grant connect on database " + d + " to " + u + ";";

        var picked = [];
        for (var i = 0; i < objs.length; i++) if (objs[i].checked) picked.push(objs[i].parentNode.textContent.trim());
        plan.innerHTML = picked.length
          ? picked.map(function (t) { return '<li><code>' + s + '.' + t + '</code></li>'; }).join('')
          : '<li class="sub">Pick at least one object above.</li>';
      }

      [schema, user, db].forEach(function (el) { el.addEventListener('input', paint); });
      for (var i = 0; i < objs.length; i++) objs[i].addEventListener('change', paint);
      paint();

      document.getElementById('copy').addEventListener('click', function () {
        var btn = this;
        navigator.clipboard.writeText(grant.textContent).then(function () {
          btn.textContent = 'Copied';
          setTimeout(function () { btn.textContent = 'Copy'; }, 1500);
        }).catch(function () { btn.textContent = 'Select it and copy'; });
      });

      // A slow first request (cold start plus the connection checks) looks like a
      // dead button, so people click it again — and used to get a second destination.
      form.addEventListener('submit', function (e) {
        if (form.dataset.sent) { e.preventDefault(); return; }
        form.dataset.sent = '1';
        go.textContent = 'Checking\u2026';
        status.hidden = false;
        setTimeout(function () { go.disabled = true; }, 0);
      });
    })();
  </script>
  <footer>
    Syncive needs to create its schema and tables. Give it the scoped user above rather
    than an admin login, and it cannot reach anything else in your database.
  </footer>
</div>`
}

const renderDone = ({ portalId, database, schema, created }) => `${HEAD}
<div class="wrap">
  <h1>Connected</h1>
  <p class="sub">Portal ${esc(portalId)} is now syncing into <code>${esc(database)}</code>.</p>
  <div class="card ok">
    <strong>Backfill queued</strong>
    <ul>${created.map((s) => `<li>${esc(s.object_type)} &rarr; <code>${esc(schema)}.${esc(s.object_type)}</code></li>`).join('')}</ul>
  </div>
  <div class="card">
    <p style="margin:0">First rows land within a minute or two. Watch it here:</p>
    <p style="margin:.5rem 0 0"><a href="/dashboard">Open the sync dashboard &rarr;</a></p>
  </div>
</div>`
