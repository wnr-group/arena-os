import 'server-only'
import { and, asc, eq, inArray } from 'drizzle-orm'
import { withUser } from '@/db'
import { orders, orderItems, resources } from '@/db/schema'
import type { ActiveContext } from '@/lib/tenant/context'

/** Flat order+item rows for the given bookings — used to show food orders on a booking's detail view. */
export function listOrdersForBookings(ctx: ActiveContext, bookingIds: string[]) {
  if (bookingIds.length === 0) return Promise.resolve([])
  return withUser(ctx.user.id, (tx) =>
    tx
      .select({
        orderId: orders.id,
        bookingId: orders.bookingId,
        orderNumber: orders.orderNumber,
        status: orders.status,
        createdAt: orders.createdAt,
        itemId: orderItems.id,
        itemName: orderItems.itemName,
        unitPrice: orderItems.unitPrice,
        taxRate: orderItems.taxRate,
        qty: orderItems.qty,
        specialInstructions: orderItems.specialInstructions,
        happyHourName: orderItems.happyHourName,
        originalUnitPrice: orderItems.originalUnitPrice,
        happyHourDiscountType: orderItems.happyHourDiscountType,
        happyHourDiscountValue: orderItems.happyHourDiscountValue,
      })
      .from(orders)
      .leftJoin(orderItems, eq(orderItems.orderId, orders.id))
      .where(and(eq(orders.tenantId, ctx.tenant.id), inArray(orders.bookingId, bookingIds)))
      .orderBy(asc(orders.createdAt), asc(orderItems.id)),
  )
}

/** Flat order+item rows for a branch's online orders still awaiting staff
 *  accept/reject — grouped by the caller, same shape as lib/kots/data.ts's
 *  listActiveKots (see components/orders/IncomingOrdersQueue.tsx). */
export function listIncomingOnlineOrders(ctx: ActiveContext, branchId: string) {
  return withUser(ctx.user.id, (tx) =>
    tx
      .select({
        orderId: orders.id,
        orderNumber: orders.orderNumber,
        createdAt: orders.createdAt,
        stationName: resources.name,
        itemId: orderItems.id,
        itemName: orderItems.itemName,
        qty: orderItems.qty,
        specialInstructions: orderItems.specialInstructions,
        lineTotal: orderItems.lineTotal,
      })
      .from(orders)
      .leftJoin(orderItems, eq(orderItems.orderId, orders.id))
      .leftJoin(resources, eq(resources.id, orders.resourceId))
      .where(
        and(
          eq(orders.tenantId, ctx.tenant.id),
          eq(orders.branchId, branchId),
          eq(orders.channel, 'online'),
          eq(orders.acceptanceStatus, 'pending'),
        ),
      )
      .orderBy(asc(orders.createdAt), asc(orderItems.id)),
  )
}
