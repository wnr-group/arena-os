import 'server-only'
import { and, eq, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { z } from 'zod'
import type * as schema from '@/db/schema'
import { eventRegistrations, events, paymentIntents } from '@/db/schema'
import { MAX_PAYMENT_AMOUNT, paise } from '@/lib/billing/payments'
import { round2 } from '@/lib/billing/pricing'
import { MAX_RECEIPT_LENGTH, type CreateOrderFn } from './razorpay'
import type { RazorpayCredentials } from '@/lib/settings/razorpay-credentials'

/**
 * Paid event registration — the transactional core behind M15 #3.
 *
 * Third sibling of ./booking-payment.ts and ./order-payment.ts, and built to
 * exactly the same shape: validate → gateway call → persist, in two
 * transactions because Razorpay is an HTTP call and cannot join a Postgres one.
 * Same tenant BYO credentials, same `payment_intents` table, same webhook. No
 * second gateway integration exists and none is wanted.
 *
 * ── What the browser is allowed to influence ────────────────────────────────
 *
 * A registration id. Nothing else. The amount is `events.entry_fee` read fresh
 * from the database on both passes, and — the part that matters — the customer
 * INSERT policy on payment_intents (migration 0083) contains
 *
 *     payment_intents.amount = e.entry_fee
 *
 * so even a caller that reached this module with an amount of its own choosing
 * could not store it. The price rule is enforced by Postgres, not by this file
 * remembering to enforce it.
 *
 * ── What this module never does ─────────────────────────────────────────────
 *
 * Mark anything paid. The intent is written `pending`; only the verified webhook
 * (./webhook.ts → confirm_event_registration_payment) may turn a registration
 * into `registered`, and it re-derives the fee from the event a third time
 * before it does.
 *
 * ── The place is already held ───────────────────────────────────────────────
 *
 * By the time this runs the registration is `pending_payment` with a live
 * capacity hold, taken under the event lock by claim_event_registration(). So
 * this module never asks "is there room?" — the room was reserved before the
 * customer ever saw a payment page, which is what makes "A and B both pay, both
 * succeed, capacity exceeded" unreachable rather than merely unlikely.
 */

type Db = NodePgDatabase<typeof schema>

/** Runs a callback inside one RLS-scoped transaction (withCustomer). */
export type RunInTx = <T>(fn: (tx: Db) => Promise<T>) => Promise<T>

/** Registration-payment rule violations the caller should show verbatim. */
export class EventRegistrationPaymentError extends Error {}

/** Raised when the gateway order exists but the intent could not be stored. */
export class OrphanedEventRegistrationPaymentError extends Error {
  readonly gatewayOrderId: string
  constructor(gatewayOrderId: string) {
    super('The payment order was created but could not be saved. Please try again.')
    this.name = 'OrphanedEventRegistrationPaymentError'
    this.gatewayOrderId = gatewayOrderId
  }
}

/** The only field the client supplies. */
export const createEventRegistrationPaymentInputSchema = z.object({
  registrationId: z.string().uuid('That registration reference is not valid.'),
})

export type CreateEventRegistrationPaymentInput = z.infer<
  typeof createEventRegistrationPaymentInputSchema
>

/** Exactly what the browser needs to open Razorpay Checkout, and nothing else. */
export type EventRegistrationCheckout = {
  /** Razorpay's gateway order id. */
  orderId: string
  /** Paise — what Checkout expects. */
  amount: number
  /** Rupees, 2dp, for display. */
  amountRupees: number
  currency: string
  keyId: string
  eventTitle: string
  registrationId: string
  /** True when an existing pending order was returned instead of a new one. */
  reused: boolean
}

const PURPOSE = 'event_registration' as const
const GATEWAY = 'razorpay' as const

/** Razorpay is an India-only gateway; paise conversion assumes INR. */
const SUPPORTED_CURRENCY = 'INR'

type PayableRegistration = {
  id: string
  eventId: string
  branchId: string
  eventTitle: string
  entryFee: string
  currency: string
}

/**
 * Load the registration and prove it may be paid for right now.
 *
 * Runs under withCustomer, so `event_registrations_customer_select` has already
 * reduced this table to the caller's own rows: another customer's registration
 * id returns nothing and is answered exactly as a nonexistent one.
 *
 * Deliberately NOT `FOR UPDATE`. Same reason order-payment.ts documents: a
 * locking read requires the row to pass an UPDATE policy too, and a customer
 * context has no UPDATE policy on event_registrations (by design — see 0081).
 * A lock here would silently match zero rows. None is needed: the capacity hold
 * was taken under the event lock at claim time, and the concurrency guard
 * against two simultaneous "Pay" presses is the partial unique index
 * idx_payment_intents_one_pending_event_registration.
 */
async function loadPayableRegistration(
  tx: Db,
  tenantId: string,
  registrationId: string,
): Promise<PayableRegistration> {
  const [row] = await tx
    .select({
      id: eventRegistrations.id,
      tenantId: eventRegistrations.tenantId,
      eventId: eventRegistrations.eventId,
      status: eventRegistrations.status,
      holdExpiresAt: eventRegistrations.paymentHoldExpiresAt,
      paymentReference: eventRegistrations.paymentReference,
      eventTitle: events.title,
      // THE amount. Read from the event, every time, on both passes.
      entryFee: events.entryFee,
      branchId: events.branchId,
      eventStatus: events.status,
    })
    .from(eventRegistrations)
    .innerJoin(events, eq(events.id, eventRegistrations.eventId))
    .where(
      and(eq(eventRegistrations.id, registrationId), eq(eventRegistrations.tenantId, tenantId)),
    )
    .limit(1)

  if (!row) throw new EventRegistrationPaymentError('That registration could not be found.')
  // Belt and braces: the WHERE already scopes by tenant and RLS scopes it
  // again, but this is money and the match is asserted explicitly.
  if (row.tenantId !== tenantId) {
    throw new EventRegistrationPaymentError('That registration could not be found.')
  }
  if (row.paymentReference) {
    throw new EventRegistrationPaymentError('This registration has already been paid for.')
  }
  if (row.status !== 'pending_payment') {
    throw new EventRegistrationPaymentError(
      row.status === 'waitlisted'
        ? 'You are on the waitlist for this event — there is nothing to pay yet.'
        : 'This registration is not awaiting payment.',
    )
  }
  if (!row.holdExpiresAt || row.holdExpiresAt.getTime() <= Date.now()) {
    // The place was released. Paying now would be paying for nothing, and the
    // INSERT policy in 0083 would refuse the intent anyway.
    throw new EventRegistrationPaymentError(
      'The place we were holding for you has expired. Please register again.',
    )
  }
  if (row.eventStatus !== 'registration_open') {
    throw new EventRegistrationPaymentError('Registration is no longer open for this event.')
  }

  return {
    id: row.id,
    eventId: row.eventId,
    branchId: row.branchId,
    eventTitle: row.eventTitle,
    entryFee: row.entryFee,
    currency: SUPPORTED_CURRENCY,
  }
}

/**
 * The fee, in rupees and paise.
 *
 * `entryFee` arrives as a string because the column is numeric(10,2) — the
 * project's rule that money never touches a float on the way in. paise() is the
 * same converter deposits, order pay-now and the webhook comparison all use, so
 * there is exactly one rounding behaviour in the codebase.
 */
export function resolveEventRegistrationAmount(entryFee: string): {
  rupees: number
  paise: number
} {
  const rupees = round2(Number(entryFee))
  if (!Number.isFinite(rupees) || rupees <= 0) {
    throw new EventRegistrationPaymentError('This event has no entry fee to pay.')
  }
  if (rupees > MAX_PAYMENT_AMOUNT) {
    throw new EventRegistrationPaymentError('This entry fee is too large to pay online.')
  }
  const amountPaise = paise(rupees)
  if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0) {
    throw new EventRegistrationPaymentError('This event has no entry fee to pay.')
  }
  return { rupees, paise: amountPaise }
}

