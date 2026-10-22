-- ============================================================================
-- Arena OS — 0155 Food cost: ingredient unit cost + modifier ingredients (M20 / AROS-180)
--
-- Additive only. Builds on the M10 inventory tables (0153/0154):
--
--   * stock_items.unit_cost — what one `unit` of the ingredient costs. Nullable:
--     NULL means "not costed yet", and a dish using such an ingredient is
--     reported as partially costed rather than as ₹0. It is the CURRENT cost —
--     food cost is always "what this dish costs to make at today's prices"
--     (movements carry quantities, not prices).
--
--   * modifier_option_ingredients — an optional recipe on a modifier option
--     ("Extra cheese" uses 0.03 kg of Cheese). Selected options are costed with
--     the dish and deducted from stock with it (lib/inventory/deduct.ts).
-- ============================================================================

alter table public.stock_items
  add column if not exists unit_cost numeric(14,4) check (unit_cost is null or unit_cost >= 0);
comment on column public.stock_items.unit_cost is
  'Current cost of one unit of this ingredient (M20 food cost). Null = not costed.';
grant update (unit_cost) on public.stock_items to arena_app;

-- Lets the table below prove its modifier option belongs to the same tenant.
create unique index if not exists modifier_options_tenant_id_id_key on public.modifier_options(tenant_id, id);

create table if not exists public.modifier_option_ingredients (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  option_id     uuid not null,
  stock_item_id uuid not null,
  -- Amount consumed per portion of the dish the option is chosen on.
  quantity      numeric(14,3) not null check (quantity > 0),
  created_at    timestamptz not null default now(),
  constraint modifier_option_ingredients_key unique (option_id, stock_item_id),
  constraint modifier_option_ingredients_option_fkey
    foreign key (tenant_id, option_id) references public.modifier_options(tenant_id, id) on delete cascade,
  constraint modifier_option_ingredients_stock_fkey
    foreign key (tenant_id, stock_item_id) references public.stock_items(tenant_id, id) on delete cascade
);
create index if not exists idx_modifier_option_ingredients_stock
  on public.modifier_option_ingredients(tenant_id, stock_item_id);

alter table public.modifier_option_ingredients enable row level security;

drop policy if exists modifier_option_ingredients_select on public.modifier_option_ingredients;
create policy modifier_option_ingredients_select on public.modifier_option_ingredients
  for select using (tenant_id in (select public.auth_tenant_ids()));

drop policy if exists modifier_option_ingredients_insert on public.modifier_option_ingredients;
create policy modifier_option_ingredients_insert on public.modifier_option_ingredients
  for insert with check (public.auth_is_manager(tenant_id));

drop policy if exists modifier_option_ingredients_update on public.modifier_option_ingredients;
create policy modifier_option_ingredients_update on public.modifier_option_ingredients
  for update using (public.auth_is_manager(tenant_id))
          with check (public.auth_is_manager(tenant_id));

drop policy if exists modifier_option_ingredients_delete on public.modifier_option_ingredients;
create policy modifier_option_ingredients_delete on public.modifier_option_ingredients
  for delete using (public.auth_is_manager(tenant_id));

grant select, insert, update, delete on public.modifier_option_ingredients to arena_app;
