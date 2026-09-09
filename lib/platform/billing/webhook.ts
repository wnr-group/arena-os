import 'server-only'
import { z } from 'zod'
import { and, eq } from 'drizzle-orm'
import { ownerDb, type DB } from '@/db'
import { webhookEvents } from '@/db/schema'
import { pgError } from '@/lib/utils/errors'
import {
  applySubscriptionState,
  HANDLED_EVENTS,
  WEBHOOK_GATEWAY,
  type ApplyResult,
} from './lifecycle'
import { issueSubscriptionInvoice } from './invoices'
import { billableChargeFor, CHARGE_EVENT } from './renewal'
import { sendDunningNotice } from './dunning-notify'
import { deadlinesFor } from './dunning-policy'
import { applyVerifiedRefundEvent } from './refunds'

/**
 * Applying a SIGNATURE-VERIFIED webhook from the PLATFORM's Razorpay account.
 *
 * The deliberate twin of lib/payments/webhook.ts, which does the same job for a
 * TENANT's account and booking deposits. The two share the delivery-log table
 * and nothing else — different gateway discriminator, different secret,
 * different identity model, different state machine.
 *
 * ── Preconditions the route has already met ─────────────────────────────────
 *   1. read the RAW body,
 *   2. verified the HMAC over those exact bytes with the PLATFORM webhook
 *      secret (lib/platform/billing/credentials.ts),
 *   3. parsed the JSON only afterwards.
 *
 * ── Identity ────────────────────────────────────────────────────────────────
 * There is no tenant in the URL and none is taken from the payload. The tenant
 * is whatever OUR OWN `tenant_subscriptions.gateway_subscription_id` row says,
 * which is why a forged `notes.tenantId` buys an attacker nothing — and why an
 * attacker cannot forge anything anyway without the platform webhook secret.
 *
 * ── Why the owner connection ────────────────────────────────────────────────
 * A webhook has no session, so `withUser()` has no `app.user_id` to set and RLS
 * has no predicate to match. This is the same narrow, documented exception
 * lib/payments/webhook.ts takes, contained the same way: one transaction, one
 * lookup by our own reference, no generic elevated-write helper exported for
 * anything else to reach for. `arena_app` has no write grant on
 * tenant_subscriptions at all (0079), so there is no non-owner path to add.
 */

// ── payload ──────────────────────────────────────────────────────────────────

/**
 * The slice of Razorpay's subscription webhook this application relies on.
 *
 * Strict about identity and state, `.passthrough()` about everything else:
 * Razorpay adds fields over time and a new one must not break billing.
 */
const subscriptionEntitySchema = z
  .object({
    id: z.string().min(1),
    plan_id: z.string().min(1).nullable().optional(),
    customer_id: z.string().min(1).nullable().optional(),
    status: z.string().min(1),
    // Unix seconds. Null until the mandate is authenticated.
    current_start: z.number().int().nullable().optional(),
    current_end: z.number().int().nullable().optional(),
  })
  .passthrough()

const paymentEntitySchema = z
  .object({
    id: z.string().min(1),
    // Razorpay sends the smallest currency unit as an integer. A float here
    // would mean the payload is not what we think it is, so it is rejected
    // rather than coerced — this figure becomes the invoice total.
    amount: z.number().int().nonnegative().optional(),
    // LETTERS, and normalised to upper case. `min(3).max(3)` accepted "1$X",
    // and the 0081 CHECK (`length(currency) = 3`) lets the same through — so a
    // malformed code could reach platform_invoices.currency and from there
    // Intl.NumberFormat, which throws RangeError on anything that is not a
    // well-formed ISO 4217 code and took the owner's invoice page down with it.
    // The same tightening lib/actions/plans.ts already applies to a catalogue
    // price, applied to the one other door a currency comes in through.
    currency: z
      .string()
      .trim()
      .regex(/^[A-Za-z]{3}$/)
      .transform((c) => c.toUpperCase())
      .optional(),
    status: z.string().min(1).optional(),
    // Razorpay raises its own invoice for a subscription charge. Its id is
    // stored on our invoice so a dispute can be answered from either side.
    invoice_id: z.string().min(1).nullable().optional(),
    // ── why a charge failed (AROS-113) ─────────────────────────────────────
    //
    // Present on a failed payment; absent on a successful one. Captured for the
    // operator and for the owner-facing arrears banner, and for NOTHING else —
    // no branch in the lifecycle reads it, so a provider that renames a code or
    // rewords a description cannot change what happens to an account.
    //
    // Length-capped where it is stored (lib/platform/billing/lifecycle.ts) and
    // again by a CHECK in migration 0082, because it is gateway-authored text
    // that ends up on a page.
    error_code: z.string().min(1).nullable().optional(),
    error_description: z.string().min(1).nullable().optional(),
    error_reason: z.string().min(1).nullable().optional(),
  })
  .passthrough()

