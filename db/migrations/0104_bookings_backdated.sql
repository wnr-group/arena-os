-- ============================================================================
-- Arena OS — 0104: bookings.backdated (M28 #1)
--
-- Explicit, queryable flag for a booking entered AFTER the session already
-- happened (owner/manager backfill of a missed sale). Deliberately a column,
-- not inferred from created_at > ends_at: that comparison would silently
-- break if any future ticket relaxed the booking-creation windows. Same
-- discipline as happy_hour_applied / setup_id / holiday_rate_applied, and the
-- same spirit as attendance.is_manual.
--
-- No RLS/grant changes: bookings already has its tenant-scoped policies.
-- Existing rows read false. Nothing reads this column until M28 #2/#4.
-- ============================================================================

alter table public.bookings
  add column if not exists backdated boolean not null default false;

comment on column public.bookings.backdated is
  'True when the booking was entered after the fact (M28 backdated entry) rather than at the time of the session. Set only by the backdated-entry action.';
