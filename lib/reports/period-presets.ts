/**
 * Quick-range presets for the month-based payroll report (M34 #8). Payslips
 * are monthly, so sub-month presets (yesterday, last 7/30 days) are not
 * offered. Pure: the caller passes the tenant's current period ('YYYY-MM' from
 * todayInZone), which is where the timezone enters.
 */
import { shiftPayrollPeriod } from '@/lib/format'

export const PAYROLL_PRESETS = ['month', 'last3m', 'last6m', 'lastyear'] as const
export type PayrollPreset = (typeof PAYROLL_PRESETS)[number]

export const PAYROLL_PRESET_LABELS: Record<PayrollPreset, string> = {
  month: 'This month',
  last3m: 'Last 3 months',
  last6m: 'Last 6 months',
  lastyear: 'Last year',
}

/**
 * Inclusive period bounds. "Last 3 months" is calendar periods — the current
 * one plus the two before it (3 payslip months) — not the rolling
 * 3-months-back day rule the day-based filters use. "Last 6 months" is the
 * report's default.
 */
export function resolvePayrollPreset(preset: PayrollPreset, currentPeriod: string): { from: string; to: string } {
  switch (preset) {
    case 'month':
      return { from: currentPeriod, to: currentPeriod }
    case 'last3m':
      return { from: shiftPayrollPeriod(currentPeriod, -2), to: currentPeriod }
    case 'last6m':
      return { from: shiftPayrollPeriod(currentPeriod, -5), to: currentPeriod }
    case 'lastyear': {
      const y = Number(currentPeriod.slice(0, 4)) - 1
      return { from: `${y}-01`, to: `${y}-12` }
    }
  }
}

export function matchingPayrollPresets(from: string, to: string, currentPeriod: string): PayrollPreset[] {
  return PAYROLL_PRESETS.filter((p) => {
    const r = resolvePayrollPreset(p, currentPeriod)
    return r.from === from && r.to === to
  })
}
