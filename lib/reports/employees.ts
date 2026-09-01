import 'server-only'
import { and, asc, eq, gte, lt, lte, sql } from 'drizzle-orm'
import { withUser } from '@/db'
import { attendance, bookings, memberships, payments } from '@/db/schema'
import type { ActiveContext } from '@/lib/tenant/context'
import { isManager } from '@/lib/auth/roles'
import { ReportAccessError } from './daily-revenue'
import { requireEntitlement } from '@/lib/platform/entitlement-guard'
import { zonedTimeToUtc } from '@/lib/booking/time'
import { addDays } from '@/lib/booking/data'

export type EmployeeAnalyticsRow = {
  membershipId: string
  fullName: string | null
  email: string | null
  role: string
  salesCollected: number
  bookingsCreated: number
  daysPresent: number
  hoursWorked: number
}

/**
 * Per-employee sales, bookings and attendance totals for [from, to] (inclusive
 * `YYYY-MM-DD` dates, interpreted in the tenant's timezone) — the analytics
 * sibling of getPerformanceSummary (lib/performance/data.ts), same aggregate-
 * then-join shape so a member with many rows in one source never inflates the
 * count from another. Sales and bookings hang off `payments.created_at` /
 * `bookings.created_at` (both timestamptz), so the range is converted to a UTC
 * instant window once and reused for both; attendance stays keyed on
 * `work_date`, already a plain date, like the performance dashboard.
 */
export async function getEmployeeAnalytics(ctx: ActiveContext, from: string, to: string) {
  // Defence in depth, matching the rest of lib/reports — the page redirects a
  // non-manager, but this reader refuses on its own account too.
  requireReportAccess(ctx)
  // Module gate (M16 #2): the plan must include Reports. Authoritative —
  // the page redirects for presentation, this is what actually refuses.
  await requireEntitlement(ctx, 'module.reports')

  const tz = ctx.tenant.timezone
  const rangeStart = zonedTimeToUtc(from, '00:00', tz)
  const rangeEnd = zonedTimeToUtc(addDays(to, 1), '00:00', tz)

  return withUser(ctx.user.id, async (tx) => {
    // Only 'captured' money is actually in the till — pending/failed/refunded
    // payments must not inflate what a cashier collected, same rule as
    // capturedTotal() in lib/billing/payments.ts.
    const salesAgg = tx
      .select({
        membershipId: payments.collectedBy,
        salesCollected:
          sql<number>`coalesce(sum(${payments.amount}) filter (where ${payments.status} = 'captured'), 0)::float`.as(
            'sales_collected',
          ),
      })
      .from(payments)
      .where(
        and(
          eq(payments.tenantId, ctx.tenant.id),
          gte(payments.createdAt, rangeStart),
          lt(payments.createdAt, rangeEnd),
        ),
      )
      .groupBy(payments.collectedBy)
      .as('sales_agg')

    // Every booking the member created, any status — this counts staff
    // booking activity, not confirmed revenue (that's salesAgg above).
    const bookingsAgg = tx
      .select({
        membershipId: bookings.createdBy,
        bookingsCreated: sql<number>`count(*)::int`.as('bookings_created'),
      })
      .from(bookings)
      .where(
        and(
          eq(bookings.tenantId, ctx.tenant.id),
          gte(bookings.createdAt, rangeStart),
          lt(bookings.createdAt, rangeEnd),
        ),
      )
      .groupBy(bookings.createdBy)
      .as('bookings_agg')

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

    const rows = await tx
      .select({
        membershipId: memberships.id,
        fullName: memberships.fullName,
        email: memberships.email,
        role: memberships.role,
        salesCollected: sql<number>`coalesce(${salesAgg.salesCollected}, 0)::float`,
        bookingsCreated: sql<number>`coalesce(${bookingsAgg.bookingsCreated}, 0)::int`,
        daysPresent: sql<number>`coalesce(${attendanceAgg.daysPresent}, 0)::int`,
        hoursWorked: sql<number>`coalesce(${attendanceAgg.hoursWorked}, 0)::float`,
      })
      .from(memberships)
      .leftJoin(salesAgg, eq(salesAgg.membershipId, memberships.id))
      .leftJoin(bookingsAgg, eq(bookingsAgg.membershipId, memberships.id))
      .leftJoin(attendanceAgg, eq(attendanceAgg.membershipId, memberships.id))
      .where(and(eq(memberships.tenantId, ctx.tenant.id), eq(memberships.status, 'active')))
      .orderBy(asc(memberships.role), asc(memberships.fullName))

    return rows as EmployeeAnalyticsRow[]
  })
}

function requireReportAccess(ctx: ActiveContext): void {
  if (!isManager(ctx.role)) {
    throw new ReportAccessError('Only owners and managers can view reports.')
  }
}
