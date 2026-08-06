import 'server-only'
import { and, asc, eq, inArray } from 'drizzle-orm'
import { withUser } from '@/db'
import { orders, orderItems } from '@/db/schema'
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
      })
      .from(orders)
      .leftJoin(orderItems, eq(orderItems.orderId, orders.id))
      .where(and(eq(orders.tenantId, ctx.tenant.id), inArray(orders.bookingId, bookingIds)))
      .orderBy(asc(orders.createdAt), asc(orderItems.id)),
  )
}