/** Razorpay's reconciliation reference. No PII — a registration id prefix. */
export function eventRegistrationReceipt(registrationId: string): string {
  return `EVT-${registrationId.replace(/-/g, '')}`.slice(0, MAX_RECEIPT_LENGTH)
}

/** The pending intent for this registration, if there is one. */
async function findPendingIntent(tx: Db, tenantId: string, registrationId: string) {
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
        eq(paymentIntents.eventRegistrationId, registrationId),
        eq(paymentIntents.purpose, PURPOSE),
        eq(paymentIntents.status, 'pending'),
      ),
    )
    .limit(1)
  return intent ?? null
}

/** True when a stored pending intent still matches what the event now charges. */
function intentMatches(
  intent: { amount: string; currency: string },
  amountPaise: number,
  currency: string,
): boolean {
  return paise(Number(intent.amount)) === amountPaise && intent.currency === currency
}

/**
 * Run the persistence step, converting ANY failure into an
 * OrphanedEventRegistrationPaymentError carrying the gateway order id — past
 * the gateway call the order exists at Razorpay whatever happens here.
 */
async function persistIntent<T>(gatewayOrderId: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch {
    throw new OrphanedEventRegistrationPaymentError(gatewayOrderId)
  }
}

export type CreateEventRegistrationPaymentDeps = {
  /** withCustomer(customerId, …) — the caller's validated session, not an id off the wire. */
  runInTx: RunInTx
  /** Loaded through loadRazorpayCredentialsForTenant — the TENANT's own BYO keys. */
  credentials: RazorpayCredentials
  /** Injectable so tests can drive gateway success and failure. */
  createOrder: CreateOrderFn
  actor: { tenantId: string }
}

/**
 * Create (or reuse) a Razorpay order for one registration's entry fee.
 *
 * At NO point does this mark anything paid. It leaves the intent `pending` and
 * the registration `pending_payment`; the webhook is the only authority that
 * moves either.
 */
