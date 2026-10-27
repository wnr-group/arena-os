-- ============================================================================
-- Arena OS — 0162 venue-wide booking time step
--
-- The grid of start times (and the duration increments) offered when booking a
-- resource. It was a hardcoded 30 minutes; a venue can now pick a finer step so
-- a customer can start at 8:20 pm instead of only 8:00 / 8:30. Default 30, so
-- every existing venue is unchanged until an owner opts in.
-- ============================================================================

alter table public.booking_settings
  add column if not exists slot_step_minutes integer not null default 30
    check (slot_step_minutes in (5, 10, 15, 20, 30, 60));
