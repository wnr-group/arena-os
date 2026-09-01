import 'server-only'
import { and, desc, eq, inArray, isNotNull } from 'drizzle-orm'
import { ownerDb, type DB } from '@/db'
import { memberships, plans, tenants, tenantSubscriptions, users } from '@/db/schema'
import { paise } from '@/lib/billing/pricing'
import { RazorpayApiError } from '@/lib/payments/razorpay'
import {
  requirePlatformRazorpayCredentials,
  type PlatformRazorpayCredentials,
} from './credentials'
import {
  cancelRazorpaySubscription,
  createRazorpayCustomer,
  createRazorpaySubscription,
  fetchRazorpayPlan,
  type CancelSubscriptionFn,
  type CreateCustomerFn,
  type CreateSubscriptionFn,
  type FetchPlanFn,
} from './razorpay-subscriptions'
import { GATEWAY, LIVE_STATUSES } from './lifecycle'
import { creditUnusedPeriod } from './proration'

/**
 * Putting a tenant onto a paid Arena OS plan through Razorpay Subscriptions.
 *
 * ── NOTHING HERE TRUSTS THE CLIENT ABOUT MONEY ──────────────────────────────
 *
 * The caller supplies a plan id and a billing period. That is all. Every figure
 * that decides what a business is charged is loaded server-side:
 *
 *   * the plan row comes from the database, and must be `active`;
 *   * the Razorpay plan id comes from THAT ROW's gateway_monthly_plan_id or
 *     gateway_annual_plan_id — the column matching the requested period, with
 *     no fallback to the other one;
 *   * the amount is never sent at all. A Razorpay plan object carries its own
 *     price, so there is no figure in the create call for anyone to influence;
 *   * and before creating anything, the Razorpay plan's price is FETCHED and
 *     compared against the Arena OS catalogue price. A mismatch aborts.
 *
 * That last check is the difference between hoping an operator pasted the right
 * `plan_…` into the admin form and knowing it. Without it, a transposed id
 * between the Starter and Enterprise rows would silently bill every new
 * subscriber the wrong amount, and the first symptom would be a chargeback.
 *
 * ── AND NEVER THE TENANT'S OWN RAZORPAY ─────────────────────────────────────
 *
 * Credentials come from requirePlatformRazorpayCredentials() — ARENA OS's
 * merchant account. lib/settings/razorpay-credentials.ts, which loads a
 * TENANT's keys for collecting its own customers' deposits, is not imported
 * here and must never be. A venue's keys charging that venue its Arena OS
 * subscription would be the venue paying itself.
 */

export class SubscriptionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SubscriptionError'
  }
}

export type BillingPeriod = 'monthly' | 'annual'

/**
 * How many billing cycles to authorise up front.
 *
 * Razorpay requires a finite `total_count`; there is no "until cancelled". Ten
 * years of cycles is the practical equivalent — long enough that no live
 * customer reaches it, short enough that a mandate is not open-ended forever.
 * When it IS reached Razorpay fires `subscription.completed`, which the
 * lifecycle maps to `expired` WITHOUT suspending the account, so the worst case
 * is a renewal conversation rather than a business going dark.
 */
const TOTAL_COUNT: Record<BillingPeriod, number> = { monthly: 120, annual: 10 }

/**
 * Provisional runway for a subscription that has been created but not yet paid.
 *
 * A Razorpay subscription starts life unauthenticated: the payer still has to
 * approve the mandate on Razorpay's hosted page, which can take minutes or
 * days. The local row exists from creation (it is what the webhook will find),
 * and it has to carry SOME current_period_end because 0050 requires one.
 *
 * The rule, and why it is not simply "now + 3 days":
 *
 *   * a tenant that already has runway KEEPS EXACTLY THAT and no more.
 *     Subscribing never adds free time, so repeatedly starting checkouts and
 *     never paying cannot be farmed for access.
 *   * a tenant with none — a fresh account, or one whose trial has lapsed —
 *     gets this window, so the app is usable while they actually complete the
 *     payment they just started.
 *
 * Either way the plan's entitlements apply immediately, which is ordinary
 * upgrade behaviour, and the clock test in readEntitlements() closes it off on
 * its own if the payment never lands.
 */
