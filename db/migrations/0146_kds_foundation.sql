-- ============================================================================
-- Arena OS — 0146 Kitchen Display System foundation (M19 / AROS-172)
--
-- Additive only. Numbered after PR #18's reserved block (0124–0145); renumber
-- to the next free number at merge time if that block has since landed.
--
-- 1. order_settings gains the per-tenant KDS opt-in (`kds_enabled`, default
--    false) and the timer colour thresholds. A tenant that never opts in keeps
--    exactly today's behaviour: one KOT per order, order-level status.
--
-- 2. kot_items — item-level kitchen state. SPARSE on purpose: a row means "this
--    order line was bumped (cooked)"; no row means still outstanding. Nothing
--    is written when an order is placed, so KOT creation (a hot path) is
--    untouched and a tenant without the KDS pays nothing. order_items stays the
--    source of truth for *what* was ordered; voids/removals therefore drop
--    straight off the KDS (void_status filter / ON DELETE CASCADE).
--
-- 3. module.kitchen_display entitlement, true on Pro/Enterprise.
-- ============================================================================

-- ── 1. settings ─────────────────────────────────────────────────────────────
alter table public.order_settings
  add column if not exists kds_enabled boolean not null default false,
  add column if not exists kds_warn_minutes integer not null default 8
    check (kds_warn_minutes between 1 and 240),
  add column if not exists kds_late_minutes integer not null default 15
    check (kds_late_minutes between 1 and 480);

do $$ begin
  alter table public.order_settings
    add constraint order_settings_kds_thresholds_check
    check (kds_warn_minutes < kds_late_minutes);
exception when duplicate_object then null; end $$;

-- ── 2. kot_items ────────────────────────────────────────────────────────────
create table if not exists public.kot_items (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  kot_id        uuid not null references public.kots(id) on delete cascade,
  order_item_id uuid not null references public.order_items(id) on delete cascade,
  bumped_at     timestamptz not null default now(),
  -- null for the 0146 backfill (nobody bumped those) and for a ticket-level bump
  -- made by a role with no membership row.
  bumped_by     uuid references public.memberships(id) on delete set null,
  constraint kot_items_order_item_key unique (order_item_id)
);
create index if not exists idx_kot_items_kot on public.kot_items(tenant_id, kot_id);

alter table public.kot_items enable row level security;

drop policy if exists kot_items_select on public.kot_items;
create policy kot_items_select on public.kot_items
  for select using (tenant_id in (select public.auth_tenant_ids()));

-- Bump / recall is a kitchen action — same roles as kots_update (0013).
-- Each command is its own policy; an UPDATE or `SELECT … FOR UPDATE` against a
-- table with no UPDATE policy silently matches zero rows (AROS-183), so UPDATE
-- is spelled out even though the app only inserts and deletes.
drop policy if exists kot_items_insert on public.kot_items;
create policy kot_items_insert on public.kot_items
  for insert with check (public.auth_role_in(tenant_id) in ('owner','manager','kitchen_staff'));

drop policy if exists kot_items_update on public.kot_items;
create policy kot_items_update on public.kot_items
  for update using (public.auth_role_in(tenant_id) in ('owner','manager','kitchen_staff'))
             with check (public.auth_role_in(tenant_id) in ('owner','manager','kitchen_staff'));

drop policy if exists kot_items_delete on public.kot_items;
create policy kot_items_delete on public.kot_items
  for delete using (public.auth_role_in(tenant_id) in ('owner','manager','kitchen_staff'));

grant select, insert, update, delete on public.kot_items to arena_app;

-- ── backfill ────────────────────────────────────────────────────────────────
-- A KOT already `ready`/`served` was finished under the old flow: every line on
-- it counts as bumped, so a tenant that turns the KDS on later never sees
-- phantom outstanding items on tickets the kitchen already completed.
insert into public.kot_items (tenant_id, kot_id, order_item_id, bumped_at)
select k.tenant_id, k.id, oi.id, k.updated_at
  from public.kots k
  join public.order_items oi on oi.order_id = k.order_id
 where k.status in ('ready', 'served')
on conflict (order_item_id) do nothing;

-- Parity check (same shape as 0107): every line on a finished KOT must now have
-- a bump row. Fails the migration — rolling the whole file back — if not.
do $$
declare
  expected bigint;
  actual   bigint;
begin
  select count(*) into expected
    from public.kots k
    join public.order_items oi on oi.order_id = k.order_id
   where k.status in ('ready', 'served');

  select count(*) into actual
    from public.kot_items ki
    join public.kots k on k.id = ki.kot_id
   where k.status in ('ready', 'served');

  if actual < expected then
    raise exception '0146 backfill parity: % finished-KOT lines but only % kot_items rows', expected, actual;
  end if;
end $$;

-- ── 3. entitlement ──────────────────────────────────────────────────────────
-- Pro/Enterprise on, Starter off; Grandfathered (0086) is off — it records what
-- pre-M16 tenants already had, and none had a KDS. A plan with no row is denied
-- (fail-closed), so any other plan an operator created simply needs the key
-- added from the admin UI.
insert into public.plan_entitlements (plan_id, key, value)
select p.id,
       'module.kitchen_display',
       case when lower(btrim(p.name)) in ('pro', 'enterprise') then 'true'::jsonb else 'false'::jsonb end
  from public.plans p
 where lower(btrim(p.name)) in ('starter', 'pro', 'enterprise', 'grandfathered')
on conflict (plan_id, key) do nothing;
