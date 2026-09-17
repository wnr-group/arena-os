import 'server-only'
import { sql } from 'drizzle-orm'
import { withUser } from '@/db'
import type { ActiveContext } from '@/lib/tenant/context'
import { requireEntitlement } from '@/lib/platform/entitlement-guard'
import { isManager } from '@/lib/auth/roles'
import { cashMovements, movementForKind, movementRefundsOut, movementShareOf } from './revenue-basis'
import type { CsvColumn } from './csv'
import type { DateRange } from './date-range'

/**
 * Daily PAID revenue, aggregated LIVE from `payments`.
 *
 * ── WHAT IT READS ───────────────────────────────────────────────────────────
 * Captured payments joined to their invoices, through the shared definition in
 * ./revenue-basis.ts — money taken, dated by when it was taken, split across
 * booking / food / membership by each kind's share of the bill.
 *
 * Two things changed here, in order:
 *
 *   1. It used to read public.v_daily_revenue, over the MATERIALIZED
 *      mv_daily_revenue. Nothing schedules the refresh that rebuilds it, so
 *      anything billed since the last manual run was missing while Food and
 *      Membership — live queries — showed it. That snapshot is no longer read
 *      by anything in the product, though it and scripts/refresh-reports.ts
 *      are left in place.
 *   2. It then counted an invoice as revenue the moment it was RAISED. It now
 *      counts money only when it is CAPTURED, so an unpaid bill contributes
 *      nothing and a part-paid one contributes only what was collected.
 *
 * ── HOW IT IS SCOPED ────────────────────────────────────────────────────────
 * Through withUser(), like every other tenant read in this codebase, so the
 * database — not this function — decides which rows exist. RLS on `invoices`
 * is the guarantee; ownerDb bypasses RLS and must never appear on this path.
 * The explicit tenant_id predicate is a second lock.
 *
 * The role check mirrors the sibling report (lib/reports/employees.ts is
 * guarded at the page): reports are owner/manager per ARCHITECTURE.md §3.
 */

export type DailyRevenueRow = {
  /** `YYYY-MM-DD` — the branch's local calendar day the money was taken on. */
  day: string
  branchId: string
  branchName: string | null
  /** The collected share of the invoices' subtotal — before discount and tax,
   *  net of refunds. */
  gross: number
  /** The collected share of the invoices' discount, net of refunds. */
  discount: number
  /** The collected share of the invoices' tax, net of refunds. */
  tax: number
  /** The collected share of the invoices' service charge, net of refunds. */
  serviceCharge: number
  /** THE FIGURE: rupees captured on this day, minus rupees refunded on it. */
  net: number
  /** Rupees returned to customers on this day (the size of the day's refunds).
   *  Already subtracted from `net`; shown so a busy refund day is legible. */
  refunds: number
  /** Distinct invoices money moved against (paid or refunded). */
  invoiceCount: number
  /** `net`, split by what the money was for. The four sum to `net` exactly
   *  (adjustment lines are counted with food). */
  bookingRevenue: number
  foodRevenue: number
  membershipRevenue: number
  serviceChargeRevenue: number
}

export type DailyRevenueTotals = {
  gross: number
  discount: number
  tax: number
  serviceCharge: number
  net: number
  refunds: number
  invoiceCount: number
  days: number
  bookingRevenue: number
  foodRevenue: number
  membershipRevenue: number
  serviceChargeRevenue: number
}

export class ReportAccessError extends Error {}

/**
 * One row per (branch, day) inside `range`, oldest first.
 *
 * The filter compares the branch-local day against plain dates, inclusive at
 * both ends (see lib/reports/date-range.ts for why). idx_invoices_branch
 * covers (tenant_id, branch_id); at the volumes this reports on the aggregate
 * is trivial, and a dedicated (tenant_id, issued_at) index is the thing to add
 * if that ever stops being true.
 */
