import express from 'express'

import { RETENTION } from '../retention.js'

export const legalRouter = express.Router()

// Both pages must be reachable without a session and without a redirect:
// Google's OAuth reviewer and HubSpot's marketplace reviewer open them as
// anonymous visitors, and a login wall reads as "no privacy policy".
legalRouter.get('/privacy', (req, res) => res.type('html').send(page(PRIVACY)))
legalRouter.get('/terms', (req, res) => res.type('html').send(page(TERMS)))

// Filled in from the environment so the address can change without a code
// change. Until it is set the pages say so rather than naming an inbox that
// does not exist — a contact address nobody reads is worse than none.
const CONTACT = process.env.SUPPORT_EMAIL || ''
const EFFECTIVE = '8 September 2026'

const mail = () =>
  CONTACT
    ? `<a href="mailto:${CONTACT}">${CONTACT}</a>`
    : '<strong>[contact address pending]</strong>'

const DRAFT_NOTICE = CONTACT
  ? ''
  : `<div class="notice"><strong>Draft.</strong> This document is not yet in force:
     a monitored contact address has still to be published, and the operating
     entity named below has still to be completed. Do not rely on it until both
     are filled in.</div>`

const page = (body) => `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${body.title} — Syncive</title>
<style>
  :root{--bg:#f7f8fa;--panel:#fff;--border:#e4e7ec;--text:#101828;--muted:#667085;
        --accent:#2563eb;--warn:#b54708;--warn-soft:#fef4e6}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--text);
       font:16px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,system-ui,sans-serif;
       -webkit-font-smoothing:antialiased}
  a{color:var(--accent)}
  .topbar{background:rgba(255,255,255,.9);border-bottom:1px solid var(--border);
          position:sticky;top:0;backdrop-filter:blur(8px)}
  .topbar .inner,.wrap{max-width:46rem;margin:0 auto;padding:0 1.25rem}
  .topbar .inner{display:flex;align-items:center;gap:.6rem;height:3.2rem}
  .mark{width:1.4rem;height:1.4rem;border-radius:.45rem;
        background:linear-gradient(140deg,#2563eb,#7c3aed)}
  .brand{font-weight:650;letter-spacing:-.01em}
  .spacer{flex:1}
  .topbar a{font-size:.85rem;text-decoration:none;color:var(--muted)}
  .topbar a:hover{color:var(--accent)}
  .wrap{padding-top:2.5rem;padding-bottom:5rem}
  h1{font-size:1.9rem;letter-spacing:-.02em;margin:0 0 .3rem}
  .eff{color:var(--muted);font-size:.85rem;margin:0 0 2rem}
  h2{font-size:1.05rem;letter-spacing:-.01em;margin:2.2rem 0 .6rem;
     padding-top:1.2rem;border-top:1px solid var(--border)}
  h3{font-size:.95rem;margin:1.4rem 0 .4rem}
  p,li{color:#344054}
  ul{padding-left:1.2rem}
  li{margin:.3rem 0}
  table{border-collapse:collapse;width:100%;font-size:.9rem;margin:.8rem 0;
        background:var(--panel);border:1px solid var(--border);border-radius:.5rem;
        overflow:hidden}
  th,td{text-align:left;padding:.55rem .7rem;border-bottom:1px solid var(--border);
        vertical-align:top}
  tr:last-child td{border-bottom:0}
  th{background:#fafbfc;font-size:.78rem;text-transform:uppercase;
     letter-spacing:.04em;color:var(--muted);font-weight:600}
  code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.88em;
       background:#fff;border:1px solid var(--border);border-radius:.3rem;padding:.05rem .3rem}
  .notice{background:var(--warn-soft);color:var(--warn);border-radius:.6rem;
          padding:.85rem 1rem;font-size:.9rem;margin-bottom:2rem}
  .foot{margin-top:3rem;padding-top:1.2rem;border-top:1px solid var(--border);
        color:var(--muted);font-size:.82rem}
</style>
<div class="topbar"><div class="inner">
  <span class="mark"></span><span class="brand">Syncive</span>
  <span class="spacer"></span>
  <a href="/privacy">Privacy</a> <a href="/terms">Terms</a>
</div></div>
<div class="wrap">
  <h1>${body.title}</h1>
  <p class="eff">Effective ${EFFECTIVE}</p>
  ${DRAFT_NOTICE}
  ${body.html()}
  <p class="foot">Syncive &middot; <a href="/privacy">Privacy Policy</a> &middot;
     <a href="/terms">Terms of Service</a></p>
</div>`

