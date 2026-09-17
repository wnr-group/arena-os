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

/**
 * Accepts what a `<input type="time">` sends (HH:MM) AND what Postgres hands
 * back from a `time` column (HH:MM:SS).
 *
 * The seconds are not cosmetic: every read of happy_hours returns "13:00:00",
 * so any caller that round-trips a stored row through this action — the
 * enable/disable toggle used to — was rejected with "Invalid start time" and
 * could not turn a happy hour off. lib/happy-hours/apply.ts already slices to
 * HH:MM for the same reason; this is the one place that did not.
 *
 * Normalised to HH:MM so the `endTime <= startTime` comparison below is
 * comparing two strings of the same shape. Postgres stores either form
 * identically, so nothing about existing rows changes.
 */
const timeRegex = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/

const timeField = (label: string) =>
  z
    .string()
    .regex(timeRegex, label)
    .transform((v) => v.slice(0, 5))

const happyHourInput = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1, 'Name is required'),
  daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1, 'Select at least one day'),
  startTime: timeField('Invalid start time'),
  endTime: timeField('Invalid end time'),
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

/**
 * Turn one happy hour on or off, and touch nothing else.
 *
 * Same shape as setPromoCodeActive() (lib/actions/promo-codes.ts), and for the
 * same two reasons. It cannot fail on validation of fields the caller never
 * meant to change — which is exactly how stopping a live happy hour broke: the
 * toggle sent the whole row back, including the stored "13:00:00" the schema
 * then rejected. And it writes one column, so it cannot silently revert an
 * edit someone else made while this page was open, the way writing back a
 * whole browser-held row does.
 */
export async function setHappyHourActive(id: string, isActive: boolean): Promise<Result> {
  try {
    const ctx = await requireManager()
    const happyHourId = z.string().uuid('That happy hour reference is not valid.').parse(id)

    await withUser(ctx.user.id, (tx) =>
      tx
        .update(happyHours)
        .set({ isActive })
        .where(and(eq(happyHours.id, happyHourId), eq(happyHours.tenantId, ctx.tenant.id))),
    )

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
