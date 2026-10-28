'use server'

import { revalidatePath } from 'next/cache'
import { withUser } from '@/db'
import { requireManager, AuthError } from '@/lib/auth/guard'
import {
  AdvanceWindowError,
  SlotStepError,
  WalkinAutoCloseError,
  applyBookingWindow,
  applySlotStep,
  applyWalkinAutoClose,
} from '@/lib/booking/settings-write'

type Result = { error?: string; success?: true; reduced?: boolean }

/**
 * Save the venue-wide advance-booking window — owner/manager only (and the RLS
 * policies say the same). Presets only: arbitrary values are rejected even
 * though the DB would allow 1–365. Shrinking never touches existing bookings.
 */
export async function saveBookingSettings(maxAdvanceDays: number): Promise<Result> {
  try {
    const ctx = await requireManager()
    const prev = await withUser(ctx.user.id, (tx) =>
      applyBookingWindow(tx, { tenantId: ctx.tenant.id, membershipId: ctx.membershipId }, maxAdvanceDays),
    )
    revalidatePath('/settings/hours')
    revalidatePath('/bookings/new')
    revalidatePath('/book', 'layout')
    revalidatePath('/book-type', 'layout')
    return { success: true, reduced: maxAdvanceDays < prev }
  } catch (e) {
    if (e instanceof AuthError || e instanceof AdvanceWindowError) return { error: e.message }
    console.error('[booking-settings] save failed', e)
    return { error: 'Could not save the booking window.' }
  }
}

/** Save the venue-wide booking time step (manager only). Existing bookings are untouched. */
export async function saveSlotStep(minutes: number): Promise<Result> {
  try {
    const ctx = await requireManager()
    await withUser(ctx.user.id, (tx) =>
      applySlotStep(tx, { tenantId: ctx.tenant.id, membershipId: ctx.membershipId }, minutes),
    )
    revalidatePath('/settings/hours')
    revalidatePath('/bookings/new')
    revalidatePath('/book', 'layout')
    revalidatePath('/book-type', 'layout')
    return { success: true }
  } catch (e) {
    if (e instanceof AuthError || e instanceof SlotStepError) return { error: e.message }
    console.error('[booking-settings] step save failed', e)
    return { error: 'Could not save the booking time step.' }
  }
}

/** Save the walk-in auto-close rules: max session length and/or closing time (manager only). */
export async function saveWalkinAutoClose(value: { minutes: number | null; atClosing: boolean }): Promise<Result> {
  try {
    const ctx = await requireManager()
    await withUser(ctx.user.id, (tx) =>
      applyWalkinAutoClose(tx, { tenantId: ctx.tenant.id, membershipId: ctx.membershipId }, value),
    )
    revalidatePath('/settings/hours')
    return { success: true }
  } catch (e) {
    if (e instanceof AuthError || e instanceof WalkinAutoCloseError) return { error: e.message }
    console.error('[booking-settings] walk-in auto-close save failed', e)
    return { error: 'Could not save the auto-close setting.' }
  }
}
