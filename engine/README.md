# Syncive Engine

The actual product: real-time, checkpointed sync from HubSpot into a customer's own
Postgres, with an event log that can answer "is it working?" without guessing.

The landing page lives in the `syncive` repo. This is the backend.

---

## What it does

| Piece | File | Why it exists |
|---|---|---|
| OAuth install | `src/hubspot/oauth.js` | Signed, expiring `state` — the callback can't be replayed or forged |
| Rate-limited API client | `src/hubspot/client.js` | Per-portal token bucket + 429/5xx backoff, and silent token refresh |
| Schema provisioning | `src/db/dest.js` | Maps HubSpot properties → Postgres columns, adds new ones as they appear |
| Backfill | `src/hubspot/backfill.js` | Chunked and checkpointed: a crash costs one page, not the whole run |
| Webhook ingest | `src/routes/webhooks.js` | Verifies v3 signature, acks in milliseconds, queues the work |
| Reconciliation | `src/reconcile.js` | Hourly re-pull of recently-changed records — the safety net under webhooks |
| Health API | `src/routes/api.js` | Per-sync status, 24h counts, unresolved failures |
| Setup page | `src/routes/connect.js` | Customer pastes their Postgres URL; connection is tested before anything is written |
| Sync dashboard | `src/routes/dashboard.js` | The health API rendered — staleness and failures visible at a glance |
| Dead letters | `sql/meta.sql` | Nothing fails silently; every undelivered record is retryable |

**We never store customer CRM data.** Records flow HubSpot → worker → their database.
Our tables hold connection config (encrypted), sync state, and logs. That's the whole
security story, and it's also why this runs cheaply.

---

## Architecture

```
HubSpot ──webhook──►  server.js  ──►  pg-boss queue  ──►  worker.js
   ▲                                                          │
   └────────── backfill / reconcile pulls ────────────────────┤
                                                              ▼
                                              customer's Postgres (hubspot.*)
```

Two processes: `npm start` (HTTP) and `npm run worker` (jobs). They share one
Postgres — ours — and can scale independently.

On a single-service host (the Render free tier we deploy to) set
`RUN_WORKER_IN_PROCESS=true` and the web process runs the workers itself. Move
them to their own service the moment volume justifies it.

---

## Setup

### 1. Create the HubSpot app (you, once)

developers.hubspot.com → your developer account → **Create app**.

- **Auth tab → Redirect URL:** `https://<your-api-host>/oauth/callback`
- **Auth tab → Scopes:** `oauth`, and read scopes for
  `crm.objects.contacts`, `crm.objects.companies`, `crm.objects.deals`,
  plus the matching `crm.schemas.*` read scopes
- **Webhooks tab → Target URL:** `https://<your-api-host>/webhooks/hubspot`
- **Webhooks tab → Subscriptions:** creation, propertyChange and deletion for
  contact, company and deal
- Copy the **Client ID** and **Client secret** into your env

Read scopes only, on purpose: the first version never writes back to a customer's CRM.

### 2. Environment

Copy `.env.example` → `.env` and fill in. Generate the encryption key once:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 3. Run

```bash
npm install
npm run migrate     # creates the syncive schema in your metadata database
npm start           # HTTP :8080
npm run worker      # queue workers + hourly reconciliation
```

---

## Connecting a customer

```bash
# 1. Install — send them to:
GET /oauth/install?account_id=<uuid>

# 2. Point at their database (probes the connection before saving)
POST /api/destinations
{ "account_id": "...", "dsn": "postgres://user:pass@host:5432/db", "schema_name": "hubspot" }

# 3. Start syncing — queues the backfill immediately
POST /api/syncs
{ "account_id": "...", "connection_id": "...", "destination_id": "...",
  "object_types": ["contacts", "companies", "deals"] }

# 4. Watch it
GET /api/accounts/<accountId>/health
GET /api/syncs/<syncId>/rows
POST /api/syncs/<syncId>/retry-failures
```

`/health` is the endpoint the dashboard renders: per-sync state, last success,
24-hour ok/failed counts, records synced, and unresolved failures.

---

## Tests

```bash
node test-integration.mjs   # crypto, OAuth state, webhook signatures, schema + writes
node test-e2e.mjs           # full backfill against a stubbed HubSpot, 512 records
```

Both need a Postgres to talk to; they create and drop their own schemas.

What they cover, and why each one is there:

- encryption round-trip **and** tamper rejection
- OAuth state signature + forgery + expiry
- webhook signature verification + replay rejection
- event parsing, dedupe of property-change bursts, deletion detection
- column-name sanitising (`Weird Prop-Name!` → `weird_prop_name_`)
- type coercion, including garbage input becoming `null` rather than an exception
- idempotent upserts (re-syncing a record updates, never duplicates)
- schema drift: a property that appears later gets a column and backfills
- soft deletes
- backfill pagination across chunked runs, checkpoint resume after a simulated crash
- health rollup and dead-letter capture

---

## Deploying

One small always-on host runs both processes: an Oracle Cloud Always Free ARM VM,
Fly, or Railway. It needs a **static outbound IP** so customers can allowlist one
address on their database firewall — that requirement rules out most serverless
platforms for the worker.

The HTTP process alone can sit behind anything; the worker is the part that must
stay awake.

---

## Deployed

| Thing | Where |
|---|---|
| Engine | `https://syncive-engine.onrender.com` (Render, free tier) |
| Metadata DB | Supabase Postgres |
| HubSpot app | App ID 51657318, `syncive` project on developer portal 23848834 |
| Landing page | Vercel, `syncive` repo root |

Customer flow, end to end:

1. `/oauth/install?account_id=<uuid>` — HubSpot install
2. `/connect?account=<uuid>` — paste a Postgres URL, pick objects, backfill starts
3. `/dashboard?account=<uuid>` — watch it run

The free tier sleeps after 15 minutes idle and takes ~50s to wake. HubSpot retries
webhooks and the hourly reconcile catches anything missed, so nothing is lost — but
a paid instance is the first thing to buy when a real customer shows up.

---

## Known gaps

Missing:

- Tickets and custom objects
- Two-way sync (write-back to HubSpot) — needs conflict rules before it's safe
- Alerting on `degraded` (email or Slack) — the dashboard only helps if someone looks
- Billing
- Auto-deploy from GitHub (Render is connected by public URL, so deploys are manual)
