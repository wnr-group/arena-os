import 'server-only'
import { and, eq, isNull, or, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { ownerDb } from '@/db'
import type * as schema from '@/db/schema'
import {
  bookings,
  eventRegistrations,
  invoices,
  orders,
  paymentIntents,
  tenants,
  webhookEvents,
} from '@/db/schema'
import { issueInvoiceForOrder } from '@/lib/billing/invoice'
import { paise, recordVerifiedGatewayPayment } from '@/lib/billing/payments'
import { applyPaidDepositsToInvoice, backfillDepositOrderIds } from './deposit-settlement'
import {
  REFUND_OUTCOMES,
  confirmEventRegistrationPayment,
  type ConfirmRegistrationOutcome,
} from './event-registration-payment'
import type { RazorpayPaymentEntity } from './razorpay-webhook'

/**
 * Applying a SIGNATURE-VERIFIED Razorpay webhook.
 *
 * ── Preconditions this module assumes, and does not re-check ────────────────
 * The caller (app/api/webhooks/razorpay/route.ts) has already:
 *   1. read the RAW body,
 *   2. resolved a candidate tenant from the request host,
 *   3. verified the HMAC over that raw body with THAT tenant's webhook secret,
 *   4. parsed the JSON only afterwards.
 * `verifiedTenantId` below therefore means "the tenant whose webhook secret
 * actually signed this message" — it is authentication, not a payload claim.
 *
 * ── Why the owner connection ────────────────────────────────────────────────
 * There is no user session on a webhook, so `withUser()` has no `app.user_id`
 * to set and RLS has no predicate to match. This is the narrow, documented
 * exception the architecture allows, and it is contained by:
 *   * every statement below filtering explicitly on `verifiedTenantId`;
 *   * the intent being located by (gateway, order id) and then REQUIRED to
 *     belong to that tenant — a mismatch aborts before any write;
 *   * all writes happening in ONE transaction that rolls back as a unit;
 *   * this file being the only place it happens, with no generic "elevated
 *     payment write" helper exported for anything else to reach for.
 *
 * ── What is authoritative ───────────────────────────────────────────────────
 * `payment_intents.status = 'paid'` plus `gateway_payment_id` IS the record
 * that a deposit was received. The `payments` row is a projection of it onto an
 * invoice, and only exists when an invoice already exists to project onto.
 */

type Db = NodePgDatabase<typeof schema>

/**
 * What the route should do with the result.
 *
 * `processed` is a discriminated union on `purpose`: a booking deposit
 * settles onto a (possibly not-yet-existing) booking invoice, while an order
 * payment always raises its OWN invoice right here (there is no earlier point
 * a standalone order could have been billed). Kept as two shapes rather than
 * one with optional fields, so a caller reading `outcome.bookingId` on an
 * order-payment outcome is a type error, not a runtime `undefined`.
 */
export type WebhookOutcome =
  /** A booking deposit, applied for the first time. */
  | {
      kind: 'processed'
      purpose: 'booking_deposit'
      intentId: string
      bookingId: string
      invoicePaymentId: string | null
    }
  /** A standalone order's pay-now, applied for the first time. */
  | {
      kind: 'processed'
      purpose: 'order_payment'
      intentId: string
      orderId: string
      invoiceId: string
      invoicePaymentId: string
    }
  /**
   * An event entry fee (M15 #3), applied for the first time.
   *
   * `registrationOutcome` is not decoration: a verified payment can arrive for
   * a place that no longer exists (the hold expired and the last place went
   * while the customer was at the payment page). Capacity is the invariant that
   * does not bend, so the registration is cancelled and flagged
   * refund_required — and the caller has to be told, because a payment that did
   * NOT buy a place is the one case a human must look at.
   */
  | {
      kind: 'processed'
      purpose: 'event_registration'
      intentId: string
      registrationId: string
      registrationOutcome: ConfirmRegistrationOutcome
      refundRequired: boolean
    }
  /** Already applied — a retry, a redelivery, or a replay. A no-op. */
  | { kind: 'duplicate'; intentId: string | null; reason: string }
  /** Verified, but not something we act on (wrong event, unknown order). */
  | { kind: 'ignored'; reason: string }
  /** Verified signature but the CONTENT is wrong. Never retry these. */
  | { kind: 'rejected'; reason: string }

export type ApplyWebhookParams = {
  /** The tenant whose webhook secret verified the signature. */
  verifiedTenantId: string
  eventType: string
  eventId: string | null
  payment: RazorpayPaymentEntity
}

const GATEWAY = 'razorpay' as const

/**
 * Claim an event id before doing any work.
 *
 * The unique index on (gateway, event_id) is what makes this a claim rather
 * than a check: two concurrent redeliveries of one event both try to insert,
 * exactly one succeeds, and the loser gets 23505 and stops. An application-only
 * `if (!exists)` would let both through.
 *
 * Returns false when the event has already been claimed.
 */
async function claimEvent(
  tx: Db,
  row: {
    eventId: string | null
    eventType: string
    tenantId: string | null
    orderId: string | null
    paymentId: string | null
    outcome: string
  },
): Promise<boolean> {
  try {
    await tx.insert(webhookEvents).values({ gateway: GATEWAY, ...row })
    return true
  } catch (e) {
    if (pgCode(e) === '23505') return false
    throw e
  }
}

/** Drizzle wraps driver errors; the SQLSTATE lives on `cause`. */
function pgCode(e: unknown): string | undefined {
  let cur: unknown = e
  for (let d = 0; d < 5 && cur && typeof cur === 'object'; d++) {
    const o = cur as { code?: unknown; cause?: unknown }
    if (typeof o.code === 'string') return o.code
    cur = o.cause
  }
}

/**
 * Apply a verified `payment.captured` webhook.
 *
 * Every state change happens inside one transaction, so a failure anywhere
 * leaves the database exactly as it was — there is no window in which the
 * intent is paid but the payment row is missing, or the reverse.
 *
 * Throws only on genuine infrastructure faults, which the route turns into a
 * 500 so Razorpay retries. Every business outcome — duplicate, mismatch,
 * unknown order — is a returned value, because retrying those would never help.
 */
export async function applyVerifiedPaymentWebhook(
  params: ApplyWebhookParams,
  db: Db = ownerDb,
): Promise<WebhookOutcome> {
  const { verifiedTenantId, eventType, eventId, payment } = params
  const orderId = payment.order_id

  return db.transaction(async (tx) => {
    const logRow = {
      eventId,
      eventType,
      tenantId: verifiedTenantId,
      orderId,
      paymentId: payment.id,
    }

    // ── 0. delivery-level idempotency ─────────────────────────────────────
    if (eventId) {
      const claimed = await claimEvent(tx, { ...logRow, outcome: 'processed' })
      if (!claimed) {
        return { kind: 'duplicate', intentId: null, reason: 'event already delivered' }
      }
    }

    // ── 1. a payment with no order cannot be matched to an intent ─────────
    if (!orderId) {
      await noteOutcome(tx, eventId, 'ignored')
      return { kind: 'ignored', reason: 'payment carries no order id' }
    }

    // ── 2. locate OUR intent, and lock it ─────────────────────────────────
    // Found by (gateway, order id) — the unique key AROS-49 wrote — then
    // required to belong to the verified tenant. This is the cross-tenant
    // check: tenant A's signed webhook naming tenant B's order matches
    // nothing and is rejected before any write.
    const [intent] = await tx
      .select({
        id: paymentIntents.id,
        tenantId: paymentIntents.tenantId,
        purpose: paymentIntents.purpose,
        bookingId: paymentIntents.bookingId,
        orderId: paymentIntents.orderId,
        eventRegistrationId: paymentIntents.eventRegistrationId,
        amount: paymentIntents.amount,
        currency: paymentIntents.currency,
        status: paymentIntents.status,
        gatewayOrderId: paymentIntents.gatewayOrderId,
        gatewayPaymentId: paymentIntents.gatewayPaymentId,
      })
      .from(paymentIntents)
      .where(
        and(
          eq(paymentIntents.gateway, GATEWAY),
          eq(paymentIntents.gatewayOrderId, orderId),
          eq(paymentIntents.tenantId, verifiedTenantId),
        ),
      )
      .for('update')
      .limit(1)

    if (!intent) {
      // Either an order we never created, or one belonging to a different
      // tenant. Both mean: do not invent a payment. Acknowledged, not retried.
      await noteOutcome(tx, eventId, 'ignored')
      return { kind: 'ignored', reason: 'no matching payment intent for this tenant' }
    }

    // Redundant given the WHERE, asserted anyway: this is the single most
    // important invariant in the file and must not depend on one clause.
    if (intent.tenantId !== verifiedTenantId) {
      await noteOutcome(tx, eventId, 'rejected')
      return { kind: 'rejected', reason: 'tenant mismatch' }
    }

    // ── 3. payment-level idempotency ──────────────────────────────────────
    if (intent.gatewayPaymentId) {
      if (intent.gatewayPaymentId === payment.id) {
        await noteOutcome(tx, eventId, 'duplicate')
        return { kind: 'duplicate', intentId: intent.id, reason: 'payment already applied' }
      }
      // A DIFFERENT payment against an already-settled intent. Never apply a
      // second one; that would be charging the deposit twice.
      await noteOutcome(tx, eventId, 'rejected')
      return { kind: 'rejected', reason: 'intent already settled by another payment' }
    }

    if (intent.status !== 'pending') {
      // Cancelled (superseded by a re-priced deposit) or already failed. Money
      // may genuinely have arrived against a stale order — that needs a human,
      // not an automatic capture.
      await noteOutcome(tx, eventId, 'rejected')
      return { kind: 'rejected', reason: `intent is ${intent.status}, not pending` }
    }

    // ── 4. the money must match OUR record, not Razorpay's assertion ──────
    if (payment.order_id !== intent.gatewayOrderId) {
      await noteOutcome(tx, eventId, 'rejected')
      return { kind: 'rejected', reason: 'order id mismatch' }
    }
    if (payment.currency !== intent.currency) {
      await noteOutcome(tx, eventId, 'rejected')
      return { kind: 'rejected', reason: 'currency mismatch' }
    }
    // Compared as integer paise on both sides. Razorpay sends the smallest
    // unit; our stored amount is numeric(10,2) rupees through paise().
    const expectedPaise = paise(Number(intent.amount))
    if (!Number.isSafeInteger(expectedPaise) || payment.amount !== expectedPaise) {
      await noteOutcome(tx, eventId, 'rejected')
      return { kind: 'rejected', reason: 'amount mismatch' }
    }
    // Razorpay's own view of the payment must also be captured. A webhook whose
    // entity says 'failed' or 'authorized' is not money in the account.
    if (payment.status !== 'captured') {
      await noteOutcome(tx, eventId, 'rejected')
      return { kind: 'rejected', reason: `payment status is ${payment.status}` }
    }

    // ── 5. the target — a booking, a standalone order, or an event
    //      registration — must exist, in the same tenant ────────────────────
    // The composite FKs already guarantee this structurally; read the row
    // back so a deleted or cross-tenant target can never be settled against.
    // Branches on `intent.purpose`: an intent is for exactly one of the three
    // (payment_intents_exactly_one_target, migrations 0058/0092), so exactly
    // one of `booking`/`order`/`registration` below is ever looked up.
    let booking: { id: string } | null = null
    let order: { id: string; branchId: string; customerId: string | null; orderNumber: string; status: string; acceptanceStatus: string } | null = null
    let registration: { id: string } | null = null

    if (intent.purpose === 'event_registration') {
      // The registration must exist, in the verified tenant.
      //
      // Deliberately NOT `for update`. Every M15 capacity path takes the EVENT
      // row first and the registration rows after it (claim, cancel, promotion,
      // and confirm_event_registration_payment below all do). Locking a
      // registration here would take them in the opposite order and give two
      // concurrent transactions a way to deadlock — a cancellation holding the
      // event and wanting this row, against this holding the row and wanting
      // the event. This read is only a pre-check; the authoritative read
      // happens inside the SQL function, under the event lock.
      const [row] = await tx
        .select({ id: eventRegistrations.id, paymentReference: eventRegistrations.paymentReference })
        .from(eventRegistrations)
        .where(
          and(
            eq(eventRegistrations.id, intent.eventRegistrationId!),
            eq(eventRegistrations.tenantId, verifiedTenantId),
          ),
        )
        .limit(1)
      if (!row) {
        await noteOutcome(tx, eventId, 'rejected')
        return { kind: 'rejected', reason: 'event registration not found for this tenant' }
      }
      // A REDELIVERY of the payment already applied: checked before the intent
      // is settled, so it leaves this transaction without writing anything.
      if (row.paymentReference && row.paymentReference === payment.id) {
        await noteOutcome(tx, eventId, 'duplicate')
        return {
          kind: 'duplicate',
          intentId: intent.id,
          reason: 'registration already confirmed by this payment',
        }
      }
      // A DIFFERENT payment id is deliberately NOT short-circuited.
      //
      // It means a second, distinct, verified-and-CAPTURED payment landed on a
      // place that is already paid for — the venue is holding money it owes
      // back. Returning `rejected` here (which is what this used to do) left
      // that money with no refund_required flag, no audit row and no console
      // trail: the only trace was a webhook_events row marked rejected, and
      // idx_event_registrations_refund_required — the list an operator works
      // from — never saw it.
      //
      // So it falls through to confirm_event_registration_payment(), whose
      // `already_paid` branch flags the registration and audits it, and which
      // this file then reports through REFUND_OUTCOMES exactly as it already
      // reports `unfulfillable` and `amount_mismatch`. The place itself is
      // never granted twice — the SQL refuses that under the event lock.
      registration = { id: row.id }
    } else if (intent.purpose === 'booking_deposit') {
      const [row] = await tx
        .select({ id: bookings.id, tenantId: bookings.tenantId })
        .from(bookings)
        .where(and(eq(bookings.id, intent.bookingId!), eq(bookings.tenantId, verifiedTenantId)))
        .limit(1)
      if (!row) {
        await noteOutcome(tx, eventId, 'rejected')
        return { kind: 'rejected', reason: 'booking not found for this tenant' }
      }
      booking = { id: row.id }
    } else {
      const [row] = await tx
        .select({
          id: orders.id,
          tenantId: orders.tenantId,
          branchId: orders.branchId,
          customerId: orders.customerId,
          orderNumber: orders.orderNumber,
          status: orders.status,
          acceptanceStatus: orders.acceptanceStatus,
        })
        .from(orders)
        .where(and(eq(orders.id, intent.orderId!), eq(orders.tenantId, verifiedTenantId)))
        .for('update')
        .limit(1)
      if (!row) {
        await noteOutcome(tx, eventId, 'rejected')
        return { kind: 'rejected', reason: 'order not found for this tenant' }
      }
      // Anything other than 'awaiting_payment' means this order was already
      // settled (a redelivery racing the first) or moved by some other path —
      // neither should ever re-fire an invoice or re-flip the order.
      if (row.acceptanceStatus !== 'awaiting_payment' || row.status !== 'open') {
        await noteOutcome(tx, eventId, 'rejected')
        return { kind: 'rejected', reason: `order is ${row.status}/${row.acceptanceStatus}, not awaiting payment` }
      }
      order = row
    }

    // ── 6. settle the intent ──────────────────────────────────────────────
    // The partial unique index on (gateway, gateway_payment_id) is the real
    // guarantee here: a concurrent delivery that got past step 3 fails on this
    // UPDATE and rolls the whole transaction back rather than paying twice.
    const settled = await tx
      .update(paymentIntents)
      .set({ status: 'paid', gatewayPaymentId: payment.id })
      .where(
        and(
          eq(paymentIntents.id, intent.id),
          eq(paymentIntents.tenantId, verifiedTenantId),
          // Only from pending, and only when unclaimed — belt and braces
          // against a lost update.
          eq(paymentIntents.status, 'pending'),
          isNull(paymentIntents.gatewayPaymentId),
        ),
      )
      .returning({ id: paymentIntents.id })

    if (settled.length === 0) {
      await noteOutcome(tx, eventId, 'duplicate')
      return { kind: 'duplicate', intentId: intent.id, reason: 'intent settled concurrently' }
    }

    if (intent.purpose === 'event_registration') {
      // ── 7c. confirm the place ────────────────────────────────────────────
      // The amount handed over is the INTENT's stored figure — which step 4
      // has just proved equals the paise Razorpay reported. The SQL function
      // compares it against events.entry_fee a third time, under the event's
      // own lock, before it grants anything. No number in this path ever came
      // from a browser.
      const outcome = await confirmEventRegistrationPayment(tx, {
        registrationId: registration!.id,
        paymentReference: payment.id,
        amount: intent.amount,
      })

      if (outcome === 'not_found') {
        // The row was read `for update` a few statements ago. Refuse loudly
        // rather than reporting a confirmation that did not happen.
        throw new Error(
          `event_registration webhook: registration ${registration!.id} vanished mid-transaction`,
        )
      }

      const refundRequired = REFUND_OUTCOMES.includes(outcome)
      if (refundRequired) {
        // Money the venue holds against no place. Logged with the ids a human
        // needs and nothing else — no secret, no signature, no raw body.
        console.error(
          `[razorpay-webhook] event registration ${registration!.id} could not be honoured (${outcome}) — refund required for payment ${payment.id}`,
        )
      }

      return {
        kind: 'processed',
        purpose: 'event_registration',
        intentId: intent.id,
        registrationId: registration!.id,
        registrationOutcome: outcome,
        refundRequired,
      }
    }

    if (intent.purpose === 'booking_deposit') {
      // ── 7a. project onto an invoice, if one exists ───────────────────────
      // Deposits are taken BEFORE the bill is raised, so usually there is no
      // invoice yet and this is skipped; AROS-51 nets the deposit off the
      // total when the invoice is created. When a bill does already exist,
      // the deposit is recorded against it through the shared M1 path, which
      // applies the same lock and the same overpayment rule.
      const [invoice] = await tx
        .select({ id: invoices.id })
        .from(invoices)
        .where(
          and(
            eq(invoices.tenantId, verifiedTenantId),
            eq(invoices.bookingId, booking!.id),
            or(eq(invoices.status, 'issued'), eq(invoices.status, 'draft')),
          ),
        )
        .orderBy(sql`${invoices.createdAt} desc`)
        .limit(1)

      // Goes through the SAME carry-over helper invoice creation uses
      // (AROS-51), so the two entry points cannot drift on the overpayment
      // rule, the already-applied check, or the invoice status transition.
      let invoicePaymentId: string | null = null
      if (invoice) {
        const carried = await applyPaidDepositsToInvoice(
          tx,
          verifiedTenantId,
          booking!.id,
          invoice.id,
        )
        invoicePaymentId =
          carried.applied.find((d) => d.gatewayPaymentId === payment.id)?.paymentId ?? null
        if (carried.applied.length > 0) {
          await backfillDepositOrderIds(tx, verifiedTenantId, invoice.id)
        }
      }

      return {
        kind: 'processed',
        purpose: 'booking_deposit',
        intentId: intent.id,
        bookingId: booking!.id,
        invoicePaymentId,
      }
    }

    // ── 7b. order_payment: raise the order's OWN invoice, right here ───────
    // Unlike a deposit there is no pre-existing bill to net against — a
    // standalone order was never billable any other way — so the invoice is
    // always newly created, in this same transaction as the intent
    // settlement above and the payment record below.
    //
    // The tenant's timezone (for the invoice's financial-year numbering) has
    // to be read here: unlike the RLS-scoped booking-deposit path, this owner
    // connection has nothing but `verifiedTenantId` in scope so far.
    const [tenantRow] = await tx
      .select({ timezone: tenants.timezone })
      .from(tenants)
      .where(eq(tenants.id, verifiedTenantId))
      .limit(1)
    if (!tenantRow) {
      // Cannot happen — the tenant was just resolved by the route to load the
      // webhook secret that verified this signature — but refuses loudly
      // rather than raising an invoice with a guessed timezone.
      throw new Error(`order_payment webhook: tenant ${verifiedTenantId} vanished mid-transaction`)
    }
    const issued = await issueInvoiceForOrder(
      tx,
      { id: verifiedTenantId, timezone: tenantRow.timezone },
      order!,
    )

    // recordVerifiedGatewayPayment is the SAME M1 path the deposit carry-over
    // uses: locks the invoice, re-reads capturedTotal(), applies the
    // overpayment rule, and settles it to 'paid'. The amount always covers
    // the total exactly — this invoice was priced from the very order_items
    // the intent's own amount was derived from (lib/payments/order-payment.ts),
    // so there is no partial-payment case to handle here.
    const recorded = await recordVerifiedGatewayPayment(tx, {
      tenantId: verifiedTenantId,
      invoiceId: issued.invoiceId,
      amount: Number(intent.amount),
      gateway: GATEWAY,
      gatewayOrderId: intent.gatewayOrderId,
      gatewayPaymentId: payment.id,
    })
    if (!recorded) {
      // Cannot happen given the invoice was just raised for exactly this
      // amount — but recordVerifiedGatewayPayment returning null must never
      // be swallowed into "processed" for money that was not, in fact,
      // recorded.
      throw new Error(
        `order_payment webhook: recordVerifiedGatewayPayment refused invoice ${issued.invoiceId} for intent ${intent.id}`,
      )
    }

    // Release the order: visible to /kitchen (acceptanceStatus='accepted')
    // and no longer billable a second time (status='billed', the same flip
    // issueInvoiceForBooking applies to a booking's food orders).
    await tx
      .update(orders)
      .set({ acceptanceStatus: 'accepted', status: 'billed' })
      .where(and(eq(orders.id, order!.id), eq(orders.tenantId, verifiedTenantId)))

    return {
      kind: 'processed',
      purpose: 'order_payment',
      intentId: intent.id,
      orderId: order!.id,
      invoiceId: issued.invoiceId,
      invoicePaymentId: recorded.paymentId,
    }
  })
}

/** Correct the delivery-log row once the outcome is known. */
async function noteOutcome(tx: Db, eventId: string | null, outcome: string): Promise<void> {
  if (!eventId) return
  await tx
    .update(webhookEvents)
    .set({ outcome })
    .where(and(eq(webhookEvents.gateway, GATEWAY), eq(webhookEvents.eventId, eventId)))
}

/**
 * Log a verified-but-unhandled event (payment.failed, refunds, order events).
 *
 * Recorded so an operator can see what arrived, and so a redelivery is
 * recognised — but it touches no payment state whatsoever.
 */
export async function logIgnoredEvent(
  params: {
    verifiedTenantId: string | null
    eventType: string
    eventId: string | null
    orderId: string | null
    paymentId: string | null
  },
  db: Db = ownerDb,
): Promise<void> {
  if (!params.eventId) return
  try {
    await db.insert(webhookEvents).values({
      gateway: GATEWAY,
      eventId: params.eventId,
      eventType: params.eventType,
      tenantId: params.verifiedTenantId,
      orderId: params.orderId,
      paymentId: params.paymentId,
      outcome: 'ignored',
    })
  } catch (e) {
    // A duplicate here just means we have seen this event before — expected.
    if (pgCode(e) !== '23505') throw e
  }
}
