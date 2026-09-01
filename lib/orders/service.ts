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
import { randomUUID } from 'node:crypto'
import { and, eq, inArray, ne, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type * as schema from '@/db/schema'
import {
  orders,
  orderItems,
  orderItemModifiers,
  orderItemVoidRequests,
  menuItems,
  modifierGroups,
  modifierOptions,
  menuItemModifierGroups,
  taxRates,
  bookings,
  happyHours,
  kots,
  auditLog,
} from '@/db/schema'
import { applyHappyHour } from '@/lib/happy-hours/apply'
import { todayInZone } from '@/lib/booking/time'
import { getActiveBookingForResource, ACTIVE_BOOKING_STATUSES } from '@/lib/booking/attribution'
import { isManager, type MemberRole } from '@/lib/auth/roles'

type Db = NodePgDatabase<typeof schema>

/** Order rule violations the caller is allowed to show verbatim. */
export class OrderError extends Error {}

export type CreateOrderItemInput = {
  menuItemId: string
  qty: number
  specialInstructions?: string
  // Structured choices (M17 #8) — a size, an add-on, "no onions" — as
  // opposed to specialInstructions' free text. Each id must be a
  // modifier_options row belonging to a group actually attached to this
  // menu item (see menuItemModifierGroups below); createOrderCore validates
  // both that and every attached group's min/max, and snapshots the chosen
  // options' name + price delta onto order_item_modifiers.
  modifierOptionIds?: string[]
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
  // Pins orders_public_select/kots_public_select (migration 0060) to this
  // one key for a public (withPublicTenant) caller — a no-op for a staff
  // (withUser) caller, which reads via the separate, unaffected
  // orders_rw/kots_select policies instead.
  await tx.execute(sql`select set_config('app.public_order_idempotency_key', ${idempotencyKey}, true)`)
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
      status: menuItems.status,
      taxPercent: taxRates.percent,
    })
    .from(menuItems)
    .leftJoin(taxRates, eq(taxRates.id, menuItems.taxRateId))
    .where(and(eq(menuItems.tenantId, ctx.tenantId), inArray(menuItems.id, ids)))

  const byId = new Map(rows.map((r) => [r.id, r]))
  if (byId.size !== ids.length) throw new OrderError('One or more menu items were not found.')

  // The true authority, not just a UI filter: the picker (TakeOrderDialog)
  // already hides 'hidden' items and shows 'out_of_stock' ones disabled, but
  // a stale client (a menu that went 86'd after the screen loaded) or a
  // replayed request must not still be able to place them.
  for (const r of rows) {
    if (r.status !== 'available') {
      throw new OrderError(`${r.name} is not available right now.`)
    }
  }

  // Modifier groups attached to any of the ordered items (M17 #8), keyed by
  // menu item — what a client is even allowed to choose from for that item,
  // and the min/max it must respect. Read once per order, same "trust
  // nothing from the browser but the ids" discipline as menuItems above.
  const groupLinkRows = await tx
    .select({
      menuItemId: menuItemModifierGroups.menuItemId,
      groupId: modifierGroups.id,
      groupName: modifierGroups.name,
      minSelect: modifierGroups.minSelect,
      maxSelect: modifierGroups.maxSelect,
    })
    .from(menuItemModifierGroups)
    .innerJoin(modifierGroups, eq(modifierGroups.id, menuItemModifierGroups.groupId))
    .where(and(eq(menuItemModifierGroups.tenantId, ctx.tenantId), inArray(menuItemModifierGroups.menuItemId, ids)))

  const groupsByMenuItem = new Map<string, typeof groupLinkRows>()
  for (const link of groupLinkRows) {
    const list = groupsByMenuItem.get(link.menuItemId) ?? []
    list.push(link)
    groupsByMenuItem.set(link.menuItemId, list)
  }

  // Every option any line asked for, resolved and tenant-checked in one
  // query — cheaper than one query per line, and the existence check below
  // catches a deleted/foreign option id the same way byId.size does for
  // menu items above.
  const requestedOptionIds = [...new Set(input.items.flatMap((i) => i.modifierOptionIds ?? []))]
  const optionRows =
    requestedOptionIds.length === 0
      ? []
      : await tx
          .select({
            id: modifierOptions.id,
            name: modifierOptions.name,
            priceDelta: modifierOptions.priceDelta,
            groupId: modifierOptions.groupId,
            groupName: modifierGroups.name,
          })
          .from(modifierOptions)
          .innerJoin(modifierGroups, eq(modifierGroups.id, modifierOptions.groupId))
          .where(and(eq(modifierOptions.tenantId, ctx.tenantId), inArray(modifierOptions.id, requestedOptionIds)))
  const optionById = new Map(optionRows.map((o) => [o.id, o]))
  if (optionById.size !== requestedOptionIds.length) {
    throw new OrderError('One or more modifier options were not found.')
  }

  /**
   * Validate one line's chosen options against the menu item's attached
   * groups (min/max, and — the part a UI bug or a tampered request could
   * otherwise smuggle past — that every chosen option actually belongs to a
   * group THIS item offers, not just any group in the tenant) and return the
   * priced total to add to the base unit price.
   */
  function resolveLineModifiers(menuItemId: string, optionIds: string[]) {
    const attachedGroups = groupsByMenuItem.get(menuItemId) ?? []
    const selected = optionIds.map((id) => optionById.get(id)!)

    const countByGroup = new Map<string, number>()
    for (const opt of selected) {
      if (!attachedGroups.some((g) => g.groupId === opt.groupId)) {
        throw new OrderError(`"${opt.name}" is not a valid option for this item.`)
      }
      countByGroup.set(opt.groupId, (countByGroup.get(opt.groupId) ?? 0) + 1)
    }

    for (const g of attachedGroups) {
      const count = countByGroup.get(g.groupId) ?? 0
      if (count < g.minSelect) {
        const phrase = g.minSelect === g.maxSelect ? 'exactly' : 'at least'
        throw new OrderError(`Choose ${phrase} ${g.minSelect} option${g.minSelect === 1 ? '' : 's'} for "${g.groupName}".`)
      }
      if (count > g.maxSelect) {
        throw new OrderError(`Choose at most ${g.maxSelect} option${g.maxSelect === 1 ? '' : 's'} for "${g.groupName}".`)
      }
    }

    const deltaSum = selected.reduce((sum, o) => sum + Number(o.priceDelta), 0)
    return { selected, deltaSum }
  }

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
    //
    // Only for a STAFF caller, though (ctx.membershipId set — see
    // lib/actions/orders.ts). Postgres requires a row to also pass the
    // table's UPDATE policy to be lockable with FOR UPDATE, and bookings has
    // no public UPDATE policy (0023) — only public SELECT/INSERT — so under
    // the public connection (lib/actions/public-orders.ts's "add food to
    // your visit" nudge, ctx.membershipId === null) that lock silently
    // matches zero rows and this threw "Booking not found" for every guest.
    // A plain SELECT is safe there: status is re-checked again at billing
    // time (issueInvoiceForBooking), so a guest racing a staff cancellation
    // in this narrow window just gets caught later instead of never.
    const bookingQuery = tx
      .select({ id: bookings.id, status: bookings.status })
      .from(bookings)
      .where(and(eq(bookings.id, effectiveBookingId), eq(bookings.tenantId, ctx.tenantId)))
      .limit(1)
    const [booking] = ctx.membershipId ? await bookingQuery.for('update') : await bookingQuery
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

  // Ids generated here, not left to the table's default, so this same
  // transaction can attach order_item_modifiers rows to the right parent
  // without a second round trip (RETURNING doesn't promise to preserve
  // input order for a multi-row INSERT ... VALUES).
  const preparedItems = input.items.map((i) => {
    const m = byId.get(i.menuItemId)!
    const basePrice = Number(m.price)
    // Every item is in scope: a live rule discounts whatever is ordered
    // inside its time window, with no per-item opt-in required. Only the
    // BASE price is discounted — modifier deltas (extra cheese, a larger
    // size) are added after, at full price, same as a real till would never
    // apply a food discount to an add-on.
    const applied = applyHappyHour(basePrice, rules, now, ctx.timezone)
    const baseUnitPrice = applied ? applied.unitPrice : basePrice
    const { selected, deltaSum } = resolveLineModifiers(i.menuItemId, i.modifierOptionIds ?? [])
    const unitPrice = baseUnitPrice + deltaSum
    const id = randomUUID()
    return {
      id,
      values: {
        id,
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
        // this line already charged. originalUnitPrice is the BASE item's
        // pre-discount price only — never includes modifier deltas, which
        // were never eligible for the discount in the first place.
        happyHourId: applied?.rule.id ?? null,
        happyHourName: applied?.rule.name ?? null,
        originalUnitPrice: applied ? basePrice.toFixed(2) : null,
        happyHourDiscountType: applied?.rule.discountType ?? null,
        happyHourDiscountValue: applied ? Number(applied.rule.discountValue).toFixed(2) : null,
      },
      modifiers: selected.map((o) => ({
        tenantId: ctx.tenantId,
        orderItemId: id,
        modifierOptionId: o.id,
        groupName: o.groupName,
        optionName: o.name,
        priceDelta: Number(o.priceDelta).toFixed(2),
      })),
    }
  })

  await tx.insert(orderItems).values(preparedItems.map((p) => p.values))

  const modifierRows = preparedItems.flatMap((p) => p.modifiers)
  if (modifierRows.length > 0) {
    await tx.insert(orderItemModifiers).values(modifierRows)
  }

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

