/**
 * Counter food orders (M41) — a food-only sale at the counter of a
 * NON-restaurant venue (gaming cafe, studio, VR centre…): pick items, take
 * payment, print the bill, in one step. No booking, no table, no open tab.
 *
 * No new pipeline. createOrderCore makes the order + its kitchen ticket,
 * issueInvoiceForOrder raises the invoice, recordPaymentForInvoice takes the
 * money — the same three functions takeaway and the POS already use — and all
 * of it runs in the caller's ONE transaction. That transaction is the
 * "paid in full or nothing" guarantee: if the payment is refused, the order,
 * the kitchen ticket, the invoice, the stock deduction AND the order/invoice/
 * KOT sequence numbers roll back together, so there are never half-done sales
 * and never gaps in the numbering.
 *
 * Every rule is enforced here, not in the UI: venue type, plan, role.
 */
import 'server-only'
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type * as schema from '@/db/schema'
import { auditLog, invoices, kots, orderItems, orders, payments, tenants } from '@/db/schema'
import { OrderError, createOrderCore, editOrderItemQuantityCore, findOrderByIdempotencyKey, type CreateOrderItemInput } from './service'
import { recordRefund, refundedForPayment, voidInvoiceRecord } from '@/lib/billing/refunds'
import { issueInvoiceForOrder } from '@/lib/billing/invoice'
import { normalizePromoCode } from '@/lib/billing/promo'
import { POS_PAYMENT_METHODS, recordPaymentForInvoice, type PosPaymentMethod } from '@/lib/billing/payments'
import { paise, round2 } from '@/lib/billing/pricing'
import { deductStockForOrders } from '@/lib/inventory/deduct'
import { findOrCreateCustomer } from '@/lib/customers/service'
import { isValidPhone } from '@/lib/customers/phone'
import { canManageWalkins, isManager, type MemberRole } from '@/lib/auth/roles'
import { requireEntitlementIn } from '@/lib/platform/entitlement-guard'

type Db = NodePgDatabase<typeof schema>

export const COUNTER_ORDERS_MODULE = 'module.counter_orders'

export type CounterOrderCtx = {
  tenantId: string
  timezone: string
  membershipId: string
  role: MemberRole
}

export type CreateCounterOrderInput = {
  branchId: string
  items: CreateOrderItemInput[]
  /** Required — every counter sale is linked to a customer record. */
  customerPhone: string
  customerName?: string
  method: PosPaymentMethod
  /** Optional promo code, applied after the customer's membership (booking-bill rules). */
  promoCode?: string
  /** Cash only: what the customer handed over. Must cover the total. */
  cashTendered?: number
  /** The total the cashier saw and the customer agreed to; a different server price aborts the sale. */
  expectedTotal: number
  /** One per attempt; a retry with the same key returns the original sale. */
  idempotencyKey: string
}

export type CounterOrderResult = {
  orderId: string
  orderNumber: string
  kotNumber: string
  invoiceId: string
  invoiceNumber: string
  customerId: string
  /** Gross before discounts, what membership and promo took off, and the GST in `total`. */
  subtotal: number
  membershipDiscount: number
  membershipPlanName: string | null
  promoDiscount: number
  promoCode: string | null
  taxTotal: number
  total: number
  /** Null only for a bill discounted to nothing (no money changed hands). */
  paymentId: string | null
  method: PosPaymentMethod
  /** Cash sales only (null otherwise): tendered and the change to hand back. */
  cashTendered: number | null
  changeDue: number | null
  /** True when this call was a retry and created/charged nothing new. */
  deduplicated: boolean
}

/** The server priced the sale differently from what the cashier confirmed; nothing was saved. */
export class PriceChangedError extends OrderError {
  constructor(readonly total: number) {
    super(`The total is now ${total.toFixed(2)} — it changed since you last looked. Check it and confirm again.`)
  }
}

