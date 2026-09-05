-- ============================================================================
-- Arena OS — 0072: "bill requested" flag for table sessions
--
-- M17 #2 (live floor map) derives most of a table's status straight from
-- existing data (whether it has an open session, its open orders' KOT
-- progress, whether it already has a live invoice) — see
-- lib/booking/table-status.ts. But "the waiter/QR asked for the bill" is
-- customer/staff INTENT, not something any existing row encodes, so it needs
-- its own column. One additive, nullable timestamptz on `bookings`, set when
-- requested and never required by anything outside the floor map's own
-- status derivation — every other booking in every other industry leaves it
-- null forever.
-- ============================================================================

alter table public.bookings
  add column if not exists bill_requested_at timestamptz;

comment on column public.bookings.bill_requested_at is
  'When a table session''s bill was requested (M17). Null until requested; null for every non-restaurant booking.';
