-- ============================================================================
-- Arena OS — 0097: studio setups — data model
--
-- M24 #1 — the foundation the rest of the studio-setups series builds on
-- (see docs/plans/studio-setups.md). A studio client has ONE physical set
-- (resource) that can be dressed as different named "setups" (Kitchen,
-- Advertisement, Royal…), each with its own price and unit. A booking still
-- reserves the physical resource_id — the existing GiST exclusion constraint
-- on booking_slots (0003) already makes booking any setup on a set block
-- every other setup on that same set, for free. No new locking.
--
-- ── resource_setups ───────────────────────────────────────────────────────
-- A per-SET named priced configuration, child of the physical resource.
-- Setups are OPTIONAL: a set keeps its base resource_types.hourly_rate
-- (today's per-hour behaviour) until the owner defines named setups for it.
-- rate_unit 'day' is the new pricing axis (M24): a per-day setup prices as
-- date-range x day rate, distinct from every existing per-hour resource.
--
-- ── booking_slots snapshot columns ───────────────────────────────────────
-- Same discipline as rate_applied/pricing_mode/head_count (0092/0094):
-- frozen at booking time, never re-derived from live config on read, so a
-- later edit to a setup's name/rate can't reprice a booking already taken.
-- Existing rows read setup_id=null, rate_unit='hour' — byte-identical to
-- today's behaviour.
-- ============================================================================

create table if not exists public.resource_setups (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  resource_id uuid not null references public.resources(id) on delete cascade,
  name        text not null,
  rate        numeric(10,2) not null check (rate >= 0),
  rate_unit   text not null default 'hour' check (rate_unit in ('hour', 'day')),
  is_active   boolean not null default true,
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (resource_id, name)
);
create index if not exists idx_resource_setups_tenant on public.resource_setups(tenant_id);
create index if not exists idx_resource_setups_resource on public.resource_setups(resource_id);
drop trigger if exists trg_resource_setups_updated on public.resource_setups;
create trigger trg_resource_setups_updated before update on public.resource_setups
  for each row execute function public.set_updated_at();

alter table public.booking_slots
  add column if not exists setup_id uuid references public.resource_setups(id) on delete set null,
  add column if not exists setup_name text,
  add column if not exists rate_unit text not null default 'hour';

alter table public.booking_slots
  drop constraint if exists booking_slots_rate_unit_check;
alter table public.booking_slots
  add constraint booking_slots_rate_unit_check
  check (rate_unit in ('hour', 'day'));

comment on table public.resource_setups is
  'M24 #1 — a per-set named priced configuration (Kitchen, Royal, …). Optional: a resource with no setups keeps its base resource_types.hourly_rate. A booking still reserves the physical resource_id, so booking_slots'' existing GiST exclusion (0003) blocks every other setup on the same set for free.';
comment on column public.resource_setups.rate_unit is
  'hour (default) or day. day is the new M24 pricing axis: date-range x day rate, rather than duration x hourly rate.';
comment on column public.booking_slots.setup_id is
  'M24 #1 — the resource_setups row selected for this booking, if any. Null for every base-rate (no-setup) booking. ON DELETE SET NULL: deleting a setup definition must not delete booking history.';
comment on column public.booking_slots.setup_name is
  'Snapshot of the setup''s name at booking time (M24 #1) — same discipline as resource_name/resource_type_name on this table. Null when no setup was selected.';
comment on column public.booking_slots.rate_unit is
  'Snapshot of the pricing unit at booking time (M24 #1): hour (default, every pre-existing row) or day. Frozen so a later edit to the setup can''t reprice a booking already taken.';

-- ============================================================================
-- RLS + grants — mirrors resource_types/resources (0003): any active member
-- may read; only owner/manager may write (the owner defines/manages setups).
-- ============================================================================
alter table public.resource_setups enable row level security;

drop policy if exists resource_setups_select on public.resource_setups;
create policy resource_setups_select on public.resource_setups
  for select using (tenant_id in (select public.auth_tenant_ids()));

drop policy if exists resource_setups_write on public.resource_setups;
create policy resource_setups_write on public.resource_setups
  for all using (public.auth_is_manager(tenant_id))
          with check (public.auth_is_manager(tenant_id));

grant select, insert, update, delete on public.resource_setups to arena_app;
