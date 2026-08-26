-- ============================================================================
-- Arena OS — 0053: order_items needs a PUBLIC SELECT policy, not just INSERT.
--
-- 0049_public_order_create.sql gave the public role INSERT on order_items
-- (for placing an order) but never SELECT — placeOnlineOrder never needed to
-- read items back, only write them. M14 #6 (v2)'s pay-now flow is the first
-- public-context path that DOES need to read them back:
-- lib/billing/invoice.ts's loadOrderFoodLines, called from
-- lib/payments/order-payment.ts to price the Razorpay order, runs under
-- withPublicTenant() and — without this policy — silently sees ZERO rows
-- rather than an error, which surfaced in production as "This order has
-- nothing to pay for" for a real, non-empty order.
--
-- Scoped identically to orders_public_select (0049): tenant-only, no
-- per-order ownership check, because there is no session/token proving
-- "this is MY order" for an anonymous checkout. This adds no new category of
-- exposure beyond what orders_public_select already grants — a public
-- caller could already read every order ROW (order_number, created_at,
-- customer_id, ...) for this tenant; this lets the same caller also read
-- those orders' LINE ITEMS. The only code path that reads order_items under
-- this policy always additionally filters by a specific (non-guessable
-- UUID) order_id the caller must already know.
-- ============================================================================

drop policy if exists order_items_public_select on public.order_items;
create policy order_items_public_select on public.order_items
  for select using (tenant_id = public.current_public_tenant_id());
