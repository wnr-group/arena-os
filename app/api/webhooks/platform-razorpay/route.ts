import { NextResponse, type NextRequest } from 'next/server'
import { DecryptionError } from '@/lib/security/encryption'
import {
  EVENT_ID_HEADER,
  SIGNATURE_HEADER,
  verifyWebhookSignature,
} from '@/lib/payments/razorpay-webhook'
import { getPlatformWebhookSecret } from '@/lib/platform/billing/credentials'
import { HANDLED_EVENTS } from '@/lib/platform/billing/lifecycle'
import {
  applyVerifiedPlatformRefundWebhook,
  applyVerifiedPlatformWebhook,
  logIgnoredPlatformEvent,
  parseVerifiedPlatformWebhook,
  REFUND_EVENTS,
} from '@/lib/platform/billing/webhook'

/**
 * POST /api/webhooks/platform-razorpay
 *
 * The ONLY thing that may change a tenant's Arena OS subscription state.
 *
 * ── This is NOT /api/webhooks/razorpay ──────────────────────────────────────
 *
 * That route belongs to a TENANT's own Razorpay account and confirms booking
 * deposits paid by that venue's customers. It resolves which tenant signed a
 * delivery from the request subdomain, because every venue registers its own
 * webhook URL on its own account.
 *
 * THIS route belongs to ARENA OS's own Razorpay account, which charges the
 * BUSINESSES their subscription. There is exactly one such account, so:
 *   * there is no tenant in the URL and none is looked up from the host;
 *   * there is one signing secret, held in platform_payment_settings (0071);
 *   * the tenant is discovered AFTERWARDS, from our own
 *     tenant_subscriptions.gateway_subscription_id row.
 *
 * A tenant's webhook secret can never verify a delivery here, and this one can
 * never verify a delivery there. The two accounts cannot be made to cross.
 *
 * ── Raw body ────────────────────────────────────────────────────────────────
 * `request.text()` is read FIRST and the HMAC is computed over exactly those
 * bytes. JSON.parse happens only after verification succeeds, and the parsed
 * object is never re-serialised for signing — re-serialising would sign
 * different bytes than Razorpay did.
 *
 * ── A browser redirect is never the source of truth ─────────────────────────
 * Razorpay's hosted subscription page bounces the payer back to the app on
 * success. That return trip is unauthenticated client input and confirms
 * nothing. Only a signature that could only have been produced by the platform
 * webhook secret moves a subscription to `active`.
 *
 * ── Status codes, and why ───────────────────────────────────────────────────
 *   200  processed, duplicate and ignored — all FINAL answers. Retrying will
 *        never change them, and a retry storm on a payload we understand and
 *        deliberately do not act on helps nobody.
 *   401  bad, missing or unverifiable signature — including "the platform
 *        gateway is not configured", answered identically so the response
 *        cannot be used to probe whether it is.
 *   503  a genuine internal fault (DB down, secret will not decrypt). We WANT
 *        Razorpay to retry these, because the state change is real and
 *        unrecorded. The transaction has already rolled back, so the retry
 *        starts from a clean state.
 */

// Billing must never be served from a cache, and the crypto + pg driver both
// need Node rather than the edge runtime.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Uniform body, so a caller cannot probe which subscriptions exist. */
const ok = (status: string) => NextResponse.json({ status }, { status: 200 })
const unauthorized = () => NextResponse.json({ status: 'unauthorized' }, { status: 401 })
const retry = () => NextResponse.json({ status: 'retry' }, { status: 503 })

