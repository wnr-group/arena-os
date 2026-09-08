import 'server-only'
import { and, desc, eq, inArray } from 'drizzle-orm'
import { ownerDb, type DB } from '@/db'
import { plans, tenantSubscriptions, tenants } from '@/db/schema'
import { round2 } from '@/lib/billing/pricing'
import { issueCreditNote } from './invoices'
import { cancelTenantSubscription, type CancelGateway } from './cancel'
import { GATEWAY, LIVE_STATUSES } from './lifecycle'
import { recordPlatformOverride, type PlatformActor } from './audit'

/**
 * PLATFORM-ADMIN MANUAL OVERRIDES (AROS-114 §8) — extend trial, comp, force
 * cancel.
 *
 * The fourth override, CHANGE PLAN, is deliberately absent from this file. It
 * already exists as `assignPlan()` in lib/actions/plans.ts, complete with the
 * refusal that matters most (it will not touch a subscription backed by a live
 * Razorpay mandate, because rewriting the local row would leave the gateway
 * charging for a plan the business is no longer on). AROS-114 asked for that
 * flow to be reused and audited, so the audit entry was added THERE rather than
 * a second plan-change path being written here.
 *
 * The fifth, REFUND, lives in ./refunds.ts because it is the only one that
 * moves money and it needed a table.
 *
 * ── Every function here takes an ACTOR and writes exactly one audit entry ────
 *
 * In the SAME transaction as the change, through recordPlatformOverride().
 * There is no path that mutates a subscription and then separately tries to
 * remember it.
 *
 * ── And every one enforces its own guard at the action layer ────────────────
 *
 * These are domain functions on the OWNER connection; `requirePlatformAdmin()`
 * runs in lib/actions/platform-billing.ts, which is the only caller, and the
 * actor these take is resolved from the SESSION there — never from an argument
 * a browser could set.
 */

/** An override rule the admin should see verbatim. */
export class OverrideError extends Error {}

/** The live subscription an override acts on, read under a lock. */
type LiveSubscription = {
  id: string
  tenantId: string
  planId: string
  planName: string
  billingPeriod: 'monthly' | 'annual'
  status: string
  currentPeriodStart: Date
  currentPeriodEnd: Date
  currency: string
  gateway: string | null
  gatewaySubscriptionId: string | null
}

/**
 * The tenant's one live subscription, LOCKED.
 *
 * The same three statuses `idx_tenant_subscriptions_one_live` (0078) permits,
 * and the same "newest first" tiebreak every other reader in this codebase
 * uses, so an override acts on exactly the row the dashboard displayed.
 */
async function lockLiveSubscription(tx: DB, tenantId: string): Promise<LiveSubscription | null> {
  const [row] = await tx
    .select({
      id: tenantSubscriptions.id,
      tenantId: tenantSubscriptions.tenantId,
      planId: tenantSubscriptions.planId,
      planName: plans.name,
      billingPeriod: tenantSubscriptions.billingPeriod,
      status: tenantSubscriptions.status,
      currentPeriodStart: tenantSubscriptions.currentPeriodStart,
      currentPeriodEnd: tenantSubscriptions.currentPeriodEnd,
      currency: plans.currency,
      gateway: tenantSubscriptions.gateway,
      gatewaySubscriptionId: tenantSubscriptions.gatewaySubscriptionId,
    })
    .from(tenantSubscriptions)
    .innerJoin(plans, eq(plans.id, tenantSubscriptions.planId))
    .where(
      and(
        eq(tenantSubscriptions.tenantId, tenantId),
        inArray(tenantSubscriptions.status, [...LIVE_STATUSES]),
      ),
    )
    .orderBy(desc(tenantSubscriptions.currentPeriodStart))
    .for('update', { of: tenantSubscriptions })
    .limit(1)

  return row ?? null
}

/** The tenant must exist before anything is done to it. */
async function requireTenant(tx: DB, tenantId: string): Promise<{ id: string; name: string }> {
  const [row] = await tx
    .select({ id: tenants.id, name: tenants.name })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1)
  if (!row) throw new OverrideError('That company does not exist.')
  return row
}

// ── extend trial ─────────────────────────────────────────────────────────────

/** A sane ceiling. A year of free trial is a decision, not a button press. */
export const MAX_TRIAL_EXTENSION_DAYS = 365