/**
 * Cancel every still-`pending` (unreviewed) online order on a booking, and
 * their kitchen tickets — called from issueInvoiceForBooking the moment a
 * bill is raised, in the SAME transaction as the invoice.
 *
 * loadFoodLines/the billed-status flip both read `acceptanceStatus =
 * 'accepted'` (see lib/billing/invoice.ts), so a `pending` order is never on
 * the bill and never flips to `billed` — it just sits there, `open` and
 * `pending`, after the invoice closes. Without this cascade, staff could
 * later accept it from /orders/incoming: acceptOrderCore only checks the
 * order itself, not whether its booking was already billed, so the kitchen
 * would cook and serve food against an invoice that already closed — served
 * but never charged. Voiding it here, before that becomes possible, is what
 * closes the gap: an order can no longer become billable after its booking
 * has been billed.
 *
 * Never throws: most bookings have no pending orders at bill time (auto-accept
 * on, or nothing left unreviewed), and that is the common case, not an error.
 */
export async function cancelPendingOrdersForBilledBooking(
  tx: Db,
  ctx: { tenantId: string },
  bookingId: string,
): Promise<void> {
  const pendingOrders = await tx
    .select({ id: orders.id })
    .from(orders)
    .where(
      and(
        eq(orders.bookingId, bookingId),
        eq(orders.tenantId, ctx.tenantId),
        eq(orders.status, 'open'),
        eq(orders.acceptanceStatus, 'pending'),
      ),
    )
  if (pendingOrders.length === 0) return

  const orderIds = pendingOrders.map((o) => o.id)

  await tx
    .update(orders)
    .set({ status: 'cancelled', acceptanceStatus: 'rejected', rejectionReason: 'Booking was billed before this order was reviewed.' })
    .where(and(inArray(orders.id, orderIds), eq(orders.tenantId, ctx.tenantId)))

  await cancelKotsForOrders(tx, ctx.tenantId, orderIds)
}