/** Gate shared by every counter-sale entry point. */
async function assertCounterAllowed(tx: Db, ctx: CounterOrderCtx): Promise<void> {
  if (!canManageWalkins(ctx.role)) throw new OrderError('You don’t have permission to take counter sales.')
  const [t] = await tx.select({ industry: tenants.industry }).from(tenants).where(eq(tenants.id, ctx.tenantId)).limit(1)
  if (!t) throw new OrderError('Business not found.')
  if (t.industry === 'restaurant') throw new OrderError('Counter sales are for gaming, studio and other venues. Restaurants use takeaway orders.')
  await requireEntitlementIn(tx, ctx.tenantId, COUNTER_ORDERS_MODULE)
}

/**
 * Take a counter sale: order + kitchen ticket + invoice + payment, atomically.
 * Idempotent on `idempotencyKey`.
 */
export async function createCounterOrderCore(tx: Db, ctx: CounterOrderCtx, input: CreateCounterOrderInput): Promise<CounterOrderResult> {
  await assertCounterAllowed(tx, ctx)

  if (!(POS_PAYMENT_METHODS as readonly string[]).includes(input.method)) throw new OrderError('Choose cash, card or UPI.')
  if (input.items.length === 0) throw new OrderError('Add at least one item.')
  if (!isValidPhone(input.customerPhone)) throw new OrderError('Enter a valid 10-digit customer phone number.')
  const key = input.idempotencyKey.trim()
  if (key.length < 8) throw new OrderError('Missing retry reference — refresh and try again.')

  // Two submits of one key serialise here, so the second reads the first's
  // COMMITTED sale below instead of racing it to the unique index.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`counter-order:${ctx.tenantId}:${key}`}, 0))`)
  // The retry is answered from what was recorded against this attempt's key, never
  // from the order's live invoice link, which a later void / re-bill may have moved.
  const attempt = await findAttempt(tx, ctx.tenantId, `counter:${key}`)
  if (attempt) return replaySale(tx, ctx.tenantId, attempt)
  if (await findOrderByIdempotencyKey(tx, ctx.tenantId, key)) throw new OrderError(DIFFERENT_ORDER)

  const { created, customer, issued } = await buildSale(tx, ctx, input, key)
  const closed = await closeSale(tx, ctx, {
    orderId: created.id,
    orderNumber: created.orderNumber,
    kotNumber: created.kotNumber,
    customerId: customer.id,
    issued,
    method: input.method,
    cashTendered: input.cashTendered,
    expectedTotal: input.expectedTotal,
    payKey: `counter:${key}`,
    auditAction: 'counter_order.created',
  })
  const d = issued.discounts!
  return {
    orderId: created.id,
    orderNumber: created.orderNumber,
    kotNumber: created.kotNumber,
    invoiceId: issued.invoiceId,
    invoiceNumber: issued.invoiceNumber,
    customerId: customer.id,
    subtotal: issued.pricing.subtotal,
    membershipDiscount: d.membershipDiscount,
    membershipPlanName: d.membership?.planName ?? null,
    promoDiscount: d.promoDiscount,
    promoCode: d.promoCode,
    taxTotal: issued.pricing.taxTotal,
    total: issued.pricing.total,
    paymentId: closed.paymentId,
    method: input.method,
    cashTendered: closed.cashTendered,
    changeDue: closed.changeDue,
    deduplicated: false,
  }
}

type IssuedForOrder = Awaited<ReturnType<typeof issueInvoiceForOrder>>

/**
 * The money half shared by a new sale and a re-bill: validate cash, mark the
 * order billed and linked to its invoice, reconcile stock (a no-op when the food
 * was already deducted — that is what stops a re-bill releasing stock twice),
 * take the payment, write the audit row. Everything is in the caller's
 * transaction, so it is paid in full or nothing.
 */
