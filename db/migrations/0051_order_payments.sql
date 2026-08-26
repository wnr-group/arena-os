-- ============================================================================
-- Arena OS — 0051 order payments (schema): let a standalone (no-booking)
-- order be paid online through the SAME Razorpay integration booking
-- deposits already use (AROS-49/50) — same per-tenant keys, same webhook,
-- same idempotency guarantees.
--
-- payment_intents (0023) was built booking-only: booking_id NOT NULL, FK'd
-- only to bookings. This widens it to optionally intend an ORDER instead,
-- keeping exactly one of the two set — a payment intent is always FOR
-- something, never for both or neither.
--
-- Split from the RLS migration that follows (0052) because a label just
-- added by ALTER TYPE ... ADD VALUE cannot be referenced within the same
-- transaction that added it (a hard Postgres restriction), and
-- scripts/migrate.ts runs each file in one transaction. 0052's policies
-- reference 'order_payment' by name, so they must live in the next file,
-- once this one has committed.
-- ============================================================================

-- orders had no (tenant_id, id) unique target before now — nothing composite
-- FK'd onto it (kots.order_id is a plain single-column FK). Needed so
-- payment_intents can FK onto (tenant_id, order_id) the same way it already
-- does onto (tenant_id, booking_id), same device bookings/invoices/
-- payment_intents themselves use.
do $$ begin
  alter table public.orders
    add constraint orders_tenant_id_key unique (tenant_id, id);
exception when duplicate_object then null; end $$;

alter table public.payment_intents
  alter column booking_id drop not null;

alter table public.payment_intents
  add column if not exists order_id uuid;

do $$ begin
  alter table public.payment_intents
    add constraint payment_intents_order_tenant_fkey
    foreign key (tenant_id, order_id) references public.orders(tenant_id, id)
    on delete cascade;
exception when duplicate_object then null; end $$;

-- A payment intent is for a booking deposit XOR a standalone order — never
-- both (which target would a webhook settle?) and never neither (settling
-- what, exactly?).
do $$ begin
  alter table public.payment_intents
    add constraint payment_intents_exactly_one_target
    check (num_nonnulls(booking_id, order_id) = 1);
exception when duplicate_object then null; end $$;

alter type public.payment_intent_purpose add value if not exists 'order_payment';

-- The old booking-only pending-idempotency index assumed booking_id was
-- NOT NULL. Replaced with one partial unique index per target, so "at most
-- one pending intent per booking+purpose" and "at most one pending intent
-- per order+purpose" are each enforced on their own, and a booking intent
-- can never collide with an order intent's index (they never share a row).
drop index if exists idx_payment_intents_one_pending;

create unique index if not exists idx_payment_intents_one_pending_booking
  on public.payment_intents(tenant_id, booking_id, purpose)
  where status = 'pending' and booking_id is not null;

create unique index if not exists idx_payment_intents_one_pending_order
  on public.payment_intents(tenant_id, order_id, purpose)
  where status = 'pending' and order_id is not null;

create index if not exists idx_payment_intents_order
  on public.payment_intents(tenant_id, order_id);

-- orders: a THIRD acceptance_status value, distinct from 'pending' (the
-- staff accept/reject queue, lib/orders/data.ts's listIncomingOnlineOrders)
-- and 'accepted' (visible to /kitchen, lib/kots/data.ts's listActiveKots).
-- A prepaid standalone order sits here — invisible to BOTH readers, since
-- neither filters for it — from the moment it's placed until the webhook
-- confirms payment and flips it to 'accepted'. Nothing else changes: the
-- order and its KOT are still born together in createOrderCore, same as
-- every other channel; only visibility is gated.
alter type public.order_acceptance_status add value if not exists 'awaiting_payment';
