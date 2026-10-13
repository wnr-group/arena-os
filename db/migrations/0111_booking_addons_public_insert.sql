-- M35 #4/#5: let the public booking path attach add-ons to its own booking.
--
-- createBookingCore -> attachAddonsToSlots INSERTs booking_addons rows inside
-- the booking transaction, which for an online booking runs as the public
-- role. booking_addons has only the staff policy (0108), so that insert would
-- be refused. INSERT-only, and only onto an 'online' booking of the public
-- tenant created in this very transaction's tenant scope — the public role
-- still cannot read, update or delete booking_addons (the stock count it needs
-- goes through public_addon_reserved_units, 0110).
drop policy if exists booking_addons_public_insert on public.booking_addons;
create policy booking_addons_public_insert on public.booking_addons
  for insert with check (
    tenant_id = public.current_public_tenant_id()
    and exists (
      select 1 from public.bookings b
       where b.id = booking_id
         and b.tenant_id = booking_addons.tenant_id
         and b.source = 'online'
    )
  );
