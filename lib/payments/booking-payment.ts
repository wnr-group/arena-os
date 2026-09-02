import 'server-only'
import { and, eq } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { z } from 'zod'
import type * as schema from '@/db/schema'
import { bookings, paymentIntents } from '@/db/schema'
import { isBillableBookingStatus } from '@/lib/billing/invoice'
import { paise } from '@/lib/billing/pricing'
import { DepositError, resolveDepositAmount, depositReceipt } from './deposits'
import type { CreateOrderFn } from './razorpay'
import type { RazorpayCredentials } from '@/lib/settings/razorpay-credentials'

/**
 * Pay-online-at-booking-time — the PUBLIC counterpart of lib/payments/
 * deposits.ts's createDepositOrder.
 *
 * Sibling to lib/payments/order-payment.ts, same reason for existing
 * separately from deposits.ts rather than being called directly by the
 * public action: deposits.ts's loadPayableBooking takes a `FOR UPDATE` lock,
 * which requires the row to also pass an UPDATE policy under RLS — fine for
 * the staff connection (withUser), but the public connection
 * (withPublicTenant) has no `bookings_public_update` policy, only
 * bookings_public_select/insert (0023_public_booking_create.sql). A locking
 * read here would silently see ZERO rows, not an error. So this file re-reads
 * without a lock, exactly as order-payment.ts already does for the same
 * reason, and leans on the same partial unique index
 * (idx_payment_intents_one_pending_booking) as the concurrency backstop.
 *
 * The amount charged is always the booking's own `deposit` column — set to
 * the full total at creation time when the customer chose "pay online now"
 * (see createPublicBooking, lib/actions/public-booking.ts), never a figure
 * this module invents or accepts from the browser. resolveDepositAmount and
 * depositReceipt are reused as-is from deposits.ts: same money math, same
 * receipt shape, one source of truth for both the staff and public paths.
 */

type Db = NodePgDatabase<typeof schema>

/** Runs a callback inside one RLS-scoped transaction. */
export type RunInTx = <T>(fn: (tx: Db) => Promise<T>) => Promise<T>

/** Booking-payment rule violations the caller should see verbatim. */
export class BookingPaymentError extends Error {}

/** Raised when the gateway order exists but the intent could not be stored. */
export class OrphanedBookingPaymentError extends Error {
  readonly gatewayOrderId: string
  constructor(gatewayOrderId: string) {
    super('The payment order was created but could not be saved. Please try again.')
    this.name = 'OrphanedBookingPaymentError'
    this.gatewayOrderId = gatewayOrderId
  }
}

/** The only field the client supplies. */
export const createBookingPaymentIntentInputSchema = z.object({
  bookingId: z.string().uuid('That booking reference is not valid.'),
})

export type CreateBookingPaymentIntentInput = z.infer<typeof createBookingPaymentIntentInputSchema>

