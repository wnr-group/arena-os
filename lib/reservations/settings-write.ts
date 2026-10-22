import 'server-only'
import type { DB } from '@/db'
import { reservationSettings } from '@/db/schema'
import { writeAudit } from '@/lib/billing/invoice'
import { getReservationSettingsCore } from './settings'
import type { ReservationSettings } from './rules'

/**
 * Upsert the venue's reservation settings and audit old → new. The caller has
 * already passed requireManager() + validateReservationSettings(); RLS
 * (reservation_settings_manager_*) is the second, independent gate. Existing
 * reservations are never touched — new values only govern what happens next.
 */
export async function applyReservationSettings(
  tx: DB,
  actor: { tenantId: string; membershipId: string },
  next: ReservationSettings,
): Promise<void> {
  const old = await getReservationSettingsCore(tx, actor.tenantId)
  const changed = (Object.keys(next) as (keyof ReservationSettings)[]).filter((k) => old[k] !== next[k])
  if (changed.length === 0) return

  await tx
    .insert(reservationSettings)
    .values({ tenantId: actor.tenantId, ...next, updatedBy: actor.membershipId })
    .onConflictDoUpdate({
      target: reservationSettings.tenantId,
      set: { ...next, updatedBy: actor.membershipId },
    })
  await writeAudit(tx, actor, {
    action: 'reservation_settings.changed',
    entityType: 'reservation_settings',
    entityId: actor.tenantId,
    before: Object.fromEntries(changed.map((k) => [k, old[k]])),
    after: Object.fromEntries(changed.map((k) => [k, next[k]])),
  })
}
