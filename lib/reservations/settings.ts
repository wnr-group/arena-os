import 'server-only'
import { eq } from 'drizzle-orm'
import type { DB } from '@/db'
import { reservationSettings } from '@/db/schema'
import { RESERVATION_DEFAULTS, type ReservationSettings } from './rules'

/**
 * One cheap read. A tenant with no row gets RESERVATION_DEFAULTS (disabled), so
 * every existing restaurant is unchanged until an owner opts in. Takes a `tx` so
 * it works under withUser (staff) and withPublicTenant (storefront) alike.
 */
export async function getReservationSettingsCore(tx: DB, tenantId: string): Promise<ReservationSettings> {
  const [row] = await tx
    .select({
      enabled: reservationSettings.enabled,
      defaultDurationMinutes: reservationSettings.defaultDurationMinutes,
      noShowGraceMinutes: reservationSettings.noShowGraceMinutes,
      walkinBufferMinutes: reservationSettings.walkinBufferMinutes,
      publicEnabled: reservationSettings.publicEnabled,
      maxPartySize: reservationSettings.maxPartySize,
      waitlistEnabled: reservationSettings.waitlistEnabled,
    })
    .from(reservationSettings)
    .where(eq(reservationSettings.tenantId, tenantId))
    .limit(1)
  return row ?? RESERVATION_DEFAULTS
}
