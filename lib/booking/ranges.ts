/**
 * Date-range presets for the bookings page (M34). Pure functions, no DB: every
 * boundary is a whole local day in the tenant timezone, built only from the
 * helpers in ./time so nothing depends on the server's zone.
 */
import { addDays, zonedTimeToUtc } from './time'

export const RANGE_PRESETS = ['yesterday', 'last7', 'month', 'last3m', 'lastyear'] as const
export type RangePreset = (typeof RANGE_PRESETS)[number]

export type ResolvedRange = {
  preset: RangePreset
  /** First local day, inclusive (`YYYY-MM-DD`). */
  fromDate: string
  /** Last local day, inclusive (`YYYY-MM-DD`). */
  toDate: string
  /** 00:00 local on `fromDate`. */
  startUtc: Date
  /** 00:00 local on the day after `toDate` (exclusive). */
  endUtc: Date
  isSingleDay: boolean
}

/** Whitelist a raw query-string value; anything else (incl. arrays) → null. */
export function parseRangePreset(raw: unknown): RangePreset | null {
  return typeof raw === 'string' && (RANGE_PRESETS as readonly string[]).includes(raw)
    ? (raw as RangePreset)
    : null
}

const pad = (n: number) => String(n).padStart(2, '0')

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate() // month is 1-based
}

/** Same day-of-month `months` ago, clamped to that month's last day. */
function subtractMonths(dateStr: string, months: number): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  const idx = y * 12 + (m - 1) - months
  const ny = Math.floor(idx / 12)
  const nm = (idx % 12) + 1
  return `${ny}-${pad(nm)}-${pad(Math.min(d, daysInMonth(ny, nm)))}`
}

export function resolveRange(preset: RangePreset, todayStr: string, tz: string): ResolvedRange {
  let fromDate: string
  let toDate: string
  switch (preset) {
    case 'yesterday':
      fromDate = toDate = addDays(todayStr, -1)
      break
    case 'last7':
      fromDate = addDays(todayStr, -6)
      toDate = todayStr
      break
    case 'month':
      fromDate = `${todayStr.slice(0, 7)}-01`
      toDate = todayStr
      break
    case 'last3m':
      fromDate = subtractMonths(todayStr, 3)
      toDate = todayStr
      break
    case 'lastyear': {
      const y = Number(todayStr.slice(0, 4)) - 1
      fromDate = `${y}-01-01`
      toDate = `${y}-12-31`
      break
    }
  }
  return {
    preset,
    fromDate,
    toDate,
    startUtc: zonedTimeToUtc(fromDate, '00:00', tz),
    endUtc: zonedTimeToUtc(addDays(toDate, 1), '00:00', tz),
    isSingleDay: fromDate === toDate,
  }
}
