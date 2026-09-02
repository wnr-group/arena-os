import 'server-only'
import type { Msg91Config } from './config'

/**
 * Minimal MSG91 REST client — OTP delivery only.
 *
 * Written the same way as lib/payments/razorpay.ts: the project has no MSG91
 * SDK dependency and this needs exactly one endpoint, so it calls the API with
 * `fetch` rather than pulling in a package. Extend this module if a later
 * ticket needs MSG91's retry/voice endpoints; do not call the API elsewhere.
 *
 * ── What this module is NOT ─────────────────────────────────────────────────
 * It is not the verifier. MSG91 can generate and check codes itself, but then
 * the gateway — not us — would own the secret, and "was this code correct?"
 * would become an unauthenticated third-party HTTP call sitting on the login
 * path. Instead WE generate the code, store a keyed hash of it (see
 * lib/otp/challenge.ts), and hand MSG91 the finished code to deliver. Expiry,
 * attempt limits and single-use are then enforced in our own database, where
 * they are transactional.
 *
 * ── Security rules this module keeps ────────────────────────────────────────
 *   * Server-only. The auth key builds a request header and never leaves here.
 *   * Nothing here logs the auth key, the phone number, or the OTP. The auth
 *     key travels in a header (not the query string) so it cannot be captured
 *     by an intermediary's request logging; the code travels in the body for
 *     the same reason.
 *   * The error type carries a sanitised message and the HTTP status only, so
 *     `toString()` on it is safe to put in a log.
 */

const MSG91_OTP_URL = 'https://control.msg91.com/api/v5/otp'

/** How long to wait on the gateway before giving up. */
const REQUEST_TIMEOUT_MS = 10_000

/**
 * A delivery attempt that did not succeed.
 *
 * `status` is the HTTP status (0 for a network/timeout failure). `retriable`
 * separates "try again" (timeout, 5xx, 429) from "this request is wrong"
 * (bad template, rejected auth key), which is what decides whether the UI
 * offers a resend.
 */
export class Msg91ApiError extends Error {
  readonly status: number
  readonly retriable: boolean

  constructor(message: string, status: number, retriable: boolean) {
    super(message)
    this.name = 'Msg91ApiError'
    this.status = status
    this.retriable = retriable
  }
}

/**
 * The seam the OTP flow calls through, so tests can substitute a fake gateway
 * (a real HTTP call to MSG91 has no place in a test suite).
 */
export type SendSmsOtpFn = (
  config: Msg91Config,
  params: { phone: string; code: string },
) => Promise<void>

/**
 * MSG91 wants a bare international number — country code then subscriber,
 * digits only. Our phones are always E.164 ('+919876543210'), so this is a
 * single strip; it is a function rather than an inline `.slice(1)` so the
 * assumption is stated and testable.
 */
export function msg91Mobile(e164Phone: string): string {
  if (!/^\+[1-9][0-9]{7,14}$/.test(e164Phone)) {
    throw new Msg91ApiError('Cannot send to a phone number that is not in E.164 form.', 0, false)
  }
  return e164Phone.slice(1)
}

/** Deliver an already-generated code by SMS. Resolves on success, throws otherwise. */
export const sendMsg91Otp: SendSmsOtpFn = async (config, { phone, code }) => {
  const mobile = msg91Mobile(phone)

  const url = new URL(MSG91_OTP_URL)
  // Non-sensitive, and MSG91 reads expiry from the query string.
  url.searchParams.set('otp_expiry', String(config.otpExpiryMinutes))

  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        authkey: config.authKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        template_id: config.templateId,
        mobile,
        otp: code,
        ...(config.senderId ? { sender: config.senderId } : {}),
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      cache: 'no-store',
    })
  } catch {
    // Timeout, DNS or TLS failure. The SMS may or may not have gone out; the
    // caller must treat this as "unknown" and must not confirm delivery.
    throw new Msg91ApiError('Could not reach the SMS gateway.', 0, true)
  }

  // MSG91 answers 200 with {"type":"error"} for several real failures (bad
  // template id, blocked number), so the status alone is not enough.
  let body: { type?: unknown; message?: unknown } = {}
  try {
    body = (await response.json()) as typeof body
  } catch {
    /* non-JSON body; the status will have to do */
  }

  const gatewayMessage = typeof body.message === 'string' ? body.message : ''
  // Gateway-authored text: safe to surface in a log, but length-capped, and
  // never shown verbatim to the customer.
  const detail = gatewayMessage ? ` (${gatewayMessage.slice(0, 200)})` : ''

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      // Do not echo MSG91's auth text — it can quote part of the key.
      throw new Msg91ApiError('The SMS gateway rejected this deployment’s credentials.', response.status, false)
    }
    const retriable = response.status >= 500 || response.status === 429
    throw new Msg91ApiError(`The SMS gateway rejected the request${detail}.`, response.status, retriable)
  }

  if (body.type !== 'success') {
    throw new Msg91ApiError(`The SMS gateway did not accept the message${detail}.`, response.status, false)
  }
}