async function closeSale(
  tx: Db,
  ctx: CounterOrderCtx,
  a: {
    orderId: string
    orderNumber: string
    kotNumber: string
    customerId: string
    issued: IssuedForOrder
    method: PosPaymentMethod
    cashTendered?: number
    expectedTotal: number
    /** Also the attempt key the audit row is filed under, so a retry can find this result. */
    payKey: string
    auditAction: 'counter_order.created' | 'counter_order.rebilled'
  },
): Promise<{ paymentId: string | null; cashTendered: number | null; changeDue: number | null }> {
  const { issued } = a
  const total = issued.pricing.total
  const free = paise(total) === 0

  // Before any money moves: the price the cashier confirmed must be the price charged.
  // Throwing rolls the whole sale back; a same-key replay never reaches here.
  if (!Number.isFinite(a.expectedTotal) || paise(a.expectedTotal) !== paise(total)) throw new PriceChangedError(total)

  let cashTendered: number | null = null
  let changeDue: number | null = null
  if (a.method === 'cash' && !free) {
    if (a.cashTendered === undefined) throw new OrderError('Enter the cash received.')
    cashTendered = round2(a.cashTendered)
    if (!Number.isFinite(cashTendered) || paise(cashTendered) < paise(total)) {
      throw new OrderError(`Cash received is less than the ${total.toFixed(2)} bill.`)
    }
    changeDue = round2(cashTendered - total)
  }

  await tx.update(orders).set({ status: 'billed', invoiceId: issued.invoiceId }).where(and(eq(orders.id, a.orderId), eq(orders.tenantId, ctx.tenantId)))
  await deductStockForOrders(tx, ctx.tenantId, [a.orderId])

  // A bill discounted to nothing was settled on issue and takes no payment row.
  let paymentId: string | null = null
  if (!free) {
    const payment = await recordPaymentForInvoice(
      tx,
      { tenantId: ctx.tenantId, membershipId: ctx.membershipId },
      { invoiceId: issued.invoiceId, method: a.method, amount: total, idempotencyKey: a.payKey },
    )
    // Paid in full or nothing: anything short of settled aborts the whole sale.
    if (!payment.settled) throw new OrderError('Payment did not settle the bill — nothing was saved.')
    paymentId = payment.paymentId
  }
  const d = issued.discounts!

  await tx.insert(auditLog).values({
    tenantId: ctx.tenantId,
    actorMembershipId: ctx.membershipId,
    action: a.auditAction,
    entityType: 'order',
    entityId: a.orderId,
    before: {},
    after: {
      attempt_key: a.payKey,
      order_number: a.orderNumber,
      kot_number: a.kotNumber,
      invoice_id: issued.invoiceId,
      invoice_number: issued.invoiceNumber,
      customer_id: a.customerId,
      total: total.toFixed(2),
      method: a.method,
      payment_id: paymentId,
      subtotal: issued.pricing.subtotal.toFixed(2),
      membership_discount: d.membershipDiscount.toFixed(2),
      membership_plan: d.membership?.planName ?? null,
      promo_code: d.promoCode,
      promo_discount: d.promoDiscount.toFixed(2),
      tax_total: issued.pricing.taxTotal.toFixed(2),
      cash_tendered: cashTendered?.toFixed(2) ?? null,
      change_due: changeDue?.toFixed(2) ?? null,
    },
  })
  return { paymentId, cashTendered, changeDue }
}

const DIFFERENT_ORDER = 'That retry reference was already used for a different order.'
const ATTEMPT_ACTIONS = ['counter_order.created', 'counter_order.rebilled']

/** The audit row closeSale filed under an attempt key, if that attempt committed. */
async function findAttempt(tx: Db, tenantId: string, attemptKey: string) {
  const [row] = await tx
    .select({ entityId: auditLog.entityId, after: auditLog.after })
    .from(auditLog)
    .where(and(eq(auditLog.tenantId, tenantId), inArray(auditLog.action, ATTEMPT_ACTIONS), sql`${auditLog.after}->>'attempt_key' = ${attemptKey}`))
    .limit(1)
  return row
}

/**
 * Rebuild the result a committed attempt returned, from the invoice and payment it
 * recorded (by id, whatever their status is now: a later refund or void must not
 * change what a retry of the original attempt sees).
 */
