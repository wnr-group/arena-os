import 'server-only'
import { eq, sql } from 'drizzle-orm'
import { ownerDb } from '@/db'
import { platformPaymentSettings } from '@/db/schema'
import { decryptSecret, encryptSecret, DecryptionError } from '@/lib/security/encryption'

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  SERVER ONLY. ARENA OS's OWN Razorpay credentials — the PLATFORM's       ║
 * ║  merchant account, used to charge BUSINESSES their subscription.         ║
 * ║  Nothing this module decrypts may ever reach a browser.                  ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The deliberate twin of lib/settings/razorpay-credentials.ts, and the two must
 * never be confused:
 *
 *   lib/settings/razorpay-credentials.ts   TENANT keys → a venue collects money
 *                                          from ITS customers (deposits, POS).
 *                                          Scoped by RLS to one tenant.
 *
 *   THIS FILE                              PLATFORM keys → Arena OS collects
 *                                          money from the VENUES. No tenant is
 *                                          involved; there is one row.
 *
 * Its own file, loudly named, for the same reason its twin is: `grep -r
 * platform/billing/credentials` enumerates every caller in the project, which
 * is an audit you can actually run. There is no shared helper between the two —
 * a "get me some Razorpay keys" abstraction is exactly how the wrong account
 * ends up charging the wrong party.
 *
 * ── Rules for every caller ──────────────────────────────────────────────────
 *   * Never return `keySecret` or `webhookSecret` from a server action, route
 *     handler or RSC. Use it, then let it fall out of scope.
 *   * Never log it, never put it in an error message, never serialise the
 *     object it lives in. Use getPlatformGatewayView() for anything UI-facing.
 *   * Reads run on the OWNER connection, because `arena_app` has no grant on
 *     platform_payment_settings at all (0071). Authorization is the CALLER's
 *     job — requirePlatformAdmin() for the admin surface; the webhook route has
 *     no session and authenticates by HMAC instead.
 */

/**
 * The AAD every platform secret is sealed with.
 *
 * A fixed string, NOT a uuid, and that is the point. Tenant secrets are sealed
 * with their tenant id (0022/0034), so a ciphertext lifted out of
 * payment_settings and pasted into platform_payment_settings fails
 * authentication rather than decrypting into the platform's account — and the
 * reverse fails too. The two key sets are cryptographically non-interchangeable
 * even though they share one master key.
 */
const PLATFORM_AAD = 'platform:razorpay'

/** Raised when the platform gateway has not been configured yet. */
export class PlatformGatewayNotConfiguredError extends Error {
  constructor(
    message = 'The Arena OS platform Razorpay account is not configured. A platform administrator must add the credentials before subscriptions can be taken.',
  ) {
    super(message)
    this.name = 'PlatformGatewayNotConfiguredError'
  }
}

/** SECRET. Server-side only — never serialise this. */
export type PlatformRazorpayCredentials = {
  /** Publishable. Identifies WHICH Razorpay account (rzp_test_… / rzp_live_…). */
  keyId: string
  /** SECRET. Used to build an Authorization header and then discarded. */
  keySecret: string
}

/** Exactly what the platform-admin UI is allowed to know. No ciphertext. */
export type PlatformGatewayView = {
  razorpayKeyId: string | null
  hasSecret: boolean
  hasWebhookSecret: boolean
}

/**
 * The UI-safe view. `hasSecret` is computed IN POSTGRES as a boolean, so the
 * ciphertext never leaves the database, let alone reaches a React tree.
 *
 * Does NOT enforce authorization — every caller is a platform-admin surface
 * that has already called requirePlatformAdmin(). It is safe by construction
 * anyway: there is no secret material in the return type.
 */
export async function getPlatformGatewayView(): Promise<PlatformGatewayView> {
  const [row] = await ownerDb
    .select({
      razorpayKeyId: platformPaymentSettings.razorpayKeyId,
      hasSecret: sql<boolean>`${platformPaymentSettings.razorpayKeySecretEncrypted} is not null`,
      hasWebhookSecret: sql<boolean>`${platformPaymentSettings.razorpayWebhookSecretEncrypted} is not null`,
    })
    .from(platformPaymentSettings)
    .where(eq(platformPaymentSettings.id, true))
    .limit(1)

  return row ?? { razorpayKeyId: null, hasSecret: false, hasWebhookSecret: false }
}

/**
 * The platform's API credentials, decrypted. Returns null when the account has
 * not been configured — a normal state on a fresh install, not an error.
 *
 * Throws DecryptionError when a secret IS stored but will not authenticate:
 * the master key changed, or the row was tampered with. That is a real fault
 * and must not be swallowed into "not configured".
 */
