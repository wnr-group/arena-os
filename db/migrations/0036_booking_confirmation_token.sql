-- ============================================================================
-- Arena OS — 0036 booking confirmation token: the unguessable identifier for
-- the public confirmation page (app/(public)/b/[token]) and its QR code.
--
-- bookings.booking_number (BK-YYYYMMDD-NNN) is sequential and trivially
-- enumerable, so it can never be the public URL's key — anyone could walk the
-- counter and read other customers' names/phones. confirmation_token is a
-- separate, random 122-bit value with no relation to the booking number;
-- the confirmation page and staff check-in scan both look bookings up by
-- this column instead.
-- ============================================================================

alter table public.bookings
  add column if not exists confirmation_token uuid not null default gen_random_uuid();

alter table public.bookings
  drop constraint if exists bookings_tenant_token_key;
alter table public.bookings
  add constraint bookings_tenant_token_key unique (tenant_id, confirmation_token);