/**
 * The refund entity, for `refund.processed` / `refund.failed` (AROS-114).
 *
 * Strict about the id — it is the ONLY thing matched against our own record —
 * and permissive about everything else. The AMOUNT is deliberately not relied
 * on: what a refund was for is decided when it is created, from a locked
 * invoice row, and re-deriving it from a payload would let a delivery restate
 * how much money left the account.
 */
const refundEntitySchema = z
  .object({
    id: z.string().min(1),
    // The payment the refund was taken from. Carried through because it is the
    // ONLY way to settle a refund whose `rfnd_…` id we never learned — see
    // applyVerifiedRefundEvent() in ./refunds.ts.
    payment_id: z.string().min(1).nullable().optional(),
    // Smallest currency unit, like every other Razorpay amount. Used to
    // disambiguate when one payment carries several unsettled refunds; never to
    // decide the outcome, which comes from the event name.
    amount: z.number().int().nonnegative().optional(),
    status: z.string().min(1).optional(),
  })
  .passthrough()

const platformWebhookSchema = z
  .object({
    event: z.string().min(1),
    payload: z
      .object({
        subscription: z
          .object({ entity: subscriptionEntitySchema })
          .passthrough()
          .optional(),
        payment: z.object({ entity: paymentEntitySchema }).passthrough().optional(),
        refund: z.object({ entity: refundEntitySchema }).passthrough().optional(),
      })
      .passthrough(),
  })
  .passthrough()

export type PlatformSubscriptionEntity = z.infer<typeof subscriptionEntitySchema>
export type PlatformPaymentEntity = z.infer<typeof paymentEntitySchema>
export type PlatformRefundEntity = z.infer<typeof refundEntitySchema>

export type ParsedPlatformWebhook =
  | {
      ok: true
      event: string
      subscription: PlatformSubscriptionEntity | null
      paymentId: string | null
      /** The whole payment entity, when the event carried one. */
      payment: PlatformPaymentEntity | null
      /** The refund entity, on refund.processed / refund.failed. */
      refund: PlatformRefundEntity | null
    }
  | { ok: false; reason: string }

/**
 * Parse and validate an ALREADY-VERIFIED raw body.
 *
 * The parameter is named `verifiedRawBody` so that reading a call site makes
 * the ordering obvious: nothing may call this before the signature check has
 * returned true.
 */
export function parseVerifiedPlatformWebhook(verifiedRawBody: string): ParsedPlatformWebhook {
  let json: unknown
  try {
    json = JSON.parse(verifiedRawBody)
  } catch {
    return { ok: false, reason: 'malformed JSON' }
  }

  const parsed = platformWebhookSchema.safeParse(json)
  if (!parsed.success) return { ok: false, reason: 'unexpected payload shape' }

  const payment = parsed.data.payload.payment?.entity ?? null
  return {
    ok: true,
    event: parsed.data.event,
    subscription: parsed.data.payload.subscription?.entity ?? null,
    // `subscription.charged` carries the payment alongside the subscription.
    paymentId: payment?.id ?? null,
    payment,
    refund: parsed.data.payload.refund?.entity ?? null,
  }
}

/**
 * The refund events this application acts on (AROS-114).
 *
 * A SECOND, deliberately separate family from HANDLED_EVENTS. They carry a
 * different entity, resolve to a different table and run a different state
 * machine; folding them into the subscription set would mean every subscription
 * code path had to start asking which kind of delivery it was holding.
 *
 * `refund.created` is NOT here. It fires when the instruction is accepted, not
 * when the money leaves, and our row is already 'pending' by then — acting on
 * it would move nothing and log noise. Only the two TERMINAL outcomes matter.
 */
export const REFUND_EVENTS = new Set(['refund.processed', 'refund.failed'])

/**
 * The most useful sentence the gateway gave us about a failed charge (AROS-113).
 *
 * Prefers the human description, falls back to the machine reason and then to
 * the code, and returns null when the payment succeeded or said nothing. Pure,
 * so it is trivially testable, and the ONLY place the three fields are ranked.
 */
