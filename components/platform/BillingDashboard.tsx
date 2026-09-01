'use client'

import { useState, useTransition, type FormEvent } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { AlertTriangle, TrendingUp } from 'lucide-react'
import { money } from '@/lib/format'

/**
 * The platform billing dashboard, rendered (AROS-114 §12).
 *
 * PRESENTATION ONLY. Every number arrives already computed by
 * lib/platform/billing/metrics.ts — this component does no aggregation, no
 * normalisation and no currency arithmetic of its own, so the screen cannot
 * disagree with the SQL behind it. The only maths here is a bar's width.
 *
 * ── The chart is divs ───────────────────────────────────────────────────────
 *
 * Deliberately, following app/(app)/reports/page.tsx, which says the same
 * thing: "the bars below are divs, which keeps the bundle and the theme
 * consistent". This project has no charting dependency and this ticket is not
 * the reason to add one.
 */

type Mrr = {
  currency: string
  mrr: number
  arr: number
  activeCount: number
  pastDueMrr: number
  pastDueCount: number
  lapsedActiveCount: number
}

type Mix = {
  trialing: number
  active: number
  pastDue: number
  suspended: number
  cancelled: number
  noPlan: number
  tenants: number
}

type Churn = {
  activeAtStart: number
  churned: number
  churnRatePercent: number | null
  newInPeriod: number
  cancelledInPeriod: number
}

type RevenuePoint = {
  bucketStart: string
  gross: number
  refunded: number
  net: number
  invoices: number
  creditsIssued: number
}

type TenantRow = {
  tenantId: string
  slug: string
  name: string
  tenantStatus: string
  planName: string | null
  billingPeriod: 'monthly' | 'annual' | null
  status: string | null
  currentPeriodEnd: string | null
  mrr: number
  currency: string
}

const STATUS_STYLE: Record<string, string> = {
  active: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  trialing: 'bg-blue-500/15 text-blue-600 dark:text-blue-400',
  past_due: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  suspended: 'bg-destructive/10 text-destructive',
  cancelled: 'bg-muted text-muted-foreground',
}

const day = (iso: string) => new Date(iso).toLocaleDateString('en-IN', { dateStyle: 'medium' })

/**
 * An AXIS label: "28 Aug", not "28 Aug 2026".
 *
 * A column is at most 56px wide and the full medium date is half again that,
 * so the year either overflowed into its neighbour or got truncated to
 * "28 Aug 2…". The year is not carrying information here — the range picker
 * directly above states it, and every bar shares it — so dropping it is the
 * one edit that makes the label fit without losing anything. The exact date is
 * still on the column's hover title.
 */
const axisDay = (iso: string) =>
  new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })

