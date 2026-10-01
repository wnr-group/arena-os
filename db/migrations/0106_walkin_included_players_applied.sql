-- ============================================================================
-- Arena OS — 0106: booking_slots.included_players_applied (M29 #8)
--
-- A board-with-surcharge walk-in froze its base rate and extra-player rate at
-- start but read included_players LIVE from resource_types at checkout, so an
-- owner editing the type mid-session silently re-priced the surcharge. This
-- freezes the included-player count on the slot, same discipline as
-- extra_player_rate_applied.
--
-- Nullable, no backfill: null = "no snapshot" (every pre-existing row and every
-- non-board slot); checkout falls back to the live value for those, which is
-- exactly the previous behaviour. No RLS/grant changes — booking_slots already
-- has them.
-- ============================================================================

alter table public.booking_slots
  add column if not exists included_players_applied smallint
    check (included_players_applied is null or included_players_applied >= 1);

comment on column public.booking_slots.included_players_applied is
  'Players covered by the base rate, frozen at walk-in start (M29 #8). Null unless a board-with-surcharge walk-in started after 0106; checkout falls back to the live resource_types.included_players when null.';