export async function getPlatformRazorpayCredentials(): Promise<PlatformRazorpayCredentials | null> {
  const [row] = await ownerDb
    .select({
      keyId: platformPaymentSettings.razorpayKeyId,
      ciphertext: platformPaymentSettings.razorpayKeySecretEncrypted,
    })
    .from(platformPaymentSettings)
    .where(eq(platformPaymentSettings.id, true))
    .limit(1)

  if (!row?.keyId || !row.ciphertext) return null

  try {
    return { keyId: row.keyId, keySecret: decryptSecret(row.ciphertext, PLATFORM_AAD) }
  } catch (e) {
    // The failure mode, never the ciphertext, the key, or any recovered bytes.
    console.error(
      '[platform-gateway] failed to decrypt the platform Razorpay key secret:',
      e instanceof Error ? e.name : 'unknown error',
    )
    if (e instanceof DecryptionError) throw e
    throw new DecryptionError('Could not decrypt the stored platform Razorpay credentials.')
  }
}

/** Same, but throws instead of returning null — for paths already committed to a charge. */
export async function requirePlatformRazorpayCredentials(): Promise<PlatformRazorpayCredentials> {
  const creds = await getPlatformRazorpayCredentials()
  if (!creds) throw new PlatformGatewayNotConfiguredError()
  return creds
}

/**
 * The platform's WEBHOOK signing secret, decrypted.
 *
 * Read by app/api/webhooks/platform-razorpay/route.ts, which has NO session —
 * Razorpay is the caller. Returns null when none is configured, which the route
 * must answer identically to a bad signature so the response cannot be used to
 * probe whether the platform gateway is set up.
 *
 * A DIFFERENT credential from the key secret above, with its own rotation, and
 * loaded separately so clearing one cannot silently affect the other.
 */
export async function getPlatformWebhookSecret(): Promise<string | null> {
  const [row] = await ownerDb
    .select({ ciphertext: platformPaymentSettings.razorpayWebhookSecretEncrypted })
    .from(platformPaymentSettings)
    .where(eq(platformPaymentSettings.id, true))
    .limit(1)

  if (!row?.ciphertext) return null

  try {
    return decryptSecret(row.ciphertext, PLATFORM_AAD)
  } catch (e) {
    console.error(
      '[platform-gateway] failed to decrypt the platform Razorpay webhook secret:',
      e instanceof Error ? e.name : 'unknown error',
    )
    if (e instanceof DecryptionError) throw e
    throw new DecryptionError('Could not decrypt the stored platform webhook secret.')
  }
}

/**
 * Create or update the single configuration row.
 *
 * Encryption happens HERE, on the server, immediately before the write —
 * plaintext exists only as a local for the length of this call and is never
 * logged, returned or persisted.
 *
 * BLANK MEANS "LEAVE THE STORED SECRET ALONE". The form never pre-fills a
 * secret, so an empty field is the normal state of an edit that only changes
 * the key id; reading it as "erase" would silently break subscription billing.
 * Clearing is a separate, explicit call below.
 *
 * Authorization is the caller's — lib/actions/platform-gateway.ts calls
 * requirePlatformAdmin() before every invocation, and `arena_app` has no grant
 * on the table regardless.
 */
export async function savePlatformGatewaySettings(input: {
  razorpayKeyId: string | null
  razorpayKeySecret: string | null
  razorpayWebhookSecret: string | null
}): Promise<void> {
  const encryptedKey = input.razorpayKeySecret
    ? encryptSecret(input.razorpayKeySecret, PLATFORM_AAD)
    : null
  const encryptedWebhook = input.razorpayWebhookSecret
    ? encryptSecret(input.razorpayWebhookSecret, PLATFORM_AAD)
    : null

  await ownerDb
    .insert(platformPaymentSettings)
    .values({
      id: true,
      razorpayKeyId: input.razorpayKeyId,
      razorpayKeySecretEncrypted: encryptedKey,
      razorpayWebhookSecretEncrypted: encryptedWebhook,
    })
    .onConflictDoUpdate({
      target: platformPaymentSettings.id,
      set: {
        razorpayKeyId: input.razorpayKeyId,
        // Each secret is in the update set ONLY when a new value was actually
        // typed, so saving one can never blank the other.
        ...(encryptedKey ? { razorpayKeySecretEncrypted: encryptedKey } : {}),
        ...(encryptedWebhook ? { razorpayWebhookSecretEncrypted: encryptedWebhook } : {}),
      },
    })
}

/** Remove the stored API key secret. Explicit, never a side effect of a blank field. */
export async function clearPlatformKeySecret(): Promise<void> {
  await ownerDb
    .update(platformPaymentSettings)
    .set({ razorpayKeySecretEncrypted: null })
    .where(eq(platformPaymentSettings.id, true))
}

/**
 * Remove the stored WEBHOOK secret.
 *
 * Separate from clearPlatformKeySecret() because the operational consequence is
 * different: without the webhook secret no subscription state change can be
 * CONFIRMED (every delivery is rejected as unsigned), while subscription
 * creation keeps working — a meaningfully different broken state, and one worth
 * being able to reach on purpose during a rotation.
 */
export async function clearPlatformWebhookSecret(): Promise<void> {
  await ownerDb
    .update(platformPaymentSettings)
    .set({ razorpayWebhookSecretEncrypted: null })
    .where(eq(platformPaymentSettings.id, true))
}
