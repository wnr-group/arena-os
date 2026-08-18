import 'server-only'
import { sql } from 'drizzle-orm'
import { withUser } from '@/db'
import { decryptSecret, DecryptionError } from '@/lib/security/encryption'
import type { ActiveContext } from '@/lib/tenant/context'

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  SERVER ONLY. The value this module returns must never reach a browser.  ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The one place in the codebase where a tenant's Razorpay key secret exists in
 * plaintext. It is deliberately its OWN file rather than a function tucked into
 * lib/settings/payment-settings.ts, so that `grep -r razorpay-credentials`
 * enumerates every caller in the project — an audit you can actually run.
 *
 * Intended consumers, both server-side:
 *   * AROS-49 — creating a Razorpay order for a booking deposit.
 *   * AROS-50 — verifying the signature on a Razorpay webhook.
 *
 * Rules for every caller:
 *   * Never return `keySecret` from a server action, route handler, or React
 *     Server Component. Use it, then let it fall out of scope.
 *   * Never log it, never put it in an error message, never serialise the
 *     object it lives in.
 *   * `keyId` alone is publishable — see getRazorpayKeyId() in
 *     lib/settings/payment-settings.ts for the browser-facing path.
 */

export type RazorpayCredentials = {
  /** Publishable. Safe to hand to Razorpay Checkout in the browser. */
  keyId: string
  /** SECRET. Server-side use only — never serialise this. */
  keySecret: string
}

/** Raised when a tenant has not finished configuring its gateway. */
export class PaymentNotConfiguredError extends Error {
  constructor(message = 'This venue has not configured its Razorpay credentials yet.') {
    super(message)
    this.name = 'PaymentNotConfiguredError'
  }
}

/**
 * The tenant's Razorpay credentials, decrypted.
 *
 * Tenant comes from the authenticated context — never from an argument, a
 * request body, or a query parameter, so there is no shape of call that reads
 * another tenant's row. Isolation is enforced three times over: the context is
 * resolved from the session, `withUser()` runs on the RLS-scoped app connection,
 * and `payment_secret_ciphertext()` filters on the caller's own
 * `auth_tenant_ids()`.
 *
 * Returns null when the tenant has no gateway configured — a normal state, not
 * an error, so callers can offer in-store payment instead.
 *
 * Throws DecryptionError if the stored ciphertext cannot be authenticated,
 * which means the master key changed or the row was tampered with. That is a
 * genuine fault and must not be swallowed into "not configured".
 */
export async function getRazorpayCredentials(
  ctx: ActiveContext,
): Promise<RazorpayCredentials | null> {
  const tenantId = ctx.tenant.id

  const row = await withUser(ctx.user.id, async (tx) => {
    const result = await tx.execute<{ key_id: string | null; ciphertext: string | null }>(
      sql`select public.payment_key_id(${tenantId}::uuid)            as key_id,
                 public.payment_secret_ciphertext(${tenantId}::uuid) as ciphertext`,
    )
    return result.rows[0]
  })

  if (!row?.key_id || !row.ciphertext) return null

  try {
    // The tenant id is the AAD the value was sealed with, so a ciphertext moved
    // between tenant rows fails here rather than decrypting into the wrong
    // venue's account.
    const keySecret = decryptSecret(row.ciphertext, tenantId)
    return { keyId: row.key_id, keySecret }
  } catch (e) {
    // Log the tenant and the failure mode — never the ciphertext, the key, or
    // any recovered bytes.
    console.error(
      `[razorpay-credentials] failed to decrypt credentials for tenant ${tenantId}:`,
      e instanceof Error ? e.name : 'unknown error',
    )
    if (e instanceof DecryptionError) throw e
    throw new DecryptionError('Could not decrypt the stored Razorpay credentials.')
  }
}

/**
 * Same, but throws PaymentNotConfiguredError instead of returning null — for
 * the AROS-49/50 paths where an online payment has already been committed to
 * and "no gateway" is not a recoverable state.
 */
export async function requireRazorpayCredentials(
  ctx: ActiveContext,
): Promise<RazorpayCredentials> {
  const creds = await getRazorpayCredentials(ctx)
  if (!creds) throw new PaymentNotConfiguredError()
  return creds
}
