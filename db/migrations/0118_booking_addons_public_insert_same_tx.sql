-- ============================================================================
-- Arena OS — 0118: tie the public booking_addons INSERT to the booking created
-- in the SAME transaction (tightens 0111).
--
-- 0111 allowed the public role to insert booking_addons onto ANY 'online'
-- booking of the public tenant. Anyone holding another customer's booking id
-- could have attached add-ons to it, inflating the booking and consuming stock.
--
-- The only legitimate writer is createBookingCore -> attachAddonsToSlots, which
-- inserts the booking and its add-on rows in one transaction. A row version
-- written by the current transaction carries xmin = the current transaction id,
-- so requiring that makes the policy mean what 0111's comment claimed: the
-- parent booking must have been created in this very transaction. Rows of
-- earlier bookings cannot be touched by the public role.
-- (xmin is 32-bit; txid_current() is the 64-bit epoch-extended id, hence the
-- modulus.)
-- ============================================================================

drop policy if exists booking_addons_public_insert on public.booking_addons;
create policy booking_addons_public_insert on public.booking_addons
  for insert with check (
    tenant_id = public.current_public_tenant_id()
    and exists (
      select 1 from public.bookings b
       where b.id = booking_id
         and b.tenant_id = booking_addons.tenant_id
         and b.source = 'online'
         and b.xmin::text = (txid_current() % 4294967296)::text
    )
  );
