import { redirect } from 'next/navigation'
import { Info, TrendingDown, TrendingUp } from 'lucide-react'
import { getActiveContext } from '@/lib/tenant/context'
import { isManager } from '@/lib/auth/roles'
import { hasEntitlement } from '@/lib/platform/entitlement-guard'
import { getPnlReport, pnlCsvRows } from '@/lib/reports/pnl'
import { resolveDateRange } from '@/lib/reports/date-range'
import { formatMoney, prettyDate } from '@/lib/format'
import { todayInZone } from '@/lib/booking/time'
import { DateRangeFilter } from '@/components/reports/DateRangeFilter'
import { ExportCsvButton, type CsvColumn } from '@/components/reports/ExportCsvButton'
import { cn } from '@/lib/utils/cn'

type Search = { from?: string; to?: string }

/**
 * Profit & Loss (AROS-86) — revenue − expenses − payroll.
 *
 * Same shape as its siblings (/reports, /reports/sales): a server component
 * that resolves context, enforces authorization, and loads the report, with
 * the shared date filter and CSV button as the only client pieces.
 *
 * Authorization is enforced HERE and again inside getPnlReport(), which throws
 * ReportAccessError for a non-manager. The nav entry is convenience, never a
 * guard — a cashier who types the URL is redirected, and one who somehow
 * reached the reader would be refused by it.
 */
