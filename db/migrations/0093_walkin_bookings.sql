-- ============================================================================
-- Arena OS — 0093: walk-in bookings — data model
--
-- M21 #1 — the foundation the rest of the walk-in epic builds on. A walk-in
-- is NOT a parallel booking type: it's a normal `bookings` row + one
-- `booking_slots` row (same as every reserved booking), distinguished by a
-- few additive, nullable fields. That keeps walk-ins on the one
-- booking/orders/invoice/POS engine every other flow already goes through —
-- no parallel schema, no parallel pricing/checkout path.
--
-- ── channel ───────────────────────────────────────────────────────────────
-- 'reserved' | 'walkin'. Defaults every existing and future non-walk-in
-- booking to 'reserved' — a pure label, doesn't touch source (staff/online/
-- walk_in) which already tracks who took the booking, not how it's billed.
--
-- ── billing_mode / committed_end_at / warning_minutes ────────────────────
-- Only meaningful for channel='walkin' (null for every reserved booking):
--   billing_mode      'open_tab' (billed by elapsed time at checkout) or
--                      'timed' (a committed end time, extendable).
--   committed_end_at   the timed session's current committed end. Extending
--                      a session moves this forward; checkout is blocked
--                      past it until extended (enforced in app code, not
--                      here — see the timed-session story).
--   warning_minutes    minutes before committed_end_at the "heads-up" alarm
--                      fires. Defaults to 5 per the design doc; stored per
--                      booking (not hardcoded) so a future story can make it
--                      operator-adjustable without another migration.
--
-- ── booking_slots.ends_at nullable ───────────────────────────────────────
-- An open tab has no known end time until checkout finalizes it — same
-- "unknown until it isn't" shape ends_at already has no equivalent for
-- elsewhere. Relaxes the NOT NULL and the ends_at > starts_at check to admit
-- null; the GiST exclusion constraint (0003) already handles a null upper
-- bound correctly (tstzrange(starts_at, null) is a valid upper-unbounded
-- range), so an open tab continues to structurally occupy its resource until
-- checkout sets a real ends_at.
-- ============================================================================

alter table public.bookings
  add column if not exists channel text not null default 'reserved',
  add column if not exists billing_mode text,
  add column if not exists committed_end_at timestamptz,
  add column if not exists warning_minutes smallint not null default 5
    check (warning_minutes > 0);

alter table public.bookings
  drop constraint if exists bookings_channel_check;
alter table public.bookings
  add constraint bookings_channel_check
  check (channel in ('reserved', 'walkin'));

alter table public.bookings
  drop constraint if exists bookings_billing_mode_check;
alter table public.bookings
  add constraint bookings_billing_mode_check
  check (billing_mode is null or billing_mode in ('open_tab', 'timed'));

comment on column public.bookings.channel is
  'How this booking was taken (M21): reserved (default, every pre-existing and future non-walk-in booking) or walkin (a walk-in customer started on the spot). Gated at the action layer per industry, not just the UI.';
comment on column public.bookings.billing_mode is
  'Walk-in billing shape (M21): open_tab (billed by elapsed time at checkout) or timed (committed end time, extendable). Null for every reserved booking.';
comment on column public.bookings.committed_end_at is
  'Timed walk-in''s current committed end (M21). Extending the session moves this forward. Null for open-tab and every reserved booking.';
comment on column public.bookings.warning_minutes is
  'Minutes before committed_end_at the heads-up alarm fires for a timed walk-in (M21). Default 5, per booking so a later story can make it operator-adjustable.';

alter table public.booking_slots
  alter column ends_at drop not null;

alter table public.booking_slots
  drop constraint if exists booking_slots_check;
alter table public.booking_slots
  add constraint booking_slots_check
  check (ends_at is null or ends_at > starts_at);

comment on column public.booking_slots.ends_at is
  'Slot end time. Null for an open-tab walk-in (M21) until checkout finalizes it; always set for every reserved/timed booking.';

-- Sessions-board / timer access pattern (M21): find the timed walk-ins whose
-- committed end is approaching, without scanning every booking.
create index if not exists idx_bookings_committed_end
  on public.bookings(tenant_id, committed_end_at)
  where committed_end_at is not null;
