import 'server-only'
import { sql } from 'drizzle-orm'
import { withUser } from '@/db'
import type { ActiveContext } from '@/lib/tenant/context'
import { isManager } from '@/lib/auth/roles'
import { ReportAccessError } from './daily-revenue'
import type { DateRange } from './date-range'

/**
 * Booking-side metrics for the Revenue & Bookings dashboard (AROS-65): booking
 * counts, occupancy, peak hours and resource usage. Revenue itself comes from
 * the AROS-64 reader (./daily-revenue.ts) — this module deliberately adds no
 * second revenue path.
 *
 * Every figure is aggregated IN POSTGRES. Nothing here pulls slots into JS to
 * add them up: a busy venue-year is ~10⁵ slots, and the database can group them
 * far better than a loop can.
 *
 * ── THE RULES, ALL TAKEN FROM THE SCHEMA (none invented) ────────────────────
 *
 * WHAT COUNTS AS OCCUPYING A RESOURCE. `booking_slots.active`, which migration
 * 0003 keeps in lockstep with the booking lifecycle by trigger:
 *
 *     active = (booking.status not in ('cancelled','no_show'))
 *
 * so confirmed / checked_in / completed hold their time and cancellations and
 * no-shows release it. That single flag is the project's own definition of "is
 * this time really taken", it is what the no-overlap exclusion constraint keys
 * on, and it is what every metric below filters by. The booking status is
 * re-checked alongside it — redundant while the trigger holds, but it states
 * the rule in the query rather than leaving it implicit.
 *
 * WHICH DAY A BOOKING BELONGS TO. The local day its FIRST active slot starts —
 * i.e. the day the guest is coming in, not the day the booking was taken. That
 * keeps the four booking metrics on this page mutually consistent (a day with
 * 12 bookings cannot show 0% occupancy). It differs on purpose from
 * lib/reports/employees.ts, which counts bookings by `created_at` because it is
 * measuring STAFF ACTIVITY. A booking is counted ONCE, on that first day, even
 * if it runs past midnight.
 *
 * TIMEZONE. Every bucket is the BRANCH's local day/hour —
 * `coalesce(branches.timezone, tenants.timezone)` — the same rule
 * mv_daily_revenue uses (0032), so a revenue day and a bookings day mean the
 * same thing. The server's zone is never involved.
 *
 * RETIRED RESOURCES — and why two metrics treat them differently. `resources.
 * status` is CURRENT state with no history, so a station retired today has
 * always-been-retired as far as any past day is concerned. That forces a split,
 * and it is deliberate:
 *
 *   * COUNTS (bookings, peak hours, resource usage) include every active slot,
 *     whatever the resource's status today. Those guests really did come, and a
 *     booking count that silently shrank when someone retired a console would
 *     not reconcile with the booking rows it is supposed to summarise.
 *   * OCCUPANCY excludes `status = 'inactive'` from the numerator AND the
 *     denominator. Capacity means what the venue can sell today; counting a
 *     retired station's bookings against capacity that no longer includes it
 *     would let occupancy exceed 100%.
 *
 * So a day can read "4 bookings, 16.7% occupancy" where one booking sat on a
 * since-retired resource. That is the honest pair of answers to two different
 * questions, not a discrepancy — and the alternative (dropping the booking
 * everywhere) would misreport history.
 *
 * OVERNIGHT BOOKINGS. Slots are `tstzrange`-shaped instants and may cross
 * midnight. Occupancy clips each slot to the day's opening window
 * (`least(ends_at, closes_at) - greatest(starts_at, opens_at)`), so a
 * 22:00–02:00 booking contributes its real minutes to each day it touches and
 * is never double-counted. Working hours themselves cannot cross midnight —
 * `check (is_closed or close_time > open_time)` in 0003 — so a day's window is
 * always one contiguous span.
 */

export type DailyBookingRow = {
  /** `YYYY-MM-DD`, the branch-local day. */
  day: string
  /** Bookings whose first active slot starts on this day. */
  bookings: number
  /** Active slot time inside the day's opening window. */
  bookedMinutes: number
  /** Bookable resources × opening hours, summed over branches. */
  availableMinutes: number
  /** bookedMinutes / availableMinutes × 100, or null when nothing was open. */
  occupancyPercent: number | null
}