async function replaySale(tx: Db, tenantId: string, attempt: { entityId: string | null; after: unknown }): Promise<CounterOrderResult> {
  const after = (attempt.after ?? {}) as Record<string, string | null>
  const invoiceId = after.invoice_id
  if (!attempt.entityId || !invoiceId) throw new OrderError('That sale is incomplete — contact support.')

  const [o] = await tx
    .select({ id: orders.id, orderNumber: orders.orderNumber, customerId: orders.customerId })
    .from(orders)
    .where(and(eq(orders.id, attempt.entityId), eq(orders.tenantId, tenantId)))
    .limit(1)
  const [inv] = await tx
    .select({ number: invoices.invoiceNumber, total: invoices.total })
    .from(invoices)
    .where(and(eq(invoices.id, invoiceId), eq(invoices.tenantId, tenantId)))
    .limit(1)
  // A bill discounted to nothing recorded no payment (payment_id null); otherwise the recorded one must exist.
  const [pay] = after.payment_id
    ? await tx
        .select({ id: payments.id, method: payments.method })
        .from(payments)
        .where(and(eq(payments.id, after.payment_id), eq(payments.tenantId, tenantId)))
        .limit(1)
    : []
  if (!o || !o.customerId || !inv || (after.payment_id && !pay)) throw new OrderError('That sale is incomplete — contact support.')

  return {
    orderId: o.id,
    orderNumber: o.orderNumber,
    kotNumber: after.kot_number ?? '',
    invoiceId,
    invoiceNumber: inv.number,
    customerId: o.customerId,
    subtotal: Number(after.subtotal ?? 0),
    membershipDiscount: Number(after.membership_discount ?? 0),
    membershipPlanName: after.membership_plan ?? null,
    promoDiscount: Number(after.promo_discount ?? 0),
    promoCode: after.promo_code ?? null,
    taxTotal: Number(after.tax_total ?? 0),
    total: round2(Number(inv.total)),
    paymentId: pay?.id ?? null,
    method: (pay?.method ?? (after.method as string | undefined) ?? 'cash') as PosPaymentMethod,
    cashTendered: after.cash_tendered ? Number(after.cash_tendered) : null,
    changeDue: after.change_due ? Number(after.change_due) : null,
    deduplicated: true,
  }
}

/** The part of a sale shared with the preview: customer → order + KOT → discounted invoice. */
async function buildSale(tx: Db, ctx: CounterOrderCtx, input: Pick<CreateCounterOrderInput, 'branchId' | 'items' | 'customerPhone' | 'customerName' | 'promoCode'>, key: string | null) {
  const customer = await findOrCreateCustomer(tx, ctx.tenantId, { phone: input.customerPhone, name: input.customerName })
  const created = await createOrderCore(
    tx,
    { tenantId: ctx.tenantId, timezone: ctx.timezone, membershipId: ctx.membershipId },
    {
      branchId: input.branchId,
      channel: 'staff',
      customerId: customer.id,
      idempotencyKey: key ?? undefined,
      items: input.items,
      typed: { orderType: 'counter', contactName: customer.name?.trim() || customer.phone, contactPhone: customer.phone },
    },
  )
  // The customer is the one the SERVER just resolved from the phone — membership
  // is looked up from that, never from anything the client names.
  const issued = await issueInvoiceForOrder(
    tx,
    { id: ctx.tenantId, timezone: ctx.timezone },
    { id: created.id, branchId: input.branchId, customerId: customer.id, orderNumber: created.orderNumber },
    { promoCode: normalizePromoCode(input.promoCode) },
  )
  return { created, customer, issued }
}

export type CounterPreview = {
  subtotal: number
  membershipDiscount: number
  membershipPlanName: string | null
  promoDiscount: number
  promoCode: string | null
  taxTotal: number
  total: number
}

/** Thrown by previewCounterOrderCore to roll its transaction back; carries the answer. */
export class CounterPreviewResult extends Error {
  constructor(readonly preview: CounterPreview) {
    super('counter preview')
  }
}

/**
 * Server-computed bill for the dialog, BEFORE payment. It runs the real sale
 * path (same pricing, same discounts, same promo checks) and then throws
 * CounterPreviewResult so the caller's transaction rolls back: no order, KOT,
 * customer, invoice number or promo use survives. The caller must catch it.
 */
