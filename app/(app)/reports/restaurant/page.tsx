import { redirect } from 'next/navigation'
import { Armchair, Ban, Clock3, UserRound, UtensilsCrossed } from 'lucide-react'
import { getActiveContext } from '@/lib/tenant/context'
import { hasEntitlement } from '@/lib/platform/entitlement-guard'
import { isManager } from '@/lib/auth/roles'
import { getRestaurantReport } from '@/lib/reports/restaurant'
import { resolveDateRange } from '@/lib/reports/date-range'
import { formatMoney } from '@/lib/format'
import { todayInZone } from '@/lib/booking/time'
import { DateRangeFilter } from '@/components/reports/DateRangeFilter'
import { ExportCsvButton, type CsvColumn } from '@/components/reports/ExportCsvButton'

type Search = { from?: string; to?: string }

/**
 * Restaurant reports (M20 / AROS-179) — the sibling of /reports/sales: a server
 * component that resolves context, enforces authorization and loads the report,
 * with the shared date filter and CSV button as the only client pieces.
 * Authorization is enforced here AND in getRestaurantReport(); the nav entry is
 * convenience, not a guard.
 */
export default async function RestaurantReportPage({ searchParams }: { searchParams: Promise<Search> }) {
  const ctx = await getActiveContext()
  if (!ctx) return null
  if (!isManager(ctx.role) || ctx.tenant.industry !== 'restaurant') redirect('/dashboard')
  // Presentation only — the reader calls requireEntitlement() itself and throws.
  if (!(await hasEntitlement(ctx, 'module.reports'))) redirect('/dashboard')

  const tz = ctx.tenant.timezone
  const sp = await searchParams
  const today = todayInZone(tz)
  const range = resolveDateRange({ start: sp.from, end: sp.to }, { timeZone: tz })
  const r = await getRestaurantReport(ctx, { range })
  const money = (n: number | null) => (n === null ? '—' : formatMoney(n, ctx.tenant.currency))
  const mins = (n: number | null) => (n === null ? '—' : `${Math.round(n)} min`)
  const hourLabel = (h: number) => `${String(h).padStart(2, '0')}:00`
  const file = (name: string) => `${name}-${range.start}_${range.end}.csv`

  const maxDaypart = Math.max(...r.daypart.map((d) => d.billed), 0)
  const maxMix = Math.max(...r.menuMix.map((m) => m.grossRevenue), 0)

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
      <h1 className="text-2xl font-semibold">Restaurant reports</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        How {ctx.tenant.name} runs: table turnover, spend per guest, busy hours, what sells, what is voided, and each server.
      </p>

      <DateRangeFilter basePath="/reports/restaurant" from={range.start} to={range.end} today={today} />

      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Table sessions" value={String(r.summary.sessions)} hint={`${r.summary.covers} guests billed`} />
        <StatCard label="Billed sales" value={money(r.summary.billed)} hint="Invoices incl. GST, excl. tips" />
        <StatCard label="Spend per guest" value={money(r.summary.spendPerCover)} hint="Billed sales ÷ guests" />
        <StatCard
          label="Avg. table time"
          value={mins(r.summary.avgSessionMinutes)}
          hint={r.summary.turnsPerTablePerDay === null ? 'Seated → closed' : `${r.summary.turnsPerTablePerDay} turns / table / day`}
        />
      </div>

      {/* ── turnover ── */}
      <Section
        icon={<Clock3 size={15} />}
        title="Table turnover"
        action={r.turnover.length > 0 ? <ExportCsvButton rows={r.turnover} columns={turnoverCols} filename={file('table-turnover')} /> : undefined}
      >
        {r.turnover.length === 0 ? (
          <Empty>No table sessions between {range.start} and {range.end}.</Empty>
        ) : (
          <Table head={['Table', 'Sessions', 'Finished', 'Avg. time', 'Turns / day']} right={[1, 2, 3, 4]}>
            {r.turnover.map((t) => (
              <tr key={t.tableName} className="border-b border-border last:border-0">
                <td className="px-4 py-3">{t.tableName}</td>
                <td className="px-4 py-3 text-right tabular-nums">{t.sessions}</td>
                <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">{t.finished}</td>
                <td className="px-4 py-3 text-right tabular-nums">{mins(t.avgMinutes)}</td>
                <td className="px-4 py-3 text-right tabular-nums">{t.turnsPerDay ?? '—'}</td>
              </tr>
            ))}
          </Table>
        )}
        <Note>Time is seated → closed, for finished sessions only. Turns per day = finished sessions ÷ days in range.</Note>
      </Section>

      {/* ── daypart ── */}
      <Section
        icon={<Armchair size={15} />}
        title="Sales by time of day"
        action={r.daypart.some((d) => d.sessions > 0) ? <ExportCsvButton rows={r.daypart} columns={daypartCols} filename={file('daypart')} /> : undefined}
      >
        {r.summary.sessions === 0 ? (
          <Empty>No table sessions in this range.</Empty>
        ) : (
          <>
            <Table head={['Daypart', 'Sessions', 'Guests', 'Billed sales', 'Per guest', 'Share']} right={[1, 2, 3, 4]}>
              {r.daypart.map((d) => (
                <tr key={d.key} className="border-b border-border last:border-0">
                  <td className="px-4 py-3">{d.label}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{d.sessions}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">{d.covers}</td>
                  <td className="px-4 py-3 text-right font-medium tabular-nums">{money(d.billed)}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{money(d.spendPerCover)}</td>
                  <td className="w-40 px-4 py-3"><Bar value={d.billed} max={maxDaypart} /></td>
                </tr>
              ))}
            </Table>
            <div className="flex flex-wrap gap-x-5 gap-y-1 border-t border-border px-4 py-3 text-xs text-muted-foreground">
              {r.hourly.map((h) => (
                <span key={h.hour} className="tabular-nums">
                  {hourLabel(h.hour)}: <strong className="text-foreground">{h.sessions}</strong>
                </span>
              ))}
            </div>
          </>
        )}
        <Note>
          Dated by when the party was seated, in {tz}. Breakfast 5–11, lunch 11–15, snacks 15–19, dinner 19–23, late night 23–5. The
          row beneath is sessions seated per hour.
        </Note>
      </Section>

      {/* ── menu mix ── */}
      <Section
        icon={<UtensilsCrossed size={15} />}
        title="Menu mix"
        action={r.menuMix.length > 0 ? <ExportCsvButton rows={r.menuMix} columns={mixCols} filename={file('menu-mix')} /> : undefined}
      >
        {r.menuMix.length === 0 ? (
          <Empty>No food was billed in this range.</Empty>
        ) : (
          <Table head={['Item', 'Qty sold', 'Paid revenue', 'Times 86’d', 'Share']} right={[1, 2, 3]}>
            {r.menuMix.map((m) => (
              <tr key={m.itemName} className="border-b border-border last:border-0">
                <td className="px-4 py-3">{m.itemName}</td>
                <td className="px-4 py-3 text-right tabular-nums">{m.quantity}</td>
                <td className="px-4 py-3 text-right font-medium tabular-nums">{money(m.grossRevenue)}</td>
                <td className={`px-4 py-3 text-right tabular-nums ${m.eightySixed > 0 ? 'font-medium text-amber-600' : 'text-muted-foreground'}`}>
                  {m.eightySixed > 0 ? m.eightySixed : '—'}
                </td>
                <td className="w-40 px-4 py-3"><Bar value={m.grossRevenue} max={maxMix} /></td>
              </tr>
            ))}
          </Table>
        )}
        <Note>
          Same figures as Food &amp; Memberships. “Times 86’d” counts the times an item was marked out of stock — recorded from when this
          report was introduced.
        </Note>
      </Section>

      {/* ── void / comp ── */}
      <Section
        icon={<Ban size={15} />}
        title="Voids & comps"
        action={r.voidComp.entries.length > 0 ? <ExportCsvButton rows={r.voidComp.entries} columns={voidCols} filename={file('voids-comps')} /> : undefined}
      >
        <div className="grid gap-4 p-4 sm:grid-cols-3">
          <StatCard label="Voided" value={money(r.voidComp.voidAmount)} hint={`${r.voidComp.voids} items removed`} />
          <StatCard label="Comped" value={money(r.voidComp.compAmount)} hint={`${r.voidComp.comps} items given free`} />
          <StatCard
            label="Share of sales"
            value={r.voidComp.pctOfBilled === null ? '—' : `${r.voidComp.pctOfBilled}%`}
            hint="Voids + comps ÷ billed sales"
          />
        </div>
        {r.voidComp.entries.length === 0 ? (
          <Empty>Nothing was voided or comped in this range.</Empty>
        ) : (
          <>
            <Table head={['Staff', 'Voids', 'Void value', 'Comps', 'Comp value']} right={[1, 2, 3, 4]}>
              {r.voidComp.byStaff.map((s) => (
                <tr key={s.staff} className="border-b border-border last:border-0">
                  <td className="px-4 py-3">{s.staff}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{s.voids}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{money(s.voidAmount)}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{s.comps}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{money(s.compAmount)}</td>
                </tr>
              ))}
            </Table>
            <Table head={['When', 'Type', 'Item', 'Value', 'By', 'Reason']} right={[3]}>
              {r.voidComp.entries.slice(0, 100).map((e) => (
                <tr key={e.id} className="border-b border-border last:border-0">
                  <td className="whitespace-nowrap px-4 py-2 text-sm text-muted-foreground">
                    {new Intl.DateTimeFormat('en-IN', { timeZone: tz, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(e.at))}
                  </td>
                  <td className="px-4 py-2 text-sm capitalize">{e.kind}</td>
                  <td className="px-4 py-2 text-sm">{e.qty > 1 ? `${e.qty}× ` : ''}{e.itemName}</td>
                  <td className="px-4 py-2 text-right text-sm tabular-nums">{money(e.amount)}</td>
                  <td className="px-4 py-2 text-sm">{e.staff}</td>
                  <td className="px-4 py-2 text-sm text-muted-foreground">{e.reason || '—'}</td>
                </tr>
              ))}
            </Table>
            {r.voidComp.entries.length > 100 && <Note>Showing the latest 100 of {r.voidComp.entries.length}; the CSV has them all.</Note>}
          </>
        )}
        <Note>From the audit trail. “By” is whoever approved or applied it — a waiter’s request that a manager approves is recorded under the manager.</Note>
      </Section>

      {/* ── servers ── */}
      <Section
        icon={<UserRound size={15} />}
        title="Server performance"
        action={r.servers.length > 0 ? <ExportCsvButton rows={r.servers} columns={serverCols} filename={file('server-performance')} /> : undefined}
      >
        {r.servers.length === 0 ? (
          <Empty>No table sessions in this range.</Empty>
        ) : (
          <Table head={['Server', 'Sessions', 'Guests', 'Billed sales', 'Per guest', 'Tips', 'Tip %']} right={[1, 2, 3, 4, 5, 6]}>
            {r.servers.map((s) => (
              <tr key={s.serverId ?? 'none'} className="border-b border-border last:border-0">
                <td className="px-4 py-3">{s.serverName}</td>
                <td className="px-4 py-3 text-right tabular-nums">{s.sessions}</td>
                <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">{s.covers}</td>
                <td className="px-4 py-3 text-right font-medium tabular-nums">{money(s.billed)}</td>
                <td className="px-4 py-3 text-right tabular-nums">{money(s.spendPerCover)}</td>
                <td className="px-4 py-3 text-right tabular-nums">{money(s.tips)}</td>
                <td className="px-4 py-3 text-right tabular-nums">{s.tipPct === null ? '—' : `${s.tipPct}%`}</td>
              </tr>
            ))}
          </Table>
        )}
        <Note>
          By the server on each session (Settings → Floor sections). Sessions with nobody assigned are under “Unassigned”. Tips are
          shown beside sales and are not part of them.
        </Note>
      </Section>
    </div>
  )
}

