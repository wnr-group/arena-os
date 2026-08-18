import 'server-only'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'

/**
 * Razorpay webhook authentication and payload parsing.
 *
 * Deliberately free of database access, so the crypto can be tested in
 * isolation against Razorpay's documented signing scheme. The processing side
 * lives in ./webhook.ts.
 *
 * ── Razorpay's signing scheme ───────────────────────────────────────────────
 *   X-Razorpay-Signature: hex( HMAC-SHA256( webhook_secret, RAW_REQUEST_BODY ) )
 *
 * The signature covers the exact bytes Razorpay sent. It must therefore be
 * checked against `await request.text()` and never against a re-serialised
 * object: JSON.stringify(JSON.parse(body)) reorders nothing in V8 today but
 * changes whitespace, number formatting (1.0 → 1) and unicode escaping, any of
 * which silently breaks verification — or, worse, would verify a body that is
 * not the one we then act on.
 */

/** The header Razorpay signs with. */
export const SIGNATURE_HEADER = 'x-razorpay-signature'
/** Razorpay's per-delivery id, used as the delivery-level idempotency key. */
export const EVENT_ID_HEADER = 'x-razorpay-event-id'

/**
 * The only event this ticket acts on.
 *
 * `payment.captured` is the point at which Razorpay has the money. `authorized`
 * is a hold, not a capture; `order.paid` is a duplicate view of the same money
 * under a different event id; `payment.failed` and refund events must never
 * mark anything paid. Everything outside this set is acknowledged and ignored.
 */
export const PROCESSED_EVENT = 'payment.captured'

/**
 * Verify a Razorpay webhook signature over the raw body.
 *
 * Timing-safe: the digests are compared with `timingSafeEqual` on equal-length
 * buffers, never with `===`. A length mismatch is answered false before the
 * comparison rather than by an early-exit inside it.
 *
 * Returns a boolean rather than throwing, because "not signed by this tenant"
 * is an expected outcome the route answers with 401, not an exception.
 */
export function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
  webhookSecret: string,
): boolean {
  if (!signatureHeader || !webhookSecret) return false

  // Razorpay sends lowercase hex. Anything else cannot be a valid signature,
  // and rejecting it here keeps Buffer.from from silently truncating garbage.
  const provided = signatureHeader.trim()
  if (!/^[0-9a-f]{64}$/i.test(provided)) return false

  const expected = createHmac('sha256', webhookSecret).update(rawBody, 'utf8').digest()
  const supplied = Buffer.from(provided, 'hex')

  // Equal by construction given the regex above, but asserted rather than
  // assumed: timingSafeEqual throws on a length mismatch.
  if (supplied.length !== expected.length) return false

  return timingSafeEqual(supplied, expected)
}

/**
 * The slice of Razorpay's `payment.captured` payload this ticket relies on.
 *
 * Strict about the fields that carry money and identity, tolerant about the
 * rest — Razorpay adds fields over time and a new one must not break payment
 * processing. `.passthrough()` is deliberate for that reason.
 */
const paymentEntitySchema = z
  .object({
    id: z.string().min(1),
    order_id: z.string().min(1).nullable(),
    // Razorpay sends the smallest currency unit as an integer. A float here
    // would mean the payload is not what we think it is.
    amount: z.number().int().nonnegative(),
    currency: z.string().min(3).max(3),
    status: z.string().min(1),
  })
  .passthrough()

export const razorpayWebhookSchema = z
  .object({
    event: z.string().min(1),
    payload: z
      .object({
        payment: z
          .object({ entity: paymentEntitySchema })
          .passthrough()
          .optional(),
      })
      .passthrough(),
  })
  .passthrough()

export type RazorpayWebhookBody = z.infer<typeof razorpayWebhookSchema>
export type RazorpayPaymentEntity = z.infer<typeof paymentEntitySchema>

export type ParsedWebhook =
  | { ok: true; event: string; payment: RazorpayPaymentEntity | null }
  | { ok: false; reason: string }

/**
 * Parse and validate an ALREADY-VERIFIED raw body.
 *
 * Callers must not invoke this before verifyWebhookSignature() has returned
 * true — the parameter is named `verifiedRawBody` so that reading the call site
 * makes the ordering obvious.
 */
export function parseVerifiedWebhook(verifiedRawBody: string): ParsedWebhook {
  let json: unknown
  try {
    json = JSON.parse(verifiedRawBody)
  } catch {
    return { ok: false, reason: 'malformed JSON' }
  }

  const parsed = razorpayWebhookSchema.safeParse(json)
  if (!parsed.success) return { ok: false, reason: 'unexpected payload shape' }

  const entity = parsed.data.payload.payment?.entity ?? null
  return { ok: true, event: parsed.data.event, payment: entity }
}
