import 'server-only'
import { and, eq } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { z } from 'zod'
import type * as schema from '@/db/schema'
import { orders, paymentIntents } from '@/db/schema'
import { loadOrderFoodLines } from '@/lib/billing/invoice'
import { MAX_PAYMENT_AMOUNT, paise } from '@/lib/billing/payments'
import { priceBill, round2, type BillLine } from '@/lib/billing/pricing'
import { MAX_RECEIPT_LENGTH, type CreateOrderFn } from './razorpay'
import type { RazorpayCredentials } from '@/lib/settings/razorpay-credentials'

/**
 * Pay-now orders — the transactional core behind M14 #6 (v2).
 *
 * Sibling to lib/payments/deposits.ts, same two-transaction shape (validate
 * → gateway call → persist) for the same reason: Razorpay is an external HTTP
 * call and cannot join a Postgres transaction.
 *
 * ── What's different from a booking deposit ─────────────────────────────────
 * A deposit amount can change while its intent is pending (staff edit
 * bookings.deposit), so deposits.ts cancels a stale intent and replaces it.
 * An order's total CANNOT change after creation — order_items are a frozen
 * snapshot (see createOrderCore) — so there is nothing to cancel-and-replace:
 * a pending intent found for this order always still matches, and a mismatch
 * would mean a logic bug, not a legitimate race.
 *
 * ── What the browser is allowed to influence ────────────────────────────────
 * An order id. The amount is re-derived from order_items every time, never
 * accepted as input.
 *
 * ── Caller responsibility ───────────────────────────────────────────────────
 * Called from the PUBLIC checkout action (lib/actions/public-orders.ts), not
 * an authenticated staff one — there is no membershipId here the way
 * deposits.ts's actor carries one.
 */

type Db = NodePgDatabase<typeof schema>

/** Runs a callback inside one RLS-scoped transaction. */
export type RunInTx = <T>(fn: (tx: Db) => Promise<T>) => Promise<T>

/** Order-payment rule violations the caller should see verbatim. */
export class OrderPaymentError extends Error {}

/** Raised when the gateway order exists but the intent could not be stored. */
export class OrphanedOrderPaymentError extends Error {
  readonly gatewayOrderId: string
  constructor(gatewayOrderId: string) {
    super('The payment order was created but could not be saved. Please try again.')
    this.name = 'OrphanedOrderPaymentError'
    this.gatewayOrderId = gatewayOrderId
  }
}

/** The only field the client supplies. */
export const createOrderPaymentIntentInputSchema = z.object({
  orderId: z.string().uuid('That order reference is not valid.'),
})

export type CreateOrderPaymentIntentInput = z.infer<typeof createOrderPaymentIntentInputSchema>

/** Exactly what the browser needs to open Razorpay Checkout, and nothing else. */
export type OrderPaymentCheckout = {
  /** Razorpay's gateway order id — same naming as DepositCheckout.orderId. */
  orderId: string
  /** Paise — what Checkout expects. */
  amount: number
  /** Rupees, 2dp, for display. */
  amountRupees: number
  currency: string
  keyId: string
  orderNumber: string
  /** True when an existing pending order was returned instead of a new one. */
  reused: boolean
}

const PURPOSE = 'order_payment' as const
const GATEWAY = 'razorpay' as const

/** Razorpay is an India-only gateway; paise conversion assumes INR. */
const SUPPORTED_CURRENCY = 'INR'

type PayableOrderRow = {
  id: string
  branchId: string
  orderNumber: string
  currency: string
}

/**
 * Load the order and prove it may be paid online right now.
 *
 * RLS applies to this read, so another tenant's order id returns no row.
 *
 * Deliberately NOT `FOR UPDATE`: this runs on the PUBLIC connection
 * (arena_app under withPublicTenant), which has no UPDATE policy on
 * `orders` — only `orders_public_select`/`orders_public_insert` (migration
 * 0049). Postgres requires a row to also pass the UPDATE policy's USING
 * clause to be locked by SELECT ... FOR UPDATE, so a locking read here would
 * silently see ZERO rows for every order, not an error — exactly the "Order
 * not found" a customer hit in production before this comment existed. No
 * lock is needed anyway: unlike a booking's deposit (which staff can edit
 * while pending, hence deposits.ts's lock), an order's total is immutable
 * after creation, and the real concurrency guard against two simultaneous
 * pay attempts is the partial unique index
 * idx_payment_intents_one_pending_order on payment_intents, not a row lock
 * here.
 *
 * `bookingId is not null` is refused here rather than upstream only: the
 * ticket's own scope is standalone orders with "no open booking to add to" —
 * an order that already has one goes through add-to-bill instead, and this
 * is the last, authoritative place that boundary is enforced before money
 * moves.
 */