const turnoverCols: CsvColumn<Awaited<ReturnType<typeof getRestaurantReport>>['turnover'][number]>[] = [
  { key: 'tableName', label: 'Table' },
  { key: 'sessions', label: 'Sessions' },
  { key: 'finished', label: 'Finished sessions' },
  { key: 'avgMinutes', label: 'Avg minutes' },
  { key: 'turnsPerDay', label: 'Turns per day' },
]
const daypartCols: CsvColumn<Awaited<ReturnType<typeof getRestaurantReport>>['daypart'][number]>[] = [
  { key: 'label', label: 'Daypart' },
  { key: 'sessions', label: 'Sessions' },
  { key: 'covers', label: 'Guests' },
  { key: 'billed', label: 'Billed sales' },
  { key: 'spendPerCover', label: 'Spend per guest' },
]
const mixCols: CsvColumn<Awaited<ReturnType<typeof getRestaurantReport>>['menuMix'][number]>[] = [
  { key: 'itemName', label: 'Item' },
  { key: 'quantity', label: 'Qty sold' },
  { key: 'invoices', label: 'Invoices' },
  { key: 'grossRevenue', label: 'Paid revenue' },
  { key: 'eightySixed', label: 'Times 86d' },
]
const voidCols: CsvColumn<Awaited<ReturnType<typeof getRestaurantReport>>['voidComp']['entries'][number]>[] = [
  { key: 'at', label: 'When (UTC)' },
  { key: 'kind', label: 'Type' },
  { key: 'itemName', label: 'Item' },
  { key: 'qty', label: 'Qty' },
  { key: 'amount', label: 'Value' },
  { key: 'staff', label: 'By' },
  { key: 'reason', label: 'Reason' },
]
const serverCols: CsvColumn<Awaited<ReturnType<typeof getRestaurantReport>>['servers'][number]>[] = [
  { key: 'serverName', label: 'Server' },
  { key: 'sessions', label: 'Sessions' },
  { key: 'covers', label: 'Guests' },
  { key: 'billed', label: 'Billed sales' },
  { key: 'spendPerCover', label: 'Spend per guest' },
  { key: 'tips', label: 'Tips' },
  { key: 'tipPct', label: 'Tip %' },
]

function StatCard({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-4 shadow-sm">
      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="mt-2 text-2xl font-semibold tabular-nums">{value}</p>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{hint}</p>
    </div>
  )
}

function Section({ icon, title, action, children }: { icon: React.ReactNode; title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="mt-6 overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <h2 className="inline-flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          {icon}
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  )
}

function Table({ head, right, children }: { head: string[]; right: number[]; children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[560px] text-left text-base">
        <thead>
          <tr className="border-b border-border text-sm uppercase tracking-wider text-muted-foreground">
            {head.map((h, i) => (
              <th key={h} className={`px-4 py-3 font-semibold ${right.includes(i) ? 'text-right' : ''}`}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  )
}

function Bar({ value, max }: { value: number; max: number }) {
  const pct = max > 0 ? Math.max((value / max) * 100, value > 0 ? 2 : 0) : 0
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
      <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
    </div>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-4 py-8 text-center text-sm text-muted-foreground">{children}</p>
}

function Note({ children }: { children: React.ReactNode }) {
  return <p className="border-t border-border px-4 py-2 text-xs text-muted-foreground">{children}</p>
}
