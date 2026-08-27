-- ============================================================================
-- Arena OS — 0062: backfill `sequences` for order/KOT numbers already minted
--
-- 359b45a switched order/KOT numbering from a `count(*) + 1` read against
-- orders/kots to the atomic `sequences` upsert 0056/0057 wired up (the same
-- mechanism invoice numbers already used). That fix is forward-only: it never
-- seeded `sequences` with the count each tenant's numbering had already
-- reached under the old mechanism.
--
-- The result: for every (tenant, day) that already had at least one order or
-- KOT before this deployed, `sequences` has no row for kind='order'/'kot' at
-- that period. The FIRST order/KOT placed after the deploy starts a fresh row
-- at value=1 — i.e. OR-<day>-001 / KOT-<day>-001 — which collides with the
-- number the old mechanism already issued for that same day, and the insert
-- fails on orders_tenant_number_key / the KOT equivalent. Because the failing
-- INSERT and the sequence bump share one transaction, the failure rolls the
-- bump back too, so every retry hits the exact same collision — this does not
-- self-heal.
--
-- Fix: seed sequences with the highest NNN already used per (tenant, kind,
-- day), from the order/kot numbers themselves — the only record of what the
-- old mechanism had already handed out. GREATEST(...) on conflict so this is
-- safe to run against a row a later, correctly-numbered order may have
-- already created (never moves a counter backwards).
-- ============================================================================

insert into public.sequences (tenant_id, kind, period, value)
select
  o.tenant_id,
  'order',
  substring(o.order_number from 'OR-(\d{8})-\d+$') as period,
  max(substring(o.order_number from 'OR-\d{8}-(\d+)$')::int) as value
from public.orders o
where o.order_number ~ '^OR-\d{8}-\d+$'
group by o.tenant_id, substring(o.order_number from 'OR-(\d{8})-\d+$')
on conflict (tenant_id, kind, period)
  do update set value = greatest(public.sequences.value, excluded.value);

insert into public.sequences (tenant_id, kind, period, value)
select
  k.tenant_id,
  'kot',
  substring(k.kot_number from 'KOT-(\d{8})-\d+$') as period,
  max(substring(k.kot_number from 'KOT-\d{8}-(\d+)$')::int) as value
from public.kots k
where k.kot_number ~ '^KOT-\d{8}-\d+$'
group by k.tenant_id, substring(k.kot_number from 'KOT-(\d{8})-\d+$')
on conflict (tenant_id, kind, period)
  do update set value = greatest(public.sequences.value, excluded.value);
