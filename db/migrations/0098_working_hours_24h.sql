-- ============================================================================
-- Arena OS — 0098: working hours "open 24 hours"
--
-- The close time is a same-day 'HH:mm', so a day can never actually reach
-- midnight: the max configurable window is 12:00 AM–11:59 PM, and every
-- booking must END by close, so the final 11:30 PM–12:00 AM slot (and any
-- session running to midnight) is unbookable. This adds an explicit per-weekday
-- "open 24 hours" flag: when true, availability treats the day as 00:00 through
-- the NEXT midnight (a full 24h), so the last slot to 12:00 AM is offered and
-- open_time/close_time are ignored for that day.
--
-- A day is never both closed and 24h; the availability reader checks is_closed
-- first, so is_closed wins if both were somehow set.
-- ============================================================================

alter table public.working_hours
  add column if not exists open_24h boolean not null default false;

comment on column public.working_hours.open_24h is
  'When true, this weekday is open a full 24 hours (00:00 → next midnight) and open_time/close_time are ignored for availability (migration 0098). Never combined with is_closed.';
