import 'server-only'
import { and, asc, desc, eq, inArray } from 'drizzle-orm'
import { withUser } from '@/db'
import {
  planEntitlements,
  plans,
  platformInvoices,
  tenantSubscriptions,
} from '@/db/schema'
import type { ActiveContext } from '@/lib/tenant/context'
// Reused, never restated: the readers and interpreters that already own these
// questions for ENFORCEMENT (M16 #1 and #2).
import {
  readEntitlements,
  type EntitlementValue,
  type TenantEntitlements,
} from '@/lib/platform/entitlements'
import { decideLimit, moduleGranted, type Resolved } from '@/lib/platform/entitlement-guard'
import { countActiveStaff, countBranches, countResources } from '@/lib/platform/usage'
import { LIVE_STATUSES } from './lifecycle'
import { deadlinesFor } from './dunning-policy'
import type { OwnSubscription, SubscribablePlan } from './data'

/**
 * Everything the owner billing portal renders, in ONE RLS-scoped transaction
 * (M16 #5).
 *
 * ── Why one reader and one transaction ──────────────────────────────────────
 *
 * The page shows five things that have to agree with each other: the plan, what
 * that plan entitles, what the tenant is actually using, the catalogue it could
 * move to, and the invoices it has been sent. Fetching those separately would
 * let a renewal land between two of them and render "Starter — 6 of 5 staff"
 * beside an invoice for Pro. One transaction is one consistent moment.
 *
 * ── Nothing here re-implements a rule ───────────────────────────────────────
 *
 * Every answer comes from the module that already owns the question:
 *
 *   readEntitlements()   M16 #1 — which plan is live, and what it grants
 *   decideLimit()        M16 #2 — what a limit VALUE means, fail-closed
 *   moduleGranted()      M16 #2 — what a module flag means
 *   countBranches() etc. M16 #2 — what the tenant is using
 *
 * So the "4 of 5 used" bar and the guard that refuses the 6th are computed by
 * the same code. A missing key reads as DENIED here exactly as it does at the
 * enforcement point — never as "unlimited", which is the mistake that would
 * make this page quietly advertise capacity a tenant does not have.
 *
 * ── And nothing here is a security boundary ─────────────────────────────────
 *
 * withUser() on the restricted `arena_app` role; RLS decides every row.
 * `platform_invoices_owner_select` (0072) admits only invoices for a tenant the
 * caller OWNS, `tenant_subscriptions_select` (0070) only their own
 * subscription. The tenant id comes from the resolved context, never from an
 * argument. The page's role check is presentation; this is the wall.
 */

export type LimitUsage = {
  key: string
  label: string
  used: number
  /** null means UNLIMITED. 0 together with `denied` means the plan excludes it. */
  limit: number | null
  denied: boolean
  /** Why it is denied, for the copy. Null when it is not. */
  deniedReason: 'no_plan' | 'missing' | 'malformed' | null
}

export type ModuleUsage = { key: string; label: string; enabled: boolean }

export type PortalPlan = SubscribablePlan & {
  /** The plan's own entitlements, for the comparison grid. */
  entitlements: Record<string, EntitlementValue>
  isCurrent: boolean
}

export type PortalInvoice = {
  id: string
  kind: 'subscription' | 'credit_note'
  invoiceNumber: string
  invoiceDate: string
  planName: string
  billingPeriodStart: Date
  billingPeriodEnd: Date
  billingPeriodType: 'monthly' | 'annual'
  taxTotal: string
  total: string
  currency: string
  status: string
  /** A stored document, when one exists. Null today — see migration 0072. */
  documentUrl: string | null
}

/**
 * The arrears state, if the business is in one (AROS-113).
 *
 * ── Why this is not folded into `subscription` above ────────────────────────
 *
 * `subscription` is the LIVE subscription, and a suspended or cancelled one is
 * by definition not live — it has left LIVE_STATUSES, so that field is null
 * exactly when the owner most needs to be told what happened and what to do
 * about it. Without this, a suspended business would open the billing page and
 * see an empty plan panel with no explanation, which is the one outcome
 * AROS-113 §6 explicitly rules out ("shown a clear reactivation/payment
 * message").
 *
 * Every date here comes from lib/platform/billing/dunning-policy.ts, the same
 * module the scheduled processor computes its deadlines with. There is no
 * second calculation, so the banner cannot promise a suspension date the job
 * does not honour.
 */
export type DunningState = {
  /**
   * grace     — in arrears, still fully working, suspension pending.
   * suspended — access restricted; a payment still reverses it.
   * cancelled — closed. Recovery means choosing a plan again, not paying this one.
   */
  state: 'grace' | 'suspended' | 'cancelled'
  /** When (or when) the account is suspended. */
  graceEndsAt: Date
  /** When the subscription is (or was) cancelled. Null until suspension. */
  cancelsAt: Date | null
  /** What the gateway said about the failed charge. Null when it said nothing. */
  reason: string | null
}

