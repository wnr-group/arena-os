'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { withUser } from '@/db'
import { requireManager, AuthError } from '@/lib/auth/guard'
import { todayInZone } from '@/lib/booking/time'
import { EntitlementError, requireEntitlement } from '@/lib/platform/entitlement-guard'
import { TIP_ROLES } from '@/lib/tips/rules'
import {
  TipError,
  finalizeTipPeriodCore,
  markTipPayoutPaidCore,
  reopenTipPeriodCore,
  saveTipRulesCore,
} from '@/lib/tips/service'
import { zodErrorMessage } from '@/lib/utils/errors'

const MODULE = 'module.tips'

type Result = { error?: string }

function fail(e: unknown): Result {
  if (e instanceof AuthError || e instanceof TipError || e instanceof EntitlementError) return { error: e.message }
  if (e instanceof z.ZodError) return { error: zodErrorMessage(e) }
  return { error: e instanceof Error ? e.message : 'Something went wrong.' }
}

type Ctx = Awaited<ReturnType<typeof requireManager>>

/** Owner/manager, restaurant, plan with Tips — enforced here, not by hiding the nav entry. */
async function run<T>(fn: (ctx: Ctx, actor: { tenantId: string; membershipId: string }) => Promise<T>): Promise<Result & { data?: T }> {
  try {
    const ctx = await requireManager()
    if (ctx.tenant.industry !== 'restaurant') throw new AuthError('Tips management is for restaurant venues.')
    await requireEntitlement(ctx, MODULE)
    const data = await fn(ctx, { tenantId: ctx.tenant.id, membershipId: ctx.membershipId })
    revalidatePath('/settings/tips')
    revalidatePath('/reports/tips')
    return { data }
  } catch (e) {
    return fail(e)
  }
}

const rulesInput = z.object({
  mode: z.enum(['direct', 'pooled']),
  tipOutPct: z.coerce.number().finite(),
  // Free strings here; validateTipRules() is the one place that knows which roles are real.
  poolRoles: z.array(z.string()).max(TIP_ROLES.length),
  tipOutRoles: z.array(z.string()).max(TIP_ROLES.length),
})

export async function saveTipRules(input: z.input<typeof rulesInput>) {
  return run((ctx, a) => {
    const v = rulesInput.parse(input)
    return withUser(ctx.user.id, (tx) => saveTipRulesCore(tx, a, v))
  })
}

const period = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Pick a month.')

/** Close a finished month: freeze the rules and totals, write what each person is owed. */
export async function finalizeTipPeriod(p: string) {
  return run((ctx, a) => {
    const v = period.parse(p)
    return withUser(ctx.user.id, (tx) => finalizeTipPeriodCore(tx, a, v, todayInZone(ctx.tenant.timezone)))
  })
}

/** Undo a finalisation (only while nothing in it has been paid). */
export async function reopenTipPeriod(p: string) {
  return run((ctx, a) => {
    const v = period.parse(p)
    return withUser(ctx.user.id, (tx) => reopenTipPeriodCore(tx, a, v))
  })
}

/** Settle one payout outside payroll (cash, or someone with no payslip). */
export async function markTipPayoutPaid(payoutId: string) {
  return run((ctx, a) => {
    const id = z.string().uuid().parse(payoutId)
    return withUser(ctx.user.id, (tx) => markTipPayoutPaidCore(tx, a, id))
  })
}
