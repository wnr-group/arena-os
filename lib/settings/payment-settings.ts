import 'server-only'
import { eq, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { z } from 'zod'
import { withUser } from '@/db'
import type * as schema from '@/db/schema'
import { paymentSettings } from '@/db/schema'
import { encryptSecret } from '@/lib/security/encryption'
import type { ActiveContext } from '@/lib/tenant/context'

/**
 * The tenant's payment gateway settings — the SAFE half.
 *
 * Nothing in this module returns a plaintext secret, and nothing returns the
 * ciphertext either. The decrypting loader lives in a separate, loudly named
 * file: lib/settings/razorpay-credentials.ts.
 *
 * Every select here names its columns explicitly. `select()` with no argument
 * would pull `razorpay_key_secret_encrypted` along with everything else, and
 * that value has no business travelling any further than it must.
 */

type Db = NodePgDatabase<typeof schema>

/** Exactly what the settings UI is allowed to know. */
export type PaymentSettingsView = {
  /** Publishable — Razorpay Checkout needs it in the browser. */
  razorpayKeyId: string | null
  /** Whether a key secret is stored. The secret itself never leaves the server. */
  hasSecret: boolean
  /** Whether a WEBHOOK secret is stored. Same rule — never leaves the server. */
  hasWebhookSecret: boolean
}

/**
 * Razorpay key ids look like `rzp_test_xxxxxxxxxxxxxx` / `rzp_live_…`, but the
 * exact alphabet is not contractual, so this validates shape rather than
 * guessing a regex that would reject a legitimate key. The secret is validated
 * only for length — its content is opaque by definition.
 */
export const paymentSettingsSchema = z.object({
  razorpayKeyId: z
    .string()
    .trim()
    .max(100, 'That key ID is too long.')
    .optional()
    .nullable()
    .transform((v) => (v ? v : null)),
  /**
   * BLANK MEANS "LEAVE THE STORED SECRET ALONE" — the form never pre-fills the
   * secret, so an empty field is the normal state of an edit that is only
   * changing the key id. It must never be read as "erase the secret".
   */
  razorpayKeySecret: z
    .string()
    .max(500, 'That key secret is too long.')
    .optional()
    .nullable()
    .transform((v) => {
      const t = v?.trim()
      return t ? t : null
    }),
  /**
   * The WEBHOOK signing secret — a DIFFERENT Razorpay credential from the key
   * secret above. Same blank-means-keep rule, same never-pre-filled form field.
   */
  razorpayWebhookSecret: z
    .string()
    .max(500, 'That webhook secret is too long.')
    .optional()
    .nullable()
    .transform((v) => {
      const t = v?.trim()
      return t ? t : null
    }),
})

export type PaymentSettingsInput = z.infer<typeof paymentSettingsSchema>

/**
 * The UI-safe view of the tenant's settings, in one RLS-scoped transaction.
 *
 * `hasSecret` is computed IN THE DATABASE as a boolean — the ciphertext is
 * never transferred out of Postgres, let alone into a React tree. The tenant
 * comes from the authenticated context, never from client input, and
 * `payment_settings_select` (manager-only) scopes the read on top of that.
 */
export async function getPaymentSettingsForClient(
  ctx: ActiveContext,
): Promise<PaymentSettingsView> {
  const row = await withUser(ctx.user.id, (tx) =>
    loadPaymentSettingsView(tx, ctx.tenant.id),
  )
  return row ?? { razorpayKeyId: null, hasSecret: false, hasWebhookSecret: false }
}

/** The same safe projection, against a caller-supplied transaction. */
export async function loadPaymentSettingsView(
  tx: Db,
  tenantId: string,
): Promise<PaymentSettingsView | null> {
  const [row] = await tx
    .select({
      razorpayKeyId: paymentSettings.razorpayKeyId,
      // Computed IN Postgres: the ciphertext never leaves the database.
      hasSecret: sql<boolean>`${paymentSettings.razorpayKeySecretEncrypted} is not null`,
      hasWebhookSecret: sql<boolean>`${paymentSettings.razorpayWebhookSecretEncrypted} is not null`,
    })
    .from(paymentSettings)
    .where(eq(paymentSettings.tenantId, tenantId))
    .limit(1)
  return row ?? null
}

/**
 * The publishable key id for any member of the tenant.
 *
 * Goes through the `payment_key_id()` SECURITY DEFINER function from migration
 * 0022 rather than the table, because `payment_settings_select` is manager-only
 * — a cashier at the POS still needs this to open Razorpay Checkout. The
 * function can only ever return the key id.
 */
export async function getRazorpayKeyId(ctx: ActiveContext): Promise<string | null> {
  const result = await withUser(ctx.user.id, (tx) =>
    tx.execute<{ key_id: string | null }>(
      sql`select public.payment_key_id(${ctx.tenant.id}::uuid) as key_id`,
    ),
  )
  return result.rows[0]?.key_id ?? null
}

/**
 * Create or update the tenant's single row.
 *
 * The secret is encrypted HERE, on the server, immediately before the write —
 * plaintext exists only as a local for the length of this call and is never
 * logged, returned, or persisted. The tenant id is bound in as AAD, so a
 * ciphertext lifted from one tenant's row cannot be replayed into another's:
 * it fails authentication instead of decrypting.
 *
 * `tenant_id` is the primary key and the conflict target, so this can only ever
 * touch the caller's own row. `created_at` is never in the update set.
 *
 * When `razorpayKeySecret` is null the existing ciphertext is left EXACTLY as
 * it was — `razorpay_key_secret_encrypted` is simply absent from the update
 * set, so an edit that only changes the key id cannot blank the secret.
 */
export async function upsertPaymentSettings(
  tx: Db,
  tenantId: string,
  input: PaymentSettingsInput,
): Promise<void> {
  const encrypted = input.razorpayKeySecret
    ? encryptSecret(input.razorpayKeySecret, tenantId)
    : null
  // Encrypted independently of the key secret: they are separate credentials
  // and either may be rotated without touching the other.
  const encryptedWebhook = input.razorpayWebhookSecret
    ? encryptSecret(input.razorpayWebhookSecret, tenantId)
    : null

  await tx
    .insert(paymentSettings)
    .values({
      tenantId,
      razorpayKeyId: input.razorpayKeyId,
      razorpayKeySecretEncrypted: encrypted,
      razorpayWebhookSecretEncrypted: encryptedWebhook,
    })
    .onConflictDoUpdate({
      target: paymentSettings.tenantId,
      set: {
        razorpayKeyId: input.razorpayKeyId,
        // Each key is present in the update set ONLY when the manager actually
        // typed a new value for it, so saving one never blanks the other.
        ...(encrypted ? { razorpayKeySecretEncrypted: encrypted } : {}),
        ...(encryptedWebhook ? { razorpayWebhookSecretEncrypted: encryptedWebhook } : {}),
      },
    })
}

/**
 * Remove the stored secret (and, with it, the ability to call Razorpay).
 *
 * Separate from the save path so that clearing a secret is always an explicit
 * act, never the side effect of an empty form field.
 */
export async function clearPaymentSecret(tx: Db, tenantId: string): Promise<void> {
  await tx
    .update(paymentSettings)
    .set({ razorpayKeySecretEncrypted: null })
    .where(eq(paymentSettings.tenantId, tenantId))
}

/** Remove the stored webhook secret. Leaves the API key secret untouched. */
export async function clearWebhookSecret(tx: Db, tenantId: string): Promise<void> {
  await tx
    .update(paymentSettings)
    .set({ razorpayWebhookSecretEncrypted: null })
    .where(eq(paymentSettings.tenantId, tenantId))
}
