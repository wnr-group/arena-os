import 'server-only'
import { and, eq, isNotNull, or } from 'drizzle-orm'
import { ownerDb, type DB } from '@/db'
import { tenantSubscriptions } from '@/db/schema'
import { RazorpayApiError } from '@/lib/payments/razorpay'
import {
  requirePlatformRazorpayCredentials,
  type PlatformRazorpayCredentials,
} from './credentials'
import { cancelRazorpaySubscription, type CancelSubscriptionFn } from './razorpay-subscriptions'
import { GATEWAY, recordSubscriptionAudit, syncTenantStatus } from './lifecycle'
import {
  assertPolicy,
  cancellationDueAt,
  cancellationIsDue,
  graceEndsAt,
  graceHasExpired,
  remindersDue,
  DUNNING_POLICY,
  type DunningPolicy,
} from './dunning-policy'
import { logDunningNotice, sendDunningNotice, type DunningNotifier } from './dunning-notify'

/**
 * THE SCHEDULED DUNNING PROCESSOR (AROS-113 §9) — the half of the lifecycle a
 * webhook cannot deliver.
 *
 * ── Why this exists when Razorpay already retries ───────────────────────────
 *
 * It does not retry anything. Razorpay Subscriptions owns the retries and this
 * application deliberately does not compete with them — see
 * ./dunning-policy.ts, which explains why a second retry engine is how a
 * business gets charged twice for one month.
 *
 * What this owns is the DEADLINE. Three things the webhook path cannot do on
 * its own:
 *
 *   1. suspend an account whose grace period ran out but whose
 *      `subscription.halted` never arrived — a dropped delivery, an outage
 *      during the one webhook that mattered, or a subscription Razorpay simply
 *      leaves `pending`. Without this, one lost webhook means a business keeps
 *      its plan forever without paying.
 *   2. send reminders, which are a function of ELAPSED TIME and therefore have
 *      no event to hang off.
 *   3. close a suspended subscription after the post-suspension window, which
 *      is a decision Arena OS makes and Razorpay knows nothing about.
 *
 * ── Safety properties, and how each is obtained ─────────────────────────────
 *
 * TENANT-SAFE. Every statement is keyed on one subscription id AND its own
 * tenant id, taken from the row we just read under lock — never from a caller.
 * The function takes no tenant argument at all, so there is no shape of call
 * that touches the wrong business.
 *
 * IDEMPOTENT. Re-running changes nothing that has already been done:
 *   * a suspension is only applied to a row still in `past_due`, so the second
 *     run finds `expired` and does nothing;
 *   * a cancellation is only applied to a row still in `expired`, and
 *     `cancelled` is TERMINAL everywhere in this codebase;
 *   * a reminder is claimed by a unique index before it is sent
 *     (./dunning-notify.ts), so an hourly schedule sends each stage once;
 *   * `past_due_since` and `suspended_at` are stamped `?? now` and never
 *     overwritten, so no clock restarts because a job ran twice.
 *
 * SAFE IF INTERRUPTED. One transaction PER SUBSCRIPTION, covering the status
 * change, the tenant status, the audit entry and the notice together. A crash
 * mid-run leaves each subscription either fully processed or entirely
 * untouched, and the next run resumes from exactly there. One subscription
 * that throws rolls back alone; the loop continues — the same "keep going,
 * report at the end" shape scripts/run-recurring-expenses.ts uses.
 *
 * CONCURRENCY-SAFE. The row is re-read `for update` inside its transaction, so
 * two overlapping runs serialise on it. The second one re-reads the state the
 * first committed and finds nothing to do.
 *
 * ── Why the owner connection ────────────────────────────────────────────────
 *
 * A scheduled job has no session, so `withUser()` has no `app.user_id` to set
 * and RLS has no predicate to match — the same narrow, documented exception the
 * two webhook handlers take, and the same one scripts/refresh-reports.ts and
 * scripts/run-recurring-expenses.ts already run under. It is contained the same
 * way: this module reads and writes exactly four tables, always by our own ids,
 * and exports no generic elevated-write helper. `arena_app` has no write grant
 * on tenant_subscriptions, tenants.status or platform_dunning_notices at all
 * (0078/0079/0081), so there is no non-owner path to add.
 */

/** What one run did. Every number is a count of ACTIONS TAKEN, not of rows seen. */
export type DunningRunSummary = {
  examined: number
  remindersSent: number
  suspended: number
  cancelled: number
  /** Subscriptions whose turn threw. The run continues past them. */
  failed: number
  /** Human-readable, for the script's output. Never a credential. */
  problems: string[]
}

