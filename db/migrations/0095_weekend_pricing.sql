-- ============================================================================
-- Arena OS — 0095: weekend/weekday pricing — data model
--
-- M22 #1 — the foundation the rest of the weekend-pricing series builds on.
-- Resources bill at a single hourly rate today. This adds an optional
-- weekend rate on the resource type plus a tenant-configurable definition
-- of which weekdays count as "weekend". Purely additive: a type with no
-- weekend rate prices exactly as it does today.
--
-- ── resource_types.weekend_rate ──────────────────────────────────────────
-- Nullable. hourly_rate (and resources.hourly_rate_override) remain the
-- WEEKDAY rate, unchanged in meaning. weekend_rate null = no weekend
-- pricing configured — weekend behaves identically to weekday (opt-in).
-- Per-station overrides (resources.hourly_rate_override) apply to the
-- weekday rate only; on weekends every station of the type uses the
-- type's weekend_rate.
--
-- ── business_profiles.weekend_days ───────────────────────────────────────
-- The set of weekday numbers (JS getDay convention: 0=Sun...6=Sat) this
-- tenant treats as "weekend". Defaults to {0,6} (Sat+Sun). Same shape as
-- happy_hours.days_of_week (0010).
--
-- No snapshot column needed: the resolved rate already freezes onto
-- booking_slots.rate_applied (0092 discipline).
-- ============================================================================

alter table public.resource_types
  add column if not exists weekend_rate numeric(10,2)
    check (weekend_rate is null or weekend_rate >= 0);

alter table public.business_profiles
  add column if not exists weekend_days smallint[] not null default '{0,6}';

comment on column public.resource_types.weekend_rate is
  'Weekend hourly rate for this type (M22 #1). Null = no weekend pricing configured — weekend prices the same as weekday. hourly_rate (and resources.hourly_rate_override) remains the weekday rate.';
comment on column public.business_profiles.weekend_days is
  'Weekday numbers (0=Sun...6=Sat, JS getDay convention) this tenant treats as weekend for pricing (M22 #1). Default {0,6} (Sat+Sun).';
