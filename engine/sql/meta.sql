-- Syncive engine metadata schema.
-- Lives in OUR database. Holds no copy of the customer's CRM: only wiring, logs,
-- and — in dead_letters — the HubSpot notifications we could not deliver, which
-- name a record and can carry the changed property's value. That table is the
-- one place customer personal data can come to rest here, so it is pruned on a
-- schedule (see src/retention.js) and is disclosed in the privacy policy.

create schema if not exists syncive;

-- One row per customer account (matches a Supabase auth user).
create table if not exists syncive.accounts (
  id          uuid primary key default gen_random_uuid(),
  email       text        not null unique,
  plan        text        not null default 'free',
  created_at  timestamptz not null default now()
);

-- A connected HubSpot portal. Tokens are encrypted at rest (AES-256-GCM).
create table if not exists syncive.hubspot_connections (
  id                 uuid primary key default gen_random_uuid(),
  account_id         uuid not null references syncive.accounts(id) on delete cascade,
  portal_id          bigint      not null,
  access_token_enc   text        not null,
  refresh_token_enc  text        not null,
  expires_at         timestamptz not null,
  scopes             text[]      not null default '{}',
  created_at         timestamptz not null default now(),
  unique (account_id, portal_id)
);

-- Set when the customer uninstalls in HubSpot or revokes our access. A revoked
-- connection is kept, not deleted: the dashboard has to be able to explain why
-- the sync stopped, and "the row vanished" explains nothing.
alter table syncive.hubspot_connections
  add column if not exists revoked_at timestamptz,
  add column if not exists revoked_reason text;

-- Two different reasons a sync can be switched off, and they must not be
-- confused: the customer paused it, or access went away. Reconnecting should
-- undo the second and leave the first alone.
alter table syncive.syncs
  add column if not exists paused_by_user boolean not null default false;

-- A destination is no longer always a database. Sheets destinations keep an
-- encrypted JSON blob (Google refresh token, spreadsheet id, tab names) instead
-- of a connection string, so the DSN cannot stay mandatory.
alter table syncive.destinations
  add column if not exists config_enc text;
alter table syncive.destinations
  alter column dsn_enc drop not null;

-- Google Sheets has no upsert and no usable per-row identity: developer metadata
-- is capped at 30,000 characters per sheet, which is roughly 700 tagged rows. So
-- the mapping from HubSpot record to row number lives here, where it is cheap,
-- and is reconciled against the sheet's own ID column when they disagree.
create table if not exists syncive.sheet_rows (
  sync_id       uuid not null references syncive.syncs(id) on delete cascade,
  hubspot_id    text not null,
  row_number    integer not null,
  primary key (sync_id, hubspot_id)
);
create index if not exists sheet_rows_position_idx
  on syncive.sheet_rows (sync_id, row_number);

-- Where the data goes. The connection string is encrypted; we never log it.
create table if not exists syncive.destinations (
  id            uuid primary key default gen_random_uuid(),
  account_id    uuid not null references syncive.accounts(id) on delete cascade,
  kind          text not null default 'postgres',
  dsn_enc       text not null,
  schema_name   text not null default 'hubspot',
  status        text not null default 'pending',   -- pending | ready | error
  last_error    text,
  created_at    timestamptz not null default now()
);

-- One sync = one HubSpot object type flowing into one destination.
create table if not exists syncive.syncs (
  id               uuid primary key default gen_random_uuid(),
  account_id       uuid not null references syncive.accounts(id) on delete cascade,
  connection_id    uuid not null references syncive.hubspot_connections(id) on delete cascade,
  destination_id   uuid not null references syncive.destinations(id) on delete cascade,
  object_type      text not null,                  -- contacts | companies | deals
  enabled          boolean not null default true,
  state            text not null default 'idle',   -- idle | backfilling | live | error
  backfill_cursor  text,                           -- HubSpot paging cursor, so we resume not restart
  backfilled_at    timestamptz,
  last_event_at    timestamptz,
  last_success_at  timestamptz,
  created_at       timestamptz not null default now(),
  unique (destination_id, object_type)
);

-- Every attempt, good or bad. This table is what the health dashboard reads.
create table if not exists syncive.sync_events (
  id           bigint generated always as identity primary key,
  sync_id      uuid not null references syncive.syncs(id) on delete cascade,
  kind         text not null,          -- backfill_page | webhook | reconcile | error
  status       text not null,          -- ok | failed | retrying
  record_count int  not null default 0,
  hubspot_id   text,
  message      text,
  created_at   timestamptz not null default now()
);

create index if not exists sync_events_sync_time_idx
  on syncive.sync_events (sync_id, created_at desc);

-- Rows we could not deliver. Nothing disappears silently; this is the retry queue of record.
create table if not exists syncive.dead_letters (
  id           bigint generated always as identity primary key,
  sync_id      uuid not null references syncive.syncs(id) on delete cascade,
  hubspot_id   text not null,
  payload      jsonb,
  error        text,
  attempts     int  not null default 0,
  resolved_at  timestamptz,
  created_at   timestamptz not null default now()
);

create index if not exists dead_letters_open_idx
  on syncive.dead_letters (sync_id) where resolved_at is null;
