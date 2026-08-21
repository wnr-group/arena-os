import 'server-only'
import { and, eq, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { z } from 'zod'
import type * as schema from '@/db/schema'
import { bookings, paymentIntents } from '@/db/schema'
import { isBillableBookingStatus } from '@/lib/billing/invoice'
import { MAX_PAYMENT_AMOUNT, paise } from '@/lib/billing/payments'
import { round2 } from '@/lib/billing/pricing'
import { MAX_RECEIPT_LENGTH, type CreateOrderFn } from './razorpay'
import type { RazorpayCredentials } from '@/lib/settings/razorpay-credentials'

/**
 * Booking deposit orders — the transactional core behind AROS-49.
 *
 * Takes a `runInTx` rather than opening its own connection, the same shape as
 * lib/billing/invoice.ts and lib/billing/payments.ts, so the caller supplies
 * RLS-scoped transactions via withUser() and this stays testable without a
 * request context.
 *
 * ── What the browser is allowed to influence ────────────────────────────────
 * A booking id. That is all. The amount, the currency, the tenant, the branch
 * and the eligibility rules are every one of them re-derived here from the
 * database row. There is deliberately no `amount` in the input type, so there
 * is no field a caller could pass one through.
 *
 * ── Why two transactions ────────────────────────────────────────────────────
 * Razorpay is an external HTTP call and cannot join a Postgres transaction.
 * Holding a transaction open across it would pin a pooled connection and a row
 * lock for the round trip. So the flow is: validate (tx1) → gateway call →
 * persist (tx2), with the partial unique index as the concurrency backstop.
 * See createDepositOrder() for exactly what happens when a step fails.
 */

type Db = NodePgDatabase<typeof schema>

/** Runs a callback inside one RLS-scoped transaction. */
export type RunInTx = <T>(fn: (tx: Db) => Promise<T>) => Promise<T>

/** Deposit rule violations the caller should see verbatim. */
export class DepositError extends Error {}

/** Raised when the gateway order exists but the intent could not be stored. */
export class OrphanedOrderError extends Error {
  readonly gatewayOrderId: string
  constructor(gatewayOrderId: string) {
    super('The payment order was created but could not be saved. Please try again.')
    this.name = 'OrphanedOrderError'
    this.gatewayOrderId = gatewayOrderId
  }
}

/** The only field the client supplies. */
export const createDepositOrderInputSchema = z.object({
  bookingId: z.string().uuid('That booking reference is not valid.'),
})

export type CreateDepositOrderInput = z.infer<typeof createDepositOrderInputSchema>

/**
 * Exactly what the browser needs to open Razorpay Checkout, and nothing else.
 *
 * `keyId` is publishable by design. There is no field here for a key secret,
 * so the action's return type cannot carry one even by mistake.
 */
export type DepositCheckout = {
  orderId: string
  /** Paise — what Checkout expects, and what the gateway order was created for. */
  amount: number
  /** Rupees, 2dp, for display. */
  amountRupees: number
  currency: string
  keyId: string
  bookingNumber: string
  /** True when an existing pending order was returned instead of a new one. */
  reused: boolean
}

const PURPOSE = 'booking_deposit' as const
const GATEWAY = 'razorpay' as const

/** Razorpay is an India-only gateway; paise conversion assumes INR. */
const SUPPORTED_CURRENCY = 'INR'

type BookingRow = {
  id: string
  tenantId: string
  branchId: string
  bookingNumber: string
  status: string
  deposit: string
  currency: string
}

/**
 * Load the booking and prove it may take a deposit right now.
 *
 * RLS applies to this read, so another tenant's booking id returns no row —
 * indistinguishable from a bad id, which is what we want. The `FOR UPDATE`
 * serialises concurrent deposit attempts for the same booking against each
 * other, exactly as recordPaymentForInvoice() does for an invoice.
 */
async function loadPayableBooking(
  tx: Db,
  tenantId: string,
  bookingId: string,
): Promise<BookingRow> {
  const [booking] = await tx
    .select({
      id: bookings.id,
      tenantId: bookings.tenantId,
      branchId: bookings.branchId,
      bookingNumber: bookings.bookingNumber,
      status: bookings.status,
      deposit: bookings.deposit,
    })
    .from(bookings)
    .where(and(eq(bookings.id, bookingId), eq(bookings.tenantId, tenantId)))
    .for('update')
    .limit(1)

  if (!booking) throw new DepositError('Booking not found.')

  // Belt and braces: the WHERE already scopes by tenant and RLS scopes it
  // again, but a deposit is money and the tenant match is asserted explicitly
  // so that no future refactor of the query can quietly drop it.
  if (booking.tenantId !== tenantId) throw new DepositError('Booking not found.')

  // Reuses the billing module's status rule rather than inventing one:
  // 'confirmed' and 'checked_in' are the states that can still owe money.
  if (!isBillableBookingStatus(booking.status)) {
    if (booking.status === 'cancelled') throw new DepositError('This booking has been cancelled.')
    if (booking.status === 'no_show') throw new DepositError('This booking was marked a no-show.')
    if (booking.status === 'completed') throw new DepositError('This booking is already completed.')
    throw new DepositError('This booking cannot take a deposit.')
  }

  return { ...booking, currency: SUPPORTED_CURRENCY }
}

/**
 * The deposit amount, in rupees and in paise, from the database row.
 *
 * `bookings.deposit` is numeric(10,2) and arrives as a string, so it never
 * makes a round trip through a float on the way in. round2() and paise() are
 * the project's existing money helpers — no new arithmetic is introduced here.
 */
export function resolveDepositAmount(booking: { deposit: string }): {
  rupees: number
  paise: number
} {
  const raw = Number(booking.deposit)

  if (!Number.isFinite(raw)) {
    throw new DepositError('This booking has no valid deposit amount set.')
  }

  const rupees = round2(raw)
  const amountPaise = paise(rupees)

  // `paise()` rounds, so a stored 0.004 would collapse to 0 — caught here.
  if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0) {
    throw new DepositError('This booking has no deposit to pay.')
  }
  if (rupees > MAX_PAYMENT_AMOUNT) {
    throw new DepositError('That deposit amount is too large to take online.')
  }

  return { rupees, paise: amountPaise }
}

