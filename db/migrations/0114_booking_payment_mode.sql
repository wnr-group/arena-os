-- ============================================================================
-- Arena OS — 0114: online booking payment mode (M36 #1)
--
-- What the storefront collects at booking time, one setting per venue:
--   optional_full  legacy: customer may tick "pay online now" and pays in full
--   venue          nothing online, pay at the venue
--   advance        collect an advance (fixed rupees or percent of the total)
--   full           collect the full amount
--
-- Existing rows (and tenants with no row, which the reader treats the same) land
-- on optional_full, so nothing changes until an owner picks a mode.
-- RLS is unchanged: payment_settings_* stay manager-only; the storefront reads
-- the mode server-side only (M36 #2), never the raw row.
-- ============================================================================

do $$ begin
  create type public.online_payment_mode as enum ('optional_full', 'venue', 'advance', 'full');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.advance_type as enum ('fixed', 'percent');
exception when duplicate_object then null; end $$;

alter table public.payment_settings
  add column if not exists online_payment_mode public.online_payment_mode not null default 'optional_full',
  add column if not exists advance_type public.advance_type,
  add column if not exists advance_value numeric(12,2);

do $$ begin
  alter table public.payment_settings
    add constraint payment_settings_advance_shape
    check (
      (online_payment_mode = 'advance'
        and advance_type is not null
        and advance_value is not null
        and advance_value > 0
        and (advance_type = 'fixed' or advance_value < 100))
      or
      (online_payment_mode <> 'advance'
        and advance_type is null
        and advance_value is null)
    );
exception when duplicate_object then null; end $$;

-- advance / full cannot be on without a stored key id + secret.
do $$ begin
  alter table public.payment_settings
    add constraint payment_settings_online_mode_needs_credentials
    check (
      online_payment_mode not in ('advance', 'full')
      or (razorpay_key_id is not null and razorpay_key_secret_encrypted is not null)
    );
exception when duplicate_object then null; end $$;

comment on column public.payment_settings.online_payment_mode is
  'M36 #1 — what the storefront collects at booking: optional_full (legacy default), venue, advance, full.';