/**
 * Void/comp actor — same shape as lib/billing/refunds.ts's AuditActor. No
 * shared audit module exists (see lib/booking/service.ts's writeAudit for the
 * same note); each domain keeps its own private copy.
 */
export type AuditActor = { tenantId: string; membershipId: string }

/** Append one audit row. See lib/billing/refunds.ts's writeAudit — identical shape. */
async function writeAudit(
  tx: Db,
  actor: AuditActor,
  entry: {
    action: string
    entityType: string
    entityId: string
    before: Record<string, unknown>
    after: Record<string, unknown>
  },
): Promise<void> {
  await tx.insert(auditLog).values({
    tenantId: actor.tenantId,
    actorMembershipId: actor.membershipId,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId,
    before: entry.before,
    after: entry.after,
  })
}

/**
 * Lock one order_items line together with its parent order and check it is
 * still eligible to be voided/comped. Shared by requestVoidOrderItemCore
 * (the initial check) and applyVoidDecision (the re-check at approval time —
 * time has passed since the request was raised, so the order may have been
 * billed or cancelled in between).
 *
 * FOR UPDATE on both reads: a concurrent bill being raised on the same
 * booking blocks against this exact row instead of racing it.
 */
async function lockActiveOrderItem(tx: Db, tenantId: string, orderItemId: string) {
  const [row] = await tx
    .select({
      itemId: orderItems.id,
      itemName: orderItems.itemName,
      qty: orderItems.qty,
      unitPrice: orderItems.unitPrice,
      lineTotal: orderItems.lineTotal,
      voidStatus: orderItems.voidStatus,
      orderId: orders.id,
      orderStatus: orders.status,
      bookingId: orders.bookingId,
    })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .where(and(eq(orderItems.id, orderItemId), eq(orderItems.tenantId, tenantId)))
    .for('update')
    .limit(1)

  if (!row) throw new OrderError('Order item not found.')
  if (row.voidStatus !== 'active') {
    throw new OrderError(`This item has already been ${row.voidStatus}.`)
  }
  if (row.orderStatus === 'billed') {
    throw new OrderError(
      'This item has already been billed — void or refund the invoice instead of the item.',
    )
  }
  if (row.orderStatus === 'cancelled') {
    throw new OrderError('This order is already cancelled.')
  }
  return row
}

