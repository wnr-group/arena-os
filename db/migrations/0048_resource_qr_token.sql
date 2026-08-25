-- ============================================================================
-- Arena OS — 0048 resource QR token: the unguessable identifier for a
-- station's public ordering entry point (app/(public)/order/[stationToken]),
-- printed as a QR code from the resources settings screen. Same shape as
-- bookings.confirmation_token (0026_booking_confirmation_token.sql) — a
-- separate random value, not the resource id, so the printed code can't be
-- swapped for another station's by walking a predictable identifier.
--
-- No RLS change: resources_public_select (0022_public_booking.sql) already
-- scopes reads by tenant_id = current_public_tenant_id() and status =
-- 'available' — a lookup filtered by qr_token under that same policy is
-- tenant-safe by construction, exactly like the booking confirmation token
-- lookup on app/(public)/b/[token].
-- ============================================================================

alter table public.resources
  add column if not exists qr_token uuid not null default gen_random_uuid();

alter table public.resources
  drop constraint if exists resources_tenant_qr_key;
alter table public.resources
  add constraint resources_tenant_qr_key unique (tenant_id, qr_token);