export async function previewCounterOrderCore(
  tx: Db,
  ctx: CounterOrderCtx,
  input: Pick<CreateCounterOrderInput, 'branchId' | 'items' | 'customerPhone' | 'promoCode'>,
): Promise<never> {
  await assertCounterAllowed(tx, ctx)
  if (input.items.length === 0) throw new OrderError('Add at least one item.')
  if (!isValidPhone(input.customerPhone)) throw new OrderError('Enter a valid 10-digit customer phone number.')
  const { issued } = await buildSale(tx, ctx, input, null)
  const d = issued.discounts!
  throw new CounterPreviewResult({
    subtotal: issued.pricing.subtotal,
    membershipDiscount: d.membershipDiscount,
    membershipPlanName: d.membership?.planName ?? null,
    promoDiscount: d.promoDiscount,
    promoCode: d.promoCode,
    taxTotal: issued.pricing.taxTotal,
    total: issued.pricing.total,
  })
}

// ── corrections (M41 ticket 4) ───────────────────────────────────────────────

export type CounterCorrectionActor = { tenantId: string; membershipId: string; role: MemberRole }

async function lockCounterOrder(tx: Db, tenantId: string, orderId: string) {
  const [o] = await tx.select().from(orders).where(and(eq(orders.id, orderId), eq(orders.tenantId, tenantId))).for('update').limit(1)
  if (!o) throw new OrderError('Order not found.')
  if (o.orderType !== 'counter') throw new OrderError('That is not a counter sale.')
  return o
}

/**
 * Wrong bill → refund every captured payment in full, then void the invoice, in
 * ONE transaction (a refund with no void, or a void with money still held, can
 * never be left behind). Manager/owner only — checked here and again by the
 * refunds RLS policy. The money guards are the existing ones: recordRefund locks
 * each payment, voidInvoiceRecord refuses while anything is still held. The void
 * detaches the order from the invoice and returns its promo use (see
 * voidInvoiceRecord), leaving an OPEN, unbilled order ready to edit and re-bill.
 */
export async function voidCounterSaleCore(
  tx: Db,
  actor: CounterCorrectionActor,
  input: { orderId: string; reason: string },
): Promise<{ invoiceNumber: string; refunded: number }> {
  if (!isManager(actor.role)) throw new OrderError('Only a manager can refund and void a sale.')
  const reason = input.reason.trim()
  if (!reason) throw new OrderError('A reason is required.')

  const o = await lockCounterOrder(tx, actor.tenantId, input.orderId)
  if (!o.invoiceId || o.status !== 'billed') throw new OrderError('This sale is not billed, so there is nothing to void.')

  const held = await tx
    .select({ id: payments.id, amount: payments.amount })
    .from(payments)
    .where(and(eq(payments.tenantId, actor.tenantId), eq(payments.invoiceId, o.invoiceId), eq(payments.status, 'captured')))
  let refunded = 0
  for (const p of held) {
    const remaining = round2(Number(p.amount) - (await refundedForPayment(tx, actor.tenantId, p.id)))
    if (paise(remaining) <= 0) continue
    await recordRefund(tx, { tenantId: actor.tenantId, membershipId: actor.membershipId }, { paymentId: p.id, amount: remaining, reason })
    refunded = round2(refunded + remaining)
  }
  const voided = await voidInvoiceRecord(tx, { tenantId: actor.tenantId, membershipId: actor.membershipId }, { invoiceId: o.invoiceId, reason })

  await tx.insert(auditLog).values({
    tenantId: actor.tenantId,
    actorMembershipId: actor.membershipId,
    action: 'counter_order.voided',
    entityType: 'order',
    entityId: o.id,
    before: { invoice_id: voided.invoiceId, invoice_number: voided.invoiceNumber, status: 'billed' },
    after: { status: 'open', refunded: refunded.toFixed(2), reason },
  })
  return { invoiceNumber: voided.invoiceNumber, refunded }
}

