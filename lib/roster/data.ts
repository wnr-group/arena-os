import 'server-only'
import { and, asc, eq, gte, lte } from 'drizzle-orm'
import { withUser } from '@/db'
import { rosters, shifts, memberships } from '@/db/schema'
import type { ActiveContext } from '@/lib/tenant/context'
import { addDays } from '@/lib/booking/data'

export function getRoster(ctx: ActiveContext, branchId: string, weekStart: string) {
  return withUser(ctx.user.id, async (tx) => {
    const [roster] = await tx
      .select()
      .from(rosters)
      .where(and(eq(rosters.tenantId, ctx.tenant.id), eq(rosters.branchId, branchId), eq(rosters.weekStart, weekStart)))
      .limit(1)
    return roster ?? null
  })
}

/** All shifts on a roster, with the assigned member's name/role — the weekly builder's grid. */
export function listRosterShifts(ctx: ActiveContext, rosterId: string) {
  return withUser(ctx.user.id, (tx) =>
    tx
      .select({
        id: shifts.id,
        membershipId: shifts.membershipId,
        memberName: memberships.fullName,
        memberRole: memberships.role,
        shiftDate: shifts.shiftDate,
        type: shifts.type,
        starts: shifts.starts,
        ends: shifts.ends,
      })
      .from(shifts)
      .innerJoin(memberships, eq(memberships.id, shifts.membershipId))
      .where(and(eq(shifts.tenantId, ctx.tenant.id), eq(shifts.rosterId, rosterId)))
      .orderBy(asc(shifts.shiftDate), asc(shifts.starts)),
  )
}

/** A member's own shifts for the 7 days starting `weekStart` ("staff see their shifts"). */
export function listMyShifts(ctx: ActiveContext, weekStart: string) {
  const weekEnd = addDays(weekStart, 6)
  return withUser(ctx.user.id, (tx) =>
    tx
      .select({
        id: shifts.id,
        shiftDate: shifts.shiftDate,
        type: shifts.type,
        starts: shifts.starts,
        ends: shifts.ends,
      })
      .from(shifts)
      .where(
        and(
          eq(shifts.tenantId, ctx.tenant.id),
          eq(shifts.membershipId, ctx.membershipId),
          gte(shifts.shiftDate, weekStart),
          lte(shifts.shiftDate, weekEnd),
        ),
      )
      .orderBy(asc(shifts.shiftDate), asc(shifts.starts)),
  )
}
