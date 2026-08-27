/**
 * Placing and cancelling a food order — the transactional core of the POS
 * order flow.
 *
 * Takes a `tx` rather than opening its own, exactly like lib/billing/invoice.ts:
 * the caller (a server action, or a test script) supplies an RLS-scoped
 * transaction via withUser(), and everything here — the order, its items and
 * its kitchen ticket — commits or rolls back together. A customer can never
 * be charged for food the kitchen was never told about, and the kitchen can
 * never be shown a ticket for an order that failed to save.
 */
import { and, eq, inArray, ne, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type * as schema from '@/db/schema'
import { orders, orderItems, menuItems, taxRates, bookings, happyHours, kots } from '@/db/schema'
import { applyHappyHour } from '@/lib/happy-hours/apply'
import { todayInZone } from '@/lib/booking/time'
import { getActiveBookingForResource, ACTIVE_BOOKING_STATUSES } from '@/lib/booking/attribution'

type Db = NodePgDatabase<typeof schema>

/** Order rule violations the caller is allowed to show verbatim. */
export class OrderError extends Error {}

export type CreateOrderItemInput = {
  menuItemId: string
  qty: number
  specialInstructions?: string
}

export type CreateOrderInput = {
  branchId: string
  bookingId?: string
  // Attribution (migration 0047). channel defaults to 'staff' so every
  // existing caller (the POS flow) is unaffected. customerId/resourceId are
  // for the online-ordering path: when resourceId is given and bookingId
  // wasn't, the order auto-attaches to that station's active booking (see
  // getActiveBookingForResource) — otherwise it stays standalone.
  channel?: 'staff' | 'online'
  // Accept/reject gate (migration 0050). Defaults to 'accepted' — only
  // placeOnlineOrder (lib/actions/public-orders.ts) ever passes 'pending' or
  // 'awaiting_payment'. 'pending' is the auto-accept-off staff review queue;
  // 'awaiting_payment' (migration 0051) is a standalone order that chose
  // pay-now — invisible to that queue AND to /kitchen until
  // lib/payments/webhook.ts flips it to 'accepted' on confirmed payment.
  acceptanceStatus?: 'pending' | 'accepted' | 'awaiting_payment'
  customerId?: string
  resourceId?: string
  // Idempotency (migration 0058) — a client-generated key that stays the
  // same across retries of ONE checkout/take-order attempt (a network retry,
  // or an impatient double-tap on "Place order"), but changes for every new
  // attempt. See the early return below.
  idempotencyKey?: string
  items: CreateOrderItemInput[]
}

export type CreatedOrder = { id: string; orderNumber: string; kotNumber: string }

/**
 * Next `PREFIX-YYYYMMDD-NNN` number for the tenant, atomically — same
 * mechanism as lib/billing/invoice.ts:nextInvoiceNumber, against the same
 * `sequences` table (0018), keyed by (tenant, kind, period) instead of this
 * function's own row. The upsert's row lock is what makes it race-proof: two
 * orders created in the same instant serialize on that one row instead of
 * both reading the same `count(*)` and colliding on the unique order/KOT
 * number index — which is exactly what the previous `count(*) + 1` version
 * of this could do once online ordering opened the door to many concurrent,
 * unauthenticated customers instead of one staff POS terminal at a time.
 */
async function nextDailyNumber(tx: Db, tenantId: string, kind: 'order' | 'kot', period: string): Promise<string> {
  const prefix = kind === 'order' ? 'OR' : 'KOT'
  const result = await tx.execute<{ value: number }>(sql`
    insert into sequences (tenant_id, kind, period, value)
    values (${tenantId}, ${kind}, ${period}, 1)
    on conflict (tenant_id, kind, period)
      do update set value = sequences.value + 1
    returning value
  `)
  const value = Number(result.rows[0].value)
  return `${prefix}-${period}-${String(value).padStart(3, '0')}`
}

/**
 * Look an order up by its idempotency key — the retry path for BOTH the
 * common case (createOrderCore's own pre-check, same transaction) and the
 * rare race (two requests with the same key both passed that pre-check and
 * collided on orders_tenant_idempotency_key; the loser's transaction is
 * already aborted by then, so its caller re-runs this in a FRESH one instead
 * — see placeOnlineOrder/createOrder).
 */
export async function findOrderByIdempotencyKey(
  tx: Db,
  tenantId: string,
  idempotencyKey: string,
): Promise<CreatedOrder | null> {
  const [existing] = await tx
    .select({ id: orders.id, orderNumber: orders.orderNumber, kotNumber: kots.kotNumber })
    .from(orders)
    .innerJoin(kots, eq(kots.orderId, orders.id))
    .where(and(eq(orders.tenantId, tenantId), eq(orders.idempotencyKey, idempotencyKey)))
    .limit(1)
  return existing ?? null
}

/**
 * Place an order: snapshot its items' price/tax/happy-hour discount, then
 * fire a kitchen ticket for it in the SAME transaction.
 */
export async function createOrderCore(
  tx: Db,
  ctx: { tenantId: string; timezone: string; membershipId: string | null },
  input: CreateOrderInput,
): Promise<CreatedOrder> {
  // Idempotency: a retry of an attempt that already succeeded reuses the
  // SAME key, so it lands here and gets the original order back instead of
  // cooking the food twice. Checked before any other work — cheapest
  // possible exit for what should be the common case on a retry.
  if (input.idempotencyKey) {
    const existing = await findOrderByIdempotencyKey(tx, ctx.tenantId, input.idempotencyKey)
    if (existing) return existing
  }

  // Snapshot each item's current name/price/tax so the order stays accurate
  // even if the menu changes later.
  const ids = [...new Set(input.items.map((i) => i.menuItemId))]
  const rows = await tx
    .select({
      id: menuItems.id,
      name: menuItems.name,
      price: menuItems.price,
      taxPercent: taxRates.percent,
    })
    .from(menuItems)
    .leftJoin(taxRates, eq(taxRates.id, menuItems.taxRateId))
    .where(and(eq(menuItems.tenantId, ctx.tenantId), inArray(menuItems.id, ids)))

  const byId = new Map(rows.map((r) => [r.id, r]))
  if (byId.size !== ids.length) throw new OrderError('One or more menu items were not found.')

  // Rules to weigh against every line. Read once per order, then matched in
  // memory — the "is it happy hour right now" decision is made here, on the
  // server, never trusted from the browser.
  const rules = await tx
    .select({
      id: happyHours.id,
      name: happyHours.name,
      daysOfWeek: happyHours.daysOfWeek,
      startTime: happyHours.startTime,
      endTime: happyHours.endTime,
      discountType: happyHours.discountType,
      discountValue: happyHours.discountValue,
      isActive: happyHours.isActive,
    })
    .from(happyHours)
    .where(and(eq(happyHours.tenantId, ctx.tenantId), eq(happyHours.isActive, true)))
  const now = new Date()

  let effectiveBookingId = input.bookingId ?? null
  if (effectiveBookingId) {
    // FOR UPDATE, same as cancelOrderCore/lockPendingOnlineOrder below: a
    // plain SELECT here would only re-check the status as of some earlier
    // moment, not block against it changing underneath us. A staff action
    // that completes/cancels this exact booking (setBookingStatus, a normal
    // UPDATE) takes a row lock for the duration of ITS transaction either
    // way — this lock just makes sure we wait for that to resolve and read
    // the COMMITTED status, instead of racing it and reading stale data.
    const [booking] = await tx
      .select({ id: bookings.id, status: bookings.status })
      .from(bookings)
      .where(and(eq(bookings.id, effectiveBookingId), eq(bookings.tenantId, ctx.tenantId)))
      .for('update')
      .limit(1)
    if (!booking) throw new OrderError('Booking not found.')
    // Re-checked here, inside the transaction that actually creates the order
    // — never trust an earlier, out-of-transaction status read (see
    // getPublicBookingForOrder), which can race a staff action that
    // completes/cancels the booking in between.
    if (!ACTIVE_BOOKING_STATUSES.includes(booking.status as (typeof ACTIVE_BOOKING_STATUSES)[number])) {
      throw new OrderError('This booking is no longer active — food can only be added to an active booking.')
    }
  } else if (input.resourceId) {
    effectiveBookingId = await getActiveBookingForResource(tx, ctx.tenantId, input.resourceId)
  }

  const compact = todayInZone(ctx.timezone).replace(/-/g, '')

  // Order number: OR-YYYYMMDD-NNN, sequential per tenant per creation day.
  const orderNumber = await nextDailyNumber(tx, ctx.tenantId, 'order', compact)

  const [order] = await tx
    .insert(orders)
    .values({
      tenantId: ctx.tenantId,
      branchId: input.branchId,
      bookingId: effectiveBookingId,
      orderNumber,
      status: 'open',
      channel: input.channel ?? 'staff',
      acceptanceStatus: input.acceptanceStatus ?? 'accepted',
      customerId: input.customerId ?? null,
      resourceId: input.resourceId ?? null,
      createdBy: ctx.membershipId,
      idempotencyKey: input.idempotencyKey ?? null,
    })
    .returning({ id: orders.id })

  await tx.insert(orderItems).values(
    input.items.map((i) => {
      const m = byId.get(i.menuItemId)!
      const basePrice = Number(m.price)
      // Every item is in scope: a live rule discounts whatever is ordered
      // inside its time window, with no per-item opt-in required.
      const applied = applyHappyHour(basePrice, rules, now, ctx.timezone)
      const unitPrice = applied ? applied.unitPrice : basePrice
      return {
        tenantId: ctx.tenantId,
        orderId: order.id,
        menuItemId: i.menuItemId,
        itemName: m.name,
        unitPrice: unitPrice.toFixed(2),
        taxRate: Number(m.taxPercent ?? 0).toFixed(2),
        qty: i.qty,
        lineTotal: (unitPrice * i.qty).toFixed(2),
        specialInstructions: i.specialInstructions || null,
        // Snapshot so an edited/deleted happy-hour rule never changes what
        // this line already charged.
        happyHourId: applied?.rule.id ?? null,
        happyHourName: applied?.rule.name ?? null,
        originalUnitPrice: applied ? basePrice.toFixed(2) : null,
        happyHourDiscountType: applied?.rule.discountType ?? null,
        happyHourDiscountValue: applied ? Number(applied.rule.discountValue).toFixed(2) : null,
      }
    }),
  )

  // A kitchen ticket is born the instant the order is — same transaction, so
  // the order and its KOT save together or not at all. The kitchen can never
  // be left not knowing about food that was actually ordered, and there can
  // never be a ghost ticket for an order that failed to save.
  //
  // GRANULARITY: one KOT per order, always — there is no kitchen-station
  // concept yet (grill vs bar vs dessert), so a burger and a coke land on the
  // same ticket. Splitting one order into several station-scoped KOTs is a
  // future enhancement, not something to build ahead of need here.
  const kotNumber = await nextDailyNumber(tx, ctx.tenantId, 'kot', compact)

  await tx.insert(kots).values({
    tenantId: ctx.tenantId,
    branchId: input.branchId,
    orderId: order.id,
    kotNumber,
    status: 'pending',
  })

  return { id: order.id, orderNumber, kotNumber }
}

/**
 * Cancel the kitchen tickets for the given orders — shared by cancelOrderCore
 * and cancelOpenOrdersForBooking below.
 *
 * A ticket already `served` is left alone: the food is already out the door,
 * so cancelling the order at that point is a billing decision, not a kitchen
 * one.
 */
async function cancelKotsForOrders(tx: Db, tenantId: string, orderIds: string[]): Promise<void> {
  if (orderIds.length === 0) return
  await tx
    .update(kots)
    .set({ status: 'cancelled' })
    .where(
      and(
        inArray(kots.orderId, orderIds),
        eq(kots.tenantId, tenantId),
        ne(kots.status, 'served'),
        ne(kots.status, 'cancelled'),
      ),
    )
}

/**
 * Cancel an order: only an `open` (unbilled) order may be cancelled, and
 * cancelling it also cancels its kitchen ticket — the kitchen must not cook,
 * or keep cooking, a voided order.
 */
export async function cancelOrderCore(
  tx: Db,
  ctx: { tenantId: string },
  orderId: string,
): Promise<void> {
  const [order] = await tx
    .select({ status: orders.status })
    .from(orders)
    .where(and(eq(orders.id, orderId), eq(orders.tenantId, ctx.tenantId)))
    .for('update')
    .limit(1)
  if (!order) throw new OrderError('Order not found.')
  if (order.status === 'cancelled') throw new OrderError('This order is already cancelled.')
  if (order.status === 'billed') {
    throw new OrderError('This order has already been billed and cannot be cancelled.')
  }

  await tx
    .update(orders)
    .set({ status: 'cancelled' })
    .where(and(eq(orders.id, orderId), eq(orders.tenantId, ctx.tenantId)))

  await cancelKotsForOrders(tx, ctx.tenantId, [orderId])
}

/**
 * Accept a pending online order — the only move that lets its kitchen ticket
 * (already sitting in the database since createOrderCore, status 'pending')
 * start showing up on /kitchen: listActiveKots requires acceptanceStatus =
 * 'accepted' precisely so an unreviewed order never reaches the kitchen.
 */
export async function acceptOrderCore(tx: Db, ctx: { tenantId: string }, orderId: string): Promise<void> {
  const order = await lockPendingOnlineOrder(tx, ctx.tenantId, orderId)

  await tx
    .update(orders)
    .set({ acceptanceStatus: 'accepted' })
    .where(and(eq(orders.id, order.id), eq(orders.tenantId, ctx.tenantId)))
}

/**
 * Reject a pending online order: cancels the order AND its kitchen ticket
 * (like cancelOrderCore) and records why, so the customer/receipt can explain
 * it later. Unlike a plain cancellation this can only happen before the order
 * was ever accepted — once accepted it's in the normal kitchen flow and must
 * go through cancelOrderCore instead.
 */
export async function rejectOrderCore(
  tx: Db,
  ctx: { tenantId: string },
  orderId: string,
  reason: string,
): Promise<void> {
  const order = await lockPendingOnlineOrder(tx, ctx.tenantId, orderId)

  await tx
    .update(orders)
    .set({ status: 'cancelled', acceptanceStatus: 'rejected', rejectionReason: reason })
    .where(and(eq(orders.id, order.id), eq(orders.tenantId, ctx.tenantId)))

  await cancelKotsForOrders(tx, ctx.tenantId, [order.id])
}

/** Shared lock/validate step for acceptOrderCore and rejectOrderCore. */
async function lockPendingOnlineOrder(
  tx: Db,
  tenantId: string,
  orderId: string,
): Promise<{ id: string }> {
  const [order] = await tx
    .select({ id: orders.id, channel: orders.channel, acceptanceStatus: orders.acceptanceStatus })
    .from(orders)
    .where(and(eq(orders.id, orderId), eq(orders.tenantId, tenantId)))
    .for('update')
    .limit(1)
  if (!order) throw new OrderError('Order not found.')
  if (order.channel !== 'online') throw new OrderError('Only online orders go through the accept/reject queue.')
  if (order.acceptanceStatus !== 'pending') {
    throw new OrderError(`This order has already been ${order.acceptanceStatus}.`)
  }
  return order
}

/**
 * Cancel every still-open order attached to a booking, and their kitchen
 * tickets — called from lib/actions/bookings.ts whenever a BOOKING is
 * cancelled. That is the only cancellation path reachable from the UI today
 * (there is no standalone "cancel order" button), and without this cascade a
 * cancelled booking's food would sit there with the kitchen still cooking it.
 *
 * Unlike cancelOrderCore this never throws: a booking can carry a mix of
 * open, billed and already-cancelled orders, and only the open ones are this
 * cascade's business. A billed order already has its own invoice to answer
 * to — cancelling the booking is not a billing decision.
 */
export async function cancelOpenOrdersForBooking(
  tx: Db,
  ctx: { tenantId: string },
  bookingId: string,
): Promise<void> {
  const openOrders = await tx
    .select({ id: orders.id })
    .from(orders)
    .where(and(eq(orders.bookingId, bookingId), eq(orders.tenantId, ctx.tenantId), eq(orders.status, 'open')))
  if (openOrders.length === 0) return

  const orderIds = openOrders.map((o) => o.id)

  await tx
    .update(orders)
    .set({ status: 'cancelled' })
    .where(and(inArray(orders.id, orderIds), eq(orders.tenantId, ctx.tenantId)))

  await cancelKotsForOrders(tx, ctx.tenantId, orderIds)
}
