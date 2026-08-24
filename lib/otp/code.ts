import 'server-only'
import { createHmac, randomInt, timingSafeEqual } from 'node:crypto'

/**
 * OTP code generation and hashing — the cryptographic core of customer login.
 *
 * ── Why a KEYED hash, not a plain digest ────────────────────────────────────
 * A 6-digit OTP has 1,000,000 possible values. A bare SHA-256 of one is not a
 * one-way function in any useful sense: anybody who reads `code_hash` can
 * enumerate the whole space on a laptop in under a second and recover the
 * code. Storing sha256(code) would therefore be barely better than storing the
 * code itself.
 *
 * A password hash (argon2, which this project already uses for staff
 * passwords) does not fix it either — at ~50 ms per guess the whole space still
 * falls in a day, and every login would pay that 50 ms.
 *
 * So the stored value is an HMAC keyed by a server-side secret that never
 * touches the database. Without the key the hash is unattackable regardless of
 * how small the code space is; with the key you already have the server.
 *
 * ── Binding ─────────────────────────────────────────────────────────────────
 * The MAC covers the challenge id, tenant id and phone as well as the code, so
 * a `code_hash` lifted from one row cannot be replayed into another: a hash
 * copied onto a different challenge, a different tenant's row, or a different
 * phone number simply stops matching.
 */

/** Thrown when the hashing secret is missing or unusable — a deployment fault. */
export class OtpSecretError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OtpSecretError'
  }
}

const SECRET_ENV = 'SESSION_SECRET'

/**
 * Domain separator. SESSION_SECRET is the project's general server-side auth
 * secret; prefixing every OTP MAC with a constant label means an OTP hash can
 * never collide with, or be substituted for, anything else that key is ever
 * used to authenticate.
 */
const DOMAIN = 'arena-os/customer-otp/v1'

/** Codes are always exactly this many digits. */
export const OTP_CODE_LENGTH = 6

const OTP_CODE_PATTERN = /^[0-9]{6}$/

export function isValidOtpCodeFormat(code: string): boolean {
  return OTP_CODE_PATTERN.test(code)
}

/**
 * Resolve the HMAC key. Exported so a deployment check or a test can validate a
 * candidate without reaching into process.env. It never echoes the value.
 */
export function resolveOtpSecret(raw: string | undefined = process.env[SECRET_ENV]): Buffer {
  const value = raw?.trim()
  if (!value) {
    throw new OtpSecretError(
      `${SECRET_ENV} is not set. Generate one with \`openssl rand -hex 32\` and add it to the server environment.`,
    )
  }
  if (value.length < 32) {
    throw new OtpSecretError(
      `${SECRET_ENV} is too short to key an OTP hash — use at least 32 characters (\`openssl rand -hex 32\`).`,
    )
  }
  // The placeholder shipped in .env.example. Valid-looking, entirely public.
  if (value === 'change-me-to-a-long-random-string') {
    throw new OtpSecretError(
      `${SECRET_ENV} is still the .env.example placeholder. Generate a real one with \`openssl rand -hex 32\`.`,
    )
  }
  return Buffer.from(value, 'utf8')
}

let cachedSecret: Buffer | null = null

function secret(): Buffer {
  if (!cachedSecret) cachedSecret = resolveOtpSecret()
  return cachedSecret
}

/**
 * A fresh code from the CSPRNG.
 *
 * `randomInt` is rejection-sampled and therefore uniform over the range —
 * `randomBytes % 1000000` would not be, and a skewed distribution measurably
 * shrinks the space an attacker has to guess.
 */
export function generateOtpCode(): string {
  return String(randomInt(0, 10 ** OTP_CODE_LENGTH)).padStart(OTP_CODE_LENGTH, '0')
}

export type OtpHashInput = {
  challengeId: string
  tenantId: string
  phone: string
  code: string
}

/** The value stored in `customer_otp_challenges.code_hash`. Hex SHA-256 MAC. */
export function hashOtpCode({ challengeId, tenantId, phone, code }: OtpHashInput): string {
  return createHmac('sha256', secret())
    .update(`${DOMAIN}|${challengeId}|${tenantId}|${phone}|${code}`)
    .digest('hex')
}

/**
 * Constant-time comparison of a submitted code against a stored hash.
 *
 * The MAC is recomputed and compared with timingSafeEqual rather than `===`:
 * a byte-at-a-time string comparison leaks, through timing, how many leading
 * characters of the digest were right, which is the standard way a MAC check
 * is turned into a forgery oracle.
 */
export function otpCodeMatches(input: OtpHashInput, storedHash: string): boolean {
  const computed = Buffer.from(hashOtpCode(input), 'utf8')
  const stored = Buffer.from(storedHash, 'utf8')
  if (computed.length !== stored.length) return false
  return timingSafeEqual(computed, stored)
}
