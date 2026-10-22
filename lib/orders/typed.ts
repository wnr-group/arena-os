/**
 * Takeaway & delivery orders — the transactional core (M20 / AROS-182).
 *
 * No new pipeline: a typed order is created by createOrderCore (menu, pricing
 * snapshot, KOT — so it reaches the kitchen like any order) with no booking and
 * no table, and is billed by issueInvoiceForOrder, the same function the online
 * pay-now webhook uses. What this adds is the order's TYPE and details, the
 * staff "take payment" step the pay-at-pickup path never had, and the handover
 * steps after the kitchen is done. See typed-rules.ts for the status model.
 */
import 'server-only'
import { and, asc, eq, inArray, ne, or, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type * as schema from '@/db/schema'
import { auditLog, invoices, kots, orderItems, orderItemModifiers, orderSettings, orders } from '@/db/schema'
import { OrderError, cancelOrderCore, createOrderCore, type CreateOrderItemInput } from './service'
import { issueInvoiceForOrder } from '@/lib/billing/invoice'
import { recordPaymentForInvoice, type RecordPaymentResult } from '@/lib/billing/payments'
import type { PosPaymentMethod } from '@/lib/billing/payments'
import { deductStockForOrders } from '@/lib/inventory/deduct'
import {
  type HandoverStatus,
  type OrderStage,
  type TypedOrderType,
  orderStage,
  typeEnabled,
  validateHandover,
  validateTypedOrder,
} from './typed-rules'

type Db = NodePgDatabase<typeof schema>
type Ctx = { tenantId: string; timezone: string; membershipId: string | null }

export type TypedOrderSettings = {
  takeawayEnabled: boolean
  deliveryEnabled: boolean
  defaultDeliveryFee: number
  deliveryFeeTaxRate: number
}
const DEFAULT_SETTINGS: TypedOrderSettings = { takeawayEnabled: false, deliveryEnabled: false, defaultDeliveryFee: 0, deliveryFeeTaxRate: 0 }

export async function getTypedOrderSettingsCore(tx: Db, tenantId: string): Promise<TypedOrderSettings> {
  const [row] = await tx
    .select({
      takeawayEnabled: orderSettings.takeawayEnabled,
      deliveryEnabled: orderSettings.deliveryEnabled,
      defaultDeliveryFee: orderSettings.defaultDeliveryFee,
      deliveryFeeTaxRate: orderSettings.deliveryFeeTaxRate,
    })
    .from(orderSettings)
    .where(eq(orderSettings.tenantId, tenantId))
    .limit(1)
  return row
    ? { ...row, defaultDeliveryFee: Number(row.defaultDeliveryFee), deliveryFeeTaxRate: Number(row.deliveryFeeTaxRate) }
    : DEFAULT_SETTINGS
}

export function validateTypedSettings(s: TypedOrderSettings): string | null {
  if (!Number.isFinite(s.defaultDeliveryFee) || s.defaultDeliveryFee < 0 || s.defaultDeliveryFee > 100000) return 'Delivery fee must be zero or more.'
  if (!Number.isFinite(s.deliveryFeeTaxRate) || s.deliveryFeeTaxRate < 0 || s.deliveryFeeTaxRate > 100) return 'Delivery fee GST must be between 0 and 100%.'
  return null
}

export async function saveTypedOrderSettingsCore(
  tx: Db,
  a: { tenantId: string; membershipId: string | null },
  s: TypedOrderSettings,
): Promise<void> {
  const problem = validateTypedSettings(s)
  if (problem) throw new OrderError(problem)
  const values = {
    takeawayEnabled: s.takeawayEnabled,
    deliveryEnabled: s.deliveryEnabled,
    defaultDeliveryFee: s.defaultDeliveryFee.toFixed(2),
    deliveryFeeTaxRate: s.deliveryFeeTaxRate.toFixed(2),
  }
  const before = await getTypedOrderSettingsCore(tx, a.tenantId)
  await tx.insert(orderSettings).values({ tenantId: a.tenantId, ...values }).onConflictDoUpdate({ target: orderSettings.tenantId, set: values })
  await tx.insert(auditLog).values({
    tenantId: a.tenantId,
    actorMembershipId: a.membershipId,
    action: 'order_settings.typed_changed',
    entityType: 'order_settings',
    entityId: a.tenantId,
    before: before as unknown as Record<string, unknown>,
    after: s as unknown as Record<string, unknown>,
  })
}

export type CreateTypedOrderInput = {
  branchId: string
  orderType: TypedOrderType
  contactName: string
  contactPhone?: string
  pickupAt?: Date | null
  deliveryAddress?: string
  /** Overrides the venue's default delivery fee (e.g. free delivery); GST rate always comes from settings. */
  deliveryFee?: number
  notes?: string
  idempotencyKey?: string
  items: CreateOrderItemInput[]
}

/**
 * Create a takeaway / delivery order for staff. Lands in the kitchen straight
 * away (staff-placed orders are accepted). Never touches a table or booking.
 */
export async function createTypedOrderCore(tx: Db, ctx: Ctx, input: CreateTypedOrderInput) {
  const settings = await getTypedOrderSettingsCore(tx, ctx.tenantId)
  if (!typeEnabled(settings, input.orderType)) {
    throw new OrderError(`${input.orderType === 'takeaway' ? 'Takeaway' : 'Delivery'} orders are not turned on for this business.`)
  }
  if (input.items.length === 0) throw new OrderError('Add at least one item.')

  const fee = input.orderType === 'delivery' ? (input.deliveryFee ?? settings.defaultDeliveryFee) : 0
  const problem = validateTypedOrder({
    orderType: input.orderType,
    contactName: input.contactName,
    contactPhone: input.contactPhone,
    deliveryAddress: input.deliveryAddress,
    deliveryFee: fee,
    deliveryFeeTaxRate: settings.deliveryFeeTaxRate,
    pickupAt: input.pickupAt,
  })
  if (problem) throw new OrderError(problem)

  return createOrderCore(tx, ctx, {
    branchId: input.branchId,
    channel: 'staff',
    idempotencyKey: input.idempotencyKey,
    items: input.items,
    typed: {
      orderType: input.orderType,
      contactName: input.contactName,
      contactPhone: input.contactPhone,
      pickupAt: input.pickupAt ?? null,
      deliveryAddress: input.deliveryAddress,
      deliveryFee: fee,
      deliveryFeeTaxRate: settings.deliveryFeeTaxRate,
      notes: input.notes,
    },
  })
}

async function lockTypedOrder(tx: Db, tenantId: string, orderId: string) {
  const [o] = await tx
    .select()
    .from(orders)
    .where(and(eq(orders.id, orderId), eq(orders.tenantId, tenantId)))
    .for('update')
    .limit(1)
  if (!o) throw new OrderError('Order not found.')
  if (o.orderType === 'dine_in') throw new OrderError('That is a table order — it is handled from the floor.')
  return o
}

async function kotStatusOf(tx: Db, tenantId: string, orderId: string): Promise<string | null> {
  const [k] = await tx.select({ status: kots.status }).from(kots).where(and(eq(kots.orderId, orderId), eq(kots.tenantId, tenantId))).limit(1)
  return k?.status ?? null
}

/**
 * Move an order through its handover: collected (takeaway) or
 * out_for_delivery → delivered. Only once the kitchen has finished it; the
 * row is locked so two screens can't both advance it.
 */
export async function handoverTypedOrderCore(
  tx: Db,
  a: { tenantId: string; membershipId: string | null },
  input: { orderId: string; to: HandoverStatus; driverName?: string; driverPhone?: string },
): Promise<{ stage: OrderStage }> {
  const o = await lockTypedOrder(tx, a.tenantId, input.orderId)
  const kot = await kotStatusOf(tx, a.tenantId, o.id)
  const stage = orderStage({ orderStatus: o.status, kotStatus: kot, handoverStatus: o.handoverStatus })
  const problem = validateHandover({ orderType: o.orderType, stage, to: input.to, driverName: input.driverName ?? o.driverName })
  if (problem) throw new OrderError(problem)
  // A finished order leaves the board, taking "Take payment" with it — so it
  // must be billed first, or it could never be invoiced (or deduct stock).
  if ((input.to === 'collected' || input.to === 'delivered') && !o.invoiceId) {
    throw new OrderError('Take payment before handing this order over.')
  }

  const patch: Partial<typeof orders.$inferInsert> = { handoverStatus: input.to }
  if (input.to === 'out_for_delivery') {
    patch.driverName = (input.driverName ?? '').trim()
    patch.driverPhone = input.driverPhone?.trim() || null
  }
  if (input.to === 'collected' || input.to === 'delivered') patch.handedOverAt = new Date()
  await tx.update(orders).set(patch).where(and(eq(orders.id, o.id), eq(orders.tenantId, a.tenantId)))

  // Handing the food over closes its kitchen ticket too (a ready ticket would
  // otherwise sit on the pass forever).
  if (input.to === 'collected' || input.to === 'delivered') {
    await tx
      .update(kots)
      .set({ status: 'served' })
      .where(and(eq(kots.orderId, o.id), eq(kots.tenantId, a.tenantId), inArray(kots.status, ['ready', 'preparing', 'pending'])))
  }
  await tx.insert(auditLog).values({
    tenantId: a.tenantId,
    actorMembershipId: a.membershipId,
    action: `order.${input.to}`,
    entityType: 'order',
    entityId: o.id,
    before: { handover_status: o.handoverStatus },
    after: { handover_status: input.to, driver: patch.driverName ?? null },
  })
  return { stage: input.to }
}

/**
 * Cancel a takeaway / delivery order that is still only "received" (the kitchen
 * hasn't started it) and not handed over or billed. Enforced here, not just by
 * hiding the button, and under the same row lock as the other moves.
 */
export async function cancelTypedOrderCore(tx: Db, a: { tenantId: string }, orderId: string): Promise<void> {
  const o = await lockTypedOrder(tx, a.tenantId, orderId)
  const kot = await kotStatusOf(tx, a.tenantId, o.id)
  const stage = orderStage({ orderStatus: o.status, kotStatus: kot, handoverStatus: o.handoverStatus })
  if (stage === 'cancelled') throw new OrderError('This order is already cancelled.')
  if (o.invoiceId || o.status === 'billed') throw new OrderError('This order has already been billed and cannot be cancelled.')
  if (stage !== 'received') throw new OrderError('The kitchen has already started this order, so it can’t be cancelled.')
  await cancelOrderCore(tx, a, o.id)
}

export type CollectPaymentResult = {
  invoiceId: string
  invoiceNumber: string
  total: number
  alreadyPaid: boolean
  payment: RecordPaymentResult | null
}

/**
 * Take payment for a takeaway / delivery order — the missing half of
 * pay-on-collection. Raises the invoice with issueInvoiceForOrder (the same
 * function pay-now's webhook uses, so the delivery fee, GST and rounding are
 * identical), tenders it in full, links it to the order, flips the order to
 * 'billed' and deducts stock — all in this one transaction. A repeat call
 * finds the order already billed and takes nothing.
 */
export async function collectTypedOrderPaymentCore(
  tx: Db,
  ctx: { tenantId: string; timezone: string; membershipId: string },
  input: { orderId: string; method: PosPaymentMethod; tipAmount?: number; idempotencyKey?: string },
): Promise<CollectPaymentResult> {
  const o = await lockTypedOrder(tx, ctx.tenantId, input.orderId)
  if (o.status === 'cancelled') throw new OrderError('This order was cancelled.')
  if (o.acceptanceStatus !== 'accepted') throw new OrderError('Accept this order first — it is still waiting for review.')

  if (o.invoiceId) {
    const [inv] = await tx
      .select({ id: invoices.id, number: invoices.invoiceNumber, total: invoices.total })
      .from(invoices)
      .where(and(eq(invoices.id, o.invoiceId), eq(invoices.tenantId, ctx.tenantId)))
      .limit(1)
    return { invoiceId: o.invoiceId, invoiceNumber: inv?.number ?? '', total: Number(inv?.total ?? 0), alreadyPaid: true, payment: null }
  }
  if (o.status !== 'open') throw new OrderError('This order has already been billed.')

  const issued = await issueInvoiceForOrder(tx, { id: ctx.tenantId, timezone: ctx.timezone }, {
    id: o.id,
    branchId: o.branchId,
    customerId: o.customerId,
    orderNumber: o.orderNumber,
  })
  await tx.update(orders).set({ status: 'billed', invoiceId: issued.invoiceId }).where(and(eq(orders.id, o.id), eq(orders.tenantId, ctx.tenantId)))
  await deductStockForOrders(tx, ctx.tenantId, [o.id])

  const payment = await recordPaymentForInvoice(
    tx,
    { tenantId: ctx.tenantId, membershipId: ctx.membershipId },
    { invoiceId: issued.invoiceId, method: input.method, amount: issued.pricing.total, tipAmount: input.tipAmount, idempotencyKey: input.idempotencyKey },
  )
  return { invoiceId: issued.invoiceId, invoiceNumber: issued.invoiceNumber, total: issued.pricing.total, alreadyPaid: false, payment }
}

// ── reads ───────────────────────────────────────────────────────────────────

export type TypedOrderView = {
  orderId: string
  orderNumber: string
  orderType: TypedOrderType
  channel: 'staff' | 'online'
  stage: OrderStage
  createdAt: Date
  pickupAt: Date | null
  contactName: string | null
  contactPhone: string | null
  deliveryAddress: string | null
  deliveryFee: number
  driverName: string | null
  driverPhone: string | null
  notes: string | null
  /** invoice raised? and settled? */
  invoiceId: string | null
  paid: boolean
  items: { name: string; qty: number; notes: string | null; modifiers: string[] }[]
}

/**
 * Live takeaway / delivery orders for a branch, oldest first: accepted, not
 * cancelled, not yet collected/delivered. (Pending online orders are in the
 * incoming queue until someone accepts them.)
 */
export async function listActiveTypedOrdersCore(tx: Db, tenantId: string, branchId: string): Promise<TypedOrderView[]> {
  const rows = await tx
    .select({
      o: orders,
      kotStatus: kots.status,
      invoiceStatus: invoices.status,
    })
    .from(orders)
    .leftJoin(kots, eq(kots.orderId, orders.id))
    .leftJoin(invoices, eq(invoices.id, orders.invoiceId))
    .where(
      and(
        eq(orders.tenantId, tenantId),
        eq(orders.branchId, branchId),
        ne(orders.orderType, 'dine_in'),
        eq(orders.acceptanceStatus, 'accepted'),
        ne(orders.status, 'cancelled'),
        or(sql`${orders.handoverStatus} is null`, eq(orders.handoverStatus, 'out_for_delivery')),
      ),
    )
    .orderBy(asc(orders.createdAt))
  if (rows.length === 0) return []

  const ids = rows.map((r) => r.o.id)
  const items = await tx
    .select({ id: orderItems.id, orderId: orderItems.orderId, name: orderItems.itemName, qty: orderItems.qty, notes: orderItems.specialInstructions })
    .from(orderItems)
    .where(and(eq(orderItems.tenantId, tenantId), inArray(orderItems.orderId, ids), ne(orderItems.voidStatus, 'voided')))
    .orderBy(asc(orderItems.id))
  const mods = items.length
    ? await tx
        .select({ itemId: orderItemModifiers.orderItemId, name: orderItemModifiers.optionName })
        .from(orderItemModifiers)
        .where(and(eq(orderItemModifiers.tenantId, tenantId), inArray(orderItemModifiers.orderItemId, items.map((i) => i.id))))
    : []
  const modsByItem = new Map<string, string[]>()
  for (const m of mods) modsByItem.set(m.itemId, [...(modsByItem.get(m.itemId) ?? []), m.name])

  return rows.map(({ o, kotStatus, invoiceStatus }) => ({
    orderId: o.id,
    orderNumber: o.orderNumber,
    orderType: o.orderType as TypedOrderType,
    channel: o.channel,
    stage: orderStage({ orderStatus: o.status, kotStatus, handoverStatus: o.handoverStatus }),
    createdAt: o.createdAt,
    pickupAt: o.pickupAt,
    contactName: o.contactName,
    contactPhone: o.contactPhone,
    deliveryAddress: o.deliveryAddress,
    deliveryFee: Number(o.deliveryFee),
    driverName: o.driverName,
    driverPhone: o.driverPhone,
    notes: o.notes,
    invoiceId: o.invoiceId,
    paid: invoiceStatus === 'paid',
    items: items
      .filter((i) => i.orderId === o.id)
      .map((i) => ({ name: i.name, qty: i.qty, notes: i.notes, modifiers: modsByItem.get(i.id) ?? [] })),
  }))
}

