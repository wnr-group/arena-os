-- ============================================================================
-- Arena OS — 0071: open-ended table sessions
--
-- M17 #1 — the foundation the rest of the dine-in epic builds on. A
-- restaurant table isn't rented by the hour like a PS5 station: a party sits
-- down, orders whenever, and the bill is food (+ service charge) only, with
-- no time line. Two ADDITIVE, nullable columns on `bookings` model that,
-- reusing the exact same table (and therefore the exact same orders / KOT /
-- combined-billing pipeline) every other industry's timed booking already
-- goes through — no parallel restaurant schema, no parallel engine.
--
-- ── Why no booking_slots row for a table session ────────────────────────────
-- booking_slots exists to price and structurally prevent overlap for a TIMED
-- reservation (GiST exclusion on resource_id × tstzrange, see 0003). A table
-- session has no meaningful time window to exclude on — a party sits until
-- they leave, not until a clock says so. Giving it a placeholder/open-ended
-- range would need a second mechanism to shrink that range back on checkout
-- just to free the table again. Simpler and just as safe: a table session
-- skips booking_slots entirely (bookings.resource_id below stands in for the
-- resource↔booking link instead), and loadBookingLines() — which reads only
-- from booking_slots — therefore already contributes zero time lines for it,
-- with no change needed to lib/billing/invoice.ts. The billing/POS read path
-- (lib/billing/data.ts's getBillableForBooking) already tolerates a booking
-- with no slots today: startsAt/endsAt there are aggregated with min()/max()
-- over booking_slots and are already nullable, precisely for a booking that
-- has none.
--
-- ── Why a partial unique index instead of an exclusion constraint ──────────
-- Occupancy of a table isn't a time range, it's a boolean: either some booking
-- currently "has" the table (status confirmed/checked_in) or it doesn't. A
-- partial unique index on (resource_id) filtered to those two statuses makes
-- double-seating the same table structurally impossible — the same
-- "constraint, not application check" discipline 0003 uses for timed
-- overlap — without needing a range type for something that isn't a range.
-- Completing, cancelling or no-show-ing the booking drops it out of the
-- index's filter and immediately frees the table for the next party.
-- ============================================================================

alter table public.bookings
  add column if not exists cover_count integer check (cover_count is null or cover_count > 0),
  add column if not exists resource_id uuid references public.resources(id) on delete restrict;

comment on column public.bookings.cover_count is
  'Guest count for a table session (M17). Null for every non-restaurant booking.';
comment on column public.bookings.resource_id is
  'Direct resource link for an open-ended table session (M17), standing in for booking_slots
   since a table session has no time window to price or exclude on. Null for every timed
   booking, which continues to link to its resource(s) via booking_slots as before.';

create index if not exists idx_bookings_resource
  on public.bookings(tenant_id, resource_id)
  where resource_id is not null;

-- THE core invariant for table sessions: at most one open (confirmed /
-- checked_in) booking per table, at the database level.
create unique index if not exists idx_bookings_open_table_session
  on public.bookings(resource_id)
  where resource_id is not null and status in ('confirmed', 'checked_in');
