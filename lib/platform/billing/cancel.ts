import 'server-only'
import { and, desc, eq, inArray } from 'drizzle-orm'
import { ownerDb, type DB } from '@/db'
import { tenantSubscriptions } from '@/db/schema'
import {
  requirePlatformRazorpayCredentials,
  type PlatformRazorpayCredentials,
} from './credentials'
import { cancelRazorpaySubscription, type CancelSubscriptionFn } from './razorpay-subscriptions'
import { GATEWAY, LIVE_STATUSES, syncTenantStatus } from './lifecycle'
import { SubscriptionError } from './subscribe'

/**
 * Cancelling an Arena OS subscription.
 *
 * ── THE CHOSEN BEHAVIOUR ────────────────────────────────────────────────────
 *
 * The project's existing rules say nothing about cancellation timing — 0079
 * left the whole billing story out — so this establishes one, and states it
 * where an operator will find it:
 *
 *   A subscription that has been CHARGED cancels AT THE END OF THE PAID PERIOD.
 *   A subscription that has never been charged cancels IMMEDIATELY.
 *
 * The reason is simply that the business already paid for the month it is in.
 * Cutting access the instant someone clicks "cancel" would take money for
 * service not delivered, and every existing rule in this codebase leans the
 * other way (past_due keeps working; a retired plan keeps its subscribers; a
 * downgrade never deletes data). A subscription that was never authenticated
 * has no paid period to run out, and Razorpay rejects `cancel_at_cycle_end` on
 * one, so that case is immediate by both design and API.
 *
 * ── RAZORPAY IS TOLD FIRST, AND THE WEBHOOK IS STILL THE TRUTH ──────────────
 *
 * This calls Razorpay's cancel API before touching anything locally. Marking a
 * row cancelled without telling the gateway would leave a live mandate quietly
 * charging a business that believes it has stopped paying — the worst outcome
 * available here.
 *
 * What it does NOT do is flip the local status to 'cancelled' on the strength
 * of that call. For an at-cycle-end cancellation the subscription is genuinely
 * still active and still owed service, so only `cancel_at_period_end` is set;
 * `subscription.cancelled` from the webhook is what finally moves the status
 * and the account. For an immediate cancellation the same rule applies for the
 * same reason — the provider's own event is the record — but the local row is
 * closed out too, because an unauthenticated subscription will never be charged
 * again and leaving it live would block the tenant from subscribing afresh.
 */

export type CancelResult = {
  /** true = access continues until currentPeriodEnd; false = ended now. */
  atPeriodEnd: boolean
  currentPeriodEnd: Date
  /**
   * Whether `tenants.status` was moved to 'cancelled' — i.e. whether the
   * ACCOUNT was closed, not just the subscription.
   *
   * Reported rather than left to be inferred because the two paths that call
   * this differ on how much it matters. An owner cancelling their own paid
   * subscription is closing the relationship. A platform admin force-cancelling
   * is stopping a mandate, and closing the account takes the venue's public
   * booking site down with it (public_tenant_by_slug, 0022) — so
   * ./overrides.ts records this in the audit entry instead of leaving an
   * operator to discover it.
   */
  closedAccount: boolean
}

/**
 * Options a PLATFORM ADMIN may set that a business may not (AROS-114 §8).
 *
 * `immediate` overrides the at-the-end-of-the-paid-period rule documented
 * above. A business cancelling its own subscription always gets the period it
 * paid for — that is the fair rule and it is not negotiable from the tenant
 * side. Support sometimes has to stop a mandate NOW: a fraudulent signup, a
 * card dispute, a business that has asked for service to end today. That is a
 * different decision made by a different party, so it is a parameter here and
 * has no route from the owner billing portal.
 *
 * It is deliberately NOT the default. `forceCancelTenantSubscription()` in
 * ./overrides.ts passes it explicitly, and audits which of the two it used.
 */
export type CancelOptions = {
  immediate?: boolean
}

export type CancelGateway = {
  cancelSubscription: CancelSubscriptionFn
  credentials?: () => Promise<PlatformRazorpayCredentials>
}

const DEFAULT_GATEWAY: CancelGateway = { cancelSubscription: cancelRazorpaySubscription }

/**
 * Cancel the tenant's live gateway subscription.
 *
 * `tenantId` comes from the authenticated context, never from client input, and
 * every statement below filters on it — so there is no shape of call that
 * cancels another business's subscription.
 */
