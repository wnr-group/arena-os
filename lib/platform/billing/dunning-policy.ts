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

/** Stages, in the order they occur. The same closed set migration 0082 CHECKs. */
export type DunningStage =
  | 'payment_failed'
  | 'grace_reminder'
  | 'final_warning'
  | 'suspended'
  | 'cancelled'

/**
 * WHERE A REMINDER'S CLOCK STARTS. Two anchors, because the notices answer two
 * different questions.
 *
 *   'arrears'     measured FORWARD from `past_due_since`. For "your payment
 *                 failed" — news that has to travel within days of the event,
 *                 whatever happens to the deadline afterwards.
 *
 *   'suspension'  measured BACKWARD from the instant the account will actually
 *                 be suspended. For "you will be suspended on <date>" — a
 *                 warning is only useful near the thing it warns about.
 *
 * ── Why this is not just `afterDays` any more ───────────────────────────────
 *
 * Every offset used to be forward from `past_due_since`, which was right while
 * suspension was always `past_due_since + graceDays`. Once suspension became
 * accessEndsAt() — deferred past a period the business had already paid for —
 * a "final warning" could arrive ten months before the suspension it named, and
 * then nothing more until the day itself. The dates in the notices were true;
 * the sequence had stopped meaning what its stage names say.
 *
 * With the default policy below the two anchors coincide exactly, so nothing
 * moves in the ordinary case: grace 7, reminders at suspension−7 / −4 / −1 are
 * days 0 / 3 / 6 of arrears, which is what they have always been.
 */
export type DunningAnchor = 'arrears' | 'suspension'

export type DunningReminder = {
  stage: Extract<DunningStage, 'payment_failed' | 'grace_reminder' | 'final_warning'>
  anchor: DunningAnchor
  /** Days after `past_due_since` ('arrears') or before suspension ('suspension'). */
  days: number
}

export type DunningPolicy = {
  /** Days from entering past_due to suspension, when no paid period outlasts it. */
  graceDays: number
  /** Days from suspension to cancellation. */
  suspensionDays: number
  /**
   * Reminder stages sent DURING grace. Ordered by when they fall in the DEFAULT
   * geometry (suspension at `past_due_since + graceDays`); each must be
   * strictly later than the last and strictly before suspension — a "final
   * warning" sent after the suspension it warns about is worse than none.
   */
  reminders: DunningReminder[]
}

