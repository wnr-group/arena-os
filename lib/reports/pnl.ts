import 'server-only'
import { and, asc, desc, eq, gte, lte, sql } from 'drizzle-orm'
import { withUser } from '@/db'
import { expenseCategories, expenses, payslips, vDailyRevenue } from '@/db/schema'
import type { ActiveContext } from '@/lib/tenant/context'
import { isManager } from '@/lib/auth/roles'
import { ReportAccessError } from './daily-revenue'
import type { DateRange } from './date-range'

/**
 * Profit & loss: revenue − expenses − payroll.
 *
 * ── WHAT EACH LINE READS ────────────────────────────────────────────────────
 *
 *   revenue   public.v_daily_revenue — the AROS-64 security-barrier view, and
 *             only ever that. NEVER mv_daily_revenue: a materialized view does
 *             not enforce RLS, arena_app holds no grant on it (0043), and the
 *             barrier view is what re-applies auth_tenant_ids(). The status
 *             filter the ticket asks for — invoices in ('issued','paid') — is
 *             already baked into the MV, so this reader inherits it and cannot
 *             get it wrong.
 *
 *   expenses  public.expenses, RLS-scoped, filtered on `spent_on`.
 *
 *   payroll   public.payslips, RLS-scoped (payslips_manager_select), filtered
 *             on `period`. SUM(gross) — see the gross-not-net note below. Also
 *             the one line that cannot be sliced to an arbitrary day.
 *
 * Every figure is aggregated in SQL. No report loads rows to add them up, and
 * nothing is filtered in the browser.
 *
 * ── THE PAYROLL LINE IS GROSS, NOT NET (AROS-184) ───────────────────────────
 *
 * `net_pay` is the cash the employee receives: gross − deductions_total −
 * advance_instalment. Neither subtraction belongs in a P&L expense line.
 *
 *   deductions_total    is still money the business pays out — it goes to the
 *                       tax authority and the PF fund instead of into the
 *                       employee's hand. An expense either way.
 *   advance_instalment  is the recovery of a loan made in an EARLIER period, a
 *                       balance-sheet movement, not a reduction in this
 *                       period's wage cost.
 *
 * Summing net_pay therefore understates the wage bill — and overstates
 * netProfit — for any tenant that withholds tax/PF or is recovering an advance.
 * `gross` is what it costs to employ someone for the period, so `gross` is what
 * this line reads. That also reconciles with the sibling report
 * lib/reports/payroll.ts, whose headline figure is `totalGross` with deductions
 * and advance recoveries broken out separately.
 *
 * ── THE PAYROLL GRANULARITY DECISION ────────────────────────────────────────
 *
 * Revenue and expenses are day-grained; payroll is not. `payslips` carries only
 * `period` ('YYYY-MM') — there is no pay date, and `created_at` is when the run
 * was EXECUTED, so a March payroll processed in April would land in the wrong
 * month if it were used.
 *
 * Proration was rejected. A payslip's `deductions_total` is documented in
 * migration 0029 as "NOT prorated by attendance, a flat monthly figure", so
 * splitting a month's wage bill across days would report a number the business
 * never paid and cannot reconcile against its own payslips.
 *
 * So the payroll line covers WHOLE CALENDAR MONTHS THAT OVERLAP the selected
 * range, and the exact months used are returned in `payrollPeriods` so the UI
 * and the CSV can state them rather than quietly implying day precision. A
 * range of 15 Mar–20 Apr therefore includes all of March and all of April's
 * payroll. That is visible and explainable; a prorated figure would be neither.
 *
 * Consequence worth knowing: `netProfit` is only a true like-for-like figure
 * when the range is whole months. The UI says so when it is not.
 */

export type PnlExpenseCategoryRow = {
  categoryId: string
  categoryName: string
  amount: number
  expenseCount: number
}

export type PnlReport = {
  range: DateRange
  revenue: {
    /** SUM(invoices.total) for issued+paid invoices — what was actually billed. */
    net: number
    /** SUM(invoices.subtotal), before discount and tax. Context, not the P&L line. */
    gross: number
    discount: number
    tax: number
    invoiceCount: number
  }
  expenses: {
    total: number
    count: number
    byCategory: PnlExpenseCategoryRow[]
  }
  payroll: {
    /** SUM(payslips.gross) — the wage bill before withholding. See the note above. */
    total: number
    payslipCount: number
    /** The 'YYYY-MM' periods actually included — see the note above. */
    periods: string[]
    /** True when the range is NOT exactly whole months, so payroll is wider. */
    isApproximate: boolean
  }
  /** revenue.net − expenses.total − payroll.total */
  netProfit: number
}