export type BillingPortal = {
  subscription: OwnSubscription | null
  /** Null when the business is not in arrears at all — the ordinary case. */
  dunning: DunningState | null
  /** Null when nothing is live — the fail-closed state, not "free forever". */
  planName: string | null
  status: TenantEntitlements['status']
  limits: LimitUsage[]
  modules: ModuleUsage[]
  plans: PortalPlan[]
  invoices: PortalInvoice[]
  /** The price the tenant is billed, from the plan it is actually on. */
  currentPrice: string | null
  currency: string
}

/**
 * The limits shown, and their nouns.
 *
 * `KNOWN_ENTITLEMENT_KEYS` (seed data) is deliberately NOT the source: it is a
 * typing convenience for the admin form, not an allow-list, and the database is
 * free to carry keys this build has never heard of. What IS listed here is the
 * set the app can put a USAGE NUMBER against — the three counters
 * lib/platform/usage.ts implements. A plan key with no counter has nothing to
 * draw a bar for, so it is left to the plan grid rather than rendered as
 * "? of 5".
 */
const COUNTED_LIMITS: { key: string; label: string }[] = [
  { key: 'max_branches', label: 'Branches' },
  { key: 'max_staff', label: 'Staff' },
  { key: 'max_resources', label: 'Resources' },
]

