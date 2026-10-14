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

export type BookingSettings = { maxAdvanceDays: number }

/** One cheap read per page load. Missing row ⇒ 7. */
export async function getBookingSettingsCore(tx: DB, tenantId: string): Promise<BookingSettings> {
  const [row] = await tx
    .select({ maxAdvanceDays: bookingSettings.maxAdvanceDays })
    .from(bookingSettings)
    .where(eq(bookingSettings.tenantId, tenantId))
    .limit(1)
  return { maxAdvanceDays: row?.maxAdvanceDays ?? DEFAULT_MAX_ADVANCE_DAYS }
}
