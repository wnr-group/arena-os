'use server'

import { revalidatePath } from 'next/cache'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { withUser } from '@/db'
import { income } from '@/db/schema'
import { requireManager, AuthError } from '@/lib/auth/guard'
import { EntitlementError, requireEntitlement } from '@/lib/platform/entitlement-guard'

type Result = { error?: string }

/**
 * Other income create / edit / delete (M40 / AROS-357). Mirrors
 * lib/actions/expenses.ts.
 *
 * Manager-only at BOTH layers: requireManager() here and the income_write RLS
 * policy (auth_is_manager). `tenantId` is never a parameter — it comes from the
 * session — and every mutation carries an explicit tenant_id predicate, so a
 * manager of tenant A targeting tenant B's id matches zero rows.
 */

function fail(e: unknown): Result {
  if (e instanceof AuthError) return { error: e.message }
  if (e instanceof EntitlementError) return { error: e.message }
  if (e instanceof z.ZodError) return { error: e.issues[0]?.message ?? 'Check the values entered.' }
  // The DB backstops the amount rule (check_violation) and note length.
  const code = dbCode(e)
  if (code === '23514') return { error: 'Check the amount and note entered.' }

  console.error('[income] action failed:', e)
  return { error: 'Could not save the income. Please try again.' }
}

/** Postgres error code, dug out of Drizzle's wrapper errors. */
function dbCode(e: unknown): string | undefined {
  let cur: unknown = e
  for (let depth = 0; depth < 5 && cur && typeof cur === 'object'; depth++) {
    const o = cur as { code?: unknown; cause?: unknown }
    if (typeof o.code === 'string') return o.code
    cur = o.cause
  }
  return undefined
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

const incomeInput = z.object({
  amount: z.coerce
    .number({ invalid_type_error: 'Enter an amount.' })
    .finite('Enter a valid amount.')
    .nonnegative('An amount cannot be negative.')
    .max(99_999_999.99, 'That amount is too large.'),
  receivedOn: z
    .string()
    .regex(DATE_RE, 'Enter a valid date.')
    // Rejects '2026-02-30' and '2026-13-01', which the regex alone allows.
    .refine((s) => {
      const [y, m, d] = s.split('-').map(Number)
      const dt = new Date(Date.UTC(y, m - 1, d))
      return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
    }, 'Enter a valid date.'),
  note: z
    .string()
    .trim()
    .max(500, 'Keep the note to 500 characters.')
    .optional()
    .nullable()
    .transform((v) => (v ? v : null)),
})

const incomeId = z.string().uuid('That income reference is not valid.')

/** Money is written as a fixed 2-decimal STRING, never a float. */
function toValues(v: z.output<typeof incomeInput>) {
  return { amount: v.amount.toFixed(2), receivedOn: v.receivedOn, note: v.note }
}

export async function createIncome(input: z.input<typeof incomeInput>): Promise<Result> {
  try {
    const ctx = await requireManager()
    await requireEntitlement(ctx, 'module.expenses')
    const v = incomeInput.parse(input)

    await withUser(ctx.user.id, (tx) =>
      tx.insert(income).values({ tenantId: ctx.tenant.id, ...toValues(v) }),
    )

    revalidatePath('/income')
    return {}
  } catch (e) {
    return fail(e)
  }
}

export async function updateIncome(id: string, input: z.input<typeof incomeInput>): Promise<Result> {
  try {
    const ctx = await requireManager()
    await requireEntitlement(ctx, 'module.expenses')
    const target = incomeId.parse(id)
    const v = incomeInput.parse(input)

    const updated = await withUser(ctx.user.id, (tx) =>
      tx
        .update(income)
        .set(toValues(v))
        .where(and(eq(income.id, target), eq(income.tenantId, ctx.tenant.id)))
        .returning({ id: income.id }),
    )

    if (updated.length === 0) return { error: 'That income entry no longer exists.' }

    revalidatePath('/income')
    return {}
  } catch (e) {
    return fail(e)
  }
}

/** Hard delete: nothing references an income row. */
export async function deleteIncome(id: string): Promise<Result> {
  try {
    const ctx = await requireManager()
    await requireEntitlement(ctx, 'module.expenses')
    const target = incomeId.parse(id)

    await withUser(ctx.user.id, (tx) =>
      tx.delete(income).where(and(eq(income.id, target), eq(income.tenantId, ctx.tenant.id))),
    )

    revalidatePath('/income')
    return {}
  } catch (e) {
    return fail(e)
  }
}
