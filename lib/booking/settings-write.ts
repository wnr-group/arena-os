import 'server-only'
import { eq } from 'drizzle-orm'
import type { DB } from '@/db'
import { bookingSettings } from '@/db/schema'
import { writeAudit } from '@/lib/billing/invoice'
import { DEFAULT_MAX_ADVANCE_DAYS, DEFAULT_SLOT_STEP_MINUTES, isAdvanceWindowPreset, isSlotStepPreset, isWalkinAutoClosePreset } from './settings'

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
  // Unchanged: nothing to write, audit or stamp as "updated by".
  if (old === next) return old
  await tx
    .insert(bookingSettings)
    .values({ tenantId: actor.tenantId, maxAdvanceDays: next, updatedBy: actor.membershipId })
    .onConflictDoUpdate({
      target: bookingSettings.tenantId,
      set: { maxAdvanceDays: next, updatedBy: actor.membershipId },
    })
  await writeAudit(tx, actor, {
    action: 'booking_settings.max_advance_days_changed',
    entityType: 'booking_settings',
    entityId: actor.tenantId,
    before: { maxAdvanceDays: old },
    after: { maxAdvanceDays: next },
  })
  return old
}

export class SlotStepError extends Error {}

/**
 * Upsert the venue's booking time step and audit old → new. Manager-only at the
 * caller and again by RLS. Never touches existing bookings: it only changes
 * which times NEW bookings can start at.
 */
export async function applySlotStep(
  tx: DB,
  actor: { tenantId: string; membershipId: string },
  next: number,
): Promise<number> {
  if (!isSlotStepPreset(next)) throw new SlotStepError('Choose 5, 10, 15, 20, 30 or 60 minutes.')
  const [row] = await tx
    .select({ slotStepMinutes: bookingSettings.slotStepMinutes })
    .from(bookingSettings)
    .where(eq(bookingSettings.tenantId, actor.tenantId))
    .limit(1)
  const old = row?.slotStepMinutes ?? DEFAULT_SLOT_STEP_MINUTES
  if (old === next) return old
  await tx
    .insert(bookingSettings)
    .values({ tenantId: actor.tenantId, slotStepMinutes: next, updatedBy: actor.membershipId })
    .onConflictDoUpdate({
      target: bookingSettings.tenantId,
      set: { slotStepMinutes: next, updatedBy: actor.membershipId },
    })
  await writeAudit(tx, actor, {
    action: 'booking_settings.slot_step_changed',
    entityType: 'booking_settings',
    entityId: actor.tenantId,
    before: { slotStepMinutes: old },
    after: { slotStepMinutes: next },
  })
  return old
}

export class WalkinAutoCloseError extends Error {}

export type WalkinAutoCloseValue = { minutes: number | null; atClosing: boolean }

/**
 * Save the walk-in auto-close rules — a max session length (preset minutes, or
 * null for none) and/or closing time — and audit old → new. Manager-only at the
 * caller and again by RLS. Only affects walk-ins closed from now on; nothing is
 * closed here.
 */
export async function applyWalkinAutoClose(
  tx: DB,
  actor: { tenantId: string; membershipId: string },
  next: WalkinAutoCloseValue,
): Promise<WalkinAutoCloseValue> {
  if (next.minutes !== null && !isWalkinAutoClosePreset(next.minutes)) {
    throw new WalkinAutoCloseError('Choose one of the listed durations, or turn the time limit off.')
  }
  if (typeof next.atClosing !== 'boolean') throw new WalkinAutoCloseError('Invalid auto-close setting.')
  const [row] = await tx
    .select({ minutes: bookingSettings.walkinAutoCloseMinutes, atClosing: bookingSettings.walkinAutoCloseAtClosing })
    .from(bookingSettings)
    .where(eq(bookingSettings.tenantId, actor.tenantId))
    .limit(1)
  const old = { minutes: row?.minutes ?? null, atClosing: row?.atClosing ?? false }
  if (old.minutes === next.minutes && old.atClosing === next.atClosing) return old
  const values = { walkinAutoCloseMinutes: next.minutes, walkinAutoCloseAtClosing: next.atClosing }
  await tx
    .insert(bookingSettings)
    .values({ tenantId: actor.tenantId, ...values, updatedBy: actor.membershipId })
    .onConflictDoUpdate({ target: bookingSettings.tenantId, set: { ...values, updatedBy: actor.membershipId } })
  await writeAudit(tx, actor, {
    action: 'booking_settings.walkin_auto_close_changed',
    entityType: 'booking_settings',
    entityId: actor.tenantId,
    before: { walkinAutoCloseMinutes: old.minutes, walkinAutoCloseAtClosing: old.atClosing },
    after: { walkinAutoCloseMinutes: next.minutes, walkinAutoCloseAtClosing: next.atClosing },
  })
  return old
}
