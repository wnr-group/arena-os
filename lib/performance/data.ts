import 'server-only'
import { and, asc, eq, gte, lte, sql } from 'drizzle-orm'
import { withUser } from '@/db'
import { attendance, memberships, tasks } from '@/db/schema'
import type { ActiveContext } from '@/lib/tenant/context'

export type PerformanceRow = {
  membershipId: string
  fullName: string | null
  email: string | null
  role: string
  daysPresent: number
  hoursWorked: number
  tasksAssigned: number
  tasksCompleted: number
}

/**
 * Per-employee attendance + task totals for [from, to] (inclusive `YYYY-MM-DD`
 * dates) — everything a manager needs for the Performance page, aggregated in
 * SQL. Attendance and tasks are aggregated in separate GROUP BY subqueries
 * before joining to memberships, so a member with many rows in one table never
 * inflates the count in the other (a single join across both would multiply
 * rows). Tasks without a due date fall outside every period and are never
 * counted — that matches attendance, which only exists for a worked day.
 */
export function getPerformanceSummary(ctx: ActiveContext, from: string, to: string) {
  return withUser(ctx.user.id, async (tx) => {
    const attendanceAgg = tx
      .select({
        membershipId: attendance.membershipId,
        daysPresent: sql<number>`count(*) filter (where ${attendance.clockIn} is not null)::int`.as('days_present'),
        hoursWorked: sql<number>`coalesce(sum(extract(epoch from (${attendance.clockOut} - ${attendance.clockIn})) / 3600) filter (where ${attendance.clockIn} is not null and ${attendance.clockOut} is not null), 0)::float`.as(
          'hours_worked',
        ),
      })
      .from(attendance)
      .where(and(eq(attendance.tenantId, ctx.tenant.id), gte(attendance.workDate, from), lte(attendance.workDate, to)))
      .groupBy(attendance.membershipId)
      .as('attendance_agg')

    const tasksAgg = tx
      .select({
        membershipId: tasks.assignedTo,
        tasksAssigned: sql<number>`count(*)::int`.as('tasks_assigned'),
        tasksCompleted: sql<number>`count(*) filter (where ${tasks.status} = 'done')::int`.as('tasks_completed'),
      })
      .from(tasks)
      .where(and(eq(tasks.tenantId, ctx.tenant.id), gte(tasks.dueDate, from), lte(tasks.dueDate, to)))
      .groupBy(tasks.assignedTo)
      .as('tasks_agg')

    const rows = await tx
      .select({
        membershipId: memberships.id,
        fullName: memberships.fullName,
        email: memberships.email,
        role: memberships.role,
        daysPresent: sql<number>`coalesce(${attendanceAgg.daysPresent}, 0)::int`,
        hoursWorked: sql<number>`coalesce(${attendanceAgg.hoursWorked}, 0)::float`,
        tasksAssigned: sql<number>`coalesce(${tasksAgg.tasksAssigned}, 0)::int`,
        tasksCompleted: sql<number>`coalesce(${tasksAgg.tasksCompleted}, 0)::int`,
      })
      .from(memberships)
      .leftJoin(attendanceAgg, eq(attendanceAgg.membershipId, memberships.id))
      .leftJoin(tasksAgg, eq(tasksAgg.membershipId, memberships.id))
      .where(and(eq(memberships.tenantId, ctx.tenant.id), eq(memberships.status, 'active')))
      .orderBy(asc(memberships.role), asc(memberships.fullName))

    return rows as PerformanceRow[]
  })
}
