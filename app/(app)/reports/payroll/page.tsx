import { redirect } from 'next/navigation'
import { Users, TrendingUp, TrendingDown, Wallet, type LucideIcon } from 'lucide-react'
import { getActiveContext } from '@/lib/tenant/context'
import { hasEntitlement } from '@/lib/platform/entitlement-guard'
import { isManager, ROLE_LABELS, type MemberRole } from '@/lib/auth/roles'
import { getPayrollCostReport } from '@/lib/reports/payroll'
import { formatMoney, formatPayrollPeriod, shiftPayrollPeriod } from '@/lib/format'
import { todayInZone } from '@/lib/booking/time'
import { PeriodRangeFilter } from '@/components/reports/PeriodRangeFilter'
import { ExportCsvButton } from '@/components/reports/ExportCsvButton'

type Search = { from?: string; to?: string }

function isValidPeriod(s: string | undefined): s is string {
  return !!s && /^\d{4}-\d{2}$/.test(s)
}

export default async function PayrollCostReportPage({ searchParams }: { searchParams: Promise<Search> }) {
  const ctx = await getActiveContext()
  if (!ctx) return null
  // Presentation only — getPayrollCostReport() is read-only and tenant-scoped
  // by payslips_manager_select RLS (0030) regardless of this gate.
  if (!isManager(ctx.role)) redirect('/dashboard')
  // Plan gate (M16 #2). PRESENTATION ONLY — the readers below and every
  // action in this module call requireEntitlement() themselves and throw.
  // This only turns that refusal into a redirect instead of an error page.
  if (!(await hasEntitlement(ctx, 'module.reports'))) redirect('/dashboard')

  const sp = await searchParams
  const currentPeriod = todayInZone(ctx.tenant.timezone).slice(0, 7)
  const to = isValidPeriod(sp.to) ? sp.to : currentPeriod
  // Six months back by default — enough to see a trend without an empty page
  // on a fresh tenant with only one or two payroll runs behind it.
  let from = isValidPeriod(sp.from) ? sp.from : shiftPayrollPeriod(to, -5)
  if (from > to) from = to

  const report = await getPayrollCostReport(ctx, from, to)
  const money = (n: number) => formatMoney(n, ctx.tenant.currency)

  const csvRows = report.rows.map((r) => ({
    employee: r.fullName || r.email || 'Unnamed',
    role: ROLE_LABELS[r.role as MemberRole] ?? r.role,
    payslips: r.payslipCount,
    gross: r.totalGross.toFixed(2),
    deductions: r.totalDeductions.toFixed(2),
    advanceRecovered: r.totalAdvanceRecovered.toFixed(2),
    netPay: r.totalNetPay.toFixed(2),
  }))

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
      <h1 className="text-2xl font-semibold">Payroll Cost Report</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Total wage bill for {formatPayrollPeriod(from)} – {formatPayrollPeriod(to)}, aggregated from posted payslips.
      </p>

      <div className="mt-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard icon={Users} label="Employees paid" value={String(report.rows.length)} accent="bg-muted text-muted-foreground" />
        <StatCard icon={TrendingUp} label="Total gross" value={money(report.totals.totalGross)} accent="bg-primary/10 text-primary" />
        <StatCard
          icon={TrendingDown}
          label="Deductions + advances recovered"
          value={money(report.totals.totalDeductions + report.totals.totalAdvanceRecovered)}
          accent="bg-amber-500/10 text-amber-600"
        />
        <StatCard
          icon={Wallet}
          label="Total net pay — the wage bill"
          value={money(report.totals.totalNetPay)}
          accent="bg-emerald-500/10 text-emerald-600"
        />
      </div>

      <PeriodRangeFilter basePath="/reports/payroll" from={from} to={to} maxPeriod={currentPeriod} />

      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Per-employee breakdown</h2>
        <ExportCsvButton
          rows={csvRows}
          filename={`payroll-cost-${from}_to_${to}.csv`}
          columns={[
            { key: 'employee', label: 'Employee' },
            { key: 'role', label: 'Role' },
            { key: 'payslips', label: 'Payslips' },
            { key: 'gross', label: 'Gross' },
            { key: 'deductions', label: 'Deductions' },
            { key: 'advanceRecovered', label: 'Advance Recovered' },
            { key: 'netPay', label: 'Net Pay' },
          ]}
        />
      </div>

      <div className="mt-3 overflow-hidden rounded-xl border border-border">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] text-left text-base">
            <thead className="bg-muted/40 text-sm uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-3 font-medium">Employee</th>
                <th className="px-4 py-3 font-medium">Role</th>
                <th className="px-4 py-3 text-right font-medium">Payslips</th>
                <th className="px-4 py-3 text-right font-medium">Gross</th>
                <th className="px-4 py-3 text-right font-medium">Deductions</th>
                <th className="px-4 py-3 text-right font-medium">Advance Recovered</th>
                <th className="px-4 py-3 text-right font-medium">Net Pay</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {report.rows.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-sm text-muted-foreground">
                    No payroll cost in this range.
                  </td>
                </tr>
              )}
              {report.rows.map((r) => (
                <tr key={r.membershipId} className="transition hover:bg-muted/20">
                  <td className="px-4 py-3 font-medium">{r.fullName || r.email || 'Unnamed'}</td>
                  <td className="px-4 py-3 text-muted-foreground">{ROLE_LABELS[r.role as MemberRole] ?? r.role}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{r.payslipCount}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{money(r.totalGross)}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-destructive">{money(r.totalDeductions)}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-amber-600">{money(r.totalAdvanceRecovered)}</td>
                  <td className="px-4 py-3 text-right font-semibold tabular-nums">{money(r.totalNetPay)}</td>
                </tr>
              ))}
            </tbody>
            {report.rows.length > 0 && (
              <tfoot>
                <tr className="border-t border-border bg-muted/20 font-semibold">
                  <td className="px-4 py-3" colSpan={2}>
                    Total
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">{report.totals.payslipCount}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{money(report.totals.totalGross)}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{money(report.totals.totalDeductions)}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{money(report.totals.totalAdvanceRecovered)}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{money(report.totals.totalNetPay)}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>
    </div>
  )
}

function StatCard({
  icon: Icon,
  label,
  value,
  accent,
}: {
  icon: LucideIcon
  label: string
  value: string
  accent: string
}) {
  return (
    <div className="group rounded-xl border border-border bg-card p-4 shadow-sm transition-all duration-300 hover:-translate-y-1 hover:border-primary/30 hover:shadow-md hover:shadow-primary/5 sm:p-5">
      <div className={`inline-flex size-9 items-center justify-center rounded-lg transition-transform duration-300 group-hover:scale-110 ${accent}`}>
        <Icon size={18} />
      </div>
      <p className="mt-3 text-2xl font-semibold tracking-tight">{value}</p>
      <p className="mt-0.5 text-sm text-muted-foreground">{label}</p>
    </div>
  )
}
