/**
 * Timezone helpers. Bookings are stored as absolute `timestamptz`, but staff
 * think in the branch's wall-clock time ("book 2–4pm"). These convert between a
 * local wall time in an IANA timezone and an absolute instant, using only Intl
 * (no dependency). India (the default) has no DST; for zones that do, the
 * one-step offset resolution is accurate except within the ~1h DST transition,
 * which is acceptable for scheduling.
 */

/** Offset (ms) of `timeZone` at the given instant: localWallClock - utc. */
function tzOffsetMs(timeZone: string, date: Date): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  const map: Record<string, number> = {}
  for (const p of dtf.formatToParts(date)) {
    if (p.type !== 'literal') map[p.type] = Number(p.value)
  }
  // Intl renders hour "24" for midnight in some engines; normalise.
  const hour = map.hour === 24 ? 0 : map.hour
  const asUTC = Date.UTC(map.year, map.month - 1, map.day, hour, map.minute, map.second)
  return asUTC - date.getTime()
}

/** Interpret `YYYY-MM-DD` + `HH:mm` as wall time in `timeZone`; return the instant. */
export function zonedTimeToUtc(dateStr: string, timeStr: string, timeZone: string): Date {
  const [y, m, d] = dateStr.split('-').map(Number)
  const [hh, mm] = timeStr.split(':').map(Number)
  const guess = Date.UTC(y, m - 1, d, hh, mm)
  const offset = tzOffsetMs(timeZone, new Date(guess))
  return new Date(guess - offset)
}

/** Day of week (0=Sun..6=Sat) for a `YYYY-MM-DD` string as seen in `timeZone`. */
export function weekdayInZone(dateStr: string, timeZone: string): number {
  // Noon avoids any DST-edge ambiguity when only the date matters.
  const noon = zonedTimeToUtc(dateStr, '12:00', timeZone)
  const wd = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(noon)
  return { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[wd] ?? 0
}

/** Format an instant as `HH:mm` wall time in `timeZone`. */
export function formatTimeInZone(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date)
}

/**
 * Shift a `YYYY-MM-DD` date by whole days, staying a calendar date.
 *
 * Pure string→string arithmetic done in UTC, so it never depends on the
 * server's zone and never drifts across a DST boundary. Lives here rather than
 * in lib/booking/data.ts (where it used to sit) because that module is
 * `server-only` and opens a DB pool on import: a pure date helper must be
 * importable from anywhere, including the validation path in
 * lib/reports/date-range.ts. `@/lib/booking/data` still re-exports it, so every
 * existing import site is unchanged.
 */
export function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d + days))
  return dt.toISOString().slice(0, 10)
}
/** Today's `YYYY-MM-DD` as seen in `timeZone`. */
export function todayInZone(timeZone: string, now: Date = new Date()): string {
  const p: Record<string, string> = {}
  for (const part of new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now)) {
    p[part.type] = part.value
  }
  return `${p.year}-${p.month}-${p.day}`
}

/**
 * Add `days` to a plain 'YYYY-MM-DD' date string, returning the same shape.
 * Lives here (a pure module, no DB import) so import-order-sensitive callers —
 * e.g. lib/reports/date-range.ts, pulled in by standalone scripts before their
 * env is loaded — can use it without dragging in db/index.ts's pool. Same
 * implementation as lib/booking/data.ts's addDays.
 */
export function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d + days))
  return dt.toISOString().slice(0, 10)
}
