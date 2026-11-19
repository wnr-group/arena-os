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
import { and, eq, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type * as schema from '@/db/schema'
import { auditLog, invoices, orders, payments, tenants } from '@/db/schema'
import { OrderError, createOrderCore, findOrderByIdempotencyKey, type CreateOrderItemInput } from './service'
import { issueInvoiceForOrder } from '@/lib/billing/invoice'
import { normalizePromoCode } from '@/lib/billing/promo'
import { POS_PAYMENT_METHODS, recordPaymentForInvoice, type PosPaymentMethod } from '@/lib/billing/payments'
import { paise, round2 } from '@/lib/billing/pricing'
import { deductStockForOrders } from '@/lib/inventory/deduct'
import { findOrCreateCustomer } from '@/lib/customers/service'
import { isValidPhone } from '@/lib/customers/phone'
import { canManageWalkins, type MemberRole } from '@/lib/auth/roles'
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
  const existing = await findOrderByIdempotencyKey(tx, ctx.tenantId, key)
  if (existing) return replaySale(tx, ctx.tenantId, existing.id)

  const { created, customer, issued } = await buildSale(tx, ctx, input, key)
  const total = issued.pricing.total
  const free = paise(total) === 0

  let cashTendered: number | null = null
  let changeDue: number | null = null
  if (input.method === 'cash' && !free) {
    if (input.cashTendered === undefined) throw new OrderError('Enter the cash received.')
    cashTendered = round2(input.cashTendered)
    if (!Number.isFinite(cashTendered) || paise(cashTendered) < paise(total)) {
      throw new OrderError(`Cash received is less than the ${total.toFixed(2)} bill.`)
    }
    changeDue = round2(cashTendered - total)
  }

  await tx.update(orders).set({ status: 'billed', invoiceId: issued.invoiceId }).where(and(eq(orders.id, created.id), eq(orders.tenantId, ctx.tenantId)))
  await deductStockForOrders(tx, ctx.tenantId, [created.id])

  // A bill discounted to nothing was settled on issue and takes no payment row.
  let paymentId: string | null = null
  if (!free) {
    const payment = await recordPaymentForInvoice(
      tx,
      { tenantId: ctx.tenantId, membershipId: ctx.membershipId },
      { invoiceId: issued.invoiceId, method: input.method, amount: total, idempotencyKey: `counter:${key}` },
    )
    // Paid in full or nothing: anything short of settled aborts the whole sale.
    if (!payment.settled) throw new OrderError('Payment did not settle the bill — nothing was saved.')
    paymentId = payment.paymentId
  }
  const d = issued.discounts!

  await tx.insert(auditLog).values({
    tenantId: ctx.tenantId,
    actorMembershipId: ctx.membershipId,
    action: 'counter_order.created',
    entityType: 'order',
    entityId: created.id,
    before: {},
    after: {
      order_number: created.orderNumber,
      kot_number: created.kotNumber,
      invoice_id: issued.invoiceId,
      invoice_number: issued.invoiceNumber,
      customer_id: customer.id,
      total: total.toFixed(2),
      method: input.method,
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
    total,
    paymentId,
    method: input.method,
    cashTendered,
    changeDue,
    deduplicated: false,
  }
}

/** Rebuild the original result for a retried key from what was committed. */
async function replaySale(tx: Db, tenantId: string, orderId: string): Promise<CounterOrderResult> {
  const [o] = await tx
    .select({ id: orders.id, orderNumber: orders.orderNumber, orderType: orders.orderType, customerId: orders.customerId, invoiceId: orders.invoiceId })
    .from(orders)
    .where(and(eq(orders.id, orderId), eq(orders.tenantId, tenantId)))
    .limit(1)
  // The key belongs to some other kind of order — a client bug, never a replay.
  if (!o || o.orderType !== 'counter' || !o.invoiceId || !o.customerId) throw new OrderError('That retry reference was already used for a different order.')

  const [inv] = await tx
    .select({ number: invoices.invoiceNumber, total: invoices.total })
    .from(invoices)
    .where(and(eq(invoices.id, o.invoiceId), eq(invoices.tenantId, tenantId)))
    .limit(1)
  const [pay] = await tx
    .select({ id: payments.id, method: payments.method })
    .from(payments)
    .where(and(eq(payments.tenantId, tenantId), eq(payments.invoiceId, o.invoiceId), eq(payments.status, 'captured')))
    .limit(1)
  const [audit] = await tx
    .select({ after: auditLog.after })
    .from(auditLog)
    .where(and(eq(auditLog.tenantId, tenantId), eq(auditLog.entityId, o.id), eq(auditLog.action, 'counter_order.created')))
    .limit(1)
  if (!inv || (!pay && round2(Number(inv.total)) > 0)) throw new OrderError('That sale is incomplete — contact support.')

  const after = (audit?.after ?? {}) as Record<string, string | null>
  const kotNumber = after.kot_number ?? ''
  return {
    orderId: o.id,
    orderNumber: o.orderNumber,
    kotNumber,
    invoiceId: o.invoiceId,
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
