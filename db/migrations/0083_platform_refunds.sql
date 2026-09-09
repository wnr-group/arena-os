-- ============================================================================
-- Arena OS — 0083 platform refunds (AROS-114)
--
-- AROS-114 asks for a platform billing dashboard with manual overrides. Four of
-- the five overrides need NO schema at all, and that is worth stating first
-- because it is the result of an inspection, not an oversight:
--
--   change plan     → lib/actions/plans.ts assignPlan() already does this, and
--                     already refuses to touch a gateway-backed subscription.
--   extend trial    → moves tenant_subscriptions.current_period_end, a column
--                     that has existed since 0079.
--   comp / discount → ALREADY MODELLED. 0081 built credit notes plus
--                     consumeProrationCredit(), which sets an outstanding
--                     credit against the next charge as `adjustment`. A comp is
--                     a credit note with a different reason on it. Adding a
--                     `discounts` table would have been a second money model
--                     for a problem this schema already solves.
--   force cancel    → lib/platform/billing/cancel.ts, plus the existing
--                     `cancelled` / `cancel_at_period_end` columns.
--
-- The metrics — MRR, ARR, subscription mix, churn, revenue over time — are all
-- derived by aggregation over `plans`, `tenant_subscriptions`, `tenants` and
-- `platform_invoices`. Nothing is denormalised, cached or duplicated, so no
-- metric can drift from the rows it is computed from.
--
-- ── WHAT ACTUALLY NEEDS A TABLE: REFUNDS ────────────────────────────────────
--
-- A refund is money LEAVING Arena OS's account, and there is nowhere to record
-- one today:
--
--   public.refunds (0018)      is the TENANT's till — refunds of a venue's own
--                              customer payments, foreign-keyed to
--                              public.payments. A platform subscription charge
--                              is not in that table and never will be.
--   platform_invoices.status   is draft|issued|paid|void (0018's enum, reused).
--                              There is no 'refunded', and adding one would
--                              lose the AMOUNT — a partial refund is not a
--                              status.
--   credit notes               are the opposite operation: a credit note is an
--                              unpaid credit set against a FUTURE charge, and
--                              `platform_invoices_credit_note_unpaid` (0081)
--                              CHECKs that it carries no gateway_payment_id
--                              precisely so it can never be mistaken for money
--                              that moved.
--
-- So one table, modelled as closely on public.refunds (0018) as the different
-- parent allows: a row per refund, an amount, a reason, an actor, and the
-- invariant `sum(amount) <= invoice.total` protected by a row lock rather than
-- by hope.
--
-- ── WHAT THIS TABLE IS NOT ──────────────────────────────────────────────────
--
-- It is not a ledger and nothing sums it into a stored balance. "How much of
-- this invoice has been refunded?" is answered by summing the rows under a lock
-- at the moment it matters, which is the same discipline lib/billing/refunds.ts
-- follows for the tenant side and the same reason a redelivered webhook cannot
-- double-count money anywhere in this schema.
-- ============================================================================

create table if not exists public.platform_refunds (
  id uuid primary key default gen_random_uuid(),

  -- Denormalised from the invoice so a tenant-scoped RLS policy and the
  -- "show me this business's refunds" read need no join. It is written from
  -- the LOCKED invoice row, never from a caller.
  tenant_id uuid not null references public.tenants(id) on delete cascade,

  -- restrict, exactly like platform_invoices.subscription_id (0081): the bill a
  -- refund reverses must not be deletable out from under it. Historical billing
  -- data is never deleted.
  invoice_id uuid not null
    references public.platform_invoices(id) on delete restrict,

  -- ── the gateway side ────────────────────────────────────────────────────
  --
  -- ARENA OS's Razorpay account, never a tenant's own (see 0080's header for
  -- why the two must never cross). `gateway_payment_id` is copied from the
  -- invoice being refunded, so a refund can only ever point at the payment that
  -- invoice recorded.
  gateway text not null default 'razorpay' check (btrim(gateway) <> ''),
  gateway_payment_id text not null check (btrim(gateway_payment_id) <> ''),

  -- Razorpay's own refund object (`rfnd_…`). Null only while a refund is
  -- 'pending' at the gateway or was refused outright.
  gateway_refund_id text check (gateway_refund_id is null or btrim(gateway_refund_id) <> ''),

  -- Rupees, matching every other money column in this schema. Strictly
  -- positive: a zero or negative refund is not a refund, and the amount that
  -- may be refunded is capped against the invoice in application code under a
  -- row lock (a CHECK cannot see another table).
  amount numeric(10,2) not null check (amount > 0),
  currency text not null default 'INR' check (length(currency) = 3),

  reason text not null check (btrim(reason) <> '' and length(reason) <= 500),

  -- ── status: the GATEWAY is authoritative ────────────────────────────────
  --
  --   pending    Razorpay accepted the instruction and is still working.
  --   processed  the money has actually left. Only this counts as refunded
  --              revenue in the dashboard.
  --   failed     Razorpay refused or reversed it. Excluded from the refunded
  --              total, so a failed attempt does not permanently consume part
  --              of an invoice's refundable amount.
  --
  -- Moved from 'pending' to a final state ONLY by a signature-verified
  -- refund.processed / refund.failed webhook, never by the browser round-trip
  -- that started it — the same rule the subscription lifecycle already follows.
  status text not null default 'pending'
    check (status in ('pending', 'processed', 'failed')),

  -- The PLATFORM ADMIN who did it. A `users` reference, not a membership:
  -- a platform admin is a global identity (users.is_platform_admin) and
  -- normally holds no membership in the tenant it is acting on, which is
  -- exactly why public.audit_log's actor_membership_id is null for these
  -- actions and the admin's identity is carried in the entry's `after` payload.
  -- `set null` so the record of the refund survives the account being removed.
  created_by_user_id uuid references public.users(id) on delete set null,

  -- The retry token, same idiom and same purpose as payments.idempotency_key
  -- (0040): a double-clicked button or a re-submitted form sends the SAME key,
  -- and the unique index below turns the second attempt into a no-op instead of
  -- a second refund. Nullable so a server-initiated refund need not invent one.
  request_key text check (request_key is null or btrim(request_key) <> ''),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists trg_platform_refunds_updated on public.platform_refunds;
create trigger trg_platform_refunds_updated
  before update on public.platform_refunds
  for each row execute function public.set_updated_at();

-- ── the two idempotency guarantees ──────────────────────────────────────────
--
-- 1. ONE REFUND PER REQUEST. The caller's retry token, scoped to the tenant
--    exactly as idx_payments_idempotency (0040) scopes its own. This is what
--    stops a double-clicked "Refund" button becoming two refunds within the
--    invoice's cap — the cap alone would happily allow both.
create unique index if not exists idx_platform_refunds_request
  on public.platform_refunds (tenant_id, request_key)
  where request_key is not null;

-- 2. ONE ROW PER GATEWAY REFUND. A refund.processed webhook can be redelivered
--    any number of times, and Razorpay may report one refund under several
--    event ids. Matching on OUR OWN stored reference and refusing a duplicate
--    insert is what keeps the refunded total honest.
create unique index if not exists idx_platform_refunds_gateway_ref
  on public.platform_refunds (gateway, gateway_refund_id)
  where gateway_refund_id is not null;

-- "How much of this invoice has come back?" — the sum taken under the invoice's
-- row lock before every new refund is allowed.
create index if not exists idx_platform_refunds_invoice
  on public.platform_refunds (invoice_id, created_at desc);

-- "What has this business had refunded?" — the drill-down and the dashboard's
-- refund series.
create index if not exists idx_platform_refunds_tenant
  on public.platform_refunds (tenant_id, created_at desc);

-- ── RLS + grants ────────────────────────────────────────────────────────────
--
-- Exactly the treatment platform_invoices got in 0081 and
-- platform_dunning_notices got in 0082, for the same reason: what a business
-- pays Arena OS — and what came back — is the PROPRIETOR's own commercial
-- information. `auth_role_in() = 'owner'`, the helper 0020 introduced.
--
-- SELECT is the ONLY grant. Refunds are created by a platform admin on the
-- owner connection and settled by the platform webhook, which has no session at
-- all. A missing GRANT is a stronger guarantee than a policy that evaluates to
-- false: there is no insert, update or delete path for a tenant user to probe,
-- so a business cannot mint itself a refund, inflate one, or erase the record
-- of one it received.
alter table public.platform_refunds enable row level security;

drop policy if exists platform_refunds_owner_select on public.platform_refunds;
create policy platform_refunds_owner_select on public.platform_refunds
  for select using (public.auth_role_in(tenant_id) = 'owner');

grant select on public.platform_refunds to arena_app;

comment on table public.platform_refunds is
  'ARENA OS refunding a BUSINESS part or all of a subscription charge. Not public.refunds, which is a venue refunding its own customer. Owner-read-only; written only on the owner connection by a platform admin, and settled only by the signature-verified platform webhook.';

comment on column public.platform_refunds.status is
  'pending until a signature-verified refund.processed / refund.failed webhook says otherwise. Only ''processed'' counts as refunded revenue; ''failed'' releases the amount back to the invoice''s refundable balance.';
