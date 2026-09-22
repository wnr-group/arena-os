/**
 * Weekday/weekend base-rate resolution (M22 #2) — the one place that decides
 * "is this session a weekend session" and "what does that mean for the
 * rate," shared by priceBookingSlots (lib/booking/service.ts, reserved) and
 * startWalkinCore (lib/booking/walkin.ts, walk-in), so the two engines can
 * never resolve it differently.
 *
 * Pure (no DB, no 'server-only') — the caller resolves weekdayRate/
 * weekendRate/weekendDays itself (a plain DB read) and hands them in, same
 * discipline as lib/billing/elapsed-time.ts's priceElapsedTime.
 */
import { todayInZone, weekdayInZone } from './time'

/**
 * Whether `at` falls on a day this tenant treats as weekend, per its
 * business_profiles.weekend_days set (0=Sun...6=Sat, JS getDay convention).
 */
export function isWeekendDay(at: Date, timezone: string, weekendDays: number[]): boolean {
  return weekendDays.includes(weekdayInZone(todayInZone(timezone, at), timezone))
}

/**
 * The base hourly rate in force for a session starting at `at` (M22 #2):
 * `weekdayRate` (resource override ?? type rate — resolved by the caller)
 * on a weekday, `weekendRate` on a weekend day — falling back to
 * `weekdayRate` when `weekendRate` is null (no weekend pricing configured,
 * so weekend prices identically to weekday). The WHOLE session uses the
 * rate for the day it STARTED, never split mid-session.
 */
export function resolveDayRate(
  weekdayRate: number,
  weekendRate: number | null,
  at: Date,
  timezone: string,
  weekendDays: number[],
): number {
  if (!isWeekendDay(at, timezone, weekendDays)) return weekdayRate
  return weekendRate ?? weekdayRate
}
