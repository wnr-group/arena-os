/**
 * Event date/time presentation, in the TENANT'S timezone.
 *
 * Pure and dependency-free so the manager screen (a client component holding
 * ISO strings) and the public pages (server components holding Dates) share one
 * implementation instead of each rolling its own — which is how a venue ends up
 * seeing an event at 18:30 on one screen and 13:00 on another.
 *
 * `starts_at`/`ends_at` are timestamptz: one true instant. The venue's timezone
 * is presentation only, and it is always passed explicitly rather than read
 * from the server's own clock — the server may be anywhere.
 */

function toDate(v: Date | string): Date {
  return v instanceof Date ? v : new Date(v)
}

/** `2 Oct 2026, 6:30 pm` — one instant in the tenant's zone. */
export function formatEventDateTime(v: Date | string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-IN', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone,
  }).format(toDate(v))
}

/** `2 Oct 2026` — date only, for headings and grouping. */
export function formatEventDate(v: Date | string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-IN', { dateStyle: 'full', timeZone }).format(toDate(v))
}

/** `6:30 pm` — time only. */
export function formatEventTime(v: Date | string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-IN', { timeStyle: 'short', timeZone }).format(toDate(v))
}

/**
 * The window as one line. Collapses to a single date when both ends fall on the
 * same day in the tenant's zone — `2 Oct 2026, 6:30 pm – 9:00 pm` rather than
 * repeating the date twice — and spells both out when the event spans midnight.
 *
 * Same-day is decided by comparing the formatted date IN THAT ZONE, not by UTC
 * arithmetic: an event running 23:00–01:00 IST is two UTC dates but one evening
 * to the customer, and vice versa.
 */
export function formatEventWindow(
  startsAt: Date | string,
  endsAt: Date | string,
  timeZone: string,
): string {
  const start = toDate(startsAt)
  const end = toDate(endsAt)
  const dayFmt = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeZone })
  const sameDay = dayFmt.format(start) === dayFmt.format(end)

  if (sameDay) {
    return `${dayFmt.format(start)}, ${formatEventTime(start, timeZone)} – ${formatEventTime(end, timeZone)}`
  }
  return `${formatEventDateTime(start, timeZone)} – ${formatEventDateTime(end, timeZone)}`
}
