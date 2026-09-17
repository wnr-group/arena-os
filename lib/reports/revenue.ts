import 'server-only'
import type { ActiveContext } from '@/lib/tenant/context'
import { requireEntitlement } from '@/lib/platform/entitlement-guard'
import { getDailyRevenue, sumDailyRevenue, type DailyRevenueRow, type DailyRevenueTotals } from './daily-revenue'
import { getBookingMetrics, type BookingMetrics } from './bookings'
import { toCsv, type CsvColumn } from './csv'
import { eachDay, type DateRange } from './date-range'

/**
 * The Revenue & Bookings dashboard's data (AROS-65), composed from the two
 * readers rather than from any new query of its own:
 *
 *   revenue  → ./daily-revenue.ts  → captured payments net of refunds (revenue-basis.ts)
 *   bookings → ./bookings.ts       → booking_slots / resources / working_hours
 *
 * Both are already tenant-scoped through withUser() and both refuse a
 * non-manager, so this adds no privilege of its own. The page and the CSV
 * export both go through here, which is what stops the download from ever
 * disagreeing with the screen above it.
 */

export type DashboardDay = {
  day: string
  /** Revenue, summed across branches for the day. */
  gross: number
  discount: number
  tax: number
  serviceCharge: number
  /** Money captured on this day, minus money refunded on it. */
  net: number
  /** Money refunded on this day (already subtracted from `net`). */
  refunds: number
  invoices: number
  /** `net` split by what the money was for; the four sum back to it to the
   *  paise (`net` is authoritative on partially-collected days). */
  bookingRevenue: number
  foodRevenue: number
  membershipRevenue: number
  serviceChargeRevenue: number
  /** Booking-side figures for the same local day. */
  bookings: number
  bookedMinutes: number
  availableMinutes: number
  occupancyPercent: number | null
}

export type RevenueDashboard = {
  range: DateRange
  /** One row per day IN THE RANGE, including days with no activity. */
  days: DashboardDay[]
  revenueTotals: DailyRevenueTotals
  bookings: BookingMetrics
  /** Per (day, branch) — kept for a future branch breakdown, and what the
   *  revenue figures above are folded from. */
  revenueByBranch: DailyRevenueRow[]
}

