-- ============================================================================
-- Arena OS — 0077: backfill `sequences` for booking numbers already minted
--
-- lib/booking/service.ts's nextBookingNumber just switched from a
-- `count(*) + 1` read against `bookings` to the atomic `sequences` upsert
-- 0018/0056 already allow for kind='booking' — the same mechanism order/KOT
-- numbers were moved onto in 0056/0062, for the exact same reason: the old
-- read-then-write count is not concurrency-safe, and seatTableSessionCore
-- (M17 walk-in seating) makes that collision far more likely than the plain
-- timed-booking flow ever did.
--
-- Same forward-only gap 0062 already documented and fixed for order/KOT
-- numbers applies here: for every (tenant, day) that already had at least one
-- booking before this deployed, `sequences` has no row for kind='booking' at
-- that period, so the FIRST booking placed after the deploy starts a fresh
-- row at value=1 — i.e. BK-<day>-001 — which collides with the number the old
-- mechanism already issued for that same day, and the insert fails on
-- bookings_tenant_number_key. Because the failing INSERT and the sequence
-- bump share one transaction, the failure rolls the bump back too, so every
-- retry hits the exact same collision — this does not self-heal.
--
-- Fix: seed sequences with the highest NNN already used per (tenant, day),
-- from the booking numbers themselves — the only record of what the old
-- mechanism had already handed out. GREATEST(...) on conflict, same as 0062,
-- so this is safe to run against a row a later, correctly-numbered booking
-- may have already created (never moves a counter backwards).
-- ============================================================================

insert into public.sequences (tenant_id, kind, period, value)
select
  b.tenant_id,
  'booking',
  substring(b.booking_number from 'BK-(\d{8})-\d+$') as period,
  max(substring(b.booking_number from 'BK-\d{8}-(\d+)$')::int) as value
from public.bookings b
where b.booking_number ~ '^BK-\d{8}-\d+$'
group by b.tenant_id, substring(b.booking_number from 'BK-(\d{8})-\d+$')
on conflict (tenant_id, kind, period)
  do update set value = greatest(public.sequences.value, excluded.value);