export const DUNNING_POLICY: DunningPolicy = {
  graceDays: 7,
  suspensionDays: 14,
  reminders: [
    // Day 0 of arrears. Anchored forward on purpose: the webhook raises this one
    // the moment a charge bounces, and the job's copy is the catch-up if that
    // delivery never landed. Tying it to a deadline months away would leave a
    // business hearing nothing about a failed payment until then.
    { stage: 'payment_failed', anchor: 'arrears', days: 0 },
    // …and the two that name the date. In the default geometry these are days 3
    // and 6 of arrears, unchanged.
    { stage: 'grace_reminder', anchor: 'suspension', days: 4 },
    { stage: 'final_warning', anchor: 'suspension', days: 1 },
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
  // Both anchors are compared on ONE axis — days after `past_due_since` in the
  // DEFAULT geometry, where suspension is `past_due_since + graceDays`. That is
  // the only geometry in which the two anchors can be ordered against each
  // other at all, and it is the one an operator has in mind when authoring the
  // constant. A deferred suspension stretches the gaps but cannot reorder them:
  // 'suspension' offsets keep their relative order, and the 'arrears' day-0
  // notice is first by construction.
  let previous = -Infinity
  for (const r of policy.reminders) {
    if (!Number.isFinite(r.days) || r.days < 0) {
      throw new Error(`dunning policy: ${r.stage} days must be a non-negative number`)
    }
    const offset = r.anchor === 'arrears' ? r.days : policy.graceDays - r.days
    if (offset <= previous) {
      throw new Error('dunning policy: reminder offsets must be strictly increasing')
    }
    if (offset >= policy.graceDays) {
      throw new Error(`dunning policy: ${r.stage} would be sent at or after suspension`)
    }
    previous = offset
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

/**
 * WHEN A SUBSCRIPTION STOPS GRANTING ANYTHING — the single definition.
 *
 * ── Why this is one function and not four expressions ───────────────────────
 *
 * The rule has two clocks and they are combined with `max`, never with a
 * branch:
 *
 *   normally     `current_period_end` — the paid-for period.
 *   in past_due  the LATER of that and the grace deadline measured from
 *                `past_due_since`. A failed renewal leaves current_period_end
 *                in the PAST (Razorpay does not extend a period it could not
 *                charge for), so without the grace term a business would lose
 *                access the instant a charge bounced.
 *
 * `max` rather than "grace wins" because GRACE CAN ONLY EVER EXTEND. A
 * subscription whose paid period outlasts its grace window — an annual plan
 * whose mandate fails mid-term, or the inherited runway a plan change seeds
 * (lib/platform/billing/subscribe.ts) — keeps the access it has already paid
 * for.
 *
 * ── This used to be written out four times, and one copy disagreed ──────────
 *
 * readEntitlements(), getBillingPortal(), getBillingOverview() and the dunning
 * processor each decided expiry for themselves. The first three applied the
 * `max`; the processor did not — it suspended purely on `graceHasExpired()`.
 * So a business paid through to next year was suspended seven days after one
 * failed charge, its subscription left LIVE_STATUSES, and the `max` in the
 * other three became unreachable: they returned "no plan" for a plan that was
 * paid for. The account's public booking site went dark with it.
 *
 * Every one of those call sites now asks THIS function, so the reader and the
 * job cannot drift again.
 *
 * A `past_due` row with no `past_due_since` — possible only for a row written
 * before migration 0082 backfilled them — gets NO grace and falls back to the
 * period end. That is the fail-closed direction: an unknown clock grants
 * nothing.
 */
export type AccessClock = {
  currentPeriodEnd: Date
  status: string
  pastDueSince: Date | null
}

export function accessEndsAt(sub: AccessClock, policy: DunningPolicy = DUNNING_POLICY): Date {
  if (sub.status !== 'past_due' || !sub.pastDueSince) return sub.currentPeriodEnd
  const grace = graceEndsAt(sub.pastDueSince, policy)
  return grace.getTime() > sub.currentPeriodEnd.getTime() ? grace : sub.currentPeriodEnd
}

/**
 * The same boundary rule as `graceHasExpired`: access ends AT the deadline.
 *
 * So there is no instant in which the dunning job considers a tenant suspended
 * while the entitlement reader still grants it a plan, and none in which the
 * reverse holds either.
 */
export function accessHasEnded(
  sub: AccessClock,
  now: Date,
  policy: DunningPolicy = DUNNING_POLICY,
): boolean {
  return now.getTime() >= accessEndsAt(sub, policy).getTime()
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
export function reminderDueAt(
  reminder: DunningReminder,
  pastDueSince: Date,
  suspendsAt: Date,
): Date {
  return reminder.anchor === 'arrears'
    ? addDays(pastDueSince, reminder.days)
    : addDays(suspendsAt, -reminder.days)
}

/**
 * `suspendsAt` is the instant the account will ACTUALLY be suspended —
 * accessEndsAt(), not the bare grace deadline — so a warning that names a date
 * is sent near that date rather than near an assumption about it.
 */
export function remindersDue(
  pastDueSince: Date,
  suspendsAt: Date,
  now: Date,
  policy: DunningPolicy = DUNNING_POLICY,
): DunningStage[] {
  return policy.reminders
    .filter((r) => now.getTime() >= reminderDueAt(r, pastDueSince, suspendsAt).getTime())
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
  /**
   * When the account is actually suspended — which is `accessEndsAt()`, not the
   * bare grace deadline, so the banner cannot promise a suspension date the job
   * will not act on. Kept under its original name because it is what every
   * surface already renders.
   */
  graceEndsAt: Date
  /** Null until the account is actually suspended. */
  cancelsAt: Date | null
}

/**
 * NAMED arguments, not positional. Three of the four are nullable dates of the
 * same type, so a caller that got the order wrong would compile cleanly and
 * quote the wrong deadline at a business — and `policy`, which existed as the
 * third parameter before `paidThrough` was added, would have been silently
 * accepted in its place.
 *
 * `paidThrough` is the subscription's `current_period_end`, and is passed ONLY
 * for a row still in `past_due` — the state in which grace can be outlasted by
 * a period the business paid for. For a row that has already been suspended or
 * cancelled the grace window is history, so callers omit it and get the
 * historical grace end back.
 */
export function deadlinesFor(args: {
  pastDueSince: Date | null
  suspendedAt: Date | null
  paidThrough?: Date | null
  policy?: DunningPolicy
}): DunningDeadlines | null {
  const { pastDueSince, suspendedAt, paidThrough = null, policy = DUNNING_POLICY } = args
  if (!pastDueSince) return null
  return {
    graceEndsAt: paidThrough
      ? accessEndsAt(
          { currentPeriodEnd: paidThrough, status: 'past_due', pastDueSince },
          policy,
        )
      : graceEndsAt(pastDueSince, policy),
    cancelsAt: suspendedAt ? cancellationDueAt(suspendedAt, policy) : null,
  }
}
