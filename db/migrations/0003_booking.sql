-- ============================================================================
-- Arena OS — 0003 booking: generic resources + booking engine
--
-- The industry-agnostic core: a booking reserves a generic RESOURCE (a PS5
-- station, a studio room, a VR pod) for a time window. Industry = config, not
-- code. Double-booking is made STRUCTURALLY impossible by a GiST exclusion
-- constraint on booking_slots — not by application checks that can be forgotten.
-- ============================================================================

-- btree_gist is a trusted extension (PG13+): the DB owner (arena_owner) may
-- install it without superuser. Needed to combine `resource_id WITH =` and a
-- range overlap in one exclusion constraint.
create extension if not exists btree_gist;

-- ── enums ────────────────────────────────────────────────────────────────────
do $$ begin
  create type public.resource_status as enum ('available','maintenance','inactive');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.booking_status as enum
    ('confirmed','checked_in','completed','cancelled','no_show');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.booking_source as enum ('walk_in','staff','online');
exception when duplicate_object then null; end $$;

-- ── resource_types (tenant-level catalogue) ──────────────────────────────────
create table if not exists public.resource_types (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  name           text not null,
  description    text,
  hourly_rate    numeric(10,2) not null default 0 check (hourly_rate >= 0),
  buffer_minutes integer not null default 0 check (buffer_minutes >= 0),
  capacity       integer check (capacity is null or capacity > 0), -- e.g. players/seats
  color          text,                                            -- calendar hint
  is_active      boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (tenant_id, name)
);
create index if not exists idx_resource_types_tenant on public.resource_types(tenant_id);
drop trigger if exists trg_resource_types_updated on public.resource_types;
create trigger trg_resource_types_updated before update on public.resource_types
  for each row execute function public.set_updated_at();

-- ── resources (individual bookable units, live at a branch) ───────────────────
create table if not exists public.resources (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references public.tenants(id) on delete cascade,
  branch_id          uuid not null references public.branches(id) on delete cascade,
  resource_type_id   uuid not null references public.resource_types(id) on delete restrict,
  name               text not null,
  hourly_rate_override numeric(10,2) check (hourly_rate_override is null or hourly_rate_override >= 0),
  status             public.resource_status not null default 'available',
  sort_order         integer not null default 0,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (tenant_id, name)
);
create index if not exists idx_resources_branch on public.resources(tenant_id, branch_id);
create index if not exists idx_resources_type on public.resources(resource_type_id);
drop trigger if exists trg_resources_updated on public.resources;
create trigger trg_resources_updated before update on public.resources
  for each row execute function public.set_updated_at();

-- ── working_hours (per branch, per weekday; 0=Sunday) ────────────────────────
create table if not exists public.working_hours (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  branch_id  uuid not null references public.branches(id) on delete cascade,
  day_of_week smallint not null check (day_of_week between 0 and 6),
  open_time  time not null default '10:00',
  close_time time not null default '22:00',
  is_closed  boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (branch_id, day_of_week),
  check (is_closed or close_time > open_time)
);
create index if not exists idx_working_hours_branch on public.working_hours(tenant_id, branch_id);
drop trigger if exists trg_working_hours_updated on public.working_hours;
create trigger trg_working_hours_updated before update on public.working_hours
  for each row execute function public.set_updated_at();