const PENDING_AUTHORISATION_DAYS = 3

export type SubscribeParams = {
  /** From the authenticated context. NEVER from client input. */
  tenantId: string
  planId: string
  billingPeriod: BillingPeriod
}

export type SubscribeResult = {
  /** Our own subscription row. */
  subscriptionId: string
  /**
   * The proration credit note raised for the plan this switch replaced, when
   * there was one. Applied against the next charge; see ./proration.ts.
   */
  prorationCredit: { invoiceNumber: string; amount: string } | null
  /** Razorpay's subscription reference. Public; appears in the checkout page. */
  gatewaySubscriptionId: string
  /**
   * Razorpay's hosted authorisation page. The payer completes the mandate here.
   * A NON-SECRET URL — but note that returning from it proves nothing; only the
   * webhook activates the subscription.
   */
  checkoutUrl: string | null
}

/**
 * The gateway calls, injectable so the flow can be tested without HTTP.
 *
 * Same device as CreateOrderFn in lib/payments/razorpay.ts: a real call to
 * Razorpay has no place in a test suite, and the decision logic — which plan
 * id, which price check, which local rows — is the part worth proving.
 */
export type SubscribeGateway = {
  fetchPlan: FetchPlanFn
  createCustomer: CreateCustomerFn
  createSubscription: CreateSubscriptionFn
  /** Used only when a switch supersedes an existing mandate. */
  cancelSubscription?: CancelSubscriptionFn
  /** Overridable so a test need not configure a real platform account. */
  credentials?: () => Promise<PlatformRazorpayCredentials>
}

const DEFAULT_GATEWAY: SubscribeGateway = {
  fetchPlan: fetchRazorpayPlan,
  createCustomer: createRazorpayCustomer,
  createSubscription: createRazorpaySubscription,
  cancelSubscription: cancelRazorpaySubscription,
}

/**
 * Create the Razorpay subscription and record it locally.
 *
 * ── Ordering, and what happens if it breaks halfway ─────────────────────────
 *
 * The gateway calls happen BEFORE the local transaction, deliberately. The
 * alternative — write locally, then call Razorpay — would leave a tenant on a
 * plan nobody is being charged for whenever the gateway call failed, which is
 * the strictly worse failure: it grants access for free and looks correct.
 *
 * This way, a crash between "Razorpay created a subscription" and "we recorded
 * it" leaves an unauthenticated subscription object at Razorpay that no payer
 * ever approves. Razorpay expires it on its own, no charge is ever made, and
 * the tenant simply retries. Nobody is billed for anything the database does
 * not know about.
 */
