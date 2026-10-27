-- Expiring leases for cross-process job exclusion.
--
-- The Google review sweep serialised itself with a SESSION advisory lock on a
-- dedicated client. Behind a transaction pooler (Supabase :6543) a session lock
-- neither excludes nor releases reliably, and a leaked one (or an invocation killed
-- mid-sweep) made every later run report "skipped" forever, silently.
--
-- A lease row has neither failure: it is taken and released with ordinary
-- statements (pooler-safe), and it EXPIRES, so a killed run only delays the next
-- one by its ttl instead of disabling the job.
create table if not exists public.job_leases (
  name       text primary key,
  holder     text not null,
  held_until timestamptz not null
);

-- Owner-only: the jobs run as arena_owner, which bypasses RLS. No policy and no
-- grant to arena_app, so nothing a tenant session does can touch a lease.
alter table public.job_leases enable row level security;

comment on table public.job_leases is
  'Expiring leases that serialise scheduled jobs (lib/cron/lease.ts). A row is free once held_until has passed.';
