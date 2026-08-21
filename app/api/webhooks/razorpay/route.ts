import { NextResponse, type NextRequest } from 'next/server'
import { DecryptionError } from '@/lib/security/encryption'
import { loadWebhookSecretBySlug } from '@/lib/settings/razorpay-webhook-secret'
import {
  EVENT_ID_HEADER,
  PROCESSED_EVENT,
  SIGNATURE_HEADER,
  parseVerifiedWebhook,
  verifyWebhookSignature,
} from '@/lib/payments/razorpay-webhook'
import { applyVerifiedPaymentWebhook, logIgnoredEvent } from '@/lib/payments/webhook'
import { tenantSlugFromHost } from '@/lib/tenant/subdomain'

/**
 * POST /api/webhooks/razorpay — the ONLY thing that may confirm a deposit.
 *
 * A browser reaching Razorpay's success callback proves nothing: it is
 * unauthenticated client input. This route is the authority, and it earns that
 * by verifying an HMAC that only the tenant's webhook secret could produce.
 *
 * ── How the tenant is identified ────────────────────────────────────────────
 * Each tenant registers its own webhook URL on its own Razorpay account:
 *
 *     https://{slug}.arenaos.app/api/webhooks/razorpay
 *
 * The host names a CANDIDATE tenant — a hint, not a claim of authority. What
 * actually authenticates the request is that the signature verifies under that
 * tenant's secret. A request to acme's URL signed with anyone else's secret is
 * rejected, and a correctly signed request whose order belongs to a different
 * tenant is rejected again inside applyVerifiedPaymentWebhook().
 *
 * Nothing in the payload is trusted for authorization. `notes.tenantId` and
 * `notes.bookingId`, which AROS-49 attaches, are attacker-controllable in
 * principle and are never read here; the tenant comes from the verified secret
 * and the booking from our own payment intent.
 *
 * ── Raw body ────────────────────────────────────────────────────────────────
 * `request.text()` is read FIRST and the HMAC is computed over exactly those
 * bytes. JSON.parse happens only after verification succeeds, and the parsed
 * object is never re-serialised for signing — re-serialising would sign
 * different bytes than Razorpay did.
 *
 * ── Status codes, and why ───────────────────────────────────────────────────
 * Razorpay retries on non-2xx. So:
 *   200  processed, duplicate, ignored, and content-rejected — all final
 *        answers. Retrying will never change them, and a retry storm on a
 *        malformed payload helps nobody.
 *   401  bad or missing signature. Not ours; never retry.
 *   503  a genuine internal fault (DB down, secret will not decrypt). We WANT
 *        Razorpay to retry these, because the payment is real and unrecorded.
 */

// Payments must never be served from a cache, and the crypto + pg driver both
// need Node rather than the edge runtime.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Uniform body so a caller cannot probe which slugs or orders exist. */
const ok = (status: string) => NextResponse.json({ status }, { status: 200 })

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

  // ── 2. candidate tenant from the host ─────────────────────────────────────
  // The proxy sets x-tenant-slug; fall back to the Host header so the route
  // works when called directly (and in tests).
  const slug =
    request.headers.get('x-tenant-slug') ?? tenantSlugFromHost(request.headers.get('host'))

  if (!slug) {
    // No tenant in the URL means no secret to verify against. Indistinguishable
    // from a bad signature, deliberately.
    return NextResponse.json({ status: 'unauthorized' }, { status: 401 })
  }

  let tenant: Awaited<ReturnType<typeof loadWebhookSecretBySlug>>
  try {
    tenant = await loadWebhookSecretBySlug(slug)
  } catch (e) {
    if (e instanceof DecryptionError) {
      // A secret IS configured but will not decrypt — a real fault, and the
      // payment is unrecorded. Ask Razorpay to come back.
      console.error(`[razorpay-webhook] webhook secret unusable for slug ${slug}`)
      return NextResponse.json({ status: 'retry' }, { status: 503 })
    }
    console.error('[razorpay-webhook] tenant lookup failed:', e instanceof Error ? e.name : 'unknown')
    return NextResponse.json({ status: 'retry' }, { status: 503 })
  }

  // Unknown slug, inactive tenant, or no webhook secret configured — all
  // answered identically, so the response cannot enumerate tenants.
  if (!tenant) {
    return NextResponse.json({ status: 'unauthorized' }, { status: 401 })
  }

  // ── 3. verify the signature over the raw bytes ────────────────────────────
  // NOTHING above this line has touched payment state, and nothing below acts
  // on the payload until this returns true.
  if (!verifyWebhookSignature(rawBody, signature, tenant.webhookSecret)) {
    console.warn(`[razorpay-webhook] signature verification failed for tenant ${tenant.tenantId}`)
    return NextResponse.json({ status: 'unauthorized' }, { status: 401 })
  }

  // ── 4. parse, only now ────────────────────────────────────────────────────
  const parsed = parseVerifiedWebhook(rawBody)
  if (!parsed.ok) {
    console.warn(
      `[razorpay-webhook] verified but unusable payload for tenant ${tenant.tenantId}: ${parsed.reason}`,
    )
    // Correctly signed but not a shape we understand. Retrying cannot fix it.
    return ok('ignored')
  }

  // ── 5. only the capture event moves money ─────────────────────────────────
  // payment.failed, payment.authorized, order.paid, refund.* and everything
  // else are acknowledged and logged, and touch no payment state.
  if (parsed.event !== PROCESSED_EVENT || !parsed.payment) {
    try {
      await logIgnoredEvent({
        verifiedTenantId: tenant.tenantId,
        eventType: parsed.event,
        eventId,
        orderId: parsed.payment?.order_id ?? null,
        paymentId: parsed.payment?.id ?? null,
      })
    } catch {
      // The delivery log is diagnostics; failing to write it must not turn an
      // ignored event into a retry storm.
    }
    return ok('ignored')
  }

  // ── 6. apply it ───────────────────────────────────────────────────────────
  try {
    const outcome = await applyVerifiedPaymentWebhook({
      verifiedTenantId: tenant.tenantId,
      eventType: parsed.event,
      eventId,
      payment: parsed.payment,
    })

    // Safe diagnostics only: an event type, our own ids, and Razorpay's public
    // order/payment references. No secret, no signature, no raw body.
    if (outcome.kind === 'rejected') {
      console.warn(
        `[razorpay-webhook] rejected ${parsed.event} for tenant ${tenant.tenantId}, order ${parsed.payment.order_id}: ${outcome.reason}`,
      )
    } else if (outcome.kind === 'processed') {
      console.info(
        `[razorpay-webhook] deposit captured for tenant ${tenant.tenantId}, intent ${outcome.intentId}`,
      )
    }

    return ok(outcome.kind)
  } catch (e) {
    // An infrastructure fault: the money is real and we have not recorded it.
    // 503 so Razorpay retries; the transaction has already rolled back, so the
    // retry starts from a clean state.
    console.error(
      `[razorpay-webhook] processing failed for tenant ${tenant.tenantId}:`,
      e instanceof Error ? e.name : 'unknown error',
    )
    return NextResponse.json({ status: 'retry' }, { status: 503 })
  }
}

/**
 * Razorpay only ever POSTs. A GET is a misconfigured URL or a prober; answer
 * plainly rather than letting Next return a confusing 405 page.
 */
export function GET(): NextResponse {
  return NextResponse.json({ status: 'method not allowed' }, { status: 405 })
}
