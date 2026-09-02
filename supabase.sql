-- Syncive waitlist table
-- Paste this whole file into Supabase → SQL Editor → Run

create table if not exists public.waitlist (
  id          bigint generated always as identity primary key,
  email       text        not null unique,
  company     text,
  source      text        default 'landing',
  created_at  timestamptz not null default now()
);

-- Row Level Security on, with no public policies:
-- only the service_role key (used server-side by the API route) can read or write.
alter table public.waitlist enable row level security;

-- Handy view for you: newest signups first
create or replace view public.waitlist_recent as
  select email, company, created_at
  from public.waitlist
  order by created_at desc;
