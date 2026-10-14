-- M34 #2: the bookings page's date-range feed (listRangeBookings) selects slots
-- by tenant + time overlap:  starts_at < :end AND (ends_at IS NULL OR ends_at > :start).
-- The only starts_at index (idx_booking_slots_resource_time) leads with
-- resource_id and is partial (WHERE active), so it cannot serve a tenant-wide
-- time scan and omits cancelled/no-show slots, which the feed must show. The
-- result was a sequential scan over every tenant's slots.
--
-- Two btrees, because each bound is selective for different presets: a past
-- window (last year, yesterday) is selective on starts_at < end; a recent one
-- (this month, last 7 days) on ends_at > start. The planner can use either, or
-- combine them.
create index if not exists idx_booking_slots_tenant_starts
  on public.booking_slots(tenant_id, starts_at);
create index if not exists idx_booking_slots_tenant_ends
  on public.booking_slots(tenant_id, ends_at);
