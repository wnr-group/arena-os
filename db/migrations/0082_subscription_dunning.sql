-- ============================================================================
-- Arena OS — 0082 dunning & suspension on failed payment (AROS-113)
--
-- 0079 built the subscription MODEL and said it "does NOT add: checkout,
-- gateway subscription creation, renewals, dunning". 0080 built checkout and
-- renewals. This migration builds the last of that list: DUNNING — what happens
-- between a renewal charge bouncing and an account being closed.
--
-- ── NO NEW STATES. NONE. ────────────────────────────────────────────────────
--
-- The lifecycle AROS-113 names —
--
--     active → past_due → suspended → cancelled
--
-- — is already fully expressible with the two enums this schema has, and 0080
-- already wrote the mapping down:
--
--   tenant_subscription_status  trialing|active|past_due|cancelled|expired (0079)
--   tenant_status               trial|active|suspended|cancelled          (0001)
--
--   ticket state │ tenant_subscriptions.status │ tenants.status
--   ─────────────┼────────────────────────────┼────────────────
--   active       │ active                     │ active
--   past_due     │ past_due                   │ active   (grace: still working)
--   suspended    │ expired                    │ suspended
--   cancelled    │ cancelled                  │ cancelled
--
-- "suspended" is an ACCOUNT state, not a subscription state — 0080 states the
-- reasoning and it has not changed: inventing a fifth subscription status would
-- split one fact across two columns that could then disagree. So this migration
-- adds NO enum value, NO status column, and NO second lifecycle. It adds only
-- the CLOCKS the lifecycle needs to run on a schedule instead of purely on a
-- webhook, and one delivery log so a reminder cannot be sent twice.
--
-- ── WHAT THIS MIGRATION ADDS ────────────────────────────────────────────────
--   1. tenant_subscriptions.past_due_since / suspended_at — the two timestamps
--      the grace and post-suspension clocks are measured from.
--   2. tenant_subscriptions.last_payment_failure_at / _reason — what went wrong,
--      for the operator and for the owner-facing message.
--   3. platform_dunning_notices — one row per reminder actually sent, with the
--      unique index that makes sending idempotent.
--
-- ── THE POLICY THESE COLUMNS SERVE ──────────────────────────────────────────
--
-- Durations are NOT in this file. They live in exactly one place —
-- lib/platform/billing/dunning-policy.ts — so there is a single number to
-- change and no chance of the schema and the code disagreeing about what "the
-- grace period" is. What the schema fixes is the SHAPE:
--
--   past_due_since   the moment the subscription entered past_due. The grace
--                    deadline is measured from HERE, not from
--                    current_period_end, because a failed renewal leaves
--                    current_period_end in the PAST (Razorpay does not extend a
--                    period it could not charge for). Measuring grace from an
--                    already-elapsed period end would give every business a
--                    grace period of zero — the exact trapdoor
--                    lib/platform/entitlements.ts says dunning must not be.
--
--   suspended_at     the moment the account was suspended. The cancellation
--                    deadline is measured from HERE.
--
-- Both are CLEARED when a payment finally clears, which is what makes recovery
-- (past_due → active, and suspended → active) leave no stale clock behind to
-- re-suspend an account that is paying again.
-- ============================================================================

-- ── 1 + 2. the clocks and the failure detail ────────────────────────────────
alter table public.tenant_subscriptions
  -- When this subscription entered past_due. Set on the FIRST transition into
  -- past_due and not rewritten by a redelivery of the same event — a
  -- redelivered `subscription.pending` must not restart a grace period that is
  -- half spent. Cleared when a charge succeeds.
  add column if not exists past_due_since timestamptz,

  -- When the account was suspended for non-payment. Set when the grace period
  -- expires (or when Razorpay halts the subscription itself), and cleared on
  -- recovery. Deliberately on the SUBSCRIPTION and not on `tenants`: an
  -- operator suspending an account by hand from platform admin is a different
  -- act with a different reason, and it must not start a billing cancellation
  -- clock.
  add column if not exists suspended_at timestamptz,

  -- What the gateway said, for the operator and for the owner-facing message.
  -- Diagnostics only: NOTHING branches on this text.
  add column if not exists last_payment_failure_at timestamptz,
  add column if not exists last_payment_failure_reason text;

