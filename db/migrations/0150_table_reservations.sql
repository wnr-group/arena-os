-- ============================================================================
-- Arena OS — 0150 Table reservations (M20 / AROS-176)
--
-- Additive only. Numbered after the last merged migration (0149); PR #18's
-- reserved block (0124–0145) is untouched. Renumber at merge time if needed.
--
-- A reservation is NOT a new entity. It is the existing timed booking on a
-- table resource — a `bookings` row with `cover_count`, `reserved_for`,
-- `resource_id` NULL and one `booking_slots` row — so the booking_slots exclusion constraint (0003)
-- already makes double-booking a table structurally impossible, and the M37
-- advance window applies unchanged. `resource_id` deliberately stays NULL
-- until the party arrives: idx_bookings_open_table_session (0071) would
-- otherwise treat the future reservation as the table's open session.
--
-- Seating converts that SAME booking (lib/reservations/service.ts): sets
-- resource_id + checked_in and drops the reservation's slot, so a seated
-- table is exactly the shape seatTableSessionCore produces. `reserved_for`
-- survives the conversion, which is how a seated reservation is still
-- recognisable (and reportable) afterwards. No-show lapse
-- reuses the existing 'no_show' status, whose trigger (0003) frees the slot.
--
-- This migration adds:
--   1. reservation_settings — per-tenant opt-in + the knobs (default OFF, so
--      existing restaurants see no change until an owner enables it).
--   2. a partial index for the reservation list / no-show sweep.
--   3. module.table_reservations entitlement (Pro/Enterprise).
-- ============================================================================

-- ── 1. settings ─────────────────────────────────────────────────────────────
create table if not exists public.reservation_settings (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,

  -- Master switch. Off => no reservation UI, and seating a walk-in ignores
  -- reservations entirely (seatTableSessionCore's guard short-circuits).
  enabled boolean not null default false,

  -- Tables have no hourly rate, so a reservation needs its own length.
  default_duration_minutes integer not null default 90
    check (default_duration_minutes between 15 and 480),

  -- A confirmed reservation not seated this long after its start lapses to
  -- 'no_show' and releases the table.
  no_show_grace_minutes integer not null default 15
    check (no_show_grace_minutes between 5 and 240),

  -- A walk-in cannot be seated at a table whose reservation starts within this
  -- many minutes (staff may override with a reason-free confirm).
  walkin_buffer_minutes integer not null default 45
    check (walkin_buffer_minutes between 0 and 480),

  -- Whether the public storefront offers "Book a table".
  public_enabled boolean not null default false,
  max_party_size integer not null default 12
    check (max_party_size between 1 and 100),

  updated_at timestamptz not null default now(),
  updated_by uuid references public.memberships(id) on delete set null
);

drop trigger if exists trg_reservation_settings_updated on public.reservation_settings;
create trigger trg_reservation_settings_updated
  before update on public.reservation_settings
  for each row execute function public.set_updated_at();

alter table public.reservation_settings enable row level security;

drop policy if exists reservation_settings_select on public.reservation_settings;
create policy reservation_settings_select on public.reservation_settings
  for select using (tenant_id in (select public.auth_tenant_ids()));

-- Each command is its own policy with USING + WITH CHECK spelled out
-- (AROS-183 / AROS-294): an UPDATE or `SELECT … FOR UPDATE` against a table
-- with no UPDATE policy silently matches zero rows.
drop policy if exists reservation_settings_manager_insert on public.reservation_settings;
create policy reservation_settings_manager_insert on public.reservation_settings
  for insert with check (public.auth_is_manager(tenant_id));

drop policy if exists reservation_settings_manager_update on public.reservation_settings;
create policy reservation_settings_manager_update on public.reservation_settings
  for update using (public.auth_is_manager(tenant_id))
          with check (public.auth_is_manager(tenant_id));

drop policy if exists reservation_settings_manager_delete on public.reservation_settings;
create policy reservation_settings_manager_delete on public.reservation_settings
  for delete using (public.auth_is_manager(tenant_id));

-- The anonymous storefront reads the visited tenant's row to decide whether to
-- offer "Book a table" and to enforce party size / duration server-side.
drop policy if exists reservation_settings_public_select on public.reservation_settings;
create policy reservation_settings_public_select on public.reservation_settings
  for select using (tenant_id = public.current_public_tenant_id());

grant select, insert, update, delete on public.reservation_settings to arena_app;

-- ── 2. bookings columns + index ────────────────────────────────────────────
-- Null for every booking that was not a table reservation (i.e. all existing
-- rows), so nothing existing changes meaning.
alter table public.bookings
  add column if not exists reserved_for timestamptz,
  add column if not exists reserved_minutes integer
    check (reserved_minutes is null or reserved_minutes > 0);

comment on column public.bookings.reserved_for is
  'Start time a table reservation was made for (M20). Set once at creation and kept after the
   party is seated, so a converted reservation stays distinguishable from a walk-in.';
comment on column public.bookings.reserved_minutes is
  'Length of the table reservation in minutes (M20), snapshotted at creation.';

create index if not exists idx_bookings_reserved_for
  on public.bookings(tenant_id, branch_id, reserved_for)
  where reserved_for is not null;

-- ── 3. entitlement ──────────────────────────────────────────────────────────
-- Same shape as module.kitchen_display (0146): Pro/Enterprise on, Starter and
-- Grandfathered off; a plan with no row is denied (fail-closed).
insert into public.plan_entitlements (plan_id, key, value)
select p.id,
       'module.table_reservations',
       case when lower(btrim(p.name)) in ('pro', 'enterprise') then 'true'::jsonb else 'false'::jsonb end
  from public.plans p
 where lower(btrim(p.name)) in ('starter', 'pro', 'enterprise', 'grandfathered')
on conflict (plan_id, key) do nothing;
