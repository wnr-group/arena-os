-- ============================================================================
-- Arena OS — 0078: let a public (no-login) booking transaction mint its own
-- BK- numbers from `sequences`
--
-- nextBookingNumber (lib/booking/service.ts) was moved onto the atomic
-- `sequences` upsert in the same change 0077 backfilled for — the same
-- mechanism lib/orders/service.ts already uses for order/KOT numbers. But
-- sequences_rw (0018) only grants staff sessions (auth_tenant_ids(), keyed
-- off app.user_id). The public booking wizard (lib/actions/public-booking.ts)
-- runs createBookingCore under withPublicTenant() instead, an unauthenticated
-- session keyed off app.public_tenant_id, which sequences_rw does not
-- recognise at all — exactly the gap 0064 already closed for kind in
-- ('order','kot'). Without this, every public booking (pay-at-venue or
-- pay-online) fails outright the moment it tries to bump the sequence, with
-- "new row violates row-level security policy for table sequences".
--
-- Widens 0064's sequences_public_* policies (kind in ('order','kot')) to also
-- allow 'booking', rather than adding new same-purpose policies — a public
-- session may bump the day's order/KOT/booking counters, and nothing else:
-- 'invoice' stays staff-only. Re-creating these three under the same names
-- 0064 used replaces them in place, so order/KOT public access is preserved,
-- not dropped.
--
-- Also needs the SELECT policy for the same reason 0064 needed one: the
-- `insert ... returning value` in nextBookingNumber re-selects the just
-- written row, and Postgres checks INSERT ... RETURNING against the table's
-- SELECT policy same as any other read.
-- ============================================================================

drop policy if exists sequences_public_select on public.sequences;
create policy sequences_public_select on public.sequences
  for select using (
    tenant_id = public.current_public_tenant_id() and kind in ('order', 'kot', 'booking')
  );

drop policy if exists sequences_public_insert on public.sequences;
create policy sequences_public_insert on public.sequences
  for insert with check (
    tenant_id = public.current_public_tenant_id() and kind in ('order', 'kot', 'booking')
  );

drop policy if exists sequences_public_update on public.sequences;
create policy sequences_public_update on public.sequences
  for update using (
    tenant_id = public.current_public_tenant_id() and kind in ('order', 'kot', 'booking')
  )
  with check (
    tenant_id = public.current_public_tenant_id() and kind in ('order', 'kot', 'booking')
  );
