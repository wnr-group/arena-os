import 'server-only'
import { and, desc, eq, inArray } from 'drizzle-orm'
import { ownerDb, type DB } from '@/db'
import { tenantSubscriptions } from '@/db/schema'
import {
  requirePlatformRazorpayCredentials,
  type PlatformRazorpayCredentials,
} from './credentials'
import { cancelRazorpaySubscription, type CancelSubscriptionFn } from './razorpay-subscriptions'
import { GATEWAY, LIVE_STATUSES } from './lifecycle'
import { SubscriptionError } from './subscribe'

/**
 * Cancelling an Arena OS subscription.
 *
 * ── THE CHOSEN BEHAVIOUR ────────────────────────────────────────────────────
 *
 * The project's existing rules say nothing about cancellation timing — 0070
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
    // An admin-assigned plan (0070's assignPlan) has no gateway object, so
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
    return { atPeriodEnd: true, currentPeriodEnd: live.currentPeriodEnd }
  }

  // Only a subscription Razorpay considers active has a cycle to run out —
  // unless a platform admin has explicitly asked for it to stop now.
  const atCycleEnd = options.immediate ? false : live.status === 'active'

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

    // Never charged, so there is no paid period to honour. Closed out now —
    // both so the tenant can start a fresh subscription immediately (the
    // one-live index would otherwise block it) and because leaving a dead
    // mandate 'live' would misreport the account.
    //
    // tenants.status is deliberately NOT touched. Backing out of a checkout
    // that was never authorised is not closing a business account, and the
    // matching `subscription.cancelled` webhook applies the same rule (see the
    // `wasPaid` refinement in ./lifecycle.ts) so the two paths agree.
    await tx
      .update(tenantSubscriptions)
      .set({ status: 'cancelled', cancelledAt: new Date(), cancelAtPeriodEnd: false })
      .where(
        and(eq(tenantSubscriptions.id, live.id), eq(tenantSubscriptions.tenantId, tenantId)),
      )
  })

  return { atPeriodEnd: atCycleEnd, currentPeriodEnd: live.currentPeriodEnd }
}