/** "module.payroll" → "Payroll". Derived, not looked up — the guard's own rule. */
function moduleLabel(key: string): string {
  const tail = key.startsWith('module.') ? key.slice('module.'.length) : key
  const words = tail.replace(/[_.]/g, ' ').trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

export async function getBillingPortal(ctx: ActiveContext): Promise<BillingPortal> {
  return withUser(ctx.user.id, async (tx) => {
    const tenantId = ctx.tenant.id

    // The live subscription and what it grants — the SAME reader the guards
    // use, so this page and enforcement can never disagree about the plan.
    const entitled = await readEntitlements(tx, tenantId)
    const resolved: Resolved = {
      entitlements: entitled.entitlements,
      hasPlan: entitled.plan !== null,
    }

    const [subRow] = await tx
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
      // The one-live index permits a single row; ordering makes a database that
      // somehow held two resolve deterministically rather than by planner luck.
      .orderBy(desc(tenantSubscriptions.currentPeriodStart))
      .limit(1)

    // ── the arrears state (AROS-113) ────────────────────────────────────────
    //
    // A SECOND read, deliberately not filtered by LIVE_STATUSES: the whole
    // point is to describe a subscription that has left them. The most recent
    // row by period start, which is the same ordering every other reader here
    // uses — so a business that was cancelled and later re-subscribed sees its
    // NEW subscription's state, not the ghost of the old one.
    //
    // RLS (tenant_subscriptions_select, 0070) confines this to the caller's own
    // tenant exactly as it does the read above; the tenant id comes from the
    // resolved context.
    const [arrears] = await tx
      .select({
        status: tenantSubscriptions.status,
        pastDueSince: tenantSubscriptions.pastDueSince,
        suspendedAt: tenantSubscriptions.suspendedAt,
        reason: tenantSubscriptions.lastPaymentFailureReason,
      })
      .from(tenantSubscriptions)
      .where(eq(tenantSubscriptions.tenantId, tenantId))
      .orderBy(desc(tenantSubscriptions.currentPeriodStart))
      .limit(1)

    // The three states are read from the STATUS plus the clocks, never guessed
    // from one of them alone. An `expired` row with no `suspended_at` got there
    // some other way (`completed`, or a mandate never authenticated) and is not
    // an arrears case — the same distinction the dunning processor's candidate
    // scan draws.
    const dunningState: DunningState['state'] | null = !arrears?.pastDueSince
      ? null
      : arrears.status === 'cancelled' && arrears.suspendedAt
        ? 'cancelled'
        : arrears.status === 'expired' && arrears.suspendedAt
          ? 'suspended'
          : arrears.status === 'past_due'
            ? 'grace'
            : null

    const deadlines =
      dunningState && arrears
        ? deadlinesFor(arrears.pastDueSince, arrears.suspendedAt)
        : null

    const dunning: DunningState | null =
      dunningState && deadlines
        ? {
            state: dunningState,
            graceEndsAt: deadlines.graceEndsAt,
            cancelsAt: deadlines.cancelsAt,
            reason: arrears?.reason ?? null,
          }
        : null

    // Usage, counted in THIS transaction, by the same functions and the same
    // RLS scoping as the checkLimitIn() calls that enforce the cap — so the
    // number shown is the number that gets compared against.
    const [branchCount, staffCount, resourceCount] = await Promise.all([
      countBranches(tx, tenantId),
      countActiveStaff(tx, tenantId),
      countResources(tx, tenantId),
    ])
    const used: Record<string, number> = {
      max_branches: branchCount,
      max_staff: staffCount,
      max_resources: resourceCount,
    }

    const limits: LimitUsage[] = COUNTED_LIMITS.map(({ key, label }) => {
      const d = decideLimit(resolved, key)
      return {
        key,
        label,
        used: used[key] ?? 0,
        limit: d.kind === 'unlimited' ? null : d.kind === 'limit' ? d.limit : 0,
        denied: d.kind === 'denied',
        deniedReason: d.kind === 'denied' ? d.reason : null,
      }
    })

    // Modules are whatever `module.*` keys the plan actually carries. Nothing is
    // hard-coded: an operator adding `module.events` from the admin UI gets it
    // here on the next request, which is the whole point of entitlements being
    // rows rather than columns.
    const modules: ModuleUsage[] = Object.keys(entitled.entitlements)
      .filter((k) => k.startsWith('module.'))
      .sort()
      .map((key) => ({
        key,
        label: moduleLabel(key),
        enabled: moduleGranted(resolved, key),
      }))

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

    const catalogueEntitlements = await tx
      .select({
        planId: planEntitlements.planId,
        key: planEntitlements.key,
        value: planEntitlements.value,
      })
      .from(planEntitlements)
      .orderBy(asc(planEntitlements.key))

    const byPlan = new Map<string, Record<string, EntitlementValue>>()
    for (const e of catalogueEntitlements) {
      const bag = byPlan.get(e.planId) ?? {}
      bag[e.key] = e.value as EntitlementValue
      byPlan.set(e.planId, bag)
    }

    const portalPlans: PortalPlan[] = catalogue
      // A retired plan the tenant is grandfathered onto stays readable (RLS
      // policy plans_select_subscribed, 0070) but must never be offered.
      .filter((p) => p.active)
      .map((p) => ({
        id: p.id,
        name: p.name,
        monthlyPrice: p.monthlyPrice,
        annualPrice: p.annualPrice,
        currency: p.currency,
        monthlyAvailable: p.gateway !== null && p.monthlyPlanId !== null,
        annualAvailable: p.gateway !== null && p.annualPlanId !== null,
        entitlements: byPlan.get(p.id) ?? {},
        isCurrent: subRow?.planId === p.id,
      }))

    const invoices = await tx
      .select({
        id: platformInvoices.id,
        kind: platformInvoices.kind,
        invoiceNumber: platformInvoices.invoiceNumber,
        invoiceDate: platformInvoices.invoiceDate,
        planName: platformInvoices.planName,
        billingPeriodStart: platformInvoices.billingPeriodStart,
        billingPeriodEnd: platformInvoices.billingPeriodEnd,
        billingPeriodType: platformInvoices.billingPeriodType,
        taxTotal: platformInvoices.taxTotal,
        total: platformInvoices.total,
        currency: platformInvoices.currency,
        status: platformInvoices.status,
        documentUrl: platformInvoices.documentUrl,
      })
      .from(platformInvoices)
      // Belt and braces beside RLS: correct on its own terms, and it keeps the
      // read on idx_platform_invoices_tenant.
      .where(eq(platformInvoices.tenantId, tenantId))
      .orderBy(desc(platformInvoices.invoiceDate), desc(platformInvoices.createdAt))
      .limit(50)

    return {
      subscription: subRow
        ? {
            id: subRow.id,
            planId: subRow.planId,
            planName: subRow.planName,
            billingPeriod: subRow.billingPeriod,
            status: subRow.status,
            currentPeriodStart: subRow.currentPeriodStart,
            currentPeriodEnd: subRow.currentPeriodEnd,
            cancelAtPeriodEnd: subRow.cancelAtPeriodEnd,
            gatewaySubscriptionId: subRow.gatewaySubscriptionId,
            // "Lapsed" means the plan grants nothing, so it is computed from
            // the SAME effective expiry readEntitlements() uses: the later of
            // the paid period and the grace deadline. A failed renewal leaves
            // current_period_end in the past, so without the grace term this
            // would tell a business in a perfectly good grace period that its
            // features were unavailable while they demonstrably still worked.
            lapsed:
              (dunning?.state === 'grace'
                ? Math.max(subRow.currentPeriodEnd.getTime(), dunning.graceEndsAt.getTime())
                : subRow.currentPeriodEnd.getTime()) <= Date.now(),
          }
        : null,
      dunning,
      // From readEntitlements(), NOT from the row above: the two differ exactly
      // when a subscription has lapsed on the clock, and the entitled answer is
      // the one the rest of the app acts on.
      planName: entitled.plan?.name ?? null,
      status: entitled.status,
      limits,
      modules,
      plans: portalPlans,
      invoices,
      currentPrice: subRow
        ? subRow.billingPeriod === 'monthly'
          ? subRow.monthlyPrice
          : subRow.annualPrice
        : null,
      currency: subRow?.currency ?? 'INR',
    }
  })
}