export type DunningGateway = {
  cancelSubscription: CancelSubscriptionFn
  credentials?: () => Promise<PlatformRazorpayCredentials>
}

const DEFAULT_GATEWAY: DunningGateway = { cancelSubscription: cancelRazorpaySubscription }

export type ProcessDunningOptions = {
  db?: DB
  /** Injectable so tests can drive the clock. Production passes nothing. */
  now?: Date
  policy?: DunningPolicy
  notify?: DunningNotifier
  gateway?: DunningGateway
}

type Candidate = {
  id: string
  tenantId: string
  status: string
  pastDueSince: Date | null
  suspendedAt: Date | null
  gateway: string | null
  gatewaySubscriptionId: string | null
}

/**
 * Advance every subscription whose dunning clock has run out.
 *
 * Takes NO tenant id: it is a platform-wide sweep by construction, exactly like
 * the recurring-expense generator. Callers are the scheduled script and the
 * test suite; there is no HTTP surface and no server action, because a
 * lifecycle transition is not something a browser gets to trigger.
 */
export async function processDunning(
  options: ProcessDunningOptions = {},
): Promise<DunningRunSummary> {
  const {
    db = ownerDb,
    now = new Date(),
    policy = DUNNING_POLICY,
    notify = logDunningNotice,
    gateway = DEFAULT_GATEWAY,
  } = options

  // A hand-edited policy whose final warning lands after its own suspension
  // would warn businesses it has already suspended. Checked before any row is
  // touched, so a bad constant costs nothing.
  assertPolicy(policy)

  const summary: DunningRunSummary = {
    examined: 0,
    remindersSent: 0,
    suspended: 0,
    cancelled: 0,
    failed: 0,
    problems: [],
  }

  // ── the candidate scan ────────────────────────────────────────────────────
  //
  // Two populations, and nothing else:
  //   * `past_due` with a clock running — may owe reminders or a suspension;
  //   * `expired` that we ourselves suspended (`suspended_at` set) — may be due
  //     for cancellation.
  //
  // An `expired` row with no `suspended_at` reached that state some other way
  // (`completed`, or a mandate never authenticated) and is NOT a dunning case,
  // so it is excluded here rather than skipped later. `cancelled` is terminal
  // and never appears. `active`/`trialing` have had their clocks cleared.
  //
  // Ids only. The authoritative read happens inside each transaction, under a
  // lock, so a row that changed between the scan and its turn is handled
  // correctly rather than acted on from a stale snapshot.
  const candidates = await db
    .select({ id: tenantSubscriptions.id })
    .from(tenantSubscriptions)
    .where(
      and(
        isNotNull(tenantSubscriptions.pastDueSince),
        or(
          eq(tenantSubscriptions.status, 'past_due'),
          and(
            eq(tenantSubscriptions.status, 'expired'),
            isNotNull(tenantSubscriptions.suspendedAt),
          ),
        ),
      ),
    )
    .orderBy(tenantSubscriptions.pastDueSince)

  for (const { id } of candidates) {
    try {
      const outcome = await processOne(db, id, { now, policy, notify, gateway })
      summary.examined += 1
      summary.remindersSent += outcome.remindersSent
      summary.suspended += outcome.suspended ? 1 : 0
      summary.cancelled += outcome.cancelled ? 1 : 0
      if (outcome.problem) summary.problems.push(`${id}: ${outcome.problem}`)
    } catch (e) {
      // One subscription must never stop the rest of the run. The transaction
      // for this one has already rolled back, so it is left exactly as it was
      // and the next run retries it from the same state.
      summary.failed += 1
      summary.problems.push(`${id}: ${e instanceof Error ? e.name : 'unknown error'}`)
    }
  }

  return summary
}

type OneOutcome = {
  remindersSent: number
  suspended: boolean
  cancelled: boolean
  /** A non-fatal note for the run report. */
  problem?: string
}