export async function getRevenueDashboard(
  ctx: ActiveContext,
  options: { range: DateRange; branchId?: string | null },
): Promise<RevenueDashboard> {
  // Module gate (M16 #2). Stated here as well as in the two readers below,
  // which both enforce it themselves: this function is its own entry point
  // (the /reports page and the CSV export action call it directly), and a gate
  // that holds only because of what a delegate happens to do today is one
  // refactor away from not holding at all.
  await requireEntitlement(ctx, 'module.reports')

  const { range, branchId } = options

  // Sequential, not Promise.all: each opens its own withUser() transaction on
  // the shared app pool, and running report queries in parallel just competes
  // for the same small pool for no gain at this size.
  const revenueByBranch = await getDailyRevenue(ctx, { range, branchId })
  const bookings = await getBookingMetrics(ctx, { range, branchId })

  // Folding per-branch revenue rows into per-day ones, and filling the days
  // nothing happened on. This is presentation shaping over rows Postgres has
  // ALREADY aggregated — at most one row per branch per day — not aggregation
  // of source rows in JS.
  const revenueByDay = new Map<
    string,
    { gross: number; discount: number; tax: number; serviceCharge: number; net: number
      refunds: number; invoices: number
      bookingRevenue: number; foodRevenue: number; membershipRevenue: number; serviceChargeRevenue: number }
  >()
  for (const r of revenueByBranch) {
    const acc = revenueByDay.get(r.day) ?? {
      gross: 0, discount: 0, tax: 0, serviceCharge: 0, net: 0, refunds: 0, invoices: 0,
      bookingRevenue: 0, foodRevenue: 0, membershipRevenue: 0, serviceChargeRevenue: 0,
    }
    acc.gross += r.gross
    acc.discount += r.discount
    acc.tax += r.tax
    acc.serviceCharge += r.serviceCharge
    acc.net += r.net
    acc.refunds += r.refunds
    acc.invoices += r.invoiceCount
    acc.bookingRevenue += r.bookingRevenue
    acc.foodRevenue += r.foodRevenue
    acc.membershipRevenue += r.membershipRevenue
    acc.serviceChargeRevenue += r.serviceChargeRevenue
    revenueByDay.set(r.day, acc)
  }

  const bookingsByDay = new Map(bookings.daily.map((d) => [d.day, d]))

  const days: DashboardDay[] = eachDay(range).map((day) => {
    const rev = revenueByDay.get(day)
    const bk = bookingsByDay.get(day)
    return {
      day,
      gross: round2(rev?.gross ?? 0),
      discount: round2(rev?.discount ?? 0),
      tax: round2(rev?.tax ?? 0),
      serviceCharge: round2(rev?.serviceCharge ?? 0),
      net: round2(rev?.net ?? 0),
      refunds: round2(rev?.refunds ?? 0),
      invoices: rev?.invoices ?? 0,
      bookingRevenue: round2(rev?.bookingRevenue ?? 0),
      foodRevenue: round2(rev?.foodRevenue ?? 0),
      membershipRevenue: round2(rev?.membershipRevenue ?? 0),
      serviceChargeRevenue: round2(rev?.serviceChargeRevenue ?? 0),
      bookings: bk?.bookings ?? 0,
      bookedMinutes: bk?.bookedMinutes ?? 0,
      availableMinutes: bk?.availableMinutes ?? 0,
      occupancyPercent: bk?.occupancyPercent ?? null,
    }
  })

  return {
    range,
    days,
    revenueTotals: sumDailyRevenue(revenueByBranch),
    bookings,
    revenueByBranch,
  }
}

/**
 * The daily export: one row per day, revenue and bookings side by side — the
 * table on screen, in a spreadsheet.
 *
 * Money at 2dp and occupancy at 1dp are written as bare numbers so a
 * spreadsheet reads them as numbers; an occupancy of `null` (branch shut, or no
 * bookable resource) exports as an EMPTY cell rather than 0, because a closed
 * day is not a day with zero occupancy and averaging those together would be
 * wrong.
 */
export const DASHBOARD_CSV_COLUMNS: readonly CsvColumn<DashboardDay>[] = [
  { header: 'Date', value: (d) => d.day },
  { header: 'Invoices', value: (d) => d.invoices },
  { header: 'Gross', value: (d) => d.gross.toFixed(2) },
  { header: 'Discount', value: (d) => d.discount.toFixed(2) },
  { header: 'Tax', value: (d) => d.tax.toFixed(2) },
  { header: 'Service charge', value: (d) => d.serviceCharge.toFixed(2) },
  { header: 'Refunds', value: (d) => d.refunds.toFixed(2) },
  { header: 'Net', value: (d) => d.net.toFixed(2) },
  { header: 'Bookings', value: (d) => d.bookings },
  { header: 'Booked minutes', value: (d) => d.bookedMinutes },
  { header: 'Available minutes', value: (d) => d.availableMinutes },
  { header: 'Occupancy %', value: (d) => (d.occupancyPercent === null ? null : d.occupancyPercent.toFixed(1)) },
]

/** Resource usage as its own export — a different grain, so a separate file. */
export const RESOURCE_USAGE_CSV_COLUMNS: readonly CsvColumn<BookingMetrics['topResources'][number]>[] = [
  { header: 'Resource', value: (r) => r.resourceName },
  { header: 'Type', value: (r) => r.resourceTypeName },
  { header: 'Bookings', value: (r) => r.bookings },
  { header: 'Slots', value: (r) => r.slots },
  { header: 'Booked minutes', value: (r) => r.minutes },
]

/** The dashboard as CSV text, built with the shared AROS-64 helper. */
export function dashboardCsv(data: RevenueDashboard): string {
  return toCsv(data.days, DASHBOARD_CSV_COLUMNS)
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