/**
 * The whole report, in one RLS-scoped transaction.
 *
 * One transaction so the three lines describe the same instant: an expense
 * recorded between two round trips could otherwise appear in the total but not
 * the breakdown, and the numbers on screen would not add up.
 */
export async function getPnlReport(ctx: ActiveContext, range: DateRange): Promise<PnlReport> {
  requireReportAccess(ctx)

  const periods = monthsOverlapping(range)
  const approximate = !isWholeMonths(range)

  return withUser(ctx.user.id, async (tx) => {
    // ── revenue ───────────────────────────────────────────────────────────
    // Aggregated by the database over the barrier view. The explicit tenant_id
    // predicate is a second lock and an index hint (idx_mv_daily_revenue_tenant_day),
    // never the guarantee — the view's auth_tenant_ids() is.
    const [revenueRow] = await tx
      .select({
        gross: sql<string>`coalesce(sum(${vDailyRevenue.gross}), 0)`,
        discount: sql<string>`coalesce(sum(${vDailyRevenue.discount}), 0)`,
        tax: sql<string>`coalesce(sum(${vDailyRevenue.tax}), 0)`,
        net: sql<string>`coalesce(sum(${vDailyRevenue.net}), 0)`,
        invoiceCount: sql<number>`coalesce(sum(${vDailyRevenue.invoiceCount}), 0)::int`,
      })
      .from(vDailyRevenue)
      .where(
        and(
          eq(vDailyRevenue.tenantId, ctx.tenant.id),
          gte(vDailyRevenue.day, range.start),
          lte(vDailyRevenue.day, range.end),
        ),
      )

    // ── expenses: the grand total ─────────────────────────────────────────
    const expenseWhere = and(
      eq(expenses.tenantId, ctx.tenant.id),
      gte(expenses.spentOn, range.start),
      lte(expenses.spentOn, range.end),
    )

    const [expenseRow] = await tx
      .select({
        total: sql<string>`coalesce(sum(${expenses.amount}), 0)`,
        count: sql<number>`count(*)::int`,
      })
      .from(expenses)
      .where(expenseWhere)

    // ── expenses: the category breakdown ──────────────────────────────────
    // The SAME predicate as the total above, grouped. Sharing the predicate is
    // what makes the breakdown reconcile to the total by construction rather
    // than by luck — a test asserts they are equal.
    const byCategory = await tx
      .select({
        categoryId: expenseCategories.id,
        categoryName: expenseCategories.name,
        amount: sql<string>`coalesce(sum(${expenses.amount}), 0)`,
        expenseCount: sql<number>`count(*)::int`,
      })
      .from(expenses)
      .innerJoin(expenseCategories, eq(expenseCategories.id, expenses.categoryId))
      .where(expenseWhere)
      .groupBy(expenseCategories.id, expenseCategories.name)
      // Largest spend first — the thing a manager is looking for.
      .orderBy(desc(sql`sum(${expenses.amount})`), asc(expenseCategories.name))

    // ── payroll ───────────────────────────────────────────────────────────
    // Period strings compare lexicographically the same as chronologically
    // ('2026-02' < '2026-11'), which is why plain gte/lte works with no
    // parsing — the same property lib/reports/payroll.ts relies on.
    //
    // gross, NOT net_pay: withheld tax/PF is still money the business spends,
    // and an advance instalment is a loan repayment rather than a lower wage
    // bill. See the AROS-184 note at the top.
    const [payrollRow] = await tx
      .select({
        total: sql<string>`coalesce(sum(${payslips.gross}), 0)`,
        payslipCount: sql<number>`count(*)::int`,
      })
      .from(payslips)
      .where(
        and(
          eq(payslips.tenantId, ctx.tenant.id),
          gte(payslips.period, periods[0]),
          lte(payslips.period, periods[periods.length - 1]),
        ),
      )

    const revenueNet = round2(Number(revenueRow?.net ?? 0))
    const expenseTotal = round2(Number(expenseRow?.total ?? 0))
    const payrollTotal = round2(Number(payrollRow?.total ?? 0))

    return {
      range,
      revenue: {
        net: revenueNet,
        gross: round2(Number(revenueRow?.gross ?? 0)),
        discount: round2(Number(revenueRow?.discount ?? 0)),
        tax: round2(Number(revenueRow?.tax ?? 0)),
        invoiceCount: revenueRow?.invoiceCount ?? 0,
      },
      expenses: {
        total: expenseTotal,
        count: expenseRow?.count ?? 0,
        byCategory: byCategory.map((c) => ({
          categoryId: c.categoryId,
          categoryName: c.categoryName,
          amount: round2(Number(c.amount)),
          expenseCount: c.expenseCount,
        })),
      },
      payroll: {
        total: payrollTotal,
        payslipCount: payrollRow?.payslipCount ?? 0,
        periods,
        isApproximate: approximate,
      },
      // Rounded once, from three figures that are each already exact to 2dp,
      // so the displayed total always equals the displayed lines subtracted.
      netProfit: round2(revenueNet - expenseTotal - payrollTotal),
    }
  })
}

