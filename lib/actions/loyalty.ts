'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { withUser } from '@/db'
import { loyaltySettings } from '@/db/schema'
import { requireManager, AuthError } from '@/lib/auth/guard'
import { zodErrorMessage, pgError } from '@/lib/utils/errors'

/**
 * Loyalty programme settings — the tenant's earn/redeem rule.
 *
 * Same shape as the other settings actions (see lib/actions/tax-rates.ts):
 * requireManager() → Zod → one withUser() transaction → revalidate → flat
 * result. Authorisation is enforced twice, deliberately:
 *
 *   requireManager()          the action refuses a cashier outright
 *   loyalty_settings_write    the RLS policy (0039) checks auth_is_manager()
 *                             again in the database
 *
 * Hiding the sidebar entry is neither of those — a cashier POSTing straight to
 * this action still gets "Only owners and managers can do this."
 *
 * `tenant_id` comes from the authenticated context and is never accepted from
 * the caller, so a manager of tenant A cannot address tenant B's row; the RLS
 * policy would refuse it even if the id were forged.
 */

type Result = { success?: true; error?: string }

function fail(e: unknown): Result {
  if (e instanceof AuthError) return { error: e.message }
  if (e instanceof z.ZodError) return { error: zodErrorMessage(e) }
  // 23514 = check_violation. The database enforces the same positivity rules
  // the schema below does, so this is a belt-and-braces branch rather than an
  // expected path — but it must not surface raw SQL to a user.
  const { code } = pgError(e)
  if (code === '23514') return { error: 'Those values are outside the allowed range.' }
  console.error('[loyalty-settings] save failed:', e)
  return { error: 'Could not save the loyalty settings. Please try again.' }
}

/**
 * ── Why three of these are `> 0` and not `>= 0` ─────────────────────────────
 *
 * The database CHECKs in migration 0039 are `points_per_unit > 0`,
 * `unit_amount > 0`, `point_value > 0` and `min_redeem_points >= 0`. Validating
 * `>= 0` here — as a naive reading of the requirement would — would let a form
 * submit 0 and then fail at the constraint with a generic error, which is a
 * worse experience than a clear field message.
 *
 * The values are also meaningless at zero: `unitAmount = 0` divides nothing
 * into nothing (pointsForSpend guards it by returning 0), `pointsPerUnit = 0`
 * earns nothing, and `pointValue = 0` makes every point worth nothing. Each is
 * an attempt to express "switch the programme off", which is exactly what
 * `isActive` is for — so the form offers that instead.
 *
 * `minRedeemPoints` genuinely may be 0: it means "no floor", which is the
 * shipped default.
 */
const loyaltySettingsInput = z.object({
  pointsPerUnit: z.coerce
    .number({ invalid_type_error: 'Enter a number.' })
    .int('Points must be a whole number — the ledger stores integers.')
    .positive('Must be greater than zero. Use the on/off switch to disable the programme.')
    .max(10_000, 'That is unusually high — keep it under 10,000.'),

  unitAmount: z.coerce
    .number({ invalid_type_error: 'Enter a number.' })
    .positive('Must be greater than zero. Use the on/off switch to disable the programme.')
    .max(1_000_000, 'That is unusually high.'),

  pointValue: z.coerce
    .number({ invalid_type_error: 'Enter a number.' })
    .positive('Must be greater than zero. Use the on/off switch to disable the programme.')
    .max(10_000, 'That is unusually high.'),

  minRedeemPoints: z.coerce
    .number({ invalid_type_error: 'Enter a number.' })
    .int('Must be a whole number of points.')
    .min(0, 'Cannot be negative.')
    .max(1_000_000, 'That is unusually high.'),

  isActive: z.boolean(),
})
// z.coerce.number() turns '' into 0 and 'abc' into NaN; .positive()/.min()
// reject the former and every numeric check rejects NaN, so neither reaches
// the database. Infinity is caught by the .max() bounds above.

/**
 * Declared explicitly rather than via z.input<>. `z.coerce.number()` types its
 * INPUT as `number`, but the whole point of the coercion is that the form sends
 * the raw strings the user typed — including "" and "1." — for the schema to
 * judge. Accepting `string | number` here states that contract honestly instead
 * of forcing the form to pre-convert and lose the distinction between "empty"
 * and "zero".
 */
export type LoyaltySettingsInput = {
  pointsPerUnit: string | number
  unitAmount: string | number
  pointValue: string | number
  minRedeemPoints: string | number
  isActive: boolean
}

/**
 * Create or update the tenant's loyalty rule.
 *
 * Upsert on `tenant_id`, which IS the primary key (0039), so a tenant that has
 * never configured the programme gets its row written here on first save — and
 * one that never opens this page keeps working on DEFAULT_LOYALTY_RULE.
 */
export async function updateLoyaltySettings(input: LoyaltySettingsInput): Promise<Result> {
  try {
    const ctx = await requireManager()
    const v = loyaltySettingsInput.parse(input)

    await withUser(ctx.user.id, async (tx) => {
      await tx
        .insert(loyaltySettings)
        .values({
          tenantId: ctx.tenant.id,
          pointsPerUnit: v.pointsPerUnit,
          // numeric(10,2) columns are written as fixed-2 strings, the same way
          // every other money value in this codebase is.
          unitAmount: v.unitAmount.toFixed(2),
          pointValue: v.pointValue.toFixed(2),
          minRedeemPoints: v.minRedeemPoints,
          isActive: v.isActive,
        })
        .onConflictDoUpdate({
          target: loyaltySettings.tenantId,
          set: {
            pointsPerUnit: v.pointsPerUnit,
            unitAmount: v.unitAmount.toFixed(2),
            pointValue: v.pointValue.toFixed(2),
            minRedeemPoints: v.minRedeemPoints,
            isActive: v.isActive,
            updatedAt: new Date(),
          },
        })
    })

    revalidatePath('/settings/loyalty')

    return { success: true }
  } catch (e) {
    return fail(e)
  }
}