export type PeakHourRow = {
  /** Hour of the branch-local day, 0–23. */
  hour: number
  /** Bookings whose slot STARTS in this hour (see peakHours below). */
  bookings: number
  slots: number
}

export type ResourceUsageRow = {
  resourceId: string
  resourceName: string
  resourceTypeName: string
  /** Booked minutes inside the range — the ranking measure. */
  minutes: number
  bookings: number
  slots: number
}

export type BookingMetrics = {
  daily: DailyBookingRow[]
  peakHours: PeakHourRow[]
  topResources: ResourceUsageRow[]
  totals: {
    bookings: number
    bookedMinutes: number
    availableMinutes: number
    /** Period occupancy = Σbooked / Σavailable — NOT the mean of daily rates,
     *  which would weight a quiet Monday the same as a full Saturday. */
    occupancyPercent: number | null
    /** The busiest hour, or null when nothing was booked in the range. */
    peakHour: number | null
    mostUsedResource: ResourceUsageRow | null
  }
}

/**
 * Every booking-side metric for `range`, in one RLS-scoped transaction.
 *
 * Four grouped queries rather than one: each answers a different question at a
 * different grain, and a single query would either fan out into wrong sums or
 * need window functions to undo the fan-out. They share one transaction, so
 * they see one consistent snapshot.
 *
 * Authorization mirrors getDailyRevenue(): owner/manager only, thrown from the
 * data layer so a hand-crafted request cannot reach the figures by skipping the
 * page guard.
 */