/** Exactly what the browser needs to open Razorpay Checkout, and nothing else. */
export type BookingPaymentCheckout = {
  orderId: string
  /** Paise — what Checkout expects. */
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

type PayableBookingRow = {
  id: string
  branchId: string
  bookingNumber: string
  deposit: string
  currency: string
}

/**
 * Load the booking and prove it may be paid online right now.
 *
 * RLS applies to this read, so another tenant's booking id returns no row.
 * Deliberately NOT `FOR UPDATE` — see this file's own doc comment above.
 */
async function loadPayableBooking(tx: Db, tenantId: string, bookingId: string): Promise<PayableBookingRow> {
  const [booking] = await tx
    .select({
      id: bookings.id,
      tenantId: bookings.tenantId,
      branchId: bookings.branchId,
      bookingNumber: bookings.bookingNumber,
      status: bookings.status,
      source: bookings.source,
      deposit: bookings.deposit,
    })
    .from(bookings)
    .where(and(eq(bookings.id, bookingId), eq(bookings.tenantId, tenantId)))
    .limit(1)

  if (!booking) throw new BookingPaymentError('Booking not found.')
  // Belt and braces: the WHERE already scopes by tenant and RLS scopes it
  // again, but this is money and the match is asserted explicitly.
  if (booking.tenantId !== tenantId) throw new BookingPaymentError('Booking not found.')
  // A staff-taken booking's deposit is staff's to collect at the counter —
  // this endpoint only ever opens a gateway order for one THIS customer
  // placed themselves online.
  if (booking.source !== 'online') throw new BookingPaymentError('This booking cannot be paid online.')
  if (!isBillableBookingStatus(booking.status)) {
    throw new BookingPaymentError('This booking can no longer be paid online.')
  }

  return {
    id: booking.id,
    branchId: booking.branchId,
    bookingNumber: booking.bookingNumber,
    deposit: booking.deposit,
    currency: SUPPORTED_CURRENCY,
  }
}

/** resolveDepositAmount, re-thrown as this module's own error type — its
 *  messages are already customer-safe, just authored under deposits.ts's
 *  DepositError rather than ours. */
function resolveAmount(booking: { deposit: string }): { rupees: number; paise: number } {
  try {
    return resolveDepositAmount(booking)
  } catch (e) {
    if (e instanceof DepositError) throw new BookingPaymentError(e.message)
    throw e
  }
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
function intentMatches(intent: { amount: string; currency: string }, amountPaise: number, currency: string): boolean {
  return paise(Number(intent.amount)) === amountPaise && intent.currency === currency
}

/**
 * Run the persistence step, converting ANY failure into an
 * OrphanedBookingPaymentError that carries the gateway order id — past the
 * gateway call the order exists at Razorpay whatever happens here.
 */
async function persistIntent<T>(gatewayOrderId: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch {
    throw new OrphanedBookingPaymentError(gatewayOrderId)
  }
}

export type CreateBookingPaymentIntentDeps = {
  runInTx: RunInTx
  /** Loaded through loadRazorpayCredentialsForTenant by the caller. */
  credentials: RazorpayCredentials
  /** Injectable so tests can drive gateway success and failure. */
  createOrder: CreateOrderFn
  actor: { tenantId: string }
}

/**
 * Create (or reuse) a Razorpay order for a booking's full online prepayment.
 *
 * At NO point does this function mark anything paid, captured, or settled —
 * that is the webhook's job alone (lib/payments/webhook.ts), which already
 * handles `purpose = 'booking_deposit'` regardless of whether the intent came
 * from here or from the staff deposit flow.
 */
export async function createBookingPaymentIntent(
  input: CreateBookingPaymentIntentInput,
  deps: CreateBookingPaymentIntentDeps,
): Promise<BookingPaymentCheckout> {
  const { runInTx, credentials, createOrder, actor } = deps
  const { bookingId } = createBookingPaymentIntentInputSchema.parse(input)

  // ── 1. validate and price ──────────────────────────────────────────────
  const prepared = await runInTx(async (tx) => {
    const booking = await loadPayableBooking(tx, actor.tenantId, bookingId)
    const amount = resolveAmount(booking)
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

  // ── 2. the gateway call ────────────────────────────────────────────────
  const gatewayOrder = await createOrder(credentials, {
    amountPaise: amount.paise,
    currency: booking.currency,
    receipt: depositReceipt(booking.bookingNumber),
    notes: {
      bookingId: booking.id,
      tenantId: actor.tenantId,
      purpose: PURPOSE,
    },
  })

  // ── 3. persist the intent ──────────────────────────────────────────────
  const persisted = await persistIntent(gatewayOrder.id, () =>
    runInTx(async (tx) => {
      // Re-check in case a concurrent request reached this point first.
      const fresh = await loadPayableBooking(tx, actor.tenantId, bookingId)
      const freshAmount = resolveAmount(fresh)

      const winner = await findPendingIntent(tx, actor.tenantId, fresh.id)
      if (winner) {
        if (!intentMatches(winner, freshAmount.paise, fresh.currency)) {
          throw new BookingPaymentError("This booking's total changed unexpectedly. Please contact the venue.")
        }
        return { orderId: winner.gatewayOrderId, reused: true }
      }

      await tx.insert(paymentIntents).values({
        tenantId: actor.tenantId,
        branchId: fresh.branchId,
        bookingId: fresh.id,
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
    currency: booking.currency,
    keyId: credentials.keyId,
    bookingNumber: booking.bookingNumber,
    reused: persisted.reused,
  }
}
