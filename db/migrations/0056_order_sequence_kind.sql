-- ============================================================================
-- Arena OS — 0056: `order` as a sequences kind
--
-- Order and KOT numbers (OR-YYYYMMDD-NNN / KOT-YYYYMMDD-NNN) were minted with
-- a `count(*) + 1` read against the orders/kots tables — not concurrency-safe
-- under this app's default READ COMMITTED isolation: two orders created at
-- the same instant (this app now has many simultaneous, unauthenticated
-- online-ordering entry points, not just one staff POS terminal) can read the
-- same count and collide on the orders_tenant_number_key / kots equivalent
-- unique constraint, silently failing the loser's order.
--
-- `sequences` (0018) already solves exactly this for invoice numbers via one
-- atomic `insert ... on conflict do update set value = value + 1 returning
-- value` statement — and its `kind` check already allows 'kot', just never
-- wired up. This widens it to also allow 'order', so lib/orders/service.ts
-- can mint BOTH order and KOT numbers off the same race-proof mechanism,
-- keyed by (tenant_id, kind, period) where period is the YYYYMMDD day string
-- already computed there.
-- ============================================================================

alter table public.sequences
  drop constraint if exists sequences_kind_check;

alter table public.sequences
  add constraint sequences_kind_check
  check (kind in ('booking','invoice','kot','order'));
