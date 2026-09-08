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

// Inline so the page stays a single request with no external asset host.
const SHEETS_ICON =
  '<svg viewBox="0 0 20 20" fill="none" stroke="#12885a" stroke-width="1.6" ' +
  'stroke-linecap="round" stroke-linejoin="round">' +
  '<rect x="3" y="2.5" width="14" height="15" rx="2"/>' +
  '<path d="M3 8h14M3 12.5h14M8 8v9.5M13 8v9.5"/></svg>'

const PG_ICON =
  '<svg viewBox="0 0 20 20" fill="none" stroke="#2563eb" stroke-width="1.6" ' +
  'stroke-linecap="round" stroke-linejoin="round">' +
  '<ellipse cx="10" cy="5" rx="6.5" ry="2.75"/>' +
  '<path d="M3.5 5v10c0 1.5 2.9 2.75 6.5 2.75s6.5-1.25 6.5-2.75V5"/>' +
  '<path d="M3.5 10c0 1.5 2.9 2.75 6.5 2.75s6.5-1.25 6.5-2.75"/></svg>'

const HEAD = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex,nofollow">
<title>Syncive</title>
<style>
  :root{
    --bg:#f7f8fa; --panel:#fff; --sunk:#fafbfc;
    --border:#e4e7ec; --border-strong:#d0d5dd;
    --text:#101828; --muted:#667085; --faint:#98a2b3;
    --accent:#2563eb; --accent-soft:#eff4ff;
    --ok:#12885a; --ok-soft:#e7f6ef;
    --warn:#b54708; --warn-soft:#fef4e6;
    --bad:#b42318; --bad-soft:#fdecea;
    --shadow:0 1px 2px rgba(16,24,40,.05);
    --shadow-lg:0 4px 16px -4px rgba(16,24,40,.1),0 2px 6px -2px rgba(16,24,40,.06);
  }
  *{box-sizing:border-box}
  html{-webkit-text-size-adjust:100%}
  body{margin:0;background:var(--bg);color:var(--text);
       font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,system-ui,sans-serif;
       -webkit-font-smoothing:antialiased}
  a{color:var(--accent);text-decoration:none}
  a:hover{text-decoration:underline}

  /* ---- top bar ---- */
  .topbar{position:sticky;top:0;z-index:20;background:rgba(255,255,255,.85);
          backdrop-filter:saturate(180%) blur(8px);border-bottom:1px solid var(--border)}
  .topbar .inner{max-width:64rem;margin:0 auto;padding:.7rem 1.25rem;
                 display:flex;align-items:center;gap:.75rem}
  .brand{display:flex;align-items:center;gap:.5rem;font-weight:650;letter-spacing:-.01em}
  .brand .mark{width:1.4rem;height:1.4rem;border-radius:.45rem;flex:none;
        background:linear-gradient(140deg,#2563eb,#7c3aed);
        box-shadow:0 1px 3px rgba(37,99,235,.4)}
  .spacer{flex:1}
  .chip{font-size:.76rem;color:var(--muted);background:var(--sunk);
        border:1px solid var(--border);border-radius:999px;padding:.2rem .55rem;white-space:nowrap}

  /* ---- layout ---- */
  .wrap{max-width:64rem;margin:0 auto;padding:1.5rem 1.25rem 4rem}
  .page-head{display:flex;align-items:flex-end;gap:1rem;flex-wrap:wrap;margin-bottom:1.1rem}
  h1{font-size:1.5rem;line-height:1.2;margin:0;letter-spacing:-.02em}
  .page-head .sub{color:var(--muted);font-size:.82rem}

  .card{background:var(--panel);border:1px solid var(--border);border-radius:.85rem;
        box-shadow:var(--shadow);margin-bottom:1rem;overflow:hidden}

  /* ---- status hero ---- */
  .hero{display:flex;align-items:center;gap:.85rem;padding:1rem 1.15rem}
  .hero .dot{width:.65rem;height:.65rem;border-radius:50%;flex:none;background:var(--faint)}
  .hero.ok .dot{background:var(--ok);box-shadow:0 0 0 4px var(--ok-soft)}
  .hero.attention .dot{background:var(--warn);box-shadow:0 0 0 4px var(--warn-soft)}
  .hero.bad .dot{background:var(--bad);box-shadow:0 0 0 4px var(--bad-soft)}
  .hero .txt{min-width:0}
  .hero strong{display:block;font-size:1rem;letter-spacing:-.01em}
  .hero .sub{color:var(--muted);font-size:.85rem}

  /* ---- destination section ---- */
  .dest-head{display:flex;align-items:center;gap:.75rem;padding:.9rem 1.15rem;
             border-bottom:1px solid var(--border);background:var(--sunk)}
  .icon{width:2.1rem;height:2.1rem;border-radius:.6rem;flex:none;display:grid;place-items:center;
        background:#fff;border:1px solid var(--border);box-shadow:var(--shadow)}
  .icon svg{width:1.1rem;height:1.1rem;display:block}
  .dest-head .who{min-width:0;flex:1}
  .dest-head .title{font-weight:620;letter-spacing:-.01em;white-space:nowrap;
                    overflow:hidden;text-overflow:ellipsis}
  .dest-head .meta{color:var(--muted);font-size:.79rem;white-space:nowrap;
                   overflow:hidden;text-overflow:ellipsis}

  /* ---- object rows ---- */
  .obj{border-bottom:1px solid var(--border)}
  .obj:last-child{border-bottom:0}
  .obj-row{display:flex;align-items:center;gap:.75rem;padding:.75rem 1.15rem;cursor:pointer;
           background:none;border:0;width:100%;text-align:left;font:inherit;color:inherit}
  .obj-row:hover{background:var(--sunk)}
  .obj-row .dot{width:.5rem;height:.5rem;border-radius:50%;flex:none;background:var(--faint)}
  .obj-row .dot.ok{background:var(--ok)} .obj-row .dot.warn{background:var(--warn)}
  .obj-row .dot.bad{background:var(--bad)}
  .obj-name{font-weight:560;text-transform:capitalize;min-width:5.5rem}
  .obj-row .fill{flex:1}
  .obj-row .val{font-size:.82rem;color:var(--muted);font-variant-numeric:tabular-nums;
                white-space:nowrap}
  .obj-row .val b{color:var(--text);font-weight:560}
  .chev{width:.9rem;height:.9rem;flex:none;color:var(--faint);transition:transform .15s}
  .obj.open .chev{transform:rotate(90deg)}
  .obj-body{display:none;padding:0 1.15rem 1rem;border-top:1px dashed var(--border)}
  .obj.open .obj-body{display:block}

  .badge{display:inline-block;font-size:.7rem;font-weight:600;letter-spacing:.01em;
         border-radius:999px;padding:.12rem .5rem;background:var(--sunk);color:var(--muted);
         border:1px solid var(--border);text-transform:capitalize}
  .badge.ok{background:var(--ok-soft);color:var(--ok);border-color:transparent}
  .badge.warn{background:var(--warn-soft);color:var(--warn);border-color:transparent}
  .badge.bad{background:var(--bad-soft);color:var(--bad);border-color:transparent}

  .stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(8rem,1fr));
         gap:.5rem;margin:.9rem 0}
  .stat{background:var(--sunk);border:1px solid var(--border);border-radius:.55rem;padding:.5rem .65rem}
  .stat .k{color:var(--muted);font-size:.7rem;text-transform:uppercase;letter-spacing:.04em}
  .stat .v{font-size:1rem;font-variant-numeric:tabular-nums;margin-top:.1rem}
  .v.ok{color:var(--ok)} .v.warn{color:var(--warn)} .v.bad{color:var(--bad)}

  .scroll{overflow-x:auto;-webkit-overflow-scrolling:touch;
          border:1px solid var(--border);border-radius:.55rem}
  table{border-collapse:collapse;width:100%;min-width:30rem;font-size:.8rem}
  th,td{text-align:left;padding:.4rem .6rem;border-bottom:1px solid var(--border);
        vertical-align:top;white-space:nowrap}
  tr:last-child td{border-bottom:0}
  td.msg{white-space:normal;color:var(--muted);max-width:20rem}
  th{color:var(--muted);font-weight:500;background:var(--sunk);font-size:.72rem;
     text-transform:uppercase;letter-spacing:.04em}

  /* ---- buttons ---- */
  button{font:inherit;font-size:.83rem;font-weight:540;cursor:pointer;border-radius:.45rem;
         padding:.4rem .75rem;border:1px solid transparent;transition:background .12s,border-color .12s}
  .btn-primary{background:var(--accent);color:#fff}
  .btn-primary:hover{background:#1d4ed8}
  .btn{background:#fff;color:var(--text);border-color:var(--border-strong);box-shadow:var(--shadow)}
  .btn:hover{background:var(--sunk)}
  .btn-quiet{background:none;color:var(--muted);padding:.3rem .5rem}
  .btn-quiet:hover{background:var(--sunk);color:var(--text)}
  .btn-danger{color:var(--bad)}
  .btn-danger:hover{background:var(--bad-soft)}
  button[disabled]{opacity:.5;cursor:default}
  .actions{display:flex;flex-wrap:wrap;gap:.45rem;align-items:center;margin-top:.85rem}
  .result{font-size:.8rem;color:var(--muted)}
  .result.ok{color:var(--ok)} .result.bad{color:var(--bad)}

  /* ---- add destination ---- */
  .add{display:flex;gap:.75rem;flex-wrap:wrap;padding:1.05rem 1.15rem}
  .add-opt{flex:1 1 15rem;display:flex;align-items:center;gap:.7rem;padding:.75rem .85rem;
           border:1px solid var(--border);border-radius:.65rem;background:var(--panel);
           color:inherit;text-decoration:none;transition:border-color .12s,box-shadow .12s}
  .add-opt:hover{border-color:var(--accent);box-shadow:var(--shadow-lg);text-decoration:none}
  .add-opt .title{font-weight:580;font-size:.9rem}
  .add-opt .meta{color:var(--muted);font-size:.78rem}

  .section-label{font-size:.74rem;text-transform:uppercase;letter-spacing:.06em;
                 color:var(--faint);font-weight:600;margin:1.6rem 0 .55rem}
  .pad{padding:1.05rem 1.15rem}
  .sub{color:var(--muted);font-size:.85rem}
  .warn-strip{display:flex;gap:.6rem;align-items:flex-start;padding:.7rem 1.15rem;
              background:var(--warn-soft);color:var(--warn);font-size:.82rem;
              border-bottom:1px solid var(--border)}
  code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.85em;
       background:var(--sunk);border:1px solid var(--border);border-radius:.3rem;padding:.05rem .3rem}
  .note{color:var(--faint);font-size:.78rem;text-align:center;margin-top:2rem}
  .skeleton{height:.85rem;border-radius:.3rem;background:linear-gradient(90deg,#eceff3,#f5f7f9,#eceff3);
            background-size:200% 100%;animation:sh 1.2s linear infinite}
  @keyframes sh{to{background-position:-200% 0}}
  @media (max-width:36rem){
    .obj-row .val.hide-sm{display:none}
    .wrap{padding:1rem .85rem 3rem}
    .topbar .inner{padding:.6rem .85rem}
  }
</style>`

// JSON.stringify alone can still emit "</script>" and break out of the block.
const jsonForScript = (value) =>
  JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')

const renderDashboard = (accountId) => `${HEAD}
<div class="topbar"><div class="inner">
  <span class="brand"><span class="mark"></span>Syncive</span>
  <span class="spacer"></span>
  <span class="chip">Account &hellip;${esc(accountId.slice(-4))}</span>
  <a class="chip" href="/oauth/signout">Sign out</a>
</div></div>

<div class="wrap">
  <div class="page-head">
    <h1>Syncs</h1>
    <span class="spacer"></span>
    <span class="sub" id="updated">Loading&hellip;</span>
  </div>

  <div id="hero" class="card hero">
    <span class="dot"></span>
    <span class="txt"><strong>Checking your syncs&hellip;</strong>
      <span class="sub skeleton" style="width:12rem;display:block;margin-top:.35rem"></span></span>
  </div>

  <div id="body"></div>

  <div class="section-label">Add a destination</div>
  <div class="card"><div class="add">
    <a class="add-opt" href="/google/connect">
      <span class="icon">${SHEETS_ICON}</span>
      <span><span class="title">Google Sheets</span><br>
        <span class="meta">A live spreadsheet, created for you</span></span>
    </a>
    <a class="add-opt" href="/connect">
      <span class="icon">${PG_ICON}</span>
      <span><span class="title">Postgres database</span><br>
        <span class="meta">Your own Supabase, RDS or server</span></span>
    </a>
  </div></div>

  <div id="danger"></div>

  <p class="note">Signed in through your HubSpot install. Syncive keeps no copy of
    your CRM &mdash; only sync state, a short event log, and changes that could not
    be delivered, so they can be retried.<br>
    <a href="/privacy">Privacy Policy</a> &middot; <a href="/terms">Terms of Service</a></p>
</div>
<script>
(function(){
  var ACCOUNT = ${jsonForScript(accountId)};
  var ICONS = ${jsonForScript({ sheets: SHEETS_ICON, postgres: PG_ICON })};
  var hero = document.getElementById('hero');
  var body = document.getElementById('body');
  var dangerBox = document.getElementById('danger');
  var updated = document.getElementById('updated');

  var HEALTH = null, DESTS = null, CONNECTION = null, REVOKED = false;
  // Which object rows the customer has opened. Kept across the 30s refresh —
  // a panel that closes itself while you are reading it is the fastest way to
  // make a dashboard feel broken.
  var OPEN = {};

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
    if(h === 'degraded') return 'bad';
    return '';
  }
  function num(n){ return Number(n || 0).toLocaleString(); }
  function plural(n, word){ return n + ' ' + word + (n === 1 ? '' : 's'); }

  var CHEV = '<svg class="chev" viewBox="0 0 16 16" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M6 3l5 5-5 5"/></svg>';

  function setHero(cls, title, detail){
    hero.className = 'card hero ' + cls;
    hero.innerHTML = '<span class="dot"></span><span class="txt"><strong>' + esc(title) +
      '</strong><span class="sub">' + esc(detail) + '</span></span>';
  }

  // ---- one object row (contacts / companies / deals) ------------------------

  function renderObject(s){
    var t = tone(s.health);
    var failed = Number(s.events_failed_24h || 0);
    var dead = Number(s.unresolved_failures || 0);
    var open = OPEN[s.id] ? ' open' : '';
    var h = '<div class="obj' + open + '" data-sync="' + esc(s.id) + '">';

    h += '<button class="obj-row" type="button">';
    h += '<span class="dot ' + t + '"></span>';
    h += '<span class="obj-name">' + esc(s.object_type) + '</span>';
    h += '<span class="badge ' + t + '">' + esc(s.health) + '</span>';
    h += '<span class="fill"></span>';
    var recs = Number(s.records_synced_24h || 0);
    h += '<span class="val hide-sm"><b>' + esc(num(recs)) + '</b> record' +
         (recs === 1 ? '' : 's') + ' / 24h</span>';
    h += '<span class="val">' + esc(ago(s.last_success_at)) + '</span>';
    h += CHEV + '</button>';

    h += '<div class="obj-body">';
    h += '<div class="stats">';
    h += '<div class="stat"><div class="k">Last success</div><div class="v ' +
         (s.last_success_at ? '' : 'warn') + '">' + esc(ago(s.last_success_at)) + '</div></div>';
    h += '<div class="stat"><div class="k">Last event</div><div class="v">' +
         esc(ago(s.last_event_at)) + '</div></div>';
    h += '<div class="stat"><div class="k">Records 24h</div><div class="v">' +
         esc(num(s.records_synced_24h)) + '</div></div>';
    h += '<div class="stat"><div class="k">OK events 24h</div><div class="v ok">' +
         esc(num(s.events_ok_24h)) + '</div></div>';
    h += '<div class="stat"><div class="k">Failed 24h</div><div class="v ' +
         (failed ? 'bad' : '') + '">' + esc(num(failed)) + '</div></div>';
    h += '<div class="stat"><div class="k">Dead letters</div><div class="v ' +
         (dead ? 'bad' : '') + '">' + esc(num(dead)) + '</div></div>';
    h += '</div>';

    var recent = s.recent || [];
    if(recent.length){
      h += '<div class="scroll"><table><thead><tr><th>When</th><th>Kind</th>' +
           '<th>Status</th><th>Records</th><th>Message</th></tr></thead><tbody>';
      for(var i=0;i<recent.length;i++){
        var e = recent[i];
        var st = e.status === 'ok' ? 'ok' : e.status === 'failed' ? 'bad' : 'warn';
        h += '<tr><td>' + esc(ago(e.created_at)) + '</td><td>' + esc(e.kind) + '</td>' +
             '<td class="v ' + st + '">' + esc(e.status) + '</td>' +
             '<td>' + esc(num(e.record_count)) + '</td>' +
             '<td class="msg">' + esc(e.message || '') + '</td></tr>';
      }
      h += '</tbody></table></div>';
    } else {
      h += '<p class="sub">No sync events recorded yet.</p>';
    }

    h += '<div class="actions">';
    if(s.revoked_at){
      h += '<button class="btn" disabled>Reinstall in HubSpot to resume</button>';
    } else if(s.enabled === false){
      h += '<button class="btn-primary resume">Resume sync</button>';
    } else {
      h += '<button class="btn retry"' + (dead ? '' : ' disabled') + '>Retry ' +
           esc(plural(dead, 'failed record')) + '</button>';
      h += '<button class="btn count">Count rows in destination</button>';
      h += '<button class="btn-quiet pause">Pause</button>';
    }
    h += '<span class="result"></span></div>';
    h += '</div></div>';
    return h;
  }

  // ---- one destination, with its objects grouped under it -------------------

  function renderDestination(dest, syncs, showRemove){
    var icon = ICONS[dest.kind] || ICONS.postgres;
    var live = 0;
    for(var i=0;i<syncs.length;i++) if(syncs[i].last_success_at) live++;

    var meta = dest.kind === 'sheets'
      ? (dest.url ? '<a href="' + esc(dest.url) + '" target="_blank" rel="noopener">Open spreadsheet &#8599;</a>'
                  : 'Spreadsheet not created yet')
      : 'Postgres &middot; schema <code>' + esc(dest.schema_name) + '</code>';
    meta += ' &middot; ' + (syncs.length ? plural(syncs.length, 'object') : 'no objects yet') +
            (live ? ' &middot; ' + live + ' with data' : '');

    var h = '<div class="card" data-dest="' + esc(dest.id) + '">';
    h += '<div class="dest-head"><span class="icon">' + icon + '</span>';
    h += '<span class="who"><div class="title">' + esc(dest.label || dest.schema_name) +
         '</div><div class="meta">' + meta + '</div></span>';
    if(showRemove) h += '<button class="btn-quiet btn-danger remove">Remove</button>';
    h += '</div>';
    if(showRemove === 'dup'){
      h += '<div class="warn-strip">This destination writes the same HubSpot changes a ' +
           'second time. Removing it stops Syncive writing through it &mdash; your own ' +
           'tables and rows are left exactly as they are.</div>';
    }
    h += '<div class="dest-result" style="padding:0 1.15rem"></div>';
    if(!syncs.length){
      h += '<div class="pad sub">No objects are syncing into this destination yet.</div>';
    } else {
      for(var j=0;j<syncs.length;j++) h += renderObject(syncs[j]);
    }
    h += '</div>';
    return h;
  }

  // ---- render ---------------------------------------------------------------

  function render(){
    if(!HEALTH) return;
    var syncs = HEALTH.syncs || [];
    CONNECTION = syncs.length ? syncs[0].connection_id : null;
    REVOKED = syncs.some(function(s){ return s.revoked_at; });
    updated.textContent = 'Updated ' + new Date().toLocaleTimeString() + ' \u00b7 refreshes every 30s';

    if(!syncs.length && DESTS && !DESTS.length){
      setHero('', 'Nothing syncing yet',
        'Pick a destination below and Syncive will backfill your HubSpot records into it.');
      body.innerHTML = '';
      renderDanger();
      return;
    }

    // Headline first. A paused or disconnected sync is not a fault, so it never
    // gets the red treatment.
    var bad = 0, staleN = 0, pausedN = 0, gone = null;
    for(var i=0;i<syncs.length;i++){
      if(syncs[i].health === 'degraded') bad++;
      else if(syncs[i].health === 'stale') staleN++;
      else if(syncs[i].health === 'paused') pausedN++;
      else if(syncs[i].health === 'disconnected') gone = syncs[i];
    }
    if(gone){
      var why = gone.revoked_reason || 'Access to this portal was revoked';
      if(!/[.!?]$/.test(why)) why += '.';
      setHero('', 'HubSpot disconnected', why + ' Your data is untouched \u2014 ' +
        'reinstall Syncive in HubSpot to start syncing again.');
    } else if(bad){
      setHero('bad', 'Attention needed',
        plural(bad, 'object') + ' of ' + syncs.length + ' had failed events or ' +
        'undelivered records' + (staleN ? ', and ' + plural(staleN, 'other') +
        ' has not synced in over 3 hours' : '') + '.');
    } else if(staleN){
      setHero('attention', plural(staleN, 'object') + ' behind',
        'No successful sync in over 3 hours. The hourly reconcile will retry on its own.');
    } else if(pausedN && pausedN === syncs.length){
      setHero('', 'All syncs paused', 'Nothing is being written. Resume any object to start again.');
    } else {
      setHero('ok', 'Everything is in sync',
        plural(syncs.length - pausedN, 'object') + ' flowing' +
        (pausedN ? ', ' + pausedN + ' paused' : '') + ', no unresolved failures.');
    }

    // Group by destination. Without this, three objects synced into two places
    // read as six identical cards called "contacts", "companies", "deals".
    var dests = DESTS || [];
    var byId = {};
    for(var d=0;d<dests.length;d++) byId[dests[d].id] = { dest: dests[d], syncs: [] };
    var orphans = [];
    for(var s2=0;s2<syncs.length;s2++){
      var g = byId[syncs[s2].destination_id];
      if(g) g.syncs.push(syncs[s2]); else orphans.push(syncs[s2]);
    }
    // Removing the last destination is refused by the API, so only offer it when
    // there is more than one — and say why when the extra one is a duplicate.
    var schemas = {};
    for(var k=0;k<dests.length;k++){
      var key = dests[k].kind + ':' + dests[k].schema_name;
      schemas[key] = (schemas[key] || 0) + 1;
    }

    var html = '';
    for(var n=0;n<dests.length;n++){
      var dd = dests[n];
      var dup = schemas[dd.kind + ':' + dd.schema_name] > 1;
      html += renderDestination(dd, byId[dd.id].syncs, dests.length > 1 ? (dup ? 'dup' : true) : false);
    }
    if(orphans.length){
      html += renderDestination(
        { id: 'orphans', kind: 'postgres', label: orphans[0].schema_name,
          schema_name: orphans[0].schema_name }, orphans, false);
    }
    body.innerHTML = html;
    wire();
    renderDanger();
  }

  // ---- wiring ---------------------------------------------------------------

  function call(url, opts, out, btn, label, onOk){
    return fetch(url, opts || {})
      .then(function(r){ return r.text().then(function(t){
        var j = null; try { j = JSON.parse(t); } catch(e){}
        if(r.status >= 400) throw new Error((j && j.error) || ('HTTP ' + r.status));
        return j || {};
      }); })
      .then(onOk)
      .catch(function(err){
        out.className = 'result bad'; out.textContent = String(err.message || err);
        if(btn){ btn.disabled = false; if(label) btn.textContent = label; }
      });
  }

  // Two clicks, not a confirm() — a modal dialog blocks the page and is the one
  // thing this dashboard must never do mid-refresh.
  function arm(btn, out, label, warning, run){
    btn.addEventListener('click', function(ev){
      ev.stopPropagation();
      if(btn.dataset.armed !== '1'){
        btn.dataset.armed = '1';
        btn.textContent = 'Click again to confirm';
        out.className = 'result'; out.textContent = warning;
        setTimeout(function(){
          if(btn.dataset.armed !== '1') return;
          btn.dataset.armed = ''; btn.textContent = label; out.textContent = '';
        }, 6000);
        return;
      }
      btn.dataset.armed = ''; btn.disabled = true; btn.textContent = 'Working\u2026';
      run(btn, out);
    });
  }

  function wire(){
    var objs = body.querySelectorAll('[data-sync]');
    for(var i=0;i<objs.length;i++){
      (function(card){
        var id = card.getAttribute('data-sync');
        var out = card.querySelector('.result');

        card.querySelector('.obj-row').addEventListener('click', function(){
          var nowOpen = !card.classList.contains('open');
          card.classList.toggle('open', nowOpen);
          if(nowOpen) OPEN[id] = true; else delete OPEN[id];
        });
        // Clicks on the buttons inside the panel must not fold it back up.
        card.querySelector('.obj-body').addEventListener('click', function(ev){
          ev.stopPropagation();
        });

        function simple(sel, verb, action){
          var btn = card.querySelector(sel);
          if(!btn) return;
          btn.addEventListener('click', function(){
            btn.disabled = true; out.className = 'result'; out.textContent = verb + '\u2026';
            call('/api/syncs/' + encodeURIComponent(id) + '/' + action, {method:'POST'},
              out, btn, null, function(){ load(); });
          });
        }
        simple('.pause', 'Pausing', 'pause');
        simple('.resume', 'Resuming', 'resume');

        var retry = card.querySelector('.retry');
        if(retry) retry.addEventListener('click', function(){
          retry.disabled = true; out.className = 'result'; out.textContent = 'Requeueing\u2026';
          call('/api/syncs/' + encodeURIComponent(id) + '/retry-failures', {method:'POST'},
            out, retry, null, function(j){
              out.className = 'result ok';
              out.textContent = 'Requeued ' + plural(Number(j.requeued || 0), 'record') + '. Refreshing\u2026';
              load();
            });
        });

        var count = card.querySelector('.count');
        if(count) count.addEventListener('click', function(){
          count.disabled = true; out.className = 'result'; out.textContent = 'Counting\u2026';
          call('/api/syncs/' + encodeURIComponent(id) + '/rows', null, out, count, null,
            function(j){
              out.className = 'result ok';
              out.textContent = num(j.rows) + ' rows in destination.';
            }).then(function(){ count.disabled = false; });
        });
      })(objs[i]);
    }

    var cards = body.querySelectorAll('[data-dest]');
    for(var c=0;c<cards.length;c++){
      (function(card){
        var id = card.getAttribute('data-dest');
        var btn = card.querySelector('.remove');
        if(!btn) return;
        var out = card.querySelector('.dest-result');
        arm(btn, out, 'Remove', 'This deletes its syncs and their history. Your rows stay.',
          function(b, o){
            call('/api/destinations/' + encodeURIComponent(id), {method:'DELETE'},
              o, b, 'Remove', function(j){
                o.className = 'result ok';
                o.textContent = 'Removed, with ' + plural(Number(j.syncsRemoved || 0), 'sync') + '.';
                loadDestinations(); load();
              });
          });
      })(cards[c]);
    }
  }

  // Leaving has to be as visible as arriving. A customer who cannot find the way
  // out uninstalls in HubSpot instead and never tells you why.
  function renderDanger(){
    if(!CONNECTION || REVOKED){ dangerBox.innerHTML = ''; return; }
    dangerBox.innerHTML =
      '<div class="section-label">Disconnect</div>' +
      '<div class="card"><div class="pad">' +
      '<div style="display:flex;gap:.75rem;align-items:center;flex-wrap:wrap">' +
      '<span style="flex:1;min-width:14rem"><b>Disconnect HubSpot</b><br>' +
      '<span class="sub">Stops all syncing, removes Syncive from your HubSpot account and ' +
      'deletes the credentials it holds. HubSpot emails your admins to confirm. Your data ' +
      'is left exactly as it is \u2014 installing again starts it back up.</span></span>' +
      '<button class="btn btn-danger disconnect">Disconnect</button></div>' +
      '<div class="result" style="margin-top:.5rem"></div></div></div>';

    var btn = dangerBox.querySelector('.disconnect');
    var out = dangerBox.querySelector('.result');
    arm(btn, out, 'Disconnect', 'Syncive is removed from HubSpot. Your data stays.',
      function(b, o){
        call('/api/connections/' + encodeURIComponent(CONNECTION) + '/disconnect',
          {method:'POST'}, o, b, 'Disconnect', function(){ load(); });
      });
  }

  // ---- loading --------------------------------------------------------------

  function load(){
    return fetch('/api/accounts/' + encodeURIComponent(ACCOUNT) + '/health',
                 {headers:{accept:'application/json'}})
      .then(function(r){
        return r.text().then(function(t){
          if(!r.ok){
            var msg = t;
            try { msg = JSON.parse(t).error || t; } catch(e){}
            throw new Error('HTTP ' + r.status + ' \u2014 ' + (msg || r.statusText));
          }
          return JSON.parse(t);
        });
      })
      .then(function(j){ HEALTH = j; render(); })
      .catch(function(err){
        updated.textContent = 'Last attempt ' + new Date().toLocaleTimeString();
        setHero('bad', 'Could not load sync health', String(err.message || err));
        if(!body.innerHTML){
          body.innerHTML = '<div class="card"><div class="pad sub">Retrying every 30 seconds. ' +
            'If this persists, check that the engine is running.</div></div>';
        }
      });
  }

  function loadDestinations(){
    return fetch('/api/destinations', {headers:{accept:'application/json'}})
      .then(function(r){ return r.ok ? r.json() : null; })
      .then(function(j){ if(j){ DESTS = j.destinations || []; render(); } })
      .catch(function(){ /* the object rows are the page; grouping is a bonus */ });
  }

  loadDestinations().then(load);
  setInterval(load, 30000);
  setInterval(loadDestinations, 30000);
})();
</script>`
