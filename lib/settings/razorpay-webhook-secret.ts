import 'server-only'
import { and, eq } from 'drizzle-orm'
import { ownerDb } from '@/db'
import { paymentSettings, tenants } from '@/db/schema'
import { decryptSecret, DecryptionError } from '@/lib/security/encryption'

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  SERVER ONLY. Loads a tenant's Razorpay WEBHOOK signing secret.          ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * A separate file from lib/settings/razorpay-credentials.ts on purpose: that
 * one serves an authenticated user and reads through RLS; this one serves the
 * webhook route, which by definition has NO session.
 *
 * ── Why the owner connection ────────────────────────────────────────────────
 * Every other tenant read in this codebase goes through withUser(), which sets
 * `app.user_id` so RLS scopes the query. A webhook has no user — Razorpay is
 * the caller — so there is no user id to set and no RLS predicate that could
 * match. `payment_webhook_secret_ciphertext()` from 0024 exists for
 * authenticated callers; this path cannot use it.
 *
 * The containment is that this function is deliberately tiny and total:
 *   * it takes a tenant SLUG (resolved from the request host) and nothing else,
 *   * it returns one secret string for one tenant, or null,
 *   * it can neither write nor read anything but this one column,
 *   * and the secret it returns only ever proves a signature — a wrong tenant's
 *     secret simply fails to verify, so a mis-resolved slug is a rejected
 *     webhook, never a cross-tenant write.
 *
 * This is the ONLY owner-connection read on the webhook credential path. The
 * webhook's state changes live in lib/payments/webhook.ts and are scoped to the
 * tenant this lookup resolved.
 */

export type WebhookTenant = {
  tenantId: string
  slug: string
  /** SECRET. Used to compute an HMAC and then discarded. Never returned onward. */
  webhookSecret: string
}

/**
 * Resolve a tenant by slug and decrypt its webhook secret.
 *
 * Returns null when the slug is unknown, the tenant is not active, or no
 * webhook secret has been configured — all of which mean "cannot verify a
 * signature for this tenant", which the route must treat identically so the
 * response cannot be used to probe which slugs exist.
 *
 * Throws DecryptionError when a secret IS stored but will not decrypt (the
 * master key changed, or the row was tampered with). That is a real fault and
 * must surface as a retriable 500, not as a silent rejection.
 */
export async function loadWebhookSecretBySlug(slug: string): Promise<WebhookTenant | null> {
  const [row] = await ownerDb
    .select({
      tenantId: tenants.id,
      slug: tenants.slug,
      ciphertext: paymentSettings.razorpayWebhookSecretEncrypted,
    })
    .from(tenants)
    .leftJoin(paymentSettings, eq(paymentSettings.tenantId, tenants.id))
    .where(and(eq(tenants.slug, slug), eq(tenants.status, 'active')))
    .limit(1)

  if (!row?.ciphertext) return null

  try {
    // The tenant id is the AAD the value was sealed with, so a ciphertext moved
    // between tenant rows fails here rather than verifying another tenant's
    // webhooks.
    const webhookSecret = decryptSecret(row.ciphertext, row.tenantId)
    return { tenantId: row.tenantId, slug: row.slug, webhookSecret }
  } catch (e) {
    console.error(
      `[razorpay-webhook] failed to decrypt the webhook secret for tenant ${row.tenantId}:`,
      e instanceof Error ? e.name : 'unknown error',
    )
    if (e instanceof DecryptionError) throw e
    throw new DecryptionError('Could not decrypt the stored webhook secret.')
  }
}
