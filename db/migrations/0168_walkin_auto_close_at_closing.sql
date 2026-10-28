-- ============================================================================
-- Arena OS — 0168 auto-close open-tab walk-ins at closing time
--
-- Adds a second auto-close rule next to 0167's max session length: close a
-- forgotten open-tab walk-in at the branch's closing time (working_hours). The
-- two rules combine — whichever deadline comes first wins. Off by default.
-- ============================================================================

alter table public.booking_settings
  add column if not exists walkin_auto_close_at_closing boolean not null default false;