export type ExtendTrialResult = {
  subscriptionId: string
  previousEnd: Date
  newEnd: Date
  days: number
}

/**
 * Give a trialing tenant more runway (AROS-114 §8).
 *
 * ── WHICH FIELD, AND WHY THERE IS NO NEW ONE ────────────────────────────────
 *
 * `tenant_subscriptions.current_period_end`. This schema has no separate
 * `trial_ends_at`, and it does not need one: a trial IS a subscription with
 * `status = 'trialing'`, and its end is its period end. That is the field
 * `readEntitlements()` (M16 #1) tests to decide whether the plan still grants
 * anything, so moving it is what actually extends the trial rather than merely
 * relabelling it. A new column would have to be taught to every one of those
 * readers, and the first one that was missed would silently expire a trial the
 * dashboard said was extended.
 *
 * ── REFUSED FOR A GATEWAY-BACKED SUBSCRIPTION, deliberately ─────────────────
 *
 * When Razorpay owns the mandate, `current_period_start/end` are SET from the
 * provider's own entity on every webhook (lib/platform/billing/lifecycle.ts —
 * "the period is SET from the entity's own current_start/current_end, never
 * advanced by adding a month locally"). A local extension would survive exactly
 * until the next delivery and then vanish, leaving an operator certain they had
 * granted something they had not. Razorpay's own trial length is set when the
 * subscription is created and cannot be moved afterwards, so this refuses and
 * says so instead of pretending.
 *
 * ── The new end is measured from NOW when the trial has already lapsed ──────
 *
 * `max(currentPeriodEnd, now) + days`. Adding to a date in the past would grant
 * a trial that had already expired a still-expired date — technically an
 * extension, practically useless, and the operator would have to work out the
 * arithmetic themselves to notice.
 */
export async function extendTenantTrial(
  actor: PlatformActor,
  params: { tenantId: string; days: number; reason?: string },
  db: DB = ownerDb,
): Promise<ExtendTrialResult> {
  const days = Math.trunc(params.days)
  if (!Number.isFinite(days) || days <= 0) {
    throw new OverrideError('Enter a number of days greater than zero.')
  }
  if (days > MAX_TRIAL_EXTENSION_DAYS) {
    throw new OverrideError(`A trial can be extended by at most ${MAX_TRIAL_EXTENSION_DAYS} days.`)
  }

  return db.transaction(async (tx) => {
    await requireTenant(tx, params.tenantId)
    const live = await lockLiveSubscription(tx, params.tenantId)
    if (!live) throw new OverrideError('This company has no live subscription to extend.')

    if (live.status !== 'trialing') {
      throw new OverrideError(
        `This subscription is ${live.status.replace('_', ' ')}, not a trial. Extending a paid period would give away a billing cycle — issue a comp instead.`,
      )
    }
    if (live.gatewaySubscriptionId && live.gateway === GATEWAY) {
      throw new OverrideError(
        'This trial is managed by Razorpay. The next webhook would overwrite any local extension — issue a comp against the first invoice instead.',
      )
    }

    const now = new Date()
    const from = live.currentPeriodEnd.getTime() > now.getTime() ? live.currentPeriodEnd : now
    const newEnd = new Date(from.getTime() + days * 86_400_000)

    await tx
      .update(tenantSubscriptions)
      .set({ currentPeriodEnd: newEnd })
      .where(
        and(
          eq(tenantSubscriptions.id, live.id),
          // Belt and braces beside the row lock: no shape of call can move a
          // different tenant's subscription.
          eq(tenantSubscriptions.tenantId, params.tenantId),
        ),
      )

    await recordPlatformOverride(tx, actor, {
      tenantId: params.tenantId,
      action: 'extend_trial',
      entityType: 'tenant_subscription',
      entityId: live.id,
      before: {
        status: live.status,
        planName: live.planName,
        currentPeriodEnd: live.currentPeriodEnd.toISOString(),
      },
      after: {
        status: live.status,
        planName: live.planName,
        currentPeriodEnd: newEnd.toISOString(),
        days,
        ...(params.reason?.trim() ? { reason: params.reason.trim() } : {}),
      },
    })

    return {
      subscriptionId: live.id,
      previousEnd: live.currentPeriodEnd,
      newEnd,
      days,
    }
  })
}

