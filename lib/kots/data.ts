import 'server-only'
import { and, asc, eq, inArray, notInArray } from 'drizzle-orm'
import { withUser } from '@/db'
import { kots, orders, orderItems, bookings, resources } from '@/db/schema'
import type { ActiveContext } from '@/lib/tenant/context'

/** Flat KOT+item rows for a branch's active tickets — grouped by the caller
 *  (see components/kitchen/KitchenQueue.tsx).
 *
 *  `acceptanceStatus = 'accepted'` (migration 0057) is the gate that keeps an
 *  online order awaiting staff accept/reject off this screen: a staff/POS
 *  order is always 'accepted' by default, so this filter never touches it. */
export function listActiveKots(ctx: ActiveContext, branchId: string) {
  return withUser(ctx.user.id, (tx) =>
    tx
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
      .orderBy(asc(kots.createdAt), asc(orderItems.id)),
  )
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
  items: { itemId: string; itemName: string; qty: number; specialInstructions: string | null }[]
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

    return {
      kotId: head.kotId,
      kotNumber: head.kotNumber,
      status: head.status,
      createdAt: head.createdAt,
      orderNumber: head.orderNumber,
      bookingNumber: head.bookingNumber,
      customerName: head.customerName,
      items: itemRows,
    }
  })
}
