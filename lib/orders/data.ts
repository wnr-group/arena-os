import 'server-only'
import { and, asc, eq, inArray } from 'drizzle-orm'
import { withUser } from '@/db'
import { orders, orderItems, orderItemModifiers, orderItemVoidRequests, bookings, resources, memberships } from '@/db/schema'
import type { ActiveContext } from '@/lib/tenant/context'

/**
 * Chosen-modifier names for a set of order_items ids, grouped by item id —
 * "no onions, extra cheese" under a booking/floor detail line. Same
 * follow-up-query shape as lib/kots/data.ts's loadModifierNamesByItem.
 */
export async function listOrderItemModifierNames(
  ctx: ActiveContext,
  orderItemIds: string[],
): Promise<Map<string, string[]>> {
  const byItem = new Map<string, string[]>()
  if (orderItemIds.length === 0) return byItem
  const rows = await withUser(ctx.user.id, (tx) =>
    tx
      .select({ orderItemId: orderItemModifiers.orderItemId, optionName: orderItemModifiers.optionName })
      .from(orderItemModifiers)
      .where(and(eq(orderItemModifiers.tenantId, ctx.tenant.id), inArray(orderItemModifiers.orderItemId, orderItemIds))),
  )
  for (const row of rows) {
    const list = byItem.get(row.orderItemId) ?? []
    if (list.length === 0) byItem.set(row.orderItemId, list)
    list.push(row.optionName)
  }
  return byItem
}

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
        voidStatus: orderItems.voidStatus,
        voidReason: orderItems.voidReason,
        // Set only while a void/comp request on this line is awaiting
        // manager approval — at most one per item (idx_order_item_void_
        // requests_one_pending, migration 0067), so this left join never
        // duplicates a row.
        pendingVoidMode: orderItemVoidRequests.mode,
      })
      .from(orders)
      .leftJoin(orderItems, eq(orderItems.orderId, orders.id))
      .leftJoin(
        orderItemVoidRequests,
        and(eq(orderItemVoidRequests.orderItemId, orderItems.id), eq(orderItemVoidRequests.status, 'pending')),
      )
      .where(and(eq(orders.tenantId, ctx.tenant.id), inArray(orders.bookingId, bookingIds)))
      .orderBy(asc(orders.createdAt), asc(orderItems.id)),
  )
}

/**
 * The manager approval queue: every void/comp request still awaiting a
 * decision for the branch, oldest first — table, item, amount, who asked,
 * why (components/orders/VoidRequestsQueue.tsx).
 */
export function listPendingVoidRequests(ctx: ActiveContext, branchId: string) {
  return withUser(ctx.user.id, (tx) =>
    tx
      .select({
        requestId: orderItemVoidRequests.id,
        mode: orderItemVoidRequests.mode,
        reason: orderItemVoidRequests.reason,
        requestedAt: orderItemVoidRequests.requestedAt,
        requestedByName: memberships.fullName,
        itemName: orderItems.itemName,
        qty: orderItems.qty,
        lineTotal: orderItems.lineTotal,
        orderNumber: orders.orderNumber,
        bookingNumber: bookings.bookingNumber,
        tableName: resources.name,
      })
      .from(orderItemVoidRequests)
      .innerJoin(orderItems, eq(orderItems.id, orderItemVoidRequests.orderItemId))
      .innerJoin(orders, eq(orders.id, orderItems.orderId))
      .leftJoin(bookings, eq(bookings.id, orders.bookingId))
      .leftJoin(resources, eq(resources.id, bookings.resourceId))
      .leftJoin(memberships, eq(memberships.id, orderItemVoidRequests.requestedBy))
      .where(
        and(
          eq(orderItemVoidRequests.tenantId, ctx.tenant.id),
          eq(orderItemVoidRequests.status, 'pending'),
          eq(orders.branchId, branchId),
        ),
      )
      .orderBy(asc(orderItemVoidRequests.requestedAt)),
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

/** Flat order+item rows for a branch's pay-now orders still waiting on their
 *  Razorpay webhook (acceptanceStatus='awaiting_payment', migration 0058) —
 *  read-only visibility for staff so a delayed/missing webhook doesn't leave
 *  a paid-for order silently invisible. Same shape as listIncomingOnlineOrders
 *  (see components/orders/IncomingOrdersQueue.tsx). */
export function listAwaitingPaymentOrders(ctx: ActiveContext, branchId: string) {
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
          eq(orders.acceptanceStatus, 'awaiting_payment'),
        ),
      )
      .orderBy(asc(orders.createdAt), asc(orderItems.id)),
  )
}