// ── comp / discount ──────────────────────────────────────────────────────────

/** A sane ceiling on a single comp, in rupees. */
export const MAX_COMP_AMOUNT = 1_000_000

export type CompResult = {
  creditNoteId: string
  creditNoteNumber: string
  amount: number
  currency: string
}

/**
 * Comp or discount a tenant (AROS-114 §8).
 *
 * ══ THE MODEL ALREADY EXISTED, AND IT IS A CREDIT NOTE ══════════════════════
 *
 * This was the single most important finding of the inspection. AROS-114 says
 * "inspect whether the current model already supports discounts, credits, comp
 * periods or zero-price subscriptions… do NOT add a second discount system."
 * It supports credits, fully, and has since AROS-4 (migration 0080):
 *
 *   issueCreditNote()         raises a positive-valued credit note against the
 *                             tenant, status 'issued' = outstanding.
 *                             It STAYS outstanding until an operator settles
 *                             it — nothing auto-applies a note to a later
 *                             invoice, because nothing reduces what Razorpay
 *                             charges, so netting it off a document would bill
 *                             less than was captured. See ./proration.ts.
 *
 * That is a complete, GST-correct, already-tested discount mechanism, built for
 * proration and entirely general. A comp is the same object with a different
 * reason written on it. Adding a `discounts` table, a coupon model, or a
 * zero-price subscription would have been a second money model competing with
 * this one for the same job — and the two would have disagreed the first time
 * anyone changed a plan mid-comp.
 *
 * ══ WHEN THE COMP APPLIES — the documented decision ═════════════════════════
 *
 * TO THE NEXT INVOICE, not to a period and not retroactively.
 *
 *   * It is NOT a refund. Nothing is paid back for a charge already taken; that
 *     is ./refunds.ts, which moves real money and is a different decision.
 *   * It is NOT a comp PERIOD. There is no "free until March" state, because
 *     representing one would need a second thing for readEntitlements() to
 *     consult and a second way for a subscription to be alive. An operator
 *     wanting three free months issues a comp worth three months, or extends
 *     the trial.
 *   * IT DOES NOT APPLY ITSELF. A comp raises a credit note and stops there.
 *     Discharging it is a separate, deliberate act — refund the customer, or
 *     leave the obligation standing and visible on their billing page. An
 *     earlier build auto-consumed notes against the next invoice; that made the
 *     document disagree with the money captured, so it was removed. See
 *     ./proration.ts for the full reasoning.
 *
 * ══ It needs a live subscription ════════════════════════════════════════════
 *
 * A credit note carries the plan and the period it relates to (GST wants a
 * credit note to reference something), and `platform_invoices.subscription_id`
 * is NOT NULL. A tenant with no live subscription has nothing to credit
 * against — assign a plan first.
 */
export async function compTenant(
  actor: PlatformActor,
  params: { tenantId: string; amount: number; reason: string },
  db: DB = ownerDb,
): Promise<CompResult> {
  const amount = round2(params.amount)
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new OverrideError('Enter a comp amount greater than zero.')
  }
  if (amount > MAX_COMP_AMOUNT) {
    throw new OverrideError(`A single comp may not exceed ${MAX_COMP_AMOUNT}.`)
  }
  const reason = params.reason.trim()
  if (!reason) throw new OverrideError('A reason is required.')
  if (reason.length > 500) throw new OverrideError('That reason is too long (max 500).')

  return db.transaction(async (tx) => {
    await requireTenant(tx, params.tenantId)
    const live = await lockLiveSubscription(tx, params.tenantId)
    if (!live) {
      throw new OverrideError(
        'This company has no live subscription, so there is nothing to credit against. Assign a plan first.',
      )
    }

    // The EXISTING credit-note writer, unchanged. Same numbering series, same
    // GST split, same letterhead snapshot, same `issued` status the proration
    // path produces — so a comp and a proration credit are indistinguishable to
    // everything downstream, which is exactly what makes this reuse and not a
    // parallel system.
    const note = await issueCreditNote(tx, {
      tenantId: params.tenantId,
      subscriptionId: live.id,
      planId: live.planId,
      billingPeriodType: live.billingPeriod,
      billingPeriodStart: live.currentPeriodStart,
      billingPeriodEnd: live.currentPeriodEnd,
      grossAmount: amount,
      currency: live.currency,
      // Prefixed so an operator reading a credit note months later can tell a
      // goodwill comp from an automatic proration credit at a glance.
      reason: `Comp: ${reason}`,
    })

    if (!note) throw new OverrideError('The comp amount rounded to zero.')

    await recordPlatformOverride(tx, actor, {
      tenantId: params.tenantId,
      action: 'comp_or_discount',
      entityType: 'tenant_subscription',
      entityId: live.id,
      before: {
        planName: live.planName,
        billingPeriod: live.billingPeriod,
        status: live.status,
      },
      after: {
        creditNoteId: note.id,
        creditNoteNumber: note.invoiceNumber,
        amount,
        currency: live.currency,
        reason,
        appliesTo: 'next_invoice',
      },
    })

    return {
      creditNoteId: note.id,
      creditNoteNumber: note.invoiceNumber,
      amount: round2(Number(note.total)),
      currency: live.currency,
    }
  })
}