-- ── bookings ─────────────────────────────────────────────────────────────────
create table if not exists public.bookings (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  branch_id      uuid not null references public.branches(id) on delete restrict,
  booking_number text not null,
  customer_name  text,
  customer_phone text,
  customer_email text,
  status         public.booking_status not null default 'confirmed',
  source         public.booking_source not null default 'staff',
  subtotal       numeric(10,2) not null default 0,
  discount       numeric(10,2) not null default 0,
  tax            numeric(10,2) not null default 0,
  total          numeric(10,2) not null default 0,
  deposit        numeric(10,2) not null default 0,
  notes          text,
  created_by     uuid references public.memberships(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  checked_in_at  timestamptz,
  completed_at   timestamptz,
  cancelled_at   timestamptz,
  unique (tenant_id, booking_number)
);
create index if not exists idx_bookings_branch on public.bookings(tenant_id, branch_id);
create index if not exists idx_bookings_status on public.bookings(tenant_id, status);
drop trigger if exists trg_bookings_updated on public.bookings;
create trigger trg_bookings_updated before update on public.bookings
  for each row execute function public.set_updated_at();

-- ── booking_slots (a resource reserved for a window) ─────────────────────────
create table if not exists public.booking_slots (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references public.tenants(id) on delete cascade,
  booking_id         uuid not null references public.bookings(id) on delete cascade,
  resource_id        uuid not null references public.resources(id) on delete restrict,
  starts_at          timestamptz not null,
  ends_at            timestamptz not null,
  rate_applied       numeric(10,2) not null default 0,
  slot_total         numeric(10,2) not null default 0,
  resource_name      text not null,
  resource_type_name text not null,
  -- kept in sync with the parent booking's status by trigger (below); the
  -- exclusion constraint only blocks OVERLAP among *active* slots, so cancelling
  -- a booking frees its time automatically.
  active             boolean not null default true,
  created_at         timestamptz not null default now(),
  check (ends_at > starts_at),
  -- THE core invariant: no two active slots for the same resource may overlap.
  constraint booking_slots_no_overlap
    exclude using gist (
      resource_id with =,
      tstzrange(starts_at, ends_at) with &&
    ) where (active)
);
create index if not exists idx_booking_slots_booking on public.booking_slots(booking_id);
create index if not exists idx_booking_slots_resource_time
  on public.booking_slots(resource_id, starts_at) where (active);

-- Keep booking_slots.active in lockstep with the booking lifecycle. A slot is
-- active unless its booking is cancelled or a no-show — so those states release
-- the time for rebooking, while confirmed/checked_in/completed keep it.
create or replace function public.sync_booking_slot_active()
returns trigger language plpgsql as $$
begin
  update public.booking_slots
     set active = (new.status not in ('cancelled','no_show'))
   where booking_id = new.id
     and active <> (new.status not in ('cancelled','no_show'));
  return new;
end;
$$;
drop trigger if exists trg_bookings_sync_slots on public.bookings;
create trigger trg_bookings_sync_slots after update of status on public.bookings
  for each row execute function public.sync_booking_slot_active();

-- ============================================================================
-- RLS + grants
-- ============================================================================
alter table public.resource_types enable row level security;
alter table public.resources      enable row level security;
alter table public.working_hours  enable row level security;
alter table public.bookings       enable row level security;
alter table public.booking_slots  enable row level security;

-- Settings tables: any member may read; only owner/manager may write.
drop policy if exists resource_types_select on public.resource_types;
create policy resource_types_select on public.resource_types
  for select using (tenant_id in (select public.auth_tenant_ids()));
drop policy if exists resource_types_write on public.resource_types;
create policy resource_types_write on public.resource_types
  for all using (public.auth_is_manager(tenant_id))
          with check (public.auth_is_manager(tenant_id));

drop policy if exists resources_select on public.resources;
create policy resources_select on public.resources
  for select using (tenant_id in (select public.auth_tenant_ids()));
drop policy if exists resources_write on public.resources;
create policy resources_write on public.resources
  for all using (public.auth_is_manager(tenant_id))
          with check (public.auth_is_manager(tenant_id));

drop policy if exists working_hours_select on public.working_hours;
create policy working_hours_select on public.working_hours
  for select using (tenant_id in (select public.auth_tenant_ids()));
drop policy if exists working_hours_write on public.working_hours;
create policy working_hours_write on public.working_hours
  for all using (public.auth_is_manager(tenant_id))
          with check (public.auth_is_manager(tenant_id));

-- Operational tables: any active member may read AND write (front-desk staff
-- create/manage bookings).
drop policy if exists bookings_rw on public.bookings;
create policy bookings_rw on public.bookings
  for all using (tenant_id in (select public.auth_tenant_ids()))
          with check (tenant_id in (select public.auth_tenant_ids()));
drop policy if exists booking_slots_rw on public.booking_slots;
create policy booking_slots_rw on public.booking_slots
  for all using (tenant_id in (select public.auth_tenant_ids()))
          with check (tenant_id in (select public.auth_tenant_ids()));

grant select, insert, update, delete on public.resource_types to arena_app;
grant select, insert, update, delete on public.resources      to arena_app;
grant select, insert, update, delete on public.working_hours  to arena_app;
grant select, insert, update, delete on public.bookings       to arena_app;
grant select, insert, update, delete on public.booking_slots  to arena_app;
