-- ============================================================================
-- Arena OS — 0055 where a subscription's billing period came from
--
-- A correctness fix to the M16 lifecycle, not a new feature. One boolean.
--
-- ── THE BUG THIS CLOSES ─────────────────────────────────────────────────────
--
-- `tenant_subscriptions.current_period_start/end` are documented (0050, 0051)
-- as the PROVIDER's absolute view of the billing cycle — that is what makes
-- webhook processing idempotent, because applying the same event twice computes
-- the same period rather than advancing one.
--
-- But a row does not START that way. subscribeTenantToPlan() has to write SOME
-- period at creation time (the column is NOT NULL and 0050's
-- tenant_subscriptions_period CHECK requires end > start), and Razorpay has not
-- yet told us anything — the payer has not even opened the authorisation page.
-- So it seeds the period from the tenant's REMAINING RUNWAY: the previous
-- subscription's unspent window, or PENDING_AUTHORISATION_DAYS when there is
-- none.
--
-- That placeholder is indistinguishable, in the schema as it stood, from a real
-- provider period. And lib/platform/billing/lifecycle.ts protected the period
-- with a "never move backwards" rule expressed on the END:
--
--     if (providerEnd > currentPeriodEnd) { …apply… }
--
-- Correct between two provider periods. Wrong for the FIRST one, whenever the
-- inherited runway outlasts the cycle being bought — an annual → monthly
-- downgrade, or an admin-assigned multi-month plan (assignPlan accepts up to
-- 36) followed by a monthly checkout. The provider's real 30-day period ends
-- BEFORE the placeholder, so it was discarded and the row kept the placeholder.
--
-- Three things then inherited the wrong window, and all three are money:
--
--   1. the GST invoice raised in the same transaction documented a ~300-day
--      `billing_period_start … billing_period_end` for a charge whose
--      `billing_period_type` said 'monthly';
--   2. `readEntitlements()` granted the plan until the placeholder's end, so
--      one month's payment bought most of a year of access;
--   3. worst, `computeProrationCredit()` reads its base period FROM THAT
--      INVOICE — so a plan change after the paid month was fully consumed
--      credited the business for the ~270 "unused" days it never bought.
--      Measured: a ₹19,999 charge produced a ₹17,999.10 credit note.
--
-- ── WHY A COLUMN AND NOT A CLEVERER COMPARISON ──────────────────────────────
--
-- Two timestamp-only rules were tried against the existing suites and both are
-- wrong, which is the argument for storing the fact instead of inferring it:
--
--   * ordering on the cycle START ("ignore a provider view that starts earlier
--     than the one we hold") rejects a legitimate first period, because
--     Razorpay backdates `current_start` to the real cycle start, which is
--     routinely EARLIER than the moment we created the row. It also breaks on
--     sub-second truncation: `current_start` is whole seconds, our placeholder
--     start is `now()` to the microsecond, so the provider's value for the very
--     same instant can read as older.
--   * any tolerance window around that comparison is a guess about clock skew
--     standing between a business and a correct bill.
--
-- The thing actually being asked is not "which timestamp is bigger" — it is
-- "has the provider ever told us this row's period?". That is a fact, so it is
-- stored as one. With it, the rule needs no clock reasoning at all:
--
--     period_from_gateway = false  →  the period is a placeholder. Take the
--                                     provider's window WHOLE, in either
--                                     direction, and set this true.
--     period_from_gateway = true   →  the period is provider-derived. The
--                                     original never-backwards rule applies
--                                     unchanged, so an out-of-order redelivery
--                                     still cannot shorten a term.
--
-- The replay protection 0050/0051 relied on is therefore not weakened for a
-- single row that has ever received a provider period; it is only lifted for
-- the placeholder it was never meant to guard.
-- ============================================================================

alter table public.tenant_subscriptions
  add column if not exists period_from_gateway boolean not null default false;

comment on column public.tenant_subscriptions.period_from_gateway is
  'False while current_period_start/end are the placeholder subscribeTenantToPlan() seeded from the tenant''s remaining runway; true once a verified webhook has set them from the provider''s own current_start/current_end. Read by lib/platform/billing/lifecycle.ts to decide whether the never-move-backwards rule applies.';

-- ── BACKFILL ────────────────────────────────────────────────────────────────
--
-- True for every row that has had a charge applied: `gateway_last_payment_id`
-- is written only by applySubscriptionState() from a verified
-- `subscription.charged`, and that event always carries the cycle — so those
-- periods ARE provider-derived and must keep their never-backwards protection
-- from this moment on.
--
-- Everything else stays false, which is the safe direction rather than the
-- cautious-looking one. A row that has never been charged is either a trial, an
-- admin assignment, or a checkout awaiting authorisation; in all three the
-- period is local, and the next provider event SHOULD replace it wholesale.
-- The one thing marking those `true` would buy is preserving the very bug this
-- migration exists to fix.
--
-- A row that was only ever `subscription.authenticated` (a provider period, no
-- payment) is also left false. The cost is bounded and self-correcting: its
-- next verified event re-applies the provider's window and sets the flag.
update public.tenant_subscriptions
   set period_from_gateway = true
 where gateway_last_payment_id is not null;

-- No index. This column is never a search predicate — it is read on a row the
-- webhook has already located by `gateway_subscription_id` and locked.
--
-- No grant change. `arena_app` holds SELECT and nothing else on
-- tenant_subscriptions (0050); this column inherits exactly that, so a business
-- can no more flip its own period source than it can flip its own status.
