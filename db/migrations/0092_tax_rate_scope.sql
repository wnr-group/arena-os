-- ============================================================================
-- Arena OS — 0092: tax rate scope (food / resources / both)
--
-- tax_rates (0009) was food-only from day one — its only consumer was
-- menu_items.tax_rate_id. Resource bookings (the arena/device side) never had
-- any tax at all: lib/billing/invoice.ts's loadBookingLines hardcoded
-- tax_percent = 0 because there was nothing to read a rate from.
--
-- This adds:
--   - tax_rates.applies_to: which side of the business a rate is eligible
--     for ('food' | 'resources' | 'both'). Existing rows default to 'food',
--     preserving exactly what they already do today — nothing is silently
--     taxed differently by this migration.
--   - resource_types.tax_rate_id: the resources-side counterpart to
--     menu_items.tax_rate_id, same nullable/SET NULL FK shape. An owner picks
--     a rate per resource type (e.g. "PS5 Station"), same granularity food
--     already has per item.
--   - booking_slots.tax_rate_percent: a snapshot column, same discipline as
--     rate_applied/resource_name/resource_type_name on the same table and
--     order_items.tax_rate for food — frozen at booking time, never
--     re-derived from live config on read.
--
-- Enforcement that a rate's applies_to actually matches where it's assigned
-- (a 'resources'-only rate can't land on a menu item, a 'food'-only rate
-- can't land on a resource type) lives in application code
-- (lib/actions/menu.ts, lib/actions/resources.ts), not a DB constraint —
-- same pattern menu_items.tax_rate_id already uses for tenant-ownership
-- re-validation.
-- ============================================================================

do $$ begin
  create type public.tax_rate_applies_to as enum ('food','resources','both');
exception when duplicate_object then null; end $$;

alter table public.tax_rates
  add column if not exists applies_to public.tax_rate_applies_to not null default 'food';

alter table public.resource_types
  add column if not exists tax_rate_id uuid references public.tax_rates(id) on delete set null;

alter table public.booking_slots
  add column if not exists tax_rate_percent numeric(5,2) not null default 0
    check (tax_rate_percent >= 0 and tax_rate_percent <= 100);

comment on column public.tax_rates.applies_to is
  'Which side of the business this rate may be attached to — gates the tax-rate picker on menu items (food/both) and resource types (resources/both). Enforced in lib/actions/menu.ts and lib/actions/resources.ts, not a DB constraint.';
comment on column public.resource_types.tax_rate_id is
  'Resources-side counterpart to menu_items.tax_rate_id (0010) — the tax rate applied to bookings for this resource type. Snapshotted onto booking_slots.tax_rate_percent at booking time.';
comment on column public.booking_slots.tax_rate_percent is
  'Snapshot of the resource type''s tax rate at booking time (0092) — same discipline as rate_applied/resource_name/resource_type_name on this table. 0 = no resources tax configured for that type.';
