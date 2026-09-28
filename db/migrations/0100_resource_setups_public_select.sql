-- ============================================================================
-- Arena OS — 0100: public read access for resource_setups (M24 #5)
--
-- 0099_studio_setups.sql gave resource_setups a staff select policy
-- (resource_setups_select, via auth_tenant_ids()) but never a PUBLIC one —
-- unlike resources/resource_types/working_hours/booking_slots, which all got
-- a *_public_select policy in 0022_public_booking.sql for exactly this
-- reason. Without this, an unauthenticated withPublicTenant() session (the
-- public booking site) sees zero rows in resource_setups regardless of what
-- exists, so priceBookingSlots' own re-validation of a public setupId always
-- fails "This setup is no longer available for the selected resource." even
-- for a perfectly valid setup — the public booking pages/actions built for
-- M24 #5 depend on this policy to work at all.
--
-- Scoped to is_active = true, same as resource_types_public_select — a
-- stranger has no reason to see (or price against) a retired setup; the
-- staff-only resource_setups_select policy is unaffected and still exposes
-- both active and inactive rows to an authenticated manager/owner.
-- ============================================================================

drop policy if exists resource_setups_public_select on public.resource_setups;
create policy resource_setups_public_select on public.resource_setups
  for select using (
    tenant_id = public.current_public_tenant_id() and is_active = true
  );