// ---------------------------------------------------------------------------

const PRIVACY = {
  title: 'Privacy Policy',
  html: () => `
<p>Syncive copies records from your HubSpot portal into a destination you
control — a Postgres database you own, or a Google Sheets spreadsheet in your
own Google Drive. This policy explains what Syncive holds in order to do that,
for how long, and who else it touches.</p>

<p>Syncive ("we", "us") is operated from India. Contact: ${mail()}.</p>

<h2>1. Our role</h2>
<p>Two different kinds of data are involved and they are governed differently:</p>
<ul>
  <li><strong>Your CRM records.</strong> You are the <em>controller</em>; Syncive
    is a <em>processor</em> acting on your instructions. We move these records
    from HubSpot to the destination you chose. We do not decide what is in them
    and we do not use them for our own purposes.</li>
  <li><strong>Your account with us</strong> — who installed Syncive, which portal
    is connected, what is configured, what the sync did. For this we are the
    controller.</li>
</ul>

<h2>2. What Syncive stores</h2>
<p>Syncive does <strong>not</strong> keep a copy of your CRM. Records are read
from HubSpot, written to your destination, and not retained. There are three
narrow exceptions, listed in the table, and we would rather state them plainly
than claim a clean "we store nothing".</p>

<table>
  <tr><th>What</th><th>Why</th><th>Kept for</th></tr>
  <tr><td>Your email address and an account identifier</td>
      <td>To identify your account and sign you in</td>
      <td>Life of the account</td></tr>
  <tr><td>HubSpot access and refresh tokens, portal ID, granted scopes</td>
      <td>To read from HubSpot on your behalf</td>
      <td>Until you disconnect or uninstall</td></tr>
  <tr><td>Your destination credentials — Postgres connection details, or a Google
          refresh token and the ID of the spreadsheet Syncive created</td>
      <td>To write to the destination you chose</td>
      <td>Until you remove the destination</td></tr>
  <tr><td>Sync configuration — object types, schema or spreadsheet name, paging
          cursor</td>
      <td>To run and resume the sync</td>
      <td>Until you remove the sync</td></tr>
  <tr><td><strong>Exception 1.</strong> Sync event log: timestamps, event type,
          success or failure, record counts, error messages, and the HubSpot
          record ID an event concerned</td>
      <td>To show you sync health and to diagnose failures</td>
      <td>${RETENTION.syncEventDays} days</td></tr>
  <tr><td><strong>Exception 2.</strong> Retry queue. When a change cannot be
          delivered after every retry, the HubSpot notification for it is parked
          so it is not lost. That notification names the record and the property
          that changed, <em>and can include the changed value</em> — so it can
          contain personal data.</td>
      <td>So a failed change can be retried instead of silently disappearing</td>
      <td>${RETENTION.resolvedDeadLetterDays} days after it is delivered;
          ${RETENTION.openDeadLetterDays} days if it never is</td></tr>
  <tr><td><strong>Exception 3.</strong> For Google Sheets destinations, a map of
          HubSpot record ID to spreadsheet row number</td>
      <td>Sheets has no way to update a row by key; without this map an edit
          would append a duplicate row instead of updating the right one</td>
      <td>Until you remove the sync</td></tr>
  <tr><td>A signed session cookie (<code>syncive_session</code>)</td>
      <td>To keep you signed in. Strictly necessary; no analytics or advertising
          cookies are set</td>
      <td>30 days</td></tr>
</table>

<p>Credentials — HubSpot tokens, Google tokens, database connection details —
are encrypted with AES-256-GCM before they are written to disk, and are never
written to logs.</p>

<h2>3. What Syncive never does</h2>
<ul>
  <li>We do not sell or rent any data, and we have no advertising of any kind.</li>
  <li>We do not share your data with data brokers or advertising platforms.</li>
  <li>We do not use your CRM records, or Google user data, to train machine
      learning or AI models.</li>
  <li>We do not read anything in your Google Drive other than the spreadsheet
      Syncive itself created (see below).</li>
  <li>We do not write anything back to HubSpot. Every HubSpot scope Syncive
      requests is read-only, apart from <code>oauth</code>.</li>
</ul>

<h2>4. Google user data</h2>
<p>If you choose a Google Sheets destination, Syncive requests a single scope,
<code>drive.file</code>. That scope grants access only to files the application
itself created. Syncive creates the spreadsheet for you; it cannot see, open or
list anything else in your Drive, including files you created yourself.</p>
<p>Syncive's use and transfer of information received from Google APIs adheres
to the
<a href="https://developers.google.com/terms/api-services-user-data-policy"
   target="_blank" rel="noopener">Google API Services User Data Policy</a>,
including the Limited Use requirements. Concretely: Google user data is used
only to write your HubSpot records into that spreadsheet and to show you the
result, it is not transferred to anyone except as required by law, and it is
never used for advertising or model training.</p>
<p>You can revoke Syncive's access at any time at
<a href="https://myaccount.google.com/permissions" target="_blank"
   rel="noopener">myaccount.google.com/permissions</a>. The spreadsheet is yours
and stays in your Drive.</p>

<h2>5. Legal bases (UK and EU)</h2>
<ul>
  <li><strong>Performance of a contract</strong> — running the sync you asked
      for, holding the credentials it needs, keeping you signed in.</li>
  <li><strong>Legitimate interests</strong> — keeping the service secure and
      working, and holding a short operational log so failures can be diagnosed.
      We keep that log small and short-lived for this reason.</li>
  <li><strong>Legal obligation</strong> — where we must retain or disclose
      something by law.</li>
</ul>
<p>For the CRM records themselves, your own legal basis as controller applies;
Syncive processes them only on your documented instructions.</p>

<h2>6. Sub-processors and where data is held</h2>
<table>
  <tr><th>Provider</th><th>Purpose</th><th>Location</th></tr>
  <tr><td>Render</td><td>Application hosting</td><td>United States (Oregon)</td></tr>
  <tr><td>Supabase</td><td>Syncive's own metadata database</td><td>United States</td></tr>
</table>
<p>HubSpot and Google are the sources you connect, not our sub-processors; your
relationship with them is governed by your own agreements with them. Your
destination — your database, or your Google Drive — is yours, and is not a
sub-processor of ours either.</p>
<p>Syncive is operated from India and hosted in the United States, so data is
transferred internationally. Where UK or EU personal data is transferred, we
rely on the appropriate safeguards under Article 46 UK/EU GDPR, including
Standard Contractual Clauses with our providers.</p>

<h2>7. Security</h2>
<ul>
  <li>All credentials are encrypted at rest with AES-256-GCM under a key held
      separately from the database.</li>
  <li>All connections to HubSpot, Google and your destination require TLS. There
      is no option to turn TLS off.</li>
  <li>Session cookies are HMAC-signed, HttpOnly, SameSite=Lax and Secure over
      HTTPS. Every account-scoped request is checked against the session, so
      knowing an identifier is not enough to read anyone's data.</li>
  <li>Syncive writes only to the schema or spreadsheet you name, and reads
      nothing else in your database.</li>
</ul>
<p>No service can promise perfect security. If a breach affects your personal
data we will notify you and, where required, the relevant supervisory authority
without undue delay.</p>

<h2>8. Your rights</h2>
<p>If you are in the UK or EU you have the right to access, correct, delete,
restrict, object to, and port your personal data, and to withdraw consent where
we rely on it. To exercise any of these, write to ${mail()}. We will respond
within one month. You also have the right to complain to your supervisory
authority — in the UK, the Information Commissioner's Office.</p>
<p>Because Syncive holds so little, most of this is immediate:</p>
<ul>
  <li><strong>Stop processing:</strong> pause a sync, or disconnect HubSpot, from
      your dashboard.</li>
  <li><strong>Delete credentials:</strong> disconnecting removes Syncive from
      your HubSpot account and deletes the tokens and connection details we
      hold.</li>
  <li><strong>Delete everything:</strong> email us and we will delete your
      account and all associated records.</li>
</ul>
<p>Records already written to your own database or spreadsheet are yours and are
not touched by any of this — deleting your Syncive account does not delete your
data, and we could not delete it if we wanted to.</p>

<h2>9. Children</h2>
<p>Syncive is a business tool and is not directed at anyone under 16. We do not
knowingly collect personal data from children.</p>

<h2>10. Changes</h2>
<p>If we change how we handle data we will update this page and change the
effective date above. Where a change materially affects you, we will tell you
before it takes effect.</p>

<h2>11. Contact</h2>
<p>Questions, requests or complaints: ${mail()}.</p>
`,
}

