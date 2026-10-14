import 'server-only'
import { eq } from 'drizzle-orm'
import type { DB } from '@/db'
import { bookingSettings } from '@/db/schema'
import { writeAudit } from '@/lib/billing/invoice'
import { DEFAULT_MAX_ADVANCE_DAYS, isAdvanceWindowPreset } from './settings'

export class AdvanceWindowError extends Error {}

/**
 * Upsert the venue's advance-booking window and audit old → new. The caller
 * has already passed requireManager(); RLS (booking_settings_manager_*) is the
 * second, independent gate. Returns the previous value.
 *
 * Never touches bookings: shrinking the window only limits NEW bookings.
 */
export async function applyBookingWindow(
  tx: DB,
  actor: { tenantId: string; membershipId: string },
  next: number,
): Promise<number> {
  if (!isAdvanceWindowPreset(next)) {
    throw new AdvanceWindowError('Choose 7 days, 1 month, 3 months or 6 months.')
  }
  const [row] = await tx
    .select({ maxAdvanceDays: bookingSettings.maxAdvanceDays })
    .from(bookingSettings)
    .where(eq(bookingSettings.tenantId, actor.tenantId))
    .limit(1)
  const old = row?.maxAdvanceDays ?? DEFAULT_MAX_ADVANCE_DAYS
  await tx
    .insert(bookingSettings)
    .values({ tenantId: actor.tenantId, maxAdvanceDays: next, updatedBy: actor.membershipId })
    .onConflictDoUpdate({
      target: bookingSettings.tenantId,
      set: { maxAdvanceDays: next, updatedBy: actor.membershipId },
    })
  if (old !== next) {
    await writeAudit(tx, actor, {
      action: 'booking_settings.max_advance_days_changed',
      entityType: 'booking_settings',
      entityId: actor.tenantId,
      before: { maxAdvanceDays: old },
      after: { maxAdvanceDays: next },
    })
  }
  return old
}
