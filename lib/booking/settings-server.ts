import 'server-only'
import { withPublicTenant, withUser } from '@/db'
import type { ActiveContext } from '@/lib/tenant/context'
import { getBookingSettingsCore, type BookingSettings } from './settings'

/** Staff path: the tenant context of a logged-in user. */
export function getBookingSettings(ctx: ActiveContext): Promise<BookingSettings> {
  return withUser(ctx.user.id, (tx) => getBookingSettingsCore(tx, ctx.tenant.id))
}

/** Anonymous storefront path: readable through the public-select policy. */
export function getPublicBookingSettings(tenantId: string): Promise<BookingSettings> {
  return withPublicTenant(tenantId, (tx) => getBookingSettingsCore(tx, tenantId))
}