function failureReasonFrom(payment: PlatformPaymentEntity | null): string | null {
  if (!payment) return null
  // A captured payment is not a failure, whatever else the entity carries.
  if (payment.status === 'captured') return null
  const candidate = payment.error_description ?? payment.error_reason ?? payment.error_code
  return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : null
}

// ── delivery-level idempotency ───────────────────────────────────────────────

type EventLogRow = {
  eventId: string | null
  eventType: string
  tenantId: string | null
  subscriptionId: string | null
  paymentId: string | null
  outcome: string
}

/**
 * Claim an event id BEFORE doing any work.
 *
 * The unique index on (gateway, event_id) from 0034 is what makes this a claim
 * rather than a check: two concurrent redeliveries of one event both try to
 * insert, exactly one succeeds, and the loser gets 23505 and stops. An
 * application-only `if (!exists)` would let both through.
 *
 * Returns false when the event has already been claimed.
 */
async function claimEvent(tx: DB, row: EventLogRow): Promise<boolean> {
  try {
    await tx.insert(webhookEvents).values({ gateway: WEBHOOK_GATEWAY, ...row })
    return true
  } catch (e) {
    if (pgError(e).code === '23505') return false
    throw e
  }
}

/** Correct the delivery-log row (and attribute its tenant) once the outcome is known. */
async function noteOutcome(
  tx: DB,
  eventId: string | null,
  outcome: string,
  tenantId?: string | null,
): Promise<void> {
  if (!eventId) return
  await tx
    .update(webhookEvents)
    .set({ outcome, ...(tenantId ? { tenantId } : {}) })
    .where(and(eq(webhookEvents.gateway, WEBHOOK_GATEWAY), eq(webhookEvents.eventId, eventId)))
}

// ── the entry point ──────────────────────────────────────────────────────────

export type PlatformWebhookOutcome =
  /** State was moved. `invoice` is set when this delivery also billed. */
  | { kind: 'processed'; detail: ApplyResult; invoice: BilledInvoice | null }
  /** Already applied — a retry, a redelivery, or a replay. A no-op. */
  | { kind: 'duplicate'; reason: string }
  /** Verified, but not something we act on. */
  | { kind: 'ignored'; reason: string }

/** What a delivery billed, when it billed anything. */
export type BilledInvoice = { id: string; invoiceNumber: string; total: string }

export type ApplyPlatformWebhookParams = {
  eventType: string
  /** Razorpay's per-delivery id, from the header. May be absent. */
  eventId: string | null
  subscription: PlatformSubscriptionEntity | null
  paymentId: string | null
  /** The payment entity, when the event carried one. Its amount is the invoice total. */
  payment?: PlatformPaymentEntity | null
}

/**
 * Apply a verified platform subscription webhook.
 *
 * Every state change happens inside ONE transaction, so a failure anywhere
 * leaves the database exactly as it was — there is no window in which the
 * subscription is active but the tenant is still suspended, or the reverse.
 *
 * Throws only on genuine infrastructure faults, which the route turns into a
 * 503 so Razorpay retries. Every business outcome — duplicate, unknown
 * subscription, unhandled event — is a RETURNED VALUE, because retrying those
 * would never help.
 */
