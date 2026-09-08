import { redirect } from 'next/navigation'
import { CalendarDays, Clock, IndianRupee, Percent } from 'lucide-react'
import { getActiveContext } from '@/lib/tenant/context'
import { isManager } from '@/lib/auth/roles'
import { getRevenueDashboard } from '@/lib/reports/revenue'
import { resolveDateRange } from '@/lib/reports/date-range'
import { formatMoney } from '@/lib/format'
import { todayInZone } from '@/lib/booking/time'
import { DateRangeFilter } from '@/components/reports/DateRangeFilter'
import { ExportCsvButton, type CsvColumn } from '@/components/reports/ExportCsvButton'
import { Pager, pageInfo } from '@/components/reports/Pager'

type Search = { from?: string; to?: string; page?: string }

const DAILY_PAGE_SIZE = 10

/**
 * Revenue & Bookings dashboard (AROS-65).
 *
 * Server component: it resolves the context, enforces authorization and loads
 * the report; the only client pieces are the date filter (URL-driven, already
 * shared with the other reports) and the CSV button. There is no chart library
 * — the bars below are divs, which keeps the bundle and the theme consistent
 * with the rest of the app.
 *
 * Authorization is enforced in THREE places, none of which is the sidebar:
 * here, in getRevenueDashboard()'s two readers, and in the export action. The
 * nav entry is convenience only — a cashier typing /reports lands on the
 * redirect below, and calling the reader directly throws ReportAccessError.
 */