do $$ begin
  alter table public.tenant_subscriptions
    add constraint tenant_subscriptions_failure_reason_nonblank
    check (last_payment_failure_reason is null
           or btrim(last_payment_failure_reason) <> '');
exception when duplicate_object then null; end $$;

-- The reason is gateway-authored text echoed into an owner-facing banner. It is
-- already length-capped in lib/platform/billing/lifecycle.ts before it is
-- written; this is the second lock, so a future call site cannot store a
-- kilobyte of provider prose in a column a page renders.
do $$ begin
  alter table public.tenant_subscriptions
    add constraint tenant_subscriptions_failure_reason_length
    check (last_payment_failure_reason is null
           or length(last_payment_failure_reason) <= 300);
exception when duplicate_object then null; end $$;

-- A clock that runs backwards is a bug, not a state. suspended_at can only
-- follow the past_due it came from.
do $$ begin
  alter table public.tenant_subscriptions
    add constraint tenant_subscriptions_suspension_follows_past_due
    check (suspended_at is null
           or past_due_since is null
           or suspended_at >= past_due_since);
exception when duplicate_object then null; end $$;

-- The scheduled processor's ONLY scan: "which subscriptions have a dunning
-- clock running?". Partial, so it stays small — the overwhelming majority of
-- rows are healthy and carry no clock at all, and a job that has nothing to do
-- should touch nothing.
create index if not exists idx_tenant_subscriptions_dunning
  on public.tenant_subscriptions (past_due_since)
  where past_due_since is not null;

-- ── BACKFILL, and why it is generous ────────────────────────────────────────
--
-- Rows already sitting in past_due when this migration runs have no
-- past_due_since, so the processor would not see them at all (the index above
-- is partial and every query below filters on the column being non-null). That
-- is a fail-OPEN gap, so it is closed here.
--
-- The value is `now()`, NOT the historical moment the charge bounced — which
-- this schema never recorded and cannot reconstruct. The consequence is
-- deliberate: an existing arrears account gets a FULL fresh grace period
-- starting at deploy, rather than being suspended the instant the job first
-- runs because its (unknowable) failure date is already past the deadline.
-- Backward compatibility for a live tenant means not surprising it, and a
-- business that has been in arrears for a while can afford one more grace
-- window far better than it can afford an unannounced suspension.
update public.tenant_subscriptions
   set past_due_since = now()
 where status = 'past_due'
   and past_due_since is null;

-- ── 3. the reminder delivery log ────────────────────────────────────────────
--
-- ── Why this table exists at all ────────────────────────────────────────────
--
-- This project has NO notification infrastructure — no email provider, no SMS
-- provider, no queue, no templates, nothing. That was checked before writing a
-- line of this: there is no dependency to reuse and no table to extend. The
-- ticket's rule ("reuse the existing notification infrastructure; do not create
-- a separate one") therefore lands on its own fallback — "extend minimally" —
-- and this is the minimum that actually works.
--
-- It is a LOG OF WHAT WAS SENT, not a notification framework. It has no
-- template, no scheduler, no retry queue and no channel routing. Its whole job
-- is the unique index below, which is what stops a scheduled job that runs
-- hourly from sending the same reminder twenty-four times a day. The DELIVERY
-- itself is one injectable function in lib/platform/billing/dunning-notify.ts
-- (today: a structured operator log line, plus the owner-facing banner the
-- billing portal already renders); when this project gains a real email
-- provider, that one function is the only thing that changes.
--
-- Modelled on webhook_events (0034/0080), the delivery log this codebase
-- already has: a row per delivery, a unique claim that makes a repeat a no-op,
-- and an outcome. Same idea, different stream.
create table if not exists public.platform_dunning_notices (
  id uuid primary key default gen_random_uuid(),

  tenant_id uuid not null references public.tenants(id) on delete cascade,

  -- restrict, like platform_invoices.subscription_id (0081): the record of what
  -- a business was warned about must not vanish under it. Historical billing
  -- data is never deleted — see the AROS-113 rule about exactly that.
  subscription_id uuid not null
    references public.tenant_subscriptions(id) on delete restrict,

  -- ── THE EPISODE KEY ─────────────────────────────────────────────────────
  --
  -- The `past_due_since` value that anchored this dunning run. It is what makes
  -- the unique index below mean the right thing:
  --
  --   * within ONE arrears episode, each stage is sent at most once, no matter
  --     how often the job runs or how far it gets before being interrupted;
  --   * a business that recovers and then fails again MONTHS later gets a fresh
  --     past_due_since, therefore a fresh episode, therefore a fresh set of
  --     reminders. It is not silenced forever by a warning it received once.
  --
  -- A plain (subscription_id, stage) unique index would have got the first half
  -- right and the second half badly wrong.
  dunning_cycle timestamptz not null,

  -- The stages are a closed set: adding one is a deliberate change to
  -- lib/platform/billing/dunning-policy.ts and to this CHECK, not something a
  -- caller can invent at runtime.
  --
  --   payment_failed  the charge bounced; grace has started
  --   grace_reminder  mid-grace nudge
  --   final_warning   last notice before suspension
  --   suspended       the account has been suspended
  --   cancelled       the subscription has been closed
  stage text not null check (stage in (
    'payment_failed', 'grace_reminder', 'final_warning', 'suspended', 'cancelled'
  )),

  -- How it went out. 'log' today, because that is honestly all this platform
  -- can do; 'email'/'sms' become possible the day a provider is wired in,
  -- without a schema change.
  channel text not null default 'log' check (btrim(channel) <> ''),

  sent_at timestamptz not null default now()
);

