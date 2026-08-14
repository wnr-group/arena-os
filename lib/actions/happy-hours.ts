'use server'

import { revalidatePath } from 'next/cache'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { withUser } from '@/db'
import { happyHours } from '@/db/schema'
import { requireManager, AuthError } from '@/lib/auth/guard'
import { zodErrorMessage, pgError } from '@/lib/utils/errors'

type Result = { error?: string }

function fail(e: unknown): Result {
  if (e instanceof AuthError) return { error: e.message }
  if (e instanceof z.ZodError) return { error: zodErrorMessage(e) }
  const { code } = pgError(e)
  if (code === '23505') return { error: 'That name is already in use.' }
  if (code === '23503' || code === '23001') return { error: 'This is still in use elsewhere and cannot be deleted.' }
  console.error('[happy-hours] action failed:', e)
  return { error: 'Something went wrong. Please try again.' }
}

const timeRegex = /^\d{2}:\d{2}$/

const happyHourInput = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1, 'Name is required'),
  daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1, 'Select at least one day'),
  startTime: z.string().regex(timeRegex, 'Invalid start time'),
  endTime: z.string().regex(timeRegex, 'Invalid end time'),
  discountType: z.enum(['percentage', 'fixed']),
  discountValue: z.coerce.number().min(0),
  isActive: z.boolean().default(true),
})

function revalidateHappyHourPaths() {
  revalidatePath('/settings/happy-hours')
}

export async function upsertHappyHour(input: z.input<typeof happyHourInput>): Promise<Result> {
  try {
    const ctx = await requireManager()
    const v = happyHourInput.parse(input)
    if (v.endTime <= v.startTime) return { error: 'End time must be after start time.' }
    if (v.discountType === 'percentage' && v.discountValue > 100) {
      return { error: 'Percentage discount cannot exceed 100.' }
    }
    await withUser(ctx.user.id, async (tx) => {
      const values = {
        tenantId: ctx.tenant.id,
        name: v.name,
        daysOfWeek: v.daysOfWeek,
        startTime: v.startTime,
        endTime: v.endTime,
        discountType: v.discountType,
        discountValue: v.discountValue.toFixed(2),
        isActive: v.isActive,
      }
      if (v.id) {
        await tx
          .update(happyHours)
          .set(values)
          .where(and(eq(happyHours.id, v.id), eq(happyHours.tenantId, ctx.tenant.id)))
      } else {
        await tx.insert(happyHours).values(values)
      }
    })
    revalidateHappyHourPaths()
    return {}
  } catch (e) {
    return fail(e)
  }
}

export async function deleteHappyHour(id: string): Promise<Result> {
  try {
    const ctx = await requireManager()
    await withUser(ctx.user.id, (tx) =>
      tx.delete(happyHours).where(and(eq(happyHours.id, id), eq(happyHours.tenantId, ctx.tenant.id))),
    )
    revalidateHappyHourPaths()
    return {}
  } catch (e) {
    return fail(e)
  }
}