/**
 * The actual money-moving step, shared by requestVoidOrderItemCore's
 * auto-approve path (a manager/owner requesting their own) and
 * decideVoidRequestCore's approve path (a manager approving someone else's
 * request). Re-locks and re-validates the item itself (see
 * lockActiveOrderItem) rather than trusting a row fetched moments — or a
 * request-queue's worth of time — earlier.
 *
 * The row is never deleted, only flagged (migration 0066): loadFoodLines/
 * loadOrderFoodLines (lib/billing/invoice.ts) exclude anything not
 * `void_status = 'active'`, which is what takes the amount off the tab —
 * everything else (the order, the KOT, the row itself) stays exactly as it
 * was, so the void/comp report (M20) still has the original line to read.
 */
async function applyVoidDecision(
  tx: Db,
  actor: AuditActor,
  input: {
    orderItemId: string
    mode: 'void' | 'comp'
    reason: string
    requestId: string
    requestedBy: string | null
  },
): Promise<{ orderId: string; bookingId: string | null }> {
  const row = await lockActiveOrderItem(tx, actor.tenantId, input.orderItemId)
  const newStatus = input.mode === 'void' ? 'voided' : 'comped'

  await tx
    .update(orderItems)
    .set({
      voidStatus: newStatus,
      voidReason: input.reason,
      voidedBy: actor.membershipId,
      voidedAt: new Date(),
    })
    .where(and(eq(orderItems.id, row.itemId), eq(orderItems.tenantId, actor.tenantId)))

  // A VOID is a kitchen mistake that must stop being cooked; a COMP is a
  // billing decision made after the fact (the food was already made, usually
  // already served), so it never touches the ticket.
  //
  // KOTs are one per ORDER, not one per item (see createOrderCore's
  // GRANULARITY note) — there is no kot_items table to cross a single line
  // off of. So this only cancels the ticket once EVERY item on the order has
  // come off the tab (this was the last active one); if other items on the
  // order are still active, the ticket is still genuinely needed and is left
  // alone — the audit row is the record for that item either way. Same
  // "never touch an already-served ticket" rule as cancelKotsForOrders.
  if (input.mode === 'void') {
    const [stillActive] = await tx
      .select({ id: orderItems.id })
      .from(orderItems)
      .where(
        and(
          eq(orderItems.tenantId, actor.tenantId),
          eq(orderItems.orderId, row.orderId),
          eq(orderItems.voidStatus, 'active'),
        ),
      )
      .limit(1)
    if (!stillActive) {
      await cancelKotsForOrders(tx, actor.tenantId, [row.orderId])
    }
  }

  await writeAudit(tx, actor, {
    action: input.mode === 'void' ? 'order_item.void' : 'order_item.comp',
    entityType: 'order_item',
    entityId: row.itemId,
    before: {
      void_status: row.voidStatus,
      item_name: row.itemName,
      qty: row.qty,
      unit_price: row.unitPrice,
      amount: row.lineTotal,
      order_id: row.orderId,
      booking_id: row.bookingId,
    },
    after: {
      void_status: newStatus,
      item_name: row.itemName,
      amount: row.lineTotal,
      order_id: row.orderId,
      booking_id: row.bookingId,
      reason: input.reason,
      request_id: input.requestId,
      requested_by: input.requestedBy,
    },
  })

  return { orderId: row.orderId, bookingId: row.bookingId }
}

