import 'server-only'
import { and, asc, desc, eq, inArray } from 'drizzle-orm'
import { ownerDb } from '@/db'
import { planEntitlements, plans, tenantSubscriptions } from '@/db/schema'
import { requirePlatformAdmin } from '../guard'

/**
 * Platform-admin reads for the plan catalogue (M16).
 *
 * Same rule as lib/platform/data.ts, restated because it is the security
 * boundary: these run on the OWNER connection and therefore bypass RLS, so each
 * enforces requirePlatformAdmin() ITSELF. A layout that hides the output still
 * executes the page, so a page-only guard would leak the catalogue into the RSC
 * payload of any signed-in user who guessed the URL.
 */

export type AdminPlan = {
  id: string
  name: string
  monthlyPrice: string
  annualPrice: string
  currency: string
  active: boolean
  /**
   * The Razorpay Subscription plan backing each billing period (M16 #3, 0071).
   * NOT credentials — a `plan_…` reference is public and appears in the
   * checkout page Razorpay serves the payer. Every secret lives in
   * platform_payment_settings, which nothing outside
   * lib/platform/billing/credentials.ts may read.
   */
  gateway: string | null
  gatewayMonthlyPlanId: string | null
  gatewayAnnualPlanId: string | null
  /** How many tenants are on this plan, live or not — the "safe to retire?" signal. */
  subscriberCount: number
  entitlements: { id: string; key: string; value: unknown }[]
}

export async function listPlans(): Promise<AdminPlan[]> {
  await requirePlatformAdmin()

  const rows = await ownerDb
    .select({
      id: plans.id,
      name: plans.name,
      monthlyPrice: plans.monthlyPrice,
      annualPrice: plans.annualPrice,
      currency: plans.currency,
      active: plans.active,
      gateway: plans.gateway,
      gatewayMonthlyPlanId: plans.gatewayMonthlyPlanId,
      gatewayAnnualPlanId: plans.gatewayAnnualPlanId,
    })
    .from(plans)
    // Live plans first, then alphabetically — a retired plan is history and
    // should not sit between two sellable ones.
    .orderBy(asc(plans.name))

  if (rows.length === 0) return []

  // Two flat reads and a join in memory rather than one aggregate query: the
  // catalogue is a handful of rows, and this keeps the entitlement list an
  // ordinary array instead of a json_agg the caller has to unpack.
  const ents = await ownerDb
    .select({
      id: planEntitlements.id,
      planId: planEntitlements.planId,
      key: planEntitlements.key,
      value: planEntitlements.value,
    })
    .from(planEntitlements)
    .orderBy(asc(planEntitlements.key))

  const subs = await ownerDb
    .select({ planId: tenantSubscriptions.planId })
    .from(tenantSubscriptions)

  const counts = new Map<string, number>()
  for (const s of subs) counts.set(s.planId, (counts.get(s.planId) ?? 0) + 1)

  return rows
    .map((p) => ({
      ...p,
      subscriberCount: counts.get(p.id) ?? 0,
      entitlements: ents
        .filter((e) => e.planId === p.id)
        .map(({ id, key, value }) => ({ id, key, value })),
    }))
    .sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name))
}

/** One plan with its entitlements, or null. */
export async function getPlan(id: string): Promise<AdminPlan | null> {
  await requirePlatformAdmin()
  const all = await listPlans()
  return all.find((p) => p.id === id) ?? null
}

/**
 * The tenant's LIVE subscription row, for the company detail page.
 *
 * Filtered to the same three statuses as idx_tenant_subscriptions_one_live in
 * 0070, so this returns the row that is actually in force rather than the first
 * one in the tenant's history. Unlike readEntitlements() it does NOT apply the
 * clock test: an operator looking at an account needs to SEE a lapsed
 * subscription, which is precisely the thing they would be there to fix.
 */
export async function getTenantSubscription(tenantId: string) {
  await requirePlatformAdmin()
  const [row] = await ownerDb
    .select({
      id: tenantSubscriptions.id,
      planId: plans.id,
      planName: plans.name,
      billingPeriod: tenantSubscriptions.billingPeriod,
      status: tenantSubscriptions.status,
      currentPeriodEnd: tenantSubscriptions.currentPeriodEnd,
      // Gateway state (M16 #3): null for a plan an operator assigned by hand,
      // set for one the business bought through Razorpay Subscriptions. The
      // difference decides whether "cancel" means anything on this account.
      gatewaySubscriptionId: tenantSubscriptions.gatewaySubscriptionId,
      cancelAtPeriodEnd: tenantSubscriptions.cancelAtPeriodEnd,
    })
    .from(tenantSubscriptions)
    .innerJoin(plans, eq(plans.id, tenantSubscriptions.planId))
    .where(
      and(
        eq(tenantSubscriptions.tenantId, tenantId),
        inArray(tenantSubscriptions.status, ['trialing', 'active', 'past_due']),
      ),
    )
    .orderBy(desc(tenantSubscriptions.currentPeriodStart))
    .limit(1)

  return row ?? null
}
