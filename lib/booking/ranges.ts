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

/**
 * The presets the report date filters offer: the bookings set plus "Last 30
 * days" (the reports' implicit default). `last30` is deliberately NOT in
 * RANGE_PRESETS, so the bookings page's ?range= contract and chips are unchanged.
 */
export const REPORT_PRESETS = ['yesterday', 'last7', 'last30', 'month', 'last3m', 'lastyear'] as const
export type ReportPreset = (typeof REPORT_PRESETS)[number]

export const RANGE_LABELS: Record<ReportPreset, string> = {
  yesterday: 'Yesterday',
  last7: 'Last 7 days',
  last30: 'Last 30 days',
  month: 'This month',
  last3m: 'Last 3 months',
  lastyear: 'Last year',
}

/**
 * Inclusive local-date bounds of a preset for a given local "today". Needs no
 * timezone: callers pass the tenant's today (todayInZone), which is where the
 * zone enters. Shared by the bookings resolver below and the report filters, so
 * there is exactly one definition of every preset.
 */
export function resolvePresetDates(preset: ReportPreset, todayStr: string): { fromDate: string; toDate: string } {
  switch (preset) {
    case 'yesterday': {
      const d = addDays(todayStr, -1)
      return { fromDate: d, toDate: d }
    }
    case 'last7':
      return { fromDate: addDays(todayStr, -6), toDate: todayStr }
    case 'last30':
      // Counts today itself, like resolveDateRange's default: 30 rows, not 31.
      return { fromDate: addDays(todayStr, -29), toDate: todayStr }
    case 'month':
      return { fromDate: `${todayStr.slice(0, 7)}-01`, toDate: todayStr }
    case 'last3m':
      return { fromDate: subtractMonths(todayStr, 3), toDate: todayStr }
    case 'lastyear': {
      const y = Number(todayStr.slice(0, 4)) - 1
      return { fromDate: `${y}-01-01`, toDate: `${y}-12-31` }
    }
  }
}

/**
 * Presets whose range is exactly [from, to] for this local "today" — what the
 * report filters highlight. Usually zero (a custom range) or one.
 */
export function matchingReportPresets(from: string, to: string, todayStr: string): ReportPreset[] {
  return REPORT_PRESETS.filter((p) => {
    const r = resolvePresetDates(p, todayStr)
    return r.fromDate === from && r.toDate === to
  })
}

export function resolveRange(preset: RangePreset, todayStr: string, tz: string): ResolvedRange {
  const { fromDate, toDate } = resolvePresetDates(preset, todayStr)
  return {
    preset,
    fromDate,
    toDate,
    startUtc: zonedTimeToUtc(fromDate, '00:00', tz),
    endUtc: zonedTimeToUtc(addDays(toDate, 1), '00:00', tz),
    isSingleDay: fromDate === toDate,
  }
}
