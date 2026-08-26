-- ============================================================================
-- Arena OS — 0052 order payments (RLS): let the PUBLIC checkout flow create a
-- payment_intents row for the standalone order it just placed.
--
-- Split from 0051 solely because it references the 'order_payment' enum
-- label that migration adds — see 0051's header for why that cannot happen
-- in the same transaction.
--
-- Unlike a booking deposit (staff-initiated, from an authenticated session —
-- payment_intents_rw already covers it via auth_tenant_ids()), an order
-- payment is customer-initiated from the unauthenticated checkout page
-- (app/(public)/checkout), which runs under withPublicTenant() and has no
-- app.user_id to satisfy that policy. Same discipline as orders_public_insert
-- (0049): the public role gets exactly the hole it needs and no more.
--
-- No public UPDATE policy. An order's total is immutable after creation —
-- its order_items are a frozen snapshot — so unlike a booking deposit (whose
-- amount can drift if staff edit bookings.deposit while it's pending) there
-- is never a stale pending intent to cancel-and-replace. The checkout flow
-- only ever inserts a new intent or reuses an existing pending one; see
-- lib/payments/order-payment.ts.
-- ============================================================================

drop policy if exists payment_intents_public_select on public.payment_intents;
create policy payment_intents_public_select on public.payment_intents
  for select using (tenant_id = public.current_public_tenant_id());

-- The WITH CHECK is a DB-level guardrail, not just an app-layer one: a public
-- caller structurally cannot insert a booking-deposit-shaped row (or one
-- naming another tenant's order) even if a future bug in the server action
-- forgot to set these fields correctly.
drop policy if exists payment_intents_public_insert on public.payment_intents;
create policy payment_intents_public_insert on public.payment_intents
  for insert with check (
    tenant_id = public.current_public_tenant_id()
    and purpose = 'order_payment'
    and order_id is not null
    and booking_id is null
    and gateway = 'razorpay'
  );
