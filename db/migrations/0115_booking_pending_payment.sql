-- ============================================================================
-- Arena OS — 0115: pending-payment booking state (M36 #3)
--
-- A new booking_status value, 'pending_payment': an ONLINE booking whose venue
-- requires an advance / the full amount and has not been paid yet.
--
--   * It still HOLDS the slot. sync_booking_slot_active() (0003) keeps a slot
--     active unless the booking is cancelled / no_show, so the exclusion
--     constraint booking_slots_no_overlap blocks every other customer — the
--     hold is the database's, not the UI's.
--   * It is NOT confirmed / checked_in, so every query that lists those states
--     explicitly (billing, POS, check-in, revenue, walk-in attribution,
--     portal "upcoming") already ignores it — the smallest blast radius.
--   * payment_hold_expires_at is when the unpaid hold lapses (M36 #4 releases it).
--
-- RLS is unchanged on purpose: there is no public UPDATE policy on bookings, so
-- the public connection can create a pending booking but can never flip it to
-- confirmed — only the owner-scoped Razorpay webhook path does.
--
-- ADD VALUE cannot be used in the same transaction that adds it, so nothing
-- below references the new value (the expiry-sweep index lands with #4).
-- ============================================================================

alter type public.booking_status add value if not exists 'pending_payment';

alter table public.bookings
  add column if not exists payment_hold_expires_at timestamptz;

comment on column public.bookings.payment_hold_expires_at is
  'M36 #3 — when an unpaid pending_payment booking''s slot hold lapses. Null for every other booking.';
