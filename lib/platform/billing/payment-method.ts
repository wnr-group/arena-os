import 'server-only'
import { and, desc, eq, inArray } from 'drizzle-orm'
import { ownerDb, type DB } from '@/db'
import { tenantSubscriptions } from '@/db/schema'
import {
  requirePlatformRazorpayCredentials,
  type PlatformRazorpayCredentials,
} from './credentials'
import { fetchRazorpaySubscription, type FetchSubscriptionFn } from './razorpay-subscriptions'
import { GATEWAY, LIVE_STATUSES } from './lifecycle'
import { SubscriptionError } from './subscribe'

/**
 * Sending an owner to Razorpay's own hosted page to (re-)authorise the mandate
 * that pays for their Arena OS subscription (M16 #5).
 *
 * ── What Razorpay actually offers, and what it does not ─────────────────────
 *
 * Razorpay Subscriptions has no Stripe-style customer portal and no
 * "update the payment method on this subscription" endpoint. What it has is the
 * subscription's OWN hosted authorisation page, reachable at `short_url` on the
 * subscription object — the same page the payer used to authorise the mandate
 * in the first place. That page is where a payer re-authorises when a mandate
 * has failed, and it is therefore the correct hosted flow to open here.
 *
 * So this module builds nothing. It does not render a card form, it does not
 * tokenise anything, and it never touches card data — it fetches one URL from
 * Razorpay, server-side, and hands it back. Building a custom card form would
 * mean putting Arena OS in the cardholder-data path for no benefit.
 *
 * A genuine limitation, stated rather than papered over: for a subscription
 * that is healthy and `active`, opening this page does not swap the stored
 * instrument — Razorpay does not expose that. Changing the instrument on a
 * working subscription means starting a new one (which the plan-change flow
 * already does, via cancel-and-recreate). What this IS good for is the case
 * that actually matters: a `pending`/`halted` subscription whose charge is
 * failing, where re-authorising is exactly the fix.
 *
 * ── The credentials never leave the server ──────────────────────────────────
 *
 * requirePlatformRazorpayCredentials() decrypts the PLATFORM key secret to
 * build one Authorization header inside fetchRazorpaySubscription(), and it
 * falls out of scope there. The only thing returned from this module is a
 * public URL that Razorpay itself serves to payers. No key, no secret, no
 * ciphertext, and — emphatically — never the TENANT's own Razorpay credentials,
 * which belong to a different account and a different money flow entirely.
 */

export type PaymentMethodFlow = {
  /** Razorpay's hosted authorisation page. Public; safe to open in a browser. */
  url: string
  /** The provider's current view of the subscription, for the copy shown next to it. */
  gatewayStatus: string
}

export type PaymentMethodGateway = {
  fetchSubscription: FetchSubscriptionFn
  /** Overridable so a test need not configure a real platform account. */
  credentials?: () => Promise<PlatformRazorpayCredentials>
}

const DEFAULT_GATEWAY: PaymentMethodGateway = {
  fetchSubscription: fetchRazorpaySubscription,
}

/**
 * The hosted URL for this tenant's live subscription.
 *
 * `tenantId` comes from the authenticated context and every statement filters
 * on it, so there is no shape of call that opens another business's mandate.
 * The gateway subscription id is read from OUR OWN row — never accepted from a
 * caller — which is what makes a forged id worthless.
 *
 * Deliberately fetched fresh rather than stored: `short_url` is a property of a
 * live gateway object, and a cached copy of it could outlive the subscription
 * it points at.
 */
export async function paymentMethodUpdateFlow(
  tenantId: string,
  gateway: PaymentMethodGateway = DEFAULT_GATEWAY,
  db: DB = ownerDb,
): Promise<PaymentMethodFlow> {
  const [live] = await db
    .select({
      gateway: tenantSubscriptions.gateway,
      gatewaySubscriptionId: tenantSubscriptions.gatewaySubscriptionId,
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

  if (!live) {
    throw new SubscriptionError('There is no active subscription to update.')
  }
  if (live.gateway !== GATEWAY || !live.gatewaySubscriptionId) {
    // An admin-assigned plan (0079's assignPlan) has no gateway object at all,
    // so there is no mandate and nothing to re-authorise. Saying so is more
    // useful than a broken link.
    throw new SubscriptionError(
      'This plan was assigned by Arena OS and has no payment mandate. Contact Arena OS support to change it.',
    )
  }

  const credentials = await (gateway.credentials
    ? gateway.credentials()
    : requirePlatformRazorpayCredentials())

  const subscription = await gateway.fetchSubscription(credentials, live.gatewaySubscriptionId)

  if (!subscription.short_url) {
    throw new SubscriptionError(
      'The payment gateway did not return an authorisation link for this subscription. Contact Arena OS support.',
    )
  }

  return { url: subscription.short_url, gatewayStatus: subscription.status }
}