async function loadPayableOrder(tx: Db, tenantId: string, orderId: string): Promise<PayableOrderRow> {
  const [order] = await tx
    .select({
      id: orders.id,
      tenantId: orders.tenantId,
      branchId: orders.branchId,
      bookingId: orders.bookingId,
      orderNumber: orders.orderNumber,
      channel: orders.channel,
      status: orders.status,
      acceptanceStatus: orders.acceptanceStatus,
    })
    .from(orders)
    .where(and(eq(orders.id, orderId), eq(orders.tenantId, tenantId)))
    .limit(1)

  if (!order) throw new OrderPaymentError('Order not found.')
  // Belt and braces: the WHERE already scopes by tenant and RLS scopes it
  // again, but this is money and the match is asserted explicitly.
  if (order.tenantId !== tenantId) throw new OrderPaymentError('Order not found.')
  if (order.channel !== 'online') throw new OrderPaymentError('This order cannot be paid online.')
  if (order.bookingId) {
    throw new OrderPaymentError('This order is attached to a booking — add it to the bill instead.')
  }
  if (order.status !== 'open') throw new OrderPaymentError('This order can no longer be paid online.')
  if (order.acceptanceStatus !== 'awaiting_payment') {
    throw new OrderPaymentError(
      order.acceptanceStatus === 'accepted'
        ? 'This order has already been paid.'
        : 'This order is not awaiting online payment.',
    )
  }

  return { id: order.id, branchId: order.branchId, orderNumber: order.orderNumber, currency: SUPPORTED_CURRENCY }
}

/** The order's total, in rupees and in paise, priced through priceBill (GST included). */
export function resolveOrderAmount(lines: BillLine[]): { rupees: number; paise: number } {
  if (lines.length === 0) throw new OrderPaymentError('This order has nothing to pay for.')

  const pricing = priceBill({ lines })
  const rupees = round2(pricing.total)
  const amountPaise = paise(rupees)

  if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0) {
    throw new OrderPaymentError('This order has nothing to pay for.')
  }
  if (rupees > MAX_PAYMENT_AMOUNT) {
    throw new OrderPaymentError('This order total is too large to pay online.')
  }

  return { rupees, paise: amountPaise }
}

/** Razorpay's reconciliation reference — the order number, capped at 40 chars. */
export function orderPaymentReceipt(orderNumber: string): string {
  return orderNumber.slice(0, MAX_RECEIPT_LENGTH)
}

/** The pending intent for this order, if there is one. */
async function findPendingIntent(tx: Db, tenantId: string, orderId: string) {
  const [intent] = await tx
    .select({
      id: paymentIntents.id,
      gatewayOrderId: paymentIntents.gatewayOrderId,
      amount: paymentIntents.amount,
      currency: paymentIntents.currency,
    })
    .from(paymentIntents)
    .where(
      and(
        eq(paymentIntents.tenantId, tenantId),
        eq(paymentIntents.orderId, orderId),
        eq(paymentIntents.purpose, PURPOSE),
        eq(paymentIntents.status, 'pending'),
      ),
    )
    .limit(1)
  return intent ?? null
}

/** True when a stored pending intent still matches what the order actually costs. */
function intentMatches(
  intent: { amount: string; currency: string },
  amountPaise: number,
  currency: string,
): boolean {
  return paise(Number(intent.amount)) === amountPaise && intent.currency === currency
}

/**
 * Run the persistence step, converting ANY failure into an
 * OrphanedOrderPaymentError that carries the gateway order id — see
 * deposits.ts's persistIntent for why: past the gateway call the order
 * exists at Razorpay whatever happens here.
 */