// ---------------------------------------------------------------------------

const TERMS = {
  title: 'Terms of Service',
  html: () => `
<p>These terms govern your use of Syncive. By installing Syncive or connecting a
destination, you agree to them. If you are agreeing on behalf of a company, you
confirm you are authorised to do so.</p>

<h2>1. What Syncive does</h2>
<p>Syncive reads records from a HubSpot portal you connect and writes them into a
destination you control: a Postgres database you own, or a Google Sheets
spreadsheet Syncive creates in your Google Drive. It performs a first full copy,
then applies changes as HubSpot reports them, and re-checks for missed changes
each hour.</p>

<h2>2. Early access, and what that means</h2>
<p>Syncive is currently free and in early access. Plainly:</p>
<ul>
  <li>There is <strong>no uptime commitment</strong> and no service level
      agreement. The service currently runs on infrastructure that sleeps when
      idle, so a change may take up to a minute to apply after a quiet period.</li>
  <li>Features may change or be withdrawn, and the service may be suspended or
      discontinued. We will give reasonable notice before discontinuing it.</li>
  <li>We may introduce paid plans in future. We will not start charging you
      without notice and without your agreement.</li>
  <li><strong>Syncive is not a backup product.</strong> Do not rely on it as your
      only copy of anything.</li>
</ul>

<h2>3. Your account and credentials</h2>
<p>You are responsible for the credentials you give Syncive and for who you let
into your account. Give Syncive the least access that works: a database user
that can write only to the schema you nominate. The setup page prints the exact
grants for this. Tell us promptly at ${mail()} if you believe your account has
been accessed by someone else.</p>

<h2>4. Your responsibilities</h2>
<ul>
  <li>You must have the right to copy the records you sync, and to place them in
      the destination you have chosen. If those records include personal data,
      you are the controller and responsible for having a lawful basis and for
      informing the people concerned.</li>
  <li>The destination is yours. You are responsible for securing it, backing it
      up, and for who can query it.</li>
  <li>You must comply with your own agreements with HubSpot and Google. Your use
      of their services is governed by their terms, not ours.</li>
</ul>

<h2>5. Acceptable use</h2>
<p>Do not use Syncive to break the law, to infringe anyone's rights, to attack
or overload our systems or anyone else's, to work around HubSpot's or Google's
rate limits or terms, or to sync data you have no right to. We may suspend an
account that does.</p>

<h2>6. Your data</h2>
<p>Your data stays yours. Syncive claims no ownership of your CRM records and
acquires no right to use them beyond running the sync you configured. What we
hold in order to run it, and for how long, is set out in the
<a href="/privacy">Privacy Policy</a>, which forms part of these terms. Where we
process personal data on your behalf we do so only on your instructions.</p>

<h2>7. Availability and changes to the service</h2>
<p>We aim to keep Syncive running and to fix what breaks, but the service is
provided as it is. Maintenance, provider outages, and limits imposed by HubSpot
or Google can interrupt it.</p>

<h2>8. Termination</h2>
<p>You can stop at any time: pause a sync, remove a destination, or disconnect
HubSpot from your dashboard, which also removes Syncive from your HubSpot
account. Uninstalling Syncive in HubSpot has the same effect. We may suspend or
end your access if you breach these terms, or if we discontinue the service.</p>
<p>Ending your use does not delete anything already written to your own database
or spreadsheet. That data is yours and remains exactly where it is.</p>

<h2>9. Disclaimers</h2>
<p>To the fullest extent the law allows, Syncive is provided "as is" and "as
available", without warranties of any kind, express or implied, including
merchantability, fitness for a particular purpose and non-infringement. We do not
warrant that the service will be uninterrupted, error-free, or that every record
will be delivered without delay.</p>
<p>Nothing in these terms limits any right you have that cannot be limited by
law, including rights you may have as a consumer.</p>

<h2>10. Limitation of liability</h2>
<p>To the fullest extent the law allows, Syncive is not liable for indirect,
incidental, special or consequential loss, or for lost profits, lost revenue,
lost business, or lost or corrupted data. Our total liability arising out of or
relating to Syncive is limited to the greater of the amount you paid us in the
twelve months before the claim, or USD 100. As Syncive is currently free, that
figure will normally be USD 100.</p>
<p>Nothing here excludes liability for death or personal injury caused by
negligence, for fraud, or for anything else that cannot lawfully be excluded.</p>

<h2>11. Changes to these terms</h2>
<p>We may update these terms. The effective date above will change, and where the
change materially affects you we will tell you before it takes effect. Continuing
to use Syncive after that means you accept the updated terms.</p>

<h2>12. Governing law</h2>
<p>These terms are governed by the laws of India, and the courts of India have
jurisdiction — except where the law of your country of residence gives you the
right to bring proceedings, or requires a different law to apply.</p>

<h2>13. Contact</h2>
<p>${mail()}</p>
`,
}