export async function cancelTenantSubscription(
  tenantId: string,
  gateway: CancelGateway = DEFAULT_GATEWAY,
  db: DB = ownerDb,
  options: CancelOptions = {},
): Promise<CancelResult> {
  const [live] = await db
    .select({
      id: tenantSubscriptions.id,
      status: tenantSubscriptions.status,
      gateway: tenantSubscriptions.gateway,
      gatewaySubscriptionId: tenantSubscriptions.gatewaySubscriptionId,
      currentPeriodEnd: tenantSubscriptions.currentPeriodEnd,
      cancelAtPeriodEnd: tenantSubscriptions.cancelAtPeriodEnd,
      // Whether this subscription was ever CHARGED — the same test
      // applySubscriptionState() makes before it closes an account, read from
      // our own record rather than from any payload. See the immediate branch.
      lastPaymentId: tenantSubscriptions.gatewayLastPaymentId,
    })
    .from(tenantSubscriptions)
    .where(
      and(
        eq(tenantSubscriptions.tenantId, tenantId),
        inArray(tenantSubscriptions.status, [...LIVE_STATUSES]),
      ),
    )
    .orderBy(desc(tenantSubscriptions.currentPeriodStart))
    .limit(1)

  if (!live) throw new SubscriptionError('There is no active subscription to cancel.')

  if (!live.gatewaySubscriptionId || live.gateway !== GATEWAY) {
    // An admin-assigned plan (0079's assignPlan) has no gateway object, so
    // there is nothing to cancel at Razorpay. Ending it is an operator action,
    // not a self-serve one — there is no money to stop.
    throw new SubscriptionError(
      'This plan was assigned by Arena OS and has no payment subscription. Contact Arena OS support to change it.',
    )
  }

  if (live.cancelAtPeriodEnd && !options.immediate) {
    // Already requested. Answer with the same shape rather than calling
    // Razorpay again — a second cancel on an already-cancelling subscription is
    // an error there, and this is the honest reply anyway.
    //
    // An IMMEDIATE cancel falls through deliberately: "it is already winding
    // down" is not an answer to support being told to stop it today, and
    // Razorpay accepts cancel_at_cycle_end=0 on a subscription that is
    // scheduled to end later.
    return { atPeriodEnd: true, currentPeriodEnd: live.currentPeriodEnd, closedAccount: false }
  }

  // Only a subscription Razorpay considers active has a cycle to run out —
  // unless a platform admin has explicitly asked for it to stop now.
  const atCycleEnd = options.immediate ? false : live.status === 'active'

  // "Was this relationship ever paid for?" — read from OUR record, never from a
  // payload, exactly as applySubscriptionState() reads it. `past_due` counts:
  // arrears are what happens to a subscription that HAS been charged and then
  // failed to renew.
  const wasPaid =
    live.status === 'active' || live.status === 'past_due' || live.lastPaymentId !== null

  const credentials = await (gateway.credentials
    ? gateway.credentials()
    : requirePlatformRazorpayCredentials())

  // Razorpay first. If this throws, nothing local has changed and the mandate
  // is still exactly as the tenant left it.
  await gateway.cancelSubscription(credentials, live.gatewaySubscriptionId, atCycleEnd)

  await db.transaction(async (tx) => {
    if (atCycleEnd) {
      // The subscription stays live and the tenant stays exactly as it is. Only
      // the intent is recorded; subscription.cancelled will do the rest when
      // the paid period actually ends.
      await tx
        .update(tenantSubscriptions)
        .set({ cancelAtPeriodEnd: true })
        .where(
          and(
            eq(tenantSubscriptions.id, live.id),
            eq(tenantSubscriptions.tenantId, tenantId),
          ),
        )
      return
    }

    // No cycle left to honour, so the row is closed out now — both so the
    // tenant can start a fresh subscription immediately (the one-live index
    // would otherwise block it) and because leaving a dead mandate 'live' would
    // misreport the account.
    await tx
      .update(tenantSubscriptions)
      .set({ status: 'cancelled', cancelledAt: new Date(), cancelAtPeriodEnd: false })
      .where(
        and(eq(tenantSubscriptions.id, live.id), eq(tenantSubscriptions.tenantId, tenantId)),
      )

    // ── and the ACCOUNT, but only if this subscription was ever paid for ─────
    //
    // The rule is ./lifecycle.ts's `wasPaid` refinement, applied here rather
    // than restated: a business ending a PAID relationship is a closed account;
    // one backing out of a checkout it never authorised is not, and closing it
    // would punish somebody for not buying.
    //
    // This branch used to skip the account entirely, on the reasoning that it
    // only ever ran for a never-charged subscription. That is true of
    // `trialing` and false of `past_due` — which by definition HAS been charged,
    // and which is the single most common state to cancel from, since a failed
    // renewal is what prompts it. The result was an order-dependent outcome for
    // one user action: cancel while 'active' and the at-cycle-end path let the
    // webhook close the account later; cancel while 'past_due' and the account
    // stayed 'active' forever, because writing 'cancelled' here first makes the
    // matching `subscription.cancelled` delivery hit the terminal-state guard
    // and do nothing at all.
    //
    // Written in the SAME transaction as the row above, so the two can never
    // disagree.
    if (wasPaid) {
      await syncTenantStatus(tx, tenantId, 'cancelled')
    }
  })

  // The account is closed only on the immediate path, and only for a
  // subscription that was actually paid for. An at-cycle-end cancellation
  // leaves the row live; the webhook closes the account when the period ends.
  return {
    atPeriodEnd: atCycleEnd,
    currentPeriodEnd: live.currentPeriodEnd,
    closedAccount: !atCycleEnd && wasPaid,
  }
}
