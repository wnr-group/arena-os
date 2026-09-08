-- ============================================================================
-- Arena OS — 0080 platform invoices: recurring billing + GST (M16 #4)
--
-- 0078 built the plan/entitlement model. 0079 connected Arena OS's own Razorpay
-- account and the subscription lifecycle. This migration adds the DOCUMENT that
-- the recurring charge produces: a GST invoice from Arena OS to the business.
--
-- ── THREE THINGS THIS IS NOT ────────────────────────────────────────────────
--
--   1. NOT `invoices` (0018). That table is the VENUE billing ITS CUSTOMER for
--      a booking or a plate of food, in the venue's own name, numbered from the
--      venue's own `sequences` counter under the venue's own GSTIN. This table
--      is ARENA OS billing THE VENUE, in Arena OS's name, under Arena OS's
--      GSTIN. Same country, same tax, opposite direction — and mixing them
--      would put the platform's subscription fee into a tenant's revenue
--      reports, which mv_daily_revenue (0043) would then report as turnover the
--      venue never earned.
--
--   2. NOT a second payments system. There is no platform `payments` table and
--      deliberately so: one Razorpay capture produces exactly one row here,
--      carrying its own `gateway_payment_id`. The invoice IS the receipt. A
--      separate payment row would be a second thing to keep in step and a
--      second thing a redelivered webhook could duplicate.
--
--   3. NOT a second numbering mechanism. `platform_sequences` below is the same
--      insert-on-conflict-bump idiom as `sequences` (0018), and the numbers are
--      formatted by the same formatInvoiceNumber() in lib/billing/invoice.ts.
--      It exists as its own table only because `sequences` is keyed by
--      tenant_id NOT NULL, and GST numbering belongs to the SUPPLIER — here,
--      Arena OS — so a per-tenant counter would mint the same number for
--      different customers in the same financial year.
--
-- ── MONEY CONVENTION, STATED ONCE ───────────────────────────────────────────
--
-- numeric(10,2) rupees everywhere, matching `invoices` (0018), `plans` (0078)
-- and every other money column in this schema. All arithmetic goes through
-- round2() from lib/billing/pricing.ts — the project's single money helper —
-- and never through raw float addition.
--
-- PLAN PRICES ARE GST-INCLUSIVE. This is forced, not chosen: 0079's
-- subscribeTenantToPlan() refuses to create a subscription unless the Razorpay
-- plan's amount equals plans.monthly_price/annual_price exactly, so the rupees
-- Razorpay captures ARE the catalogue price. GST is therefore back-computed out
-- of the captured total rather than added to it, and `total` on every row here
-- equals the money that actually moved. See lib/platform/billing/gst.ts.
-- ============================================================================

-- ── 1. who Arena OS is, on its own invoices ─────────────────────────────────
--
-- A singleton, the same `id boolean` idiom as platform_payment_settings (0079):
-- there is one supplier. Separate from that table on purpose — that one holds
-- SECRETS and is granted to nobody, while this is a letterhead. Keeping them
-- apart means the letterhead can grow fields without anyone re-reasoning about
-- the blast radius of the credentials table.
--
-- Nothing here is read when RENDERING an invoice: every value is snapshotted
-- onto the row at issue time (see §3), so changing the letterhead tomorrow
-- cannot rewrite what a business was billed last year. This table is only ever
-- read at the moment an invoice is created.
create table if not exists public.platform_billing_settings (
  id boolean primary key default true check (id),

  seller_legal_name text,
  seller_gstin      text,
  seller_address    text,

  -- The GST state code (01–38, 97) of the SUPPLIER's registration. It is what
  -- decides CGST+SGST vs IGST, and it is stored explicitly rather than derived
  -- from the GSTIN every time so an operator can state it for a supplier whose
  -- GSTIN is absent (pre-registration) without the rule silently changing.
  seller_state_code text
    check (seller_state_code is null or seller_state_code ~ '^[0-9]{2}$'),

  -- The rate applied to a SaaS subscription. Configurable rather than hardcoded
  -- at 18 because a rate change is a government decision, not a deploy — but
  -- every issued invoice snapshots the rate it used, so changing this never
  -- alters an existing bill.
  gst_rate numeric(5,2) not null default 18.00 check (gst_rate >= 0 and gst_rate <= 100),

  -- Same 16-character GST ceiling as business_profiles.invoice_prefix (0020),
  -- and the same ≤4 rule, because the number format is the same:
  -- PREFIX/YYYY/NNNNNN.
  invoice_prefix     text not null default 'AOS'
    check (btrim(invoice_prefix) <> '' and length(invoice_prefix) <= 4),
  credit_note_prefix text not null default 'AOC'
    check (btrim(credit_note_prefix) <> '' and length(credit_note_prefix) <= 4),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists trg_platform_billing_settings_updated on public.platform_billing_settings;
create trigger trg_platform_billing_settings_updated
  before update on public.platform_billing_settings
  for each row execute function public.set_updated_at();

-- ── 2. platform-wide invoice numbering ──────────────────────────────────────
--
-- Deliberately the SAME SHAPE as public.sequences (0018) minus tenant_id:
-- (kind, period) → value, bumped by `insert … on conflict do update set
-- value = value + 1 returning value`. That statement is atomic in Postgres —
-- the second concurrent bumper blocks on the row lock and then sees the
-- incremented value — which is what makes two simultaneous renewals unable to
-- mint the same number, without an advisory lock or a retry loop.
--
-- `period` is the Indian financial year ('2026-27'), so numbering restarts on
-- 1 April exactly as GST expects, and the compacted year is part of the
-- formatted number so last year's #1 and this year's #1 are different strings.
create table if not exists public.platform_sequences (
  kind   text not null check (kind in ('invoice', 'credit_note')),
  period text not null,
  value  integer not null default 0 check (value >= 0),
  primary key (kind, period)
);

-- ── 3. the invoice ──────────────────────────────────────────────────────────
do $$ begin
  create type public.platform_invoice_kind as enum ('subscription', 'credit_note');
exception when duplicate_object then null; end $$;

-- `public.invoice_status` (0018) is REUSED rather than a parallel enum being
-- invented: 'draft' | 'issued' | 'paid' | 'void' describes a platform invoice
-- exactly as well as a POS one, and one status vocabulary is one thing to learn.
create table if not exists public.platform_invoices (
  id uuid primary key default gen_random_uuid(),

  -- WHO WAS BILLED. Cascade with the tenant: when a business is deleted its
  -- billing history goes with it, matching every other tenant-owned table.
  tenant_id uuid not null references public.tenants(id) on delete cascade,

  -- WHAT WAS BILLED FOR. RESTRICT, not cascade — a subscription or plan that
  -- an invoice references must not be deletable out from under it. 0078 already
  -- retires plans with active=false rather than deleting them for this reason.
  subscription_id uuid not null references public.tenant_subscriptions(id) on delete restrict,
  plan_id         uuid not null references public.plans(id) on delete restrict,

  kind public.platform_invoice_kind not null default 'subscription',

  -- ── the document ────────────────────────────────────────────────────────
  invoice_number text not null,
  invoice_date   date not null default current_date,
  -- The financial year the number was drawn from. Stored so a number can be
  -- traced back to its counter without re-deriving it from the date.
  period         text not null,

  -- ── the period covered ──────────────────────────────────────────────────
  -- Taken from Razorpay's own current_start/current_end on the subscription
  -- entity, which is what makes a redelivered webhook compute the same period
  -- rather than advancing one.
  billing_period_start timestamptz not null,
  billing_period_end   timestamptz not null,
  billing_period_type  public.billing_period not null,

  -- ── snapshots, so an old invoice never changes ──────────────────────────
  plan_name          text not null,
  -- The catalogue price for this plan and period at the moment of billing. Kept
  -- beside `subtotal` because they can legitimately differ: `subtotal` is what
  -- the gateway actually captured, and a divergence is exactly the thing an
  -- operator would want to see rather than have silently reconciled away.
  plan_price         numeric(10,2) not null check (plan_price >= 0),

  seller_legal_name  text not null,
  seller_gstin       text,
  seller_address     text,
  seller_state_code  text,

  buyer_legal_name   text not null,
  buyer_gstin        text,
  buyer_address      text,
  buyer_state_code   text,
  place_of_supply    text,

  -- ── the money ───────────────────────────────────────────────────────────
  -- GST-INCLUSIVE, as explained in the header: `subtotal` is the gross amount
  -- captured, `taxable_value` is what remains once the tax inside it is taken
  -- out, and `total` = taxable_value + tax_total = subtotal - adjustment.
  subtotal      numeric(10,2) not null check (subtotal >= 0),
  -- A proration credit applied to this bill, gross. Zero on an ordinary
  -- renewal. Never larger than subtotal, which is the constraint that makes a
  -- negative invoice unrepresentable rather than merely unlikely.
  adjustment    numeric(10,2) not null default 0 check (adjustment >= 0),
  taxable_value numeric(10,2) not null check (taxable_value >= 0),
  gst_rate      numeric(5,2)  not null check (gst_rate >= 0 and gst_rate <= 100),
  cgst          numeric(10,2) not null default 0 check (cgst >= 0),
  sgst          numeric(10,2) not null default 0 check (sgst >= 0),
  igst          numeric(10,2) not null default 0 check (igst >= 0),
  tax_total     numeric(10,2) not null default 0 check (tax_total >= 0),
  total         numeric(10,2) not null check (total >= 0),
  currency      text not null default 'INR' check (length(currency) = 3),

  status public.invoice_status not null default 'issued',

  -- ── reconciliation ──────────────────────────────────────────────────────
  -- 'razorpay' on the PLATFORM account. Named `gateway` to match
  -- tenant_subscriptions (0078) and payment_intents (0033).
  gateway                 text,
  gateway_payment_id      text,
  gateway_subscription_id text,
  -- Razorpay raises its own invoice for a subscription charge; its id is on the
  -- payment entity. Stored so a dispute can be answered from either side.
  gateway_invoice_id      text,
  -- The delivery that produced this row. webhook_events (0034) already records
  -- every delivery; this is the pointer back from the money to the message.
  gateway_event_id        text,

  -- A stored document, when one exists. NULL today: this project has no PDF
  -- generator (no such dependency in package.json) and introducing one for a
  -- single page would be disproportionate. The invoice is instead reproducible
  -- forever from the snapshot columns above and is rendered as a print-ready
  -- page, the same way lib/billing/receipt.ts serves the POS receipt. The
  -- column exists so a future generator — or a Razorpay short_url — has a home
  -- that does not require a migration.
  document_url text,

  -- Why an adjustment was applied, in words, for the printed document.
  notes text,

  created_at timestamptz not null default now(),

  -- ── the arithmetic, enforced by the database ────────────────────────────
  -- These are not decoration. They are the reason a rounding bug in application
  -- code becomes a failed INSERT instead of a wrong bill.
  constraint platform_invoices_period_order
    check (billing_period_end > billing_period_start),
  constraint platform_invoices_adjustment_within_subtotal
    check (adjustment <= subtotal),
  constraint platform_invoices_taxable_value
    check (taxable_value = subtotal - adjustment - tax_total),
  constraint platform_invoices_tax_total
    check (tax_total = cgst + sgst + igst),
  constraint platform_invoices_total
    check (total = taxable_value + tax_total),
  -- Intra-state XOR inter-state. A GST invoice carries CGST+SGST or IGST, never
  -- both; a row with all three at zero (a zero-rated or zero-value bill) is
  -- still legal.
  constraint platform_invoices_gst_kind
    check (igst = 0 or (cgst = 0 and sgst = 0)),
  -- A credit note is a document Arena OS issues, not money Razorpay captured.
  constraint platform_invoices_credit_note_unpaid
    check (kind <> 'credit_note' or gateway_payment_id is null),

  -- Numbering is platform-wide, not per tenant: Arena OS is the supplier, and
  -- one supplier may not issue the same invoice number to two customers.
  constraint platform_invoices_number_key unique (invoice_number)
);

-- ── THE MONEY IDEMPOTENCY RULE ──────────────────────────────────────────────
--
-- One Razorpay payment bills exactly once, enforced by Postgres rather than by
-- an application `if (!exists)` that two concurrent redeliveries would both
-- pass. This is the same device migration 0034 used for deposits
-- (idx_payment_intents_gateway_payment) and it is the one that must never be
-- relaxed: the event-id claim in webhook_events short-circuits a repeat
-- DELIVERY, but a single payment can legitimately arrive under several event
-- ids, and only this stops that becoming two invoices.
--
-- Partial because a credit note has no payment.
create unique index if not exists idx_platform_invoices_gateway_payment
  on public.platform_invoices (gateway, gateway_payment_id)
  where gateway_payment_id is not null;

-- "Show me my bills, newest first" — the tenant-facing list.
create index if not exists idx_platform_invoices_tenant
  on public.platform_invoices (tenant_id, invoice_date desc, created_at desc);

-- "What has this subscription been billed?" — the proration lookup, which needs
-- the most recent paid invoice for a subscription.
create index if not exists idx_platform_invoices_subscription
  on public.platform_invoices (subscription_id, created_at desc);

-- ============================================================================
-- RLS + grants
--
-- ── Reads: the OWNER only ───────────────────────────────────────────────────
--
-- Narrower than `invoices` (0018), which is readable by every member, and
-- deliberately so. A POS invoice is operational — a cashier has to be able to
-- pull one up. What the BUSINESS pays Arena OS is the proprietor's own
-- commercial information, of no use to a cashier or a kitchen hand, and this
-- codebase already draws that exact line: `business_profiles` reserves the
-- legal identity for owners (0020), /settings/business is owner-only, and
-- 0079's subscribe/cancel actions are behind requireOwner().
--
-- So the policy uses auth_role_in() = 'owner', the same helper 0020 uses.
--
-- ── Writes: not reachable from the app role at all ─────────────────────────
--
-- SELECT is the only grant. Invoices are raised by the webhook, which has no
-- session and runs on the owner connection — the narrow, documented exception
-- lib/payments/webhook.ts established and lib/platform/billing/webhook.ts
-- follows. A missing GRANT is a stronger guarantee than a policy that evaluates
-- to false: there is no write path for a tenant user to probe, and no way for a
-- business to mint itself an invoice or mark one paid.
--
-- ── platform_billing_settings / platform_sequences ─────────────────────────
--
-- No policies and no grants, exactly like platform_payment_settings (0079).
-- Both are platform-internal: the letterhead is snapshotted onto every invoice
-- at issue time, so no tenant ever needs to read the live row, and a counter is
-- nobody's business but the supplier's.
-- ============================================================================

alter table public.platform_invoices          enable row level security;
alter table public.platform_billing_settings  enable row level security;
alter table public.platform_sequences         enable row level security;

drop policy if exists platform_invoices_owner_select on public.platform_invoices;
create policy platform_invoices_owner_select on public.platform_invoices
  for select using (public.auth_role_in(tenant_id) = 'owner');

grant select on public.platform_invoices to arena_app;

-- platform_billing_settings and platform_sequences: no policies, no grants.
-- Stated as a comment rather than left implicit, because "there is nothing
-- here" IS the security property.

comment on table public.platform_invoices is
  'ARENA OS billing a BUSINESS for its subscription. Not public.invoices, which is a venue billing its own customers. Owner-read-only; written only by the platform Razorpay webhook on the owner connection.';

comment on table public.platform_sequences is
  'Platform-wide (supplier-side) invoice numbering. Same bump idiom as public.sequences, without tenant_id: GST numbering belongs to the supplier, and Arena OS is the supplier.';
