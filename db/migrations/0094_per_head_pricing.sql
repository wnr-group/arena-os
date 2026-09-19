-- ============================================================================
-- Arena OS — 0094: per-head pricing — data model
--
-- M21 per-head #1 — the foundation the rest of the per-head series builds on.
-- Per-station pricing (the only mode until now) bills resource × rate × time.
-- Per-head pricing bills players × rate × time instead — same resource, same
-- booking_slots row, different multiplier. Purely additive: every existing
-- resource type keeps behaving exactly as it does today.
--
-- ── resource_types.pricing_mode / min_players ────────────────────────────────
-- pricing_mode  'per_resource' (default — today's behaviour, unchanged) or
--               'per_head' (bill by head_count instead of by resource).
--               resource_types.hourly_rate is UNCHANGED as a column — its
--               *meaning* now depends on pricing_mode: rate per resource per
--               hour ('per_resource') vs rate per player per hour
--               ('per_head'). Documented on the column in db/schema.ts.
-- min_players   floor on how many players a per-head booking must have (e.g.
--               snooker = 2). Meaningless for 'per_resource' types; defaults
--               to 1 there so the column stays NOT NULL everywhere.
--
-- ── bookings.head_count ───────────────────────────────────────────────────
-- Player count for a per-head booking. Null for every per-station booking
-- (the vast majority, unaffected by this migration).
--
-- ── booking_slots.head_count / pricing_mode ──────────────────────────────
-- Snapshotted at booking time, same discipline as rate_applied and
-- tax_rate_percent on this table (0092): once a slot is billed, its head
-- count and pricing mode are frozen — a later change to the resource type's
-- configuration can't reprice a booking already taken.
-- ============================================================================

alter table public.resource_types
  add column if not exists pricing_mode text not null default 'per_resource',
  add column if not exists min_players smallint not null default 1
    check (min_players >= 1);

alter table public.resource_types
  drop constraint if exists resource_types_pricing_mode_check;
alter table public.resource_types
  add constraint resource_types_pricing_mode_check
  check (pricing_mode in ('per_resource', 'per_head'));

alter table public.bookings
  add column if not exists head_count smallint
    check (head_count is null or head_count >= 1);

alter table public.booking_slots
  add column if not exists head_count smallint
    check (head_count is null or head_count >= 1),
  add column if not exists pricing_mode text;

alter table public.booking_slots
  drop constraint if exists booking_slots_pricing_mode_check;
alter table public.booking_slots
  add constraint booking_slots_pricing_mode_check
  check (pricing_mode is null or pricing_mode in ('per_resource', 'per_head'));

comment on column public.resource_types.pricing_mode is
  'How this resource type is billed (M21 per-head #1): per_resource (default — resource x rate x time, unchanged) or per_head (players x rate x time). hourly_rate''s meaning depends on this: rate per resource vs rate per player.';
comment on column public.resource_types.min_players is
  'Floor on head_count for a per_head booking on this type (e.g. snooker = 2). Unused (default 1) for per_resource types.';
comment on column public.bookings.head_count is
  'Player count for a per_head booking (M21 per-head #1). Null for every per_resource booking.';
comment on column public.booking_slots.head_count is
  'Snapshot of the booking''s head_count at booking time (M21 per-head #1) — same discipline as rate_applied/tax_rate_percent on this table. Null for per_resource bookings.';
comment on column public.booking_slots.pricing_mode is
  'Snapshot of the resource type''s pricing_mode at booking time (M21 per-head #1) — frozen so a later config change can''t reprice a booking already taken.';
