/**
 * Pure restaurant-report rules (M20 / AROS-179) — no DB, no `server-only`, so
 * the reader, the page and the unit tests share one definition.
 */

export type DaypartKey = 'breakfast' | 'lunch' | 'snacks' | 'dinner' | 'late_night'

/** Hour bands in the VENUE's timezone, [from, to) on a 24h clock. late_night wraps midnight. */
export const DAYPARTS: readonly { key: DaypartKey; label: string; from: number; to: number }[] = [
  { key: 'breakfast', label: 'Breakfast', from: 5, to: 11 },
  { key: 'lunch', label: 'Lunch', from: 11, to: 15 },
  { key: 'snacks', label: 'Snacks / tea', from: 15, to: 19 },
  { key: 'dinner', label: 'Dinner', from: 19, to: 23 },
  { key: 'late_night', label: 'Late night', from: 23, to: 5 },
]

/** The daypart a local hour (0–23) falls in. */
export function daypartOf(hour: number): DaypartKey {
  const h = ((Math.floor(hour) % 24) + 24) % 24
  for (const d of DAYPARTS) {
    if (d.from < d.to ? h >= d.from && h < d.to : h >= d.from || h < d.to) return d.key
  }
  return 'late_night'
}

export const round2 = (n: number): number => Math.round(n * 100) / 100

/** a ÷ b, or null when there is nothing to divide by (never NaN/Infinity). */
export function safeDiv(a: number, b: number): number | null {
  return b > 0 && Number.isFinite(a) ? a / b : null
}

/** Sessions shorter than this or longer than this are glitches, not meals. */
export const SESSION_MINUTES_BOUNDS = { min: 1, max: 720 } as const

/**
 * Turns per table per day: finished sessions ÷ tables ÷ days. `tables` is the
 * number of tables on the floor (a table nobody sat at still counts — an idle
 * table is exactly what a low turn rate is telling the owner).
 */
export function turnsPerTablePerDay(sessions: number, tables: number, days: number): number | null {
  const d = safeDiv(sessions, tables * days)
  return d === null ? null : round2(d)
}

/** Inclusive number of calendar days in a YYYY-MM-DD range. */
export function daysInRange(start: string, end: string): number {
  const ms = Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)
  return Math.max(1, Math.round(ms / 86_400_000) + 1)
}

/** Tip as a percentage of the bill it was left on; null with no billed sales. */
export function tipPercent(tips: number, billed: number): number | null {
  const v = safeDiv(tips * 100, billed)
  return v === null ? null : round2(v)
}
