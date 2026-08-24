-- ============================================================================
-- Arena OS — 0026 customer_memberships: a plan a customer has actually bought
--
-- The purchase side of AROS-59's catalogue. `membership_plans` is what the
-- venue SELLS; this is what a customer HOLDS.
--
-- ── The eligibility invariant ───────────────────────────────────────────────
-- A membership confers benefits only when
--
--     status = 'active'  AND  now() < expires_at  AND  same tenant throughout
--
-- Both halves matter. `status` alone is not enough, because nothing sweeps the
-- table on a timer — a lapsed row sits at 'active' until something touches it.
-- Every read path in lib/memberships/customer-memberships.ts therefore tests
-- the clock as well as the column, so correctness never depends on a cron job
-- having run. The sweep is housekeeping, not the source of truth.
--
-- ── Why the benefits are copied, not referenced ─────────────────────────────
-- Every benefit column below is a SNAPSHOT taken at purchase. A manager who
-- reprices Gold from ₹2000 to ₹2500, or drops its discount from 10% to 5%,
-- changes what the NEXT customer buys — never what an existing member already
-- paid for. `plan_id` is kept for provenance ("which plan was this?"), but no
-- benefit is ever read through it.
-- ============================================================================

do $$ begin
  create type public.customer_membership_status as enum ('active','expired','cancelled');
exception when duplicate_object then null; end $$;

create table if not exists public.customer_memberships (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants(id) on delete cascade,
  customer_id      uuid not null,
  plan_id          uuid not null,

  -- ── snapshot of the plan at the moment of purchase ────────────────────────
  -- Mirrors membership_plans exactly (0021), including precision, so a value
  -- copied across cannot be silently rounded.
  plan_name        text not null check (length(btrim(plan_name)) > 0),
  price_paid       numeric(10,2) not null check (price_paid >= 0),
  duration_months  integer not null check (duration_months > 0),
  discount_percent numeric(5,2) not null default 0
                     check (discount_percent >= 0 and discount_percent <= 100),
  free_hours       numeric(10,2) not null default 0 check (free_hours >= 0),
  wallet_credit    numeric(10,2) not null default 0 check (wallet_credit >= 0),

  -- Consumption of the free-hours benefit. Lives here rather than arriving with
  -- AROS-61, because a benefit that cannot be drawn down is not usable and
  -- adding the column later would mean migrating live memberships.
  free_hours_used  numeric(10,2) not null default 0 check (free_hours_used >= 0),

  -- ── lifecycle ─────────────────────────────────────────────────────────────
  status           public.customer_membership_status not null default 'active',
  starts_at        timestamptz not null default now(),
  expires_at       timestamptz not null,
  cancelled_at     timestamptz,

  -- ── money ─────────────────────────────────────────────────────────────────
  -- Nullable and unconstrained for now: a membership purchase does not raise a
  -- GST invoice yet. `invoice_items.kind` already admits 'membership' (0014)
  -- and `invoices.booking_id` is nullable, so the billing ticket that adds a
  -- non-booking invoice path can attach it here without a migration.
  invoice_id       uuid,
  sold_by          uuid references public.memberships(id) on delete set null,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  constraint customer_memberships_period check (expires_at > starts_at),
  -- Cannot consume more free hours than were bought.
  constraint customer_memberships_free_hours_drawdown
    check (free_hours_used <= free_hours),
  -- A cancelled membership must say when; anything else must not.
  constraint customer_memberships_cancelled_at
    check ((status = 'cancelled') = (cancelled_at is not null)),

  -- Composite FKs — the device 0008/0010/0017/0023 use — so a membership can
  -- never point at ANOTHER tenant's customer or plan. FKs ignore RLS, so the
  -- tenant column inside the key is what makes cross-tenant linkage impossible.
  constraint customer_memberships_customer_tenant_fkey
    foreign key (tenant_id, customer_id)
    references public.customers(tenant_id, id) on delete cascade,
  -- No cascade on the plan: plans are retired, never deleted, and this FK is
  -- what makes deleting one that has been sold fail loudly instead of orphaning
  -- a member's provenance.
  constraint customer_memberships_plan_tenant_fkey
    foreign key (tenant_id, plan_id)
    references public.membership_plans(tenant_id, id),

  constraint customer_memberships_tenant_id_key unique (tenant_id, id)
);

-- THE lifecycle rule: at most ONE active membership per customer.
--
-- Without it "what discount does this customer get?" has no single answer, and
-- AROS-61 would have to invent a tie-break. Partial on `status`, because a
-- customer accumulates expired and cancelled memberships over years of renewals
-- and those must not block the next purchase. Renewal works by expiring the old
-- row and inserting the new one in one transaction; this index is what makes
-- two tills selling simultaneously safe.
create unique index if not exists idx_customer_memberships_one_active
  on public.customer_memberships(tenant_id, customer_id)
  where status = 'active';

-- The profile read: this customer's memberships, newest first.
create index if not exists idx_customer_memberships_customer
  on public.customer_memberships(tenant_id, customer_id, starts_at desc);

-- The expiry sweep, and "who is a member right now?".
create index if not exists idx_customer_memberships_expiry
  on public.customer_memberships(tenant_id, status, expires_at);

-- Provenance lookups: "who bought Gold?" Also makes the plan FK check cheap.
create index if not exists idx_customer_memberships_plan
  on public.customer_memberships(tenant_id, plan_id);

drop trigger if exists trg_customer_memberships_updated on public.customer_memberships;
create trigger trg_customer_memberships_updated before update on public.customer_memberships
  for each row execute function public.set_updated_at();

-- ── RLS + grants ─────────────────────────────────────────────────────────────
-- Follows `customers_rw` (0007) rather than the manager-only settings template:
-- a membership is OPERATIONAL data. The front desk sells one and the till needs
-- to read one to price a bill, so any active member of the tenant may do both.
-- Selling is further restricted to cashier-and-up by canBill() in the server
-- action — the same role rule that governs taking any other payment.
alter table public.customer_memberships enable row level security;

drop policy if exists customer_memberships_rw on public.customer_memberships;
create policy customer_memberships_rw on public.customer_memberships
  for all using (tenant_id in (select public.auth_tenant_ids()))
          with check (tenant_id in (select public.auth_tenant_ids()));

-- No DELETE: a membership is cancelled or allowed to expire, never removed —
-- the customer paid for it and the record is financial history.
grant select, insert, update on public.customer_memberships to arena_app;
