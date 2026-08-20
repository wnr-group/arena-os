-- ============================================================================
-- Arena OS — 0012 orders: order + order_items, optionally attached to a booking
--
-- Operational tables (same split as bookings/booking_slots in 0003): any
-- active member may read AND write — front-desk/staff take orders. An order
-- may attach to a booking (booking_id) or stand alone (walk-in counter sale).
-- order_items snapshot the item name/price/tax at the time of sale so past
-- orders stay accurate even if the menu changes later.
-- ============================================================================

do $$ begin
  create type public.order_status as enum ('open','billed','cancelled');
exception when duplicate_object then null; end $$;

create table if not exists public.orders (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  branch_id    uuid not null references public.branches(id) on delete restrict,
  booking_id   uuid references public.bookings(id) on delete set null,
  order_number text not null,
  status       public.order_status not null default 'open',
  created_by   uuid references public.memberships(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (tenant_id, order_number)
);
create index if not exists idx_orders_branch on public.orders(tenant_id, branch_id);
create index if not exists idx_orders_booking on public.orders(booking_id);
drop trigger if exists trg_orders_updated on public.orders;
create trigger trg_orders_updated before update on public.orders
  for each row execute function public.set_updated_at();

create table if not exists public.order_items (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references public.tenants(id) on delete cascade,
  order_id              uuid not null references public.orders(id) on delete cascade,
  menu_item_id          uuid references public.menu_items(id) on delete set null,
  item_name             text not null,
  unit_price            numeric(10,2) not null,
  tax_rate              numeric(5,2) not null default 0,
  qty                   integer not null check (qty > 0),
  line_total            numeric(10,2) not null,
  special_instructions  text
);
create index if not exists idx_order_items_order on public.order_items(order_id);

-- ── RLS + grants ─────────────────────────────────────────────────────────────
alter table public.orders      enable row level security;
alter table public.order_items enable row level security;

drop policy if exists orders_rw on public.orders;
create policy orders_rw on public.orders
  for all using (tenant_id in (select public.auth_tenant_ids()))
          with check (tenant_id in (select public.auth_tenant_ids()));
drop policy if exists order_items_rw on public.order_items;
create policy order_items_rw on public.order_items
  for all using (tenant_id in (select public.auth_tenant_ids()))
          with check (tenant_id in (select public.auth_tenant_ids()));

grant select, insert, update, delete on public.orders      to arena_app;
grant select, insert, update, delete on public.order_items to arena_app;
