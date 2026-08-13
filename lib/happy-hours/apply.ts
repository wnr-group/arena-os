/**
 * Applying a happy-hour rule to a price. Pure and server-only-agnostic (no DB,
 * no 'server-only' import) so it can be unit tested directly.
 */
import { round2 } from '@/lib/billing/pricing'
import { todayInZone, weekdayInZone, formatTimeInZone } from '@/lib/booking/time'

export type HappyHourRule = {
  id: string
  name: string
  daysOfWeek: number[]
  /** `HH:mm` or `HH:mm:ss`, as stored in the `time` column. */
  startTime: string
  endTime: string
  discountType: 'percentage' | 'fixed'
  discountValue: string | number
  isActive: boolean
}

export type AppliedHappyHour = {
  unitPrice: number
  originalPrice: number
  rule: HappyHourRule
}

function discountAmount(basePrice: number, rule: HappyHourRule): number {
  const value = Number(rule.discountValue)
  return rule.discountType === 'percentage' ? (basePrice * value) / 100 : value
}

/**
 * Which rules are live right now, in the tenant's timezone.
 *
 * Comparison is done at minute granularity and end-inclusive: a rule running
 * 15:00–18:00 still applies at 18:00 and stops at 18:01, matching how staff
 * read "3–6pm" — a snack ordered at 6:01pm is back to full price.
 */
export function activeHappyHours(rules: HappyHourRule[], now: Date, tenantTimezone: string): HappyHourRule[] {
  const date = todayInZone(tenantTimezone, now)
  const weekday = weekdayInZone(date, tenantTimezone)
  const nowHm = formatTimeInZone(now, tenantTimezone)

  return rules.filter((r) => {
    if (!r.isActive) return false
    if (!r.daysOfWeek.includes(weekday)) return false
    const start = r.startTime.slice(0, 5)
    const end = r.endTime.slice(0, 5)
    return nowHm >= start && nowHm <= end
  })
}

/**
 * Apply the best-matching happy-hour rule to a base price, or `null` if none
 * apply right now. When more than one rule is live at once, the biggest
 * discount wins (deterministic tie-break, per AROS happy-hours ticket) rather
 * than e.g. the first/last rule in list order.
 */
export function applyHappyHour(
  basePrice: number,
  rules: HappyHourRule[],
  now: Date,
  tenantTimezone: string,
): AppliedHappyHour | null {
  const live = activeHappyHours(rules, now, tenantTimezone)
  if (live.length === 0) return null

  const best = live.reduce((a, b) => (discountAmount(basePrice, b) > discountAmount(basePrice, a) ? b : a))
  const unitPrice = Math.max(0, round2(basePrice - discountAmount(basePrice, best)))

  return { unitPrice, originalPrice: basePrice, rule: best }
}
