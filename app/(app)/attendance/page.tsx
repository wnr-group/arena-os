import { getActiveContext } from '@/lib/tenant/context'
import { isManager } from '@/lib/auth/roles'
import { listTodayAttendance } from '@/lib/attendance/data'
import { todayInZone } from '@/lib/booking/time'
import { AttendanceView } from '@/components/attendance/AttendanceView'

export default async function AttendancePage() {
  const ctx = await getActiveContext()
  if (!ctx) return null

  const workDate = todayInZone(ctx.tenant.timezone)
  const rows = await listTodayAttendance(ctx, workDate)

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
      <h1 className="text-2xl font-semibold">Attendance</h1>
      <p className="mt-1 text-sm text-muted-foreground">Clock in/out and today&apos;s attendance — tenant &amp; branch scoped.</p>
      <AttendanceView
        workDate={workDate}
        timeZone={ctx.tenant.timezone}
        currentMembershipId={ctx.membershipId}
        isManagerView={isManager(ctx.role)}
        rows={rows.map((r) => ({
          membershipId: r.membershipId,
          fullName: r.fullName,
          email: r.email,
          role: r.role,
          attendanceId: r.attendanceId,
          clockIn: r.clockIn ? r.clockIn.toISOString() : null,
          clockOut: r.clockOut ? r.clockOut.toISOString() : null,
          isManual: r.isManual ?? false,
          note: r.note,
        }))}
      />
    </div>
  )
}
