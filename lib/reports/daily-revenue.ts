import 'server-only'
import { and, asc, eq, gte, lte } from 'drizzle-orm'
import { withUser } from '@/db'
import { branches, vDailyRevenue } from '@/db/schema'
import type { ActiveContext } from '@/lib/tenant/context'
import { isManager } from '@/lib/auth/roles'
import type { CsvColumn } from './csv'
import type { DateRange } from './date-range'

/**
 * Daily revenue, read through the security-barrier view (AROS-64).
 *
 * ── WHAT IT READS ───────────────────────────────────────────────────────────
 * public.v_daily_revenue, and only that. Never mv_daily_revenue: a
 * materialized view does not enforce RLS, arena_app has no grant on it, and
 * the barrier view is what re-applies auth_tenant_ids(). See
 * db/migrations/0032_reporting.sql.
 *
 * ── HOW IT IS SCOPED ────────────────────────────────────────────────────────
 * Through withUser(), like every other tenant read in this codebase, so the
 * database — not this function — decides which rows exist. ownerDb bypasses
 * RLS and must never appear on this path. The explicit tenant_id filter below
 * is a second lock and an index hint, not the guarantee.
 *
 * The role check mirrors the sibling report (lib/reports/employees.ts is
 * guarded at the page): reports are owner/manager per ARCHITECTURE.md §3. It
 * is a product rule, deliberately kept out of the SQL so the shared view stays
 * usable by AROS-65/66/67.
 */

export type DailyRevenueRow = {
  /** `YYYY-MM-DD` — the branch's local calendar day, already bucketed. */
  day: string
  branchId: string
  branchName: string | null
  /** SUM(invoices.subtotal) — before discount, before tax. */
  gross: number
  /** SUM(invoices.discount) — every kind, already combined on the invoice. */
  discount: number
  /** SUM(invoices.tax_total). */
  tax: number
  /** SUM(invoices.total) — what was actually billed. */
  net: number
  invoiceCount: number
}

export type DailyRevenueTotals = {
  gross: number
  discount: number
  tax: number
  net: number
  invoiceCount: number
  days: number
}

export class ReportAccessError extends Error {}

/**
 * One row per (branch, day) inside `range`, oldest first.
 *
 * The filter is applied to the aggregated `day` column — a plain date compared
 * against plain dates, so there is no timezone conversion at query time and no
 * off-by-one at either end (see lib/reports/date-range.ts for why the range is
 * inclusive). idx_mv_daily_revenue_tenant_day covers (tenant_id, day); adding
 * a branch narrows it onto mv_daily_revenue_key instead.
 */
export async function getDailyRevenue(
  ctx: ActiveContext,
  options: { range: DateRange; branchId?: string | null },
): Promise<DailyRevenueRow[]> {
  requireReportAccess(ctx)
  const { range, branchId } = options

  const rows = await withUser(ctx.user.id, (tx) =>
    tx
      .select({
        day: vDailyRevenue.day,
        branchId: vDailyRevenue.branchId,
        branchName: branches.name,
        gross: vDailyRevenue.gross,
        discount: vDailyRevenue.discount,
        tax: vDailyRevenue.tax,
        net: vDailyRevenue.net,
        invoiceCount: vDailyRevenue.invoiceCount,
      })
      .from(vDailyRevenue)
      // Left, not inner: a deleted branch must not make its revenue vanish
      // from a historical report. `branches` is itself RLS-scoped.
      .leftJoin(branches, eq(branches.id, vDailyRevenue.branchId))
      .where(
        and(
          eq(vDailyRevenue.tenantId, ctx.tenant.id),
          gte(vDailyRevenue.day, range.start),
          lte(vDailyRevenue.day, range.end),
          branchId ? eq(vDailyRevenue.branchId, branchId) : undefined,
        ),
      )
      .orderBy(asc(vDailyRevenue.day), asc(branches.name)),
  )

  // numeric arrives as a string (exact, no float rounding on the way out of
  // Postgres); the report layer wants numbers. Same conversion the invoice
  // views already do — see app/(app)/invoices/[id]/page.tsx.
  return rows.map((r) => ({
    day: r.day,
    branchId: r.branchId,
    branchName: r.branchName,
    gross: Number(r.gross),
    discount: Number(r.discount),
    tax: Number(r.tax),
    net: Number(r.net),
    invoiceCount: r.invoiceCount,
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
  const totals = { gross: 0, discount: 0, tax: 0, net: 0, invoiceCount: 0, days: 0 }
  const days = new Set<string>()
  for (const r of rows) {
    totals.gross += r.gross
    totals.discount += r.discount
    totals.tax += r.tax
    totals.net += r.net
    totals.invoiceCount += r.invoiceCount
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
    net: round2(totals.net),
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
