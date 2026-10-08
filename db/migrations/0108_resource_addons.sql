-- ============================================================================
-- Arena OS — 0108: resource add-ons — catalog + booking line items (M33 #1)
--
-- Owner-configured optional priced extras (camera, lens, extra equipment —
-- anything rentable alongside a booking) per resource type, with a real stock
-- count. Purely additive: two new tables + one widened CHECK. No backfill —
-- net-new feature, no legacy column to reconcile.
--
-- ── resource_type_addons (catalog) ────────────────────────────────────────
-- Catalog is per resource type but STOCK is pooled per BRANCH. resource_types
-- has no branch column (it is tenant-scoped), so branch scope cannot be
-- inherited through resource_type_id — the catalog row carries its own
-- explicit branch_id. rate_unit is hour|day, flat rate only.
--
-- ── booking_addons (reservation + billing line item) ─────────────────────
-- One row per add-on attached to a booking slot. name/rate_unit/rate_applied
-- are SNAPSHOTS frozen at attach time (same discipline as rate_applied /
-- setup_name on booking_slots): a catalog edit never reprices a live booking.
-- addon_id is ON DELETE SET NULL (mirrors booking_slots.setup_id): deleting a
-- catalog entry must never delete booking history. starts_at/ends_at mirror
-- the slot window so the stock overlap-sum is a single-table query; the
-- application keeps ends_at in lockstep with booking_slots.ends_at.
-- ends_at is NULL for an open-tab walk-in until checkout (as booking_slots).
--
-- ── invoice_items.kind ────────────────────────────────────────────────────
-- text + CHECK, not a native enum — same drop/add constraint dance as 0038
-- and 0090. Adds 'addon'.
--
-- ── RLS ───────────────────────────────────────────────────────────────────
-- Both policy sets ship HERE, in the same migration as the tables — M24
-- shipped staff-only RLS and needed 0100 to patch public visibility.
-- ============================================================================

create table if not exists public.resource_type_addons (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants(id) on delete cascade,
  branch_id        uuid not null references public.branches(id) on delete cascade,
  resource_type_id uuid not null references public.resource_types(id) on delete cascade,
  name             text not null,
  rate_unit        text not null default 'hour' check (rate_unit in ('hour', 'day')),
  rate             numeric(10,2) not null check (rate >= 0),
  stock_quantity   integer not null check (stock_quantity >= 0),
  is_active        boolean not null default true,
  sort_order       integer not null default 0,
  created_at       timestamptz not null default now(),
  unique (resource_type_id, branch_id, name)
);
create index if not exists idx_resource_type_addons_tenant
  on public.resource_type_addons(tenant_id);
create index if not exists idx_resource_type_addons_type_branch
  on public.resource_type_addons(resource_type_id, branch_id);

create table if not exists public.booking_addons (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  branch_id       uuid not null references public.branches(id) on delete cascade,
  booking_id      uuid not null references public.bookings(id) on delete cascade,
  booking_slot_id uuid not null references public.booking_slots(id) on delete cascade,
  -- SET NULL, never CASCADE/RESTRICT: catalog deletion must not touch history.
  addon_id        uuid references public.resource_type_addons(id) on delete set null,
  addon_name      text not null,
  rate_unit       text not null check (rate_unit in ('hour', 'day')),
  rate_applied    numeric(10,2) not null check (rate_applied >= 0),
  quantity        integer not null check (quantity > 0),
  starts_at       timestamptz not null,
  ends_at         timestamptz,
  line_total      numeric(10,2) not null default 0 check (line_total >= 0),
  created_at      timestamptz not null default now(),
  created_by      uuid references public.memberships(id) on delete set null,
  check (ends_at is null or ends_at > starts_at)
);
create index if not exists idx_booking_addons_booking on public.booking_addons(booking_id);
create index if not exists idx_booking_addons_slot on public.booking_addons(booking_slot_id);
-- Stock overlap-sum lookup: per catalog row, by time window.
create index if not exists idx_booking_addons_addon_time
  on public.booking_addons(addon_id, starts_at) where addon_id is not null;

comment on table public.resource_type_addons is
  'M33 #1 — owner-defined priced add-on catalog per resource type. Stock is pooled per branch, so the row carries its own explicit branch_id (resource_types has no branch column). Flat rate only: hour or day.';
comment on column public.resource_type_addons.stock_quantity is
  'Units owned at this branch. Availability = stock_quantity minus the overlapping-window sum of booking_addons.quantity for non-cancelled bookings.';
comment on table public.booking_addons is
  'M33 #1 — an add-on attached to a booking slot: both the stock reservation and the billing line item. name/rate/unit are frozen snapshots; catalog edits never reprice a live booking.';
comment on column public.booking_addons.addon_id is
  'The catalog row this was attached from. ON DELETE SET NULL (mirrors booking_slots.setup_id): deleting a catalog entry must never delete booking history.';
comment on column public.booking_addons.ends_at is
  'Mirrors booking_slots.ends_at — kept in lockstep by the application at every site that writes the latter (extend, end-time correction, checkout). NULL for an open-tab walk-in until checkout.';
comment on column public.booking_addons.line_total is
  'Computed once, at the booking''s single pricing pass (creation for reserved/studio, checkout for walk-ins). Daily-rate add-ons bill ceil(elapsed hours / 24) day-blocks.';

-- invoice_items.kind gains 'addon' (see 0038 / 0090 for the pattern).
alter table public.invoice_items
  drop constraint if exists invoice_items_kind_check;
alter table public.invoice_items
  add constraint invoice_items_kind_check
  check (kind in ('booking','food','membership','adjustment','wallet_topup','service_charge','addon'));

-- ============================================================================
-- RLS + grants
-- ============================================================================
alter table public.resource_type_addons enable row level security;
alter table public.booking_addons       enable row level security;

-- Catalog: any member reads, owner/manager writes (mirrors resource_setups).
drop policy if exists resource_type_addons_select on public.resource_type_addons;
create policy resource_type_addons_select on public.resource_type_addons
  for select using (tenant_id in (select public.auth_tenant_ids()));

drop policy if exists resource_type_addons_write on public.resource_type_addons;
create policy resource_type_addons_write on public.resource_type_addons
  for all using (public.auth_is_manager(tenant_id))
          with check (public.auth_is_manager(tenant_id));

-- Public catalog read — shipped NOW, not as a follow-up (the 0100 lesson).
drop policy if exists resource_type_addons_public_select on public.resource_type_addons;
create policy resource_type_addons_public_select on public.resource_type_addons
  for select using (
    tenant_id = public.current_public_tenant_id() and is_active = true
  );

-- Booking line items: operational data — any active member reads AND writes
-- (front-desk staff create/edit bookings), same as booking_slots_rw.
drop policy if exists booking_addons_rw on public.booking_addons;
create policy booking_addons_rw on public.booking_addons
  for all using (tenant_id in (select public.auth_tenant_ids()))
          with check (tenant_id in (select public.auth_tenant_ids()));

grant select, insert, update, delete on public.resource_type_addons to arena_app;
grant select, insert, update, delete on public.booking_addons       to arena_app;