/** The pending intent for this booking, if there is one. */
async function findPendingIntent(tx: Db, tenantId: string, bookingId: string) {
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
        eq(paymentIntents.bookingId, bookingId),
        eq(paymentIntents.purpose, PURPOSE),
        eq(paymentIntents.status, 'pending'),
      ),
    )
    .limit(1)
  return intent ?? null
}

/** True when a stored pending intent still matches what the booking now owes. */
function intentMatches(
  intent: { amount: string; currency: string },
  amountPaise: number,
  currency: string,
): boolean {
  return paise(Number(intent.amount)) === amountPaise && intent.currency === currency
}

/**
 * Razorpay's reconciliation reference. The booking number is short, unique per
 * tenant, meaningful to staff reading a Razorpay dashboard — and carries no
 * PII: no name, no phone, no email, no internal uuid.
 */
export function depositReceipt(bookingNumber: string): string {
  return bookingNumber.slice(0, MAX_RECEIPT_LENGTH)
}

/**
 * Run the persistence step, converting ANY failure into an OrphanedOrderError
 * that carries the gateway order id.
 *
 * Past the gateway call the order exists at Razorpay whatever happens here, so
 * losing its id would leave an untraceable orphan. A DepositError is re-wrapped
 * too: "the booking was cancelled while you were paying" is still a state where
 * an order is live and needs reconciling.
 */
async function persistIntent<T>(gatewayOrderId: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch {
    throw new OrphanedOrderError(gatewayOrderId)
  }
}

export type CreateDepositOrderDeps = {
  runInTx: RunInTx
  /** Loaded through the AROS-48 server-only helper by the caller. */
  credentials: RazorpayCredentials
  /** Injectable so tests can drive gateway success and failure. */
  createOrder: CreateOrderFn
  actor: { tenantId: string; membershipId: string }
}

/**
 * Create (or reuse) a Razorpay order for a booking's deposit.
 *
 * ── The sequence, and what each failure leaves behind ───────────────────────
 *
 *  1. tx1 — lock the booking, check eligibility, compute the amount, look for a
 *     reusable pending intent. If one exists for the same amount and currency,
 *     return it: a double-clicked button never mints a second gateway order.
 *
 *  2. Gateway call. If it fails, nothing has been written; the booking is
 *     untouched and the caller sees a safe error. No payment is recorded.
 *
 *  3. tx2 — re-lock the booking, re-check for a pending intent (a concurrent
 *     request may have won the race while we were on the network), then cancel
 *     any superseded intent and insert the new one. If a matching pending
 *     intent now exists, the order we just created is abandoned and the
 *     winner's is returned instead.
 *
 * ── Where atomicity genuinely does not hold ─────────────────────────────────
 * If step 3 fails after step 2 succeeded, Razorpay holds an order that this
 * database has no row for. That is unavoidable — an external API cannot be
 * rolled back — and it is the SAFE direction to fail in: an unpaid order is
 * inert, expires on Razorpay's side, and no money has moved. The order id is
 * surfaced on OrphanedOrderError and logged by the action so the orphan is
 * identifiable. Should a customer somehow pay it, AROS-50 will receive a
 * webhook for an order id with no matching intent, which is precisely the
 * signal it needs to quarantine rather than silently accept.
 *
 * At NO point does this function mark anything paid, captured, or settled.
 */
