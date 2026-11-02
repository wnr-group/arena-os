-- ============================================================================
-- Arena OS — 0181 auto-close overrides
--
-- Two guards for the walk-in auto-close sweep (0167/0168):
--
-- * booking_settings.walkin_auto_close_enabled_at: stamped whenever the rules are
--   saved with a change. Only tabs that STARTED at or after it are auto-closed, so
--   turning a rule on (or tightening it) never cuts off a customer who is already
--   playing. NULL (settings saved before this column) = no restriction.
-- * bookings.auto_close_exempt: set when staff reopen a tab, so a customer who is
--   genuinely still playing is not re-closed at the old deadline on the next sweep.
-- ============================================================================

alter table public.booking_settings
  add column if not exists walkin_auto_close_enabled_at timestamptz;

alter table public.bookings
  add column if not exists auto_close_exempt boolean not null default false;
