import 'server-only'
import { and, asc, desc, eq, inArray } from 'drizzle-orm'
import { withUser } from '@/db'
import { plans, platformInvoices, tenantSubscriptions } from '@/db/schema'
import type { ActiveContext } from '@/lib/tenant/context'
import { graceEndsAt } from './dunning-policy'
import { LIVE_STATUSES } from './lifecycle'

/**
 * What a BUSINESS may see about its own Arena OS subscription and the plans it
 * could move to.
 *
 * ── Everything here runs through withUser() ─────────────────────────────────
 *
 * Not the owner connection, unlike the platform-admin readers in
 * lib/platform/plans/data.ts. This is a tenant-facing surface, so it runs on the
 * restricted `arena_app` role inside a transaction that sets `app.user_id`, and
 * RLS decides what is visible:
 *
 *   tenant_subscriptions_select (0050)  → only the caller's own tenant's rows.
 *   plans_select_active (0050)          → the live catalogue.
 *   plans_select_subscribed (0050)      → plus the plan they are actually ON,
 *                                         even after it has been retired.
 *
 * The tenant id comes from the resolved context and never from an argument, so
 * a caller cannot ask about someone else — and even if it did, RLS returns zero
 * rows. Cross-tenant isolation here is a property of the database, not of this
 * file remembering to filter.
 *
 * ── What is deliberately absent ─────────────────────────────────────────────
 *
 * No credential, no ciphertext, and nothing from platform_payment_settings.
 * That table has no grant to `arena_app` at all (0051), so these queries could
 * not reach it even by mistake — a tenant asking for the platform's Razorpay
 * secret gets a 42501 from Postgres, not a redacted value.
 *
 * `gatewaySubscriptionId` IS included. A `sub_…` reference is public — it is in
 * the URL of the page Razorpay serves the payer — and showing it is what lets a
 * business quote something useful to support.
 */

export type SubscribablePlan = {
  id: string
  name: string
  monthlyPrice: string
  annualPrice: string
  currency: string
  /** Whether this plan can actually be billed on each cycle, per 0051's mapping. */
  monthlyAvailable: boolean
  annualAvailable: boolean
}

export type OwnSubscription = {
  id: string
  planId: string
  planName: string
  billingPeriod: 'monthly' | 'annual'
  status: 'trialing' | 'active' | 'past_due' | 'cancelled' | 'expired'
  currentPeriodStart: Date
  currentPeriodEnd: Date
  /** A cancellation requested but not yet effective (Razorpay cancel_at_cycle_end). */
  cancelAtPeriodEnd: boolean
  /** Razorpay's public subscription reference, or null for an admin-assigned plan. */
  gatewaySubscriptionId: string | null
  /** Lapsed on the clock even if the status has not caught up. */
  lapsed: boolean
}

export type BillingOverview = {
  subscription: OwnSubscription | null
  plans: SubscribablePlan[]
}

/**
 * The tenant's own live subscription, plus the catalogue it could move to.
 *
 * Both reads happen in ONE transaction so the page cannot render a subscription
 * and a catalogue taken from two different moments — a small thing, but it is
 * what stops "you are on Pro" appearing next to a list in which Pro has just
 * been retired.
 */
export async function getBillingOverview(ctx: ActiveContext): Promise<BillingOverview> {
  return withUser(ctx.user.id, async (tx) => {
    const [row] = await tx
      .select({
        id: tenantSubscriptions.id,
        planId: plans.id,
        planName: plans.name,
        billingPeriod: tenantSubscriptions.billingPeriod,
        status: tenantSubscriptions.status,
        currentPeriodStart: tenantSubscriptions.currentPeriodStart,
        currentPeriodEnd: tenantSubscriptions.currentPeriodEnd,
        cancelAtPeriodEnd: tenantSubscriptions.cancelAtPeriodEnd,
        gatewaySubscriptionId: tenantSubscriptions.gatewaySubscriptionId,
        pastDueSince: tenantSubscriptions.pastDueSince,
      })
      .from(tenantSubscriptions)
      .innerJoin(plans, eq(plans.id, tenantSubscriptions.planId))
      .where(
        and(
          eq(tenantSubscriptions.tenantId, ctx.tenant.id),
          inArray(tenantSubscriptions.status, [...LIVE_STATUSES]),
        ),
      )
      // The one-live index permits a single row; ordering makes a database that
      // somehow held two resolve deterministically rather than by planner luck
      // — the same defence readEntitlements() takes.
      .orderBy(desc(tenantSubscriptions.currentPeriodStart))
      .limit(1)

    const catalogue = await tx
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
      .orderBy(asc(plans.monthlyPrice))

    return {
      subscription: row
        ? {
            ...row,
            // The SAME effective expiry readEntitlements() and getBillingPortal()
            // use (AROS-113): the later of the paid period and the grace
            // deadline, because a failed renewal leaves current_period_end in
            // the past and a business in grace is not lapsed.
            lapsed:
              (row.status === 'past_due' && row.pastDueSince
                ? Math.max(
                    row.currentPeriodEnd.getTime(),
                    graceEndsAt(row.pastDueSince).getTime(),
                  )
                : row.currentPeriodEnd.getTime()) <= Date.now(),
          }
        : null,
      plans: catalogue
        // RLS lets a subscriber read the RETIRED plan it is grandfathered onto
        // (plans_select_subscribed, 0050), which is right for showing "you are
        // on X" — but a retired plan must never appear as something to buy.
        .filter((p) => p.active)
        .map((p) => ({
          id: p.id,
          name: p.name,
          monthlyPrice: p.monthlyPrice,
          annualPrice: p.annualPrice,
          currency: p.currency,
          // A period with no gateway plan id cannot be charged, so the UI must
          // not offer it — subscribeToPlan() would refuse it anyway, and being
          // told "no" after clicking pay is a worse way to learn that.
          monthlyAvailable: p.gateway !== null && p.monthlyPlanId !== null,
          annualAvailable: p.gateway !== null && p.annualPlanId !== null,
        })),
    }
  })
}

