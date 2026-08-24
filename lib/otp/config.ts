import 'server-only'

/**
 * The ONE place that decides whether customer OTP runs against MSG91 or the
 * development bypass, and the one place that reads any OTP environment
 * variable.
 *
 * Nothing else in the codebase may test `process.env.OTP_DEV_BYPASS`. Scattered
 * checks are how a bypass survives into production: each site is individually
 * plausible, and no single one is responsible for refusing. Here there is
 * exactly one decision, made once per process, that cannot be reached around.
 *
 * ── The production guarantee ────────────────────────────────────────────────
 * Enabling the bypass in production is a hard failure, not a warning. The check
 * runs at module load, so a misconfigured deployment dies the first time
 * anything touches the OTP flow — during `next build`, in fact, since the
 * server actions that import this are compiled then. There is deliberately no
 * "fall back to the real provider and carry on": silently ignoring the flag
 * would leave an operator believing a demo login works when it does not, and
 * the same tolerant code path is what lets the opposite mistake through.
 */

/** A deployment fault: the environment is configured in a way we refuse to run. */
export class OtpConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OtpConfigError'
  }
}

const BYPASS_ENV = 'OTP_DEV_BYPASS'

/** The only code the bypass provider ever issues or accepts. */
export const BYPASS_OTP_CODE = '123456'

export type OtpMode = 'msg91' | 'bypass'

export type Msg91Config = {
  authKey: string
  templateId: string
  /** MSG91 sender/DLT header, e.g. 'ARENA'. Optional — templates may fix it. */
  senderId: string | null
  /** OTP validity communicated to MSG91, in minutes. */
  otpExpiryMinutes: number
}

/**
 * `true` for '1' / 'true' / 'yes' / 'on' (any case). Everything else — unset,
 * empty, 'false', or a typo like 'ture' — is false. An unrecognised value is
 * NOT an error: for a security flag, "anything I don't understand means off"
 * is the only safe reading.
 */
function envFlag(raw: string | undefined): boolean {
  const v = raw?.trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes' || v === 'on'
}

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production'
}

/**
 * Resolve the OTP mode from an environment.
 *
 * Exported (and parameterised) so a test can exercise the production refusal
 * without mutating the real process environment.
 *
 * ── Two production paths, on purpose ────────────────────────────────────────
 * `next build` runs with NODE_ENV=production, so a developer who has the
 * bypass in their .env.local would otherwise be unable to build at all — a
 * false alarm about an environment that is never deployed. But simply ignoring
 * the build would be worse than useless: anything Next prerenders during it
 * could bake "dev mode, use 123456" into a real bundle.
 *
 * So the build phase FORCES the real provider (the escape the ticket allows)
 * while every other production context REFUSES TO START. Nothing bypassy can
 * be compiled in, and no production server can run with it, but a local
 * `npm run build` still works. NEXT_PHASE is set by Next only for the duration
 * of the build command, so this cannot leak into a running server.
 */
export function resolveOtpMode(env: NodeJS.ProcessEnv = process.env): OtpMode {
  const wantsBypass = envFlag(env[BYPASS_ENV])
  if (!wantsBypass) return 'msg91'

  if (env.NODE_ENV === 'production') {
    if (env.NEXT_PHASE === 'phase-production-build') return 'msg91'

    throw new OtpConfigError(
      `${BYPASS_ENV} is enabled but NODE_ENV=production. The customer OTP development ` +
        `bypass accepts a fixed code and sends no SMS; it must never run in production. ` +
        `Unset ${BYPASS_ENV} (or set it to 'false') and configure MSG91 instead.`,
    )
  }

  return 'bypass'
}

/**
 * MSG91 credentials, or a configuration error naming what is missing.
 *
 * Read lazily rather than at module load: a developer running with the bypass
 * on has no MSG91 account, and demanding credentials they will never use would
 * make the bypass useless.
 */
export function resolveMsg91Config(env: NodeJS.ProcessEnv = process.env): Msg91Config {
  const authKey = env.MSG91_AUTH_KEY?.trim()
  const templateId = env.MSG91_TEMPLATE_ID?.trim()

  const missing: string[] = []
  if (!authKey) missing.push('MSG91_AUTH_KEY')
  if (!templateId) missing.push('MSG91_TEMPLATE_ID')
  if (missing.length > 0) {
    throw new OtpConfigError(
      `Customer OTP is not configured: ${missing.join(' and ')} ${
        missing.length === 1 ? 'is' : 'are'
      } not set. ` +
        `Set them in the server environment, or set ${BYPASS_ENV}=true for local development.`,
    )
  }

  const rawExpiry = env.MSG91_OTP_EXPIRY_MINUTES?.trim()
  const parsedExpiry = rawExpiry ? Number(rawExpiry) : NaN
  const otpExpiryMinutes =
    Number.isInteger(parsedExpiry) && parsedExpiry > 0 && parsedExpiry <= 1440 ? parsedExpiry : 5

  return {
    authKey: authKey!,
    templateId: templateId!,
    senderId: env.MSG91_SENDER_ID?.trim() || null,
    otpExpiryMinutes,
  }
}

// ── resolved once per process ────────────────────────────────────────────────
// Module-level, so the production refusal above happens at import time.
const MODE: OtpMode = resolveOtpMode()

if (MODE === 'bypass' && !isProduction()) {
  // Deliberately unmissable, and deliberately only in the bypass branch — a
  // real MSG91 flow logs nothing about codes at all.
  console.warn(
    [
      '',
      '████████████████████████████████████████████████████████████████',
      '  WARNING: CUSTOMER OTP DEV BYPASS IS ENABLED.',
      `  No SMS is sent. OTP ${BYPASS_OTP_CODE} is accepted for every phone number.`,
      '  THIS MUST NEVER BE ENABLED IN PRODUCTION.',
      `  (${BYPASS_ENV}=true — the app refuses to start with NODE_ENV=production.)`,
      '████████████████████████████████████████████████████████████████',
      '',
    ].join('\n'),
  )
}

/** The mode this process runs in. Fixed at startup; never re-read per request. */
export function otpMode(): OtpMode {
  return MODE
}

export function isOtpBypassActive(): boolean {
  return MODE === 'bypass'
}
