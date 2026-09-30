-- ============================================================================
-- Arena OS — 0105: board pricing — included players + extra-player surcharge
-- (M29 #1)
--
-- A per_resource ("board") type can cover N included players in its base
-- rate and charge a flat per-hour surcharge for each player beyond that.
-- Purely additive: every existing type/booking reads the defaults below and
-- prices exactly as it does today. Nothing reads these columns until M29 #2+.
--
-- ── resource_types ───────────────────────────────────────────────────────
-- included_players            players covered by the base rate (>= 1).
-- extra_player_rate           per extra player per hour. Null = surcharge
--                             feature OFF for this type.
-- extra_player_weekend_rate   weekend per-extra-player rate. Null falls back
--                             to extra_player_rate (same idiom as
--                             weekend_rate, resolved by resolveDayRate).
--
-- The invariants "only per_resource types", "only gaming_cafe tenants" and
-- "a weekend extra rate needs a base extra rate" are enforced in the write
-- path (lib/actions/resources.ts, M29 #2), not by DB constraints.
--
-- ── booking_slots ────────────────────────────────────────────────────────
-- extra_player_rate_applied   the per-extra-player rate actually charged for
--                             the slot, frozen at booking time (rate_applied
--                             discipline). Null unless the booking was a
--                             board-with-surcharge booking. The player count
--                             reuses the existing head_count column.
--
-- No RLS/grant changes: both tables already have tenant-scoped policies.
-- ============================================================================

alter table public.resource_types
  add column if not exists included_players smallint not null default 1
    check (included_players >= 1),
  add column if not exists extra_player_rate numeric(10,2)
    check (extra_player_rate is null or extra_player_rate >= 0),
  add column if not exists extra_player_weekend_rate numeric(10,2)
    check (extra_player_weekend_rate is null or extra_player_weekend_rate >= 0);

alter table public.booking_slots
  add column if not exists extra_player_rate_applied numeric(10,2);

comment on column public.resource_types.included_players is
  'Players covered by the base rate of a per_resource (board) type (M29 #1). Default 1. Only meaningful when extra_player_rate is set.';
comment on column public.resource_types.extra_player_rate is
  'Per-extra-player hourly surcharge for a per_resource type (M29 #1). Null = surcharge off.';
comment on column public.resource_types.extra_player_weekend_rate is
  'Weekend per-extra-player hourly surcharge (M29 #1). Null falls back to extra_player_rate.';
comment on column public.booking_slots.extra_player_rate_applied is
  'Per-extra-player rate charged for this slot, frozen at booking time (M29 #1). Null unless a board-with-surcharge booking; head_count holds the player count.';
