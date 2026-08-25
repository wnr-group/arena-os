/**
 * The tenant's order settings — currently just the online-order auto-accept
 * toggle. Same singleton shape as lib/settings/business-profile.ts:
 * tenant_id is the primary key and the upsert conflict target.
 *
 * getOrderSettingsCore takes a `tx` (not a ctx) so it can be read from inside
 * placeOnlineOrder's public/anon transaction (lib/actions/public-orders.ts) as
 * well as from the normal staff-authenticated path.
 */
import 'server-only'
import { eq } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type * as schema from '@/db/schema'
import { orderSettings } from '@/db/schema'
import { withUser } from '@/db'
import type { ActiveContext } from '@/lib/tenant/context'

type Db = NodePgDatabase<typeof schema>

export type OrderSettings = { autoAcceptOnlineOrders: boolean }

/** A tenant that has never opened the settings page still behaves safely — the
 *  accept/reject gate stays on until a manager explicitly turns it off. */
const DEFAULT_ORDER_SETTINGS: OrderSettings = { autoAcceptOnlineOrders: false }

export async function getOrderSettingsCore(tx: Db, tenantId: string): Promise<OrderSettings> {
  const [row] = await tx
    .select({ autoAcceptOnlineOrders: orderSettings.autoAcceptOnlineOrders })
    .from(orderSettings)
    .where(eq(orderSettings.tenantId, tenantId))
    .limit(1)
  return row ?? DEFAULT_ORDER_SETTINGS
}

export function getOrderSettings(ctx: ActiveContext): Promise<OrderSettings> {
  return withUser(ctx.user.id, (tx) => getOrderSettingsCore(tx, ctx.tenant.id))
}

export async function setAutoAcceptOnlineOrders(tx: Db, tenantId: string, value: boolean): Promise<void> {
  await tx
    .insert(orderSettings)
    .values({ tenantId, autoAcceptOnlineOrders: value })
    .onConflictDoUpdate({ target: orderSettings.tenantId, set: { autoAcceptOnlineOrders: value } })
}
