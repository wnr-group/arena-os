-- ============================================================================
-- Arena OS — 0174 stock restore + sale-time recipe/cost snapshots
--
-- 1. order_item_stock_usage — per order line, the quantity of each stock item
--    ONE portion consumed (dish recipe + chosen modifier options), frozen the
--    first time the line is deducted. Later recipe edits no longer reach lines
--    that were already sold, and a line that is voided / cut / removed can be
--    restored at exactly the rate it was deducted. Rows go with their line
--    (ON DELETE CASCADE), which is how a removed line restores its stock.
--
-- 2. stock_movements.unit_cost — the stock item's unit cost at the moment of an
--    'order' movement. Food-cost % prices usage at this, so changing a cost
--    today no longer rewrites past months. (The ledger is immutable, so
--    movements written before this migration stay NULL and the report falls
--    back to the item's current cost for them.)
--
-- 3. Tenant-leading indexes so the "does this tenant have any recipe?" probe
--    that lets recipe-less tenants skip the deduct work is an index lookup.
-- ============================================================================

alter table public.stock_movements
  add column if not exists unit_cost numeric(14,4) check (unit_cost is null or unit_cost >= 0);

create table if not exists public.order_item_stock_usage (
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  order_item_id uuid not null references public.order_items(id) on delete cascade,
  stock_item_id uuid not null,
  -- Per ONE portion of the line.
  per_portion   numeric(14,3) not null check (per_portion > 0),
  created_at    timestamptz not null default now(),
  primary key (order_item_id, stock_item_id),
  constraint order_item_stock_usage_stock_fkey
    foreign key (tenant_id, stock_item_id) references public.stock_items(tenant_id, id) on delete cascade
);
create index if not exists idx_order_item_stock_usage_tenant on public.order_item_stock_usage(tenant_id);
create index if not exists idx_modifier_option_ingredients_tenant on public.modifier_option_ingredients(tenant_id);

alter table public.order_item_stock_usage enable row level security;

drop policy if exists order_item_stock_usage_select on public.order_item_stock_usage;
create policy order_item_stock_usage_select on public.order_item_stock_usage
  for select using (tenant_id in (select public.auth_tenant_ids()));

-- Written by billing / order corrections, which run as any active member (the
-- same rule as an 'order' stock movement).
drop policy if exists order_item_stock_usage_insert on public.order_item_stock_usage;
create policy order_item_stock_usage_insert on public.order_item_stock_usage
  for insert with check (tenant_id in (select public.auth_tenant_ids()));

grant select, insert on public.order_item_stock_usage to arena_app;

-- Orders already deducted before this migration: freeze today's recipe for
-- their lines so a later correction restores at a sensible rate.
insert into public.order_item_stock_usage (tenant_id, order_item_id, stock_item_id, per_portion)
select x.tenant_id, x.order_item_id, x.stock_item_id, sum(x.per)
  from (
    select oi.tenant_id, oi.id as order_item_id, mii.stock_item_id, mii.quantity as per
      from public.order_items oi
      join public.menu_item_ingredients mii
        on mii.menu_item_id = oi.menu_item_id and mii.tenant_id = oi.tenant_id
     where oi.order_id in (select distinct source_id from public.stock_movements where source_type = 'order')
    union all
    select oi.tenant_id, oi.id, moi.stock_item_id, moi.quantity
      from public.order_items oi
      join public.order_item_modifiers oim
        on oim.order_item_id = oi.id and oim.tenant_id = oi.tenant_id
      join public.modifier_option_ingredients moi
        on moi.option_id = oim.modifier_option_id and moi.tenant_id = oi.tenant_id
     where oi.order_id in (select distinct source_id from public.stock_movements where source_type = 'order')
  ) x
 group by x.tenant_id, x.order_item_id, x.stock_item_id
on conflict (order_item_id, stock_item_id) do nothing;
