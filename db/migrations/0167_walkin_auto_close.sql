-- ============================================================================
-- Arena OS — 0167 auto-close forgotten open-tab walk-ins
--
-- An open-tab walk-in has no end time until staff check it out, so a forgotten
-- one keeps running day after day. When this is set, a scheduled job
-- (/api/cron/auto-close-walkins) closes any open-tab walk-in that has been
-- running longer than this many minutes, billing it for exactly that long.
-- NULL = off, so every existing venue is unchanged until an owner opts in.
-- ============================================================================

alter table public.booking_settings
  add column if not exists walkin_auto_close_minutes integer
    check (walkin_auto_close_minutes is null or walkin_auto_close_minutes between 30 and 1440);
