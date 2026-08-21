-- ============================================================================
-- Arena OS — 0023 payment_intents: pending gateway orders awaiting a webhook
--
-- AROS-49 creates a Razorpay ORDER for a booking deposit. That is not a
-- payment: it is an intent to pay, which only becomes money when AROS-50
-- verifies the webhook signature. This table is where that intent lives in
-- between.
--
-- ── Why not reuse `payments` (0014)? ────────────────────────────────────────
-- `payments.invoice_id` is NOT NULL with a composite FK to `invoices`, and a
-- deposit is taken at BOOKING time — before any invoice exists (invoices are
-- raised at the till by lib/billing/invoice.ts). Relaxing that column would
-- weaken an invariant the whole billing module leans on: every payment settles
-- an invoice. So the intent gets its own table, keyed to the BOOKING, and
-- AROS-50 writes the real `payments` row once the money is confirmed.
--
-- Nothing in here is a secret: an order id is a public reference that Razorpay
-- also hands to the browser.
-- ============================================================================

do $$ begin
  create type public.payment_intent_status as enum ('pending','paid','failed','cancelled');
exception when duplicate_object then null; end $$;

-- One value today; an enum rather than free text so a second purpose (a
-- membership purchase, say) is a deliberate migration, not a typo.
do $$ begin
  create type public.payment_intent_purpose as enum ('booking_deposit');
exception when duplicate_object then null; end $$;

create table if not exists public.payment_intents (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references public.tenants(id) on delete cascade,
  branch_id          uuid not null references public.branches(id) on delete restrict,
  booking_id         uuid not null,
  purpose            public.payment_intent_purpose not null default 'booking_deposit',
  gateway            text not null default 'razorpay' check (btrim(gateway) <> ''),
  -- Razorpay's `order_xxxxxxxx`. Written ONLY after the gateway call returns.
  gateway_order_id   text not null check (btrim(gateway_order_id) <> ''),
  -- Filled by AROS-50 from the verified webhook, never here.
  gateway_payment_id text,
  -- Rupees, the project's money rule. The paise figure sent to Razorpay is
  -- derived from this by paise() and is not stored twice.
  amount             numeric(10,2) not null check (amount > 0),
  currency           text not null default 'INR' check (length(currency) = 3),
  status             public.payment_intent_status not null default 'pending',
  created_by         uuid references public.memberships(id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  -- Composite FK — the device 0008/0010/0017 use — so an intent can never
  -- reference ANOTHER tenant's booking. FKs are not subject to RLS, so the
  -- tenant column in the key is what makes cross-tenant linkage impossible.
  constraint payment_intents_booking_tenant_fkey
    foreign key (tenant_id, booking_id) references public.bookings(tenant_id, id)
    on delete cascade,
  constraint payment_intents_tenant_id_key unique (tenant_id, id)
);

-- THE idempotency rule: at most ONE pending intent per booking per purpose.
-- Partial on `status`, because a booking accumulates cancelled/failed intents
-- over retries and those must not block the next attempt. This is what makes a
-- double-clicked "Pay deposit" safe even if two requests race past the
-- application-level check — the loser gets 23505 and reuses the winner's order.
create unique index if not exists idx_payment_intents_one_pending
  on public.payment_intents(tenant_id, booking_id, purpose)
  where status = 'pending';

-- AROS-50's lookup key. Razorpay order ids are globally unique, so this is NOT
-- tenant-scoped on purpose: two tenants claiming one order id would make the
-- webhook ambiguous, and that must be impossible rather than merely unlikely.
create unique index if not exists idx_payment_intents_gateway_order
  on public.payment_intents(gateway, gateway_order_id);

create index if not exists idx_payment_intents_booking
  on public.payment_intents(tenant_id, booking_id);

drop trigger if exists trg_payment_intents_updated on public.payment_intents;
create trigger trg_payment_intents_updated before update on public.payment_intents
  for each row execute function public.set_updated_at();

-- ── RLS + grants ─────────────────────────────────────────────────────────────
-- Same shape as `payments_rw` in 0014: tenant-scoped for every member, with the
-- role rule (cashier and up) enforced by canBill() in the server action. An
-- intent carries no secret, so there is nothing here to withhold from a member
-- the way payment_settings withholds ciphertext.
alter table public.payment_intents enable row level security;

drop policy if exists payment_intents_rw on public.payment_intents;
create policy payment_intents_rw on public.payment_intents
  for all using (tenant_id in (select public.auth_tenant_ids()))
          with check (tenant_id in (select public.auth_tenant_ids()));

-- No DELETE: an intent is superseded by setting status='cancelled', never
-- removed. The gateway order it names outlives it, and reconciliation has to be
-- able to find the row that explains an incoming webhook.
grant select, insert, update on public.payment_intents to arena_app;
