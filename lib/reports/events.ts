import 'server-only'
import { sql } from 'drizzle-orm'
import { withUser } from '@/db'
import type { ActiveContext } from '@/lib/tenant/context'
import { isManager } from '@/lib/auth/roles'
import { ReportAccessError } from './daily-revenue'
import type { DateRange } from './date-range'
import { round2 } from '@/lib/billing/pricing'

/**
 * THE EVENTS REPORT (M15 #8) — attendance and entry-fee revenue per event.
 *
 * Built on the M6 reporting layer, not beside it: same DateRange, same
 * ReportAccessError, same `module.reports` entitlement gate, same
 * aggregate-in-Postgres discipline, same CSV helpers at the page. There is no
 * second reporting architecture here.
 *
 * ══ WHAT COUNTS AS A REGISTRANT ═════════════════════════════════════════════
 *
 *   registered  status in ('registered', 'checked_in') — the CONFIRMED set: a
 *               place is held and, for a paid event, the money has arrived.
 *               This is the same set getEventCheckInCounts() calls `confirmed`,
 *               so the report and the check-in desk cannot disagree.
 *
 *               Deliberately NOT included: `waitlisted` (never had a place),
 *               `cancelled` (gave it back) and `pending_payment` (holding a
 *               place while an unpaid window runs — counting it would tell a
 *               manager more people are coming than are).
 *
 *   checkedIn   status = 'checked_in'. Arrived.
 *
 *   attendance  checkedIn ÷ registered, as a PERCENT. Null — never 0 and never
 *               NaN — when nobody registered. A rate over nothing is undefined,
 *               and rendering "0% attendance" for an event nobody entered would
 *               be a lie in the unflattering direction. The divide-by-zero the
 *               ticket asks about is answered by not dividing.
 *
 * ══ REVENUE IS MONEY THE GATEWAY CONFIRMED ═════════════════════════════════
 *
 * `sum(paid_amount) where payment_reference is not null`.
 *
 * `paid_amount` is written ONLY by confirm_event_registration_payment() from a
 * signature-verified Razorpay webhook (0092) — never by a browser, never by the
 * registration form. Migration 0091's `event_registrations_paid` CHECK makes
 * that structural: `paid_amount = 0 or payment_reference is not null`, so an
 * amount without a verified reference cannot exist as a row. The predicate here
 * is therefore belt-and-braces on a guarantee the database already holds, and
 * it states the intent at the query so a reader does not have to go and check.
 *
 * A free event contributes 0, correctly: nobody paid anything.
 *
 * ── Money that may have to go back is reported SEPARATELY ───────────────────
 *
 * A registration cancelled after payment carries `refund_required` (0091) —
 * this codebase never auto-refunds. Folding it into revenue would overstate
 * what the venue kept; dropping it would hide money that was actually taken.
 * So it is counted in `refundDue` beside the revenue figure, and the page shows
 * it when it is non-zero.
 */

/** Manager or owner, the same rule every other report in this module applies. */
function requireReportAccess(ctx: ActiveContext): void {
  if (!isManager(ctx.role)) {
    throw new ReportAccessError('Only owners and managers can view reports.')
  }
}

export type EventReportRow = {
  eventId: string
  title: string
  /** The event's LOCAL calendar date, `YYYY-MM-DD`. */
  date: string
  type: string
  status: string
  /** Set when this occurrence came from a recurring series (M15 #8). */
  seriesId: string | null
  registered: number
  checkedIn: number
  /** checkedIn ÷ registered as a percent. Null when nobody registered. */
  attendanceRate: number | null
  /** Verified, gateway-confirmed entry fees. */
  revenue: number
  /** Paid, then cancelled — money that may have to go back. Never in `revenue`. */
  refundDue: number
}

export type EventReport = {
  range: DateRange
  rows: EventReportRow[]
  totals: {
    events: number
    registered: number
    checkedIn: number
    /** Overall checkedIn ÷ registered. Null when nothing was registered. */
    attendanceRate: number | null
    revenue: number
    refundDue: number
  }
  /** Up to five events by registrations, then attendance. Empty when there are none. */
  mostPopular: EventReportRow[]
}

