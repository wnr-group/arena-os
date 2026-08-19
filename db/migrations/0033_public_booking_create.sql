-- ============================================================================
-- Arena OS — 0033 public booking creation: let a public (no-login) visitor on
-- app/(public)/book actually place a booking, pinned to app.public_tenant_id
-- exactly like the read-only policies in 0032_public_booking.sql.
-- ============================================================================

-- customers: resolveBookingCustomer() (lib/booking/customer.ts) looks up an
-- existing customer by phone via findOrCreateCustomer() before creating one,
-- so a scoped SELECT is required, not just INSERT. Same trust model as
-- booking_slots' pricing columns in 0032: RLS is the tenant boundary: the
-- lookup itself is always filtered to the one phone number just submitted,
-- by the shared application code that runs on both the staff and public
-- paths, not by RLS.
drop policy if exists customers_public_select on public.customers;
create policy customers_public_select on public.customers
  for select using (tenant_id = public.current_public_tenant_id());

drop policy if exists customers_public_insert on public.customers;
create policy customers_public_insert on public.customers
  for insert with check (tenant_id = public.current_public_tenant_id());

-- bookings: INSERT is restricted to source = 'online' at the database layer —
-- a public caller can never write a 'staff'/'walk_in' booking even if the
-- server action's own hardcoded source were ever changed by mistake. SELECT
-- is needed for the sequential BK-YYYYMMDD-NNN numbering in
-- createBookingCore (lib/booking/service.ts), which counts same-day rows; no
-- public code path selects customer_name/phone/email/notes off this table —
-- that counting query only ever does `select count(*)`.
drop policy if exists bookings_public_select on public.bookings;
create policy bookings_public_select on public.bookings
  for select using (tenant_id = public.current_public_tenant_id());

drop policy if exists bookings_public_insert on public.bookings;
create policy bookings_public_insert on public.bookings
  for insert with check (
    tenant_id = public.current_public_tenant_id() and source = 'online'
  );

-- booking_slots: the exclusion constraint (booking_slots_no_overlap) is what
-- actually stops a double-booking, regardless of role — this policy only
-- gates whether the INSERT is attempted at all.
drop policy if exists booking_slots_public_insert on public.booking_slots;
create policy booking_slots_public_insert on public.booking_slots
  for insert with check (tenant_id = public.current_public_tenant_id());
