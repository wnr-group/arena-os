-- ============================================================================
-- Arena OS — 0097: booking cancellation reason
--
-- Staff cancelling a booking (setBookingStatus in lib/actions/bookings.ts) had
-- no way to record WHY — the only trace left behind was cancelled_at. This adds
-- a free-text reason, captured at cancel time and shown on the booking detail
-- drawer / Bookings table thereafter.
-- ============================================================================

alter table public.bookings
  add column if not exists cancellation_reason text;

comment on column public.bookings.cancellation_reason is
  'Why the booking was cancelled — captured by the staff Cancel dialog (lib/actions/bookings.ts setBookingStatus). Null until a cancellation happens; never cleared afterward.';
