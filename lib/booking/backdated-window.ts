/**
 * The backdated-entry window, in one place both the server rule
 * (lib/booking/backdated.ts) and the entry form import — no `server-only`, so a
 * client component can use it and the two can never drift apart.
 */

/** How far back a session may be entered. */
export const BACKDATED_MAX_DAYS = 45

/**
 * Whether a local calendar date (YYYY-MM-DD) falls in a month before the current
 * one. Both dates are in the TENANT's calendar (todayInZone), so "previous month"
 * is the venue's, not the server's. Prior-month entries may touch a tax period
 * that is already filed, so the form asks for confirmation and the audit row
 * records the flag.
 */
export function isPriorMonthDate(dateStr: string, todayStr: string): boolean {
  return dateStr.slice(0, 7) < todayStr.slice(0, 7)
}
