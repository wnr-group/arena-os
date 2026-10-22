-- ============================================================================
-- Arena OS — 0154 Link menu items to stock (recipe / BOM) (M10 / AROS-98)
--
-- Additive only. `menu_item_ingredients` says "one portion of this menu item
-- uses N of that stock item". It is OPTIONAL per item: a menu item with no
-- rows is never deducted, and a tenant that never links anything is
-- completely unaffected.
--
-- The deduction itself is application code (lib/inventory/deduct.ts), run in
-- the same transaction that flips an order to 'billed'; it writes
-- stock_movements (source_type = 'order', source_id = the order) and is made
-- exactly-once by uq_stock_movements_order_once (0153).
-- ============================================================================

-- Lets the recipe table prove its menu item belongs to the same tenant.
create unique index if not exists menu_items_tenant_id_id_key on public.menu_items(tenant_id, id);

create table if not exists public.menu_item_ingredients (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  menu_item_id  uuid not null,
  stock_item_id uuid not null,
  -- Amount of the stock item's unit consumed per ONE sold portion.
  quantity      numeric(14,3) not null check (quantity > 0),
  created_at    timestamptz not null default now(),
  constraint menu_item_ingredients_item_stock_key unique (menu_item_id, stock_item_id),
  constraint menu_item_ingredients_menu_fkey
    foreign key (tenant_id, menu_item_id) references public.menu_items(tenant_id, id) on delete cascade,
  constraint menu_item_ingredients_stock_fkey
    foreign key (tenant_id, stock_item_id) references public.stock_items(tenant_id, id) on delete cascade
);
create index if not exists idx_menu_item_ingredients_stock on public.menu_item_ingredients(tenant_id, stock_item_id);

alter table public.menu_item_ingredients enable row level security;

drop policy if exists menu_item_ingredients_select on public.menu_item_ingredients;
create policy menu_item_ingredients_select on public.menu_item_ingredients
  for select using (tenant_id in (select public.auth_tenant_ids()));

drop policy if exists menu_item_ingredients_insert on public.menu_item_ingredients;
create policy menu_item_ingredients_insert on public.menu_item_ingredients
  for insert with check (public.auth_is_manager(tenant_id));

drop policy if exists menu_item_ingredients_update on public.menu_item_ingredients;
create policy menu_item_ingredients_update on public.menu_item_ingredients
  for update using (public.auth_is_manager(tenant_id))
          with check (public.auth_is_manager(tenant_id));

drop policy if exists menu_item_ingredients_delete on public.menu_item_ingredients;
create policy menu_item_ingredients_delete on public.menu_item_ingredients
  for delete using (public.auth_is_manager(tenant_id));

grant select, insert, update, delete on public.menu_item_ingredients to arena_app;