async function processOne(
  db: DB,
  subscriptionId: string,
  ctx: {
    now: Date
    policy: DunningPolicy
    notify: DunningNotifier
    gateway: DunningGateway
  },
): Promise<OneOutcome> {
  const { now, policy, notify, gateway } = ctx

  // ── The gateway call happens OUTSIDE the transaction, and BEFORE it ────────
  //
  // Cancellation is the only step that talks to Razorpay, and it must be told
  // first: marking a subscription cancelled locally while its mandate is still
  // live would leave Razorpay quietly charging a business whose account we have
  // closed — the worst outcome available here, and the same reason
  // ./cancel.ts calls the gateway before it writes. Holding a transaction open
  // across a network call would also pin a row lock for the length of an HTTP
  // timeout.
  //
  // So this is a two-phase turn: read enough to decide, call the gateway if the
  // decision is "cancel", then open the transaction and re-read UNDER LOCK
  // before writing anything. The lock re-read is what makes the gap safe — if a
  // payment landed in between, the row is `active` by then and the cancellation
  // is abandoned.
  const [peek] = await db
    .select({
      id: tenantSubscriptions.id,
      status: tenantSubscriptions.status,
      suspendedAt: tenantSubscriptions.suspendedAt,
      gateway: tenantSubscriptions.gateway,
      gatewaySubscriptionId: tenantSubscriptions.gatewaySubscriptionId,
    })
    .from(tenantSubscriptions)
    .where(eq(tenantSubscriptions.id, subscriptionId))
    .limit(1)

  if (!peek) return { remindersSent: 0, suspended: false, cancelled: false }

  const wantsCancel =
    peek.status === 'expired' &&
    peek.suspendedAt !== null &&
    cancellationIsDue(peek.suspendedAt, now, policy)

  if (wantsCancel && peek.gatewaySubscriptionId && peek.gateway === GATEWAY) {
    const stop = await stopMandate(gateway, peek.gatewaySubscriptionId)
    if (!stop.ok) {
      // A transient gateway problem. NOTHING is written: cancelling locally
      // while the mandate may still be live is precisely the direction this
      // ordering exists to prevent. The next run retries from the same state.
      return {
        remindersSent: 0,
        suspended: false,
        cancelled: false,
        problem: `gateway cancel deferred (${stop.reason})`,
      }
    }
  }

  return db.transaction(async (tx) => {
    // The authoritative read. `for update` serialises this turn against a
    // concurrent job run AND against a webhook applying a payment.
    const [row] = await tx
      .select({
        id: tenantSubscriptions.id,
        tenantId: tenantSubscriptions.tenantId,
        status: tenantSubscriptions.status,
        pastDueSince: tenantSubscriptions.pastDueSince,
        suspendedAt: tenantSubscriptions.suspendedAt,
        gateway: tenantSubscriptions.gateway,
        gatewaySubscriptionId: tenantSubscriptions.gatewaySubscriptionId,
      })
      .from(tenantSubscriptions)
      .where(eq(tenantSubscriptions.id, subscriptionId))
      .for('update')
      .limit(1)

    if (!row) return { remindersSent: 0, suspended: false, cancelled: false }

    const candidate: Candidate = row
    // A payment landed while we were deciding, or an operator intervened. The
    // clocks are cleared by the webhook on recovery, so re-checking the state
    // here — not the snapshot above — is what makes the gap harmless.
    if (!candidate.pastDueSince) return { remindersSent: 0, suspended: false, cancelled: false }

    if (candidate.status === 'past_due') {
      return grace(tx, candidate, { now, policy, notify })
    }
    if (candidate.status === 'expired' && candidate.suspendedAt) {
      return afterSuspension(tx, candidate, { now, policy, notify })
    }
    // Anything else (recovered, cancelled, completed) is not this job's
    // business. Doing nothing is the correct outcome, not a skipped one.
    return { remindersSent: 0, suspended: false, cancelled: false }
  })
}

/**
 * A subscription in `past_due`: either the grace period has run out, or it owes
 * reminders.
 */
