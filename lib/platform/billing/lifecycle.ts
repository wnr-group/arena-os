import 'server-only'
import { and, eq } from 'drizzle-orm'
import type { DB } from '@/db'
import { auditLog, tenants, tenantSubscriptions } from '@/db/schema'

/**
 * THE SUBSCRIPTION LIFECYCLE — the one place that decides what a Razorpay
 * subscription state means for Arena OS.
 *
 * Two local columns move, and they mean different things:
 *
 *   tenant_subscriptions.status   the SUBSCRIPTION's state (0050)
 *                                 trialing | active | past_due | cancelled | expired
 *
 *   tenants.status                the ACCOUNT's state as the operator sees it (0001)
 *                                 trial | active | suspended | cancelled
 *
 * 0050 already said they "move independently: a subscription can go past_due
 * while the tenant is still active, and the decision to suspend is a separate,
 * deliberate act". This module IS that deliberate act, written down once.
 *
 * ═══ THE MAPPING ═══════════════════════════════════════════════════════════
 *
 * Derived from the Razorpay subscription ENTITY's own `status`, not from the
 * event name. Every subscription webhook carries the full entity, the entity's
 * status is the provider's authoritative view, and mapping from it means an
 * event Razorpay adds tomorrow still lands on a correct state instead of being
 * silently ignored.
 *
 *  Razorpay status │ event that typically carries it │ local subscription │ tenant
 *  ────────────────┼─────────────────────────────────┼────────────────────┼──────────
 *  created         │ (creation response)             │ trialing           │ unchanged
 *  authenticated   │ subscription.authenticated      │ trialing           │ unchanged
 *  active          │ subscription.activated          │ active             │ active
 *                  │ subscription.charged            │ active             │ active
 *                  │ subscription.resumed            │ active             │ active
 *  pending         │ subscription.pending            │ past_due           │ unchanged
 *  halted          │ subscription.halted             │ expired            │ suspended
 *  paused          │ subscription.paused             │ expired            │ suspended
 *  cancelled       │ subscription.cancelled          │ cancelled          │ cancelled
 *  completed       │ subscription.completed          │ expired            │ unchanged
 *  expired         │ (never authenticated in time)   │ expired            │ unchanged
 *
 * ── Three of those rows deserve their reasoning stated ──────────────────────
 *
 * `pending` → past_due, TENANT UNCHANGED. Razorpay is retrying a failed charge.
 * The ticket asks for "tenant_status = past_due OR existing equivalent";
 * tenant_status has no past_due, and the existing equivalent is: do not touch
 * it. That is not a shrug — it is the rule this codebase already wrote down in
 * lib/platform/entitlements.ts ("past_due is included so a failed renewal does
 * not revoke a business's access the instant the charge bounces — dunning is
 * supposed to be a conversation, not a trapdoor"). Forcing 'active' here would
 * also silently PROMOTE a trial tenant whose first charge failed, which is
 * exactly backwards. So a business in arrears keeps working, and the account
 * state stops lying about why.
 *
 * AROS-113 adds the CLOCK that makes that conversation finite: entering
 * past_due stamps `past_due_since`, and lib/platform/billing/dunning.ts
 * suspends the account when the grace period measured from it runs out. The
 * mapping above is unchanged — grace is a deadline on Razorpay's retries, not a
 * new state.
 *
 * `halted` → expired + SUSPENDED. This is grace exhaustion: Razorpay has run
 * out of retries. Two things happen at once, and both are load-bearing. The
 * subscription leaves the three LIVE_STATUSES, so readEntitlements() returns
 * the empty answer and every entitlement gate closes (M16 #2, fail-closed). And
 * the tenant becomes 'suspended', so public_tenant_by_slug() (0022) stops
 * resolving and the venue's public booking site goes dark. Nothing is deleted;
 * paying reverses all of it on the next webhook.
 *
 * `cancelled` → cancelled + CANCELLED, but only when the subscription was
 * actually being paid for. A checkout that was started and abandoned emits the
 * identical event, and closing a business's account for not completing a
 * purchase would be absurd. The refinement is applied in
 * applySubscriptionState() below, where the prior local state is known.
 *
 * `completed` and `expired` → tenant UNCHANGED. Neither is a payment failure.
 * `completed` means the authorised cycle count ran out (the subscription did
 * its job); `expired` means the mandate was never authenticated at all, so the
 * tenant simply stays wherever it already was and the ordinary trial rules
 * continue to apply. Suspending an account because a checkout was abandoned
 * would be a punishment for not buying.
 *
 * ═══ IDEMPOTENCY ═══════════════════════════════════════════════════════════
 *
 * Razorpay delivers at least once, and re-delivers after any non-2xx. Every
 * mechanism here is designed so a second delivery of the same event is a no-op:
 *
 *  1. NOTHING IS INCREMENTED. The billing period is SET from the entity's own
 *     `current_start`/`current_end` — absolute unix timestamps from the
 *     provider — never advanced by adding a month locally. Applying the same
 *     event twice therefore computes the same period. This is the structural
 *     reason money cannot be double-counted: no total is accumulated anywhere,
 *     so there is nothing for a replay to add to.
 *  2. THE ROW IS LOCKED. `select … for update` on the subscription serialises
 *     concurrent deliveries of two DIFFERENT events, so they apply in some
 *     order rather than interleaving.
 *  3. TERMINAL IS TERMINAL. A 'cancelled' row is never moved back to a live
 *     state, so a delayed `subscription.charged` arriving after a cancellation
 *     cannot resurrect an account.
 *  4. A PROVIDER PERIOD NEVER GOES BACKWARDS. An out-of-order redelivery of an
 *     older event cannot shorten a period a newer one already set. The rule is
 *     scoped by `period_from_gateway` (migration 0055) so that it guards only
 *     periods the provider actually gave us: the placeholder a row is CREATED
 *     with is replaced wholesale by the first real cycle, in either direction.
 *     See the note beside the comparison in applySubscriptionState().
 *  5. THE DUNNING CLOCKS ARE SET-ONCE-PER-EPISODE (AROS-113). `past_due_since`
 *     and `suspended_at` are written with `?? new Date()`, never overwritten
 *     while they hold a value, so a redelivered `subscription.pending` cannot
 *     restart a grace period that is half spent — which would let a business
 *     stay in arrears indefinitely by provoking redeliveries. They are cleared
 *     in exactly one circumstance: a charge succeeded.
 *
 * Delivery-level idempotency — the claim on webhook_events (gateway, event_id)
 * — lives one layer up in ./webhook.ts, where it can short-circuit before any
 * of this runs.
 */

