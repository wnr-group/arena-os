'use server'

import { revalidatePath } from 'next/cache'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { withUser } from '@/db'
import { attendance, memberships } from '@/db/schema'
import { requireContext, requireManager, AuthError } from '@/lib/auth/guard'
import { getPrimaryBranch } from '@/lib/attendance/data'
import { todayInZone, zonedTimeToUtc } from '@/lib/booking/time'

type Result = { error?: string }

function fail(e: unknown): Result {
  if (e instanceof AuthError) return { error: e.message }
  return { error: e instanceof Error ? e.message : 'Something went wrong.' }
}

/** The branch attendance rows are filed under: the member's own branch, else the tenant's primary branch. */
async function resolveBranchId(ctx: Awaited<ReturnType<typeof requireContext>>, memberBranchId: string | null) {
  if (memberBranchId) return memberBranchId
  const branch = await getPrimaryBranch(ctx)
  if (!branch) throw new Error('No branch configured for this business.')
  return branch.id
}

export async function clockIn(): Promise<Result> {
  try {
    const ctx = await requireContext()
    const workDate = todayInZone(ctx.tenant.timezone)
    const branchId = await resolveBranchId(ctx, ctx.branchId)

    await withUser(ctx.user.id, async (tx) => {
      const [existing] = await tx
        .select({ id: attendance.id, clockIn: attendance.clockIn })
        .from(attendance)
        .where(and(eq(attendance.membershipId, ctx.membershipId), eq(attendance.workDate, workDate)))
        .limit(1)

      if (existing?.clockIn) throw new Error('You are already clocked in today.')

      if (existing) {
        await tx.update(attendance).set({ clockIn: new Date() }).where(eq(attendance.id, existing.id))
      } else {
        await tx.insert(attendance).values({
          tenantId: ctx.tenant.id,
          branchId,
          membershipId: ctx.membershipId,
          workDate,
          clockIn: new Date(),
        })
      }
    })

    revalidatePath('/attendance')
    return {}
  } catch (e) {
    return fail(e)
  }
}

export async function clockOut(): Promise<Result> {
  try {
    const ctx = await requireContext()
    const workDate = todayInZone(ctx.tenant.timezone)

    await withUser(ctx.user.id, async (tx) => {
      const [existing] = await tx
        .select({ id: attendance.id, clockOut: attendance.clockOut })
        .from(attendance)
        .where(and(eq(attendance.membershipId, ctx.membershipId), eq(attendance.workDate, workDate)))
        .limit(1)

      if (!existing) throw new Error("You haven't clocked in today.")
      if (existing.clockOut) throw new Error('You are already clocked out.')

      await tx.update(attendance).set({ clockOut: new Date() }).where(eq(attendance.id, existing.id))
    })

    revalidatePath('/attendance')
    return {}
  } catch (e) {
    return fail(e)
  }
}

const correctionInput = z.object({
  id: z.string().uuid().optional(),
  membershipId: z.string().uuid(),
  workDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  clockIn: z.string().regex(/^\d{2}:\d{2}$/).nullable(),
  clockOut: z.string().regex(/^\d{2}:\d{2}$/).nullable(),
  note: z.string().trim().optional(),
})

/** Manager add/correct: back-fill a missed punch or fix a wrong time. */
export async function managerSaveAttendance(input: z.input<typeof correctionInput>): Promise<Result> {
  try {
    const ctx = await requireManager()
    const v = correctionInput.parse(input)

    if (v.clockIn && v.clockOut && v.clockOut <= v.clockIn) {
      return { error: 'Clock out must be after clock in.' }
    }

    const clockIn = v.clockIn ? zonedTimeToUtc(v.workDate, v.clockIn, ctx.tenant.timezone) : null
    const clockOut = v.clockOut ? zonedTimeToUtc(v.workDate, v.clockOut, ctx.tenant.timezone) : null

    await withUser(ctx.user.id, async (tx) => {
      const [member] = await tx
        .select({ branchId: memberships.branchId })
        .from(memberships)
        .where(and(eq(memberships.id, v.membershipId), eq(memberships.tenantId, ctx.tenant.id)))
        .limit(1)
      if (!member) throw new Error('That team member was not found.')

      const branchId = await resolveBranchId(ctx, member.branchId)
      const values = {
        tenantId: ctx.tenant.id,
        branchId,
        membershipId: v.membershipId,
        workDate: v.workDate,
        clockIn,
        clockOut,
        isManual: true,
        note: v.note || null,
      }

      if (v.id) {
        await tx.update(attendance).set(values).where(and(eq(attendance.id, v.id), eq(attendance.tenantId, ctx.tenant.id)))
        return
      }

      const [existing] = await tx
        .select({ id: attendance.id })
        .from(attendance)
        .where(and(eq(attendance.membershipId, v.membershipId), eq(attendance.workDate, v.workDate)))
        .limit(1)

      if (existing) {
        await tx.update(attendance).set(values).where(eq(attendance.id, existing.id))
      } else {
        await tx.insert(attendance).values(values)
      }
    })

    revalidatePath('/attendance')
    return {}
  } catch (e) {
    return fail(e)
  }
}

export async function managerDeleteAttendance(id: string): Promise<Result> {
  try {
    const ctx = await requireManager()
    await withUser(ctx.user.id, (tx) =>
      tx.delete(attendance).where(and(eq(attendance.id, id), eq(attendance.tenantId, ctx.tenant.id))),
    )
    revalidatePath('/attendance')
    return {}
  } catch (e) {
    return fail(e)
  }
}
