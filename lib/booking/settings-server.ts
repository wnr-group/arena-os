import 'server-only'
import { withPublicTenant, withUser } from '@/db'
import type { ActiveContext } from '@/lib/tenant/context'
import { DEFAULT_MAX_ADVANCE_DAYS, DEFAULT_SLOT_STEP_MINUTES, getBookingSettingsCore, type BookingSettings } from './settings'

/** Staff path: the tenant context of a logged-in user. */
export function getBookingSettings(ctx: ActiveContext): Promise<BookingSettings> {
  return withUser(ctx.user.id, (tx) => getBookingSettingsCore(tx, ctx.tenant.id))
}

/** Anonymous storefront path: readable through the public-select policy. */
export function getPublicBookingSettings(tenantId: string): Promise<BookingSettings> {
  return withPublicTenant(tenantId, (tx) => getBookingSettingsCore(tx, tenantId))
}

/**
 * Enforcement-path readers: a failed read must never open the window, so they
 * fall back to the default 7 days instead of throwing or returning nothing.
 */
export async function maxAdvanceDaysOrDefault(ctx: ActiveContext): Promise<number> {
  try {
    return (await getBookingSettings(ctx)).maxAdvanceDays
  } catch (e) {
    console.error('[booking-settings] read failed, using default window:', e instanceof Error ? e.name : 'unknown')
    return DEFAULT_MAX_ADVANCE_DAYS
  }
}

export async function publicMaxAdvanceDaysOrDefault(tenantId: string): Promise<number> {
  try {
    return (await getPublicBookingSettings(tenantId)).maxAdvanceDays
  } catch (e) {
    console.error('[booking-settings] public read failed, using default window:', e instanceof Error ? e.name : 'unknown')
    return DEFAULT_MAX_ADVANCE_DAYS
  }
}

/** Time-step readers fail to the 30-minute default, never to a finer grid. */
export async function slotStepOrDefault(ctx: ActiveContext): Promise<number> {
  try {
    return (await getBookingSettings(ctx)).slotStepMinutes
  } catch (e) {
    console.error('[booking-settings] step read failed, using default:', e instanceof Error ? e.name : 'unknown')
    return DEFAULT_SLOT_STEP_MINUTES
  }
}

export async function publicSlotStepOrDefault(tenantId: string): Promise<number> {
  try {
    return (await getPublicBookingSettings(tenantId)).slotStepMinutes
  } catch (e) {
    console.error('[booking-settings] public step read failed, using default:', e instanceof Error ? e.name : 'unknown')
    return DEFAULT_SLOT_STEP_MINUTES
  }
}
