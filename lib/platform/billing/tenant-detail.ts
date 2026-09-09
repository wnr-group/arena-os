import 'server-only'
import { and, desc, eq, inArray, or, sql } from 'drizzle-orm'
import { ownerDb, type DB } from '@/db'
import {
  auditLog,
  plans,
  platformInvoices,
  platformRefunds,
  tenantSubscriptions,
  tenants,
} from '@/db/schema'
import { round2 } from '@/lib/billing/pricing'
import { accessHasEnded, deadlinesFor } from './dunning-policy'
import { LIVE_STATUSES } from './lifecycle'
import { requirePlatformAdmin } from '../guard'

/**
 * THE TENANT BILLING DRILL-DOWN (AROS-114 §7).
 *
 * Everything a platform admin needs to answer "what is going on with this
 * business's billing?", in one RLS-bypassing, platform-admin-guarded read.
 *
 * ── Reuses the existing readers' rules, restated nowhere ────────────────────
 *
 *   the LIVE subscription   → the same three statuses and the same
 *                             "newest by period start" tiebreak
 *                             getTenantSubscription() and readEntitlements()
 *                             use, so this page cannot show a different
 *                             subscription from the one that governs access.
 *   the DUNNING clocks      → deadlinesFor() from ./dunning-policy.ts, the same
 *                             module the scheduled processor and the owner's
 *                             own banner compute from. One definition of "when
 *                             does this suspend", shared by all three.
 *   the MRR contribution    → the same normalisation ./metrics.ts applies, so a
 *                             tenant's figure sums into the platform total.
 *
 * ── WHAT IS NEVER SELECTED ──────────────────────────────────────────────────
 *
 * No column of `platform_payment_settings`. Not the key id, not the ciphertext,
 * not the webhook secret. `gateway_subscription_id` and `gateway_payment_id`
 * ARE included and are not credentials — a `sub_…` appears in the URL Razorpay
 * serves the payer, and a `pay_…` is what a business quotes to support. Every
 * secret lives in a table this module does not touch and `arena_app` has no
 * grant on at all (0080).
 */

export type TenantBillingSubscription = {
  id: string
  planId: string
  planName: string
  billingPeriod: 'monthly' | 'annual'
  status: string
  currentPeriodStart: Date
  currentPeriodEnd: Date
  cancelAtPeriodEnd: boolean
  /** Razorpay's public subscription reference, or null for an admin-assigned plan. */
  gatewaySubscriptionId: string | null
  gatewayBacked: boolean
  currency: string
  /** Catalogue price for the period this subscription is billed on. */
  price: string
  /** This tenant's contribution to platform MRR. 0 unless active and unlapsed. */
  mrr: number
  /** True when `status = 'trialing'` — the period end IS the trial end. */
  isTrial: boolean
  /** Lapsed on the clock: the plan grants nothing regardless of the status. */
  lapsed: boolean
  // ── arrears (AROS-113) ────────────────────────────────────────────────────
  pastDueSince: Date | null
  suspendedAt: Date | null
  lastPaymentFailureAt: Date | null
  lastPaymentFailureReason: string | null
  /** Computed from the SAME policy module the dunning job acts on. */
  graceEndsAt: Date | null
  cancelsAt: Date | null
}

export type TenantBillingInvoice = {
  id: string
  kind: 'subscription' | 'credit_note'
  invoiceNumber: string
  invoiceDate: string
  planName: string
  billingPeriodStart: Date
  billingPeriodEnd: Date
  total: number
  currency: string
  status: string
  /** Null for a credit note and for an admin-assigned charge. */
  gatewayPaymentId: string | null
  /** Already refunded or reserved against this invoice (pending + processed). */
  refunded: number
  /** total − refunded. 0 means nothing more can come back. */
  refundable: number
  notes: string | null
}

export type TenantBillingRefund = {
  id: string
  invoiceId: string
  amount: number
  currency: string
  reason: string
  status: string
  gatewayRefundId: string | null
  createdAt: Date
  /** When the money actually left (0085). Null unless the refund processed. */
  processedAt: Date | null
}

export type TenantBillingAuditEntry = {
  id: string
  action: string
  entityType: string
  entityId: string | null
  createdAt: Date
  /** Who did it — from the entry's payload, since a platform admin has no membership. */
  actorEmail: string | null
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
}

export type TenantBillingDetail = {
  tenant: { id: string; slug: string; name: string; status: string; createdAt: Date }
  subscription: TenantBillingSubscription | null
  invoices: TenantBillingInvoice[]
  refunds: TenantBillingRefund[]
  /** Billing-relevant audit entries, newest first. */
  history: TenantBillingAuditEntry[]
  /** Sellable plans, for the change-plan control. Retired plans are excluded. */
  catalogue: { id: string; name: string; monthlyPrice: string; annualPrice: string; currency: string }[]
}