export async function getBookingMetrics(
  ctx: ActiveContext,
  options: { range: DateRange; branchId?: string | null },
): Promise<BookingMetrics> {
  if (!isManager(ctx.role)) {
    throw new ReportAccessError('Only owners and managers can view reports.')
  }

  const { range, branchId } = options
  const tenantId = ctx.tenant.id
  const start = range.start
  // Inclusive end, per lib/reports/date-range.ts. Where an instant window is
  // needed it becomes [start 00:00, end+1 00:00) — half-open, so the final day
  // is whole and no second is lost.
  const end = range.end
  const branchFilter = branchId ? sql`and b.id = ${branchId}` : sql``

  return withUser(ctx.user.id, async (tx) => {
    // ── 1. occupancy + capacity, per local day ───────────────────────────────
    //
    //                     Σ active slot-minutes inside opening hours
    //   occupancy(day) = ───────────────────────────────────────────── × 100
    //                     Σ (bookable resources × opening minutes)
    //
    // Numerator and denominator are restricted to the SAME resource set
    // (status <> 'inactive'), so occupancy can never exceed 100% by counting a
    // booking on a resource that is no longer part of capacity.
    const occupancy = await tx.execute(sql`
      with days as (
        select gs::date as day
          from generate_series(${start}::date, ${end}::date, interval '1 day') gs
      ),
      -- One row per (branch, open day): the exact instants the branch trades
      -- between, resolved in the branch's own timezone.
      windows as (
        select b.id as branch_id,
               d.day,
               (d.day + wh.open_time)  at time zone coalesce(b.timezone, t.timezone) as opens_at,
               (d.day + wh.close_time) at time zone coalesce(b.timezone, t.timezone) as closes_at
          from days d
          join public.branches b on b.tenant_id = ${tenantId}
          join public.tenants  t on t.id = b.tenant_id
          join public.working_hours wh
            on wh.branch_id = b.id
           and wh.tenant_id = b.tenant_id
           and wh.day_of_week = extract(dow from d.day)::smallint
         where not wh.is_closed
           ${branchFilter}
      ),
      capacity as (
        select w.branch_id, w.day, w.opens_at, w.closes_at,
               (select count(*) from public.resources r
                 where r.tenant_id = ${tenantId}
                   and r.branch_id = w.branch_id
                   and r.status <> 'inactive') as resource_count
          from windows w
      ),
      available as (
        select day,
               sum(resource_count * extract(epoch from (closes_at - opens_at))) as available_seconds
          from capacity
         group by day
      ),
      booked as (
        select c.day,
               sum(extract(epoch from (
                 least(s.ends_at, c.closes_at) - greatest(s.starts_at, c.opens_at)
               ))) as booked_seconds
          from capacity c
          join public.resources r
            on r.branch_id = c.branch_id
           and r.tenant_id = ${tenantId}
           and r.status <> 'inactive'
          join public.booking_slots s
            on s.resource_id = r.id
           and s.tenant_id = ${tenantId}
           and s.active
           -- strict overlap with the open window; touching endpoints are not
           -- occupancy, and this is what clips an overnight booking per day
           and s.starts_at < c.closes_at
           and s.ends_at   > c.opens_at
         group by c.day
      )
      select d.day::text                                        as day,
             coalesce(b.booked_seconds, 0)::float / 60          as booked_minutes,
             coalesce(a.available_seconds, 0)::float / 60       as available_minutes
        from days d
        left join available a on a.day = d.day
        left join booked    b on b.day = d.day
       order by d.day
    `)

    // ── 2. bookings per local day ────────────────────────────────────────────
    // Counted on the day of the booking's FIRST active slot, so a multi-slot or
    // overnight booking is one booking on one day.
    const counts = await tx.execute(sql`
      with first_slot as (
        select s.booking_id, min(s.starts_at) as first_start
          from public.booking_slots s
         where s.tenant_id = ${tenantId}
           and s.active
         group by s.booking_id
      ),
      placed as (
        select ((fs.first_start at time zone coalesce(b.timezone, t.timezone))::date) as day
          from first_slot fs
          join public.bookings bk on bk.id = fs.booking_id and bk.tenant_id = ${tenantId}
          join public.branches b  on b.id = bk.branch_id
          join public.tenants  t  on t.id = bk.tenant_id
         where bk.status not in ('cancelled','no_show')
           ${branchFilter}
      )
      select day::text as day, count(*)::int as bookings
        from placed
       where day between ${start}::date and ${end}::date
       group by day
       order by day
    `)

    // ── 3. peak hours ────────────────────────────────────────────────────────
    // Grouped by the hour a slot STARTS, in branch-local time. A slot longer
    // than an hour is attributed to the hour it begins — the arrival profile,
    // which is what "when are we busiest" is asked for when staffing a shift.
    // (Occupancy above is the measure of time actually consumed.)
    const peak = await tx.execute(sql`
      select extract(hour from (s.starts_at at time zone coalesce(b.timezone, t.timezone)))::int as hour,
             count(distinct s.booking_id)::int as bookings,
             count(*)::int                     as slots
        from public.booking_slots s
        join public.resources r on r.id = s.resource_id and r.tenant_id = ${tenantId}
        join public.branches  b on b.id = r.branch_id
        join public.tenants   t on t.id = b.tenant_id
        join public.bookings bk on bk.id = s.booking_id and bk.tenant_id = ${tenantId}
       where s.tenant_id = ${tenantId}
         and s.active
         and bk.status not in ('cancelled','no_show')
         and ((s.starts_at at time zone coalesce(b.timezone, t.timezone))::date)
             between ${start}::date and ${end}::date
         ${branchFilter}
       group by 1
       order by 1
    `)

    // ── 4. resource usage ────────────────────────────────────────────────────
    // Ranked by BOOKED MINUTES, not by booking count: resources here are hired
    // by the hour (resource_types.hourly_rate), so one four-hour session uses a
    // station far more than two twenty-minute ones. Slot time is clipped to the
    // range window so a booking straddling the edge contributes only the part
    // inside it.
    const usage = await tx.execute(sql`
      with win as (
        select b.id as branch_id,
               (${start}::date)::timestamp       at time zone coalesce(b.timezone, t.timezone) as range_start,
               (${end}::date + 1)::timestamp     at time zone coalesce(b.timezone, t.timezone) as range_end
          from public.branches b
          join public.tenants  t on t.id = b.tenant_id
         where b.tenant_id = ${tenantId}
           ${branchFilter}
      )
      select r.id::text          as resource_id,
             r.name              as resource_name,
             rt.name             as resource_type_name,
             sum(extract(epoch from (
               least(s.ends_at, w.range_end) - greatest(s.starts_at, w.range_start)
             )))::float / 60     as minutes,
             count(distinct s.booking_id)::int as bookings,
             count(*)::int                     as slots
        from win w
        join public.resources r  on r.branch_id = w.branch_id and r.tenant_id = ${tenantId}
        join public.resource_types rt on rt.id = r.resource_type_id
        join public.booking_slots s
          on s.resource_id = r.id
         and s.tenant_id = ${tenantId}
         and s.active
         and s.starts_at < w.range_end
         and s.ends_at   > w.range_start
        join public.bookings bk on bk.id = s.booking_id and bk.tenant_id = ${tenantId}
       where bk.status not in ('cancelled','no_show')
       group by r.id, r.name, rt.name
       order by minutes desc, r.name
    `)

    const daily: DailyBookingRow[] = (occupancy.rows as OccupancyRow[]).map((r) => {
      const bookedMinutes = round1(Number(r.booked_minutes))
      const availableMinutes = round1(Number(r.available_minutes))
      const bookingsForDay = (counts.rows as CountRow[]).find((c) => c.day === r.day)
      return {
        day: r.day,
        bookings: bookingsForDay ? Number(bookingsForDay.bookings) : 0,
        bookedMinutes,
        availableMinutes,
        // Null, never 0 and never a division error, when the branch was shut or
        // had no bookable resource: "no data" and "nobody came" are different
        // facts and the UI shows them differently.
        occupancyPercent: availableMinutes > 0 ? round1((bookedMinutes / availableMinutes) * 100) : null,
      }
    })

    const peakHours: PeakHourRow[] = (peak.rows as PeakRow[]).map((r) => ({
      hour: Number(r.hour),
      bookings: Number(r.bookings),
      slots: Number(r.slots),
    }))

    const topResources: ResourceUsageRow[] = (usage.rows as UsageRow[]).map((r) => ({
      resourceId: r.resource_id,
      resourceName: r.resource_name,
      resourceTypeName: r.resource_type_name,
      minutes: round1(Number(r.minutes)),
      bookings: Number(r.bookings),
      slots: Number(r.slots),
    }))

    const bookedMinutes = round1(daily.reduce((n, d) => n + d.bookedMinutes, 0))
    const availableMinutes = round1(daily.reduce((n, d) => n + d.availableMinutes, 0))
    // Strict `>`, over hours already ordered ascending, so a tie resolves to
    // the EARLIEST hour — deterministic, and the more useful answer when
    // staffing (open earlier rather than later).
    const busiest = peakHours.reduce<PeakHourRow | null>(
      (best, h) => (best === null || h.bookings > best.bookings ? h : best),
      null,
    )

    return {
      daily,
      peakHours,
      topResources,
      totals: {
        bookings: daily.reduce((n, d) => n + d.bookings, 0),
        bookedMinutes,
        availableMinutes,
        occupancyPercent: availableMinutes > 0 ? round1((bookedMinutes / availableMinutes) * 100) : null,
        peakHour: busiest?.hour ?? null,
        // Already ordered by minutes desc in SQL.
        mostUsedResource: topResources[0] ?? null,
      },
    }
  })
}

type OccupancyRow = { day: string; booked_minutes: number | string; available_minutes: number | string }
type CountRow = { day: string; bookings: number | string }
type PeakRow = { hour: number | string; bookings: number | string; slots: number | string }
type UsageRow = {
  resource_id: string
  resource_name: string
  resource_type_name: string
  minutes: number | string
  bookings: number | string
  slots: number | string
}

/** Minutes and percentages to 1dp — enough for a dashboard, and it keeps the
 *  float noise of an epoch division out of the UI. */
function round1(n: number): number {
  return Math.round(n * 10) / 10
}
