-- Occurrences the recurring-event job could not create (M15 #8).
--
-- When a generated occurrence's resource blocks collide with a booking that is
-- already in its window, the job now skips THAT occurrence and carries on,
-- instead of rolling the whole series back — which left next_run on the head
-- period forever and stopped every later period too. This table is the record
-- of what was skipped and why, so a manager can see it and resolve it.
--
-- One row per (series, period): a re-run that hits the same clash updates the
-- reason rather than piling up rows. Written only by the job (owner role,
-- bypasses RLS); managers read their own tenant's rows.
create table if not exists public.event_series_skips (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants(id) on delete cascade,
  series_id         uuid not null,
  occurrence_period date not null,
  reason            text not null,
  created_at        timestamptz not null default now(),
  constraint event_series_skips_series_period_key unique (series_id, occurrence_period),
  constraint event_series_skips_series_fk foreign key (tenant_id, series_id)
    references public.event_series(tenant_id, id) on delete cascade
);
create index if not exists idx_event_series_skips_tenant
  on public.event_series_skips(tenant_id, created_at desc);

alter table public.event_series_skips enable row level security;

drop policy if exists event_series_skips_select on public.event_series_skips;
create policy event_series_skips_select on public.event_series_skips
  for select using (public.auth_is_manager(tenant_id));

grant select on public.event_series_skips to arena_app;

comment on table public.event_series_skips is
  'Occurrences scripts/run-recurring-events.ts (lib/events/recurring.ts) skipped because their resources were already booked. The series itself keeps advancing.';