/** The five subscription states 0050 defines. Not extended here. */
export type LocalSubscriptionStatus =
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'cancelled'
  | 'expired'

/** The four account states 0001 defines. Not extended here. */
export type LocalTenantStatus = 'trial' | 'active' | 'suspended' | 'cancelled'

export type StateMapping = {
  subscription: LocalSubscriptionStatus
  /** null means LEAVE THE ACCOUNT STATE ALONE — a deliberate outcome, not a gap. */
  tenant: LocalTenantStatus | null
}

/**
 * Razorpay subscription status → local state. The table above, as code.
 *
 * Returns null for a status this build does not recognise. The caller
 * acknowledges those and changes nothing: guessing what an unknown provider
 * state means is how an account gets suspended by a gateway release note.
 */
export function mapRazorpayStatus(razorpayStatus: string): StateMapping | null {
  switch (razorpayStatus) {
    case 'created':
    case 'authenticated':
      return { subscription: 'trialing', tenant: null }
    case 'active':
      return { subscription: 'active', tenant: 'active' }
    case 'pending':
      return { subscription: 'past_due', tenant: null }
    case 'halted':
    case 'paused':
      return { subscription: 'expired', tenant: 'suspended' }
    case 'cancelled':
      return { subscription: 'cancelled', tenant: 'cancelled' }
    case 'completed':
    case 'expired':
      return { subscription: 'expired', tenant: null }
    default:
      return null
  }
}

/**
 * The subscription events this application acts on.
 *
 * Every one of them carries `payload.subscription.entity`, which is all the
 * mapping above needs. Listed explicitly rather than accepting anything
 * starting with `subscription.` so that adding an event is a decision someone
 * makes, and so the delivery log records the rest as 'ignored' instead of
 * quietly acting on a shape this build has never seen.
 */
export const HANDLED_EVENTS = new Set([
  'subscription.authenticated',
  'subscription.activated',
  'subscription.charged',
  'subscription.pending',
  'subscription.halted',
  'subscription.paused',
  'subscription.resumed',
  'subscription.cancelled',
  'subscription.completed',
  'subscription.updated',
])

