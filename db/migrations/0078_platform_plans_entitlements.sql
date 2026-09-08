-- ============================================================================
-- Arena OS — 0078 platform plans, entitlements & tenant subscriptions (M16)
--
-- The FIRST tables that belong to the PLATFORM rather than to a tenant. Every
-- other table in this schema carries a tenant_id and is scoped by RLS to the
-- tenant that owns the row. `plans` and `plan_entitlements` deliberately do
-- NOT: there is one catalogue for the whole platform, authored by the operator.
--
-- ── The two money flows, kept apart ─────────────────────────────────────────
--
-- There are now two, and confusing them would be expensive:
--
--   1. tenant → its customers   (already built) — a venue collects booking and
--      POS money through ITS OWN Razorpay keys (payment_settings, 0032).
--      Recorded in `invoices` (0018) and aggregated by mv_daily_revenue (0043).
--
--   2. Arena OS → the tenants   (this migration) — the platform charges the
--      businesses a subscription. Nothing here touches `invoices`, so a
--      tenant's own revenue reports can never be inflated by the fee it pays
--      us, and no tenant's gateway keys are ever used to collect it.
--
-- ── Naming, because three neighbouring words are already taken ──────────────
--
--   public.memberships          — STAFF: a user's seat in a tenant (0001)
--   public.membership_plans     — a VENUE's customer-facing product catalogue
--                                 ("Gold", "Silver") (0031)
--   public.customer_memberships — a CUSTOMER's purchase of one of those (0036)
--
-- So `plans` here means PLATFORM plans (Starter/Pro/Enterprise) — what a
-- business pays Arena OS. It is the only unprefixed `plans` table and the only
-- one with no tenant_id, which is how to tell them apart at a glance.
--
-- ── Scope: model only ───────────────────────────────────────────────────────
-- This migration establishes the schema and the read paths. It deliberately
-- does NOT add: checkout, gateway subscription creation, renewals, dunning,
-- upgrade/downgrade, or ANY entitlement enforcement. Enforcement is the next
-- story; nothing in the app reads these tables to block anything yet.
-- ============================================================================

-- ── 1. the platform plan catalogue ──────────────────────────────────────────
create table if not exists public.plans (
  id            uuid primary key default gen_random_uuid(),
  name          text not null check (length(btrim(name)) > 0),

  -- Rupees at numeric(10,2) — the project's money rule everywhere (0003
  -- booking totals, 0018 invoices, 0031 membership_plans). A free tier is 0,
  -- not null, so every plan has a comparable price.
  monthly_price numeric(10,2) not null default 0 check (monthly_price >= 0),
  annual_price  numeric(10,2) not null default 0 check (annual_price  >= 0),

  -- One currency for the whole platform catalogue: unlike a tenant's own
  -- prices, these are what WE charge, so they are not per-tenant. Shaped like
  -- payment_intents.currency (0033).
  currency      text not null default 'INR' check (length(currency) = 3),

  -- Retired rather than deleted: a subscription references its plan for the
  -- life of the account, so a plan is never removed once anyone is on it.
  active        boolean not null default true,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Case-insensitively unique across the WHOLE catalogue, not just live plans.
--
-- Deliberately different from membership_plans' partial `where is_active`
-- index (0031). That table is per-tenant and its plans are marketing products
-- a venue relaunches under the same name. This one is the operator's own price
-- list of three or four rows that subscriptions and (later) invoices point at
-- for years — two plans ever named "Pro" would make a billing dispute
-- unanswerable. It is also what makes the seed idempotent on name.
create unique index if not exists idx_plans_name
  on public.plans (lower(btrim(name)));

-- The catalogue read: "what can a tenant subscribe to right now?"
create index if not exists idx_plans_active on public.plans (active);

drop trigger if exists trg_plans_updated on public.plans;
create trigger trg_plans_updated before update on public.plans
  for each row execute function public.set_updated_at();

