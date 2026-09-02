import 'server-only'
import { BYPASS_OTP_CODE, otpMode, resolveMsg91Config, type OtpMode } from './config'
import { sendMsg91Otp, type SendSmsOtpFn } from './msg91'
import { generateOtpCode, otpCodeMatches, type OtpHashInput } from './code'

/**
 * The seam between the login flow and however codes actually reach a phone.
 *
 * Everything above this file — the server actions, the challenge table, the
 * session — is written against `OtpProvider` and has no idea MSG91 exists. That
 * is what lets the development bypass be a *provider swap* rather than a
 * scattering of `if (bypass)` branches through the auth path, and what would
 * let a second gateway be added without touching the flow.
 *
 * ── The three methods, and why it is three ──────────────────────────────────
 * `issueCode` and `sendOtp` are separate because the flow must persist the
 * hashed code BEFORE the SMS goes out. Merged into one "send" call, a delivery
 * that succeeded while the database write failed would put a live code in
 * somebody's hand with nothing on our side to verify it against.
 *
 * `verifyOtp` exists on the provider — even though both implementations today
 * check the same keyed hash — because "who is the authority on whether this
 * code is right?" is a per-provider question. A future provider that delegates
 * to a gateway's own verify endpoint slots in here without the flow changing.
 * The bypass additionally refuses anything but its fixed code, so it cannot be
 * talked into accepting a random one even if a hash somehow matched.
 */
export interface OtpProvider {
  readonly name: OtpMode

  /** The code this provider will consider valid for one challenge. */
  issueCode(): string

  /**
   * Deliver an already-issued code. Resolves on success; throws on failure so
   * the caller can void the challenge it just wrote.
   */
  sendOtp(phone: string, code: string): Promise<void>

  /** Constant-time check of a submitted code against a stored challenge hash. */
  verifyOtp(input: OtpHashInput, storedHash: string): Promise<boolean>
}

/**
 * The real provider. Generates the code itself and uses MSG91 purely for
 * delivery, so expiry, attempt limits and single-use stay enforceable in our
 * own transaction rather than over an HTTP call (see lib/otp/msg91.ts).
 *
 * `send` is injectable for tests — the same pattern lib/payments/razorpay.ts
 * uses for `CreateOrderFn`. A test substitutes a fake and asserts on what was
 * handed to the gateway; no test ever reaches the network.
 */
export class Msg91Provider implements OtpProvider {
  readonly name = 'msg91' as const

  constructor(private readonly send: SendSmsOtpFn = sendMsg91Otp) {}

  issueCode(): string {
    return generateOtpCode()
  }

  async sendOtp(phone: string, code: string): Promise<void> {
    // Credentials are resolved per send, not cached at construction, so a
    // missing MSG91_AUTH_KEY surfaces as a clear configuration error on the
    // request that needed it rather than at import time — where it would break
    // an otherwise healthy app that has not enabled customer login yet.
    await this.send(resolveMsg91Config(), { phone, code })
  }

  async verifyOtp(input: OtpHashInput, storedHash: string): Promise<boolean> {
    return otpCodeMatches(input, storedHash)
  }
}

/**
 * The development / demo provider.
 *
 * Sends nothing, issues one fixed code, and accepts only that code. Everything
 * else about the flow is unchanged: a challenge row is still written, still
 * expires, still counts attempts, still rate-limits, and is still single-use.
 * That is the point — a bypass that skipped those would let the whole login
 * path go untested until it reached production.
 */
export class BypassProvider implements OtpProvider {
  readonly name = 'bypass' as const

  issueCode(): string {
    return BYPASS_OTP_CODE
  }

  async sendOtp(): Promise<void> {
    // Deliberately empty. No SMS, no network call, and no log line either —
    // the startup banner in lib/otp/config.ts already tells the developer what
    // the code is, so printing it per request would only train the habit of
    // reading OTPs out of logs.
  }

  async verifyOtp(input: OtpHashInput, storedHash: string): Promise<boolean> {
    // Two independent conditions, both required. The hash check is the real
    // one; the literal check means that even a corrupted or attacker-supplied
    // hash cannot make this provider accept a code other than its fixed one.
    if (input.code !== BYPASS_OTP_CODE) return false
    return otpCodeMatches(input, storedHash)
  }
}

let cached: OtpProvider | null = null

/**
 * The provider for this process.
 *
 * Selection happens HERE and nowhere else. `otpMode()` has already refused to
 * return 'bypass' under NODE_ENV=production, so there is no path from a
 * production deployment to `BypassProvider`.
 */
export function getOtpProvider(): OtpProvider {
  if (!cached) {
    cached = otpMode() === 'bypass' ? new BypassProvider() : new Msg91Provider()
  }
  return cached
}
