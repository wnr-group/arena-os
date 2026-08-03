'use server'

import { revalidatePath } from 'next/cache'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { withUser } from '@/db'
import { resourceTypes, resources, workingHours } from '@/db/schema'
import { requireManager, AuthError } from '@/lib/auth/guard'

type Result = { error?: string }

function fail(e: unknown): Result {
  if (e instanceof AuthError) return { error: e.message }
  const msg = e instanceof Error ? e.message : 'Something went wrong.'
  if (/unique|duplicate/i.test(msg)) return { error: 'That name is already in use.' }
  return { error: msg }
}

// ── resource types ───────────────────────────────────────────────────────────
const resourceTypeInput = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1, 'Name is required'),
  description: z.string().trim().optional(),
  hourlyRate: z.coerce.number().min(0),
  bufferMinutes: z.coerce.number().int().min(0).default(0),
  capacity: z.coerce.number().int().positive().optional(),
  color: z.string().trim().optional(),
  isActive: z.boolean().default(true),
})

export async function upsertResourceType(input: z.input<typeof resourceTypeInput>): Promise<Result> {
  try {
    const ctx = await requireManager()
    const v = resourceTypeInput.parse(input)
    await withUser(ctx.user.id, async (tx) => {
      const values = {
        tenantId: ctx.tenant.id,
        name: v.name,
        description: v.description || null,
        hourlyRate: v.hourlyRate.toFixed(2),
        bufferMinutes: v.bufferMinutes,
        capacity: v.capacity ?? null,
        color: v.color || null,
        isActive: v.isActive,
      }
      if (v.id) {
        await tx
          .update(resourceTypes)
          .set(values)
          .where(and(eq(resourceTypes.id, v.id), eq(resourceTypes.tenantId, ctx.tenant.id)))
      } else {
        await tx.insert(resourceTypes).values(values)
      }
    })
    revalidatePath('/settings/resources')
    return {}
  } catch (e) {
    return fail(e)
  }
}

export async function deleteResourceType(id: string): Promise<Result> {
  try {
    const ctx = await requireManager()
    await withUser(ctx.user.id, (tx) =>
      tx.delete(resourceTypes).where(and(eq(resourceTypes.id, id), eq(resourceTypes.tenantId, ctx.tenant.id))),
    )
    revalidatePath('/settings/resources')
    return {}
  } catch (e) {
    return fail(e) // e.g. restrict violation if resources reference it
  }
}

// ── resources ────────────────────────────────────────────────────────────────
const resourceInput = z.object({
  id: z.string().uuid().optional(),
  branchId: z.string().uuid(),
  resourceTypeId: z.string().uuid(),
  name: z.string().trim().min(1, 'Name is required'),
  hourlyRateOverride: z.union([z.coerce.number().min(0), z.null()]).optional(),
  status: z.enum(['available', 'maintenance', 'inactive']).default('available'),
  sortOrder: z.coerce.number().int().default(0),
})

export async function upsertResource(input: z.input<typeof resourceInput>): Promise<Result> {
  try {
    const ctx = await requireManager()
    const v = resourceInput.parse(input)
    await withUser(ctx.user.id, async (tx) => {
      const values = {
        tenantId: ctx.tenant.id,
        branchId: v.branchId,
        resourceTypeId: v.resourceTypeId,
        name: v.name,
        hourlyRateOverride:
          v.hourlyRateOverride === null || v.hourlyRateOverride === undefined
            ? null
            : v.hourlyRateOverride.toFixed(2),
        status: v.status,
        sortOrder: v.sortOrder,
      }
      if (v.id) {
        await tx
          .update(resources)
          .set(values)
          .where(and(eq(resources.id, v.id), eq(resources.tenantId, ctx.tenant.id)))
      } else {
        await tx.insert(resources).values(values)
      }
    })
    revalidatePath('/settings/resources')
    revalidatePath('/bookings')
    return {}
  } catch (e) {
    return fail(e)
  }
}

export async function deleteResource(id: string): Promise<Result> {
  try {
    const ctx = await requireManager()
    await withUser(ctx.user.id, (tx) =>
      tx.delete(resources).where(and(eq(resources.id, id), eq(resources.tenantId, ctx.tenant.id))),
    )
    revalidatePath('/settings/resources')
    revalidatePath('/bookings')
    return {}
  } catch (e) {
    return fail(e)
  }
}

// ── working hours ────────────────────────────────────────────────────────────
const dayInput = z.object({
  dayOfWeek: z.number().int().min(0).max(6),
  openTime: z.string().regex(/^\d{2}:\d{2}$/),
  closeTime: z.string().regex(/^\d{2}:\d{2}$/),
  isClosed: z.boolean(),
})
const hoursInput = z.object({
  branchId: z.string().uuid(),
  days: z.array(dayInput).length(7),
})

export async function saveWorkingHours(input: z.input<typeof hoursInput>): Promise<Result> {
  try {
    const ctx = await requireManager()
    const v = hoursInput.parse(input)
    for (const d of v.days) {
      if (!d.isClosed && d.closeTime <= d.openTime) {
        return { error: `Close time must be after open time (day ${d.dayOfWeek}).` }
      }
    }
    await withUser(ctx.user.id, async (tx) => {
      for (const d of v.days) {
        await tx
          .insert(workingHours)
          .values({
            tenantId: ctx.tenant.id,
            branchId: v.branchId,
            dayOfWeek: d.dayOfWeek,
            openTime: d.openTime,
            closeTime: d.closeTime,
            isClosed: d.isClosed,
          })
          .onConflictDoUpdate({
            target: [workingHours.branchId, workingHours.dayOfWeek],
            set: { openTime: d.openTime, closeTime: d.closeTime, isClosed: d.isClosed },
          })
      }
    })
    revalidatePath('/settings/hours')
    revalidatePath('/bookings')
    return {}
  } catch (e) {
    return fail(e)
  }
}