export type RequestVoidOrderItemInput = {
  orderItemId: string
  /** 'void' = removed, ordered by mistake. 'comp' = given free. */
  mode: 'void' | 'comp'
  reason: string
}

export type VoidRequestResult = {
  requestId: string
  orderItemId: string
  orderId: string
  bookingId: string | null
  mode: 'void' | 'comp'
  /** 'approved' when the requester was a manager/owner and this was applied
   *  immediately, in the same transaction as the request. 'pending' when it
   *  is now sitting in the manager approval queue. */
  status: 'pending' | 'approved'
}

/**
 * Raise a void/comp request on one order_items line — reasoned, and always
 * recorded, whoever raises it.
 *
 * If the requester is a manager/owner (checked against `actor.role`, which
 * the caller — lib/actions/orders.ts's requestVoidOrderItem — derives from
 * requireContext(), never trusted from the client), this applies it
 * immediately in the SAME transaction: they don't need to ask themselves for
 * permission, and the pending approval queue (decideVoidRequestCore) exists
 * for everyone else's requests. Either way there is exactly one request row
 * and one code path, so the audit trail reads the same regardless of who
 * pulled the trigger.
 */
export async function requestVoidOrderItemCore(
  tx: Db,
  actor: AuditActor & { role: MemberRole },
  input: RequestVoidOrderItemInput,
): Promise<VoidRequestResult> {
  const reason = input.reason.trim()
  if (!reason) throw new OrderError('A reason is required to request a void or comp.')

  const row = await lockActiveOrderItem(tx, actor.tenantId, input.orderItemId)

  // At most one open request per item (also enforced by the DB — see
  // idx_order_item_void_requests_one_pending, migration 0067) — locking the
  // order_item above already serialises two concurrent requesters on the
  // same line, so this read is race-free.
  const [existingPending] = await tx
    .select({ id: orderItemVoidRequests.id })
    .from(orderItemVoidRequests)
    .where(
      and(eq(orderItemVoidRequests.orderItemId, row.itemId), eq(orderItemVoidRequests.status, 'pending')),
    )
    .limit(1)
  if (existingPending) {
    throw new OrderError('A void/comp request is already pending for this item.')
  }

  const [request] = await tx
    .insert(orderItemVoidRequests)
    .values({
      tenantId: actor.tenantId,
      orderItemId: row.itemId,
      mode: input.mode,
      reason,
      requestedBy: actor.membershipId,
    })
    .returning({ id: orderItemVoidRequests.id })

  await writeAudit(tx, actor, {
    action: input.mode === 'void' ? 'order_item.void_requested' : 'order_item.comp_requested',
    entityType: 'order_item_void_request',
    entityId: request.id,
    before: {},
    after: {
      order_item_id: row.itemId,
      item_name: row.itemName,
      amount: row.lineTotal,
      order_id: row.orderId,
      booking_id: row.bookingId,
      reason,
    },
  })

  if (isManager(actor.role)) {
    const { orderId, bookingId } = await applyVoidDecision(tx, actor, {
      orderItemId: row.itemId,
      mode: input.mode,
      reason,
      requestId: request.id,
      requestedBy: actor.membershipId,
    })
    await tx
      .update(orderItemVoidRequests)
      .set({ status: 'approved', decidedBy: actor.membershipId, decidedAt: new Date() })
      .where(eq(orderItemVoidRequests.id, request.id))
    return { requestId: request.id, orderItemId: row.itemId, orderId, bookingId, mode: input.mode, status: 'approved' }
  }

  return {
    requestId: request.id,
    orderItemId: row.itemId,
    orderId: row.orderId,
    bookingId: row.bookingId,
    mode: input.mode,
    status: 'pending',
  }
}

