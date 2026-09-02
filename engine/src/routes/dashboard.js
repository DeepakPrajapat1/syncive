import express from 'express'

export const dashboardRouter = express.Router()

// The dashboard is served by the engine itself: same origin as /api, so no CORS,
// no second deploy target, and no build step. One HTML string, everything inline.
dashboardRouter.get('/', (req, res) => {
  const accountId = typeof req.query.account === 'string' ? req.query.account.trim() : ''
  // The health API casts the id straight to uuid, so a malformed id would only
  // produce a 500. Catch it here and re-ask instead of polling a doomed URL.
  const valid = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(accountId)
  if (!accountId) return res.type('html').send(renderPrompt())
  if (!valid) return res.status(400).type('html').send(renderPrompt("That doesn't look like an account id — it should be a UUID."))
  res.type('html').send(renderDashboard(accountId))
})

// Every value that reaches the page goes through this. Object type names, error
// strings and event messages come out of the database — treat them as hostile.
const esc = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

const HEAD = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex,nofollow">
<title>Sync health — Syncive</title>
<style>
  :root{
    --bg:#0b0e13; --panel:#131822; --border:#222a36; --text:#e9eef5;
    --muted:#9fb0c3; --accent:#4c8dff;
    --ok:#3ddc97; --warn:#f5b544; --bad:#ff6b6b;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--text);
       font:16px/1.55 system-ui,-apple-system,Segoe UI,sans-serif}
  .wrap{max-width:56rem;margin:0 auto;padding:1.5rem 1rem 3rem}
  header{display:flex;flex-wrap:wrap;gap:.5rem 1rem;align-items:baseline;margin-bottom:1rem}
  h1{font-size:1.25rem;margin:0}
  .sub{color:var(--muted);font-size:.85rem}
  .card{background:var(--panel);border:1px solid var(--border);border-radius:.75rem;
        padding:1rem;margin-bottom:.75rem}
  .banner{display:flex;flex-wrap:wrap;gap:.5rem .75rem;align-items:center;
          border-left:4px solid var(--muted)}
  .banner.ok{border-left-color:var(--ok)}
  .banner.attention{border-left-color:var(--warn)}
  .banner.bad{border-left-color:var(--bad)}
  .banner strong{font-size:1.05rem}
  .row{display:flex;flex-wrap:wrap;gap:.5rem .75rem;align-items:baseline;
       justify-content:space-between}
  .name{font-size:1rem;font-weight:600}
  .pill{display:inline-block;font-size:.72rem;letter-spacing:.02em;text-transform:uppercase;
        border:1px solid var(--border);border-radius:999px;padding:.1rem .5rem;color:var(--muted)}
  .pill.ok{color:var(--ok);border-color:var(--ok)}
  .pill.warn{color:var(--warn);border-color:var(--warn)}
  .pill.bad{color:var(--bad);border-color:var(--bad)}
  .stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(7.5rem,1fr));
         gap:.5rem;margin-top:.75rem}
  .stat{background:#0f141d;border:1px solid var(--border);border-radius:.5rem;padding:.5rem .6rem}
  .stat .k{color:var(--muted);font-size:.72rem;text-transform:uppercase;letter-spacing:.03em}
  .stat .v{font-size:1.05rem;font-variant-numeric:tabular-nums}
  .v.ok{color:var(--ok)} .v.warn{color:var(--warn)} .v.bad{color:var(--bad)}
  .scroll{overflow-x:auto;-webkit-overflow-scrolling:touch;margin-top:.75rem}
  table{border-collapse:collapse;width:100%;min-width:32rem;font-size:.82rem}
  th,td{text-align:left;padding:.35rem .5rem;border-bottom:1px solid var(--border);
        vertical-align:top;white-space:nowrap}
  td.msg{white-space:normal;color:var(--muted);max-width:22rem}
  th{color:var(--muted);font-weight:500}
  button{font:inherit;font-size:.85rem;background:var(--accent);color:#06101f;border:0;
         border-radius:.4rem;padding:.4rem .8rem;cursor:pointer}
  button.ghost{background:transparent;color:var(--accent);border:1px solid var(--border)}
  button[disabled]{opacity:.55;cursor:default}
  .actions{display:flex;flex-wrap:wrap;gap:.5rem;align-items:center;margin-top:.75rem}
  .result{font-size:.82rem;color:var(--muted)}
  .result.ok{color:var(--ok)} .result.bad{color:var(--bad)}
  .note{color:var(--muted);font-size:.78rem;border-top:1px solid var(--border);
        margin-top:1.5rem;padding-top:.75rem}
  code{color:var(--accent)}
  input{font:inherit;background:#0f141d;color:var(--text);border:1px solid var(--border);
        border-radius:.4rem;padding:.45rem .6rem;width:100%}
  label{display:block;font-size:.85rem;color:var(--muted);margin-bottom:.35rem}
  form{max-width:26rem}
  .empty{color:var(--muted)}
</style>`

// JSON.stringify alone can still emit "</script>" and break out of the block.
const jsonForScript = (value) =>
  JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')

const NOTE = `<p class="note">This link contains your account id and is the only thing
  guarding these numbers — treat it like a password and don't share or post it.
  Syncive never stores your CRM records; this page reads sync state and logs only.</p>`

const renderPrompt = (message) => `${HEAD}
<div class="wrap">
  <header><h1>Sync health</h1></header>
  <div class="card">
    ${message ? `<p class="sub" style="color:var(--bad)">${esc(message)}</p>` : ''}
    <p class="sub">Enter the account id you want to inspect. It's the <code>account_id</code>
      you used when you installed the HubSpot app.</p>
    <form method="get" action="">
      <label for="account">Account id</label>
      <input id="account" name="account" autocomplete="off" spellcheck="false"
             placeholder="00000000-0000-0000-0000-000000000000" required>
      <div class="actions"><button type="submit">Open dashboard</button></div>
    </form>
  </div>
  ${NOTE}
</div>`

const renderDashboard = (accountId) => `${HEAD}
<div class="wrap">
  <header>
    <h1>Sync health</h1>
    <span class="sub">account &hellip;${esc(accountId.slice(-4))}</span>
    <span class="sub" id="updated">Loading&hellip;</span>
  </header>
  <div id="banner" class="card banner"><strong>Loading…</strong>
    <span class="sub">Fetching current sync state.</span></div>
  <div id="syncs"></div>
  ${NOTE}
</div>
<script>
(function(){
  var ACCOUNT = ${jsonForScript(accountId)};
  var banner = document.getElementById('banner');
  var list = document.getElementById('syncs');
  var updated = document.getElementById('updated');

  function esc(v){
    return String(v === null || v === undefined ? '' : v)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }
  function ago(ts){
    if(!ts) return 'never';
    var t = Date.parse(ts);
    if(isNaN(t)) return 'unknown';
    var s = Math.round((Date.now()-t)/1000);
    if(s < 0) s = 0;
    if(s < 60) return s + 's ago';
    if(s < 3600) return Math.floor(s/60) + 'm ago';
    if(s < 86400) return Math.floor(s/3600) + 'h ago';
    return Math.floor(s/86400) + 'd ago';
  }
  function tone(h){ return h === 'healthy' ? 'ok' : h === 'stale' ? 'warn' : 'bad'; }
  function num(n){ return Number(n || 0).toLocaleString(); }

  function setBanner(cls, title, detail){
    banner.className = 'card banner ' + cls;
    banner.innerHTML = '<strong>' + esc(title) + '</strong><span class="sub">' + esc(detail) + '</span>';
  }

  function renderSync(s){
    var t = tone(s.health);
    var failed = Number(s.events_failed_24h || 0);
    var dead = Number(s.unresolved_failures || 0);
    var html = '';
    html += '<div class="card" data-sync="' + esc(s.id) + '">';
    html += '<div class="row"><span class="name">' + esc(s.object_type) + '</span>';
    html += '<span><span class="pill">' + esc(s.state) + '</span> ';
    html += '<span class="pill ' + t + '">' + esc(s.health) + '</span></span></div>';
    html += '<div class="stats">';
    html += '<div class="stat"><div class="k">Last success</div><div class="v ' +
            (s.last_success_at ? '' : 'warn') + '">' + esc(ago(s.last_success_at)) + '</div></div>';
    html += '<div class="stat"><div class="k">Last event</div><div class="v">' +
            esc(ago(s.last_event_at)) + '</div></div>';
    html += '<div class="stat"><div class="k">Records 24h</div><div class="v">' +
            esc(num(s.records_synced_24h)) + '</div></div>';
    html += '<div class="stat"><div class="k">OK events 24h</div><div class="v ok">' +
            esc(num(s.events_ok_24h)) + '</div></div>';
    html += '<div class="stat"><div class="k">Failed 24h</div><div class="v ' +
            (failed ? 'bad' : '') + '">' + esc(num(failed)) + '</div></div>';
    html += '<div class="stat"><div class="k">Dead letters</div><div class="v ' +
            (dead ? 'bad' : '') + '">' + esc(num(dead)) + '</div></div>';
    html += '<div class="stat"><div class="k">Destination schema</div><div class="v">' +
            esc(s.schema_name) + '</div></div>';
    html += '</div>';

    var recent = s.recent || [];
    if(recent.length){
      html += '<div class="scroll"><table><thead><tr><th>When</th><th>Kind</th>' +
              '<th>Status</th><th>Records</th><th>Message</th></tr></thead><tbody>';
      for(var i=0;i<recent.length;i++){
        var e = recent[i];
        var st = e.status === 'ok' ? 'ok' : e.status === 'failed' ? 'bad' : 'warn';
        html += '<tr><td>' + esc(ago(e.created_at)) + '</td><td>' + esc(e.kind) + '</td>' +
                '<td class="v ' + st + '">' + esc(e.status) + '</td>' +
                '<td>' + esc(num(e.record_count)) + '</td>' +
                '<td class="msg">' + esc(e.message || '') + '</td></tr>';
      }
      html += '</tbody></table></div>';
    } else {
      html += '<p class="result">No sync events recorded yet.</p>';
    }

    html += '<div class="actions">';
    html += '<button class="retry"' + (dead ? '' : ' disabled') + '>Retry ' +
            esc(num(dead)) + ' failed record' + (dead === 1 ? '' : 's') + '</button>';
    html += '<button class="ghost count">Count rows in destination</button>';
    html += '<span class="result"></span></div>';
    html += '</div>';
    return html;
  }

  function wire(){
    var cards = list.querySelectorAll('[data-sync]');
    for(var i=0;i<cards.length;i++){
      (function(card){
        var id = card.getAttribute('data-sync');
        var out = card.querySelector('.result');
        card.querySelector('.retry').addEventListener('click', function(){
          var btn = this; btn.disabled = true;
          out.className = 'result'; out.textContent = 'Requeueing…';
          fetch('/api/syncs/' + encodeURIComponent(id) + '/retry-failures', {method:'POST'})
            .then(function(r){ return r.json().then(function(j){ return {s:r.status,j:j}; }); })
            .then(function(r){
              if(r.s >= 400) throw new Error(r.s + ' ' + (r.j && r.j.error || 'retry failed'));
              out.className = 'result ok';
              out.textContent = 'Requeued ' + Number(r.j.requeued || 0) + ' record(s). Refreshing…';
              load();
            })
            .catch(function(err){
              out.className = 'result bad'; out.textContent = String(err.message || err);
              btn.disabled = false;
            });
        });
        card.querySelector('.count').addEventListener('click', function(){
          var btn = this; btn.disabled = true;
          out.className = 'result'; out.textContent = 'Counting…';
          fetch('/api/syncs/' + encodeURIComponent(id) + '/rows')
            .then(function(r){ return r.json().then(function(j){ return {s:r.status,j:j}; }); })
            .then(function(r){
              if(r.s >= 400) throw new Error(r.s + ' ' + (r.j && r.j.error || 'count failed'));
              out.className = 'result ok';
              out.textContent = Number(r.j.rows || 0).toLocaleString() + ' rows in destination.';
            })
            .catch(function(err){
              out.className = 'result bad'; out.textContent = String(err.message || err);
            })
            .then(function(){ btn.disabled = false; });
        });
      })(cards[i]);
    }
  }

  function render(data){
    var syncs = (data && data.syncs) || [];
    updated.textContent = 'Updated ' + new Date().toLocaleTimeString() + ' — refreshes every 30s';

    if(!syncs.length){
      setBanner('', 'No syncs yet',
        'This account has no syncs configured.');
      list.innerHTML = '<div class="card empty"><p>Nothing is flowing yet. Connect a HubSpot ' +
        'portal at <code>/oauth/install</code>, register a destination database with ' +
        '<code>POST /api/destinations</code>, then create syncs with <code>POST /api/syncs</code>. ' +
        'This page will start reporting as soon as the first backfill runs.</p></div>';
      return;
    }

    var bad = 0, staleN = 0;
    for(var i=0;i<syncs.length;i++){
      if(syncs[i].health === 'degraded') bad++;
      else if(syncs[i].health === 'stale') staleN++;
    }
    if(bad) setBanner('bad', 'Attention needed',
      bad + ' of ' + syncs.length + ' syncs are degraded — failed events or undelivered records.');
    else if(staleN) setBanner('attention', 'Sync is stale',
      staleN + ' of ' + syncs.length + ' syncs have not succeeded in over 3 hours.');
    else setBanner('ok', 'All syncs healthy',
      syncs.length + ' sync' + (syncs.length === 1 ? '' : 's') + ' flowing, no unresolved failures.');

    var html = '';
    for(var j=0;j<syncs.length;j++) html += renderSync(syncs[j]);
    list.innerHTML = html;
    wire();
  }

  function load(){
    fetch('/api/accounts/' + encodeURIComponent(ACCOUNT) + '/health', {headers:{accept:'application/json'}})
      .then(function(r){
        return r.text().then(function(body){
          if(!r.ok){
            var msg = body;
            try { var j = JSON.parse(body); msg = j.error || body; } catch(e){}
            throw new Error('HTTP ' + r.status + ' — ' + (msg || r.statusText || 'request failed'));
          }
          return JSON.parse(body);
        });
      })
      .then(render)
      .catch(function(err){
        updated.textContent = 'Last attempt ' + new Date().toLocaleTimeString();
        setBanner('bad', 'Could not load sync health', String(err.message || err));
        if(!list.innerHTML){
          list.innerHTML = '<div class="card empty"><p>The dashboard will keep retrying every ' +
            '30 seconds. If this persists, check that the engine is running and that the ' +
            'account id in this link is correct.</p></div>';
        }
      });
  }

  load();
  setInterval(load, 30000);
})();
</script>`