export default async function PnlReportPage({ searchParams }: { searchParams: Promise<Search> }) {
  const ctx = await getActiveContext()
  if (!ctx) return null // the layout already guards a missing session
  if (!isManager(ctx.role)) redirect('/dashboard')
  // Plan gate (M16 #2). PRESENTATION ONLY — getPnlReport() calls
  // requireEntitlement() itself and throws. This only turns that refusal into
  // a redirect instead of an error page.
  if (!(await hasEntitlement(ctx, 'module.reports'))) redirect('/dashboard')

  const tz = ctx.tenant.timezone
  const currency = ctx.tenant.currency
  const sp = await searchParams
  const today = todayInZone(tz)
  const range = resolveDateRange({ start: sp.from, end: sp.to }, { timeZone: tz })

  const report = await getPnlReport(ctx, range)
  const money = (n: number) => formatMoney(n, currency)
  const profitable = report.netProfit >= 0

  // Exports exactly the figures rendered below — pnlCsvRows() projects the very
  // report object this page renders, so the file cannot disagree with the
  // screen. Expense and payroll rows are negative, so the four lines sum to net.
  const csvRows = pnlCsvRows(report)
  const csvCols: CsvColumn<(typeof csvRows)[number]>[] = [
    { key: 'label', label: 'Line' },
    { key: 'amount', label: 'Amount' },
    { key: 'detail', label: 'Detail' },
  ]

  const maxCategory = Math.max(...report.expenses.byCategory.map((c) => c.amount), 0)

  // The snapshot cannot contain everything in the window if it was rebuilt on a
  // venue-calendar day before the window ends. Compared as calendar dates in the
  // venue's zone, which is the same basis mv_daily_revenue buckets `day` on —
  // comparing a raw instant against a 'YYYY-MM-DD' would drift by the offset.
  const revenueStale =
    report.revenueRefreshedAt === null ||
    todayInZone(tz, report.revenueRefreshedAt) < range.end

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Profit &amp; Loss</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            What {ctx.tenant.name} earned and spent over the selected period.
          </p>
        </div>
        <ExportCsvButton
          rows={csvRows}
          columns={csvCols}
          filename={`pnl-${range.start}-to-${range.end}.csv`}
        />
      </div>

      <DateRangeFilter basePath="/reports/pnl" from={range.start} to={range.end} today={today} />

      {/* ── the statement ───────────────────────────────────────────────── */}
      <section className="mt-6 overflow-hidden rounded-xl border border-border bg-card">
        <Line
          label="Revenue"
          hint={`${report.revenue.invoiceCount} invoice${report.revenue.invoiceCount === 1 ? '' : 's'} issued or paid`}
          value={money(report.revenue.net)}
        />
        <Line
          label="Expenses"
          hint={`${report.expenses.count} expense${report.expenses.count === 1 ? '' : 's'} recorded`}
          value={`− ${money(report.expenses.total)}`}
          negative
        />
        <Line
          label="Payroll"
          hint={
            report.payroll.payslipCount === 0
              ? 'No payslips in this period'
              : `${report.payroll.payslipCount} payslip${report.payroll.payslipCount === 1 ? '' : 's'} · ${formatPeriods(report.payroll.periods)}`
          }
          value={`− ${money(report.payroll.total)}`}
          negative
        />

        <div
          className={cn(
            'flex flex-wrap items-center justify-between gap-3 border-t-2 border-border px-4 py-4',
            profitable ? 'bg-emerald-500/5' : 'bg-destructive/5',
          )}
        >
          <span className="flex items-center gap-2 text-sm font-semibold">
            {profitable ? (
              <TrendingUp size={18} className="text-emerald-600" aria-hidden />
            ) : (
              <TrendingDown size={18} className="text-destructive" aria-hidden />
            )}
            Net {profitable ? 'profit' : 'loss'}
          </span>
          <span
            className={cn(
              'text-2xl font-semibold tabular-nums',
              profitable ? 'text-emerald-600' : 'text-destructive',
            )}
          >
            {money(report.netProfit)}
          </span>
        </div>
      </section>

      {/* The payroll line is month-grained; saying so is the difference between
          a figure a manager can trust and one they later find surprising. */}
      {report.payroll.isApproximate && report.payroll.total > 0 && (
        <p className="mt-3 flex gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-400">
          <Info size={16} className="mt-0.5 shrink-0" aria-hidden />
          <span>
            Payslips are issued per calendar month, so the payroll line covers all of{' '}
            {formatPeriods(report.payroll.periods)} — wider than the dates you picked. For a
            like-for-like figure, choose a range of whole months.
          </span>
        </p>
      )}

      {/* The revenue half of the profit is a snapshot while the two lines it is
          reduced by are live, so a stale snapshot shows up as profit that is
          too LOW. Warned about only when the snapshot actually predates the end
          of the chosen range — that is when it can be missing whole days of
          income, rather than just the last few minutes of today. */}
      {revenueStale && (
        <p className="mt-3 flex gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-400">
          <Info size={16} className="mt-0.5 shrink-0" aria-hidden />
          <span>
            {report.revenueRefreshedAt
              ? `Revenue was last brought up to date on ${prettyDate(todayInZone(tz, report.revenueRefreshedAt), tz)}, before the end of this range.`
              : 'Revenue has never been brought up to date on this database.'}{' '}
            Expenses and payroll are current, so any invoice raised since then is missing from
            revenue and the net profit above is understated. Run{' '}
            <code className="rounded bg-muted px-1 py-0.5">npm run reports:refresh</code> for a
            true figure.
          </span>
        </p>
      )}

      {/* ── expense breakdown ───────────────────────────────────────────── */}
      <section className="mt-6 rounded-xl border border-border bg-card">
        <h2 className="flex items-center justify-between border-b border-border px-4 py-3 text-sm font-semibold">
          Expenses by category
          {report.expenses.byCategory.length > 0 && (
            <span className="text-xs font-normal text-muted-foreground">
              {money(report.expenses.total)} total
            </span>
          )}
        </h2>

        {report.expenses.byCategory.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">
            No expenses recorded between {range.start} and {range.end}.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {report.expenses.byCategory.map((c) => {
              const share = report.expenses.total > 0 ? (c.amount / report.expenses.total) * 100 : 0
              return (
                <li key={c.categoryId} className="px-4 py-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="text-sm font-medium">{c.categoryName}</span>
                    <span className="text-sm tabular-nums">
                      {money(c.amount)}{' '}
                      <span className="text-xs text-muted-foreground">
                        ({share.toFixed(1)}% · {c.expenseCount})
                      </span>
                    </span>
                  </div>
                  <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-primary"
                      style={{ width: `${maxCategory > 0 ? (c.amount / maxCategory) * 100 : 0}%` }}
                    />
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      {/* The revenue line comes from a pre-aggregated snapshot while expenses
          and payroll are read live, so a P&L can briefly mix fresh and stale
          figures. The revenue dashboard discloses the same thing; on a NET
          number it matters more, because the staleness lands in the profit. */}
      <p className="mt-4 text-xs text-muted-foreground">
        Revenue counts invoices that were issued or paid, at the amount billed, and comes from a
        pre-aggregated snapshot (refreshed by{' '}
        <code className="rounded bg-muted px-1 py-0.5">npm run reports:refresh</code>). Expenses and
        payroll are read live, so invoices raised since the last refresh are not yet in the net.
        Expenses are dated by when they were spent. All figures are for {ctx.tenant.name} only.
      </p>
    </div>
  )
}

function Line({
  label,
  hint,
  value,
  negative,
}: {
  label: string
  hint: string
  value: string
  negative?: boolean
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3.5">
      <div className="min-w-0">
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
      <span
        className={cn('text-lg tabular-nums', negative ? 'text-muted-foreground' : 'font-medium')}
      >
        {value}
      </span>
    </div>
  )
}

/** '2026-03', '2026-04' → 'Mar 2026 – Apr 2026' (or just the one month). */
function formatPeriods(periods: string[]): string {
  if (periods.length === 0) return '—'
  const first = formatPeriod(periods[0])
  if (periods.length === 1) return first
  return `${first} – ${formatPeriod(periods[periods.length - 1])}`
}

function formatPeriod(period: string): string {
  const [y, m] = period.split('-').map(Number)
  // UTC throughout — a calendar month has no timezone of its own, the same
  // reasoning lib/format.ts:formatPayrollPeriod uses.
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-US', {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  })
}
