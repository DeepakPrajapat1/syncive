import express from 'express'

import { requireAccountPage } from '../auth.js'

export const dashboardRouter = express.Router()

// The dashboard is served by the engine itself: same origin as /api, so no CORS,
// no second deploy target, and no build step. One HTML string, everything inline.
// The account comes from the session cookie, so a dashboard link is no longer a
// credential: pasting this URL to someone shows them their own account or the
// sign-in page, never yours.
dashboardRouter.get('/', requireAccountPage, (req, res) => {
  res.type('html').send(renderDashboard(req.accountId))
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

const NOTE = `<p class="note">Signed in through your HubSpot install. Syncive never
  stores your CRM records; this page reads sync state and logs only.</p>`

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
  <div id="destinations"></div>
  <div id="danger"></div>
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
  function tone(h){
    if(h === 'healthy') return 'ok';
    if(h === 'stale') return 'warn';
    if(h === 'paused' || h === 'disconnected') return '';
    return 'bad';
  }
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
    html += '<span>';
    // 'live' next to 'disconnected' is a contradiction. The backfill state only
    // means anything while the sync is actually running.
    if(s.health !== 'disconnected' && s.health !== 'paused'){
      html += '<span class="pill">' + esc(s.state) + '</span> ';
    }
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
    if(s.revoked_at){
      html += '<button class="ghost" disabled>Reinstall in HubSpot to resume</button>';
    } else if(s.enabled === false){
      html += '<button class="ghost resume">Resume sync</button>';
    } else {
      html += '<button class="retry"' + (dead ? '' : ' disabled') + '>Retry ' +
              esc(num(dead)) + ' failed record' + (dead === 1 ? '' : 's') + '</button>';
      html += '<button class="ghost count">Count rows in destination</button>';
      html += '<button class="ghost pause">Pause sync</button>';
    }
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
        var pauseBtn = card.querySelector('.pause');
        if(pauseBtn) pauseBtn.addEventListener('click', function(){
          var btn = this; btn.disabled = true;
          out.className = 'result'; out.textContent = 'Pausing\u2026';
          post(id, 'pause', out, btn, 'Pause sync');
        });
        var resumeBtn = card.querySelector('.resume');
        if(resumeBtn) resumeBtn.addEventListener('click', function(){
          var btn = this; btn.disabled = true;
          out.className = 'result'; out.textContent = 'Resuming\u2026';
          post(id, 'resume', out, btn, 'Resume sync');
        });

        var retryBtn = card.querySelector('.retry');
        if(retryBtn) retryBtn.addEventListener('click', function(){
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
        var countBtn = card.querySelector('.count');
        if(countBtn) countBtn.addEventListener('click', function(){
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

  var destBox = document.getElementById('destinations');
  var dangerBox = document.getElementById('danger');
  var CONNECTION = null;
  var REVOKED = false;

  // A mis-click during setup can leave a second destination writing the same
  // rows into the same schema — three times the HubSpot calls and three times
  // the database connections, for one copy of the data. Until you can see the
  // destinations you cannot tell that is what is happening.
  function renderDestinations(list){
    if(list.length < 2){ destBox.innerHTML = ''; renderDanger(); return; }

    var html = '<div class="card"><div class="row"><span class="name">Destinations</span>' +
      '<span class="pill bad">' + list.length + ' configured</span></div>' +
      '<p class="sub">More than one destination means every HubSpot change is written ' +
      'more than once. Removing one stops Syncive writing through it — your own tables ' +
      'and rows are left exactly as they are.</p>';

    for(var i=0;i<list.length;i++){
      var d = list[i];
      var syncs = d.syncs || [];
      var live = 0;
      for(var k=0;k<syncs.length;k++) if(syncs[k].last_success_at) live++;
      html += '<div class="row" data-dest="' + esc(d.id) + '">';
      html += '<span><code>' + esc(d.schema_name) + '</code> ' +
              '<span class="sub">' + esc(d.id.slice(0,8)) + '… &middot; ' +
              syncs.length + ' sync' + (syncs.length === 1 ? '' : 's') + ' &middot; ' +
              (live ? live + ' with data' : 'never synced') + '</span></span>';
      html += '<span><button class="ghost remove">Remove</button> ' +
              '<span class="result"></span></span></div>';
    }
    destBox.innerHTML = html + '</div>';
    renderDanger(true);

    var rows = destBox.querySelectorAll('[data-dest]');
    for(var r=0;r<rows.length;r++){
      (function(row){
        var id = row.getAttribute('data-dest');
        var out = row.querySelector('.result');
        var btn = row.querySelector('.remove');
        btn.addEventListener('click', function(){
          // Two clicks, not a confirm() — a modal dialog blocks the page and is
          // the one thing this dashboard must never do mid-refresh.
          if(btn.dataset.armed !== '1'){
            btn.dataset.armed = '1';
            btn.textContent = 'Click again to remove';
            out.className = 'result'; out.textContent = 'This deletes its syncs and their history.';
            setTimeout(function(){
              if(btn.dataset.armed !== '1') return;
              btn.dataset.armed = ''; btn.textContent = 'Remove';
              out.textContent = '';
            }, 6000);
            return;
          }
          btn.dataset.armed = ''; btn.disabled = true; btn.textContent = 'Removing…';
          fetch('/api/destinations/' + encodeURIComponent(id), {method:'DELETE'})
            .then(function(res){ return res.json().then(function(j){ return {s:res.status,j:j}; }); })
            .then(function(res){
              if(res.s >= 400) throw new Error(res.j && res.j.error || ('HTTP ' + res.s));
              out.className = 'result ok';
              out.textContent = 'Removed, with ' + Number(res.j.syncsRemoved || 0) + ' sync(s).';
              load();
            })
            .catch(function(err){
              out.className = 'result bad'; out.textContent = String(err.message || err);
              btn.disabled = false; btn.textContent = 'Remove';
            });
        });
      })(rows[r]);
    }
  }

  // Leaving has to be as visible as arriving. A customer who cannot find the way
  // out uninstalls in HubSpot instead and never tells you why.
  function renderDanger(append){
    if(!CONNECTION || REVOKED){ if(!append) dangerBox.innerHTML = ''; return; }
    dangerBox.innerHTML =
      '<div class="card"><div class="row"><span class="name">Disconnect HubSpot</span>' +
      '<span><button class="ghost disconnect">Disconnect</button> ' +
      '<span class="result"></span></span></div>' +
      '<p class="sub">Stops all syncing and deletes the HubSpot credentials Syncive holds. ' +
      'Your database is left exactly as it is — every row already written stays. ' +
      'Reinstalling in HubSpot starts it again.</p></div>';

    var btn = dangerBox.querySelector('.disconnect');
    var out = dangerBox.querySelector('.result');
    btn.addEventListener('click', function(){
      if(btn.dataset.armed !== '1'){
        btn.dataset.armed = '1';
        btn.textContent = 'Click again to disconnect';
        out.className = 'result';
        out.textContent = 'All syncing stops. Your data stays.';
        setTimeout(function(){
          if(btn.dataset.armed !== '1') return;
          btn.dataset.armed = ''; btn.textContent = 'Disconnect'; out.textContent = '';
        }, 6000);
        return;
      }
      btn.dataset.armed = ''; btn.disabled = true; btn.textContent = 'Disconnecting\u2026';
      fetch('/api/connections/' + encodeURIComponent(CONNECTION) + '/disconnect', {method:'POST'})
        .then(function(r){ return r.json().then(function(j){ return {s:r.status,j:j}; }); })
        .then(function(r){
          if(r.s >= 400) throw new Error(r.j && r.j.error || ('HTTP ' + r.s));
          load();
        })
        .catch(function(err){
          out.className = 'result bad'; out.textContent = String(err.message || err);
          btn.disabled = false; btn.textContent = 'Disconnect';
        });
    });
  }

  function loadDestinations(){
    fetch('/api/destinations', {headers:{accept:'application/json'}})
      .then(function(r){ return r.ok ? r.json() : null; })
      .then(function(j){ if(j) renderDestinations(j.destinations || []); })
      .catch(function(){ /* the sync cards are the page; this section is a bonus */ });
  }

  // Pause and resume are the same shape: fire, report, reload.
  function post(id, action, out, btn, label){
    fetch('/api/syncs/' + encodeURIComponent(id) + '/' + action, {method:'POST'})
      .then(function(r){ return r.json().then(function(j){ return {s:r.status,j:j}; }); })
      .then(function(r){
        if(r.s >= 400) throw new Error(r.j && r.j.error || ('HTTP ' + r.s));
        load();
      })
      .catch(function(err){
        out.className = 'result bad'; out.textContent = String(err.message || err);
        btn.disabled = false; btn.textContent = label;
      });
  }

  function render(data){
    var syncs = (data && data.syncs) || [];
    CONNECTION = syncs.length ? syncs[0].connection_id : null;
    REVOKED = syncs.some(function(s){ return s.revoked_at; });
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

    var bad = 0, staleN = 0, pausedN = 0, gone = null;
    for(var i=0;i<syncs.length;i++){
      if(syncs[i].health === 'degraded') bad++;
      else if(syncs[i].health === 'stale') staleN++;
      else if(syncs[i].health === 'paused') pausedN++;
      else if(syncs[i].health === 'disconnected') gone = syncs[i];
    }
    // Say this before anything else: nothing below is going to update, and the
    // reason is not a fault.
    if(gone){
      var why = gone.revoked_reason || 'Access to this portal was revoked';
      if(!/[.!?]$/.test(why)) why += '.';
      setBanner('', 'HubSpot disconnected',
        why + ' Your tables and rows are untouched — reinstall Syncive in HubSpot to start syncing again.');
      renderCards(syncs);
      return;
    }
    if(bad) setBanner('bad', 'Attention needed',
      bad + ' of ' + syncs.length + ' syncs are degraded — failed events or undelivered records.');
    else if(staleN) setBanner('attention', 'Sync is stale',
      staleN + ' of ' + syncs.length + ' syncs have not succeeded in over 3 hours.');
    else if(pausedN === syncs.length) setBanner('', 'All syncs paused',
      'Nothing is being written. Resume any sync to start again.');
    else setBanner('ok', 'All syncs healthy',
      (syncs.length - pausedN) + ' sync' + (syncs.length - pausedN === 1 ? '' : 's') + ' flowing' +
      (pausedN ? ', ' + pausedN + ' paused' : '') + ', no unresolved failures.');

    renderCards(syncs);
  }

  function renderCards(syncs){
    var html = '';
    for(var j=0;j<syncs.length;j++) html += renderSync(syncs[j]);
    list.innerHTML = html;
    wire();
    // The connection id only becomes known here, so the exit is drawn here too.
    renderDanger();
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
  loadDestinations();
  setInterval(load, 30000);
  setInterval(loadDestinations, 30000);
})();
</script>`