async function grace(
  tx: DB,
  row: Candidate,
  ctx: { now: Date; policy: DunningPolicy; notify: DunningNotifier },
): Promise<OneOutcome> {
  const { now, policy, notify } = ctx
  const pastDueSince = row.pastDueSince as Date
  const episodeEnds = graceEndsAt(pastDueSince, policy)

  if (graceHasExpired(pastDueSince, now, policy)) {
    // ── SUSPENSION ────────────────────────────────────────────────────────
    //
    // The two writes that make it real, in ONE transaction so there is no
    // window in which the subscription is dead but the account still resolves:
    //
    //   subscription → 'expired'  leaves LIVE_STATUSES, so readEntitlements()
    //                             returns the empty answer and every gate in
    //                             lib/platform/entitlement-guard.ts closes.
    //                             That is the WHOLE of enforcement — there is
    //                             no `if (tenant.status === 'suspended')`
    //                             anywhere in this codebase, by design.
    //   tenant       → 'suspended' makes public_tenant_by_slug() (0022) stop
    //                             resolving, so the venue's public booking site
    //                             goes dark.
    //
    // Deliberately the SAME pair `halted` maps to in ./lifecycle.ts. This path
    // is the timeout for when that webhook never arrives, not a second rule.
    //
    // NOTHING IS DELETED. No data, no invoice, no booking. A payment reverses
    // all of it on the next webhook — see ./dunning-policy.ts § RECOVERY.
    const suspendedAt = row.suspendedAt ?? now
    const moved = await tx
      .update(tenantSubscriptions)
      .set({ status: 'expired', suspendedAt })
      .where(
        and(
          eq(tenantSubscriptions.id, row.id),
          eq(tenantSubscriptions.tenantId, row.tenantId),
          // Only from `past_due`. The row lock above already guarantees this,
          // but stating it in the UPDATE means a future refactor that loosens
          // the lock cannot silently start suspending live subscriptions.
          eq(tenantSubscriptions.status, 'past_due'),
        ),
      )
      .returning({ id: tenantSubscriptions.id })

    // The guard matched nothing, so the subscription did NOT move. Everything
    // below — the account status, the audit entry, the notice — describes a
    // transition that did not happen, so none of it runs.
    if (moved.length === 0) return { remindersSent: 0, suspended: false, cancelled: false }

    await syncTenantStatus(tx, row.tenantId, 'suspended')
    await recordSubscriptionAudit(tx, {
      tenantId: row.tenantId,
      subscriptionId: row.id,
      from: 'past_due',
      to: 'expired',
      tenantStatus: 'suspended',
      source: 'dunning_job',
      reason: 'grace period expired',
    })

    // The grace reminders are NOT sent alongside this. A "your account will be
    // suspended tomorrow" arriving in the same minute as "your account has been
    // suspended" — which is what a job catching up after a week's outage would
    // otherwise produce — is worse than silence. The suspension notice says
    // everything those would have said, and says it accurately.
    const sent = await sendDunningNotice(
      tx,
      {
        tenantId: row.tenantId,
        subscriptionId: row.id,
        stage: 'suspended',
        dunningCycle: pastDueSince,
        graceEndsAt: episodeEnds,
        cancelsAt: cancellationDueAt(suspendedAt, policy),
      },
      notify,
    )

    return { remindersSent: sent ? 1 : 0, suspended: true, cancelled: false }
  }

  // ── STILL IN GRACE ────────────────────────────────────────────────────────
  //
  // The tenant is untouched and keeps working — `tenants.status` stays
  // 'active' and the subscription stays in LIVE_STATUSES, so entitlements
  // continue to be granted (readEntitlements() extends the effective expiry
  // across the grace window; see lib/platform/entitlements.ts). Only reminders
  // go out.
  //
  // EVERY due stage is sent, not just the newest: a job that did not run for
  // three days still owes the warnings it missed, and the unique index silently
  // drops the ones already delivered.
  let remindersSent = 0
  for (const stage of remindersDue(pastDueSince, now, policy)) {
    const sent = await sendDunningNotice(
      tx,
      {
        tenantId: row.tenantId,
        subscriptionId: row.id,
        stage,
        dunningCycle: pastDueSince,
        graceEndsAt: episodeEnds,
        cancelsAt: null,
      },
      notify,
    )
    if (sent) remindersSent += 1
  }

  return { remindersSent, suspended: false, cancelled: false }
}

/**
 * A subscription we suspended: cancel it once the post-suspension window has
 * elapsed, and otherwise leave it alone.
 */