/**
 * Attendance and revenue for every event STARTING in the range.
 *
 * ── One query, aggregated in Postgres ───────────────────────────────────────
 *
 * A left join to a grouped subquery, not a query per event. A venue with two
 * hundred classes in a quarter is one round trip, and the counts come back
 * already summed — the same shape lib/reports/sales.ts and lib/reports/pnl.ts
 * use.
 *
 * The range is compared against the event's LOCAL date, converted with `at time
 * zone` from the tenant's own zone, so "August" means the venue's August rather
 * than UTC's. That is the same conversion the rest of the reporting layer makes
 * and the reason no timezone arithmetic happens in JavaScript here.
 */
export async function getEventReport(ctx: ActiveContext, range: DateRange): Promise<EventReport> {
  requireReportAccess(ctx)

  const tz = ctx.tenant.timezone

  const rows = await withUser(ctx.user.id, async (tx) => {
    const res = await tx.execute<{
      event_id: string
      title: string
      date: string
      type: string
      status: string
      series_id: string | null
      registered: string | number
      checked_in: string | number
      revenue: string | null
      refund_due: string | null
    }>(sql`
      select e.id                                        as event_id,
             e.title,
             ((e.starts_at at time zone ${tz})::date)::text as date,
             e.type::text                                as type,
             e.status::text                              as status,
             e.series_id,
             coalesce(r.registered, 0)                   as registered,
             coalesce(r.checked_in, 0)                   as checked_in,
             coalesce(r.revenue, 0)                      as revenue,
             coalesce(r.refund_due, 0)                   as refund_due
        from public.events e
        left join (
          select er.event_id,
                 count(*) filter (
                   where er.status in ('registered', 'checked_in')
                 )                                                   as registered,
                 count(*) filter (where er.status = 'checked_in')    as checked_in,
                 -- Verified money only. See the header: paid_amount cannot be
                 -- non-zero without a webhook-written payment_reference.
                 sum(er.paid_amount) filter (
                   where er.payment_reference is not null
                     and er.status <> 'cancelled'
                 )                                                   as revenue,
                 sum(er.paid_amount) filter (
                   where er.payment_reference is not null
                     and er.status = 'cancelled'
                 )                                                   as refund_due
            from public.event_registrations er
           where er.tenant_id = ${ctx.tenant.id}
           group by er.event_id
        ) r on r.event_id = e.id
       where e.tenant_id = ${ctx.tenant.id}
         and (e.starts_at at time zone ${tz})::date >= ${range.start}::date
         and (e.starts_at at time zone ${tz})::date <= ${range.end}::date
       order by e.starts_at desc, e.title asc
    `)
    return res.rows
  })

  const num = (v: string | number | null | undefined): number => {
    const n = typeof v === 'number' ? v : Number(v ?? 0)
    return Number.isFinite(n) ? n : 0
  }

  const mapped: EventReportRow[] = rows.map((r) => {
    const registered = num(r.registered)
    const checkedIn = num(r.checked_in)
    return {
      eventId: r.event_id,
      title: r.title,
      date: r.date,
      type: r.type,
      status: r.status,
      seriesId: r.series_id,
      registered,
      checkedIn,
      // Null, not 0 — see the header.
      attendanceRate: registered > 0 ? round2((checkedIn / registered) * 100) : null,
      revenue: round2(num(r.revenue)),
      refundDue: round2(num(r.refund_due)),
    }
  })

  const totals = mapped.reduce(
    (acc, r) => ({
      events: acc.events + 1,
      registered: acc.registered + r.registered,
      checkedIn: acc.checkedIn + r.checkedIn,
      attendanceRate: null as number | null,
      revenue: round2(acc.revenue + r.revenue),
      refundDue: round2(acc.refundDue + r.refundDue),
    }),
    { events: 0, registered: 0, checkedIn: 0, attendanceRate: null as number | null, revenue: 0, refundDue: 0 },
  )
  // Computed from the TOTALS, not averaged from the per-event rates: a class
  // with two entrants and one with two hundred must not count equally.
  totals.attendanceRate =
    totals.registered > 0 ? round2((totals.checkedIn / totals.registered) * 100) : null

  // Most popular by registrations, then by who actually turned up, then by
  // title so the order is total and two identical events do not swap places
  // between page loads.
  const mostPopular = [...mapped]
    .filter((r) => r.registered > 0)
    .sort(
      (a, b) =>
        b.registered - a.registered ||
        b.checkedIn - a.checkedIn ||
        (a.title < b.title ? -1 : a.title > b.title ? 1 : 0),
    )
    .slice(0, 5)

  return { range, rows: mapped, totals, mostPopular }
}
