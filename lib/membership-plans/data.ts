import 'server-only'
import { and, asc, eq } from 'drizzle-orm'
import { withUser } from '@/db'
import { membershipPlans } from '@/db/schema'
import type { ActiveContext } from '@/lib/tenant/context'

/**
 * The tenant's membership plan catalogue — same ctx-taking reader shape as
 * lib/tax-rates/data.ts and lib/promo-codes/data.ts. The tenant comes from the
 * authenticated context, never from the client, and membership_plans_select
 * scopes the read again in the database.
 *
 * Retired plans are included: managers need to see what was once sold, and
 * AROS-60 purchases will keep pointing at them.
 */
export function listMembershipPlans(ctx: ActiveContext) {
  return withUser(ctx.user.id, (tx) =>
    tx
      .select()
      .from(membershipPlans)
      .where(eq(membershipPlans.tenantId, ctx.tenant.id))
      .orderBy(asc(membershipPlans.name)),
  )
}

/**
 * Only what a customer can currently buy — the list AROS-60's purchase screen
 * will offer.
 */
export function listActiveMembershipPlans(ctx: ActiveContext) {
  return withUser(ctx.user.id, (tx) =>
    tx
      .select()
      .from(membershipPlans)
      .where(and(eq(membershipPlans.tenantId, ctx.tenant.id), eq(membershipPlans.isActive, true)))
      .orderBy(asc(membershipPlans.price)),
  )
}

/** A single plan, or undefined when it is not this tenant's. */
export async function getMembershipPlan(ctx: ActiveContext, planId: string) {
  const [plan] = await withUser(ctx.user.id, (tx) =>
    tx
      .select()
      .from(membershipPlans)
      .where(and(eq(membershipPlans.id, planId), eq(membershipPlans.tenantId, ctx.tenant.id)))
      .limit(1),
  )
  return plan
}