/** Statuses that still count as "live" — the same three 0050's index permits. */
const LIVE_STATUSES = ['trialing', 'active', 'past_due'] as const

/** Once here, a subscription never moves again. */
const TERMINAL_STATUSES: readonly LocalSubscriptionStatus[] = ['cancelled']

export type ApplyResult =
  | {
      kind: 'applied'
      subscriptionId: string
      tenantId: string
      from: LocalSubscriptionStatus
      to: LocalSubscriptionStatus
      tenantStatus: LocalTenantStatus | null
      /**
       * What the caller needs to BILL this change, carried out of here rather
       * than re-read afterwards (M16 #4).
       *
       * The period is the one this call actually settled on — provider-derived
       * and already clamped by the never-move-backwards rule below — so the
       * invoice documents exactly the window the subscription row now claims.
       * Re-reading the row outside the transaction could see a different one.
       */
      planId: string
      billingPeriod: 'monthly' | 'annual'
      periodStart: Date
      periodEnd: Date
      /**
       * The dunning clocks as this call left them (AROS-113). Carried out
       * rather than re-read for the same reason the period is: the caller needs
       * the value that was actually committed, and a read outside the
       * transaction could see a different one.
       *
       * `pastDueSince` non-null is what the notifier keys a dunning EPISODE on.
       * Both null means the subscription is healthy.
       */
      pastDueSince: Date | null
      suspendedAt: Date | null
    }
  | { kind: 'unchanged'; subscriptionId: string; tenantId: string; reason: string }
  | { kind: 'ignored'; reason: string }

export type ApplyParams = {
  /** Razorpay's subscription id (`sub_…`), from the VERIFIED payload. */
  gatewaySubscriptionId: string
  /** The entity's own status, from the VERIFIED payload. */
  razorpayStatus: string
  /** Unix SECONDS, or null when Razorpay has not set a period yet. */
  currentStart: number | null
  currentEnd: number | null
  /** Razorpay payment id when the event carried one (subscription.charged). */
  paymentId: string | null
  /**
   * Gateway-authored text about WHY a charge failed, when the event carried a
   * payment that says so (AROS-113). Diagnostics and owner-facing copy only —
   * nothing in this module branches on it, and it is truncated before it is
   * stored so provider prose cannot fill a column a page renders.
   */
  failureReason?: string | null
}

/** Matches tenant_subscriptions_failure_reason_length in migration 0053. */
const MAX_FAILURE_REASON = 300

function normaliseFailureReason(reason: string | null | undefined): string | null {
  if (typeof reason !== 'string') return null
  const trimmed = reason.trim()
  if (!trimmed) return null
  return trimmed.slice(0, MAX_FAILURE_REASON)
}

/** Unix seconds → Date, rejecting the zeros and nonsense a payload can carry. */
function fromUnixSeconds(seconds: number | null): Date | null {
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) return null
  const d = new Date(seconds * 1000)
  return Number.isNaN(d.getTime()) ? null : d
}

/**
 * Apply a VERIFIED subscription state to the local model, inside a transaction
 * the caller has already opened.
 *
 * ── Preconditions this function assumes and does not re-check ───────────────
 * The caller (./webhook.ts, driven by the route) has already read the RAW body,
 * verified the HMAC against the PLATFORM webhook secret, parsed only afterwards,
 * and claimed the event id. Everything below therefore acts on data Razorpay
 * genuinely signed.
 *
 * ── What identifies the tenant ──────────────────────────────────────────────
 * The Razorpay subscription id, matched against `gateway_subscription_id` —
 * OUR OWN column, written when we created the subscription. The tenant is then
 * whatever that row says. `notes.tenantId`, which subscribe.ts attaches for
 * human reconciliation, is NEVER read here: notes are payload data, and payload
 * data does not get to choose which account it modifies.
 */