export async function POST(request: NextRequest): Promise<NextResponse> {
  // ── 1. the RAW body, before anything else ─────────────────────────────────
  let rawBody: string
  try {
    rawBody = await request.text()
  } catch {
    return NextResponse.json({ status: 'unreadable' }, { status: 400 })
  }

  const signature = request.headers.get(SIGNATURE_HEADER)
  const eventId = request.headers.get(EVENT_ID_HEADER)

  // ── 2. the PLATFORM signing secret ────────────────────────────────────────
  let secret: string | null
  try {
    secret = await getPlatformWebhookSecret()
  } catch (e) {
    if (e instanceof DecryptionError) {
      // A secret IS configured but will not decrypt — the master key changed or
      // the row was altered. A real fault, and the billing event is unrecorded.
      console.error('[platform-razorpay-webhook] platform webhook secret unusable')
      return retry()
    }
    console.error(
      '[platform-razorpay-webhook] could not load the platform webhook secret:',
      process.env.ARENA_DEBUG_WEBHOOK ? e : e instanceof Error ? e.name : 'unknown error',
    )
    return retry()
  }

  // Not configured yet. Answered exactly like a bad signature: an unconfigured
  // platform must not be distinguishable from a wrongly signed request.
  if (!secret) return unauthorized()

  // ── 3. verify over the raw bytes ──────────────────────────────────────────
  // NOTHING above this line has touched subscription state, and nothing below
  // acts on the payload until this returns true.
  if (!verifyWebhookSignature(rawBody, signature, secret)) {
    console.warn('[platform-razorpay-webhook] signature verification failed')
    return unauthorized()
  }

  // ── 4. parse, only now ────────────────────────────────────────────────────
  const parsed = parseVerifiedPlatformWebhook(rawBody)
  if (!parsed.ok) {
    console.warn(`[platform-razorpay-webhook] verified but unusable payload: ${parsed.reason}`)
    // Correctly signed but not a shape we understand. Retrying cannot fix it.
    return ok('ignored')
  }

  // ── 5a. refunds (AROS-114) ────────────────────────────────────────────────
  //
  // A SECOND family, handled before the subscription branch because it carries
  // a different entity and drives a different state machine. It moves no
  // subscription and raises no invoice — it only settles a refund WE created
  // and already recorded, matched on our own stored `rfnd_…` reference.
  //
  // This is the gateway confirmation the whole refund path defers to: the
  // browser round-trip that instructed the refund never marks money as having
  // left, exactly as it never activates a subscription.
  if (REFUND_EVENTS.has(parsed.event)) {
    try {
      const outcome = await applyVerifiedPlatformRefundWebhook({
        eventType: parsed.event,
        eventId,
        refund: parsed.refund,
        paymentId: parsed.paymentId,
      })
      if (outcome.kind === 'ignored') {
        console.warn(`[platform-razorpay-webhook] ignored ${parsed.event}: ${outcome.reason}`)
      } else if (outcome.kind === 'processed') {
        // Our own refund reference only. No amount, no customer, no secret.
        console.info(`[platform-razorpay-webhook] ${parsed.event}: refund ${parsed.refund?.id}`)
      }
      return ok(outcome.kind)
    } catch (e) {
      console.error(
        '[platform-razorpay-webhook] refund processing failed:',
        process.env.ARENA_DEBUG_WEBHOOK ? e : e instanceof Error ? e.name : 'unknown error',
      )
      return retry()
    }
  }

  // ── 5b. events we do not act on ───────────────────────────────────────────
  // The platform account also emits payment.*, invoice.* and order.* events for
  // the same money. Acting on more than one view of a single charge is how a
  // state machine gets driven twice, so exactly one family — subscription.* —
  // is authoritative for the lifecycle. The rest are logged and dropped.
  if (!HANDLED_EVENTS.has(parsed.event) || !parsed.subscription) {
    try {
      await logIgnoredPlatformEvent({
        eventType: parsed.event,
        eventId,
        subscriptionId: parsed.subscription?.id ?? null,
        paymentId: parsed.paymentId,
      })
    } catch {
      // The delivery log is diagnostics; failing to write it must not turn an
      // ignored event into a retry storm.
    }
    return ok('ignored')
  }

  // ── 6. apply it ───────────────────────────────────────────────────────────
  try {
    const outcome = await applyVerifiedPlatformWebhook({
      eventType: parsed.event,
      eventId,
      subscription: parsed.subscription,
      paymentId: parsed.paymentId,
      // Carried through so that a `subscription.charged` can be invoiced in the
      // SAME transaction as the state change (M16 #4). The amount on this
      // entity is what the invoice totals — never the catalogue price.
      payment: parsed.payment,
    })

    // Safe diagnostics only: an event type, our own ids, and Razorpay's public
    // subscription reference. No secret, no signature, no raw body.
    if (outcome.kind === 'processed' && outcome.detail.kind === 'applied') {
      console.info(
        `[platform-razorpay-webhook] ${parsed.event}: subscription ${outcome.detail.subscriptionId} ` +
          `${outcome.detail.from} → ${outcome.detail.to}` +
          (outcome.detail.tenantStatus
            ? `, tenant ${outcome.detail.tenantId} → ${outcome.detail.tenantStatus}`
            : '') +
          // Our own invoice number and total. No customer data, no secret.
          (outcome.invoice
            ? `, invoiced ${outcome.invoice.invoiceNumber} for ${outcome.invoice.total}`
            : ''),
      )
    } else if (outcome.kind === 'ignored') {
      console.warn(`[platform-razorpay-webhook] ignored ${parsed.event}: ${outcome.reason}`)
    }

    return ok(outcome.kind)
  } catch (e) {
    // An infrastructure fault: the billing event is real and we have not
    // recorded it. 503 so Razorpay retries.
    console.error(
      '[platform-razorpay-webhook] processing failed:',
      // The name only. A driver error's MESSAGE can quote the statement's
      // parameters, which on this path would include billing figures.
      // ARENA_DEBUG_WEBHOOK is a local-development escape hatch and is never
      // set in production.
      process.env.ARENA_DEBUG_WEBHOOK ? e : e instanceof Error ? e.name : 'unknown error',
    )
    return retry()
  }
}

/**
 * Razorpay only ever POSTs. A GET is a misconfigured URL or a prober; answer
 * plainly rather than letting Next return a confusing 405 page.
 */
export function GET(): NextResponse {
  return NextResponse.json({ status: 'method not allowed' }, { status: 405 })
}