export async function createEventRegistrationPayment(
  input: CreateEventRegistrationPaymentInput,
  deps: CreateEventRegistrationPaymentDeps,
): Promise<EventRegistrationCheckout> {
  const { runInTx, credentials, createOrder, actor } = deps
  const { registrationId } = createEventRegistrationPaymentInputSchema.parse(input)

  // ── 1. validate and price ──────────────────────────────────────────────
  const prepared = await runInTx(async (tx) => {
    const registration = await loadPayableRegistration(tx, actor.tenantId, registrationId)
    const amount = resolveEventRegistrationAmount(registration.entryFee)
    const existing = await findPendingIntent(tx, actor.tenantId, registration.id)
    return { registration, amount, existing }
  })

  const { registration, amount } = prepared

  if (prepared.existing && intentMatches(prepared.existing, amount.paise, registration.currency)) {
    return {
      orderId: prepared.existing.gatewayOrderId,
      amount: amount.paise,
      amountRupees: amount.rupees,
      currency: registration.currency,
      keyId: credentials.keyId,
      eventTitle: registration.eventTitle,
      registrationId: registration.id,
      reused: true,
    }
  }

  // ── 2. the gateway call ────────────────────────────────────────────────
  // Notes are echoed back on the webhook and are NEVER read for authorisation
  // there (see the route's header) — they are reconciliation breadcrumbs only.
  const gatewayOrder = await createOrder(credentials, {
    amountPaise: amount.paise,
    currency: registration.currency,
    receipt: eventRegistrationReceipt(registration.id),
    notes: {
      eventRegistrationId: registration.id,
      eventId: registration.eventId,
      tenantId: actor.tenantId,
      purpose: PURPOSE,
    },
  })

  // ── 3. persist the intent ──────────────────────────────────────────────
  const persisted = await persistIntent(gatewayOrder.id, () =>
    runInTx(async (tx) => {
      // Re-read in case a concurrent request reached this point first, and so
      // the amount written is derived from the event a second time.
      const fresh = await loadPayableRegistration(tx, actor.tenantId, registrationId)
      const freshAmount = resolveEventRegistrationAmount(fresh.entryFee)

      const winner = await findPendingIntent(tx, actor.tenantId, fresh.id)
      if (winner) {
        if (!intentMatches(winner, freshAmount.paise, fresh.currency)) {
          throw new EventRegistrationPaymentError(
            'This event’s entry fee changed unexpectedly. Please contact the venue.',
          )
        }
        return { orderId: winner.gatewayOrderId, reused: true }
      }

      await tx.insert(paymentIntents).values({
        tenantId: actor.tenantId,
        branchId: fresh.branchId,
        eventRegistrationId: fresh.id,
        purpose: PURPOSE,
        gateway: GATEWAY,
        gatewayOrderId: gatewayOrder.id,
        // numeric column: a fixed-2 string, so no float reaches money.
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
    currency: registration.currency,
    keyId: credentials.keyId,
    eventTitle: registration.eventTitle,
    registrationId: registration.id,
    reused: persisted.reused,
  }
}

/**
 * What confirm_event_registration_payment() can answer.
 *
 *   confirmed        the place is theirs and the money is recorded against it
 *   duplicate        this exact Razorpay payment was already applied
 *   already_paid     a DIFFERENT payment already settled this entry
 *   unfulfillable    money arrived but the last place had gone — cancelled and
 *                    flagged refund_required
 *   amount_mismatch  the fee moved between checkout and capture — same landing
 *   not_found        the registration vanished (cannot happen; asserted anyway)
 */
export type ConfirmRegistrationOutcome =
  | 'confirmed'
  | 'duplicate'
  | 'already_paid'
  | 'unfulfillable'
  | 'amount_mismatch'
  | 'not_found'

/** Outcomes that mean the venue owes the customer money back. */
export const REFUND_OUTCOMES: readonly ConfirmRegistrationOutcome[] = [
  'unfulfillable',
  'amount_mismatch',
]

/**
 * Confirm a registration from an ALREADY-VERIFIED payment.
 *
 * Called only by lib/payments/webhook.ts, inside its single transaction on the
 * owner connection, AFTER the HMAC has been verified and the payment matched to
 * our own intent. Everything that decides the outcome — the event lock, the
 * occupancy recount, the fee comparison, the idempotency check on
 * payment_reference — happens inside the SQL function, which is where the same
 * lock discipline every other capacity decision uses already lives.
 *
 * `amount` is the INTENT's stored amount, not anything the gateway sent. The
 * webhook has already asserted the gateway's paise figure equals it.
 */
export async function confirmEventRegistrationPayment(
  tx: Db,
  params: { registrationId: string; paymentReference: string; amount: string },
): Promise<ConfirmRegistrationOutcome> {
  const { rows } = await tx.execute<{ outcome: ConfirmRegistrationOutcome }>(
    sql`select public.confirm_event_registration_payment(
          ${params.registrationId}::uuid,
          ${params.paymentReference}::text,
          ${params.amount}::numeric
        ) as outcome`,
  )
  return rows[0]?.outcome ?? 'not_found'
}
