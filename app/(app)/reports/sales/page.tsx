import { redirect } from 'next/navigation'
import { BadgeCheck, UtensilsCrossed } from 'lucide-react'
import { getActiveContext } from '@/lib/tenant/context'
import { isManager } from '@/lib/auth/roles'
import { getSalesReport } from '@/lib/reports/sales'
import { resolveDateRange } from '@/lib/reports/date-range'
import { formatMoney } from '@/lib/format'
import { todayInZone } from '@/lib/booking/time'
import { DateRangeFilter } from '@/components/reports/DateRangeFilter'
import { ExportCsvButton } from '@/components/reports/ExportCsvButton'

type Search = { from?: string; to?: string }

/**
 * Food & Membership sales (AROS-66) — the sibling of /reports, same shape:
 * a server component that resolves context, enforces authorization and loads
 * the report, with the shared date filter and CSV button as the only client
 * pieces. Authorization is enforced here AND in getSalesReport() AND in the
 * export action; the nav entry is convenience, not a guard.
 */
export default async function SalesReportPage({ searchParams }: { searchParams: Promise<Search> }) {
  const ctx = await getActiveContext()
  if (!ctx) return null // the layout already guards a missing session
  if (!isManager(ctx.role)) redirect('/dashboard')

  const tz = ctx.tenant.timezone
  const currency = ctx.tenant.currency
  const sp = await searchParams
  const today = todayInZone(tz)
  const range = resolveDateRange({ start: sp.from, end: sp.to }, { timeZone: tz })

  const report = await getSalesReport(ctx, { range })
  const { food, memberships, totals } = report
  const money = (n: number) => formatMoney(n, currency)
  const maxFood = Math.max(...food.map((f) => f.grossRevenue), 0)
  const maxPlan = Math.max(...memberships.map((m) => m.revenue), 0)

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Food &amp; Membership Sales</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            What sold at {ctx.tenant.name} — plate by plate and plan by plan.
          </p>
        </div>
      </div>

      <DateRangeFilter basePath="/reports/sales" from={range.start} to={range.end} today={today} />

      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Items sold" value={formatQty(totals.foodQuantity)} hint="Billed food & drink lines" />
        <StatCard
          label="Food gross"
          value={money(totals.foodGrossRevenue)}
          hint="Before invoice discounts and GST"
        />
        <StatCard label="Plans sold" value={String(totals.membershipsSold)} hint="Memberships purchased" />
        <StatCard label="Membership revenue" value={money(totals.membershipRevenue)} hint="Price paid at purchase" />
      </div>

      {/* ── food ── */}
      <Section
        icon={<UtensilsCrossed size={15} />}
        title="Food & drink sales"
        action={
          food.length > 0 ? (
            <ExportCsvButton from={range.start} to={range.end} dataset="food" label="CSV" />
          ) : undefined
        }
      >
        {food.length === 0 ? (
          <Empty>
            No food or drink was billed between {range.start} and {range.end}. Orders only appear here once their
            booking has been billed.
          </Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-left text-base">
              <thead>
                <tr className="border-b border-border text-sm uppercase tracking-wider text-muted-foreground">
                  <th className="px-4 py-3 font-semibold">Item</th>
                  <th className="px-4 py-3 text-right font-semibold">Qty sold</th>
                  <th className="px-4 py-3 text-right font-semibold">Invoices</th>
                  <th className="px-4 py-3 text-right font-semibold">Gross revenue</th>
                  <th className="px-4 py-3 font-semibold">Share</th>
                </tr>
              </thead>
              <tbody>
                {food.map((f) => (
                  <tr key={f.itemName} className="border-b border-border last:border-0">
                    <td className="px-4 py-3">{f.itemName}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{formatQty(f.quantity)}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">{f.invoices}</td>
                    <td className="px-4 py-3 text-right font-medium tabular-nums">{money(f.grossRevenue)}</td>
                    <td className="px-4 py-3">
                      <Bar value={f.grossRevenue} max={maxFood} />
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-border font-semibold">
                  <td className="px-4 py-3">Total</td>
                  <td className="px-4 py-3 text-right tabular-nums">{formatQty(totals.foodQuantity)}</td>
                  <td />
                  <td className="px-4 py-3 text-right tabular-nums">{money(totals.foodGrossRevenue)}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
        {/* Said plainly, because this figure deliberately does NOT match the
            net revenue on /reports: a line total is qty × price as billed, and
            invoice-level discounts and GST are applied to the bill as a whole,
            never written back onto the line. */}
        <p className="border-t border-border px-4 py-2 text-xs text-muted-foreground">
          Counted from billed invoice lines, by the item name at the time of sale. Gross revenue excludes
          invoice-level discounts (promo, membership, loyalty) and GST, so it will not equal net revenue.
        </p>
      </Section>

      {/* ── memberships ── */}
      <Section
        icon={<BadgeCheck size={15} />}
        title="Membership sales"
        action={
          memberships.length > 0 ? (
            <ExportCsvButton from={range.start} to={range.end} dataset="memberships" label="CSV" />
          ) : undefined
        }
      >
        {memberships.length === 0 ? (
          <Empty>
            No memberships were sold between {range.start} and {range.end}.
          </Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-left text-base">
              <thead>
                <tr className="border-b border-border text-sm uppercase tracking-wider text-muted-foreground">
                  <th className="px-4 py-3 font-semibold">Plan</th>
                  <th className="px-4 py-3 text-right font-semibold">Plans sold</th>
                  <th className="px-4 py-3 text-right font-semibold">Cancelled since</th>
                  <th className="px-4 py-3 text-right font-semibold">Revenue</th>
                  <th className="px-4 py-3 font-semibold">Share</th>
                </tr>
              </thead>
              <tbody>
                {memberships.map((m) => (
                  <tr key={`${m.planId}:${m.planName}`} className="border-b border-border last:border-0">
                    <td className="px-4 py-3">{m.planName}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{m.sold}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                      {m.cancelled > 0 ? m.cancelled : '—'}
                    </td>
                    <td className="px-4 py-3 text-right font-medium tabular-nums">{money(m.revenue)}</td>
                    <td className="px-4 py-3">
                      <Bar value={m.revenue} max={maxPlan} />
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-border font-semibold">
                  <td className="px-4 py-3">Total</td>
                  <td className="px-4 py-3 text-right tabular-nums">{totals.membershipsSold}</td>
                  <td />
                  <td className="px-4 py-3 text-right tabular-nums">{money(totals.membershipRevenue)}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
        <p className="border-t border-border px-4 py-2 text-xs text-muted-foreground">
          Dated by purchase, priced at what was actually charged — never today&apos;s plan price. A cancelled
          membership stays a sale: cancelling does not refund it.
        </p>
      </Section>
    </div>
  )
}

function StatCard({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-4 shadow-sm">
      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="mt-2 text-2xl font-semibold tabular-nums">{value}</p>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{hint}</p>
    </div>
  )
}

function Section({
  icon,
  title,
  action,
  children,
}: {
  icon: React.ReactNode
  title: string
  action?: React.ReactNode
  children: React.ReactNode
}) {
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

/** Quantities are numeric(10,2) in the schema but whole plates in practice. */
function formatQty(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2)
}
