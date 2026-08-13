import 'server-only'
import { and, asc, eq, notInArray } from 'drizzle-orm'
import { withUser } from '@/db'
import { kots, orders, orderItems } from '@/db/schema'
import type { ActiveContext } from '@/lib/tenant/context'

/** Flat KOT+item rows for a branch's active tickets — grouped by the caller (see components/kitchen/KitchenQueue.tsx). */
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
        itemId: orderItems.id,
        itemName: orderItems.itemName,
        qty: orderItems.qty,
        specialInstructions: orderItems.specialInstructions,
      })
      .from(kots)
      .innerJoin(orders, eq(orders.id, kots.orderId))
      .leftJoin(orderItems, eq(orderItems.orderId, orders.id))
      .where(
        and(
          eq(kots.tenantId, ctx.tenant.id),
          eq(kots.branchId, branchId),
          notInArray(kots.status, ['served', 'cancelled']),
        ),
      )
      .orderBy(asc(kots.createdAt), asc(orderItems.id)),
  )
}
