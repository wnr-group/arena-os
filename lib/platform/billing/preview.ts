import 'server-only'
import { and, desc, eq, inArray } from 'drizzle-orm'
import { ownerDb, type DB } from '@/db'
import { plans, tenantSubscriptions } from '@/db/schema'
import { round2 } from '@/lib/billing/pricing'
import { computeProrationCredit } from './proration'
import { lastPaidInvoiceFor } from './invoices'
import { GATEWAY, LIVE_STATUSES } from './lifecycle'

/**
 * A QUOTE for a plan change — what would happen, computed server-side, before
 * anything happens (M16 #5).
 *
 * ── Read-only, and that is the whole point ──────────────────────────────────
 *
 * Nothing here writes, calls Razorpay, or has a side effect. It exists so the
 * confirmation dialog can state the consequences in figures the SERVER worked
 * out, rather than the browser guessing from a price list. "Do not silently
 * change a subscription" is only meaningful if the sentence shown beforehand is
 * actually the sentence the mutation will honour.
 *
 * ── It reuses the same arithmetic the mutation will use ─────────────────────
 *
 * The credit comes from computeProrationCredit() against lastPaidInvoiceFor(),
 * exactly as creditUnusedPeriod() does inside subscribeTenantToPlan()'s swap
 * transaction. A separate "estimate" formula here would be a second rule to
 * keep in step, and the first time they drifted the confirmation dialog would
 * become a lie.
 *
 * ── The one thing it cannot promise ─────────────────────────────────────────
 *
 * The quote is taken at time T and the change happens at T+ε. If a renewal
 * lands in between, the credit the mutation computes will differ by a day's
 * worth. The figures are therefore presented as what will happen, not as a
 * contract — and the mutation never reads these numbers back, it recomputes
 * them. Nothing the browser was shown can influence what it is charged.
 */

export type PlanChangePreview = {
  /** Null when the tenant has no live subscription — this is a first purchase. */
  current: {
    planId: string
    planName: string
    billingPeriod: 'monthly' | 'annual'
    price: string
    currentPeriodEnd: Date
    status: string
    /** True when this plan came from a platform admin, not a gateway checkout. */
    adminAssigned: boolean
  } | null
  target: {
    planId: string
    planName: string
    billingPeriod: 'monthly' | 'annual'
    price: string
    currency: string
  }
  /** 'upgrade' | 'downgrade' | 'same' — by price, on the requested period. */
  direction: 'upgrade' | 'downgrade' | 'same'
  /**
   * The proration credit note that would be RAISED for the unused remainder of
   * the current paid period. Null when there is nothing to credit — no live
   * subscription, none ever charged, or the period already spent.
   *
   * It is an OUTSTANDING OBLIGATION, not a discount on what follows. Nothing
   * nets it off the charge or the invoice; see ./proration.ts.
   */
  credit: { amount: string; unusedDays: number; periodDays: number } | null
  /**
   * What Razorpay will actually capture on the new subscription's first cycle:
   * the FULL new-plan price. Razorpay is not asked to prorate — a plan change
   * here is cancel-and-recreate (M16 #3) — so this is never reduced.
   */
  firstChargeAmount: string
  /**
   * What the resulting invoice will total — which is the SAME figure, always.
   *
   * Kept as its own field rather than removed because the dialog states both
   * lines, and because a future gateway-side discount (a Razorpay offer, which
   * genuinely WOULD reduce the capture) is the case that makes them differ.
   */
  firstInvoiceTotal: string
  /** Changes take effect immediately; there is no scheduled-at-period-end path. */
  effective: 'immediate'
}

export class PreviewError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PreviewError'
  }
}

/**
 * Quote a plan change for `tenantId`.
 *
 * `tenantId` comes from the authenticated context, never from client input, and
 * the target plan is loaded from the database — the caller supplies an id and a
 * period and nothing else. No price, amount or subscription id from the browser
 * is read anywhere in this file.
 */
