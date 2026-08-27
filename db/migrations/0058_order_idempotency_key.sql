-- ============================================================================
-- Arena OS — 0058: idempotency key on orders
--
-- Neither placeOnlineOrder (public checkout) nor createOrder (staff POS "Take
-- order") had any way to tell "the network retried my last request" or "the
-- customer double-tapped Place order" apart from "this is a genuinely new
-- order" — the only guard was a client-side disabled/pending button state,
-- which protects nothing against an actual network-level retry. Each retry
-- created a brand-new order + KOT: real food cooked twice, and for a pay-now
-- order, a second payment intent to reconcile.
--
-- A client-generated key, sent once per checkout/take-order attempt and
-- reused verbatim on any retry of that SAME attempt, lets createOrderCore
-- (lib/orders/service.ts) recognise a retry and hand back the original
-- order instead of creating a second one. NULL for any caller that doesn't
-- send one (there are none left after this change, but the column stays
-- nullable rather than backfilled/required, since past rows genuinely have
-- no key to assign) — Postgres's UNIQUE constraint treats every NULL as
-- distinct from every other NULL, so those rows never collide with anything.
-- ============================================================================

alter table public.orders
  add column if not exists idempotency_key uuid;

alter table public.orders
  add constraint orders_tenant_idempotency_key unique (tenant_id, idempotency_key);