export default async function RevenueReportPage({ searchParams }: { searchParams: Promise<Search> }) {
  const ctx = await getActiveContext()
  if (!ctx) return null // the layout already guards a missing session
  if (!isManager(ctx.role)) redirect('/dashboard')

  const tz = ctx.tenant.timezone
  const currency = ctx.tenant.currency
  const sp = await searchParams
  const today = todayInZone(tz)
  // Shared AROS-64 parser: inclusive [start, end], tenant-local "today",
  // junk ignored, reversed ranges clamped. No second date parser in this file.
  const range = resolveDateRange({ start: sp.from, end: sp.to }, { timeZone: tz })

  const data = await getRevenueDashboard(ctx, { range })
  const { revenueTotals, bookings } = data
  const totals = bookings.totals

  const money = (n: number) => formatMoney(n, currency)
  const hasActivity = revenueTotals.invoiceCount > 0 || totals.bookings > 0
  const maxNet = Math.max(...data.days.map((d) => d.net), 0)
  const maxPeak = Math.max(...bookings.peakHours.map((h) => h.bookings), 0)
  const maxResource = Math.max(...bookings.topResources.map((r) => r.minutes), 0)

  // Table only — the CSV export below still gets every day in range, and the
  // summary cards/footer totals are computed over the full range, not the page.
  const dailyPage = pageInfo(sp.page, data.days.length, DAILY_PAGE_SIZE)
  const pagedDays = data.days.slice((dailyPage.page - 1) * DAILY_PAGE_SIZE, dailyPage.page * DAILY_PAGE_SIZE)
  const dailyHref = (page: number) => `/reports?from=${range.start}&to=${range.end}&page=${page}`

  // CSV columns for the client-side export button (shared ExportCsvButton).
  // Exports data.days — the FULL date range, not just the current page of
  // pagedDays — so "Export CSV" can hand back far more rows than are
  // visible on screen. Nothing re-fetched either way.
  const dailyCols: CsvColumn<(typeof data.days)[number]>[] = [
    { key: 'day', label: 'Date' },
    { key: 'gross', label: 'Gross' },
    { key: 'discount', label: 'Discount' },
    { key: 'tax', label: 'Tax' },
    { key: 'net', label: 'Net' },
    { key: 'bookings', label: 'Bookings' },
    { key: 'occupancyPercent', label: 'Occupancy %' },
  ]
  const resourceCols: CsvColumn<(typeof bookings.topResources)[number]>[] = [
    { key: 'resourceName', label: 'Resource' },
    { key: 'resourceTypeName', label: 'Type' },
    { key: 'minutes', label: 'Minutes' },
  ]

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Revenue &amp; Bookings</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            What {ctx.tenant.name} took, how busy it was, and which resources earned it.
          </p>
        </div>
        <ExportCsvButton
          rows={data.days}
          columns={dailyCols}
          filename={`revenue-${range.start}_${range.end}.csv`}
        />
      </div>

      <DateRangeFilter basePath="/reports" from={range.start} to={range.end} today={today} />

      {/* ── summary ── */}
      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          icon={<IndianRupee size={18} />}
          label="Net revenue"
          value={money(revenueTotals.net)}
          hint={`${money(revenueTotals.gross)} gross · ${money(revenueTotals.discount)} discount · ${money(revenueTotals.tax)} tax`}
        />
        <StatCard
          icon={<CalendarDays size={18} />}
          label="Bookings"
          value={String(totals.bookings)}
          hint={`${revenueTotals.invoiceCount} invoice${revenueTotals.invoiceCount === 1 ? '' : 's'} raised`}
        />
        <StatCard
          icon={<Percent size={18} />}
          label="Occupancy"
          value={totals.occupancyPercent === null ? '—' : `${totals.occupancyPercent}%`}
          hint={
            totals.occupancyPercent === null
              ? 'No open hours or bookable resources in this period'
              : `${Math.round(totals.bookedMinutes / 60)}h booked of ${Math.round(totals.availableMinutes / 60)}h available`
          }
        />
        <StatCard
          icon={<Clock size={18} />}
          label="Peak hour"
          value={totals.peakHour === null ? '—' : formatHour(totals.peakHour)}
          hint={
            totals.mostUsedResource
              ? `Most used: ${totals.mostUsedResource.resourceName}`
              : 'No bookings in this period'
          }
        />
      </div>

      {!hasActivity && (
        <p className="mt-6 rounded-2xl border border-border bg-card p-8 text-center text-sm text-muted-foreground shadow-sm">
          No invoices or bookings between {range.start} and {range.end}. Pick a wider date range, or raise a bill from
          the POS to see it here.
        </p>
      )}

      {/* ── daily table ── */}
      <Section title="Daily breakdown">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-base">
            <thead>
              <tr className="border-b border-border text-sm uppercase tracking-wider text-muted-foreground">
                <th className="px-4 py-3 font-semibold">Date</th>
                <th className="px-4 py-3 text-right font-semibold">Gross</th>
                <th className="px-4 py-3 text-right font-semibold">Discount</th>
                <th className="px-4 py-3 text-right font-semibold">Tax</th>
                <th className="px-4 py-3 text-right font-semibold">Net</th>
                <th className="px-4 py-3 text-right font-semibold">Bookings</th>
                <th className="px-4 py-3 text-right font-semibold">Occupancy</th>
                <th className="px-4 py-3 font-semibold">Net revenue</th>
              </tr>
            </thead>
            <tbody>
              {pagedDays.map((d) => (
                <tr key={d.day} className="border-b border-border last:border-0">
                  <td className="whitespace-nowrap px-4 py-3 tabular-nums">{d.day}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{money(d.gross)}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">{money(d.discount)}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">{money(d.tax)}</td>
                  <td className="px-4 py-3 text-right font-medium tabular-nums">{money(d.net)}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{d.bookings}</td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {d.occupancyPercent === null ? (
                      <span className="text-muted-foreground" title="Closed, or no bookable resource">
                        —
                      </span>
                    ) : (
                      `${d.occupancyPercent}%`
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <Bar value={d.net} max={maxNet} />
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-border font-semibold">
                <td className="px-4 py-3">Total</td>
                <td className="px-4 py-3 text-right tabular-nums">{money(revenueTotals.gross)}</td>
                <td className="px-4 py-3 text-right tabular-nums">{money(revenueTotals.discount)}</td>
                <td className="px-4 py-3 text-right tabular-nums">{money(revenueTotals.tax)}</td>
                <td className="px-4 py-3 text-right tabular-nums">{money(revenueTotals.net)}</td>
                <td className="px-4 py-3 text-right tabular-nums">{totals.bookings}</td>
                <td className="px-4 py-3 text-right tabular-nums">
                  {totals.occupancyPercent === null ? '—' : `${totals.occupancyPercent}%`}
                </td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
        {/* Said plainly, because the two halves of this table have different
            freshness: revenue is read from the AROS-64 pre-aggregate, which is
            rebuilt out of band, while the booking figures are queried live. A
            bill raised minutes ago can therefore be missing from Net but its
            booking already counted. */}
        <p className="border-t border-border px-4 py-2 text-xs text-muted-foreground">
          Revenue comes from a pre-aggregated snapshot (refreshed by{' '}
          <code className="rounded bg-muted px-1 py-0.5">npm run reports:refresh</code>); booking, occupancy and
          resource figures are live.
        </p>
        <Pager info={dailyPage} label="Daily breakdown" hrefFor={dailyHref} />
      </Section>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* ── peak hours ── */}
        <Section title="Peak hours">
          {bookings.peakHours.length === 0 ? (
            <Empty>No bookings in this period.</Empty>
          ) : (
            <ul className="space-y-2 p-4">
              {bookings.peakHours.map((h) => (
                <li key={h.hour} className="flex items-center gap-3 text-sm">
                  <span className="w-20 shrink-0 tabular-nums text-muted-foreground">{formatHour(h.hour)}</span>
                  <Bar value={h.bookings} max={maxPeak} />
                  <span className="w-8 shrink-0 text-right tabular-nums">{h.bookings}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="border-t border-border px-4 py-2 text-xs text-muted-foreground">
            Bookings by the hour their slot starts, in the branch&apos;s local time.
          </p>
        </Section>

        {/* ── resource usage ── */}
        <Section
          title="Most-used resources"
          action={
            <ExportCsvButton
              rows={bookings.topResources}
              columns={resourceCols}
              filename={`resource-usage-${range.start}_${range.end}.csv`}
            />
          }
        >
          {bookings.topResources.length === 0 ? (
            <Empty>No resource was booked in this period.</Empty>
          ) : (
            <ul className="space-y-2 p-4">
              {bookings.topResources.map((r) => (
                <li key={r.resourceId} className="flex items-center gap-3 text-sm">
                  <span className="w-32 shrink-0 truncate" title={`${r.resourceName} · ${r.resourceTypeName}`}>
                    {r.resourceName}
                  </span>
                  <Bar value={r.minutes} max={maxResource} />
                  <span className="w-20 shrink-0 text-right tabular-nums text-muted-foreground">
                    {formatHours(r.minutes)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="border-t border-border px-4 py-2 text-xs text-muted-foreground">
            Ranked by booked time, not booking count — resources are hired by the hour.
          </p>
        </Section>
      </div>
    </div>
  )
}

function StatCard({
  icon,
  label,
  value,
  hint,
}: {
  icon: React.ReactNode
  label: string
  value: string
  hint: string
}) {
  return (
    <div className="rounded-2xl border border-border bg-card p-4 shadow-sm">
      <div className="flex items-center gap-2 text-muted-foreground">
        <span className="inline-flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
          {icon}
        </span>
        <span className="text-xs font-semibold uppercase tracking-wider">{label}</span>
      </div>
      <p className="mt-3 text-2xl font-semibold tabular-nums">{value}</p>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{hint}</p>
    </div>
  )
}

function Section({
  title,
  action,
  children,
}: {
  title: string
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="mt-6 overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  )
}

function Bar({ value, max }: { value: number; max: number }) {
  // max === 0 → every bar is empty rather than a division by zero.
  const pct = max > 0 ? Math.max((value / max) * 100, value > 0 ? 2 : 0) : 0
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
      <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${pct}%` }} />
    </div>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-4 py-8 text-center text-sm text-muted-foreground">{children}</p>
}

/** 14 → "2 PM", matching how staff read a shift board. */
function formatHour(hour: number): string {
  const suffix = hour < 12 ? 'AM' : 'PM'
  const h = hour % 12 === 0 ? 12 : hour % 12
  return `${h} ${suffix}`
}

function formatHours(minutes: number): string {
  if (minutes < 60) return `${Math.round(minutes)}m`
  return `${(minutes / 60).toFixed(1)}h`
}