export async function previewPlanChangeFor(
  tenantId: string,
  planId: string,
  billingPeriod: 'monthly' | 'annual',
  db: DB = ownerDb,
  at: Date = new Date(),
): Promise<PlanChangePreview> {
  const [target] = await db
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

  if (!target) throw new PreviewError('That plan no longer exists.')
  if (!target.active) throw new PreviewError('That plan is no longer available.')

  // The same two refusals subscribeTenantToPlan() makes, made HERE too so the
  // owner learns before the confirmation dialog rather than after clicking pay.
  // The mutation still re-checks; this is not the gate.
  if (target.gateway !== GATEWAY) {
    throw new PreviewError(
      `The ${target.name} plan is not yet connected to the payment gateway. Contact Arena OS support.`,
    )
  }
  const gatewayPlanId =
    billingPeriod === 'monthly' ? target.monthlyPlanId : target.annualPlanId
  if (!gatewayPlanId) {
    throw new PreviewError(
      `The ${target.name} plan cannot be billed ${billingPeriod === 'monthly' ? 'monthly' : 'annually'} yet. Choose the other billing period or contact Arena OS support.`,
    )
  }

  const targetPrice = round2(
    Number(billingPeriod === 'monthly' ? target.monthlyPrice : target.annualPrice),
  )

  const [live] = await db
    .select({
      id: tenantSubscriptions.id,
      planId: plans.id,
      planName: plans.name,
      monthlyPrice: plans.monthlyPrice,
      annualPrice: plans.annualPrice,
      billingPeriod: tenantSubscriptions.billingPeriod,
      status: tenantSubscriptions.status,
      currentPeriodEnd: tenantSubscriptions.currentPeriodEnd,
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
    .limit(1)

  let credit: PlanChangePreview['credit'] = null
  if (live) {
    // Identical to what creditUnusedPeriod() will do: the credit is based on
    // the invoice the business ACTUALLY PAID for the period it is leaving, not
    // on today's catalogue price for the old plan.
    const lastPaid = await lastPaidInvoiceFor(db, live.id)
    if (lastPaid) {
      const c = computeProrationCredit({
        paidTotal: Number(lastPaid.total),
        periodStart: lastPaid.billingPeriodStart,
        periodEnd: lastPaid.billingPeriodEnd,
        at,
      })
      if (c.amount > 0) {
        credit = {
          amount: c.amount.toFixed(2),
          unusedDays: c.unusedDays,
          periodDays: c.periodDays,
        }
      }
    }
  }

  const currentPrice = live
    ? round2(Number(live.billingPeriod === 'monthly' ? live.monthlyPrice : live.annualPrice))
    : 0

  const direction: PlanChangePreview['direction'] = !live
    ? 'upgrade'
    : targetPrice > currentPrice
      ? 'upgrade'
      : targetPrice < currentPrice
        ? 'downgrade'
        : 'same'

  return {
    current: live
      ? {
          planId: live.planId,
          planName: live.planName,
          billingPeriod: live.billingPeriod,
          price: currentPrice.toFixed(2),
          currentPeriodEnd: live.currentPeriodEnd,
          status: live.status,
          // An admin-assigned plan has no gateway object. Naming it lets the
          // dialog say so instead of implying a card will be charged.
          adminAssigned: live.gatewaySubscriptionId === null,
        }
      : null,
    target: {
      planId: target.id,
      planName: target.name,
      billingPeriod,
      price: targetPrice.toFixed(2),
      currency: target.currency,
    },
    direction,
    credit,
    firstChargeAmount: targetPrice.toFixed(2),
    // EQUAL to the charge. This used to be `targetPrice − credit`, which made
    // the confirmation dialog quote a total the business would never be
    // billed: nothing reduces what Razorpay captures (the new subscription
    // bills its plan's full price), and issueSubscriptionInvoice() writes
    // `adjustment = 0` unconditionally, so the invoice totals the capture. A
    // credit note is raised as a separate OUTSTANDING document and is
    // discharged deliberately — by a refund or a comp — never by being netted
    // off a later bill. See ./proration.ts and ./invoices.ts, which say the
    // same thing from the writing side.
    //
    // The credit is still reported above, so the dialog can say what is being
    // issued. It is simply no longer subtracted from anything.
    firstInvoiceTotal: targetPrice.toFixed(2),
    effective: 'immediate',
  }
}
