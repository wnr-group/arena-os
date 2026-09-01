-- ============================================================================
-- Arena OS — 0069: modifiers & modifier groups (M17 #8)
--
-- Structured per-item choices — size, add-ons ("extra cheese +₹30"), "no
-- onions", spice level — as opposed to order_items.special_instructions'
-- free text. A modifier_group (e.g. "Size") holds modifier_options (e.g.
-- "Small"/"Large", each with its own price_delta); menu_item_modifier_groups
-- is the many-to-many that attaches groups to the items offering them, so
-- one group (e.g. "Spice Level") can be reused across many dishes instead of
-- being redefined per item.
--
-- order_item_modifiers snapshots the CHOSEN modifiers onto an order line at
-- order time — same discipline as the happy-hour columns on order_items
-- (0021), except genuinely one-to-many (a burger can carry several chosen
-- modifiers), so it's a child table rather than more columns on order_items.
-- Editing or deleting a modifier_option later never changes a past bill.
--
-- Pricing: order_items.unit_price already has every selected delta folded
-- in at order time (see createOrderCore) — no change needed to
-- lib/billing/pricing.ts/priceBill/loadFoodLines, which just read unit_price
-- as they always have.
--
-- RLS follows two existing precedents depending on the table:
--   - modifier_groups/modifier_options/menu_item_modifier_groups are
--     CONFIG, like menu_categories/menu_items (0010_menu.sql): any tenant
--     member may read, only a manager/owner may write. Also readable by the
--     public connection (like 0025/0049's menu_items_public_select), since
--     the customer QR ordering flow needs to show/validate them too.
--   - order_item_modifiers is OPERATIONAL data, like order_items itself
--     (0012_orders.sql): any tenant member may read/write (waiters place
--     orders), plus public select+insert (0053/0049) for the same reason
--     order_items needs both under the anonymous public connection.
-- ============================================================================

create table if not exists public.modifier_groups (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  name         text not null,
  min_select   integer not null default 0 check (min_select >= 0),
  max_select   integer not null default 1 check (max_select >= 1),
  required     boolean not null default false,
  sort_order   integer not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (tenant_id, name),
  check (max_select >= min_select)
);
drop trigger if exists trg_modifier_groups_updated on public.modifier_groups;
create trigger trg_modifier_groups_updated before update on public.modifier_groups
  for each row execute function public.set_updated_at();

create table if not exists public.modifier_options (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  group_id     uuid not null references public.modifier_groups(id) on delete cascade,
  name         text not null,
  price_delta  numeric(10,2) not null default 0,
  sort_order   integer not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists idx_modifier_options_group on public.modifier_options(group_id);
drop trigger if exists trg_modifier_options_updated on public.modifier_options;
create trigger trg_modifier_options_updated before update on public.modifier_options
  for each row execute function public.set_updated_at();

create table if not exists public.menu_item_modifier_groups (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  menu_item_id  uuid not null references public.menu_items(id) on delete cascade,
  group_id      uuid not null references public.modifier_groups(id) on delete cascade,
  sort_order    integer not null default 0,
  unique (menu_item_id, group_id)
);
create index if not exists idx_menu_item_modifier_groups_item on public.menu_item_modifier_groups(menu_item_id);

create table if not exists public.order_item_modifiers (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants(id) on delete cascade,
  order_item_id       uuid not null references public.order_items(id) on delete cascade,
  modifier_option_id  uuid references public.modifier_options(id) on delete set null,
  group_name          text not null,
  option_name         text not null,
  price_delta         numeric(10,2) not null
);
create index if not exists idx_order_item_modifiers_order_item on public.order_item_modifiers(order_item_id);

-- ── RLS + grants ─────────────────────────────────────────────────────────────
alter table public.modifier_groups           enable row level security;
alter table public.modifier_options           enable row level security;
alter table public.menu_item_modifier_groups   enable row level security;
alter table public.order_item_modifiers        enable row level security;

create policy modifier_groups_select on public.modifier_groups
  for select using (tenant_id in (select public.auth_tenant_ids()));
create policy modifier_groups_write on public.modifier_groups
  for all using (public.auth_is_manager(tenant_id))
          with check (public.auth_is_manager(tenant_id));
create policy modifier_groups_public_select on public.modifier_groups
  for select using (tenant_id = public.current_public_tenant_id());

create policy modifier_options_select on public.modifier_options
  for select using (tenant_id in (select public.auth_tenant_ids()));
create policy modifier_options_write on public.modifier_options
  for all using (public.auth_is_manager(tenant_id))
          with check (public.auth_is_manager(tenant_id));
create policy modifier_options_public_select on public.modifier_options
  for select using (tenant_id = public.current_public_tenant_id());

create policy menu_item_modifier_groups_select on public.menu_item_modifier_groups
  for select using (tenant_id in (select public.auth_tenant_ids()));
create policy menu_item_modifier_groups_write on public.menu_item_modifier_groups
  for all using (public.auth_is_manager(tenant_id))
          with check (public.auth_is_manager(tenant_id));
create policy menu_item_modifier_groups_public_select on public.menu_item_modifier_groups
  for select using (tenant_id = public.current_public_tenant_id());

create policy order_item_modifiers_rw on public.order_item_modifiers
  for all using (tenant_id in (select public.auth_tenant_ids()))
          with check (tenant_id in (select public.auth_tenant_ids()));
create policy order_item_modifiers_public_select on public.order_item_modifiers
  for select using (tenant_id = public.current_public_tenant_id());
create policy order_item_modifiers_public_insert on public.order_item_modifiers
  for insert with check (tenant_id = public.current_public_tenant_id());

grant select, insert, update, delete on public.modifier_groups           to arena_app;
grant select, insert, update, delete on public.modifier_options           to arena_app;
grant select, insert, update, delete on public.menu_item_modifier_groups   to arena_app;
grant select, insert, update, delete on public.order_item_modifiers        to arena_app;
