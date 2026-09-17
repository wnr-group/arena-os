/**
 * priceElapsedTime — the money core of a walk-in session (M21 #2).
 *
 * A reserved booking is priced once, up front, from a fixed start/end (see
 * lib/booking/service.ts's priceBookingSlots). A walk-in's open tab isn't
 * known until checkout: the only inputs are "when did it start" and "when
 * did it end", so the elapsed time itself has to be turned into a price,
 * honouring the SAME per-segment happy-hour behaviour a reserved booking
 * would get if it happened to straddle a happy-hour boundary.
 *
 * Pure (no DB, no 'server-only') so it's directly unit-testable — every
 * caller resolves the resource's rate and the tenant's happy-hour rows
 * itself and simply hands them in. Its output is one BillLine; tax and
 * discount are NOT this function's job — they ride the existing priceBill
 * path (lib/billing/pricing.ts) exactly like every other line.
 *
 * ── the algorithm ────────────────────────────────────────────────────────
 * 1. elapsedMinutes = end − start.
 * 2. billableMinutes = max(30, ceil to the next 15) — the 30-min minimum and
 *    15-min round-up apply to TIME, never to money: rounding a segment's
 *    money instead of its minutes would silently overcharge/undercharge
 *    whichever happy-hour segment happened to sit at the rounded edge.
 * 3. Walk [start, billableEnd) as a sequence of segments, split at every
 *    happy-hour rule's own start/end that falls strictly inside the window
 *    — those are exactly the instants the effective rate can change. Price
 *    each segment at (minutes / 60) × the rate in force for that segment
 *    (the resource rate, or the resource rate net of the biggest-discount
 *    happy-hour rule active at that instant — same tie-break as
 *    applyHappyHour).
 * 4. Sum the UNROUNDED segment prices, then round2 exactly once at the end.
 *    Rounding each segment first would drift from what a reserved booking
 *    covering the same window and rate would total — round2 is for MONEY,
 *    applied once, at the boundary where a number becomes a rupee figure.
 */
import { round2, type BillLine } from './pricing'
import { discountAmount, type HappyHourRule } from '@/lib/happy-hours/apply'
import { todayInZone, weekdayInZone, zonedTimeToUtc, formatTimeInZone, addDays } from '@/lib/booking/time'

const MINUTE_MS = 60_000
const ROUND_TO_MINUTES = 15
const MIN_BILLABLE_MINUTES = 30

/** Round `minutes` UP to the next multiple of `step`. */
function ceilToStep(minutes: number, step: number): number {
  return Math.ceil(minutes / step) * step
}

/**
 * `rule`'s [start, end) as absolute instants (ms) on one local calendar
 * date, or null if the rule doesn't run that day. Overnight windows
 * (end <= start) aren't supported here — same scope limit activeHappyHours
 * already has via its plain string comparison.
 */
function ruleWindowOnDate(
  rule: HappyHourRule,
  dateStr: string,
  tenantTimezone: string,
): { startsAt: number; endsAt: number } | null {
  if (!rule.isActive) return null
  if (!rule.daysOfWeek.includes(weekdayInZone(dateStr, tenantTimezone))) return null
  const startTime = rule.startTime.slice(0, 5)
  const endTime = rule.endTime.slice(0, 5)
  if (endTime <= startTime) return null
  return {
    startsAt: zonedTimeToUtc(dateStr, startTime, tenantTimezone).getTime(),
    endsAt: zonedTimeToUtc(dateStr, endTime, tenantTimezone).getTime(),
  }
}

/**
 * The rule in force at `instantMs`, or null. Half-open per rule window
 * ([start, end)): the rate reverts exactly AT a rule's end time, matching
 * how the worked example (a session crossing a happy hour's own end)
 * prices — deliberately NOT the end-inclusive-to-the-minute reading
 * activeHappyHours uses for a single point-in-time order (a different,
 * separately-documented concern there).
 */
function ruleActiveAt(
  instantMs: number,
  rules: HappyHourRule[],
  rate: number,
  tenantTimezone: string,
): HappyHourRule | null {
  const dateStr = todayInZone(tenantTimezone, new Date(instantMs))
  const live = rules.filter((r) => {
    const w = ruleWindowOnDate(r, dateStr, tenantTimezone)
    return w !== null && instantMs >= w.startsAt && instantMs < w.endsAt
  })
  if (live.length === 0) return null
  // Biggest discount wins — the same deterministic tie-break applyHappyHour
  // uses when more than one rule is live at once.
  return live.reduce((a, b) => (discountAmount(rate, b) > discountAmount(rate, a) ? b : a))
}

/**
 * Price an elapsed-time session (a walk-in's open tab, or any start→end
 * window on an hourly resource) into a single `kind: 'booking'` BillLine.
 *
 * `taxPercent` is left at 0 — the caller snapshots the resource type's own
 * tax rate onto the line, same as lib/billing/invoice.ts's loadBookingLines
 * does for a reserved booking.
 */
export function priceElapsedTime(
  start: Date,
  end: Date,
  rate: number,
  happyHours: HappyHourRule[],
  tenantTimezone: string,
): BillLine {
  const elapsedMinutes = Math.max(0, (end.getTime() - start.getTime()) / MINUTE_MS)
  const billableMinutes = Math.max(MIN_BILLABLE_MINUTES, ceilToStep(elapsedMinutes, ROUND_TO_MINUTES))
  const startMs = start.getTime()
  const billableEndMs = startMs + billableMinutes * MINUTE_MS

  // Segment boundaries: the window's own edges, plus every happy-hour rule
  // edge that falls strictly inside it — the only instants the effective
  // rate can change.
  const boundaries = new Set<number>([startMs, billableEndMs])
  const lastDate = todayInZone(tenantTimezone, new Date(billableEndMs))
  for (let d = todayInZone(tenantTimezone, start); ; d = addDays(d, 1)) {
    for (const rule of happyHours) {
      const w = ruleWindowOnDate(rule, d, tenantTimezone)
      if (!w) continue
      if (w.startsAt > startMs && w.startsAt < billableEndMs) boundaries.add(w.startsAt)
      if (w.endsAt > startMs && w.endsAt < billableEndMs) boundaries.add(w.endsAt)
    }
    if (d === lastDate) break
  }
  const sorted = [...boundaries].sort((a, b) => a - b)

  let total = 0
  for (let i = 0; i < sorted.length - 1; i++) {
    const segStartMs = sorted[i]
    const segEndMs = sorted[i + 1]
    const minutes = (segEndMs - segStartMs) / MINUTE_MS
    if (minutes <= 0) continue
    const active = ruleActiveAt(segStartMs, happyHours, rate, tenantTimezone)
    const effectiveRate = active ? Math.max(0, rate - discountAmount(rate, active)) : rate
    total += (minutes / 60) * effectiveRate
  }

  const billableEnd = new Date(billableEndMs)
  return {
    description: `${formatTimeInZone(start, tenantTimezone)}–${formatTimeInZone(billableEnd, tenantTimezone)}`,
    kind: 'booking',
    qty: 1,
    unitPrice: round2(total),
    taxPercent: 0,
  }
}