async function persistIntent<T>(gatewayOrderId: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch {
    throw new OrphanedOrderPaymentError(gatewayOrderId)
  }
}

export type CreateOrderPaymentIntentDeps = {
  runInTx: RunInTx
  /** Loaded through loadRazorpayCredentialsForTenant by the caller. */
  credentials: RazorpayCredentials
  /** Injectable so tests can drive gateway success and failure. */
  createOrder: CreateOrderFn
  actor: { tenantId: string }
}

/**
 * Create (or reuse) a Razorpay order for a standalone order's total.
 *
 * At NO point does this function mark anything paid, captured, or settled,
 * or move the order out of `acceptanceStatus = 'awaiting_payment'` — that is
 * the webhook's job alone (lib/payments/webhook.ts), exactly as it is for a
 * booking deposit.
 */
export async function createOrderPaymentIntent(
  input: CreateOrderPaymentIntentInput,
  deps: CreateOrderPaymentIntentDeps,
): Promise<OrderPaymentCheckout> {
  const { runInTx, credentials, createOrder, actor } = deps
  const { orderId } = createOrderPaymentIntentInputSchema.parse(input)

  // ── 1. validate and price, under the order lock ───────────────────────────
  const prepared = await runInTx(async (tx) => {
    const order = await loadPayableOrder(tx, actor.tenantId, orderId)
    const lines = await loadOrderFoodLines(tx, actor.tenantId, order.id)
    const amount = resolveOrderAmount(lines)
    const existing = await findPendingIntent(tx, actor.tenantId, order.id)
    return { order, amount, existing }
  })

  const { order, amount } = prepared

  if (prepared.existing && intentMatches(prepared.existing, amount.paise, order.currency)) {
    return {
      orderId: prepared.existing.gatewayOrderId,
      amount: amount.paise,
      amountRupees: amount.rupees,
      currency: order.currency,
      keyId: credentials.keyId,
      orderNumber: order.orderNumber,
      reused: true,
    }
  }

  // ── 2. the gateway call ────────────────────────────────────────────────────
  const gatewayOrder = await createOrder(credentials, {
    amountPaise: amount.paise,
    currency: order.currency,
    receipt: orderPaymentReceipt(order.orderNumber),
    notes: {
      orderId: order.id,
      tenantId: actor.tenantId,
      purpose: PURPOSE,
    },
  })

  // ── 3. persist the intent ──────────────────────────────────────────────────
  const persisted = await persistIntent(gatewayOrder.id, () =>
    runInTx(async (tx) => {
      // Re-lock and re-price in case a concurrent request reached this point
      // first. Unlike deposits.ts there is no "the amount changed, cancel and
      // replace" branch: an order's total cannot drift after creation, so a
      // winner found here is either the same amount (use it) or something is
      // badly wrong (refuse rather than silently reconcile).
      const fresh = await loadPayableOrder(tx, actor.tenantId, orderId)
      const freshLines = await loadOrderFoodLines(tx, actor.tenantId, fresh.id)
      const freshAmount = resolveOrderAmount(freshLines)

      const winner = await findPendingIntent(tx, actor.tenantId, fresh.id)
      if (winner) {
        if (!intentMatches(winner, freshAmount.paise, fresh.currency)) {
          throw new OrderPaymentError(
            "This order's total changed unexpectedly. Please contact the venue.",
          )
        }
        return { orderId: winner.gatewayOrderId, reused: true }
      }

      await tx.insert(paymentIntents).values({
        tenantId: actor.tenantId,
        branchId: fresh.branchId,
        orderId: fresh.id,
        bookingId: null,
        purpose: PURPOSE,
        gateway: GATEWAY,
        gatewayOrderId: gatewayOrder.id,
        amount: freshAmount.rupees.toFixed(2),
        currency: fresh.currency,
        status: 'pending',
        createdBy: null,
      })

      return { orderId: gatewayOrder.id, reused: false }
    }),
  )

  return {
    orderId: persisted.orderId,
    amount: amount.paise,
    amountRupees: amount.rupees,
    currency: order.currency,
    keyId: credentials.keyId,
    orderNumber: order.orderNumber,
    reused: persisted.reused,
  }
}
