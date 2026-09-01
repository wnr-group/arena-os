-- ============================================================================
-- Arena OS — 0051 platform subscription billing (Razorpay Subscriptions)
--
-- M16 #1 (0050) built the MODEL: `plans`, `plan_entitlements`,
-- `tenant_subscriptions`. M16 #2 built ENFORCEMENT. This migration builds the
-- part 0050 explicitly deferred — "checkout, gateway subscription creation,
-- renewals, dunning" — on Razorpay Subscriptions.
--
-- ── THE TWO RAZORPAY ACCOUNTS ───────────────────────────────────────────────
--
-- This is the single most important thing in this file, so it is stated first:
--
--   payment_settings (0022/0034)          → the TENANT's OWN Razorpay account.
--     A venue's keys. Collects booking deposits and POS money FROM THAT VENUE'S
--     CUSTOMERS. Encrypted with the tenant id as AAD. Webhook:
--     /api/webhooks/razorpay, resolved per-tenant by subdomain.
--
--   platform_payment_settings (this file) → ARENA OS's OWN Razorpay account.
--     ONE row for the whole platform, authored by a platform admin. Charges the
--     BUSINESSES their Arena OS subscription. Encrypted with a fixed, non-uuid
--     AAD so a tenant ciphertext can never be replayed into it, or vice versa.
--     Webhook: /api/webhooks/platform-razorpay, with no tenant in the URL.
--
-- They must NEVER cross. A tenant's keys charging that tenant its own
-- subscription would mean the venue paying itself; the platform's keys
-- collecting a booking deposit would mean Arena OS taking a venue's customer
-- money. The separation is structural: different tables, different AAD,
-- different webhook route, different `gateway` discriminator value, and no
-- shared loader module.
--
-- ── WHAT THIS MIGRATION ADDS ────────────────────────────────────────────────
--   1. platform_payment_settings — the platform's own encrypted credentials.
--   2. plans.gateway_* — the Arena OS plan → Razorpay plan mapping, per period.
--   3. tenant_subscriptions.gateway_customer_id / cancel_at_period_end /
--      gateway_last_payment_id — what the lifecycle needs to stay idempotent.
--   4. webhook_events.subscription_id — so the existing delivery log can carry
--      a subscription reference instead of pretending it is an order id.
--
-- It adds NO new enum values. The lifecycle the ticket names —
-- trial → active → past_due → suspended → cancelled — is already fully
-- expressible across the two enums this schema has, and the mapping is
-- documented in lib/platform/billing/lifecycle.ts:
--
--   tenant_subscription_status  trialing|active|past_due|cancelled|expired (0050)
--   tenant_status               trial|active|suspended|cancelled           (0001)
--
-- "suspended" is a TENANT state, not a subscription state: the subscription is
-- `expired` (Razorpay halted it after exhausting its retries) and the ACCOUNT
-- is `suspended`. Inventing a fifth subscription status for it would have split
-- one fact across two columns that could then disagree.
-- ============================================================================

