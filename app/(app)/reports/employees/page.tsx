import { redirect } from 'next/navigation'
import { getActiveContext } from '@/lib/tenant/context'
import { isManager, ROLE_LABELS, type MemberRole } from '@/lib/auth/roles'
import { getEmployeeAnalytics } from '@/lib/reports/employees'
import { formatMoney } from '@/lib/format'
import { todayInZone } from '@/lib/booking/time'
import { addDays } from '@/lib/booking/data'
import { DateRangeFilter } from '@/components/reports/DateRangeFilter'

type Search = { from?: string; to?: string }

function isValidDate(s: string | undefined): s is string {
  return !!s && /^\d{4}-\d{2}-\d{2}$/.test(s)
}

export default async function EmployeeReportPage({ searchParams }: { searchParams: Promise<Search> }) {
  const ctx = await getActiveContext()
  if (!ctx) return null
  // Presentation only — getEmployeeAnalytics() is read-only and tenant-scoped
  // by RLS regardless; this just keeps the page off non-managers' nav.
  if (!isManager(ctx.role)) redirect('/dashboard')

  const tz = ctx.tenant.timezone
  const sp = await searchParams
  const today = todayInZone(tz)
  const to = isValidDate(sp.to) ? sp.to : today
  let from = isValidDate(sp.from) ? sp.from : addDays(to, -29)
  if (from > to) from = to

  const rows = await getEmployeeAnalytics(ctx, from, to)

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
      <h1 className="text-2xl font-semibold">Employee Analytics</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        See who&apos;s billing the most, who&apos;s taking the bookings, and attendance at a glance for {ctx.tenant.name}.
      </p>

      <DateRangeFilter basePath="/reports/employees" from={from} to={to} today={today} />

      <div className="mt-6 overflow-x-auto rounded-2xl border border-border bg-card shadow-sm">
        <table className="w-full text-left text-base">
          <thead>
            <tr className="border-b border-border text-sm uppercase tracking-wider text-muted-foreground">
              <th className="px-4 py-3.5 font-semibold">Employee</th>
              <th className="px-4 py-3.5 font-semibold">Role</th>
              <th className="px-4 py-3.5 font-semibold text-right">Sales Collected</th>
              <th className="px-4 py-3.5 font-semibold text-right">Bookings Created</th>
              <th className="px-4 py-3.5 font-semibold text-right">Days Present</th>
              <th className="px-4 py-3.5 font-semibold text-right">Hours Worked</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-base text-muted-foreground">
                  No active employees.
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.membershipId} className="border-b border-border last:border-0">
                <td className="px-4 py-3.5">
                  <div className="font-medium text-foreground">{r.fullName || r.email || 'Unnamed'}</div>
                  {r.fullName && r.email && <div className="text-sm text-muted-foreground">{r.email}</div>}
                </td>
                <td className="px-4 py-3.5 text-muted-foreground">{ROLE_LABELS[r.role as MemberRole]}</td>
                <td className="px-4 py-3.5 text-right tabular-nums">
                  {formatMoney(r.salesCollected, ctx.tenant.currency)}
                </td>
                <td className="px-4 py-3.5 text-right tabular-nums">{r.bookingsCreated}</td>
                <td className="px-4 py-3.5 text-right tabular-nums">{r.daysPresent}</td>
                <td className="px-4 py-3.5 text-right tabular-nums">{r.hoursWorked.toFixed(1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