-- THE idempotency guarantee. Not a check in application code — an index, so
-- two concurrent job runs racing on the same subscription cannot both win: one
-- inserts, the other gets 23505 and skips. This is the same shape as
-- idx_webhook_events_event (0034) and idx_expenses_recurrence_period (0042),
-- and it is chosen for the same reason: an application-level `if (!exists)` has
-- a window between the check and the insert, and an index does not.
create unique index if not exists idx_platform_dunning_notices_once
  on public.platform_dunning_notices (subscription_id, dunning_cycle, stage);

-- "What has this business been told, and when?" — the owner-facing history and
-- the operator's answer to "did we warn them?".
create index if not exists idx_platform_dunning_notices_tenant
  on public.platform_dunning_notices (tenant_id, sent_at desc);

-- ── RLS + grants ────────────────────────────────────────────────────────────
--
-- Exactly the treatment platform_invoices got in 0081, for exactly the same
-- reason: what a business owes Arena OS, and what it has been warned about, is
-- the PROPRIETOR's commercial information. A cashier does not need it and a
-- manager does not either. So the policy is auth_role_in() = 'owner', the same
-- helper 0020's business_profiles and 0081's platform_invoices use.
--
-- SELECT is the only grant. Notices are written by the scheduled processor and
-- by the webhook, both of which run on the OWNER connection with no session —
-- the narrow, documented exception lib/payments/webhook.ts established. A
-- missing GRANT is a stronger guarantee than a policy that evaluates to false:
-- there is no insert, update or delete path for a tenant user to probe, so a
-- business cannot mark itself as "already warned" to dodge a reminder, and it
-- cannot delete the record that it was.
alter table public.platform_dunning_notices enable row level security;

drop policy if exists platform_dunning_notices_owner_select on public.platform_dunning_notices;
create policy platform_dunning_notices_owner_select on public.platform_dunning_notices
  for select using (public.auth_role_in(tenant_id) = 'owner');

grant select on public.platform_dunning_notices to arena_app;

-- tenant_subscriptions keeps the grants 0079 gave it — SELECT only to
-- arena_app, writes only through the owner connection. The four new columns
-- inherit exactly that, so a suspended business cannot clear its own
-- suspended_at any more than it could clear its own status. And 0080 already
-- revoked the blanket UPDATE on public.tenants, so it cannot un-suspend itself
-- from the other side either.

comment on table public.platform_dunning_notices is
  'One row per dunning reminder actually sent for a subscription arrears episode. NOT a notification framework: its job is the unique (subscription_id, dunning_cycle, stage) index, which makes a repeatedly-run scheduled job unable to send the same warning twice. Owner-read-only; written only on the owner connection.';

comment on column public.tenant_subscriptions.past_due_since is
  'When this subscription entered past_due. The grace deadline is measured from here, NOT from current_period_end (which a failed renewal leaves in the past). Cleared when a payment clears.';

comment on column public.tenant_subscriptions.suspended_at is
  'When the account was suspended for non-payment. The cancellation deadline is measured from here. Cleared on recovery. Not set by an operator''s manual suspension in platform admin.';
