import { redirect } from 'next/navigation'
import { CalendarDays, Repeat, TrendingUp, Users, type LucideIcon } from 'lucide-react'
import { getActiveContext } from '@/lib/tenant/context'
import { isManager } from '@/lib/auth/roles'
import { getEventReport } from '@/lib/reports/events'
import { resolveDateRange } from '@/lib/reports/date-range'
import { formatMoney, prettyDate } from '@/lib/format'
import { todayInZone } from '@/lib/booking/time'
import { DateRangeFilter } from '@/components/reports/DateRangeFilter'
import { ExportCsvButton, type CsvColumn } from '@/components/reports/ExportCsvButton'

/**
 * The Events report (M15 #8) — attendance and entry-fee revenue.
 *
 * The same shape as every other M6 report page: resolve context, gate on
 * manager, resolve the range with the shared helper, call one reader, render.
 * The CSV button is the shared client component, exporting exactly the rows on
 * screen so the file and the page cannot disagree.
 *
 * Authorization is enforced HERE and again inside getEventReport(), which
 * throws ReportAccessError for a non-manager. The nav entry is convenience,
 * never the guard.
 */

type Search = { from?: string; to?: string }

export default async function EventsReportPage({ searchParams }: { searchParams: Promise<Search> }) {
  const ctx = await getActiveContext()
  if (!ctx) return null
  if (!isManager(ctx.role)) redirect('/dashboard')

  const tz = ctx.tenant.timezone
  const currency = ctx.tenant.currency
  const sp = await searchParams
  const today = todayInZone(tz)
  const range = resolveDateRange({ start: sp.from, end: sp.to }, { timeZone: tz })

  const report = await getEventReport(ctx, range)
  const money = (n: number) => formatMoney(n, currency)
  const pct = (v: number | null) => (v === null ? '—' : `${v.toFixed(1)}%`)

  // The shared client exporter takes COLUMN KEYS, so the file is a projection
  // of exactly the rows rendered below — the CSV and the screen cannot drift.
  // `seriesId` is deliberately not a column: a manager needs to know an event
  // recurs (the badge says so), not the internal id of the series.
  const columns: CsvColumn<(typeof report.rows)[number]>[] = [
    { key: 'date', label: 'Date' },
    { key: 'title', label: 'Event' },
    { key: 'type', label: 'Type' },
    { key: 'status', label: 'Status' },
    { key: 'registered', label: 'Registered' },
    { key: 'checkedIn', label: 'Checked in' },
    { key: 'attendanceRate', label: 'Attendance %' },
    { key: 'revenue', label: `Revenue (${currency})` },
    { key: 'refundDue', label: `Refund due (${currency})` },
  ]

  const tiles: { icon: LucideIcon; label: string; value: string; hint?: string }[] = [
    { icon: CalendarDays, label: 'Events', value: String(report.totals.events) },
    {
      icon: Users,
      label: 'Registered',
      value: String(report.totals.registered),
      hint: `${report.totals.checkedIn} checked in`,
    },
    {
      icon: TrendingUp,
      label: 'Attendance',
      value: pct(report.totals.attendanceRate),
      hint: report.totals.registered === 0 ? 'no registrations yet' : undefined,
    },
    {
      icon: TrendingUp,
      label: 'Entry-fee revenue',
      value: money(report.totals.revenue),
      hint: report.totals.refundDue > 0 ? `${money(report.totals.refundDue)} refund due` : undefined,
    },
  ]

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
      <h1 className="text-2xl font-semibold">Events</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Attendance and entry-fee revenue per event. Revenue counts only entries the payment
        gateway confirmed.
      </p>

      <div className="mt-4">
        <DateRangeFilter basePath="/reports/events" from={range.start} to={range.end} today={today} />
      </div>

      <dl className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {tiles.map((t) => (
          <div key={t.label} className="rounded-xl border border-border bg-card p-4 shadow-sm">
            <dt className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <t.icon size={14} aria-hidden /> {t.label}
            </dt>
            <dd className="mt-1 text-2xl font-semibold tabular-nums">{t.value}</dd>
            {t.hint && <dd className="text-xs text-muted-foreground">{t.hint}</dd>}
          </div>
        ))}
      </dl>

      {report.mostPopular.length > 0 && (
        <section className="mt-6 rounded-xl border border-border bg-card p-4 shadow-sm">
          <h2 className="text-sm font-semibold">Most popular</h2>
          <ul className="mt-2 space-y-1 text-sm">
            {report.mostPopular.map((r) => (
              <li key={r.eventId} className="flex flex-wrap justify-between gap-2">
                <span className="min-w-0 truncate">{r.title}</span>
                <span className="shrink-0 text-muted-foreground tabular-nums">
                  {r.registered} registered · {r.checkedIn} attended
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="mt-6 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">All events</h2>
        <ExportCsvButton
          rows={report.rows}
          columns={columns}
          filename={`events-${range.start}-to-${range.end}.csv`}
        />
      </div>

      <div className="mt-2 overflow-x-auto rounded-xl border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">Date</th>
              <th className="px-3 py-2 font-medium">Event</th>
              <th className="px-3 py-2 text-right font-medium">Registered</th>
              <th className="px-3 py-2 text-right font-medium">Checked in</th>
              <th className="px-3 py-2 text-right font-medium">Attendance</th>
              <th className="px-3 py-2 text-right font-medium">Revenue</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {report.rows.map((r) => (
              <tr key={r.eventId}>
                <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                  {prettyDate(r.date)}
                </td>
                <td className="px-3 py-2">
                  <span className="font-medium">{r.title}</span>
                  {/* M15 #8 — a generated occurrence is an ordinary event, but a
                      manager reading a report should still be able to tell one
                      from a one-off. */}
                  {r.seriesId && (
                    <span
                      className="ml-2 inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground"
                      title="Generated from a recurring series"
                    >
                      <Repeat size={10} aria-hidden /> recurring
                    </span>
                  )}
                  <span className="ml-2 text-xs text-muted-foreground">{r.type}</span>
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{r.registered}</td>
                <td className="px-3 py-2 text-right tabular-nums">{r.checkedIn}</td>
                <td className="px-3 py-2 text-right tabular-nums">{pct(r.attendanceRate)}</td>
                <td className="px-3 py-2 text-right font-medium tabular-nums">
                  {money(r.revenue)}
                  {r.refundDue > 0 && (
                    <span className="block text-xs font-normal text-amber-700">
                      {money(r.refundDue)} refund due
                    </span>
                  )}
                </td>
              </tr>
            ))}
            {report.rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-center text-muted-foreground">
                  No events in this range.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
