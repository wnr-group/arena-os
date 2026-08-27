export function formatMoney(amount: number | string, currency = 'INR'): string {
  const n = typeof amount === 'string' ? Number(amount) : amount
  try {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency,
      maximumFractionDigits: 2,
    }).format(n)
  } catch {
    return `${currency} ${n.toFixed(2)}`
  }
}

export function timeInZone(iso: string | Date, timeZone: string): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d)
}

/** 'YYYY-MM' → 'August 2026'. UTC throughout — a calendar month has no timezone of its own. */
export function formatPayrollPeriod(period: string): string {
  const [year, month] = period.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

/** 'YYYY-MM' shifted by `delta` calendar months (negative moves back). UTC — a month has no timezone. */
export function shiftPayrollPeriod(period: string, delta: number): string {
  const [year, month] = period.split('-').map(Number)
  const d = new Date(Date.UTC(year, month - 1 + delta, 1))
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

/**
 * Render a plain calendar date — 'YYYY-MM-DD' — as 'Fri, 28 Aug 2026'.
 *
 * ── The input has NO timezone, and that is the whole point ──────────────────
 *
 * Every caller passes a date that is already resolved to the right calendar:
 * `todayInZone(tz, instant)` for a timestamptz, or a plain `date` column
 * (customers.dob, expenses.spent_on, a roster day). By the time it arrives here
 * the question "which day was that in the venue's zone?" has already been
 * answered. This function only has to word it.
 *
 * ── Why it used to be wrong at UTC+12 and beyond ────────────────────────────
 *
 * It built the date at 12:00 UTC and formatted THAT INSTANT in the caller's
 * timezone. Noon is a safe anchor for any offset within ±11 hours, but it is
 * not safe further out: 2026-08-28T12:00Z is already 2026-08-29T00:00 in
 * Pacific/Auckland (UTC+12), so a venue there saw every date rendered one day
 * late — and Pacific/Kiritimati (UTC+14) the same. Sydney, Tokyo, Kolkata and
 * everything westward were unaffected, which is why it survived this long.
 *
 * The fix is not a bigger anchor — there isn't one that works for both ends of
 * the range. It is to stop converting at all: build the date at UTC midnight
 * and format it in UTC, so the calendar date that came in is the calendar date
 * that goes out, at every offset from UTC-12 to UTC+14.
 *
 * `_timeZone` is accepted and deliberately ignored. Roughly twenty call sites
 * pass it, and several read better for saying which venue the date belongs to
 * (`prettyDate(todayInZone(tz, d), tz)`); keeping the parameter avoids touching
 * all of them for a change that must not alter behaviour anywhere else. It is
 * optional so new callers need not pass anything.
 */
export function prettyDate(dateStr: string, _timeZone?: string): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date(Date.UTC(y, m - 1, d)))
}
