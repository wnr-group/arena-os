import { redirect } from 'next/navigation'
import { getActiveContext } from '@/lib/tenant/context'
import { hasEntitlement } from '@/lib/platform/entitlement-guard'
import { isManager } from '@/lib/auth/roles'
import { getTipsReport } from '@/lib/reports/tips'
import { resolveDateRange } from '@/lib/reports/date-range'
import { formatMoney } from '@/lib/format'
import { todayInZone } from '@/lib/booking/time'
import { DateRangeFilter } from '@/components/reports/DateRangeFilter'
import { ExportCsvButton, type CsvColumn } from '@/components/reports/ExportCsvButton'

type Search = { from?: string; to?: string }

/** Tips by server and by day (M20). Owner/manager; enforced here and in getTipsReport(). */
export default async function TipsReportPage({ searchParams }: { searchParams: Promise<Search> }) {
  const ctx = await getActiveContext()
  if (!ctx) return null
  if (!isManager(ctx.role) || ctx.tenant.industry !== 'restaurant') redirect('/dashboard')
  if (!(await hasEntitlement(ctx, 'module.tips'))) redirect('/dashboard')

  const tz = ctx.tenant.timezone
  const sp = await searchParams
  const today = todayInZone(tz)
  const range = resolveDateRange({ start: sp.from, end: sp.to }, { timeZone: tz })
  const r = await getTipsReport(ctx, { range })
  const money = (n: number) => formatMoney(n, ctx.tenant.currency)
  const file = (n: string) => `${n}-${range.start}_${range.end}.csv`
  const maxServer = Math.max(...r.byServer.map((s) => s.tips), 0)

  const serverCols: CsvColumn<(typeof r.byServer)[number]>[] = [
    { key: 'serverName', label: 'Server' },
    { key: 'tips', label: 'Tips' },
    { key: 'payments', label: 'Payments with a tip' },
  ]
  const dayCols: CsvColumn<(typeof r.byDay)[number]>[] = [
    { key: 'date', label: 'Date' },
    { key: 'tips', label: 'Tips' },
    { key: 'unattributed', label: 'Unattributed' },
    { key: 'payments', label: 'Payments with a tip' },
  ]

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
      <h1 className="text-2xl font-semibold">Tips</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Tips left at {ctx.tenant.name}, by server and by day. Tips are not revenue; they go to your team. Pay-out rules and monthly
        payouts are under Settings → Tips.
      </p>

      <DateRangeFilter basePath="/reports/tips" from={range.start} to={range.end} today={today} />

      <div className="mt-6 grid gap-4 sm:grid-cols-3">
        <Stat label="Total tips" value={money(r.total)} hint={`${r.payments} payments with a tip`} />
        <Stat label="Unattributed" value={money(r.unattributed)} hint="No server on the table and no recipient named" />
        <Stat label="Servers tipped" value={String(r.byServer.filter((s) => s.serverId).length)} hint="With at least one tip" />
      </div>

      <Section title="By server" action={r.byServer.length > 0 ? <ExportCsvButton rows={r.byServer} columns={serverCols} filename={file('tips-by-server')} /> : undefined}>
        {r.byServer.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">No tips were collected between {range.start} and {range.end}.</p>
        ) : (
          <table className="w-full min-w-[480px] text-left text-base">
            <thead>
              <tr className="border-b border-border text-sm uppercase tracking-wider text-muted-foreground">
                <th className="px-4 py-3 font-semibold">Server</th>
                <th className="px-4 py-3 text-right font-semibold">Tips</th>
                <th className="px-4 py-3 text-right font-semibold">Payments</th>
                <th className="w-40 px-4 py-3 font-semibold">Share</th>
              </tr>
            </thead>
            <tbody>
              {r.byServer.map((s) => (
                <tr key={s.serverId ?? 'none'} className="border-b border-border last:border-0">
                  <td className={`px-4 py-3 ${s.serverId ? '' : 'text-muted-foreground'}`}>{s.serverName}</td>
                  <td className="px-4 py-3 text-right font-medium tabular-nums">{money(s.tips)}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">{s.payments}</td>
                  <td className="px-4 py-3">
                    <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                      <div className="h-full rounded-full bg-primary" style={{ width: `${maxServer > 0 ? Math.max((s.tips / maxServer) * 100, 2) : 0}%` }} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="border-t border-border px-4 py-2 text-xs text-muted-foreground">
          A tip is credited to the person named at checkout, otherwise to the server on the table (Settings → Floor sections). Refunded
          payments and voided bills are excluded.
        </p>
      </Section>

      <Section title="By day" action={r.byDay.length > 0 ? <ExportCsvButton rows={r.byDay} columns={dayCols} filename={file('tips-by-day')} /> : undefined}>
        {r.byDay.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">No tips in this range.</p>
        ) : (
          <table className="w-full min-w-[480px] text-left text-base">
            <thead>
              <tr className="border-b border-border text-sm uppercase tracking-wider text-muted-foreground">
                <th className="px-4 py-3 font-semibold">Date</th>
                <th className="px-4 py-3 text-right font-semibold">Tips</th>
                <th className="px-4 py-3 text-right font-semibold">Unattributed</th>
                <th className="px-4 py-3 text-right font-semibold">Payments</th>
              </tr>
            </thead>
            <tbody>
              {r.byDay.map((d) => (
                <tr key={d.date} className="border-b border-border last:border-0">
                  <td className="px-4 py-3 tabular-nums">{d.date}</td>
                  <td className="px-4 py-3 text-right font-medium tabular-nums">{money(d.tips)}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">{d.unattributed > 0 ? money(d.unattributed) : '—'}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">{d.payments}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
    </div>
  )
}

function Stat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-4 shadow-sm">
      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="mt-2 text-2xl font-semibold tabular-nums">{value}</p>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{hint}</p>
    </div>
  )
}

function Section({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="mt-6 overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">{title}</h2>
        {action}
      </div>
      <div className="overflow-x-auto">{children}</div>
    </section>
  )
}
