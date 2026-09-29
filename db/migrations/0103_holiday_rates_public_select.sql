-- ============================================================================
-- Arena OS — 0103: public read access for holiday_rates (M27 #2)
--
-- 0102_holiday_pricing.sql gave holiday_rates a staff select policy
-- (holiday_rates_select, via auth_tenant_ids()) but never a PUBLIC one —
-- same gap 0100_resource_setups_public_select.sql closed for resource_setups,
-- for the identical reason: priceBookingSlots (lib/booking/service.ts) runs
-- under withPublicTenant() for the ENTIRE public booking flow (quote,
-- confirm, and the actual createBookingCore write —
-- lib/actions/public-booking.ts), not just the staff one. Without this, an
-- unauthenticated withPublicTenant() session sees zero rows in
-- holiday_rates regardless of what exists, so a public booking on a
-- configured holiday date silently falls back to weekday/weekend pricing —
-- exactly the "quote/charge disagreement" the epic's own done-when bullet
-- says must never happen, and the two public-availability quote functions
-- (getPublicAvailableStarts/getPublicAvailableStartsForType,
-- lib/booking/public-availability.ts) would show it too.
--
-- Unlike resource_setups_public_select, no is_active scoping: holiday_rates
-- has no such column — every row is inherently in force for its date, and
-- retiring one is deleting it.
-- ============================================================================

drop policy if exists holiday_rates_public_select on public.holiday_rates;
create policy holiday_rates_public_select on public.holiday_rates
  for select using (tenant_id = public.current_public_tenant_id());
