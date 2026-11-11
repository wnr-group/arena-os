'use server'

import { revalidatePath } from 'next/cache'
import { withUser } from '@/db'
import { requireManager, AuthError } from '@/lib/auth/guard'
import { EntitlementError, requireEntitlement } from '@/lib/platform/entitlement-guard'
import { OpeningBalanceError, setOpeningBalance } from '@/lib/reports/financial-settings'

type Result = { error?: string }

/**
 * Save (or clear, with `null`) the P&L opening-balance reference (M40 /
 * AROS-359). Manager-only here and again by the financial_settings RLS policies;
 * the same module.expenses gate as the income ledger it sits beside. Writes an
 * audit row old → new. The amount is a STRING so it never meets a JS float.
 */
export async function saveOpeningBalance(
  input: { amount: string; asOf: string | null } | null,
): Promise<Result> {
  try {
    const ctx = await requireManager()
    await requireEntitlement(ctx, 'module.expenses')
    await withUser(ctx.user.id, (tx) =>
      setOpeningBalance(tx, { tenantId: ctx.tenant.id, membershipId: ctx.membershipId }, input),
    )
    revalidatePath('/reports/pnl')
    return {}
  } catch (e) {
    if (e instanceof AuthError || e instanceof EntitlementError || e instanceof OpeningBalanceError) {
      return { error: e.message }
    }
    console.error('[financial-settings] opening balance save failed', e)
    return { error: 'Could not save the opening balance. Please try again.' }
  }
}
