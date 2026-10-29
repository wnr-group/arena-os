/**
 * Venue-wide advance-booking window (M37 #1): how far ahead bookings can be
 * made, for the public storefront and the admin future-booking wizard.
 *
 * "N days" keeps today's meaning — bookable dates are today … today + N − 1 in
 * the tenant timezone, so 7 is the same 7 date chips as before. A tenant with
 * no row behaves as 7: the reader supplies the default, no row is required.
 *
 * The core reader takes a `tx` so it works inside withPublicTenant() for the
 * anonymous storefront as well as inside withUser() for staff.
 */
import { eq } from 'drizzle-orm'
import type { DB } from '@/db'
import { bookingSettings } from '@/db/schema'

export const DEFAULT_MAX_ADVANCE_DAYS = 7

/** The only values the UI offers and the action accepts (stored as integer days). */
export const ADVANCE_WINDOW_PRESETS = [
  { days: 7, label: '7 days' },
  { days: 30, label: '1 month' },
  { days: 90, label: '3 months' },
  { days: 180, label: '6 months' },
] as const

export const ADVANCE_WINDOW_DAYS: number[] = ADVANCE_WINDOW_PRESETS.map((p) => p.days)

export function isAdvanceWindowPreset(n: unknown): n is number {
  return typeof n === 'number' && ADVANCE_WINDOW_DAYS.includes(n)
}

/** "3 months", "7 days" ... for a stored day count; an unlisted value reads as plain days. */
export function advanceWindowLabel(days: number): string {
  return ADVANCE_WINDOW_PRESETS.find((p) => p.days === days)?.label ?? `${days} days`
}

export const DEFAULT_SLOT_STEP_MINUTES = 30

/** The only steps the UI offers and the action accepts (all divide 60). */
export const SLOT_STEP_PRESETS = [
  { minutes: 5, label: '5 min' },
  { minutes: 10, label: '10 min' },
  { minutes: 15, label: '15 min' },
  { minutes: 20, label: '20 min' },
  { minutes: 30, label: '30 min' },
  { minutes: 60, label: '1 hour' },
] as const

export function isSlotStepPreset(n: unknown): n is number {
  return typeof n === 'number' && SLOT_STEP_PRESETS.some((p) => p.minutes === n)
}

/** Shortest bookable session in the picker, whatever the step. */
const MIN_PICKER_DURATION = 30

/**
 * Duration choices for a step: every multiple of the step from 30 minutes to
 * 4 hours, then hourly to 24 hours. At the default step of 30 this is exactly
 * the list the booking pages always offered.
 */
export function buildDurations(step: number = DEFAULT_SLOT_STEP_MINUTES): number[] {
  const out: number[] = []
  for (let m = step; m <= 240; m += step) if (m >= MIN_PICKER_DURATION) out.push(m)
  for (let h = 5; h <= 24; h++) out.push(h * 60)
  return out
}

/** Session lengths an owner can auto-close open-tab walk-ins after (minutes). */
export const WALKIN_AUTO_CLOSE_PRESETS = [
  { minutes: 120, label: '2 hours' },
  { minutes: 180, label: '3 hours' },
  { minutes: 240, label: '4 hours' },
  { minutes: 360, label: '6 hours' },
  { minutes: 480, label: '8 hours' },
  { minutes: 720, label: '12 hours' },
] as const

export function isWalkinAutoClosePreset(n: unknown): n is number {
  return typeof n === 'number' && WALKIN_AUTO_CLOSE_PRESETS.some((p) => p.minutes === n)
}

export type BookingSettings = {
  maxAdvanceDays: number
  slotStepMinutes: number
  /** null = auto-close is off. */
  walkinAutoCloseMinutes: number | null
  /** Also close open walk-ins at the branch's closing time. */
  walkinAutoCloseAtClosing: boolean
}

/** One cheap read per page load. Missing row ⇒ 7. */
export async function getBookingSettingsCore(tx: DB, tenantId: string): Promise<BookingSettings> {
  const [row] = await tx
    .select({
      maxAdvanceDays: bookingSettings.maxAdvanceDays,
      slotStepMinutes: bookingSettings.slotStepMinutes,
      walkinAutoCloseMinutes: bookingSettings.walkinAutoCloseMinutes,
      walkinAutoCloseAtClosing: bookingSettings.walkinAutoCloseAtClosing,
    })
    .from(bookingSettings)
    .where(eq(bookingSettings.tenantId, tenantId))
    .limit(1)
  return {
    maxAdvanceDays: row?.maxAdvanceDays ?? DEFAULT_MAX_ADVANCE_DAYS,
    slotStepMinutes: row?.slotStepMinutes ?? DEFAULT_SLOT_STEP_MINUTES,
    walkinAutoCloseMinutes: row?.walkinAutoCloseMinutes ?? null,
    walkinAutoCloseAtClosing: row?.walkinAutoCloseAtClosing ?? false,
  }
}
