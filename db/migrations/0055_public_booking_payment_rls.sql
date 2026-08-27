-- ============================================================================
-- Arena OS — 0055 public booking payment (RLS): let the PUBLIC booking flow
-- create a payment_intents row for the "pay online now" booking it just
-- placed (lib/payments/booking-payment.ts).
--
-- 0052_order_payments_rls.sql already opened payment_intents_public_insert
-- for purpose='order_payment' rows, but its WITH CHECK requires
-- `order_id is not null and booking_id is null` — the exact opposite shape
-- a booking deposit needs (`booking_id is not null and order_id is null`).
-- A public "pay online now" booking therefore hit a real RLS insert
-- violation: the gateway order was created at Razorpay, but the local intent
-- could never be persisted (surfaced to the customer as "online payment
-- could not be started").
--
-- payment_intents_public_select (0052) already covers reading this row back
-- — its USING clause only scopes by tenant, not purpose — so only INSERT
-- needs a new, ADDITIONAL permissive policy here; Postgres ORs multiple
-- permissive policies together for the same command, so
-- payment_intents_public_insert (order_payment) is untouched.
--
-- Same discipline as that policy: a structural DB-level guardrail, not a
-- substitute for the application-layer eligibility check (loadPayableBooking
-- in lib/payments/booking-payment.ts refuses a non-'online'-source or
-- non-billable-status booking before ever reaching this INSERT).
-- ============================================================================

drop policy if exists payment_intents_public_insert_booking on public.payment_intents;
create policy payment_intents_public_insert_booking on public.payment_intents
  for insert with check (
    tenant_id = public.current_public_tenant_id()
    and purpose = 'booking_deposit'
    and booking_id is not null
    and order_id is null
    and gateway = 'razorpay'
  );