-- ── 1. the PLATFORM's own gateway credentials ───────────────────────────────
--
-- A singleton. Not `tenant_id`-keyed like payment_settings (0022) — there is no
-- tenant here; Arena OS is the merchant. The `id boolean` + CHECK is the
-- standard one-row idiom: the primary key admits exactly one value, so a second
-- row is a 23505 rather than a silent ambiguity about which config is live.
create table if not exists public.platform_payment_settings (
  id boolean primary key default true check (id),

  -- Publishable. Razorpay's hosted subscription page is opened with the
  -- subscription's own short_url, so this is not strictly needed in a browser;
  -- it is stored and shown so an operator can see WHICH account is configured
  -- (rzp_test_… vs rzp_live_…) without decrypting anything.
  razorpay_key_id text
    check (razorpay_key_id is null or btrim(razorpay_key_id) <> ''),

  -- AES-256-GCM ciphertext from lib/security/encryption.ts under the master key
  -- in PAYMENT_SETTINGS_ENCRYPTION_KEY, sealed with AAD 'platform:razorpay'.
  -- Same storage contract and same CHECK as payment_settings: a plaintext
  -- secret physically cannot be written into these columns.
  razorpay_key_secret_encrypted text
    check (razorpay_key_secret_encrypted is null
           or razorpay_key_secret_encrypted ~ '^v[0-9]+:[^:]+:[^:]+:[^:]+$'),

  -- The WEBHOOK signing secret. A different Razorpay credential from the key
  -- secret, with its own rotation — exactly the distinction 0034 drew for the
  -- tenant side, restated because it is just as easy to get wrong here.
  razorpay_webhook_secret_encrypted text
    check (razorpay_webhook_secret_encrypted is null
           or razorpay_webhook_secret_encrypted ~ '^v[0-9]+:[^:]+:[^:]+:[^:]+$'),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists trg_platform_payment_settings_updated on public.platform_payment_settings;
create trigger trg_platform_payment_settings_updated
  before update on public.platform_payment_settings
  for each row execute function public.set_updated_at();

-- ── 2. Arena OS plan → Razorpay Subscription plan ───────────────────────────
--
-- Razorpay models a recurring price as a PLAN object (`plan_…`) that already
-- carries its own amount, currency and period. So one Arena OS plan maps to TWO
-- Razorpay plans — one billed monthly, one billed yearly — because
-- plans.monthly_price and plans.annual_price are two different prices.
--
-- Storing both explicitly, rather than deriving one from the other, is what
-- makes "accidentally charged annually" impossible: subscribe.ts picks the
-- column matching the requested billing_period and refuses outright when it is
-- null. There is deliberately no fallback to the other column.
--
-- `gateway` names which provider these ids belong to, matching the column 0050
-- already added to tenant_subscriptions and payment_intents' convention (0033).
alter table public.plans
  add column if not exists gateway text,
  add column if not exists gateway_monthly_plan_id text,
  add column if not exists gateway_annual_plan_id text;

do $$ begin
  alter table public.plans
    add constraint plans_gateway_refs_nonblank
    check (
      (gateway is null or btrim(gateway) <> '')
      and (gateway_monthly_plan_id is null or btrim(gateway_monthly_plan_id) <> '')
      and (gateway_annual_plan_id  is null or btrim(gateway_annual_plan_id)  <> '')
    );
exception when duplicate_object then null; end $$;

-- An id with no gateway is unusable and an invitation to guess. Either the
-- mapping names its provider or it is absent entirely.
do $$ begin
  alter table public.plans
    add constraint plans_gateway_ids_need_gateway
    check (
      gateway is not null
      or (gateway_monthly_plan_id is null and gateway_annual_plan_id is null)
    );
exception when duplicate_object then null; end $$;

-- The monthly and annual ids must differ. They are different PRICES; the same
-- id in both columns means one of the two periods silently charges the other's
-- amount — precisely the "wrong billing period" failure to prevent.
do $$ begin
  alter table public.plans
    add constraint plans_gateway_ids_distinct
    check (
      gateway_monthly_plan_id is null
      or gateway_annual_plan_id is null
      or gateway_monthly_plan_id <> gateway_annual_plan_id
    );
exception when duplicate_object then null; end $$;

-- …and no Razorpay plan may back two Arena OS plans. If it did, a
-- `subscription.charged` webhook could not say which plan was paid for.
--
-- Two partial unique indexes, one per column. Honest about what this does and
-- does not guarantee: it makes a duplicate WITHIN a column impossible in the
-- database, which is the collision an operator actually makes (pasting the same
-- monthly id onto two plans). A cross-column collision — plan A's monthly id
-- equal to plan B's annual id — is not expressible as a plain unique index over
-- two columns of the same row, so it is caught by setPlanGateway() in
-- lib/actions/plans.ts, which checks BOTH columns of every other plan before
-- writing. Stated here so nobody reads these indexes as more than they are.
create unique index if not exists idx_plans_gateway_monthly
  on public.plans (gateway, gateway_monthly_plan_id)
  where gateway_monthly_plan_id is not null;

create unique index if not exists idx_plans_gateway_annual
  on public.plans (gateway, gateway_annual_plan_id)
  where gateway_annual_plan_id is not null;

-- ── 3. what the lifecycle needs on the subscription row ─────────────────────
--
-- `gateway` and `gateway_subscription_id` already exist (0050) and are REUSED
-- unchanged, together with idx_tenant_subscriptions_gateway_ref — the partial
-- unique index that guarantees a webhook resolves to at most one row. Only the
-- genuinely missing fields are added.
alter table public.tenant_subscriptions
  -- Razorpay's customer object (`cust_…`) for this tenant. Kept so a second
  -- subscription (an upgrade, or a retry after a failed authorisation) reuses
  -- the same customer instead of creating duplicates on the Razorpay account.
  add column if not exists gateway_customer_id text,

  -- A cancellation REQUESTED but not yet effective. Razorpay's
  -- cancel_at_cycle_end=1 leaves the subscription active until the paid-for
  -- period ends, and only then fires subscription.cancelled.
  --
  -- A separate column rather than an early `cancelled_at` write, because
  -- tenant_subscriptions_cancelled_at (0050) CHECKs that cancelled_at is set if
  -- and only if status = 'cancelled'. A pending cancellation is not a
  -- cancellation, and the webhook stays the source of truth for the final
  -- provider state.
  add column if not exists cancel_at_period_end boolean not null default false,

  -- The last Razorpay payment applied to this subscription. Reconciliation and
  -- a cheap replay check; NOT a ledger. Nothing in this schema sums platform
  -- payments, which is the structural reason a redelivered subscription.charged
  -- cannot double-count money — see lib/platform/billing/lifecycle.ts.
  add column if not exists gateway_last_payment_id text;

do $$ begin
  alter table public.tenant_subscriptions
    add constraint tenant_subscriptions_gateway_refs_nonblank
    check (
      (gateway_customer_id is null or btrim(gateway_customer_id) <> '')
      and (gateway_last_payment_id is null or btrim(gateway_last_payment_id) <> '')
    );
exception when duplicate_object then null; end $$;

-- "Which subscription is this Razorpay customer's?" — for the reuse lookup at
-- creation time, which runs before any subscription object exists.
create index if not exists idx_tenant_subscriptions_gateway_customer
  on public.tenant_subscriptions (gateway, gateway_customer_id)
  where gateway_customer_id is not null;

-- ── 4. the delivery log carries a subscription reference ────────────────────
--
-- webhook_events (0034) is REUSED rather than duplicated: same table, same
-- unique (gateway, event_id) claim, same outcome vocabulary. The platform
-- stream is distinguished by gateway = 'platform_razorpay', so an operator can
-- tell the two accounts' deliveries apart and a tenant event id can never
-- collide with a platform one.
--
-- `order_id` is left alone — a subscription is not an order, and overloading
-- that column would make the log lie. `payment_id` IS reused, because a
-- subscription charge really is a Razorpay payment.
alter table public.webhook_events
  add column if not exists subscription_id text;

create index if not exists idx_webhook_events_subscription
  on public.webhook_events (gateway, subscription_id)
  where subscription_id is not null;

-- ── RLS + grants ────────────────────────────────────────────────────────────
--
-- platform_payment_settings is the strictest table in this schema and gets the
-- strictest treatment available: RLS enabled, NO POLICIES AT ALL, and NO GRANT
-- of any kind to arena_app.
--
-- That is deliberately belt AND braces. The missing grant alone means every
-- statement a tenant request could possibly issue against this table — select,
-- insert, update, delete — fails with 42501 before RLS is even consulted. The
-- enabled-with-no-policies RLS then means that even if some future migration
-- added a grant by mistake, the default-deny still applies. There is no
-- SECURITY DEFINER accessor either: unlike payment_key_id() (0022), no
-- tenant-facing surface has any legitimate need for one byte of this row.
--
-- The only reader is lib/platform/billing/credentials.ts on the owner
-- connection — after requirePlatformAdmin() for the admin surface, or with no
-- session at all for the webhook, exactly as lib/settings/razorpay-webhook-
-- secret.ts already does on the tenant side.
alter table public.platform_payment_settings enable row level security;

-- No policies, and no grants. Stated as a comment rather than left implicit,
-- because "there is nothing here" IS the security property.

-- ── tenants.status becomes unwritable by the app role ───────────────────────
--
-- 0002 granted arena_app `update` on ALL of public.tenants and added
-- `tenants_owner_update`, a policy letting a tenant OWNER update its own row.
-- At the time that was harmless: `status` was operator bookkeeping that nothing
-- in the app read for a decision, and the policy existed so an owner could edit
-- descriptive fields.
--
-- This migration changes what that column MEANS. tenants.status is now the
-- output of the subscription lifecycle: it is what suspension writes when a
-- business stops paying, and what public_tenant_by_slug() (0022) reads to
-- decide whether a venue's public site resolves. Leaving it owner-writable
-- would mean a suspended business could un-suspend itself with a single update
-- — the whole dunning path defeated by the party it applies to.
--
-- Postgres cannot express "this policy may not touch that column", but it does
-- not need to: COLUMN-LEVEL UPDATE grants say it directly. The blanket UPDATE
-- is revoked and re-granted on exactly the descriptive columns, so
-- `tenants_owner_update` keeps working for what it was for while an UPDATE that
-- so much as mentions `status` fails with 42501 — before RLS is consulted, and
-- regardless of what any future policy says.
--
-- `slug` is deliberately NOT re-granted either. It is the tenant's subdomain,
-- the thing every webhook URL and public link is built from; changing it is an
-- operator action, not a self-service one.
--
-- Nothing in the application loses a capability: the only writes to `tenants`
-- anywhere are setCompanyStatus() and updateCompany() in lib/actions/platform.ts,
-- both of which run on the OWNER connection after requirePlatformAdmin() and are
-- unaffected by a grant to arena_app.
revoke update on public.tenants from arena_app;
grant update (name, industry, currency, timezone) on public.tenants to arena_app;

-- plans / tenant_subscriptions keep the policies and grants 0050 gave them:
-- SELECT-only to arena_app, writes only through the owner connection after
-- requirePlatformAdmin(). The new columns therefore inherit exactly that, and
-- the subscribe/cancel actions in lib/actions/subscription.ts write through
-- the owner connection after resolving the tenant from the session — they
-- never widen arena_app's grants.
--
-- One consequence worth naming: plans.gateway_monthly_plan_id IS readable by a
-- tenant, because plans_select_active exposes the whole live catalogue row.
-- That is fine — a Razorpay plan id is a public reference that appears in the
-- checkout page Razorpay serves to the payer, not a credential. Every SECRET
-- lives in platform_payment_settings, which no tenant can touch at all.

comment on table public.platform_payment_settings is
  'Singleton. ARENA OS''s own Razorpay account, used to charge tenants for their Arena OS subscription. NEVER a tenant''s BYO gateway (see payment_settings). No grants to arena_app, by design.';
