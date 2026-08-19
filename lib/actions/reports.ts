'use server'

import { z } from 'zod'
import { requireManager, AuthError } from '@/lib/auth/guard'
import { zodErrorMessage } from '@/lib/utils/errors'
import { DateRangeError, parseDateRange } from '@/lib/reports/date-range'
import { ReportAccessError } from '@/lib/reports/daily-revenue'
import { getRevenueDashboard, dashboardCsv, RESOURCE_USAGE_CSV_COLUMNS } from '@/lib/reports/revenue'
import { getSalesReport, FOOD_SALES_CSV_COLUMNS, MEMBERSHIP_SALES_CSV_COLUMNS } from '@/lib/reports/sales'
import { toCsv } from '@/lib/reports/csv'

/**
 * CSV exports for the report pages — the Revenue & Bookings dashboard
 * (AROS-65) and the Food & Membership sales report (AROS-66).
 *
 * A Server Action rather than a route handler, deliberately: an action is
 * reached only through Next's own POST path with the session cookie attached
 * and an Origin/Host check Next enforces itself (see next.config.ts), so there
 * is no public URL that could hand a spreadsheet of a tenant's takings to
 * anyone who guesses it.
 *
 * The export is authorized EXACTLY like the page it belongs to, and twice over:
 * requireManager() here, and getRevenueDashboard() → the readers, which refuse
 * a non-manager on their own. Tenant scoping is never a parameter — it comes
 * from the authenticated context and then from RLS, so the range is the only
 * thing the browser gets to choose.
 */

type ExportResult = { error?: string; csv?: string; filename?: string }

function fail(e: unknown): ExportResult {
  if (e instanceof AuthError || e instanceof ReportAccessError || e instanceof DateRangeError) {
    return { error: e.message }
  }
  if (e instanceof z.ZodError) return { error: zodErrorMessage(e) }
  console.error('[reports] export failed:', e)
  return { error: 'Could not build the export. Please try again.' }
}

const exportInput = z.object({
  start: z.string(),
  end: z.string(),
  branchId: z.string().uuid().optional().nullable(),
  /** Which grain to export. Each is a different table on a report page. */
  dataset: z.enum(['daily', 'resources', 'food', 'memberships']).default('daily'),
})

export async function exportRevenueReportCsv(input: unknown): Promise<ExportResult> {
  try {
    const ctx = await requireManager()
    const v = exportInput.parse(input)
    // The STRICT parser here, not the lenient one the page uses: a page silently
    // falling back to sensible defaults is good UX, but an export that quietly
    // returns a different period from the one asked for is a wrong document.
    const range = parseDateRange({ start: v.start, end: v.end })

    const stamp = `${range.start}_${range.end}`

    // Sales first, so a food/membership export does not also run the whole
    // revenue+bookings dashboard just to throw it away.
    if (v.dataset === 'food' || v.dataset === 'memberships') {
      const sales = await getSalesReport(ctx, { range, branchId: v.branchId ?? null })
      return v.dataset === 'food'
        ? { csv: toCsv(sales.food, FOOD_SALES_CSV_COLUMNS), filename: `food-sales_${stamp}.csv` }
        : {
            csv: toCsv(sales.memberships, MEMBERSHIP_SALES_CSV_COLUMNS),
            filename: `membership-sales_${stamp}.csv`,
          }
    }
    const data = await getRevenueDashboard(ctx, { range, branchId: v.branchId ?? null })
    if (v.dataset === 'resources') {
      return {
        csv: toCsv(data.bookings.topResources, RESOURCE_USAGE_CSV_COLUMNS),
        filename: `resource-usage_${stamp}.csv`,
      }
    }
    return { csv: dashboardCsv(data), filename: `revenue-bookings_${stamp}.csv` }
  } catch (e) {
    return fail(e)
  }
}
