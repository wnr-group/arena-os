/**
 * Calendar arithmetic shared across modules.
 *
 * No `server-only`: this is pure date maths with no database or request
 * dependency, and both server code and a future client component may need it.
 */

/**
 * Add whole months to an instant, clamping the day of month.
 *
 * 31 Jan + 1 month is 28 Feb, not 3 March: `setMonth` alone would roll over
 * into the next month, because JavaScript resolves an impossible date (31 Feb)
 * forward rather than refusing it. Someone whose period starts on the 31st
 * should get the last day of the target month.
 *
 * The overflow is not a rare edge: seven months have 31 days, so any period
 * starting on the 31st and landing on a 30-day month gains a day and crosses
 * into the next calendar month. Everywhere this is used — a membership's
 * expiry, a subscription's `current_period_end` — that date decides when access
 * ends, so the extra day is not cosmetic.
 *
 * UTC throughout, deliberately. These are instants stored in `timestamptz`, and
 * doing the arithmetic in the server's local zone would make the result depend
 * on where the process happens to run.
 */
export function addMonths(from: Date, months: number): Date {
  const d = new Date(from.getTime())
  const targetMonth = d.getUTCMonth() + months
  const dayOfMonth = d.getUTCDate()

  // Park on the 1st before moving the month, so the month shift itself can
  // never overflow; the day is restored (clamped) immediately after.
  d.setUTCDate(1)
  d.setUTCMonth(targetMonth)

  // Day 0 of the FOLLOWING month is the last day of the one we landed in.
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()
  d.setUTCDate(Math.min(dayOfMonth, lastDay))
  return d
}
