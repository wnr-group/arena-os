-- ============================================================================
-- Arena OS — 0116: expiry-sweep index for pending-payment holds (M36 #4)
--
-- The release sweep (lib/booking/payment-hold.ts) finds unpaid holds whose
-- payment_hold_expires_at has passed. Partial, so it stays tiny: only the
-- handful of bookings currently awaiting payment are indexed. Separate from
-- 0115 because a new enum value cannot be referenced in the transaction that
-- adds it.
-- ============================================================================

create index if not exists idx_bookings_pending_payment_expiry
  on public.bookings (payment_hold_expires_at)
  where status = 'pending_payment';