export async function applySubscriptionState(
  tx: DB,
  params: ApplyParams,
): Promise<ApplyResult> {
  const mapping = mapRazorpayStatus(params.razorpayStatus)
  if (!mapping) {
    return { kind: 'ignored', reason: `unrecognised gateway status ${params.razorpayStatus}` }
  }

  // Locate by OUR reference, and lock. idx_tenant_subscriptions_gateway_ref
  // (0050) makes at most one row possible, so there is never a choice to make.
  const [row] = await tx
    .select({
      id: tenantSubscriptions.id,
      tenantId: tenantSubscriptions.tenantId,
      planId: tenantSubscriptions.planId,
      billingPeriod: tenantSubscriptions.billingPeriod,
      status: tenantSubscriptions.status,
      currentPeriodStart: tenantSubscriptions.currentPeriodStart,
      currentPeriodEnd: tenantSubscriptions.currentPeriodEnd,
      // Whether the two above are the provider's window or the placeholder the
      // row was created with (migration 0055). Decides the clamp below.
      periodFromGateway: tenantSubscriptions.periodFromGateway,
      cancelledAt: tenantSubscriptions.cancelledAt,
      lastPaymentId: tenantSubscriptions.gatewayLastPaymentId,
      pastDueSince: tenantSubscriptions.pastDueSince,
      suspendedAt: tenantSubscriptions.suspendedAt,
      failureReason: tenantSubscriptions.lastPaymentFailureReason,
    })
    .from(tenantSubscriptions)
    .where(
      and(
        eq(tenantSubscriptions.gateway, GATEWAY),
        eq(tenantSubscriptions.gatewaySubscriptionId, params.gatewaySubscriptionId),
      ),
    )
    .for('update')
    .limit(1)

  if (!row) {
    // A subscription we did not create, or one whose row has been removed with
    // its tenant. Acknowledged, never retried — inventing a subscription from a
    // payload is precisely what "never trust the payload" forbids.
    return { kind: 'ignored', reason: 'no local subscription for this gateway reference' }
  }

  const current = row.status as LocalSubscriptionStatus

  // (3) Terminal is terminal, for EVERY incoming state including 'cancelled'
  // itself. Two different deliveries land here and both must be no-ops:
  //
  //   * a late `subscription.charged` after a cancellation, which must not
  //     resurrect an account;
  //   * the `subscription.cancelled` we ourselves provoked when a business
  //     switched plans (see subscribeTenantToPlan) — the old row was already
  //     closed out locally, and re-applying the mapping would take the tenant
  //     to 'cancelled' while it sits happily on its NEW subscription.
  //
  // The second is why the check is not `mapping.subscription !== current`:
  // arriving at the state a row is already in still has consequences here,
  // because the tenant sync runs off the mapping rather than off the delta.
  if (TERMINAL_STATUSES.includes(current)) {
    return {
      kind: 'unchanged',
      subscriptionId: row.id,
      tenantId: row.tenantId,
      reason: `subscription is ${current}, which is terminal`,
    }
  }

  // (1) The period is SET from the provider's absolute timestamps, never
  // advanced locally — and (4) never moved backwards, so an out-of-order
  // redelivery cannot shorten a period a newer event already extended.
  //
  // ── The never-backwards rule guards a PROVIDER period, not a placeholder ──
  //
  // An earlier version compared ENDS only, and applied the provider's window
  // solely when it ended LATER than the one held locally. That is right between
  // two provider periods and wrong for the FIRST one, because the period a row
  // starts life with is not a provider value at all: subscribeTenantToPlan()
  // seeds it from the tenant's remaining runway (the inherited window, or
  // PENDING_AUTHORISATION_DAYS).
  //
  // When that runway outlasts the cycle being bought — an annual → monthly
  // downgrade, or an admin-assigned multi-month plan followed by a monthly
  // checkout — the real 30-day period ends BEFORE the placeholder and was
  // discarded. The row kept a ~300-day term bought with one month's money; the
  // GST invoice raised in this same transaction documented that term for a
  // charge labelled 'monthly'; and computeProrationCredit(), which reads its
  // base period from that invoice, then credited a later plan change for
  // hundreds of days the business had actually consumed.
  //
  // `period_from_gateway` (migration 0055) records which of the two a row is
  // holding, so the decision needs no clock reasoning:
  //
  //   false → a placeholder. Take the provider's window WHOLE, in either
  //           direction, and mark it provider-derived.
  //   true  → provider-derived. The original rule applies unchanged: extend
  //           only, so an out-of-order redelivery cannot shorten a term.
  //
  // Ordering on the timestamps instead was tried and does not work: Razorpay
  // backdates `current_start` to the real cycle start, which is routinely
  // EARLIER than the moment we created the row, and it is truncated to whole
  // seconds while the placeholder start is not. Migration 0055's header carries
  // the full argument.
  const providerStart = fromUnixSeconds(params.currentStart)
  const providerEnd = fromUnixSeconds(params.currentEnd)

  let periodStart = row.currentPeriodStart
  let periodEnd = row.currentPeriodEnd
  let periodFromGateway = row.periodFromGateway

  if (providerEnd) {
    // A range we can write as-is: both ends present and correctly ordered, so
    // tenant_subscriptions_period (0050) holds by construction.
    const wholeRange = providerStart !== null && providerEnd.getTime() > providerStart.getTime()

    if (!periodFromGateway && wholeRange) {
      periodStart = providerStart as Date
      periodEnd = providerEnd
      periodFromGateway = true
    } else if (providerEnd.getTime() > periodEnd.getTime()) {
      periodEnd = providerEnd
      // Only move the start alongside a genuine extension, and only when the
      // resulting range still satisfies tenant_subscriptions_period.
      if (providerStart && providerStart.getTime() < providerEnd.getTime()) {
        periodStart = providerStart
      }
      periodFromGateway = true
    }
    // Deliberately no `else`: a provider view with no usable start that would
    // SHORTEN the period is not applied. We cannot write an end without knowing
    // the start it must stay ahead of, and leaving the flag false lets the next
    // properly-formed delivery correct the row.
  }

  const isCancelled = mapping.subscription === 'cancelled'

  // ── the one refinement the flat table above cannot express ────────────────
  //
  // `cancelled` → tenant cancelled is right for a subscription that was being
  // PAID FOR: a business ending a paid relationship is a closed account.
  //
  // It is badly wrong for one that never was. A tenant that starts a checkout,
  // never approves the mandate, and then backs out produces exactly the same
  // `subscription.cancelled` event — and closing their account for abandoning a
  // purchase would be a punishment for not buying. So the account is only
  // cancelled when the subscription had actually been charged; otherwise the
  // subscription row closes, the tenant is left exactly where it was, and the
  // ordinary trial rules carry on applying.
  //
  // "Had been charged" is read from OUR record (a payment id we applied, or a
  // status only a successful charge can produce), never from the payload.
  const wasPaid =
    current === 'active' || current === 'past_due' || row.lastPaymentId !== null
  const tenantTarget = isCancelled && !wasPaid ? null : mapping.tenant

  // ── the dunning clocks (AROS-113) ─────────────────────────────────────────
  //
  // Three situations, and nothing else touches these columns:
  //
  //   ARREARS   the subscription is past_due. Stamp `past_due_since` if it is
  //             not already stamped. `?? now` and never a plain `now` — see
  //             idempotency note (5) at the top of this file: a redelivered
  //             `subscription.pending` must not restart a half-spent grace
  //             period, or a business could stay in arrears forever by
  //             provoking redeliveries.
  //
  //   SUSPENDED Razorpay halted or paused the subscription, i.e. it gave up
  //             retrying. Stamp `suspended_at`, and stamp `past_due_since` too
  //             if this is the first we have heard of the trouble — the
  //             post-suspension cancellation clock in dunning.ts needs an
  //             anchor, and the dunning-notice episode key is `past_due_since`,
  //             so a suspension that skipped past_due entirely still belongs to
  //             an identifiable episode.
  //
  //   RECOVERED the subscription is live again. BOTH clocks are cleared, which
  //             is the whole of "suspended → active" as a policy: a business
  //             that pays carries no stale deadline that would re-suspend or
  //             cancel it on the next job run. See
  //             lib/platform/billing/dunning-policy.ts § RECOVERY.
  //
  //             `trialing` counts as recovery alongside `active`, deliberately.
  //             It is reached from `created`/`authenticated`, i.e. a mandate
  //             being (re-)authorised, and the alternative is worse: keeping a
  //             stale anchor would mean the NEXT failure starts with its grace
  //             period already spent, and the business would be suspended the
  //             first time the job ran. A re-authorised mandate deserves a
  //             fresh clock, and the next real failure stamps one.
  //
  // A `cancelled` or `completed`/`expired` subscription keeps whatever clocks
  // it had. They are history at that point, and history is not rewritten.
  const now = new Date()
  const isArrears = mapping.subscription === 'past_due'
  const isSuspension = mapping.subscription === 'expired' && mapping.tenant === 'suspended'
  const isRecovery = mapping.subscription === 'active' || mapping.subscription === 'trialing'

  const pastDueSince = isRecovery
    ? null
    : isArrears || isSuspension
      ? (row.pastDueSince ?? now)
      : row.pastDueSince
  const suspendedAt = isRecovery
    ? null
    : isSuspension
      ? (row.suspendedAt ?? now)
      : row.suspendedAt

  // Failure detail is recorded when the arrears are NEW (a fresh episode) or
  // when the gateway has told us something we have not already stored. Both
  // conditions are false for a redelivery of an event we have applied, so a
  // replay leaves these columns exactly as it found them.
  const incomingReason = normaliseFailureReason(params.failureReason)
  const recordFailure =
    (isArrears || isSuspension) &&
    (row.pastDueSince === null ||
      (incomingReason !== null && incomingReason !== row.failureReason))

  const set = {
    status: mapping.subscription,
    currentPeriodStart: periodStart,
    currentPeriodEnd: periodEnd,
    // Written with the period it describes, so the two can never disagree
    // about whether the stored window is the provider's.
    periodFromGateway,
    pastDueSince,
    suspendedAt,
    ...(recordFailure
      ? {
          lastPaymentFailureAt: now,
          // Keep the previous reason when this delivery carried none, rather
          // than blanking a useful message with a silence.
          lastPaymentFailureReason: incomingReason ?? row.failureReason,
        }
      : {}),
    // tenant_subscriptions_cancelled_at (0050) CHECKs that cancelled_at is set
    // if and only if status = 'cancelled', so the two must be written in the
    // same statement. An already-cancelled row keeps its ORIGINAL timestamp —
    // a redelivery must not rewrite when the cancellation happened.
    cancelledAt: isCancelled ? (row.cancelledAt ?? new Date()) : null,
    // The request has been honoured; the pending flag has done its job.
    ...(isCancelled ? { cancelAtPeriodEnd: false } : {}),
    // Recorded for reconciliation only. Writing it twice is harmless because
    // nothing sums it — see the idempotency note at the top of this file.
    ...(params.paymentId ? { gatewayLastPaymentId: params.paymentId } : {}),
  }

  const noStatusChange = current === mapping.subscription
  // BOTH ends, because the provider's period can now correct a locally-seeded
  // placeholder without its end moving — a start-only change is still a change.
  const noPeriodChange =
    periodEnd.getTime() === row.currentPeriodEnd.getTime() &&
    periodStart.getTime() === row.currentPeriodStart.getTime()
  const noPaymentChange = !params.paymentId || params.paymentId === row.lastPaymentId

  await tx
    .update(tenantSubscriptions)
    .set(set)
    .where(eq(tenantSubscriptions.id, row.id))

  // Tenant status is synchronised even when the subscription state did not
  // move: a redelivery of `subscription.charged` for an already-active
  // subscription is the cheapest possible repair for an account that somehow
  // drifted out of 'active', and setting a column to the value it already
  // holds costs nothing.
  if (tenantTarget) {
    await syncTenantStatus(tx, row.tenantId, tenantTarget)
  }

  // ── the audit trail (AROS-113) ────────────────────────────────────────────
  //
  // Written ONLY when the subscription status genuinely moved, in the SAME
  // transaction as the move. A redelivery that changes nothing writes nothing,
  // so the trail cannot be padded by replaying a webhook — which is what makes
  // it worth reading.
  if (!noStatusChange) {
    await recordSubscriptionAudit(tx, {
      tenantId: row.tenantId,
      subscriptionId: row.id,
      from: current,
      to: mapping.subscription,
      tenantStatus: tenantTarget,
      source: 'webhook',
      reason: incomingReason,
    })
  }

  if (noStatusChange && noPeriodChange && noPaymentChange) {
    return {
      kind: 'unchanged',
      subscriptionId: row.id,
      tenantId: row.tenantId,
      reason: 'already in this state',
    }
  }

  return {
    kind: 'applied',
    subscriptionId: row.id,
    tenantId: row.tenantId,
    from: current,
    to: mapping.subscription,
    tenantStatus: tenantTarget,
    planId: row.planId,
    billingPeriod: row.billingPeriod,
    periodStart,
    periodEnd,
    pastDueSince,
    suspendedAt,
  }
}