export async function applyVerifiedPlatformWebhook(
  params: ApplyPlatformWebhookParams,
  db: DB = ownerDb,
): Promise<PlatformWebhookOutcome> {
  const { eventType, eventId, subscription, paymentId, payment } = params

  return db.transaction(async (tx) => {
    const logRow: EventLogRow = {
      eventId,
      eventType,
      // Filled in below once OUR OWN row has told us whose subscription it is.
      tenantId: null,
      subscriptionId: subscription?.id ?? null,
      paymentId,
      outcome: 'processed',
    }

    // ── 0. delivery-level idempotency, before any work ────────────────────
    if (eventId) {
      const claimed = await claimEvent(tx, logRow)
      if (!claimed) return { kind: 'duplicate', reason: 'event already delivered' }
    }

    // ── 1. is this an event we act on at all? ─────────────────────────────
    if (!HANDLED_EVENTS.has(eventType)) {
      await noteOutcome(tx, eventId, 'ignored')
      return { kind: 'ignored', reason: `event ${eventType} is not handled` }
    }
    if (!subscription) {
      // A handled event type with no subscription entity is a shape this build
      // does not understand. Acknowledged; retrying cannot fix it.
      await noteOutcome(tx, eventId, 'ignored')
      return { kind: 'ignored', reason: 'event carries no subscription entity' }
    }

    // ── 2. apply the state machine ────────────────────────────────────────
    const result = await applySubscriptionState(tx, {
      gatewaySubscriptionId: subscription.id,
      razorpayStatus: subscription.status,
      currentStart: subscription.current_start ?? null,
      currentEnd: subscription.current_end ?? null,
      paymentId,
      // Diagnostics from the VERIFIED payload. Only reaches a column; never a
      // branch. See the schema note above.
      failureReason: failureReasonFrom(payment ?? null),
    })

    if (result.kind === 'ignored') {
      await noteOutcome(tx, eventId, 'ignored')
      return { kind: 'ignored', reason: result.reason }
    }
    if (result.kind === 'unchanged') {
      await noteOutcome(tx, eventId, 'duplicate', result.tenantId)
      return { kind: 'duplicate', reason: result.reason }
    }

    // ── 3. bill it ────────────────────────────────────────────────────────
    //
    // ONLY `subscription.charged` raises an invoice, and only when it carries a
    // payment. That is the single event at which Razorpay has actually taken
    // money; `activated`, `resumed` and `updated` all describe the same
    // subscription without a new charge, and billing on any of them would
    // invoice a business twice for one renewal.
    //
    // Inside the SAME transaction as the state change above, so a renewal can
    // never end up with an extended period and no invoice, or the reverse.
    //
    // A duplicate is a returned null, not an exception: one payment can
    // legitimately arrive under several event ids, and the partial unique index
    // on (gateway, gateway_payment_id) is what refuses the second one.
    let invoice: BilledInvoice | null = null
    const charge = billableChargeFor(eventType, subscription, payment ?? null)
    if (charge) {
      invoice = await issueSubscriptionInvoice(tx, {
        tenantId: result.tenantId,
        subscriptionId: result.subscriptionId,
        planId: result.planId,
        billingPeriodType: result.billingPeriod,
        billingPeriodStart: result.periodStart,
        billingPeriodEnd: result.periodEnd,
        grossAmount: charge.grossRupees,
        currency: charge.currency,
        gatewayPaymentId: charge.paymentId,
        gatewaySubscriptionId: subscription.id,
        gatewayInvoiceId: charge.gatewayInvoiceId,
        gatewayEventId: eventId,
      })
    }

    // ── 4. tell the business, once (AROS-113) ─────────────────────────────
    //
    // The day-zero notice, raised at the moment the failure is known rather
    // than whenever the scheduled job next runs. It goes through the SAME
    // claim-then-send helper the job uses, so the two cannot double-send: the
    // unique index on (subscription_id, dunning_cycle, stage) is what decides,
    // and whichever path gets there first wins.
    //
    // Only on 'applied'. A duplicate or an unchanged redelivery has already
    // returned above, so a replayed `subscription.pending` never reaches here —
    // and even if it did, the index would refuse it.
    //
    // In the SAME transaction as the state change: an account cannot end up
    // marked past_due with no record that anyone was told, or the reverse.
    if (result.kind === 'applied' && result.pastDueSince) {
      const stage =
        result.to === 'past_due'
          ? 'payment_failed'
          : result.tenantStatus === 'suspended'
            ? // Razorpay halted the subscription itself — it exhausted its own
              // retries before our grace period ran out. Same outcome as the
              // job's suspension, same notice.
              'suspended'
            : null

      if (stage) {
        // Through deadlinesFor(), so the date this notice quotes is the one the
        // dunning processor will actually act on. `periodEnd` is passed only
        // while the subscription is still in past_due, because that is the one
        // state in which a paid period can push the suspension out past the
        // grace deadline — see ./dunning-policy.ts § accessEndsAt.
        const deadlines = deadlinesFor({
          pastDueSince: result.pastDueSince,
          suspendedAt: result.suspendedAt,
          paidThrough: result.to === 'past_due' ? result.periodEnd : null,
        })

        if (deadlines) {
          await sendDunningNotice(tx, {
            tenantId: result.tenantId,
            subscriptionId: result.subscriptionId,
            stage,
            dunningCycle: result.pastDueSince,
            graceEndsAt: deadlines.graceEndsAt,
            cancelsAt: deadlines.cancelsAt,
          })
        }
      }
    }

    await noteOutcome(tx, eventId, 'processed', result.tenantId)
    return { kind: 'processed', detail: result, invoice }
  })
}

