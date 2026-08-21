import 'server-only'
import type { RazorpayCredentials } from '@/lib/settings/razorpay-credentials'

/**
 * Minimal Razorpay REST client — order creation only.
 *
 * The project has no Razorpay SDK dependency and this ticket needs exactly one
 * endpoint, so this calls the API directly with `fetch` rather than pulling in
 * a package. If AROS-50 or later work needs refunds, payment fetches or
 * settlements, extend this module rather than calling the API from elsewhere.
 *
 * ── Security rules this module keeps ────────────────────────────────────────
 *   * Server-only. The key secret is used to build an Authorization header and
 *     never leaves this function.
 *   * Nothing here logs a credential. The error type carries a sanitised
 *     message and the HTTP status; it never carries the request headers, and
 *     `toString()` on it can be put in a log safely.
 *   * The caller passes an amount in PAISE that it computed from trusted data.
 *     This module does no money arithmetic at all, so it cannot introduce a
 *     rounding bug or be talked into a different amount.
 */

const RAZORPAY_ORDERS_URL = 'https://api.razorpay.com/v1/orders'

/** Razorpay caps `receipt` at 40 characters. */
export const MAX_RECEIPT_LENGTH = 40

/** Razorpay allows at most 15 notes keys, each a string. */
const MAX_NOTES_KEYS = 15

/** How long to wait on the gateway before giving up. */
const REQUEST_TIMEOUT_MS = 15_000

/**
 * A gateway call that did not succeed.
 *
 * `status` is the HTTP status (0 for a network/timeout failure). `retriable`
 * distinguishes "try again" (timeout, 5xx, 429) from "this request is wrong"
 * (4xx), which is what decides whether the UI offers a retry.
 */
export class RazorpayApiError extends Error {
  readonly status: number
  readonly retriable: boolean

  constructor(message: string, status: number, retriable: boolean) {
    super(message)
    this.name = 'RazorpayApiError'
    this.status = status
    this.retriable = retriable
  }
}

export type CreateOrderParams = {
  /** Smallest currency unit — paise for INR. Must be a positive integer. */
  amountPaise: number
  /** ISO 4217, uppercase. */
  currency: string
  /** Reconciliation reference. No PII — a booking number is ideal. */
  receipt: string
  /** Non-secret key/value pairs echoed back on the webhook. */
  notes?: Record<string, string>
}

export type RazorpayOrder = {
  id: string
  amount: number
  currency: string
  status: string
  receipt: string | null
}

/**
 * The seam the deposit flow calls through, so tests can substitute a fake
 * gateway (a real HTTP call to Razorpay has no place in a test suite).
 */
export type CreateOrderFn = (
  credentials: RazorpayCredentials,
  params: CreateOrderParams,
) => Promise<RazorpayOrder>

/**
 * Create a Razorpay order.
 *
 * The amount is validated as a positive safe integer here as well as by the
 * caller: this is the last point before the money figure leaves the system, and
 * a NaN or a float reaching the gateway would either fail obscurely or — worse
 * — be coerced into the wrong charge.
 */
export const createRazorpayOrder: CreateOrderFn = async (credentials, params) => {
  const { amountPaise, currency, receipt, notes } = params

  if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0) {
    throw new RazorpayApiError('Order amount must be a positive whole number of paise.', 0, false)
  }
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new RazorpayApiError('Order currency must be a 3-letter ISO code.', 0, false)
  }
  if (!receipt || receipt.length > MAX_RECEIPT_LENGTH) {
    throw new RazorpayApiError(`Order receipt must be 1–${MAX_RECEIPT_LENGTH} characters.`, 0, false)
  }
  if (notes && Object.keys(notes).length > MAX_NOTES_KEYS) {
    throw new RazorpayApiError(`Order notes may hold at most ${MAX_NOTES_KEYS} keys.`, 0, false)
  }

  // HTTP Basic: key id as username, key secret as password. Built inline and
  // never stored, logged, or returned.
  const auth = Buffer.from(`${credentials.keyId}:${credentials.keySecret}`, 'utf8').toString(
    'base64',
  )

  let response: Response
  try {
    response = await fetch(RAZORPAY_ORDERS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        amount: amountPaise,
        currency,
        receipt,
        ...(notes ? { notes } : {}),
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      cache: 'no-store',
    })
  } catch {
    // A timeout or a DNS/TLS failure. The order may or may not have been
    // created at Razorpay's end — the caller must treat this as "unknown", and
    // it never means "paid".
    throw new RazorpayApiError('Could not reach the payment gateway.', 0, true)
  }

  if (!response.ok) {
    // Razorpay returns { error: { code, description, … } }. The description is
    // Razorpay's own text about the REQUEST (bad amount, auth failure) and
    // never contains our credentials, but it is still gateway-authored, so it
    // is length-capped before going anywhere near a log or a UI.
    let description = ''
    try {
      const body = (await response.json()) as { error?: { description?: unknown } }
      if (typeof body?.error?.description === 'string') description = body.error.description
    } catch {
      /* non-JSON error body; the status alone will have to do */
    }

    const retriable = response.status >= 500 || response.status === 429
    const detail = description ? ` (${description.slice(0, 200)})` : ''

    if (response.status === 401 || response.status === 403) {
      // Do not echo Razorpay's auth text — it can name the key id.
      throw new RazorpayApiError(
        'The payment gateway rejected this venue’s credentials.',
        response.status,
        false,
      )
    }
    throw new RazorpayApiError(
      `The payment gateway rejected the order${detail}.`,
      response.status,
      retriable,
    )
  }

  const order = (await response.json()) as Partial<RazorpayOrder>

  // Trust nothing about the shape. An order without an id is unusable, and
  // persisting a blank order id would leave AROS-50 unable to reconcile.
  if (typeof order.id !== 'string' || order.id.length === 0) {
    throw new RazorpayApiError('The payment gateway returned an unusable order.', 200, true)
  }
  // If the gateway ever echoed a different amount than we asked for, charging
  // it would be a silent money bug. Refuse instead.
  if (order.amount !== amountPaise || order.currency !== currency) {
    throw new RazorpayApiError(
      'The payment gateway returned an order for a different amount.',
      200,
      false,
    )
  }

  return {
    id: order.id,
    amount: order.amount,
    currency: order.currency,
    status: typeof order.status === 'string' ? order.status : 'created',
    receipt: typeof order.receipt === 'string' ? order.receipt : null,
  }
}
