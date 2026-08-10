import 'server-only'
import { and, asc, eq } from 'drizzle-orm'
import { withUser } from '@/db'
import { branches, attendance, memberships } from '@/db/schema'
import type { ActiveContext } from '@/lib/tenant/context'

/** The tenant's primary branch — attendance hangs off a branch like resources/hours. */
export function getPrimaryBranch(ctx: ActiveContext) {
  return withUser(ctx.user.id, async (tx) => {
    const [branch] = await tx
      .select({ id: branches.id, name: branches.name })
      .from(branches)
      .where(and(eq(branches.tenantId, ctx.tenant.id), eq(branches.isPrimary, true)))
      .limit(1)
    return branch ?? null
  })
}

/** One row per active member for `workDate` — punched or not — the day's attendance view. */
export function listTodayAttendance(ctx: ActiveContext, workDate: string) {
  return withUser(ctx.user.id, (tx) =>
    tx
      .select({
        membershipId: memberships.id,
        fullName: memberships.fullName,
        email: memberships.email,
        role: memberships.role,
        attendanceId: attendance.id,
        clockIn: attendance.clockIn,
        clockOut: attendance.clockOut,
        isManual: attendance.isManual,
        note: attendance.note,
      })
      .from(memberships)
      .leftJoin(attendance, and(eq(attendance.membershipId, memberships.id), eq(attendance.workDate, workDate)))
      .where(and(eq(memberships.tenantId, ctx.tenant.id), eq(memberships.status, 'active')))
      .orderBy(asc(memberships.role), asc(memberships.fullName)),
  )
}