/**
 * Apply a verified `refund.processed` / `refund.failed` delivery (AROS-114).
 *
 * ── The same three guarantees as the subscription path, obtained the same way ─
 *
 * DELIVERY IDEMPOTENCY. The event id is claimed on `webhook_events` before any
 * work, against the same unique (gateway, event_id) index — so a redelivery
 * short-circuits before it can touch a refund row.
 *
 * IDENTITY FROM OUR OWN RECORD. The refund is located by
 * `platform_refunds.gateway_refund_id`, a column WE wrote when we instructed
 * the gateway. A refund id we have never seen is ignored, never inserted:
 * creating a refund from a payload would let a delivery decide that money left
 * an account, which is exactly what "never trust the payload" forbids. The
 * tenant is then whatever our row says.
 *
 * TERMINAL IS TERMINAL. applyVerifiedRefundEvent() refuses to move a refund out
 * of `processed` or `failed`, so an out-of-order redelivery cannot flip a
 * settled refund back, in either direction.
 *
 * One transaction, like every other state change in this module.
 */
export async function applyVerifiedPlatformRefundWebhook(
  params: {
    eventType: string
    eventId: string | null
    refund: PlatformRefundEntity | null
    paymentId: string | null
  },
  db: DB = ownerDb,
): Promise<PlatformWebhookOutcome> {
  const { eventType, eventId, refund, paymentId } = params

  return db.transaction(async (tx) => {
    if (eventId) {
      const claimed = await claimEvent(tx, {
        eventId,
        eventType,
        tenantId: null,
        subscriptionId: null,
        paymentId,
        outcome: 'processed',
      })
      if (!claimed) return { kind: 'duplicate', reason: 'event already delivered' }
    }

    if (!REFUND_EVENTS.has(eventType)) {
      await noteOutcome(tx, eventId, 'ignored')
      return { kind: 'ignored', reason: `event ${eventType} is not handled` }
    }
    if (!refund) {
      await noteOutcome(tx, eventId, 'ignored')
      return { kind: 'ignored', reason: 'event carries no refund entity' }
    }

    // The EVENT NAME decides the outcome, not the entity's `status` field.
    // Razorpay names these events after what happened, and a `refund.processed`
    // carrying a stale or absent status must still mean processed. (The
    // subscription path maps from the entity instead, for the opposite reason
    // documented in ./lifecycle.ts: there, one status arrives under many event
    // names.)
    const status = eventType === 'refund.processed' ? 'processed' : 'failed'

    const result = await applyVerifiedRefundEvent(tx, {
      gatewayRefundId: refund.id,
      // The fallback match. A refund whose instruction timed out is recorded
      // locally with a NULL gateway_refund_id, so the reference above can never
      // find it; these let it be recognised by the payment it came from.
      gatewayPaymentId: refund.payment_id ?? paymentId,
      amountPaise: refund.amount ?? null,
      status,
    })

    if (result.kind === 'ignored') {
      await noteOutcome(tx, eventId, 'ignored')
      return { kind: 'ignored', reason: 'no local refund for this gateway reference' }
    }
    if (result.kind === 'unchanged') {
      await noteOutcome(tx, eventId, 'duplicate', result.tenantId)
      return { kind: 'duplicate', reason: 'refund is already settled' }
    }

    await noteOutcome(tx, eventId, 'processed', result.tenantId)
    return {
      kind: 'processed',
      // A refund moves no subscription, so there is no ApplyResult to report.
      // Said explicitly rather than faked, so a caller cannot read a
      // subscription transition out of a refund delivery.
      detail: { kind: 'ignored', reason: `refund ${status}` },
      invoice: null,
    }
  })
}

/** Re-exported so the route can name the one event that bills. */
export { CHARGE_EVENT }

/**
 * Log a verified-but-unhandled delivery without opening the state machine.
 *
 * Used by the route for events it can see are irrelevant before doing any work.
 * Recorded so an operator can see what arrived and so a redelivery is
 * recognised — it touches no subscription state whatsoever.
 */
export async function logIgnoredPlatformEvent(
  params: {
    eventType: string
    eventId: string | null
    subscriptionId: string | null
    paymentId: string | null
  },
  db: DB = ownerDb,
): Promise<void> {
  if (!params.eventId) return
  try {
    await db.insert(webhookEvents).values({
      gateway: WEBHOOK_GATEWAY,
      eventId: params.eventId,
      eventType: params.eventType,
      tenantId: null,
      subscriptionId: params.subscriptionId,
      paymentId: params.paymentId,
      outcome: 'ignored',
    })
  } catch (e) {
    // A duplicate here just means we have seen this event before — expected.
    if (pgError(e).code !== '23505') throw e
  }
}
