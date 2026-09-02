-- ============================================================================
-- Arena OS — 0056 public order creation: let a public (no-login) visitor on
-- app/(public)/order/[stationToken] actually place a food order, the same
-- way 0023_public_booking_create.sql opened up booking creation. Pinned to
-- app.public_tenant_id exactly like every other public policy.
-- ============================================================================

-- menu_items: widen 0025_public_menu.sql's policy so 'out_of_stock' items are
-- readable too (still never 'hidden') — the ordering UI shows them as "Sold
-- out" rather than having them silently vanish from a menu the customer is
-- already looking at. lib/menu/public.ts:getPublicMenu is the only reader and
-- already filters/labels accordingly.
drop policy if exists menu_items_public_select on public.menu_items;
create policy menu_items_public_select on public.menu_items
  for select using (
    tenant_id = public.current_public_tenant_id() and status in ('available', 'out_of_stock')
  );

-- tax_rates / happy_hours: createOrderCore (lib/orders/service.ts) joins/reads
-- both when snapshotting a line's price — no public policy existed for either
-- because there was no public order-creation path before this.
drop policy if exists tax_rates_public_select on public.tax_rates;
create policy tax_rates_public_select on public.tax_rates
  for select using (tenant_id = public.current_public_tenant_id());

drop policy if exists happy_hours_public_select on public.happy_hours;
create policy happy_hours_public_select on public.happy_hours
  for select using (tenant_id = public.current_public_tenant_id());

-- orders: INSERT restricted to channel = 'online' at the database layer, same
-- discipline as bookings_public_insert's source = 'online' check — a public
-- caller can never write a 'staff' order even if the server action's own
-- hardcoded channel were ever changed by mistake. SELECT is only ever used
-- for createOrderCore's sequential OR-YYYYMMDD-NNN counting query, same
-- justification as bookings_public_select — no order content is exposed by
-- a `count(*)`.
drop policy if exists orders_public_select on public.orders;
create policy orders_public_select on public.orders
  for select using (tenant_id = public.current_public_tenant_id());

drop policy if exists orders_public_insert on public.orders;
create policy orders_public_insert on public.orders
  for insert with check (
    tenant_id = public.current_public_tenant_id() and channel = 'online'
  );

-- order_items: no channel column of its own — scoped by tenant_id only, same
-- as booking_slots_public_insert.
drop policy if exists order_items_public_insert on public.order_items;
create policy order_items_public_insert on public.order_items
  for insert with check (tenant_id = public.current_public_tenant_id());

-- kots: createOrderCore always fires a kitchen ticket in the same transaction
-- as the order — SELECT for its sequential KOT-YYYYMMDD-NNN counting query,
-- INSERT for the ticket itself.
drop policy if exists kots_public_select on public.kots;
create policy kots_public_select on public.kots
  for select using (tenant_id = public.current_public_tenant_id());

drop policy if exists kots_public_insert on public.kots;
create policy kots_public_insert on public.kots
  for insert with check (tenant_id = public.current_public_tenant_id());