/**
 * The audit actions this page shows.
 *
 * The platform overrides (AROS-114 §9) plus the subscription lifecycle
 * transitions AROS-113 writes — which is what makes this a BILLING history
 * rather than a list of button presses: "we suspended them on the 12th" and
 * "support comped them on the 14th" belong in the same column, in order.
 *
 * Deliberately a list rather than "everything for this tenant": `audit_log`
 * also carries the venue's own refunds and voids, which are its business and
 * not the platform's.
 */
const BILLING_AUDIT_ACTIONS = [
  'change_plan',
  'extend_trial',
  'comp_or_discount',
  'refund',
  'force_cancel',
  // AROS-113's lifecycle entries: `subscription.<new status>`.
  'subscription.active',
  'subscription.past_due',
  'subscription.expired',
  'subscription.cancelled',
  'subscription.trialing',
]

export async function getTenantBillingDetail(
  tenantId: string,
  db: DB = ownerDb,
): Promise<TenantBillingDetail | null> {
  // The boundary. Cross-tenant by design and therefore on the owner
  // connection, so it enforces the check itself rather than trusting the page
  // — the rule lib/platform/data.ts states and every platform reader follows.
  await requirePlatformAdmin()

  return db.transaction(async (tx) => {
    const [tenant] = await tx
      .select({
        id: tenants.id,
        slug: tenants.slug,
        name: tenants.name,
        status: tenants.status,
        createdAt: tenants.createdAt,
      })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1)

    if (!tenant) return null

    const [sub] = await tx
      .select({
        id: tenantSubscriptions.id,
        planId: plans.id,
        planName: plans.name,
        monthlyPrice: plans.monthlyPrice,
        annualPrice: plans.annualPrice,
        currency: plans.currency,
        billingPeriod: tenantSubscriptions.billingPeriod,
        status: tenantSubscriptions.status,
        currentPeriodStart: tenantSubscriptions.currentPeriodStart,
        currentPeriodEnd: tenantSubscriptions.currentPeriodEnd,
        cancelAtPeriodEnd: tenantSubscriptions.cancelAtPeriodEnd,
        gateway: tenantSubscriptions.gateway,
        gatewaySubscriptionId: tenantSubscriptions.gatewaySubscriptionId,
        pastDueSince: tenantSubscriptions.pastDueSince,
        suspendedAt: tenantSubscriptions.suspendedAt,
        lastPaymentFailureAt: tenantSubscriptions.lastPaymentFailureAt,
        lastPaymentFailureReason: tenantSubscriptions.lastPaymentFailureReason,
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

    // Invoices with their refunded totals, aggregated in SQL. A left join to a
    // grouped subquery rather than one query per invoice — the N+1 an admin
    // page with fifty invoices would otherwise produce.
    const invoiceRows = await tx
      .select({
        id: platformInvoices.id,
        kind: platformInvoices.kind,
        invoiceNumber: platformInvoices.invoiceNumber,
        invoiceDate: platformInvoices.invoiceDate,
        planName: platformInvoices.planName,
        billingPeriodStart: platformInvoices.billingPeriodStart,
        billingPeriodEnd: platformInvoices.billingPeriodEnd,
        total: platformInvoices.total,
        currency: platformInvoices.currency,
        status: platformInvoices.status,
        gatewayPaymentId: platformInvoices.gatewayPaymentId,
        notes: platformInvoices.notes,
        // Only 'pending' and 'processed' reserve part of the balance; a failed
        // refund releases what it held. The same rule refundedForInvoice()
        // applies at the moment a refund is booked.
        // ── the outer column is written out IN FULL, deliberately ───────────
        //
        // `${platformInvoices.id}` renders as the bare identifier `"id"` inside
        // a select-list fragment, and Postgres then resolves it against the
        // INNER table — platform_refunds has an `id` of its own, so the
        // predicate silently became `r.invoice_id = r.id`, which is never true.
        // Not an error: just a permanent zero. Every invoice reported nothing
        // refunded, so `refundable` below was always the full total, and the
        // admin panel offered a Refund control (pre-filled with the whole
        // amount, captioned "Up to ₹X remains refundable") on invoices that had
        // already been refunded in full. Only the server-side cap in
        // refundPlatformInvoice() stopped it from being acted on.
        //
        // The same trap caught lastPaidInvoiceFor() in ./invoices.ts. These two
        // are the only correlated subqueries in the module; both now qualify.
        refunded: sql<string>`coalesce((
          select sum(r.amount) from ${platformRefunds} r
           where r.invoice_id = public.platform_invoices.id
             and r.status in ('pending','processed')
        ), 0)`,
      })
      .from(platformInvoices)
      .where(eq(platformInvoices.tenantId, tenantId))
      .orderBy(desc(platformInvoices.invoiceDate), desc(platformInvoices.createdAt))
      .limit(50)

    const refundRows = await tx
      .select({
        id: platformRefunds.id,
        invoiceId: platformRefunds.invoiceId,
        amount: platformRefunds.amount,
        currency: platformRefunds.currency,
        reason: platformRefunds.reason,
        status: platformRefunds.status,
        gatewayRefundId: platformRefunds.gatewayRefundId,
        createdAt: platformRefunds.createdAt,
        processedAt: platformRefunds.processedAt,
      })
      .from(platformRefunds)
      .where(eq(platformRefunds.tenantId, tenantId))
      .orderBy(desc(platformRefunds.createdAt))
      .limit(50)

    const historyRows = await tx
      .select({
        id: auditLog.id,
        action: auditLog.action,
        entityType: auditLog.entityType,
        entityId: auditLog.entityId,
        createdAt: auditLog.createdAt,
        before: auditLog.before,
        after: auditLog.after,
      })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenantId),
          or(
            inArray(auditLog.action, BILLING_AUDIT_ACTIONS),
            eq(auditLog.entityType, 'tenant_subscription'),
            eq(auditLog.entityType, 'platform_invoice'),
          ),
        ),
      )
      .orderBy(desc(auditLog.createdAt))
      .limit(50)

    const catalogue = await tx
      .select({
        id: plans.id,
        name: plans.name,
        monthlyPrice: plans.monthlyPrice,
        annualPrice: plans.annualPrice,
        currency: plans.currency,
      })
      .from(plans)
      // A retired plan keeps its existing subscribers but must never be
      // assignable to anyone new — the same filter the company page applies.
      .where(eq(plans.active, true))
      .orderBy(plans.monthlyPrice)

    const now = Date.now()

    return {
      tenant,
      subscription: sub
        ? (() => {
            // The SAME rule the owner portal and the entitlement reader apply.
            // This used to test `current_period_end` alone, which showed an
            // operator "lapsed" for a business that was in grace and demonstrably
            // still working. For an `active` subscription the two are identical,
            // so the MRR test below is unchanged.
            const lapsed = accessHasEnded(sub, new Date(now))
            const deadlines = deadlinesFor({
              pastDueSince: sub.pastDueSince,
              suspendedAt: sub.suspendedAt,
              paidThrough: sub.status === 'past_due' ? sub.currentPeriodEnd : null,
            })
            return {
              id: sub.id,
              planId: sub.planId,
              planName: sub.planName,
              billingPeriod: sub.billingPeriod,
              status: sub.status,
              currentPeriodStart: sub.currentPeriodStart,
              currentPeriodEnd: sub.currentPeriodEnd,
              cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
              gatewaySubscriptionId: sub.gatewaySubscriptionId,
              gatewayBacked: Boolean(sub.gatewaySubscriptionId) && sub.gateway === 'razorpay',
              currency: sub.currency,
              price: sub.billingPeriod === 'monthly' ? sub.monthlyPrice : sub.annualPrice,
              // The SAME rule ./metrics.ts uses for the platform total: active
              // AND unlapsed, annual normalised by twelve.
              mrr:
                sub.status === 'active' && !lapsed
                  ? round2(
                      sub.billingPeriod === 'annual'
                        ? Number(sub.annualPrice) / 12
                        : Number(sub.monthlyPrice),
                    )
                  : 0,
              isTrial: sub.status === 'trialing',
              lapsed,
              pastDueSince: sub.pastDueSince,
              suspendedAt: sub.suspendedAt,
              lastPaymentFailureAt: sub.lastPaymentFailureAt,
              lastPaymentFailureReason: sub.lastPaymentFailureReason,
              graceEndsAt: deadlines?.graceEndsAt ?? null,
              cancelsAt: deadlines?.cancelsAt ?? null,
            }
          })()
        : null,
      invoices: invoiceRows.map((i) => {
        const total = round2(Number(i.total))
        const refunded = round2(Number(i.refunded))
        return {
          id: i.id,
          kind: i.kind,
          invoiceNumber: i.invoiceNumber,
          invoiceDate: i.invoiceDate,
          planName: i.planName,
          billingPeriodStart: i.billingPeriodStart,
          billingPeriodEnd: i.billingPeriodEnd,
          total,
          currency: i.currency,
          status: i.status,
          gatewayPaymentId: i.gatewayPaymentId,
          refunded,
          // Only a PAID SUBSCRIPTION invoice backed by a real payment can be
          // refunded. Computed here so the UI offers the control exactly where
          // refundPlatformInvoice() would accept it, and nowhere else.
          refundable:
            i.kind === 'subscription' && i.status === 'paid' && i.gatewayPaymentId
              ? Math.max(0, round2(total - refunded))
              : 0,
          notes: i.notes,
        }
      }),
      refunds: refundRows.map((r) => ({
        ...r,
        amount: round2(Number(r.amount)),
      })),
      history: historyRows.map((h) => ({
        id: h.id,
        action: h.action,
        entityType: h.entityType,
        entityId: h.entityId,
        createdAt: h.createdAt,
        // The actor lives in the payload for a platform override, because
        // audit_log.actor_membership_id references a MEMBERSHIP and a platform
        // admin has none. See lib/platform/billing/audit.ts.
        actorEmail:
          typeof (h.after as Record<string, unknown> | null)?.actorEmail === 'string'
            ? ((h.after as Record<string, unknown>).actorEmail as string)
            : null,
        before: (h.before as Record<string, unknown> | null) ?? null,
        after: (h.after as Record<string, unknown> | null) ?? null,
      })),
      catalogue,
    }
  })
}
