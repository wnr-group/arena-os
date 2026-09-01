/**
 * THE DUNNING POLICY (AROS-113) — every duration, in one file, once.
 *
 * Deliberately NOT `import 'server-only'`. It holds numbers and pure date
 * arithmetic, no credential and no database handle, and the owner billing
 * banner needs the same deadlines the scheduled job acts on. One definition
 * shared is what stops a page saying "suspended on the 14th" while the job
 * suspends on the 12th.
 *
 * ═══ THE POLICY ════════════════════════════════════════════════════════════
 *
 *   day 0   renewal charge fails
 *           → subscription past_due, tenant stays ACTIVE, grace starts
 *           → reminder: "payment failed"
 *   day 3   → reminder: "grace reminder"
 *   day 6   → reminder: "final warning — suspension tomorrow"
 *   day 7   grace expires with no successful charge
 *           → subscription expired, tenant SUSPENDED
 *           → reminder: "suspended"
 *   day 21  fourteen days suspended with no successful charge
 *           → subscription cancelled, tenant CANCELLED
 *           → reminder: "cancelled"
 *
 * At ANY point before day 21, a successful charge returns the subscription to
 * `active` and the tenant to `active`. See RECOVERY below.
 *
 * ═══ WHY THESE NUMBERS ═════════════════════════════════════════════════════
 *
 * ── 7 days of grace, because that is Razorpay's own retry window ────────────
 *
 * THIS APPLICATION DOES NOT RETRY CHARGES. Razorpay Subscriptions does its own
 * retries: a failed renewal moves the subscription to `pending`, Razorpay
 * re-attempts it on its own schedule, and only when those attempts are
 * exhausted does it move the subscription to `halted`. Building a second retry
 * engine here would mean two systems taking money from one mandate on two
 * schedules, which is how a business gets charged twice for one month.
 *
 * So the grace period is not a retry schedule — it is a DEADLINE on Razorpay's.
 * Seven days comfortably contains Razorpay's default retry sequence, so in the
 * ordinary case the gateway itself resolves the arrears (a retry succeeds →
 * `subscription.charged` → active; or the retries are exhausted →
 * `subscription.halted` → suspended) and this clock never fires at all.
 *
 * The clock exists for the case the webhook path cannot cover: a delivery that
 * never arrives, a subscription Razorpay leaves `pending` indefinitely, an
 * outage during the one delivery that mattered. Without it, a single dropped
 * webhook means a business keeps its plan forever without paying. AROS-113's
 * "do not rely only on the frontend being opened for lifecycle transitions" is
 * the same instinct applied one layer further out: do not rely only on a
 * webhook arriving, either.
 *
 * ── 3 reminders, at 0 / 3 / 6 ───────────────────────────────────────────────
 *
 * One at the start (so the failure is not a surprise), one in the middle (so a
 * missed first message is not fatal), one the day before suspension (so the
 * consequence is stated before it happens). Spaced so a business that reads
 * none of them still cannot claim it was not told.
 *
 * ── 14 days suspended before cancellation ───────────────────────────────────
 *
 * Suspension is reversible and cancellation is not (`cancelled` is TERMINAL in
 * lib/platform/billing/lifecycle.ts — nothing moves a row out of it). Two weeks
 * is a working fortnight for a business owner to notice a dark public booking
 * site, find the email, and re-authorise a card. Cancelling faster would trade a
 * few days of a suspended account for an irreversible close, which is the wrong
 * trade in the wrong direction.
 *
 * ── RECOVERY: yes, from suspension too ──────────────────────────────────────
 *
 *     past_due  → active   YES
 *     suspended → active   YES
 *     cancelled → active   NO
 *
 * The first two need no new code: a successful charge is a
 * `subscription.charged` with an `active` entity, and applySubscriptionState()
 * already maps that to subscription `active` + tenant `active` from ANY
 * non-terminal state. syncTenantStatus() is deliberately unconditional and
 * already documents why ("the honest reading of a successful charge is that the
 * business is paying and should have service"). Dunning adds only the clearing
 * of past_due_since / suspended_at, so a recovered account carries no stale
 * deadline that would re-suspend it.
 *
 * The third is refused by the same rule that has always protected this schema:
 * a `cancelled` subscription is terminal, so a late webhook cannot resurrect a
 * closed account. Recovering from cancellation means choosing a plan again,
 * which creates a NEW subscription — and the old row, its invoices and its
 * dunning notices all stay exactly where they are.
 *
 * ═══ CHANGING THESE NUMBERS ════════════════════════════════════════════════
 *
 * Edit them here and nowhere else. They are plain constants rather than
 * environment variables on purpose: a grace period that differs between two
 * deployments — or between the banner's process and the job's process — is a
 * business promise that quietly changes, and a mis-typed env var would silently
 * suspend paying customers. Every function below takes an optional policy so a
 * test can drive the clock without touching the shipped values.
 */

/** Stages, in the order they occur. The same closed set migration 0053 CHECKs. */
export type DunningStage =
  | 'payment_failed'
  | 'grace_reminder'
  | 'final_warning'
  | 'suspended'
  | 'cancelled'

export type DunningPolicy = {
  /** Days from entering past_due to suspension. */
  graceDays: number
  /** Days from suspension to cancellation. */
  suspensionDays: number
  /**
   * Reminder stages sent DURING grace, each with its offset in days from
   * past_due_since. Must be strictly increasing and strictly less than
   * graceDays — a "final warning" sent after the suspension it warns about is
   * worse than none.
   */
  reminders: { stage: Extract<DunningStage, 'payment_failed' | 'grace_reminder' | 'final_warning'>; afterDays: number }[]
}

