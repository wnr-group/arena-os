-- ============================================================================
-- Arena OS — 0082 paid event registrations through the EXISTING Razorpay
-- integration (M15 #3).
--
-- No new gateway, no new webhook, no second set of credentials. `payment_intents`
-- (0033) already models "a gateway order we are waiting on", and 0058 already
-- taught it a second kind of target (a standalone order beside a booking
-- deposit). This adds the third target the same way, so the ONE webhook in
-- app/api/webhooks/razorpay/route.ts settles all three.
--
-- The credentials used are the tenant's own BYO keys, loaded through
-- lib/settings/razorpay-credentials.ts, exactly as booking deposits and order
-- pay-now do. Nothing here reaches for platform billing credentials (M16) —
-- an event entry fee is money the VENUE collects from its customer, not money
-- the platform collects from the venue.
--
-- ── Split from 0081 for a hard Postgres reason ──────────────────────────────
--
-- `alter type … add value` is at the bottom of this file, and a label added
-- that way cannot be REFERENCED in the transaction that added it. Every policy
-- and index here that names 'event_registration' therefore has to precede it
-- in a file that does NOT add it… which is impossible in one file. So the label
-- goes last here and everything that names it lands in 0083. Same split, same
-- reason, as 0058 → 0059.
-- ============================================================================

-- ── 1. the third target ─────────────────────────────────────────────────────
alter table public.payment_intents
  add column if not exists event_registration_id uuid;

-- The composite-FK device again: an intent can never name a registration
-- belonging to a different tenant, because the FK carries tenant_id and FKs are
-- not subject to RLS.
do $$ begin
  alter table public.payment_intents
    add constraint payment_intents_event_registration_tenant_fkey
    foreign key (tenant_id, event_registration_id)
    references public.event_registrations(tenant_id, id)
    on delete cascade;
exception when duplicate_object then null; end $$;

-- A payment intent is for exactly ONE thing. 0058 said "one of two"; this says
-- "one of three". Dropped and re-added rather than altered, because a CHECK
-- constraint has no ALTER form.
alter table public.payment_intents
  drop constraint if exists payment_intents_exactly_one_target;

alter table public.payment_intents
  add constraint payment_intents_exactly_one_target
  check (num_nonnulls(booking_id, order_id, event_registration_id) = 1);

-- The idempotency rule, per target, matching the two 0058 already created: at
-- most one PENDING intent per registration+purpose. A double-tapped "Pay" that
-- races past the application check gets 23505 and reuses the winner's order
-- instead of opening a second one.
create unique index if not exists idx_payment_intents_one_pending_event_registration
  on public.payment_intents(tenant_id, event_registration_id, purpose)
  where status = 'pending' and event_registration_id is not null;

create index if not exists idx_payment_intents_event_registration
  on public.payment_intents(tenant_id, event_registration_id);

-- ── 2. the purpose label ────────────────────────────────────────────────────
-- LAST statement in the file, and nothing above or below may reference it —
-- see the header. 0083 is where it starts being used.
alter type public.payment_intent_purpose add value if not exists 'event_registration';