// ── force cancel ─────────────────────────────────────────────────────────────

export type ForceCancelResult = {
  subscriptionId: string
  /** true = access runs to the end of the paid period; false = ended now. */
  atPeriodEnd: boolean
  currentPeriodEnd: Date
  gatewayBacked: boolean
}

/**
 * Force-cancel a tenant's subscription (AROS-114 §8).
 *
 * ══ TIMING — the documented decision ════════════════════════════════════════
 *
 * The DEFAULT is the existing rule, unchanged, from
 * lib/platform/billing/cancel.ts:
 *
 *     a subscription that HAS been charged  → cancels at the end of the paid period
 *     a subscription never charged          → cancels immediately
 *
 * The business paid for the month it is in, and support ending it early would
 * be taking money for service not delivered. Every rule in this codebase leans
 * the same way (past_due keeps working, a retired plan keeps its subscribers, a
 * downgrade deletes nothing).
 *
 * `immediate: true` overrides it, and exists because support genuinely needs
 * it — a fraudulent signup, a chargeback, a business that has asked for service
 * to stop today. It is a platform-admin-only parameter with no route from the
 * owner portal, and the audit entry records WHICH of the two was used, so
 * "why did their access stop on the 3rd?" has an answer.
 *
 * ══ THE GATEWAY IS TOLD FIRST ═══════════════════════════════════════════════
 *
 * For a Razorpay-backed subscription this delegates to the EXISTING
 * cancelTenantSubscription(), which calls the gateway before touching anything
 * locally — marking a row cancelled while its mandate lives would leave
 * Razorpay quietly charging a business whose subscription we had closed. The
 * webhook then remains the source of truth for the final state.
 *
 * ══ THE ACCOUNT IS NOT CLOSED ═══════════════════════════════════════════════
 *
 * `tenants.status` is deliberately NOT touched. Cancelling a SUBSCRIPTION and
 * closing an ACCOUNT are two decisions; `setCompanyStatus()` is the second one
 * and already exists. 0079's header states the same separation from the other
 * direction ("cancelling an account in platform admin does not stop its
 * subscription"), and the lifecycle already applies exactly this rule to an
 * uncharged subscription — `wasPaid === false` leaves the tenant alone. Where a
 * charged, gateway-backed subscription IS cancelled, the resulting
 * `subscription.cancelled` webhook closes the account through the normal path,
 * so the two routes agree without this function second-guessing either.
 *
 * ══ NOTHING IS DELETED ══════════════════════════════════════════════════════
 *
 * The subscription row stays (it is `restrict`-referenced by every invoice it
 * explains), the invoices stay, the credit notes stay, the refunds stay, the
 * dunning notices stay, the audit trail stays.
 */
