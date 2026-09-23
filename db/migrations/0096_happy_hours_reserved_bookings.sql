-- ============================================================================
-- Arena OS — 0096: happy hours for reserved bookings — data model
--
-- M23 #1 — closes the gap found in PR #29 review: happy hours were honoured
-- for walk-in elapsed-time billing (lib/billing/elapsed-time.ts) and menu
-- orders (lib/orders/service.ts), but NOT for reserved/advance bookings
-- priced by priceBookingSlots (lib/booking/service.ts) — a slot booked
-- inside a happy-hour window billed full rate.
--
-- ── booking_slots.happy_hour_applied ─────────────────────────────────────
-- true when at least one segment of this slot's [starts_at, ends_at) window
-- actually billed at a happy-hour-discounted rate (priceBookingSlots splits
-- the slot at every rule boundary inside it and discounts each segment,
-- the same per-segment discipline priceElapsedTime already uses for
-- walk-ins). Snapshotted at booking time, same discipline as rate_applied/
-- slot_total/tax_rate_percent on this table (0092/0094/0095) — never
-- recomputed on read, so a later happy-hour rule change can't restate an
-- existing booking.
--
-- Read by loadBookingLines (lib/billing/invoice.ts): a flat
-- hours × rate_applied reconstruction cannot reproduce a per-segment blend,
-- so a flagged slot bills as its already-computed slot_total (qty=1)
-- instead — the same shape a walk-in's happy-hour blend already uses there.
-- An untouched slot (the default, false) keeps today's hours × rate_applied
-- decomposition, byte-identical to before this ticket.
-- ============================================================================

alter table public.booking_slots
  add column if not exists happy_hour_applied boolean not null default false;

comment on column public.booking_slots.happy_hour_applied is
  'True when at least one segment of this slot billed at a happy-hour-discounted rate (M23 #1). Snapshotted at booking time — never recomputed. See loadBookingLines (lib/billing/invoice.ts) for how this changes the bill-line reconstruction.';