export type DecideVoidRequestInput = {
  requestId: string
  decision: 'approve' | 'reject'
  /** Optional manager note — mainly useful on a reject ("kitchen already remade it"). */
  note?: string
}

export type DecidedVoidRequest = {
  requestId: string
  orderItemId: string
  orderId: string
  bookingId: string | null
  mode: 'void' | 'comp'
  decision: 'approve' | 'reject'
}

/**
 * Approve or reject a pending void/comp request — manager-authorised (the
 * caller, lib/actions/orders.ts's decideVoidRequest, gates on
 * requireManager() before this ever runs).
 *
 * Approving re-validates the item from scratch (applyVoidDecision →
 * lockActiveOrderItem): time has passed since the waiter raised the request,
 * so the order may since have been billed or cancelled — in which case this
 * throws and the request is left `pending` for the manager to reject
 * explicitly, rather than silently mutating anything.
 */
export async function decideVoidRequestCore(
  tx: Db,
  actor: AuditActor,
  input: DecideVoidRequestInput,
): Promise<DecidedVoidRequest> {
  const [request] = await tx
    .select({
      id: orderItemVoidRequests.id,
      orderItemId: orderItemVoidRequests.orderItemId,
      mode: orderItemVoidRequests.mode,
      reason: orderItemVoidRequests.reason,
      status: orderItemVoidRequests.status,
      requestedBy: orderItemVoidRequests.requestedBy,
    })
    .from(orderItemVoidRequests)
    .where(and(eq(orderItemVoidRequests.id, input.requestId), eq(orderItemVoidRequests.tenantId, actor.tenantId)))
    .for('update')
    .limit(1)

  if (!request) throw new OrderError('Request not found.')
  if (request.status !== 'pending') {
    throw new OrderError(`This request has already been ${request.status}.`)
  }

  const note = input.note?.trim() || null

  if (input.decision === 'reject') {
    await tx
      .update(orderItemVoidRequests)
      .set({ status: 'rejected', decidedBy: actor.membershipId, decidedAt: new Date(), decisionNote: note })
      .where(eq(orderItemVoidRequests.id, request.id))

    await writeAudit(tx, actor, {
      action: request.mode === 'void' ? 'order_item.void_rejected' : 'order_item.comp_rejected',
      entityType: 'order_item_void_request',
      entityId: request.id,
      before: { status: 'pending' },
      after: { status: 'rejected', order_item_id: request.orderItemId, reason: request.reason, note },
    })

    // The item itself never moved — just enough to let the caller revalidate
    // the right pages.
    const [item] = await tx
      .select({ orderId: orderItems.orderId, bookingId: orders.bookingId })
      .from(orderItems)
      .innerJoin(orders, eq(orders.id, orderItems.orderId))
      .where(eq(orderItems.id, request.orderItemId))
      .limit(1)

    return {
      requestId: request.id,
      orderItemId: request.orderItemId,
      orderId: item?.orderId ?? '',
      bookingId: item?.bookingId ?? null,
      mode: request.mode,
      decision: 'reject',
    }
  }

  const { orderId, bookingId } = await applyVoidDecision(tx, actor, {
    orderItemId: request.orderItemId,
    mode: request.mode,
    reason: request.reason,
    requestId: request.id,
    requestedBy: request.requestedBy,
  })

  await tx
    .update(orderItemVoidRequests)
    .set({ status: 'approved', decidedBy: actor.membershipId, decidedAt: new Date(), decisionNote: note })
    .where(eq(orderItemVoidRequests.id, request.id))

  return {
    requestId: request.id,
    orderItemId: request.orderItemId,
    orderId,
    bookingId,
    mode: request.mode,
    decision: 'approve',
  }
}
