import 'server-only'
import { and, eq, isNull, or, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { ownerDb } from '@/db'
import type * as schema from '@/db/schema'
import { bookings, invoices, paymentIntents, webhookEvents } from '@/db/schema'
import { paise } from '@/lib/billing/payments'
import { applyPaidDepositsToInvoice, backfillDepositOrderIds } from './deposit-settlement'
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

/** What the route should do with the result. */
export type WebhookOutcome =
  /** Applied for the first time. */
  | { kind: 'processed'; intentId: string; bookingId: string; invoicePaymentId: string | null }
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
        bookingId: paymentIntents.bookingId,
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

    // ── 5. the booking must exist, in the same tenant ─────────────────────
    // The composite FK already guarantees this structurally; read it back so a
    // deleted or cross-tenant booking cannot be settled against.
    const [booking] = await tx
      .select({ id: bookings.id, tenantId: bookings.tenantId })
      .from(bookings)
      .where(
        and(eq(bookings.id, intent.bookingId), eq(bookings.tenantId, verifiedTenantId)),
      )
      .limit(1)

    if (!booking) {
      await noteOutcome(tx, eventId, 'rejected')
      return { kind: 'rejected', reason: 'booking not found for this tenant' }
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

    // ── 7. project onto an invoice, if one exists ─────────────────────────
    // Deposits are taken BEFORE the bill is raised, so usually there is no
    // invoice yet and this is skipped; AROS-51 nets the deposit off the total
    // when the invoice is created. When a bill does already exist, the deposit
    // is recorded against it through the shared M1 path, which applies the same
    // lock and the same overpayment rule.
    const [invoice] = await tx
      .select({ id: invoices.id })
      .from(invoices)
      .where(
        and(
          eq(invoices.tenantId, verifiedTenantId),
          eq(invoices.bookingId, booking.id),
          or(eq(invoices.status, 'issued'), eq(invoices.status, 'draft')),
        ),
      )
      .orderBy(sql`${invoices.createdAt} desc`)
      .limit(1)

    // Goes through the SAME carry-over helper invoice creation uses (AROS-51),
    // so the two entry points cannot drift on the overpayment rule, the
    // already-applied check, or the invoice status transition.
    let invoicePaymentId: string | null = null
    if (invoice) {
      const carried = await applyPaidDepositsToInvoice(
        tx,
        verifiedTenantId,
        booking.id,
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
      intentId: intent.id,
      bookingId: booking.id,
      invoicePaymentId,
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
