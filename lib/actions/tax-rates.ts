'use server'

import { revalidatePath } from 'next/cache'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { withUser } from '@/db'
import { taxRates } from '@/db/schema'
import { requireManager, AuthError } from '@/lib/auth/guard'

type Result = { error?: string }

function fail(e: unknown): Result {
  if (e instanceof AuthError) return { error: e.message }
  const msg = e instanceof Error ? e.message : 'Something went wrong.'
  if (/unique|duplicate/i.test(msg)) return { error: 'That name is already in use.' }
  if (/foreign key|violates.*constraint/i.test(msg)) {
    return { error: 'This is still in use elsewhere and cannot be deleted.' }
  }
  return { error: msg }
}

const taxRateInput = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1, 'Name is required'),
  percent: z.coerce.number().min(0).max(100),
  isActive: z.boolean().default(true),
})

function revalidateTaxRatePaths() {
  revalidatePath('/settings/tax-rates')
  revalidatePath('/menu/items')
}

export async function upsertTaxRate(input: z.input<typeof taxRateInput>): Promise<Result> {
  try {
    const ctx = await requireManager()
    const v = taxRateInput.parse(input)
    await withUser(ctx.user.id, async (tx) => {
      const values = {
        tenantId: ctx.tenant.id,
        name: v.name,
        percent: v.percent.toFixed(2),
        isActive: v.isActive,
      }
      if (v.id) {
        await tx
          .update(taxRates)
          .set(values)
          .where(and(eq(taxRates.id, v.id), eq(taxRates.tenantId, ctx.tenant.id)))
      } else {
        await tx.insert(taxRates).values(values)
      }
    })
    revalidateTaxRatePaths()
    return {}
  } catch (e) {
    return fail(e)
  }
}

export async function deleteTaxRate(id: string): Promise<Result> {
  try {
    const ctx = await requireManager()
    await withUser(ctx.user.id, (tx) =>
      tx.delete(taxRates).where(and(eq(taxRates.id, id), eq(taxRates.tenantId, ctx.tenant.id))),
    )
    revalidateTaxRatePaths()
    return {}
  } catch (e) {
    return fail(e)
  }
}
