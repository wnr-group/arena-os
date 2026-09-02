-- ============================================================================
-- Arena OS — 0064: let a public (no-login) order transaction mint its own
-- order/KOT numbers from `sequences`
--
-- 0063 widened sequences.kind to allow 'order', so lib/orders/service.ts can
-- mint OR-/KOT- numbers via the same atomic upsert lib/billing/invoice.ts
-- already uses for invoices. But sequences_rw (0018) only grants staff
-- sessions (auth_tenant_ids(), keyed off app.user_id) — placeOnlineOrder
-- (lib/actions/public-orders.ts) runs createOrderCore under
-- withPublicTenant() instead, an unauthenticated session keyed off
-- app.public_tenant_id, which sequences_rw does not recognise at all.
-- Without this, a public order/station/pickup order would fail outright the
-- moment it tried to bump the sequence — the previous count(*) queries this
-- replaces got by on orders_public_select/kots_public_select (0056), which
-- existed for exactly this reason.
--
-- Scoped to kind in ('order','kot') only — a public session may bump the
-- day's order/KOT counters, and nothing else: 'booking' and 'invoice'
-- sequences stay staff-only, enforced here at the database layer rather than
-- solely by createOrderCore never asking for them.
--
-- Also needs a SELECT policy: nextDailyNumber's `insert ... returning value`
-- has to re-select the just-written row to hand the value back, and Postgres
-- RLS checks INSERT ... RETURNING against the table's SELECT policy same as
-- any other read — without one, the insert itself fails with "new row
-- violates row-level security policy" even though the WITH CHECK it's
-- actually complaining about would have passed.
-- ============================================================================

drop policy if exists sequences_public_select on public.sequences;
create policy sequences_public_select on public.sequences
  for select using (
    tenant_id = public.current_public_tenant_id() and kind in ('order', 'kot')
  );

drop policy if exists sequences_public_insert on public.sequences;
create policy sequences_public_insert on public.sequences
  for insert with check (
    tenant_id = public.current_public_tenant_id() and kind in ('order', 'kot')
  );

drop policy if exists sequences_public_update on public.sequences;
create policy sequences_public_update on public.sequences
  for update using (
    tenant_id = public.current_public_tenant_id() and kind in ('order', 'kot')
  )
  with check (
    tenant_id = public.current_public_tenant_id() and kind in ('order', 'kot')
  );