export const DUNNING_POLICY: DunningPolicy = {
  graceDays: 7,
  suspensionDays: 14,
  reminders: [
    { stage: 'payment_failed', afterDays: 0 },
    { stage: 'grace_reminder', afterDays: 3 },
    { stage: 'final_warning', afterDays: 6 },
  ],
}

const MS_PER_DAY = 86_400_000

/**
 * Assert a policy is internally coherent.
 *
 * Called by the scheduled processor before it does anything. A policy whose
 * final warning lands after its own suspension would produce a job that warns
 * businesses it has already suspended — cheap to check, and the check runs
 * where a hand-edited constant would first do damage.
 */
export function assertPolicy(policy: DunningPolicy = DUNNING_POLICY): void {
  if (!Number.isFinite(policy.graceDays) || policy.graceDays < 0) {
    throw new Error('dunning policy: graceDays must be a non-negative number')
  }
  if (!Number.isFinite(policy.suspensionDays) || policy.suspensionDays < 0) {
    throw new Error('dunning policy: suspensionDays must be a non-negative number')
  }
  let previous = -Infinity
  for (const r of policy.reminders) {
    if (!Number.isFinite(r.afterDays) || r.afterDays < 0) {
      throw new Error(`dunning policy: ${r.stage} afterDays must be a non-negative number`)
    }
    if (r.afterDays <= previous) {
      throw new Error('dunning policy: reminder offsets must be strictly increasing')
    }
    if (r.afterDays >= policy.graceDays) {
      throw new Error(`dunning policy: ${r.stage} would be sent at or after suspension`)
    }
    previous = r.afterDays
  }
}

function addDays(from: Date, days: number): Date {
  return new Date(from.getTime() + days * MS_PER_DAY)
}

/**
 * When grace runs out for a subscription that entered past_due at `pastDueSince`.
 *
 * The suspension is due when NOW IS AT OR AFTER this instant — see
 * `graceHasExpired` below for the boundary rule, which is stated once so the
 * job, the banner and the tests cannot disagree about the exact millisecond.
 */
export function graceEndsAt(pastDueSince: Date, policy: DunningPolicy = DUNNING_POLICY): Date {
  return addDays(pastDueSince, policy.graceDays)
}

/** When a suspended subscription is cancelled, measured from `suspendedAt`. */
export function cancellationDueAt(
  suspendedAt: Date,
  policy: DunningPolicy = DUNNING_POLICY,
): Date {
  return addDays(suspendedAt, policy.suspensionDays)
}

/**
 * THE BOUNDARY RULE, defined once: a deadline is reached at `>=`, not `>`.
 *
 * At exactly `pastDueSince + graceDays`, the grace period is OVER. The tenant
 * had the whole window and it has elapsed. Defining it the other way would
 * leave a one-instant state that behaves differently from both its neighbours,
 * which is precisely the kind of edge a boundary test finds and a production
 * incident finds later.
 *
 * The entitlement reader applies the SAME rule from the other side (access ends
 * at `>=`), so there is no instant in which the job considers a tenant suspended
 * while the entitlement layer still grants it a plan.
 */
export function graceHasExpired(
  pastDueSince: Date,
  now: Date,
  policy: DunningPolicy = DUNNING_POLICY,
): boolean {
  return now.getTime() >= graceEndsAt(pastDueSince, policy).getTime()
}

/** Same boundary rule for the post-suspension window. */
export function cancellationIsDue(
  suspendedAt: Date,
  now: Date,
  policy: DunningPolicy = DUNNING_POLICY,
): boolean {
  return now.getTime() >= cancellationDueAt(suspendedAt, policy).getTime()
}

/**
 * The grace reminders whose moment has arrived, oldest first.
 *
 * Returns EVERY stage that is due, not just the newest. A job that was not run
 * for a week — a scheduler outage, a box that was down — must still send the
 * warnings it owes rather than skipping straight to the last one, and the
 * unique index on (subscription_id, dunning_cycle, stage) means the ones already
 * sent are silently skipped at insert time. So "catch up" and "do not repeat"
 * are both true without this function knowing anything about what was sent.
 */
export function remindersDue(
  pastDueSince: Date,
  now: Date,
  policy: DunningPolicy = DUNNING_POLICY,
): DunningStage[] {
  const elapsedMs = now.getTime() - pastDueSince.getTime()
  return policy.reminders
    .filter((r) => elapsedMs >= r.afterDays * MS_PER_DAY)
    .map((r) => r.stage)
}

/**
 * How the deadlines read to a human, for the owner-facing banner.
 *
 * Derived from the same functions the job uses. There is no second calculation
 * anywhere in the UI, which is the point of this module being importable from
 * both sides.
 */
export type DunningDeadlines = {
  graceEndsAt: Date
  /** Null until the account is actually suspended. */
  cancelsAt: Date | null
}

export function deadlinesFor(
  pastDueSince: Date | null,
  suspendedAt: Date | null,
  policy: DunningPolicy = DUNNING_POLICY,
): DunningDeadlines | null {
  if (!pastDueSince) return null
  return {
    graceEndsAt: graceEndsAt(pastDueSince, policy),
    cancelsAt: suspendedAt ? cancellationDueAt(suspendedAt, policy) : null,
  }
}