export async function getDailyRevenue(
  ctx: ActiveContext,
  options: { range: DateRange; branchId?: string | null },
): Promise<DailyRevenueRow[]> {
  requireReportAccess(ctx)
  // Module gate (M16 #2): the plan must include Reports. Authoritative —
  // the pages redirect for presentation, this is what actually refuses.
  await requireEntitlement(ctx, 'module.reports')
  const { range, branchId } = options

  // One GROUP BY in Postgres — at most one row per branch per day out.
  const result = await withUser(ctx.user.id, (tx) =>
    tx.execute(sql`
      select m.local_day::text                                        as day,
             m.branch_id::text                                        as branch_id,
             m.branch_name                                            as branch_name,
             sum(${movementShareOf(sql`subtotal`)})::float            as gross,
             sum(${movementShareOf(sql`discount`)})::float            as discount,
             sum(${movementShareOf(sql`tax_total`)})::float           as tax,
             sum(${movementShareOf(sql`service_charge`)})::float      as service_charge,
             sum(m.amount)::float                                     as net,
             sum(${movementRefundsOut})::float                        as refunds,
             count(distinct m.invoice_id)::int                        as invoice_count,
             coalesce(sum(${movementForKind('booking')}), 0)::float        as booking_revenue,
             coalesce(sum(${movementForKind('food')}), 0)::float           as food_revenue,
             coalesce(sum(${movementForKind('membership')}), 0)::float     as membership_revenue,
             coalesce(sum(${movementForKind('service_charge')}), 0)::float as service_charge_revenue
        from ${cashMovements(ctx.tenant.id, range, branchId)} m
       group by m.local_day, m.branch_id, m.branch_name
       order by day asc, branch_name asc
    `),
  )
  const rows = result.rows as {
    day: string
    branch_id: string
    branch_name: string | null
    gross: number
    discount: number
    tax: number
    service_charge: number
    net: number
    refunds: number
    invoice_count: number
    booking_revenue: number
    food_revenue: number
    membership_revenue: number
    service_charge_revenue: number
  }[]

  return rows.map((r) => ({
    day: r.day,
    branchId: r.branch_id,
    branchName: r.branch_name,
    gross: round2(Number(r.gross)),
    discount: round2(Number(r.discount)),
    tax: round2(Number(r.tax)),
    serviceCharge: round2(Number(r.service_charge)),
    net: round2(Number(r.net)),
    refunds: round2(Number(r.refunds)),
    invoiceCount: Number(r.invoice_count),
    bookingRevenue: round2(Number(r.booking_revenue)),
    foodRevenue: round2(Number(r.food_revenue)),
    membershipRevenue: round2(Number(r.membership_revenue)),
    serviceChargeRevenue: round2(Number(r.service_charge_revenue)),
  }))
}

/**
 * Period totals for a set of rows — the summary strip above a report table.
 *
 * Summed in JS from rows the database already aggregated, so the figure can
 * never disagree with the table under it. `days` counts DAYS WITH REVENUE, not
 * the length of the range.
 */
export function sumDailyRevenue(rows: readonly DailyRevenueRow[]): DailyRevenueTotals {
  const totals = {
    gross: 0, discount: 0, tax: 0, serviceCharge: 0, net: 0, refunds: 0,
    invoiceCount: 0, days: 0,
    bookingRevenue: 0, foodRevenue: 0, membershipRevenue: 0, serviceChargeRevenue: 0,
  }
  const days = new Set<string>()
  for (const r of rows) {
    totals.gross += r.gross
    totals.discount += r.discount
    totals.tax += r.tax
    totals.serviceCharge += r.serviceCharge
    totals.net += r.net
    totals.refunds += r.refunds
    totals.invoiceCount += r.invoiceCount
    totals.bookingRevenue += r.bookingRevenue
    totals.foodRevenue += r.foodRevenue
    totals.membershipRevenue += r.membershipRevenue
    totals.serviceChargeRevenue += r.serviceChargeRevenue
    days.add(r.day)
  }
  totals.days = days.size
  // Money summed as floats drifts (0.1 + 0.2); every total here is 2dp, so
  // rounding once at the end restores the exact figure.
  return {
    ...totals,
    gross: round2(totals.gross),
    discount: round2(totals.discount),
    tax: round2(totals.tax),
    serviceCharge: round2(totals.serviceCharge),
    net: round2(totals.net),
    refunds: round2(totals.refunds),
    bookingRevenue: round2(totals.bookingRevenue),
    foodRevenue: round2(totals.foodRevenue),
    membershipRevenue: round2(totals.membershipRevenue),
    serviceChargeRevenue: round2(totals.serviceChargeRevenue),
  }
}

/**
 * The export's column spec (AROS-65 will hand this to toCsv/csvStream).
 *
 * Money is exported at 2dp as a bare number — no currency symbol, no thousands
 * separator — so a spreadsheet reads it as a number. Formatting belongs on the
 * screen, not in a data file.
 */
export const DAILY_REVENUE_CSV_COLUMNS: readonly CsvColumn<DailyRevenueRow>[] = [
  { header: 'Day', value: (r) => r.day },
  { header: 'Branch', value: (r) => r.branchName },
  { header: 'Invoices', value: (r) => r.invoiceCount },
  { header: 'Gross', value: (r) => r.gross.toFixed(2) },
  { header: 'Discount', value: (r) => r.discount.toFixed(2) },
  { header: 'Tax', value: (r) => r.tax.toFixed(2) },
  { header: 'Service charge', value: (r) => r.serviceCharge.toFixed(2) },
  { header: 'Refunds', value: (r) => r.refunds.toFixed(2) },
  { header: 'Net', value: (r) => r.net.toFixed(2) },
]

function requireReportAccess(ctx: ActiveContext): void {
  if (!isManager(ctx.role)) {
    throw new ReportAccessError('Only owners and managers can view reports.')
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