export type RebillCounterInput = {
  orderId: string
  method: PosPaymentMethod
  cashTendered?: number
  promoCode?: string
  /** The total the cashier confirmed; a different server price aborts the re-bill. */
  expectedTotal: number
  idempotencyKey: string
}

/** The order a re-bill acts on, locked: a counter order, by a walk-in role, at a non-restaurant venue. */
async function loadRebillable(tx: Db, ctx: CounterOrderCtx, orderId: string) {
  if (!canManageWalkins(ctx.role)) throw new OrderError('You don’t have permission to take counter sales.')
  const [t] = await tx.select({ industry: tenants.industry }).from(tenants).where(eq(tenants.id, ctx.tenantId)).limit(1)
  if (!t || t.industry === 'restaurant') throw new OrderError('Counter sales are for gaming, studio and other venues.')
  return lockCounterOrder(tx, ctx.tenantId, orderId)
}

/** Open, unbilled, not cancelled, with a customer — otherwise there is nothing to bill again. */
function assertRebillable(o: { status: string; invoiceId: string | null; customerId: string | null }): string {
  if (o.invoiceId || o.status === 'billed') throw new OrderError('This sale is already billed. Refund and void it first to bill it again.')
  if (o.status === 'cancelled') throw new OrderError('This order was cancelled — there is nothing to bill.')
  if (!o.customerId) throw new OrderError('This order has no customer, so it cannot be re-billed.')
  return o.customerId
}

/**
 * Bill an unbilled counter order again after a void (and any edits), with a fresh
 * invoice number and a new payment. Same discount rules and promo checks as a new
 * sale; the promo use is taken again here (the void gave it back). Idempotent on
 * the key; paid in full or nothing.
 */
