-- ============================================================================
-- Arena OS — 0102: public holiday pricing — data model
--
-- M27 #1 (AROS-247) — the foundation the rest of the holiday-pricing series
-- builds on. Owners today can only price a WEEKDAY vs WEEKEND (M22,
-- resource_types.weekend_rate); this adds a third, higher-precedence axis: a
-- literal calendar date, per resource type, that overrides both.
--
-- ── holiday_rates ────────────────────────────────────────────────────────
-- One row per (resource_type_id, date). `date` is a plain calendar date, no
-- time/timezone component — it is compared against the tenant's own local
-- wall-clock date at slot-start time (todayInZone, lib/booking/time.ts),
-- same "local calendar day" concept business_profiles.weekend_days /
-- isWeekendDay already use. A timestamptz here would let UTC-day drift
-- disagree with what the owner actually picked on the calendar.
--
-- Not industry-gated, same as weekend_rate: this is a sibling axis on
-- resource_types, so it naturally no-ops for a restaurant table (₹0/hr
-- regardless).
--
-- v1 boundary: a booking under a named setup (resource_setups, M24) already
-- bypasses weekend_rate/happy hours entirely ("flat as named") — it bypasses
-- holiday pricing for the identical reason, so this table is never consulted
-- on that path. Only the base-rate (no-setup) path reads it.
--
-- ── booking_slots.holiday_rate_applied ──────────────────────────────────
-- Same discipline as happy_hour_applied/setup_id/rate_unit (0096/0099):
-- frozen at booking time, never re-derived from live holiday_rates config on
-- read. Not required for pricing correctness on its own — rate_applied
-- already captures whatever was actually charged — but gives reporting a
-- clean signal for "this booking billed at a holiday rate" without having to
-- reverse-engineer it from rate_applied against a possibly-since-changed or
-- since-deleted holiday_rates row. Existing rows read false — byte-identical
-- to today; nothing reads holiday_rates until M27 #2.
-- ============================================================================

create table if not exists public.holiday_rates (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants(id) on delete cascade,
  resource_type_id uuid not null references public.resource_types(id) on delete cascade,
  date             date not null,
  rate             numeric(10,2) not null check (rate >= 0),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (resource_type_id, date)
);
create index if not exists idx_holiday_rates_tenant on public.holiday_rates(tenant_id);
create index if not exists idx_holiday_rates_type on public.holiday_rates(resource_type_id);

drop trigger if exists trg_holiday_rates_updated on public.holiday_rates;
create trigger trg_holiday_rates_updated before update on public.holiday_rates
  for each row execute function public.set_updated_at();

alter table public.booking_slots
  add column if not exists holiday_rate_applied boolean not null default false;

comment on table public.holiday_rates is
  'M27 #1 — a resource type''s fixed hourly rate on one literal calendar date (a public holiday, a festival, a one-off event), overriding both weekend_rate and the weekday base hourly_rate. A one-off, not a recurring rule (v1 boundary) — the owner re-adds it each year if needed.';
comment on column public.holiday_rates.date is
  'Plain calendar date, no time/timezone component — compared against the tenant''s own local wall-clock date at slot-start time (todayInZone), same concept business_profiles.weekend_days uses. Do not read/write this as a timestamptz.';
comment on column public.holiday_rates.rate is
  'Fixed/undiscountable hourly rate for this resource type on this date. An active happy-hour rule does NOT apply on top of it — the one place holiday pricing behaves differently from weekend pricing.';
comment on column public.booking_slots.holiday_rate_applied is
  'M27 #1 — true when this slot''s rate_applied came from a holiday_rates row at booking time. Reporting signal only; rate_applied already captures the actual charge regardless. False for every pre-existing row and every slot with no holiday rate configured for its resource type/date.';

-- ============================================================================
-- RLS + grants — mirrors resource_types/resource_setups (0002/0099): any
-- active tenant member may read; only owner/manager may write (the owner
-- configures holiday pricing).
-- ============================================================================
alter table public.holiday_rates enable row level security;

drop policy if exists holiday_rates_select on public.holiday_rates;
create policy holiday_rates_select on public.holiday_rates
  for select using (tenant_id in (select public.auth_tenant_ids()));

drop policy if exists holiday_rates_write on public.holiday_rates;
create policy holiday_rates_write on public.holiday_rates
  for all using (public.auth_is_manager(tenant_id))
          with check (public.auth_is_manager(tenant_id));

grant select, insert, update, delete on public.holiday_rates to arena_app;
