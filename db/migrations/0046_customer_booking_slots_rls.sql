-- ============================================================================
-- Arena OS — 0046 customer access to booking_slots (AROS-89): the times and
-- resources behind a customer's own bookings.
--
-- 0045 gave a logged-in customer their own rows in customers, bookings,
-- wallet_transactions, loyalty_transactions and customer_memberships. A booking
-- on its own says almost nothing a customer cares about — WHEN it is and WHICH
-- table/room/bay it is for both live on booking_slots — so the portal's
-- bookings page needs this one more table.
--
-- No policy is needed on `resources` or `resource_types`: booking_slots
-- denormalises resource_name and resource_type_name at booking time (0003), so
-- the portal reads the name that was true when the booking was made and never
-- joins to the live catalogue. That is also the correct behaviour — renaming a
-- resource must not silently rewrite a customer's booking history.
-- ============================================================================

-- booking_slots carries no customer_id, so ownership is derived from its parent
-- booking. Two independent things make this safe:
--
--   1. the explicit `b.customer_id = current_customer_id()` test below, and
--   2. the sub-select on `bookings` is ITSELF subject to that table's RLS, so
--      under a customer context it can only ever see that customer's bookings.
--
-- Either alone would be sufficient; stating (1) explicitly means the policy is
-- correct on its own terms rather than by reference to a policy in another
-- migration.
drop policy if exists booking_slots_customer_select on public.booking_slots;
create policy booking_slots_customer_select on public.booking_slots
  for select using (
    exists (
      select 1 from public.bookings b
       where b.id = booking_slots.booking_id
         and b.customer_id = public.current_customer_id()
    )
  );

-- Deliberately NOT filtered on `active`. The public policy
-- (booking_slots_public_select, 0022) requires active = true because a stranger
-- checking availability must not see time that has been released. A customer
-- looking at their own history is the opposite case: cancelling a booking flips
-- its slots to active = false (trg_bookings_sync_slots, 0003), and a cancelled
-- booking that forgot when it was would be a worse record than no record.

-- The same restrictive pairing 0045 applies to every other portal table: under
-- a customer context, nothing any other permissive policy grants can widen the
-- result beyond that customer's own rows.
drop policy if exists booking_slots_customer_isolation on public.booking_slots;
create policy booking_slots_customer_isolation on public.booking_slots
  as restrictive for all
  using (
    public.current_customer_id() is null
    or exists (
      select 1 from public.bookings b
       where b.id = booking_slots.booking_id
         and b.customer_id = public.current_customer_id()
    )
  )
  with check (
    public.current_customer_id() is null
    or exists (
      select 1 from public.bookings b
       where b.id = booking_slots.booking_id
         and b.customer_id = public.current_customer_id()
    )
  );

-- Supports the EXISTS above, and the portal's "my bookings" listing, which
-- walks booking_slots by booking_id for a handful of bookings at a time.
-- idx_booking_slots_booking (0003) already covers booking_id; nothing further
-- is needed.

-- No new grants. arena_app has held select/insert/update/delete on
-- booking_slots since 0003, and every policy added here is `for select`, so a
-- customer context can read its own slots and write nothing.