/**
 * Append one lifecycle transition to the EXISTING audit trail (AROS-113).
 *
 * `audit_log` (0018) is reused rather than duplicated: same append-only table,
 * same tenant scoping, same shape the refund path already writes. There is no
 * second history table for billing.
 *
 * ── Two things about the columns ────────────────────────────────────────────
 *
 * `actor_membership_id` is NULL, and that is the honest value: nobody in the
 * business did this. A renewal bouncing and a scheduled job suspending an
 * account have no human actor, and inventing one — the owner, say — would put a
 * person's name against a decision they did not make. The column is nullable
 * precisely so an entry can survive without one.
 *
 * `source` distinguishes the two paths that can move a subscription: a verified
 * gateway webhook, or the scheduled dunning processor. An operator reading the
 * trail after an argument about a suspension needs to know which.
 *
 * Written on the OWNER connection (the webhook and the job both have no
 * session, so RLS has no `app.user_id` to match). `audit_log` is granted
 * SELECT + INSERT to arena_app and nothing else, so this never widens what a
 * tenant can do: a business can READ its own trail and can neither add to it
 * nor erase from it.
 */
export async function recordSubscriptionAudit(
  tx: DB,
  params: {
    tenantId: string
    subscriptionId: string
    from: LocalSubscriptionStatus
    to: LocalSubscriptionStatus
    tenantStatus: LocalTenantStatus | null
    source: 'webhook' | 'dunning_job'
    reason?: string | null
  },
): Promise<void> {
  await tx.insert(auditLog).values({
    tenantId: params.tenantId,
    actorMembershipId: null,
    action: `subscription.${params.to}`,
    entityType: 'tenant_subscription',
    entityId: params.subscriptionId,
    before: { status: params.from },
    after: {
      status: params.to,
      // Null means "the account state was deliberately left alone" — the
      // documented outcome for `pending`, not a missing value.
      tenantStatus: params.tenantStatus,
      source: params.source,
      ...(params.reason ? { reason: params.reason } : {}),
    },
  })
}

