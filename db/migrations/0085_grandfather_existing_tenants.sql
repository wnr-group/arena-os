-- ============================================================================
-- Arena OS — 0085 grandfather existing tenants onto a plan (M16 deploy safety)
--
-- NOT a feature. This migration exists so that deploying M16 does not take
-- working features away from businesses that already have them.
--
-- ── THE REGRESSION THIS PREVENTS ────────────────────────────────────────────
--
-- M16 #2 added entitlement gates to features that shipped LONG BEFORE plans
-- existed, and those gates are deliberately fail-closed:
--
--     lib/actions/payroll.ts     requireEntitlement('module.payroll')
--     lib/actions/expenses.ts    requireEntitlement('module.expenses')
--     lib/reports/*.ts           requireEntitlement('module.reports')
--     lib/actions/resources.ts   checkLimitIn('max_resources')
--     lib/actions/team.ts        checkLimitIn('max_staff')
--
-- readEntitlements() (lib/platform/entitlements.ts) returns NO_SUBSCRIPTION —
-- `plan: null`, `entitlements: {}` — for a tenant with no live
-- `tenant_subscriptions` row, and entitlement-guard.ts grants a module ONLY on
-- an explicit `true` and a limit ONLY on an explicit number or null. So a
-- tenant with no subscription is refused every one of the above.
--
-- Every tenant that existed before M16 is exactly that tenant. Migrations
-- 0078–0084 create the tables, the catalogue and the billing machinery, and
-- none of them writes a `tenant_subscriptions` row for a tenant that already
-- exists; the three code paths that insert one (self-serve signup, gateway
-- checkout, admin assignPlan) all require somebody to act first. Without this
-- file the deploy silently switches off payroll, expenses and every report for
-- existing customers, and caps their staff and resources, until an operator
-- hand-assigns a plan to each one.
--
-- ── WHY A MIGRATION AND NOT A RUNBOOK STEP ──────────────────────────────────
--
-- A runbook step is a thing a human can skip, and skipping it is invisible: the
-- app does not fail to start, it just starts refusing. Making it a migration
-- makes it part of the deploy by construction — the same discipline as every
-- other schema change, applied exactly once, in order, before the new code
-- serves a request.
--
-- ── THE PLAN THIS ASSIGNS ───────────────────────────────────────────────────
--
-- A dedicated `Grandfathered` plan, NOT one of the seed tiers, and `active =
-- false`. Three reasons, all of which the codebase already anticipates:
--
--   1. It must never be OFFERED. `active = false` keeps it out of the public
--      signup picker (`plans_select_active`, lib/platform/plans/public.ts) and
--      out of the owner billing portal's upgrade list, which filters on
--      `p.active` under the comment "a retired plan the tenant is grandfathered
--      onto stays readable but must never be offered" (billing/portal.ts).
--   2. It must still GRANT. readEntitlements() deliberately does not filter on
--      `plans.active` — "grandfathering is the normal reason to retire a plan
--      rather than delete it" — and RLS policy `plans_select_subscribed` (0078)
--      exists precisely so a subscriber can still read a retired plan.
--   3. It must not be mistaken for a commercial tier. Pricing it at 0 and
--      naming it for what it is keeps `Pro` meaning "somebody chose and pays
--      for Pro", which is what the revenue metrics in 0080/0082 count.
--
-- Its entitlements grant what these tenants ALREADY HAD before M16: the three
-- modules, and unlimited limits. Unlimited (`null`, not a large number) is the
-- only correct choice — a pre-M16 tenant may already hold more staff or
-- resources than any finite tier allows, so any number would be either a cap
-- they are already over or a fiction.
--
-- `module.events` is granted as false, matching the seed catalogue: M15 does
-- not exist, and grandfathering means keeping what a business had, not gifting
-- what it never did.
-- ============================================================================

-- ── 1. the plan ─────────────────────────────────────────────────────────────
--
-- Idempotent on the unique lower(btrim(name)) index from 0078. `do update` on
-- `active` rather than `do nothing`, so a plan an operator accidentally
-- re-activated is put back: this row must never become offerable.
insert into public.plans (name, monthly_price, annual_price, currency, active)
values ('Grandfathered', 0, 0, 'INR', false)
on conflict (lower(btrim(name)))
  do update set active = false;

-- ── 2. its entitlements ─────────────────────────────────────────────────────
--
-- Written as literal rows rather than copied from an existing tier: this set is
-- a statement about what pre-M16 tenants had, and it must not drift when an
-- operator reprices or re-scopes Pro. Idempotent on (plan_id, key).
--
-- The values are jsonb scalars, which is what the `jsonb_typeof(value) in
-- ('number','boolean','string','null')` check in 0078 requires. Note
-- 'null'::jsonb — a JSON null, meaning UNLIMITED — and NOT SQL NULL, which the
-- not-null column would reject. The two are different things and the difference
-- is the whole limit contract: a JSON null is "no ceiling", while a MISSING key
-- is denied outright (decideLimit(), entitlement-guard.ts).
insert into public.plan_entitlements (plan_id, key, value)
select p.id, t.k, t.v::jsonb
  from public.plans p
 cross join (values
        ('max_branches',    'null'),
        ('max_staff',       'null'),
        ('max_resources',   'null'),
        ('module.payroll',  'true'),
        ('module.expenses', 'true'),
        ('module.reports',  'true'),
        ('module.events',   'false')
      ) as t(k, v)
 where lower(btrim(p.name)) = 'grandfathered'
on conflict (plan_id, key) do update set value = excluded.value;

-- ── 3. the subscriptions ────────────────────────────────────────────────────
--
-- One row per tenant that has no LIVE subscription, where "live" is the same
-- three statuses `idx_tenant_subscriptions_one_live` (0078) permits and
-- LIVE_STATUSES (entitlements.ts) reads. Keying the `not exists` on that exact
-- set is what makes this safe to run against a database where some tenants have
-- already subscribed — a tenant mid-trial, or one an operator has already
-- assigned a plan to, is left completely alone — and what keeps the insert from
-- colliding with that partial unique index.
--
-- Expired and cancelled history is deliberately NOT a reason to skip a tenant:
-- such a tenant has no live row either, so it is refused everything for the same
-- reason. The insert adds a new live row and leaves the history exactly where it
-- is, which is how assignPlan() treats it too.
--
-- EVERY tenant, with no filter on `tenants.status`. A plan grants nothing on its
-- own to an account suspended or cancelled for other reasons, and filtering here
-- would strand any such tenant with no plan on the day it is reactivated — a
-- second, later instance of this same bug.
--
-- ── about current_period_end ────────────────────────────────────────────────
--
-- readEntitlements() applies status AND clock: a row whose `current_period_end`
-- has passed returns NO_SUBSCRIPTION even while it still says 'active'. So a
-- normal one-month period here would be a time bomb — the exact regression this
-- file exists to prevent, merely deferred by thirty days and considerably harder
-- to diagnose once it fired.
--
-- A fixed far-future sentinel rather than `now() + interval`, so the value is
-- deterministic: a replay or a restore produces the same date instead of a
-- horizon that drifts with whenever it happened to run.
--
-- This is not a claim that anybody paid through 2099. It is the honest encoding
-- of "does not lapse on its own" for a comp plan that only an operator's
-- deliberate assignPlan() should ever end. `gateway` and
-- `gateway_subscription_id` are left null, which is exactly what 0078 says an
-- admin-assigned plan looks like, and what keeps the dunning sweep (0081) away
-- from these rows: it only ever touches rows already in `past_due`, or in
-- `expired` with `suspended_at` set.
insert into public.tenant_subscriptions
  (tenant_id, plan_id, billing_period, status, current_period_start, current_period_end)
select t.id,
       p.id,
       'monthly',
       'active',
       now(),
       timestamptz '2099-12-31 00:00:00+00'
  from public.tenants t
 cross join public.plans p
 where lower(btrim(p.name)) = 'grandfathered'
   and not exists (
         select 1
           from public.tenant_subscriptions s
          where s.tenant_id = t.id
            and s.status in ('trialing', 'active', 'past_due')
       );

-- ── grants and RLS ──────────────────────────────────────────────────────────
--
-- Nothing to change. This migration runs as the owner role, which is RLS-exempt,
-- and writes only to tables 0078 already created with their policies and grants.
-- `arena_app` still holds SELECT and nothing else on all three, so a business
-- can no more grandfather itself than it could assign itself Enterprise.
--
-- ── AFTER THIS RUNS ─────────────────────────────────────────────────────────
--
-- Every existing tenant keeps payroll, expenses and reports and stays uncapped,
-- exactly as before M16. An operator moves a business onto a real tier with the
-- normal admin flow (/admin/companies → assign plan), which cancels this row and
-- inserts the chosen one.
--
-- Companies created AFTER this migration are not covered by it, and do not need
-- to be: both create paths now attach a plan themselves. Self-serve signup
-- always did (lib/signup/service.ts), and createCompany() now requires a
-- `planId` and assigns it — the change that keeps this one-shot backfill from
-- re-accumulating planless companies the day after it runs.
