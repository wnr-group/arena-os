import 'server-only'
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm'
import { withPublicTenant } from '@/db'
import { orders, orderItems, kots, customers } from '@/db/schema'
import type { KotStatus } from '@/lib/kots/service'
import { normalizePhone } from '@/lib/customers/phone'

/**
 * One customer-facing status derived from acceptanceStatus + this order's
 * KOT(s) — see deriveCustomerOrderStatus below for the mapping.
 */
export type CustomerOrderStatus =
  | 'awaiting_payment'
  | 'placed'
  | 'preparing'
  | 'ready'
  | 'served'
  | 'rejected'
  | 'cancelled'

const KOT_RANK: Record<KotStatus, number> = {
  pending: 0,
  preparing: 1,
  ready: 2,
  served: 3,
  cancelled: -1,
}

/**
 * acceptanceStatus is the earlier gate (has a human/payment confirmed this
 * order exists at all?); once 'accepted', the furthest-along non-cancelled
 * KOT decides the rest. Written against a LIST of KOTs, not an assumed single
 * row — createOrderCore is 1:1 today "by explicit design, not accident" but
 * documents multi-KOT-per-order as a future enhancement; this shouldn't be a
 * second place that needs revisiting when that lands.
 */
export function deriveCustomerOrderStatus(
  acceptanceStatus: 'pending' | 'accepted' | 'rejected' | 'awaiting_payment',
  kotStatuses: KotStatus[],
): CustomerOrderStatus {
  if (acceptanceStatus === 'rejected') return 'rejected'
  if (acceptanceStatus === 'awaiting_payment') return 'awaiting_payment'
  if (acceptanceStatus === 'pending') return 'placed'

  const active = kotStatuses.filter((s) => s !== 'cancelled')
  if (active.length === 0) return kotStatuses.length > 0 ? 'cancelled' : 'placed'

  const furthest = active.reduce((best, s) => (KOT_RANK[s] > KOT_RANK[best] ? s : best), active[0])
  switch (furthest) {
    case 'preparing':
      return 'preparing'
    case 'ready':
      return 'ready'
    case 'served':
      return 'served'
    default:
      return 'placed'
  }
}

export type PublicOrderItem = {
  itemId: string
  itemName: string
  qty: number
  specialInstructions: string | null
  lineTotal: string
}

export type PublicOrderStatus = {
  orderNumber: string
  createdAt: string
  status: CustomerOrderStatus
  rejectionReason: string | null
  items: PublicOrderItem[]
}

/**
 * Look an order up by id for the public status page (app/(public)/o/[orderId])
 * — the same trust model as lib/booking/public-confirmation.ts's
 * getPublicBookingByToken: RLS (orders_public_select/kots_public_select/
 * order_items_public_select, migrations 0049/0053) only scopes reads to the
 * pinned tenant; filtering by this SPECIFIC (non-guessable, random) order id
 * is what actually stops enumeration. orders.id is used directly rather than
 * a dedicated confirmation-token column — it's already the same entropy
 * class, and is exactly what order_items_public_select's own trust model
 * already assumes callers use.
 */
export async function getPublicOrderStatus(tenantId: string, orderId: string): Promise<PublicOrderStatus | null> {
  return withPublicTenant(tenantId, async (tx) => {
    // Pins orders_public_select/order_items_public_select/kots_public_select
    // (migration 0060) to this one order — the id is already this function's
    // whole trust boundary (see the doc comment above), now enforced by the
    // database too, not just by every reader here remembering to filter by it.
    await tx.execute(sql`select set_config('app.public_order_id', ${orderId}, true)`)
    const [order] = await tx
      .select({
        orderNumber: orders.orderNumber,
        acceptanceStatus: orders.acceptanceStatus,
        rejectionReason: orders.rejectionReason,
        createdAt: orders.createdAt,
      })
      .from(orders)
      .where(and(eq(orders.tenantId, tenantId), eq(orders.id, orderId)))
      .limit(1)
    if (!order) return null

    const kotRows = await tx
      .select({ status: kots.status })
      .from(kots)
      .where(and(eq(kots.tenantId, tenantId), eq(kots.orderId, orderId)))

    const itemRows = await tx
      .select({
        itemId: orderItems.id,
        itemName: orderItems.itemName,
        qty: orderItems.qty,
        specialInstructions: orderItems.specialInstructions,
        lineTotal: orderItems.lineTotal,
      })
      .from(orderItems)
      .where(and(eq(orderItems.tenantId, tenantId), eq(orderItems.orderId, orderId)))
      .orderBy(orderItems.id)

    return {
      orderNumber: order.orderNumber,
      createdAt: order.createdAt.toISOString(),
      status: deriveCustomerOrderStatus(order.acceptanceStatus, kotRows.map((k) => k.status)),
      rejectionReason: order.rejectionReason,
      items: itemRows,
    }
  })
}

