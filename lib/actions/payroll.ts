'use server'

import { revalidatePath } from 'next/cache'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { withUser } from '@/db'
import { salaryStructures, employeeAdvances } from '@/db/schema'
import { requireOwner, AuthError } from '@/lib/auth/guard'
import { hasRecoveries } from '@/lib/payroll/advances'
import { zodErrorMessage, pgError } from '@/lib/utils/errors'

type Result = { error?: string }

class AdvanceError extends Error {}

function fail(e: unknown): Result {
  if (e instanceof AuthError) return { error: e.message }
  if (e instanceof AdvanceError) return { error: e.message }
  if (e instanceof z.ZodError) return { error: zodErrorMessage(e) }
  const { code, constraint } = pgError(e)
  if (code === '23505' && constraint === 'salary_structures_member_effective_key') {
    return { error: 'That employee already has a salary structure effective on that date.' }
  }
  console.error('[payroll] action failed:', e)
  return { error: 'Something went wrong. Please try again.' }
}

const componentInput = z.object({
  label: z.string().trim().min(1, 'Enter a label'),
  amount: z.coerce.number().min(0, 'Must be zero or more'),
})

const salaryStructureInput = z.object({
  id: z.string().uuid().optional(),
  membershipId: z.string().uuid('Choose an employee'),
  base: z.coerce.number().min(0, 'Must be zero or more'),
  allowances: z.array(componentInput).default([]),
  deductions: z.array(componentInput).default([]),
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter a valid date'),
})

/**
 * Insert a new version (a raise/change, dated from `effectiveFrom`) or, when
 * `id` is given, correct an existing row in place — see 0027_salary_structures
 * for why those are different operations. Owner-only: requireOwner() here and
 * the salary_structures_owner_rw RLS policy both gate this independently.
 */
export async function upsertSalaryStructure(input: z.input<typeof salaryStructureInput>): Promise<Result> {
  try {
    const ctx = await requireOwner()
    const v = salaryStructureInput.parse(input)

    const allowancesTotal = v.allowances.reduce((sum, a) => sum + a.amount, 0)
    const deductionsTotal = v.deductions.reduce((sum, d) => sum + d.amount, 0)
    if (v.base + allowancesTotal - deductionsTotal < 0) {
      return { error: 'Deductions cannot exceed base pay plus allowances.' }
    }

    const shared = {
      membershipId: v.membershipId,
      base: v.base.toFixed(2),
      allowances: v.allowances.map((a) => ({ label: a.label, amount: a.amount.toFixed(2) })),
      deductions: v.deductions.map((d) => ({ label: d.label, amount: d.amount.toFixed(2) })),
      effectiveFrom: v.effectiveFrom,
    }

    await withUser(ctx.user.id, async (tx) => {
      if (v.id) {
        await tx
          .update(salaryStructures)
          .set(shared)
          .where(and(eq(salaryStructures.id, v.id), eq(salaryStructures.tenantId, ctx.tenant.id)))
      } else {
        await tx.insert(salaryStructures).values({
          ...shared,
          tenantId: ctx.tenant.id,
          createdBy: ctx.membershipId,
        })
      }
    })
    revalidatePath('/settings/payroll/salary-structures')
    return {}
  } catch (e) {
    return fail(e)
  }
}

export async function deleteSalaryStructure(id: string): Promise<Result> {
  try {
    const ctx = await requireOwner()
    await withUser(ctx.user.id, (tx) =>
      tx
        .delete(salaryStructures)
        .where(and(eq(salaryStructures.id, id), eq(salaryStructures.tenantId, ctx.tenant.id))),
    )
    revalidatePath('/settings/payroll/salary-structures')
    return {}
  } catch (e) {
    return fail(e)
  }
}

const advanceInput = z.object({
  membershipId: z.string().uuid('Choose an employee'),
  amount: z.coerce.number().positive('Enter an amount greater than zero.'),
  instalmentAmount: z.coerce.number().positive('Enter an amount greater than zero.'),
  note: z.string().trim().optional(),
  givenAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter a valid date'),
})

/**
 * Records the advance itself (the plan). It does NOT touch the recovery
 * ledger — that's written by the payroll run (AROS-104) as it deducts each
 * period's instalment, matching the wallet/loyalty ledger's separation of
 * "the thing" from "the transactions against it."
 */
export async function recordAdvance(input: z.input<typeof advanceInput>): Promise<Result> {
  try {
    const ctx = await requireOwner()
    const v = advanceInput.parse(input)
    if (v.instalmentAmount > v.amount) {
      return { error: 'The instalment cannot be larger than the advance itself.' }
    }

    await withUser(ctx.user.id, (tx) =>
      tx.insert(employeeAdvances).values({
        tenantId: ctx.tenant.id,
        membershipId: v.membershipId,
        amount: v.amount.toFixed(2),
        instalmentAmount: v.instalmentAmount.toFixed(2),
        note: v.note || null,
        givenAt: v.givenAt,
        createdBy: ctx.membershipId,
      }),
    )
    revalidatePath('/settings/payroll/advances')
    return {}
  } catch (e) {
    return fail(e)
  }
}

/** Blocked once any recovery has been posted — deleting would silently orphan real ledger history. Correct with a new advance instead. */
export async function deleteAdvance(id: string): Promise<Result> {
  try {
    const ctx = await requireOwner()
    await withUser(ctx.user.id, async (tx) => {
      if (await hasRecoveries(tx, ctx.tenant.id, id)) {
        throw new AdvanceError('This advance already has recoveries recorded and cannot be deleted.')
      }
      await tx
        .delete(employeeAdvances)
        .where(and(eq(employeeAdvances.id, id), eq(employeeAdvances.tenantId, ctx.tenant.id)))
    })
    revalidatePath('/settings/payroll/advances')
    return {}
  } catch (e) {
    return fail(e)
  }
}
