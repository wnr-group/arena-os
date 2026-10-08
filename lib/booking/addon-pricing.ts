/**
 * M33 — pure add-on pricing rules (no DB, no server-only), so the staff
 * dialogs can preview exactly what the server will charge and the tests can
 * pin the rules without a database.
 *
 * Flat rate only — no weekday/weekend split, no happy-hour discount, no
 * holiday composition. Owner picks hourly OR daily per add-on.
 */
export type AddonRateUnit = 'hour' | 'day'

export type AddonRequest = { addonId: string; quantity: number }

/** Sanity ceiling on a single add-on line's quantity. */
export const ADDON_MAX_QUANTITY = 99

const HOUR_MS = 60 * 60_000

/**
 * Billable units for the window [startsAt, endsAt).
 *   hour -> exact elapsed hours (fractional), same as a reserved slot's
 *           rate × durationHours.
 *   day  -> ceil(elapsed hours / 24), minimum 1. A fixed elapsed-time rule,
 *           NOT calendar-dates-touched: that would price the same booking
 *           differently depending on whether it happens to cross midnight.
 */
export function addonBillableUnits(rateUnit: AddonRateUnit, startsAt: Date, endsAt: Date): number {
  const hours = (endsAt.getTime() - startsAt.getTime()) / HOUR_MS
  if (rateUnit === 'day') return Math.max(1, Math.ceil(hours / 24 - 1e-9))
  return hours
}