// ── platform invoices (M16 #4) ───────────────────────────────────────────────

/**
 * A business's own Arena OS invoices.
 *
 * Same rule as everything above: `withUser()` on the restricted `arena_app`
 * role, and RLS decides what is visible. `platform_invoices_owner_select`
 * (migration 0052) admits only rows whose tenant the caller OWNS —
 * `auth_role_in(tenant_id) = 'owner'`, the same helper `business_profiles`
 * uses — so a manager or a cashier sees nothing here, and another tenant's
 * owner sees nothing either. The tenant id is never taken from an argument.
 *
 * `arena_app` holds SELECT and nothing else on the table, so no path from a
 * browser can create, alter or void one of these. They are written only by the
 * platform webhook, on the owner connection.
 */
export type PlatformInvoiceRow = {
  id: string
  kind: 'subscription' | 'credit_note'
  invoiceNumber: string
  invoiceDate: string
  planName: string
  billingPeriodStart: Date
  billingPeriodEnd: Date
  billingPeriodType: 'monthly' | 'annual'
  total: string
  currency: string
  status: string
}

export async function listPlatformInvoices(
  ctx: ActiveContext,
  limit = 50,
): Promise<PlatformInvoiceRow[]> {
  return withUser(ctx.user.id, async (tx) => {
    const rows = await tx
      .select({
        id: platformInvoices.id,
        kind: platformInvoices.kind,
        invoiceNumber: platformInvoices.invoiceNumber,
        invoiceDate: platformInvoices.invoiceDate,
        planName: platformInvoices.planName,
        billingPeriodStart: platformInvoices.billingPeriodStart,
        billingPeriodEnd: platformInvoices.billingPeriodEnd,
        billingPeriodType: platformInvoices.billingPeriodType,
        total: platformInvoices.total,
        currency: platformInvoices.currency,
        status: platformInvoices.status,
      })
      .from(platformInvoices)
      // Belt and braces beside RLS: correct on its own terms, and it keeps the
      // read on idx_platform_invoices_tenant.
      .where(eq(platformInvoices.tenantId, ctx.tenant.id))
      .orderBy(desc(platformInvoices.invoiceDate), desc(platformInvoices.createdAt))
      .limit(limit)
    return rows
  })
}

/** The full document. Every field is a SNAPSHOT — nothing here is recomputed. */
export type PlatformInvoiceDetail = typeof platformInvoices.$inferSelect

/**
 * One invoice, for the printable document.
 *
 * Returns null when the id is unknown OR when RLS hid it, which are answered
 * identically so a caller cannot probe which invoice ids exist.
 *
 * NOTHING here reads `business_profiles`, `plans` or
 * `platform_billing_settings`. The whole point of the snapshot columns is that
 * an invoice raised last year renders exactly as it did then, even after the
 * business has changed its address and Arena OS has changed its price list.
 */
export async function getPlatformInvoice(
  ctx: ActiveContext,
  invoiceId: string,
): Promise<PlatformInvoiceDetail | null> {
  return withUser(ctx.user.id, async (tx) => {
    const [row] = await tx
      .select()
      .from(platformInvoices)
      .where(
        and(
          eq(platformInvoices.id, invoiceId),
          eq(platformInvoices.tenantId, ctx.tenant.id),
        ),
      )
      .limit(1)
    return row ?? null
  })
}