export async function forceCancelTenantSubscription(
  actor: PlatformActor,
  params: { tenantId: string; immediate?: boolean; reason?: string },
  gateway?: CancelGateway,
  db: DB = ownerDb,
): Promise<ForceCancelResult> {
  // Read (without locking) first, to decide which path this is. The gateway
  // path must not hold a transaction open across an HTTP call, and the local
  // path re-reads under a lock before it writes.
  const [peek] = await db
    .select({
      id: tenantSubscriptions.id,
      status: tenantSubscriptions.status,
      planId: tenantSubscriptions.planId,
      currentPeriodEnd: tenantSubscriptions.currentPeriodEnd,
      gateway: tenantSubscriptions.gateway,
      gatewaySubscriptionId: tenantSubscriptions.gatewaySubscriptionId,
    })
    .from(tenantSubscriptions)
    .where(
      and(
        eq(tenantSubscriptions.tenantId, params.tenantId),
        inArray(tenantSubscriptions.status, [...LIVE_STATUSES]),
      ),
    )
    .orderBy(desc(tenantSubscriptions.currentPeriodStart))
    .limit(1)

  if (!peek) throw new OverrideError('This company has no live subscription to cancel.')

  const gatewayBacked = Boolean(peek.gatewaySubscriptionId) && peek.gateway === GATEWAY

  if (gatewayBacked) {
    // THE EXISTING FLOW, unchanged. It calls Razorpay first and refuses to
    // close a row the gateway did not accept a cancellation for.
    const result = gateway
      ? await cancelTenantSubscription(params.tenantId, gateway, db, {
          immediate: params.immediate,
        })
      : await cancelTenantSubscription(params.tenantId, undefined, db, {
          immediate: params.immediate,
        })

    await db.transaction(async (tx) => {
      await recordPlatformOverride(tx, actor, {
        tenantId: params.tenantId,
        action: 'force_cancel',
        entityType: 'tenant_subscription',
        entityId: peek.id,
        before: {
          status: peek.status,
          currentPeriodEnd: peek.currentPeriodEnd.toISOString(),
          gatewayBacked: true,
        },
        after: {
          // NOT 'cancelled' — for an at-period-end cancellation the row is
          // still live and only the intent is recorded. The audit says what
          // actually happened, not what was asked for.
          atPeriodEnd: result.atPeriodEnd,
          immediate: Boolean(params.immediate),
          effectiveAt: result.currentPeriodEnd.toISOString(),
          gatewayBacked: true,
          ...(params.reason?.trim() ? { reason: params.reason.trim() } : {}),
        },
      })
    })

    return {
      subscriptionId: peek.id,
      atPeriodEnd: result.atPeriodEnd,
      currentPeriodEnd: result.currentPeriodEnd,
      gatewayBacked: true,
    }
  }

  // ── admin-assigned, no mandate ────────────────────────────────────────────
  //
  // There is no gateway object to cancel and no money to stop, so this closes
  // the local row immediately. cancelTenantSubscription() refuses this case by
  // design ("Contact Arena OS support to change it") — and this IS support.
  return db.transaction(async (tx) => {
    const live = await lockLiveSubscription(tx, params.tenantId)
    if (!live) throw new OverrideError('This company has no live subscription to cancel.')
    if (live.gatewaySubscriptionId && live.gateway === GATEWAY) {
      // A mandate appeared between the peek and the lock. Refuse rather than
      // close a row whose gateway has not been told.
      throw new OverrideError('A Razorpay subscription was created for this company. Try again.')
    }

    const now = new Date()
    await tx
      .update(tenantSubscriptions)
      .set({
        status: 'cancelled',
        // tenant_subscriptions_cancelled_at (0078) CHECKs that this is set if
        // and only if status = 'cancelled', so the two move in one statement.
        cancelledAt: now,
        cancelAtPeriodEnd: false,
      })
      .where(
        and(
          eq(tenantSubscriptions.id, live.id),
          eq(tenantSubscriptions.tenantId, params.tenantId),
        ),
      )

    await recordPlatformOverride(tx, actor, {
      tenantId: params.tenantId,
      action: 'force_cancel',
      entityType: 'tenant_subscription',
      entityId: live.id,
      before: {
        status: live.status,
        planName: live.planName,
        currentPeriodEnd: live.currentPeriodEnd.toISOString(),
        gatewayBacked: false,
      },
      after: {
        status: 'cancelled',
        atPeriodEnd: false,
        immediate: true,
        cancelledAt: now.toISOString(),
        gatewayBacked: false,
        ...(params.reason?.trim() ? { reason: params.reason.trim() } : {}),
      },
    })

    return {
      subscriptionId: live.id,
      atPeriodEnd: false,
      currentPeriodEnd: live.currentPeriodEnd,
      gatewayBacked: false,
    }
  })
}
