import 'server-only'
import { and, asc, eq, inArray, notInArray } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { withUser } from '@/db'
import { kots, orders, orderItems, orderItemModifiers, bookings, resources } from '@/db/schema'
import type * as schema from '@/db/schema'
import type { ActiveContext } from '@/lib/tenant/context'

type Db = NodePgDatabase<typeof schema>

/**
 * Chosen-modifier names for a set of order_items ids, grouped by item id —
 * "no onions, extra cheese" under a KOT line. A follow-up query rather than
 * folding into the main KOT/item join (which would multiply one item row
 * per modifier), same "read once, group in memory" shape as
 * lib/menu/data.ts's listMenuItemModifierGroups.
 */
async function loadModifierNamesByItem(tx: Db, tenantId: string, itemIds: string[]): Promise<Map<string, string[]>> {
  const byItem = new Map<string, string[]>()
  if (itemIds.length === 0) return byItem
  const rows = await tx
    .select({ orderItemId: orderItemModifiers.orderItemId, optionName: orderItemModifiers.optionName })
    .from(orderItemModifiers)
    .where(and(eq(orderItemModifiers.tenantId, tenantId), inArray(orderItemModifiers.orderItemId, itemIds)))
  for (const row of rows) {
    const list = byItem.get(row.orderItemId) ?? []
    if (list.length === 0) byItem.set(row.orderItemId, list)
    list.push(row.optionName)
  }
  return byItem
}

/** Flat KOT+item rows for a branch's active tickets — grouped by the caller
 *  (see components/kitchen/KitchenQueue.tsx).
 *
 *  `acceptanceStatus = 'accepted'` (migration 0050) is the gate that keeps an
 *  online order awaiting staff accept/reject off this screen: a staff/POS
 *  order is always 'accepted' by default, so this filter never touches it. */
export function listActiveKots(ctx: ActiveContext, branchId: string) {
  return withUser(ctx.user.id, async (tx) => {
    const rows = await tx
      .select({
        kotId: kots.id,
        kotNumber: kots.kotNumber,
        status: kots.status,
        createdAt: kots.createdAt,
        orderId: orders.id,
        orderNumber: orders.orderNumber,
        channel: orders.channel,
        stationName: resources.name,
        itemId: orderItems.id,
        itemName: orderItems.itemName,
        qty: orderItems.qty,
        specialInstructions: orderItems.specialInstructions,
      })
      .from(kots)
      .innerJoin(orders, eq(orders.id, kots.orderId))
      .leftJoin(orderItems, eq(orderItems.orderId, orders.id))
      .leftJoin(resources, eq(resources.id, orders.resourceId))
      .where(
        and(
          eq(kots.tenantId, ctx.tenant.id),
          eq(kots.branchId, branchId),
          notInArray(kots.status, ['served', 'cancelled']),
          eq(orders.acceptanceStatus, 'accepted'),
        ),
      )
      .orderBy(asc(kots.createdAt), asc(orderItems.id))

    const itemIds = rows.map((r) => r.itemId).filter((id): id is string => id !== null)
    const modifiersByItem = await loadModifierNamesByItem(tx, ctx.tenant.id, itemIds)
    return rows.map((r) => ({ ...r, modifiers: r.itemId ? (modifiersByItem.get(r.itemId) ?? []) : [] }))
  })
}

/**
 * Each booking's open orders' KOT status — the M17 floor map's "ordered" vs
 * "served" signal (see lib/booking/table-status.ts). One row per order:
 * every order gets exactly one KOT (lib/orders/service.ts, "one KOT per
 * order, always"), so no item-level join is needed here.
 */
export function listKotStatusesForBookings(ctx: ActiveContext, bookingIds: string[]) {
  if (bookingIds.length === 0) return Promise.resolve([])
  return withUser(ctx.user.id, (tx) =>
    tx
      .select({
        bookingId: orders.bookingId,
        orderId: orders.id,
        status: kots.status,
      })
      .from(kots)
      .innerJoin(orders, eq(orders.id, kots.orderId))
      .where(and(eq(kots.tenantId, ctx.tenant.id), inArray(orders.bookingId, bookingIds))),
  )
}

export type KotPrintTicket = {
  kotId: string
  kotNumber: string
  status: (typeof kots.$inferSelect)['status']
  createdAt: Date
  orderNumber: string
  bookingNumber: string | null
  customerName: string | null
  items: { itemId: string; itemName: string; qty: number; specialInstructions: string | null; modifiers: string[] }[]
}

/**
 * A single ticket for the printable slip at /kitchen/[kotId]/print — same
 * tenant scoping as listActiveKots, but for one KOT regardless of status (a
 * served ticket should still be reprintable).
 */
export async function getKotForPrint(ctx: ActiveContext, kotId: string): Promise<KotPrintTicket | null> {
  return withUser(ctx.user.id, async (tx) => {
    const [head] = await tx
      .select({
        kotId: kots.id,
        kotNumber: kots.kotNumber,
        status: kots.status,
        createdAt: kots.createdAt,
        orderId: orders.id,
        orderNumber: orders.orderNumber,
        bookingNumber: bookings.bookingNumber,
        customerName: bookings.customerName,
      })
      .from(kots)
      .innerJoin(orders, eq(orders.id, kots.orderId))
      .leftJoin(bookings, eq(bookings.id, orders.bookingId))
      .where(and(eq(kots.id, kotId), eq(kots.tenantId, ctx.tenant.id)))
      .limit(1)
    if (!head) return null

    const itemRows = await tx
      .select({
        itemId: orderItems.id,
        itemName: orderItems.itemName,
        qty: orderItems.qty,
        specialInstructions: orderItems.specialInstructions,
      })
      .from(orderItems)
      .where(eq(orderItems.orderId, head.orderId))
      .orderBy(asc(orderItems.id))

    const modifiersByItem = await loadModifierNamesByItem(
      tx,
      ctx.tenant.id,
      itemRows.map((r) => r.itemId),
    )

    return {
      kotId: head.kotId,
      kotNumber: head.kotNumber,
      status: head.status,
      createdAt: head.createdAt,
      orderNumber: head.orderNumber,
      bookingNumber: head.bookingNumber,
      customerName: head.customerName,
      items: itemRows.map((r) => ({ ...r, modifiers: modifiersByItem.get(r.itemId) ?? [] })),
    }
  })
}