/**
 * Move the ACCOUNT to the state the subscription implies.
 *
 * There is deliberately no second status system: this writes `tenants.status`,
 * the same column lib/actions/platform.ts's setCompanyStatus() writes and the
 * same one public_tenant_by_slug() (0022) reads to decide whether a venue's
 * public site resolves. Everything already keyed off tenant status therefore
 * picks this up with no further wiring.
 *
 * ── Unconditional, deliberately ─────────────────────────────────────────────
 * Every transition the mapping produces is applied, including
 * suspended → active (which is exactly what paying an overdue charge should do)
 * and cancelled → active.
 *
 * An earlier draft refused to lift an operator's manual cancellation, on the
 * theory that a stray webhook should not undo a human decision. That guard was
 * removed because it is worse than the problem: an account cancelled by hand
 * while its subscription is still being CHARGED would have been permanently
 * unrecoverable through billing, and the honest reading of a successful charge
 * is that the business is paying and should have service.
 *
 * The operational rule that replaces it: cancelling an account in platform
 * admin does not stop its subscription. Cancel the subscription too, or the
 * next successful charge will reassert 'active' — which is the correct
 * behaviour, since the money is real.
 *
 * The genuine "do not act" cases are handled upstream instead, where the
 * information to decide actually exists: a terminal local subscription is a
 * no-op, and a cancellation on a never-charged subscription leaves the account
 * alone.
 */
export async function syncTenantStatus(
  tx: DB,
  tenantId: string,
  status: LocalTenantStatus,
): Promise<void> {
  await tx.update(tenants).set({ status }).where(eq(tenants.id, tenantId))
}

/** The `gateway` discriminator for the PLATFORM's account. */
export const GATEWAY = 'razorpay' as const

/**
 * The `webhook_events.gateway` value for the PLATFORM stream.
 *
 * Deliberately NOT 'razorpay': the tenant deposit webhook already writes that,
 * and the unique index is on (gateway, event_id). Distinct values keep the two
 * accounts' delivery logs readable apart and make a cross-account event-id
 * collision impossible.
 */
export const WEBHOOK_GATEWAY = 'platform_razorpay' as const

export { LIVE_STATUSES }
