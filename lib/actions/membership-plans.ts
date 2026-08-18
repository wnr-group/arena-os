'use server'

import { revalidatePath } from 'next/cache'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { withUser } from '@/db'
import { membershipPlans } from '@/db/schema'
import { requireManager, AuthError } from '@/lib/auth/guard'

type Result = { error?: string }

/**
 * Postgres error code, dug out of however many wrappers sit on top of it.
 *
 * Drizzle re-throws driver errors wrapped in its own Error whose `message` is
 * just `Failed query: insert into …` — the SQLSTATE and constraint name live on
 * `cause`, so matching on message text silently never fires. Same helper as
 * lib/actions/promo-codes.ts.
 */
function pgError(e: unknown): { code?: string; constraint?: string } {
  let cur: unknown = e
  for (let depth = 0; depth < 5 && cur && typeof cur === 'object'; depth++) {
    const o = cur as { code?: unknown; constraint?: unknown; cause?: unknown }
    if (typeof o.code === 'string') {
      return { code: o.code, constraint: typeof o.constraint === 'string' ? o.constraint : undefined }
    }
    cur = o.cause
  }
  return {}
}

function fail(e: unknown): Result {
  if (e instanceof AuthError) return { error: e.message }
  if (e instanceof z.ZodError) return { error: e.issues[0]?.message ?? 'Check the values entered.' }

  const { code } = pgError(e)
  // 23505 = unique_violation, from idx_membership_plans_active_name — scoped to
  // live plans, so the clash is always with one currently on sale.
  if (code === '23505') return { error: 'A live plan with that name already exists.' }
  // 23514 = check_violation — the DB backstops every rule Zod checks.
  if (code === '23514') return { error: 'Check the price, duration and benefit values.' }

  console.error('[membership-plans] action failed:', e)
  return { error: 'Could not save the membership plan. Please try again.' }
}

/**
 * The management contract.
 *
 * `tenant_id`, `created_at` are deliberately absent: the tenant comes from the
 * session, never from the browser.
 *
 * Benefits are three separate numbers rather than a description string, because
 * AROS-61 applies them at billing and must not have to parse prose.
 */
const planInput = z.object({
  name: z.string().trim().min(1, 'A plan name is required.').max(60, 'Keep the name to 60 characters.'),
  price: z.coerce
    .number({ invalid_type_error: 'Enter a price.' })
    .finite('Enter a price.')
    .min(0, 'A price cannot be negative.'),
  durationMonths: z.coerce
    .number({ invalid_type_error: 'Enter a duration in months.' })
    .int('Use a whole number of months.')
    .positive('A plan must last at least one month.')
    .max(120, 'Keep the duration to 120 months or fewer.'),
  discountPercent: z.coerce
    .number({ invalid_type_error: 'Enter a discount percentage.' })
    .finite('Enter a discount percentage.')
    .min(0, 'A discount cannot be negative.')
    .max(100, 'A discount cannot exceed 100%.'),
  freeHours: z.coerce
    .number({ invalid_type_error: 'Enter the free hours.' })
    .finite('Enter the free hours.')
    .min(0, 'Free hours cannot be negative.'),
  walletCredit: z.coerce
    .number({ invalid_type_error: 'Enter the wallet credit.' })
    .finite('Enter the wallet credit.')
    .min(0, 'Wallet credit cannot be negative.'),
  isActive: z.boolean().default(true),
})

const planId = z.string().uuid('That plan reference is not valid.')

/**
 * Money and benefit amounts are written as fixed 2-decimal STRINGS: the columns
 * are numeric(10,2) and Drizzle reads them back as strings, so keeping the
 * write side in the same shape means a value never makes a round trip through
 * a JavaScript float.
 */
function toValues(v: z.output<typeof planInput>) {
  return {
    name: v.name,
    price: v.price.toFixed(2),
    durationMonths: v.durationMonths,
    discountPercent: v.discountPercent.toFixed(2),
    freeHours: v.freeHours.toFixed(2),
    walletCredit: v.walletCredit.toFixed(2),
    isActive: v.isActive,
  }
}

/**
 * Create a plan. Manager-only at BOTH layers: requireManager() here, and the
 * membership_plans_write RLS policy (auth_is_manager) in the database — a
 * cashier calling this server action directly is refused twice.
 */
export async function createMembershipPlan(input: z.input<typeof planInput>): Promise<Result> {
  try {
    const ctx = await requireManager()
    const v = planInput.parse(input)

    await withUser(ctx.user.id, (tx) =>
      tx.insert(membershipPlans).values({ tenantId: ctx.tenant.id, ...toValues(v) }),
    )

    revalidatePath('/settings/memberships')
    return {}
  } catch (e) {
    return fail(e)
  }
}

/**
 * Edit a plan.
 *
 * The update set is the FULL editable shape, so a field the manager left alone
 * is rewritten with its current value rather than nulled — and `tenant_id`,
 * `created_at` are never in it.
 *
 * Editing the catalogue is a forward-looking change only. Once AROS-60 exists,
 * a purchase must SNAPSHOT the price and benefits it was sold at, so repricing
 * Gold tomorrow cannot retroactively rewrite what a customer already bought.
 */
export async function updateMembershipPlan(
  id: string,
  input: z.input<typeof planInput>,
): Promise<Result> {
  try {
    const ctx = await requireManager()
    const target = planId.parse(id)
    const v = planInput.parse(input)

    await withUser(ctx.user.id, (tx) =>
      tx
        .update(membershipPlans)
        .set(toValues(v))
        .where(and(eq(membershipPlans.id, target), eq(membershipPlans.tenantId, ctx.tenant.id))),
    )

    revalidatePath('/settings/memberships')
    return {}
  } catch (e) {
    return fail(e)
  }
}

/**
 * Retire (or re-list) a plan.
 *
 * Deactivating rather than deleting is deliberate: purchased memberships will
 * point at these rows, and a customer's record must keep saying which plan they
 * bought. Nothing else about the plan is touched.
 */
export async function setMembershipPlanActive(id: string, isActive: boolean): Promise<Result> {
  try {
    const ctx = await requireManager()
    const target = planId.parse(id)
    z.boolean().parse(isActive)

    await withUser(ctx.user.id, (tx) =>
      tx
        .update(membershipPlans)
        .set({ isActive })
        .where(and(eq(membershipPlans.id, target), eq(membershipPlans.tenantId, ctx.tenant.id))),
    )

    revalidatePath('/settings/memberships')
    return {}
  } catch (e) {
    return fail(e)
  }
}

/** Named alias for the ticket's primary verb — retires, never deletes. */
export async function deactivateMembershipPlan(id: string): Promise<Result> {
  return setMembershipPlanActive(id, false)
}