export async function createDepositOrder(
  input: CreateDepositOrderInput,
  deps: CreateDepositOrderDeps,
): Promise<DepositCheckout> {
  const { runInTx, credentials, createOrder, actor } = deps
  const { bookingId } = createDepositOrderInputSchema.parse(input)

  // ── 1. validate and price, under the booking lock ─────────────────────────
  const prepared = await runInTx(async (tx) => {
    const booking = await loadPayableBooking(tx, actor.tenantId, bookingId)
    const amount = resolveDepositAmount(booking)
    const existing = await findPendingIntent(tx, actor.tenantId, booking.id)

    return { booking, amount, existing }
  })

  const { booking, amount } = prepared

  if (prepared.existing && intentMatches(prepared.existing, amount.paise, booking.currency)) {
    return {
      orderId: prepared.existing.gatewayOrderId,
      amount: amount.paise,
      amountRupees: amount.rupees,
      currency: booking.currency,
      keyId: credentials.keyId,
      bookingNumber: booking.bookingNumber,
      reused: true,
    }
  }

  // ── 2. the gateway call ───────────────────────────────────────────────────
  // Notes are non-secret identifiers echoed back on the webhook, which lets
  // AROS-50 cross-check the order against the intent it finds. No customer
  // name, phone or email goes to the gateway from here.
  const order = await createOrder(credentials, {
    amountPaise: amount.paise,
    currency: booking.currency,
    receipt: depositReceipt(booking.bookingNumber),
    notes: {
      bookingId: booking.id,
      tenantId: actor.tenantId,
      purpose: PURPOSE,
    },
  })

  // ── 3. persist the intent ─────────────────────────────────────────────────
  // Wrapped: from here on the gateway order EXISTS, so any failure has to carry
  // its id out with it or the orphan becomes untraceable.
  const persisted = await persistIntent(order.id, () =>
    runInTx(async (tx) => {
      // Re-lock: serialises against a concurrent request that reached this point
      // first, and re-proves eligibility in case the booking was cancelled while
      // we were on the network.
      const fresh = await loadPayableBooking(tx, actor.tenantId, bookingId)
      const freshAmount = resolveDepositAmount(fresh)

      const winner = await findPendingIntent(tx, actor.tenantId, bookingId)
      if (winner && intentMatches(winner, freshAmount.paise, fresh.currency)) {
        // Someone else got there first with an equivalent order. Use theirs; ours
        // is abandoned unpaid.
        return { orderId: winner.gatewayOrderId, reused: true, abandoned: order.id }
      }

      if (winner) {
        // A pending intent for a DIFFERENT amount — the deposit changed under it.
        // Cancel it so the partial unique index admits the replacement, and so
        // AROS-50 refuses a late webhook for the stale order.
        await tx
          .update(paymentIntents)
          .set({ status: 'cancelled' })
          .where(
            and(eq(paymentIntents.id, winner.id), eq(paymentIntents.tenantId, actor.tenantId)),
          )
      }

      await tx.insert(paymentIntents).values({
        tenantId: actor.tenantId,
        branchId: fresh.branchId,
        bookingId: fresh.id,
        purpose: PURPOSE,
        gateway: GATEWAY,
        gatewayOrderId: order.id,
        amount: freshAmount.rupees.toFixed(2),
        currency: fresh.currency,
        // Explicit, not relying on the column default: this row must be pending.
        status: 'pending',
        createdBy: actor.membershipId,
      })

      return { orderId: order.id, reused: false, abandoned: null as string | null }
    }),
  )

  return {
    orderId: persisted.orderId,
    amount: amount.paise,
    amountRupees: amount.rupees,
    currency: booking.currency,
    keyId: credentials.keyId,
    bookingNumber: booking.bookingNumber,
    reused: persisted.reused,
  }
}

/**
 * The deposit state of a booking, for rendering the button. Read-only, and
 * carries no gateway credential.
 */
export async function getDepositState(
  tx: Db,
  tenantId: string,
  bookingId: string,
): Promise<{ pendingOrderId: string | null; paid: boolean }> {
  const [row] = await tx
    .select({
      status: paymentIntents.status,
      gatewayOrderId: paymentIntents.gatewayOrderId,
    })
    .from(paymentIntents)
    .where(
      and(
        eq(paymentIntents.tenantId, tenantId),
        eq(paymentIntents.bookingId, bookingId),
        eq(paymentIntents.purpose, PURPOSE),
        sql`${paymentIntents.status} in ('pending','paid')`,
      ),
    )
    // 'paid' sorts before 'pending' alphabetically; order explicitly instead.
    .orderBy(sql`case when ${paymentIntents.status} = 'paid' then 0 else 1 end`)
    .limit(1)

  if (!row) return { pendingOrderId: null, paid: false }
  if (row.status === 'paid') return { pendingOrderId: null, paid: true }
  return { pendingOrderId: row.gatewayOrderId, paid: false }
}