export async function subscribeTenantToPlan(
  params: SubscribeParams,
  gateway: SubscribeGateway = DEFAULT_GATEWAY,
  db: DB = ownerDb,
): Promise<SubscribeResult> {
  const { tenantId, planId, billingPeriod } = params

  // ── 1. the tenant must exist and still be an account we can bill ──────────
  const [tenant] = await db
    .select({ id: tenants.id, name: tenants.name, status: tenants.status })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1)

  if (!tenant) throw new SubscriptionError('This workspace no longer exists.')
  if (tenant.status === 'cancelled') {
    // A cancelled account is a closed business relationship. Re-opening one is
    // an operator decision (setCompanyStatus), not something a self-serve
    // checkout may do on its own.
    throw new SubscriptionError(
      'This account has been cancelled. Contact Arena OS support to reopen it.',
    )
  }

  // ── 2. the plan, from the DATABASE ────────────────────────────────────────
  const [plan] = await db
    .select({
      id: plans.id,
      name: plans.name,
      monthlyPrice: plans.monthlyPrice,
      annualPrice: plans.annualPrice,
      currency: plans.currency,
      active: plans.active,
      gateway: plans.gateway,
      monthlyPlanId: plans.gatewayMonthlyPlanId,
      annualPlanId: plans.gatewayAnnualPlanId,
    })
    .from(plans)
    .where(eq(plans.id, planId))
    .limit(1)

  if (!plan) throw new SubscriptionError('That plan no longer exists.')
  if (!plan.active) {
    // Retired plans keep their existing subscribers (that is what
    // plans_select_subscribed in 0050 is for) but must never take a new one.
    throw new SubscriptionError('That plan is no longer available.')
  }

  // ── 3. the RIGHT gateway plan for the RIGHT period ────────────────────────
  if (plan.gateway !== GATEWAY) {
    throw new SubscriptionError(
      `The ${plan.name} plan is not yet connected to the payment gateway. Contact Arena OS support.`,
    )
  }
  const gatewayPlanId =
    billingPeriod === 'monthly' ? plan.monthlyPlanId : plan.annualPlanId
  if (!gatewayPlanId) {
    // Explicitly NOT falling back to the other period's id. Charging annually
    // because the monthly mapping was missing is the exact accident this
    // whole two-column design exists to prevent.
    throw new SubscriptionError(
      `The ${plan.name} plan cannot be billed ${billingPeriod === 'monthly' ? 'monthly' : 'annually'} yet. Choose the other billing period or contact Arena OS support.`,
    )
  }

  const expectedRupees = Number(
    billingPeriod === 'monthly' ? plan.monthlyPrice : plan.annualPrice,
  )
  if (!Number.isFinite(expectedRupees) || expectedRupees <= 0) {
    // A zero-priced plan has nothing for a gateway to collect. It is a valid
    // catalogue entry (a free tier) — it is just assigned by an operator, not
    // subscribed to through checkout.
    throw new SubscriptionError(
      `The ${plan.name} plan has no ${billingPeriod} price to charge. Contact Arena OS support.`,
    )
  }
  const expectedPaise = paise(expectedRupees)

  // ── 4. the PLATFORM's credentials. Never a tenant's ───────────────────────
  const credentials = await (gateway.credentials
    ? gateway.credentials()
    : requirePlatformRazorpayCredentials())

  // ── 5. prove the gateway plan charges what the catalogue advertises ───────
  const gatewayPlan = await gateway.fetchPlan(credentials, gatewayPlanId)
  if (gatewayPlan.item.amount !== expectedPaise) {
    console.error(
      `[subscribe] gateway plan ${gatewayPlanId} charges ${gatewayPlan.item.amount} paise; ` +
        `plan ${plan.id} (${billingPeriod}) advertises ${expectedPaise}`,
    )
    throw new SubscriptionError(
      'This plan is misconfigured and would charge the wrong amount. Nothing has been charged. Contact Arena OS support.',
    )
  }
  if (gatewayPlan.item.currency !== plan.currency) {
    throw new SubscriptionError(
      'This plan is misconfigured and would charge in the wrong currency. Nothing has been charged. Contact Arena OS support.',
    )
  }
  // The period the gateway plan actually renews on must be the one asked for.
  const expectedPeriod = billingPeriod === 'monthly' ? 'monthly' : 'yearly'
  if (gatewayPlan.period && gatewayPlan.period !== expectedPeriod) {
    throw new SubscriptionError(
      'This plan is misconfigured and would renew on the wrong cycle. Nothing has been charged. Contact Arena OS support.',
    )
  }

  // ── 6. the Razorpay customer, reused where one already exists ─────────────
  const existingCustomerId = await findGatewayCustomerId(db, tenantId)
  const customerId =
    existingCustomerId ??
    (
      await gateway.createCustomer(credentials, {
        // Arena OS's customer is the BUSINESS, not a booker.
        name: tenant.name,
        email: await billingEmail(db, tenantId),
        notes: { tenant_id: tenantId },
      })
    ).id

  // ── 7. create the subscription ────────────────────────────────────────────
  const created = await gateway.createSubscription(credentials, {
    planId: gatewayPlanId,
    customerId,
    totalCount: TOTAL_COUNT[billingPeriod],
    // Reconciliation breadcrumbs for a human reading the Razorpay dashboard.
    // NEVER read back for authorization — the webhook resolves the tenant from
    // our own gateway_subscription_id column, not from these.
    notes: { tenant_id: tenantId, plan_id: plan.id, billing_period: billingPeriod },
  })

  // ── 8. record it, replacing whatever live row existed ─────────────────────
  const now = new Date()
  let supersededGatewayId: string | null = null
  let prorationCredit: { invoiceNumber: string; amount: string } | null = null
  const subscriptionId = await db.transaction(async (tx) => {
    // Lock the tenant's live row so two concurrent checkouts cannot both pass
    // the "close the old one" step and then race on the one-live index.
    const [live] = await tx
      .select({
        id: tenantSubscriptions.id,
        currentPeriodEnd: tenantSubscriptions.currentPeriodEnd,
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
      .for('update')
      .orderBy(desc(tenantSubscriptions.currentPeriodStart))
      .limit(1)

    // Inherit the runway; only a tenant with none gets the pending window.
    const inherited =
      live && live.currentPeriodEnd.getTime() > now.getTime() ? live.currentPeriodEnd : null
    const periodEnd =
      inherited ??
      new Date(now.getTime() + PENDING_AUTHORISATION_DAYS * 24 * 60 * 60 * 1000)

    if (live) {
      // idx_tenant_subscriptions_one_live permits exactly one live row per
      // tenant, so the old one is closed in the SAME transaction the new one
      // is opened in — two statements outside a transaction would fail on the
      // index half the time and leave the tenant with no plan the other half.
      await tx
        .update(tenantSubscriptions)
        .set({ status: 'cancelled', cancelledAt: now, cancelAtPeriodEnd: false })
        .where(eq(tenantSubscriptions.id, live.id))

      // A live row backed by a real mandate must not simply be forgotten:
      // Razorpay would keep charging the business for the plan it just left,
      // alongside the new one. Cancelled at the gateway immediately after this
      // transaction commits — see the note below the transaction for the
      // ordering, which is not arbitrary.
      if (live.gateway === GATEWAY && live.gatewaySubscriptionId) {
        supersededGatewayId = live.gatewaySubscriptionId
      }

      // ── proration (M16 #4) ──────────────────────────────────────────────
      // The business paid for a period it is now leaving part-way through.
      // Razorpay does not refund that — a plan change here is cancel-and-
      // recreate, and the new subscription charges its full price — so the
      // unused remainder is credited by Arena OS.
      //
      // In THIS transaction, deliberately: the credit and the closing of the
      // old row commit together, so there is no state in which the old
      // subscription is gone and its unused remainder has silently evaporated.
      //
      // Writes nothing when the outgoing subscription was never charged, when
      // its period has already run out, or when the credit rounds to zero.
      // The rule itself, and why upgrade and downgrade share it, is documented
      // in ./proration.ts.
      prorationCredit = await creditUnusedPeriod(tx, {
        tenantId,
        subscriptionId: live.id,
        at: now,
      })
    }

    const [row] = await tx
      .insert(tenantSubscriptions)
      .values({
        tenantId,
        planId: plan.id,
        billingPeriod,
        // NOT 'active'. No money has moved yet — the payer has not even opened
        // Razorpay's authorisation page. `trialing` is the live-but-unpaid
        // state 0050 already defines; the webhook is what promotes it.
        status: 'trialing',
        currentPeriodStart: now,
        currentPeriodEnd: periodEnd,
        gateway: GATEWAY,
        gatewaySubscriptionId: created.id,
        gatewayCustomerId: customerId,
      })
      .returning({ id: tenantSubscriptions.id })

    return row.id
  })

  // ── 9. stop the mandate the business just replaced ────────────────────────
  //
  // AFTER the local swap, and that ordering is load-bearing. Cancelling at
  // Razorpay first would let the resulting `subscription.cancelled` webhook
  // arrive while the old row was still live, and the lifecycle would correctly
  // — and disastrously — read that as "this business cancelled" and set the
  // account to cancelled, moments before it moved onto its new plan. With the
  // old row already closed out, that same delivery hits the terminal-state
  // guard in applySubscriptionState() and does nothing at all.
  //
  // The residual risk this leaves is stated plainly rather than hidden: if the
  // gateway call below fails, the old mandate is still live at Razorpay while
  // the local row says cancelled, and the business could be charged for a plan
  // it has left. That is why it is logged at error level with the reference,
  // why the reference stays on the cancelled row, and why the caller is told.
  if (supersededGatewayId) {
    try {
      await (gateway.cancelSubscription ?? cancelRazorpaySubscription)(
        credentials,
        supersededGatewayId,
        // Immediate, not at cycle end: the business has moved to a different
        // plan, so there is no cycle on the old one worth honouring.
        false,
      )
    } catch (e) {
      console.error(
        `[subscribe] tenant ${tenantId} switched plans but the previous gateway ` +
          `subscription ${supersededGatewayId} could not be cancelled — it may still ` +
          `charge. Cancel it manually on the Arena OS Razorpay account.`,
        e instanceof Error ? e.name : 'unknown error',
      )
      throw new SubscriptionError(
        'Your new plan is set up, but your previous subscription could not be stopped automatically. Contact Arena OS support so you are not billed twice.',
      )
    }
  }

  // Deliberately NOT touching tenants.status here. Creating a subscription is
  // not paying for one; the account moves to 'active' when the webhook says the
  // charge succeeded, and not one moment earlier.
  return {
    subscriptionId,
    prorationCredit,
    gatewaySubscriptionId: created.id,
    checkoutUrl: created.short_url,
  }
}

/**
 * The Razorpay customer this tenant already has, from any previous subscription.
 *
 * Reused so an abandoned checkout followed by a retry does not accumulate
 * duplicate customer objects on the platform account — which would then make
 * "how much has this business paid us?" unanswerable from the dashboard.
 */
async function findGatewayCustomerId(db: DB, tenantId: string): Promise<string | null> {
  const [row] = await db
    .select({ customerId: tenantSubscriptions.gatewayCustomerId })
    .from(tenantSubscriptions)
    .where(
      and(
        eq(tenantSubscriptions.tenantId, tenantId),
        eq(tenantSubscriptions.gateway, GATEWAY),
        isNotNull(tenantSubscriptions.gatewayCustomerId),
      ),
    )
    .orderBy(desc(tenantSubscriptions.createdAt))
    .limit(1)
  return row?.customerId ?? null
}

/**
 * Who Razorpay notifies about the mandate: the tenant's OWNER.
 *
 * Read on the owner connection alongside everything else in this flow, from
 * `memberships`, so the address is the one the business actually administers
 * rather than whichever staff member happened to click subscribe.
 */
async function billingEmail(db: DB, tenantId: string): Promise<string> {
  const [row] = await db
    .select({ email: users.email })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(
      and(
        eq(memberships.tenantId, tenantId),
        eq(memberships.role, 'owner'),
        eq(memberships.status, 'active'),
      ),
    )
    .orderBy(desc(memberships.createdAt))
    .limit(1)

  if (!row?.email) {
    throw new SubscriptionError(
      'This workspace has no active owner to bill. Add an owner before subscribing.',
    )
  }
  return row.email
}

/** True when a gateway failure is worth offering a retry for. */
export function isRetriableGatewayError(e: unknown): boolean {
  return e instanceof RazorpayApiError && e.retriable
}