/**
 * Every 'YYYY-MM' month the range touches, ascending.
 *
 * Pure string arithmetic on the calendar dates — no Date objects, so it cannot
 * drift by a timezone. A range inside one month yields one period.
 */
export function monthsOverlapping(range: DateRange): string[] {
  const months: string[] = []
  let [y, m] = [Number(range.start.slice(0, 4)), Number(range.start.slice(5, 7))]
  const last = range.end.slice(0, 7)

  for (let guard = 0; guard < 400; guard++) {
    const period = `${y}-${String(m).padStart(2, '0')}`
    months.push(period)
    if (period >= last) break
    m += 1
    if (m > 12) {
      m = 1
      y += 1
    }
  }
  return months
}

/**
 * Does the range start on the 1st and end on a month's last day?
 *
 * When true, the payroll line lines up exactly with revenue and expenses and
 * `netProfit` is a like-for-like figure. When false the UI says the payroll
 * line covers whole months.
 */
export function isWholeMonths(range: DateRange): boolean {
  if (!range.start.endsWith('-01')) return false
  const [y, m] = [Number(range.end.slice(0, 4)), Number(range.end.slice(5, 7))]
  // Day 0 of the next month is the last day of this one.
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return Number(range.end.slice(8, 10)) === lastDay
}

/**
 * One CSV line. Money stays a NUMBER here — no currency symbol and no
 * thousands separator — so a spreadsheet reads it as a number; formatting
 * belongs on the screen, not in a data file. Expense and payroll lines are
 * negative so the four rows literally sum to the net.
 */
export type PnlCsvRow = { label: string; amount: number; detail: string }

/**
 * Flatten the report into CSV rows: the three P&L lines, the net, then one row
 * per expense category.
 *
 * Built from the SAME report object the page renders, so the file and the
 * screen cannot disagree — the export is a projection of the data, never a
 * second query.
 */
export function pnlCsvRows(report: PnlReport): PnlCsvRow[] {
  const rows: PnlCsvRow[] = [
    {
      label: 'Revenue',
      amount: report.revenue.net,
      detail: `${report.revenue.invoiceCount} invoice(s), ${report.range.start} to ${report.range.end}`,
    },
    {
      label: 'Expenses',
      amount: -report.expenses.total,
      detail: `${report.expenses.count} expense(s), ${report.range.start} to ${report.range.end}`,
    },
    {
      label: 'Payroll',
      amount: -report.payroll.total,
      detail: `${report.payroll.payslipCount} payslip(s), period(s) ${report.payroll.periods.join(', ')}${
        report.payroll.isApproximate ? ' — whole months, wider than the selected range' : ''
      }`,
    },
    { label: 'Net profit/loss', amount: report.netProfit, detail: '' },
  ]

  for (const c of report.expenses.byCategory) {
    rows.push({
      label: `Expenses — ${c.categoryName}`,
      amount: -c.amount,
      detail: `${c.expenseCount} expense(s)`,
    })
  }

  return rows
}

function requireReportAccess(ctx: ActiveContext): void {
  if (!isManager(ctx.role)) {
    throw new ReportAccessError('Only owners and managers can view reports.')
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