export type PublicOrderSummary = {
  orderId: string
  orderNumber: string
  createdAt: string
  status: CustomerOrderStatus
}

/** How far back the "track order" phone lookup looks — bounds what a stranger
 *  who knows/guesses someone's phone number could see (next paragraph), and
 *  matches the feature's actual use case: checking on food ordered recently,
 *  not browsing months of history. */
const RECENT_LOOKUP_WINDOW_MS = 48 * 60 * 60 * 1000

/**
 * Recent orders for a phone number — the food-order half of the "My Booking"
 * hub (lib/actions/my-bookings.ts's lookupMyBookings). Deliberately narrow,
 * the same discipline lookupPublicCustomerByPhone already applies to a plain
 * boolean: no items, no prices, no customer name — just orderNumber/status/
 * date, and only from the last 48h. This is a real, accepted trust
 * trade-off: there is no OTP/account system yet (M9) to verify the caller
 * actually owns this phone number, so anyone who knows (or guesses) it can
 * see this much. Widening what's returned, or the time window, should be
 * revisited once M9 lands.
 */
export async function getRecentPublicOrdersByPhone(tenantId: string, rawPhone: string): Promise<PublicOrderSummary[]> {
  const phone = normalizePhone(rawPhone)
  if (!phone) return []

  return withPublicTenant(tenantId, async (tx) => {
    const [customer] = await tx
      .select({ id: customers.id })
      .from(customers)
      .where(and(eq(customers.tenantId, tenantId), eq(customers.phone, phone)))
      .limit(1)
    if (!customer) return []

    // Pins orders_public_select/kots_public_select (migration 0060) to this
    // one customer — the customer row just resolved by phone above is
    // already this function's whole trust boundary (see the doc comment
    // above), now enforced by the database too.
    await tx.execute(sql`select set_config('app.public_customer_id', ${customer.id}, true)`)

    const since = new Date(Date.now() - RECENT_LOOKUP_WINDOW_MS)
    const orderRows = await tx
      .select({
        id: orders.id,
        orderNumber: orders.orderNumber,
        acceptanceStatus: orders.acceptanceStatus,
        createdAt: orders.createdAt,
      })
      .from(orders)
      .where(and(eq(orders.tenantId, tenantId), eq(orders.customerId, customer.id), gte(orders.createdAt, since)))
      .orderBy(desc(orders.createdAt))
      .limit(5)
    if (orderRows.length === 0) return []

    const kotRows = await tx
      .select({ orderId: kots.orderId, status: kots.status })
      .from(kots)
      .where(
        and(
          eq(kots.tenantId, tenantId),
          inArray(
            kots.orderId,
            orderRows.map((o) => o.id),
          ),
        ),
      )
    const kotsByOrder = new Map<string, KotStatus[]>()
    for (const row of kotRows) {
      kotsByOrder.set(row.orderId, [...(kotsByOrder.get(row.orderId) ?? []), row.status])
    }

    return orderRows.map((o) => ({
      orderId: o.id,
      orderNumber: o.orderNumber,
      createdAt: o.createdAt.toISOString(),
      status: deriveCustomerOrderStatus(o.acceptanceStatus, kotsByOrder.get(o.id) ?? []),
    }))
  })
}
