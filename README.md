# Syncive

Real-time HubSpot ↔ Postgres sync. This repo currently holds the marketing site
and waitlist for the private beta.

**Live:** _(add your Vercel URL here)_

## Stack

- Next.js 14 (App Router), no CSS framework — one stylesheet in `app/globals.css`
- Waitlist API route at `app/api/waitlist/route.js` → Supabase REST
- Deployed on Vercel, free tier

## Setup

See [SETUP.md](./SETUP.md) — browser-only, about 15 minutes.

## Environment variables

| Name | Where it comes from |
|---|---|
| `SUPABASE_URL` | Supabase → Project Settings → API → Project URL |
| `SUPABASE_SERVICE_KEY` | Supabase → Project Settings → API → `service_role` key |

Both are set in Vercel → Settings → Environment Variables. Never commit them.

## Local development (optional — not required)

```bash
npm install
npm run dev
```

## Structure

```
app/
  layout.jsx            # metadata, global css
  page.jsx              # the landing page
  globals.css           # all styles, light + dark
  api/waitlist/route.js # POST { email, company } -> Supabase
supabase.sql            # waitlist table + RLS, paste into Supabase SQL editor
SETUP.md                # step-by-step deploy guide
```

## Roadmap

- [x] Landing page + waitlist
- [ ] HubSpot OAuth app (developer portal) + connect flow
- [ ] Postgres connection + table provisioning
- [ ] Backfill worker (checkpointed, rate-limit aware)
- [ ] Webhook ingest + hourly reconciliation
- [ ] Sync-health dashboard + failure alerts
