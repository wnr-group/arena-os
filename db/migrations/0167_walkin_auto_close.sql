-- ============================================================================
-- Arena OS — 0167 auto-close forgotten open-tab walk-ins
--
-- An open-tab walk-in has no end time until staff check it out, so a forgotten
-- one keeps running day after day. When this is set, any open-tab walk-in
-- running longer than this many minutes is closed, billed for exactly that
-- long. There is no scheduler: the sweep runs when the Sessions list or the
-- alarm poll is read (/api/cron/auto-close-walkins exists but is unscheduled).
-- NULL = off, so every existing venue is unchanged until an owner opts in.
-- ============================================================================

alter table public.booking_settings
  add column if not exists walkin_auto_close_minutes integer
    check (walkin_auto_close_minutes is null or walkin_auto_close_minutes between 30 and 1440);