export async function rebillCounterOrderCore(tx: Db, ctx: CounterOrderCtx, input: RebillCounterInput): Promise<CounterOrderResult> {
  if (!(POS_PAYMENT_METHODS as readonly string[]).includes(input.method)) throw new OrderError('Choose cash, card or UPI.')
  const key = input.idempotencyKey.trim()
  if (key.length < 8) throw new OrderError('Missing retry reference — refresh and try again.')

  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`counter-rebill:${ctx.tenantId}:${key}`}, 0))`)
  // A retry of this very re-bill, paid or free: answered from the attempt's own record.
  const attempt = await findAttempt(tx, ctx.tenantId, `counter-rebill:${key}`)
  if (attempt) {
    if (attempt.entityId !== input.orderId) throw new OrderError(DIFFERENT_ORDER)
    return replaySale(tx, ctx.tenantId, attempt)
  }

  const o = await loadRebillable(tx, ctx, input.orderId)
  const customerId = assertRebillable(o)
  const kotNumber = await kotNumberOf(tx, ctx.tenantId, o.id)

  const issued = await issueInvoiceForOrder(
    tx,
    { id: ctx.tenantId, timezone: ctx.timezone },
    { id: o.id, branchId: o.branchId, customerId, orderNumber: o.orderNumber },
    { promoCode: normalizePromoCode(input.promoCode) },
  )
  const closed = await closeSale(tx, ctx, {
    orderId: o.id,
    orderNumber: o.orderNumber,
    kotNumber,
    customerId,
    issued,
    method: input.method,
    cashTendered: input.cashTendered,
    expectedTotal: input.expectedTotal,
    payKey: `counter-rebill:${key}`,
    auditAction: 'counter_order.rebilled',
  })
  const d = issued.discounts!
  return {
    orderId: o.id,
    orderNumber: o.orderNumber,
    kotNumber,
    invoiceId: issued.invoiceId,
    invoiceNumber: issued.invoiceNumber,
    customerId,
    subtotal: issued.pricing.subtotal,
    membershipDiscount: d.membershipDiscount,
    membershipPlanName: d.membership?.planName ?? null,
    promoDiscount: d.promoDiscount,
    promoCode: d.promoCode,
    taxTotal: issued.pricing.taxTotal,
    total: issued.pricing.total,
    paymentId: closed.paymentId,
    method: input.method,
    cashTendered: closed.cashTendered,
    changeDue: closed.changeDue,
    deduplicated: false,
  }
}

/** Server-priced total for the re-bill dialog; rolls back like previewCounterOrderCore. */
export async function previewRebillCounterOrderCore(tx: Db, ctx: CounterOrderCtx, input: { orderId: string; promoCode?: string }): Promise<never> {
  const o = await loadRebillable(tx, ctx, input.orderId)
  const customerId = assertRebillable(o)
  const issued = await issueInvoiceForOrder(
    tx,
    { id: ctx.tenantId, timezone: ctx.timezone },
    { id: o.id, branchId: o.branchId, customerId, orderNumber: o.orderNumber },
    { promoCode: normalizePromoCode(input.promoCode) },
  )
  const d = issued.discounts!
  throw new CounterPreviewResult({
    subtotal: issued.pricing.subtotal,
    membershipDiscount: d.membershipDiscount,
    membershipPlanName: d.membership?.planName ?? null,
    promoDiscount: d.promoDiscount,
    promoCode: d.promoCode,
    taxTotal: issued.pricing.taxTotal,
    total: issued.pricing.total,
  })
}

async function kotNumberOf(tx: Db, tenantId: string, orderId: string): Promise<string> {
  const [k] = await tx.select({ kotNumber: kots.kotNumber }).from(kots).where(and(eq(kots.orderId, orderId), eq(kots.tenantId, tenantId))).limit(1)
  return k?.kotNumber ?? ''
}

/**
 * Edit a line's quantity (0 removes it) on an UNBILLED counter order — i.e. a
 * sale that has been refunded and voided. Billed orders are refused (the only
 * path back is refund → void → edit → re-bill). The edit itself is the booking
 * food-edit core, unchanged: KOT reconciled, stock restored, audited.
 */
export async function editCounterOrderLineCore(
  tx: Db,
  actor: CounterCorrectionActor,
  input: { orderItemId: string; newQty: number },
) {
  if (!canManageWalkins(actor.role)) throw new OrderError('You don’t have permission to change counter sales.')
  const [row] = await tx
    .select({ orderId: orderItems.orderId })
    .from(orderItems)
    .where(and(eq(orderItems.id, input.orderItemId), eq(orderItems.tenantId, actor.tenantId)))
    .limit(1)
  if (!row) throw new OrderError('Order item not found.')
  const o = await lockCounterOrder(tx, actor.tenantId, row.orderId)
  if (o.invoiceId || o.status === 'billed') throw new OrderError('This sale is billed. Refund and void it first, then edit it.')
  if (o.status === 'cancelled') throw new OrderError('This order was cancelled.')
  // The sale was refunded and voided (with a reason, audited) to get here, and this edit
  // is the only way back to billing, so a served ticket must not block it. The edit is
  // allowed past the served guard and recorded as such.
  const [ticket] = await tx.select({ status: kots.status }).from(kots).where(and(eq(kots.orderId, o.id), eq(kots.tenantId, actor.tenantId))).limit(1)
  const result = await editOrderItemQuantityCore(tx, { tenantId: actor.tenantId, membershipId: actor.membershipId }, { ...input, allowServed: true })
  if (ticket?.status === 'served') {
    await tx.insert(auditLog).values({
      tenantId: actor.tenantId,
      actorMembershipId: actor.membershipId,
      action: 'counter_order.served_line_edited',
      entityType: 'order',
      entityId: o.id,
      before: { kot_status: 'served' },
      after: { order_item_id: input.orderItemId, new_qty: input.newQty },
    })
  }
  // Removing the last line cancels the order; its kitchen ticket must go with it, but
  // kots_update admits only kitchen roles + managers, so a cashier's own UPDATE would
  // silently match nothing. The definer function (0185) does just that one thing.
  const [after] = await tx.select({ status: orders.status }).from(orders).where(and(eq(orders.id, o.id), eq(orders.tenantId, actor.tenantId))).limit(1)
  if (after?.status === 'cancelled') await tx.execute(sql`select public.cancel_kots_for_cancelled_order(${o.id}::uuid)`)
  return result
}
