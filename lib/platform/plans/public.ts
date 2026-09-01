import 'server-only'
import { asc, eq } from 'drizzle-orm'
import { withPublicApp } from '@/db'
import { planEntitlements, plans } from '@/db/schema'

/**
 * The plan catalogue as an ANONYMOUS visitor may see it (M16 #6).
 *
 * ── Why this is not listPlans() ─────────────────────────────────────────────
 *
 * lib/platform/plans/data.ts runs on the OWNER connection behind
 * requirePlatformAdmin(), and returns things a stranger has no business seeing:
 * the Razorpay `plan_…` references, and how many tenants are on each plan. The
 * signup page needs neither, and calling that reader from a public route would
 * mean either weakening its guard or leaking operator data into an RSC payload.
 *
 * So this is a separate, deliberately narrow reader on the RESTRICTED app
 * connection with no identity set at all. Two things then protect it:
 *
 *   * `plans_select_active` (0050) — `for select using (active)`, with no
 *     tenant predicate. A retired plan is invisible here even to a query that
 *     asked for it by id, so an inactive plan cannot be subscribed to by
 *     guessing its id from an older page load.
 *   * the column list below, which simply never mentions the gateway columns.
 *
 * `plan_entitlements_select` is expressed as "visible exactly when its plan is",
 * so the entitlement rows follow the same rule with nothing extra to maintain.
 *
 * Prices come from these rows and are for DISPLAY. Nothing the browser sends
 * back is trusted: the signup action re-reads the plan by id server-side, and
 * lib/platform/billing/subscribe.ts additionally proves the gateway plan
 * charges what this catalogue advertises before creating anything.
 */

/** A JSON scalar, same shape lib/platform/entitlements.ts returns. */
export type PublicEntitlementValue = number | boolean | string | null

export type PublicPlan = {
  id: string
  name: string
  /** numeric(10,2) as a string, all the way from Postgres. Never a float. */
  monthlyPrice: string
  annualPrice: string
  currency: string
  /** Whatever keys the operator has configured. Never an allow-list. */
  entitlements: Record<string, PublicEntitlementValue>
}

export async function listPublicPlans(): Promise<PublicPlan[]> {
  return withPublicApp(async (tx) => {
    const rows = await tx
      .select({
        id: plans.id,
        name: plans.name,
        monthlyPrice: plans.monthlyPrice,
        annualPrice: plans.annualPrice,
        currency: plans.currency,
      })
      .from(plans)
      // The predicate is belt-and-braces — `plans_select_active` has already
      // reduced the table to active rows — so the query is correct on its own
      // terms rather than by reference to a policy in another file.
      .where(eq(plans.active, true))
      .orderBy(asc(plans.monthlyPrice), asc(plans.name))

    if (rows.length === 0) return []

    const ents = await tx
      .select({
        planId: planEntitlements.planId,
        key: planEntitlements.key,
        value: planEntitlements.value,
      })
      .from(planEntitlements)
      .orderBy(asc(planEntitlements.key))

    return rows.map((p) => ({
      ...p,
      entitlements: Object.fromEntries(
        ents.filter((e) => e.planId === p.id).map((e) => [e.key, e.value as PublicEntitlementValue]),
      ),
    }))
  })
}

/**
 * One active plan, by id, for the SERVER to price a signup against.
 *
 * Separate from the list because the signup action must not price a checkout
 * from whatever the browser posted back. It re-reads the row, and gets null for
 * a plan that is retired or does not exist — which the caller turns into the
 * same refusal, so a retired plan id is not distinguishable from a fabricated
 * one.
 */
export async function getPublicPlan(planId: string): Promise<PublicPlan | null> {
  const all = await listPublicPlans()
  return all.find((p) => p.id === planId) ?? null
}
