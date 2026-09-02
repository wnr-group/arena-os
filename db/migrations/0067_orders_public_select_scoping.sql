-- ============================================================================
-- Arena OS — 0067: scope orders/order_items/kots public SELECT to a specific
-- order, customer, or idempotency key — not just the tenant
--
-- orders_public_select (0056), order_items_public_select (0060) and
-- kots_public_select (0056) all scoped a public (no-login) read to the right
-- TENANT only, explicitly documented in both migrations as an accepted
-- trade-off: there was no session/token proving "this is MY order" beyond
-- knowing its (non-guessable) id or phone number, so app code alone enforced
-- the narrower "only the order/customer you already know about" rule.
-- Flagged in the pre-merge review as a defense-in-depth gap — every public
-- read of these tables already happens to filter by a specific order id,
-- customer id, or idempotency key, so that same value can now be pinned as a
-- transaction-local session variable and checked by the policy itself,
-- closing the gap without needing a real customer-auth system (M9).
--
-- Three narrow, single-purpose GUCs (set once per transaction, right where
-- each caller already resolves the value — see lib/orders/service.ts,
-- lib/orders/public-status.ts, lib/payments/order-payment.ts,
-- lib/billing/invoice.ts, lib/actions/public-orders.ts):
--   app.public_order_id               — "I already know this ONE order's id."
--   app.public_customer_id            — "I already resolved a customer from
--                                        their phone; show only THEIR orders."
--   app.public_order_idempotency_key  — "I'm retrying a checkout attempt
--                                        with this key; is there already an
--                                        order for it?"
--
-- None of this touches the STAFF policies (orders_rw, order_items_rw,
-- kots_select/insert/update, migrations 0012/0013) — those key off
-- auth_tenant_ids(), a completely separate GUC (app.user_id) a public
-- session never sets, and stay exactly as permissive as before. Multiple
-- permissive policies for the same command combine with OR, so a staff
-- session keeps full tenant-wide read access regardless of what these three
-- new conditions evaluate to for it (NULL, since none of these GUCs are ever
-- set outside a public transaction).
-- ============================================================================

create or replace function public.current_public_order_id()
returns uuid
language sql stable
as $$
  select nullif(current_setting('app.public_order_id', true), '')::uuid;
$$;
grant execute on function public.current_public_order_id() to arena_app;

create or replace function public.current_public_customer_id()
returns uuid
language sql stable
as $$
  select nullif(current_setting('app.public_customer_id', true), '')::uuid;
$$;
grant execute on function public.current_public_customer_id() to arena_app;

create or replace function public.current_public_order_idempotency_key()
returns uuid
language sql stable
as $$
  select nullif(current_setting('app.public_order_idempotency_key', true), '')::uuid;
$$;
grant execute on function public.current_public_order_idempotency_key() to arena_app;

drop policy if exists orders_public_select on public.orders;
create policy orders_public_select on public.orders
  for select using (
    tenant_id = public.current_public_tenant_id()
    and (
      id = public.current_public_order_id()
      or customer_id = public.current_public_customer_id()
      or idempotency_key = public.current_public_order_idempotency_key()
    )
  );

-- order_items has no customer_id/idempotency_key of its own — every public
-- reader of it (getPublicOrderStatus, loadOrderFoodLines) already knows a
-- specific order id going in, so this only ever needs that one predicate.
drop policy if exists order_items_public_select on public.order_items;
create policy order_items_public_select on public.order_items
  for select using (
    tenant_id = public.current_public_tenant_id()
    and order_id = public.current_public_order_id()
  );

-- kots needs the customer-scoped branch too: getRecentPublicOrdersByPhone
-- (the "My Booking" hub) reads kots for a SET of order ids belonging to one
-- customer, not a single known order id. The subquery runs under the SAME
-- session GUCs as orders_public_select itself, so a kot is visible here
-- exactly when its parent order would be visible there — the two policies
-- can't drift apart into showing a kot for an order the caller couldn't
-- otherwise read.
drop policy if exists kots_public_select on public.kots;
create policy kots_public_select on public.kots
  for select using (
    tenant_id = public.current_public_tenant_id()
    and (
      order_id = public.current_public_order_id()
      or order_id in (
        select o.id from public.orders o
        where o.tenant_id = public.current_public_tenant_id()
          and o.customer_id = public.current_public_customer_id()
      )
      or order_id in (
        select o.id from public.orders o
        where o.tenant_id = public.current_public_tenant_id()
          and o.idempotency_key = public.current_public_order_idempotency_key()
      )
    )
  );