-- ── 2. entitlements, as DATA ────────────────────────────────────────────────
-- A key/value row per plan rather than columns, and deliberately so: adding
-- "module.events" or "max_kots_per_day" must be an INSERT the operator can
-- make, not a migration plus a deploy. Nothing in application logic may switch
-- on a specific key — the reader returns whatever rows exist.
--
-- `value` is jsonb because entitlements are genuinely mixed-typed: a limit is a
-- number (max_branches: 3), a module flag is a boolean (module.payroll: true),
-- and "unlimited" is naturally null. Storing that as text would push parsing —
-- and a parsing bug — into every future call site. The check keeps it to
-- SCALARS so the reader's contract stays "number | boolean | string | null"
-- and no caller has to defend against a nested object arriving.
create table if not exists public.plan_entitlements (
  id         uuid primary key default gen_random_uuid(),
  plan_id    uuid not null references public.plans(id) on delete cascade,

  -- Dotted lowercase snake segments: `max_branches`, `module.payroll`.
  -- Shape-checked so a typo ("Max Branches") fails loudly at write time rather
  -- than silently becoming a key nothing ever reads.
  key        text not null check (key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$'),

  value      jsonb not null
             check (jsonb_typeof(value) in ('number', 'boolean', 'string', 'null')),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- One value per key per plan. This is what lets the reader collapse the rows
  -- into a plain object without deciding which duplicate wins.
  constraint plan_entitlements_plan_key_key unique (plan_id, key)
);

drop trigger if exists trg_plan_entitlements_updated on public.plan_entitlements;
create trigger trg_plan_entitlements_updated before update on public.plan_entitlements
  for each row execute function public.set_updated_at();

-- ── 3. which plan a tenant is on ────────────────────────────────────────────
do $$ begin
  create type public.billing_period as enum ('monthly','annual');
exception when duplicate_object then null; end $$;

-- Distinct from public.tenant_status (0001), which is the ACCOUNT's state as
-- the operator sees it (trial/active/suspended/cancelled). This is the
-- SUBSCRIPTION's own state. They move independently: a subscription can go
-- past_due while the tenant is still 'active', and the decision to suspend is
-- a separate, deliberate act (the dunning story).
do $$ begin
  create type public.tenant_subscription_status as enum
    ('trialing','active','past_due','cancelled','expired');
exception when duplicate_object then null; end $$;

create table if not exists public.tenant_subscriptions (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references public.tenants(id) on delete cascade,

  -- RESTRICT, not cascade: deleting a plan someone is paying for must fail
  -- loudly. Plans are retired with active = false instead.
  plan_id              uuid not null references public.plans(id) on delete restrict,

  billing_period       public.billing_period not null default 'monthly',
  status               public.tenant_subscription_status not null default 'trialing',

  current_period_start timestamptz not null default now(),
  current_period_end   timestamptz not null,
  cancelled_at         timestamptz,

  -- ── gateway reference ─────────────────────────────────────────────────────
  -- Nullable, and unused for now. A plan assigned by a platform admin has no
  -- gateway object at all, and the billing story will fill these in for
  -- self-serve subscriptions. Named `gateway` (not `razorpay`) to match
  -- payment_intents (0033), which already anticipates a second provider — the
  -- platform's own account will NOT be a tenant's BYO Razorpay.
  gateway              text check (gateway is null or btrim(gateway) <> ''),
  gateway_subscription_id text
                       check (gateway_subscription_id is null
                              or btrim(gateway_subscription_id) <> ''),

  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  constraint tenant_subscriptions_period check (current_period_end > current_period_start),
  -- A cancelled subscription must say when, and a live one must not.
  constraint tenant_subscriptions_cancelled_at
    check ((status = 'cancelled') = (cancelled_at is not null))
);

-- AT MOST ONE LIVE SUBSCRIPTION PER TENANT.
--
-- The same device customer_memberships uses (idx_customer_memberships_one_active,
-- 0036): a surrogate id plus a partial unique index, rather than making
-- tenant_id the primary key the way single-row config tables do
-- (business_profiles 0020, payment_settings 0032, loyalty_settings 0039).
--
-- The difference is history. A subscription is not configuration — it renews,
-- upgrades and lapses, and "what were they on last March?" is a question a
-- billing dispute actually asks. tenant_id-as-PK would answer it by destroying
-- the previous row. So old rows stay, and this index is what guarantees the
-- reader below can never find two live ones to choose between.
create unique index if not exists idx_tenant_subscriptions_one_live
  on public.tenant_subscriptions (tenant_id)
  where status in ('trialing','active','past_due');

-- The history read, newest first.
create index if not exists idx_tenant_subscriptions_tenant
  on public.tenant_subscriptions (tenant_id, current_period_start desc);

-- "Who is on Pro?" — also makes the plan FK check cheap.
create index if not exists idx_tenant_subscriptions_plan
  on public.tenant_subscriptions (plan_id);

-- The renewal/expiry sweep the billing story will run.
create index if not exists idx_tenant_subscriptions_period_end
  on public.tenant_subscriptions (status, current_period_end);

-- One subscription per gateway object, when there is one. Partial because the
-- column is null for admin-assigned plans — the same shape as
-- idx_webhook_events_event (0034).
create unique index if not exists idx_tenant_subscriptions_gateway_ref
  on public.tenant_subscriptions (gateway, gateway_subscription_id)
  where gateway_subscription_id is not null;

drop trigger if exists trg_tenant_subscriptions_updated on public.tenant_subscriptions;
create trigger trg_tenant_subscriptions_updated before update on public.tenant_subscriptions
  for each row execute function public.set_updated_at();

-- ============================================================================
-- RLS + grants
--
-- These are PLATFORM tables, so the usual tenant template does not apply and
-- is not copied. Two rules shape everything below:
--
--   WRITES ARE NOT REACHABLE FROM THE APP ROLE AT ALL. arena_app is granted
--   SELECT and nothing else on all three tables. Platform administration goes
--   through the owner connection after requirePlatformAdmin() — the pattern
--   lib/actions/platform.ts already uses for tenants, branches and memberships
--   — and the owner role bypasses RLS. A missing GRANT is a stronger guarantee
--   than a policy that merely evaluates to false: there is no policy to get
--   wrong, and no write path for a tenant user to probe.
--
--   READS ARE SCOPED BY THE EXISTING HELPER. auth_tenant_ids() (0002) is the
--   same function every tenant table's SELECT policy uses, so a subscription is
--   visible exactly to the active members of the tenant that owns it.
-- ============================================================================

alter table public.plans             enable row level security;
alter table public.plan_entitlements enable row level security;
alter table public.tenant_subscriptions enable row level security;

-- ── plans ───────────────────────────────────────────────────────────────────
-- The live catalogue is not secret — it is a price list, and the billing
-- portal has to show what a tenant could move to.
drop policy if exists plans_select_active on public.plans;
create policy plans_select_active on public.plans
  for select using (active);

-- …and a tenant must still be able to read the plan it is actually ON, even
-- after that plan is retired. Without this, grandfathering a customer onto an
-- old plan would make their own entitlements unreadable to them.
--
-- The subquery is itself subject to tenant_subscriptions' policy below, which
-- references only auth_tenant_ids() and never comes back to `plans` — so this
-- pair cannot recurse.
drop policy if exists plans_select_subscribed on public.plans;
create policy plans_select_subscribed on public.plans
  for select using (
    exists (
      select 1 from public.tenant_subscriptions s
       where s.plan_id = plans.id
         and s.tenant_id in (select public.auth_tenant_ids())
    )
  );

-- ── plan_entitlements ───────────────────────────────────────────────────────
-- Visible exactly when its plan is. Expressed by reference rather than by
-- repeating the rule, so the two can never drift: the subquery runs under
-- `plans`' own policies, whatever those become.
drop policy if exists plan_entitlements_select on public.plan_entitlements;
create policy plan_entitlements_select on public.plan_entitlements
  for select using (
    exists (select 1 from public.plans p where p.id = plan_entitlements.plan_id)
  );

-- ── tenant_subscriptions ────────────────────────────────────────────────────
-- A tenant's own row, to its own active members. There is deliberately NO
-- write policy: nothing in the current authorization model lets a business
-- change its own subscription, and the absent GRANT means it could not even if
-- a policy existed.
drop policy if exists tenant_subscriptions_select on public.tenant_subscriptions;
create policy tenant_subscriptions_select on public.tenant_subscriptions
  for select using (tenant_id in (select public.auth_tenant_ids()));

-- ── grants ──────────────────────────────────────────────────────────────────
-- SELECT only. No insert/update/delete to arena_app on any of the three.
grant select on public.plans               to arena_app;
grant select on public.plan_entitlements   to arena_app;
grant select on public.tenant_subscriptions to arena_app;