export function BillingDashboard({
  basePath,
  range,
  bucket,
  headline,
  mrr,
  mix,
  churn,
  revenue,
  revenueTotals,
  tenants,
}: {
  basePath: string
  range: { start: string; end: string }
  bucket: 'day' | 'week' | 'month'
  headline: Mrr | null
  mrr: Mrr[]
  mix: Mix
  churn: Churn
  revenue: RevenuePoint[]
  revenueTotals: { gross: number; refunded: number; net: number; invoices: number; creditsIssued: number }
  tenants: TenantRow[]
}) {
  const currency = headline?.currency ?? 'INR'
  // Named for what it actually reduces. It was `maxNet` while summing `gross`,
  // which mattered once the bars started being drawn against it: the column is
  // gross with the refunded part shaded, so the scale has to be gross too.
  const maxGross = revenue.reduce((m, p) => Math.max(m, p.gross), 0)

  /**
   * The Companies table is capped server-side (TENANT_ROW_LIMIT), while every
   * figure above it — MRR, the mix, churn, revenue — is computed over the WHOLE
   * platform. So on a large platform the table is a sample and the tiles are
   * not, and saying nothing would leave "350 companies" sitting directly above
   * a list of 200 with no explanation.
   *
   * Compared against mix.tenants rather than re-counting: readMix() and
   * readTenantRows() both select from `tenants` with no filter, and both run in
   * ONE transaction, so the two are the same population read at the same
   * instant. A difference can only be the cap.
   */
  const tenantsTruncated = tenants.length < mix.tenants

  return (
    <>
      <Filters basePath={basePath} range={range} bucket={bucket} />

      {/* ── the tiles ─────────────────────────────────────────────────────
          Eight equal tiles used to sit here, five of which repeated counts the
          "Subscription mix" section renders below with proportion bars — the
          same number twice, in two styles, on one screen. The counts now live
          only in the mix, and this row keeps what the mix cannot say: the
          MONEY, and the two rates.

          MRR leads on its own because it is the number this page exists for;
          the rest support it. */}
      {/* One flat grid, MRR simply twice as wide. An earlier attempt nested a
          tall MRR card beside a 2×2 block of tiles, which stretched it to match
          their combined height and left half of it empty. Every card is one row
          tall here, so nothing stretches to fill space it has no content for. */}
      {/* sm is THREE columns, not two. With two, the three tiles beside MRR
          wrapped as 2 + 1 and left a dead cell at tablet width; at three they
          form one full row under a full-width MRR. At lg the same four cards
          sit on a single row: 3 + 1 + 1 + 1 = 6.

          `col-span-1` at the BASE breakpoint is load-bearing, not decoration.
          Below sm this grid has no explicit column count, and CSS sizes an
          implicit grid to fit the widest span in it — so a bare `col-span-3`
          silently created THREE implicit columns on a phone and crushed the
          three tiles into ~110px each at a 380px viewport. Resetting the span
          to 1 is what keeps the cards stacked; adding `grid-cols-1` instead
          does NOT fix it (the explicit track takes the free space and the two
          implicit ones collapse to ~44px). */}
      <div className="mt-6 grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <div className="rounded-lg border bg-card p-5 col-span-1 sm:col-span-3">
          <p className="text-xs font-medium text-muted-foreground">Monthly recurring revenue</p>
          <p className="mt-1 text-4xl font-semibold tabular-nums tracking-tight">
            {headline ? money(currency, headline.mrr) : '—'}
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            {headline
              ? `${headline.activeCount} active subscription${headline.activeCount === 1 ? '' : 's'} · annual ÷ 12`
              : 'No active subscriptions'}
          </p>
        </div>

        <Tile label="ARR" value={headline ? money(currency, headline.arr) : '—'} hint="MRR × 12" />
        <Tile
          label="At risk"
          value={headline ? money(currency, headline.pastDueMrr) : '—'}
          hint={`${mix.pastDue} subscription${mix.pastDue === 1 ? '' : 's'} in arrears`}
          tone={mix.pastDue > 0 ? 'warn' : undefined}
        />
        <Tile
          label="Churn"
          // Null is rendered as an em dash, never as "0%" — a rate over
          // nothing is undefined, and showing 0 would flatter an empty platform.
          value={churn.churnRatePercent === null ? '—' : `${churn.churnRatePercent}%`}
          // `newInPeriod` rides in the hint rather than taking a card of its
          // own: it is the counterweight to churn and is read WITH it ("lost
          // two, gained eleven"), and a fifth card left two dead cells in the
          // row for a number nobody looks up on its own.
          hint={
            (churn.churnRatePercent === null
              ? 'None live at the start of this range'
              : `${churn.churned} of ${churn.activeAtStart} live at the start`) +
            ` · ${churn.newInPeriod} new`
          }
          tone={churn.churnRatePercent !== null && churn.churnRatePercent > 0 ? 'warn' : undefined}
        />
      </div>

      {/* A platform billing several currencies cannot have ONE headline MRR.
          Said out loud rather than silently summing incompatible money. */}
      {mrr.length > 1 && (
        <p className="mt-3 flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
          <AlertTriangle size={14} className="shrink-0" />
          Plans are priced in {mrr.length} currencies. The tiles show{' '}
          {currency} only — currencies are never summed together.{' '}
          {/* Through money(), like every other figure on this page. These read
              "$1,234" rather than "USD 1234" — each in ITS OWN currency, which
              is the whole point of the banner. */}
          {mrr
            .slice(1)
            .map((m) => money(m.currency, m.mrr))
            .join(', ')}
        </p>
      )}

      {headline && headline.lapsedActiveCount > 0 && (
        <p className="mt-3 flex items-center gap-2 rounded-md border px-3 py-2 text-sm text-muted-foreground">
          <AlertTriangle size={14} className="shrink-0" />
          {headline.lapsedActiveCount} subscription
          {headline.lapsedActiveCount === 1 ? ' is' : 's are'} marked active but past their period
          end. They grant nothing and are excluded from MRR.
        </p>
      )}

      {/* ── revenue over time ─────────────────────────────────────────── */}
      <section className="mt-8 rounded-lg border">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <TrendingUp size={15} className="text-primary" />
            Revenue over time
          </h2>
          <p className="text-xs text-muted-foreground">
            {money(currency, revenueTotals.gross)} billed · {money(currency, revenueTotals.refunded)}{' '}
            refunded · <strong>{money(currency, revenueTotals.net)} net</strong> ·{' '}
            {revenueTotals.invoices} invoice{revenueTotals.invoices === 1 ? '' : 's'}
          </p>
        </div>

        {/* ── the series ───────────────────────────────────────────────────
            Was one ROW per bucket with a horizontal bar. That reads fine for a
            handful of categories — which is what the mix below is — but a time
            series is not categories: its whole value is the SHAPE, and a
            vertical list of horizontal bars hides trend behind scrolling. A
            range of a year at daily granularity was 365 rows.

            Columns on a shared baseline show growth, a dip and a spike at a
            glance. Refunds are drawn INSIDE the column as a destructive-tinted
            cap rather than as a footnote to the right, so a month that grossed
            well and refunded half of it stops looking like a good month. */}
        {/* Emptiness is now a question about ACTIVITY, not about row count.
            readRevenue() returns a contiguous spine, so `revenue.length` is
            never 0 for a valid range and testing it would have replaced this
            message with a flat, unexplained baseline of zero-height columns. */}
        {revenueTotals.invoices === 0 && revenueTotals.refunded === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">
            No paid invoices in this range.
          </p>
        ) : (
          <div className="overflow-x-auto px-4 pb-3 pt-4">
            <div className="flex h-48 min-w-full items-end gap-[3px]">
              {revenue.map((p) => {
                // Both segments are measured against the same max, so the whole
                // column is gross and the red portion is the part given back.
                const grossPct = maxGross > 0 ? Math.max((p.gross / maxGross) * 100, p.gross > 0 ? 1.5 : 0) : 0
                const refundPct = maxGross > 0 ? (Math.min(p.refunded, p.gross) / maxGross) * 100 : 0
                return (
                  <div
                    key={p.bucketStart}
                    // max-w matters as much as min-w: `flex-1` alone made two
                    // weekly buckets into two 700px slabs that read as a filled
                    // panel rather than a chart. Columns grow to fill the width
                    // and stop at a bar-like 56px, so a short range looks like a
                    // few bars on a baseline instead of a colour field.
                    className="group relative flex min-w-[6px] max-w-[56px] flex-1 flex-col justify-end"
                    style={{ height: '100%' }}
                    title={
                      `${day(p.bucketStart)}\n` +
                      `${money(currency, p.gross)} billed\n` +
                      (p.refunded > 0 ? `−${money(currency, p.refunded)} refunded\n` : '') +
                      `${money(currency, p.net)} net · ${p.invoices} invoice${p.invoices === 1 ? '' : 's'}`
                    }
                  >
                    <div
                      className="w-full overflow-hidden rounded-t-sm bg-primary/85 transition-all group-hover:bg-primary"
                      style={{ height: `${grossPct}%` }}
                    >
                      {/* The refunded slice, anchored to the TOP of the column:
                          money that arrived and left again. */}
                      {refundPct > 0 && (
                        <div
                          className="w-full bg-destructive/70"
                          style={{ height: `${(refundPct / grossPct) * 100}%` }}
                        />
                      )}
                    </div>
                  </div>
                )
              })}
            </div>

            {/* A short range gets a label under every column, MIRRORING the
                column layout exactly (same flex-1 and max-w) so each label sits
                beneath its own bar. Labelling only the two ends was wrong here:
                with two buckets the columns hug the left edge while the closing
                date sat at the far right, over empty space, appearing to date a
                bar that is not there. Past a dozen buckets per-column labels
                collide, so the ends are used instead — where they are accurate,
                because the columns then span the full width. */}
            {revenue.length <= 12 ? (
              <div className="mt-2 flex gap-[3px]">
                {revenue.map((p) => (
                  <span
                    key={p.bucketStart}
                    className="min-w-[6px] max-w-[56px] flex-1 truncate text-center text-[10px] text-muted-foreground"
                  >
                    {axisDay(p.bucketStart)}
                  </span>
                ))}
              </div>
            ) : (
              <div className="mt-2 flex justify-between text-[11px] text-muted-foreground">
                <span>{day(revenue[0].bucketStart)}</span>
                <span>{day(revenue[revenue.length - 1].bucketStart)}</span>
              </div>
            )}

            <div className="mt-2 flex flex-wrap items-center gap-3 border-t pt-2 text-[11px] text-muted-foreground">
              <span className="flex items-center gap-1">
                <span className="h-2 w-2 rounded-sm bg-primary/85" /> billed
              </span>
              {revenueTotals.refunded > 0 && (
                <span className="flex items-center gap-1">
                  <span className="h-2 w-2 rounded-sm bg-destructive/70" /> refunded
                </span>
              )}
              <span className="tabular-nums">peak {money(currency, maxGross)}</span>
              <span className="ml-auto">
                {revenue.length} {bucket}
                {revenue.length === 1 ? '' : 's'}
              </span>
            </div>
          </div>
        )}

        {/* Credit notes are shown, never netted off — they are already
            reflected as a discount on a later invoice, so subtracting them
            here would deduct the same credit twice. */}
        {revenueTotals.creditsIssued > 0 && (
          <p className="border-t px-4 py-2 text-xs text-muted-foreground">
            {money(currency, revenueTotals.creditsIssued)} of credit notes issued in this range.
            Not deducted above — a credit reduces a future invoice&rsquo;s total when it is applied.
          </p>
        )}
      </section>

      {/* ── subscription mix ──────────────────────────────────────────────
          Now the ONLY place the per-status counts appear, so it carries the
          alerting the removed tiles used to: past due and suspended are tinted
          when non-zero, because "3" in the same grey as every other row is not
          a number anybody notices. Each row also names what the state MEANS —
          the six labels were bare, and "No plan" in particular reads as an
          error rather than as the lapsed-or-never-subscribed bucket it is. */}
      <section className="mt-8 rounded-lg border">
        <h2 className="border-b px-4 py-3 text-sm font-semibold">Subscription mix</h2>
        <div className="divide-y">
          {[
            { label: 'Trial', value: mix.trialing, hint: 'Not yet paying — excluded from MRR', tone: '' },
            { label: 'Active', value: mix.active, hint: 'On a live paid plan', tone: '' },
            {
              label: 'Past due',
              value: mix.pastDue,
              hint: 'Charge failed; still working, inside grace',
              tone: mix.pastDue > 0 ? 'text-amber-700 dark:text-amber-400' : '',
            },
            {
              label: 'Suspended',
              value: mix.suspended,
              hint: 'Grace expired; access revoked',
              tone: mix.suspended > 0 ? 'text-destructive' : '',
            },
            { label: 'Cancelled', value: mix.cancelled, hint: 'Closed; records retained', tone: '' },
            { label: 'No plan', value: mix.noPlan, hint: 'Never subscribed, or lapsed quietly', tone: '' },
          ].map((row) => (
            <div
              key={row.label}
              className="grid grid-cols-[1fr_auto] items-center gap-3 px-4 py-2 text-sm sm:grid-cols-[9rem_1fr_auto]"
            >
              <span className={row.tone}>
                {row.label}
                <span className="block text-[11px] font-normal text-muted-foreground">
                  {row.hint}
                </span>
              </span>
              <div className="hidden sm:block">
                <Bar value={row.value} max={mix.tenants} tone={row.tone} />
              </div>
              <span className={`text-right tabular-nums ${row.tone || ''}`}>{row.value}</span>
            </div>
          ))}
        </div>
        <p className="border-t px-4 py-2 text-xs text-muted-foreground">
          {mix.tenants} companies. Counted once each — a business with several historical
          subscriptions appears in exactly one row.
        </p>
      </section>

      {/* ── tenants ───────────────────────────────────────────────────── */}
      <section className="mt-8 rounded-lg border">
        <h2 className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3 text-sm font-semibold">
          Companies
          <span className="text-xs font-normal tabular-nums text-muted-foreground">
            {tenantsTruncated
              ? `Showing ${tenants.length} of ${mix.tenants}`
              : `${tenants.length}`}
          </span>
        </h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">Company</th>
                <th className="px-4 py-2 font-medium">Plan</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 text-right font-medium">MRR</th>
                <th className="px-4 py-2 font-medium">Period end</th>
                <th className="px-4 py-2 font-medium" />
              </tr>
            </thead>
            <tbody className="divide-y">
              {tenants.map((t) => (
                <tr key={t.tenantId}>
                  <td className="px-4 py-2">
                    <span className="font-medium">{t.name}</span>
                    <span className="ml-2 text-xs text-muted-foreground">{t.slug}</span>
                  </td>
                  <td className="px-4 py-2 text-muted-foreground">
                    {t.planName ?? '—'}
                    {t.billingPeriod && (
                      <span className="ml-1 text-xs">· {t.billingPeriod}</span>
                    )}
                  </td>
                  <td className="px-4 py-2">
                    <span
                      className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                        STATUS_STYLE[t.status ?? t.tenantStatus] ?? 'bg-muted text-muted-foreground'
                      }`}
                    >
                      {(t.status ?? t.tenantStatus).replace('_', ' ')}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {t.mrr > 0 ? money(t.currency, t.mrr) : '—'}
                  </td>
                  <td className="px-4 py-2 text-muted-foreground">
                    {t.currentPeriodEnd ? day(t.currentPeriodEnd) : '—'}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <Link
                      href={`/admin/revenue/${t.tenantId}`}
                      className="rounded-md border px-2 py-1 text-xs hover:bg-muted"
                    >
                      Manage
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {tenants.length === 0 && (
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">No companies yet.</p>
        )}
        {/* WHICH companies are missing, not just how many. The table is ordered
            by MRR descending, so the ones cut are the zero-MRR tail — lapsed,
            cancelled and never-subscribed accounts, which is exactly the cohort
            somebody opens this page to chase. Leaving that unsaid would make an
            incomplete roster look like a complete one. */}
        {tenantsTruncated && (
          <p className="border-t px-4 py-2 text-xs text-muted-foreground">
            Ordered by MRR, so the {mix.tenants - tenants.length} not shown are the lowest-value
            accounts — mostly lapsed, cancelled or never subscribed. The figures above cover all{' '}
            {mix.tenants}.
          </p>
        )}
      </section>
    </>
  )
}

/** `?from=&to=&bucket=` — a soft RSC navigation, like the tenant reports' filter. */
function Filters({
  basePath,
  range,
  bucket,
}: {
  basePath: string
  range: { start: string; end: string }
  bucket: string
}) {
  const router = useRouter()
  const [from, setFrom] = useState(range.start)
  const [to, setTo] = useState(range.end)
  const [b, setB] = useState(bucket)
  const [pending, start] = useTransition()

  function apply(e: FormEvent) {
    e.preventDefault()
    start(() => {
      router.push(`${basePath}?from=${from}&to=${to}&bucket=${b}`)
    })
  }

  const field = 'rounded-lg border bg-background px-3 py-1.5 text-sm'

  return (
    <form onSubmit={apply} className="mt-6 flex flex-wrap items-end gap-3 rounded-lg border p-4">
      <div className="flex flex-col gap-1">
        <label htmlFor="pb-from" className="text-xs font-medium text-muted-foreground">From</label>
        <input id="pb-from" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} className={field} />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="pb-to" className="text-xs font-medium text-muted-foreground">To</label>
        <input id="pb-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} className={field} />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="pb-bucket" className="text-xs font-medium text-muted-foreground">Group by</label>
        <select id="pb-bucket" value={b} onChange={(e) => setB(e.target.value)} className={field}>
          <option value="day">Day</option>
          <option value="week">Week</option>
          <option value="month">Month</option>
        </select>
      </div>
      <button type="submit" disabled={pending} className="rounded-lg border px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:opacity-50">
        {pending ? 'Loading…' : 'Apply'}
      </button>
    </form>
  )
}

function Tile({
  label,
  value,
  hint,
  tone,
}: {
  label: string
  value: string
  hint?: string
  tone?: 'warn'
}) {
  return (
    <div className={`rounded-lg border p-4 ${tone === 'warn' ? 'border-amber-500/40' : ''}`}>
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

/**
 * `tone` carries a TEXT colour class from the caller, so the bar can match the
 * row it belongs to (amber for past due, red for suspended) using the same
 * value that colours the label — one decision, applied twice, rather than a
 * second colour table that could disagree with the first.
 */
function Bar({ value, max, tone }: { value: number; max: number; tone?: string }) {
  // max === 0 → every bar is empty rather than a division by zero. The same
  // guard app/(app)/reports/page.tsx uses.
  const pct = max > 0 ? Math.max((value / max) * 100, value > 0 ? 2 : 0) : 0
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
      <div
        className={`h-full rounded-full transition-all ${tone ? `bg-current ${tone}` : 'bg-primary'}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  )
}