async function afterSuspension(
  tx: DB,
  row: Candidate,
  ctx: { now: Date; policy: DunningPolicy; notify: DunningNotifier },
): Promise<OneOutcome> {
  const { now, policy, notify } = ctx
  const suspendedAt = row.suspendedAt as Date

  if (!cancellationIsDue(suspendedAt, now, policy)) {
    // Still inside the window. The 'suspended' notice already went out when the
    // account was suspended, so there is deliberately nothing to send here —
    // a daily "you are still suspended" is nagging, not dunning.
    return { remindersSent: 0, suspended: false, cancelled: false }
  }

  // ── CANCELLATION ──────────────────────────────────────────────────────────
  //
  // Razorpay was already told, before this transaction opened (see processOne).
  //
  // `cancelled_at` is required by tenant_subscriptions_cancelled_at (0078),
  // which CHECKs that it is set if and only if status = 'cancelled', so the two
  // must move in one statement. `cancel_at_period_end` is cleared because the
  // request — whoever made it — has now been honoured.
  //
  // The clocks are LEFT AS THEY ARE. `past_due_since` and `suspended_at` are
  // the history of how this subscription ended, and a cancelled row is history.
  //
  // NOTHING IS DELETED, and this is the rule AROS-113 states most firmly: the
  // tenant, its bookings, its own customer invoices, its platform invoices, its
  // payments, its audit entries and its dunning notices all remain. The
  // subscription row itself remains too — `platform_invoices.subscription_id`
  // is ON DELETE RESTRICT precisely so it cannot be removed out from under the
  // bills it explains.
  const moved = await tx
    .update(tenantSubscriptions)
    .set({ status: 'cancelled', cancelledAt: now, cancelAtPeriodEnd: false })
    .where(
      and(
        eq(tenantSubscriptions.id, row.id),
        eq(tenantSubscriptions.tenantId, row.tenantId),
        // Only from the suspended state we read. A late payment that reactivated
        // this subscription makes this match nothing.
        eq(tenantSubscriptions.status, 'expired'),
        isNotNull(tenantSubscriptions.suspendedAt),
      ),
    )
    .returning({ id: tenantSubscriptions.id })

  if (moved.length === 0) {
    // The row moved out from under us between the peek and the lock — which
    // means a payment landed AFTER we had already told Razorpay to stop the
    // mandate. Nothing local is changed (the account is paying and should keep
    // service), but the mandate is now dead and the next renewal will not be
    // attempted, so this is surfaced for an operator rather than swallowed.
    //
    // The window is the length of one HTTP call against a fourteen-day
    // deadline. It is not closed by holding a transaction across that call,
    // which would pin a row lock for the length of a gateway timeout.
    return {
      remindersSent: 0,
      suspended: false,
      cancelled: false,
      problem: 'recovered after the mandate was stopped — needs a fresh subscription',
    }
  }

  await syncTenantStatus(tx, row.tenantId, 'cancelled')
  await recordSubscriptionAudit(tx, {
    tenantId: row.tenantId,
    subscriptionId: row.id,
    from: 'expired',
    to: 'cancelled',
    tenantStatus: 'cancelled',
    source: 'dunning_job',
    reason: 'unpaid after suspension',
  })

  const sent = await sendDunningNotice(
    tx,
    {
      tenantId: row.tenantId,
      subscriptionId: row.id,
      stage: 'cancelled',
      dunningCycle: row.pastDueSince as Date,
      graceEndsAt: graceEndsAt(row.pastDueSince as Date, policy),
      cancelsAt: cancellationDueAt(suspendedAt, policy),
    },
    notify,
  )

  return { remindersSent: sent ? 1 : 0, suspended: false, cancelled: true }
}

/**
 * Stop the mandate at Razorpay before closing the subscription locally.
 *
 * Returns `ok` when the mandate is definitely not going to charge again —
 * either because Razorpay accepted the cancellation, or because it refused with
 * a NON-retriable error, which for this endpoint means the subscription is
 * already cancelled or unknown to it. Both are the state we wanted.
 *
 * Returns not-ok for a timeout, a 5xx, a 429, or missing platform credentials.
 * Those leave the mandate's state UNKNOWN, and the caller must not cancel
 * locally on an unknown — it defers to the next run instead.
 */
async function stopMandate(
  gateway: DunningGateway,
  gatewaySubscriptionId: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  let credentials: PlatformRazorpayCredentials
  try {
    credentials = await (gateway.credentials
      ? gateway.credentials()
      : requirePlatformRazorpayCredentials())
  } catch {
    // Not configured, or the stored secret will not decrypt. An operator
    // problem; deferring is right, because the mandate may well still be live.
    return { ok: false, reason: 'platform gateway unavailable' }
  }

  try {
    await gateway.cancelSubscription(credentials, gatewaySubscriptionId, false)
    return { ok: true }
  } catch (e) {
    if (e instanceof RazorpayApiError && !e.retriable) {
      // A 4xx: already cancelled, or Razorpay does not know this subscription.
      // Either way it will not charge again, which is all this needs.
      return { ok: true }
    }
    return { ok: false, reason: 'gateway unreachable' }
  }
}

/** Re-exported so the scheduled script has one import for the whole feature. */
export { DUNNING_POLICY }
