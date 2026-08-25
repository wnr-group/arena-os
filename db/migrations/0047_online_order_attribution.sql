-- ============================================================================
-- Arena OS — 0047 online order attribution: an order needs to know where it
-- came from — a channel (staff POS vs. future online ordering), an optional
-- customer, and an optional station/table (resource) — so the kitchen ticket
-- and eventual bill land in the right place.
--
-- No RLS change: orders_rw (0012_orders.sql) is row-scoped by tenant_id and
-- already covers any new column on the table. Public INSERT isn't opened up
-- here — there is no public order-creation path yet (that's a later story).
-- ============================================================================

create type order_channel as enum ('staff', 'online');

alter table public.orders
  add column if not exists channel order_channel not null default 'staff';
alter table public.orders
  add column if not exists customer_id uuid references public.customers(id) on delete set null;
alter table public.orders
  add column if not exists resource_id uuid references public.resources(id) on delete set null;

create index if not exists idx_orders_customer on public.orders(tenant_id, customer_id);
create index if not exists idx_orders_resource on public.orders(resource_id);
