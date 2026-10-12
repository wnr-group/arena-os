import 'server-only'
import { eq, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { z } from 'zod'
import { withUser } from '@/db'
import type * as schema from '@/db/schema'
import { auditLog, paymentSettings } from '@/db/schema'
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
  /** M36 #1 — what the storefront collects at booking time. */
  onlinePaymentMode: OnlinePaymentMode
  advanceType: 'fixed' | 'percent' | null
  advanceValue: number | null
}

export const ONLINE_PAYMENT_MODES = ['optional_full', 'venue', 'advance', 'full'] as const
export type OnlinePaymentMode = (typeof ONLINE_PAYMENT_MODES)[number]

const DEFAULT_MODE_VIEW = {
  onlinePaymentMode: 'optional_full' as OnlinePaymentMode,
  advanceType: null,
  advanceValue: null,
}

/**
 * The booking-payment mode the owner picks (M36 #1). `optional_full` is the
 * legacy state — it can be shown but never newly chosen, so it is not
 * selectable here. Mirrors the DB CHECK: advance needs a type and a value
 * (fixed > 0, percent in (0,100)); any other mode carries neither.
 */
export const bookingPaymentModeSchema = z
  .object({
    mode: z.enum(['venue', 'advance', 'full']),
    advanceType: z.enum(['fixed', 'percent']).optional().nullable(),
    advanceValue: z.number().finite().optional().nullable(),
  })
  .transform((v, ctx) => {
    if (v.mode !== 'advance') return { mode: v.mode, advanceType: null, advanceValue: null }
    const type = v.advanceType
    const value = v.advanceValue == null ? null : Math.round(v.advanceValue * 100) / 100
    if (!type || value == null) {
      ctx.addIssue({ code: 'custom', message: 'Choose how much to collect as the advance.' })
      return z.NEVER
    }
    if (value <= 0) {
      ctx.addIssue({ code: 'custom', message: 'The advance must be greater than zero.' })
      return z.NEVER
    }
    if (type === 'percent' && value >= 100) {
      ctx.addIssue({
        code: 'custom',
        message: 'A percentage advance must be below 100% — choose "Collect full amount" instead.',
      })
      return z.NEVER
    }
    if (value > 9_999_999_999) {
      ctx.addIssue({ code: 'custom', message: 'That advance is too large.' })
      return z.NEVER
    }
    return { mode: v.mode, advanceType: type, advanceValue: value }
  })

export type BookingPaymentModeInput = z.input<typeof bookingPaymentModeSchema>

export class PaymentModeError extends Error {}

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
  return row ?? { razorpayKeyId: null, hasSecret: false, hasWebhookSecret: false, ...DEFAULT_MODE_VIEW }
}

/** The same safe projection, against a caller-supplied transaction. */
export async function loadPaymentSettingsView(
  tx: Db,
  tenantId: string,
): Promise<PaymentSettingsView | null> {
  const [r] = await tx
    .select({
      razorpayKeyId: paymentSettings.razorpayKeyId,
      onlinePaymentMode: paymentSettings.onlinePaymentMode,
      advanceType: paymentSettings.advanceType,
      advanceValue: paymentSettings.advanceValue,
      // Computed IN Postgres: the ciphertext never leaves the database.
      hasSecret: sql<boolean>`${paymentSettings.razorpayKeySecretEncrypted} is not null`,
      hasWebhookSecret: sql<boolean>`${paymentSettings.razorpayWebhookSecretEncrypted} is not null`,
    })
    .from(paymentSettings)
    .where(eq(paymentSettings.tenantId, tenantId))
    .limit(1)
  if (!r) return null
  return { ...r, advanceValue: r.advanceValue == null ? null : Number(r.advanceValue) }
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
export async function clearPaymentSecret(
  tx: Db,
  tenantId: string,
  actorMembershipId?: string,
): Promise<{ revertedToVenue: boolean }> {
  const before = await loadPaymentSettingsView(tx, tenantId)
  // Without a secret the storefront cannot take payment, so a mode that
  // requires it must not outlive it: revert to "pay at venue" in the same
  // statement (the DB CHECK would refuse anything else).
  const revert = before?.onlinePaymentMode === 'advance' || before?.onlinePaymentMode === 'full'
  await tx
    .update(paymentSettings)
    .set({
      razorpayKeySecretEncrypted: null,
      ...(revert ? { onlinePaymentMode: 'venue' as const, advanceType: null, advanceValue: null } : {}),
    })
    .where(eq(paymentSettings.tenantId, tenantId))
  if (revert && before) {
    await tx.insert(auditLog).values({
      tenantId,
      actorMembershipId: actorMembershipId ?? null,
      action: 'payment_settings.booking_mode_changed',
      entityType: 'payment_settings',
      entityId: tenantId,
      before: modeSnapshot(before),
      after: { mode: 'venue', advanceType: null, advanceValue: null, reason: 'razorpay_secret_removed' },
    })
  }
  return { revertedToVenue: revert }
}

function modeSnapshot(v: Pick<PaymentSettingsView, 'onlinePaymentMode' | 'advanceType' | 'advanceValue'>) {
  return { mode: v.onlinePaymentMode, advanceType: v.advanceType, advanceValue: v.advanceValue }
}

/**
 * Set the booking-payment mode (M36 #1). Runs inside the caller's RLS
 * transaction, so a non-manager's write is also refused by payment_settings_write.
 * advance / full require a stored key id AND secret — checked here for a clear
 * message and again by the payment_settings_online_mode_needs_credentials CHECK.
 * Writes an audit row (who, old → new) in the same transaction.
 */
export async function saveBookingPaymentMode(
  tx: Db,
  tenantId: string,
  actorMembershipId: string,
  input: BookingPaymentModeInput,
): Promise<void> {
  const v = bookingPaymentModeSchema.parse(input)
  const before = (await loadPaymentSettingsView(tx, tenantId)) ?? {
    razorpayKeyId: null,
    hasSecret: false,
    hasWebhookSecret: false,
    ...DEFAULT_MODE_VIEW,
  }
  if ((v.mode === 'advance' || v.mode === 'full') && !(before.razorpayKeyId && before.hasSecret)) {
    throw new PaymentModeError(
      'Save your Razorpay key ID and key secret first — online payment can’t be required without them.',
    )
  }
  const advanceValue = v.advanceValue == null ? null : v.advanceValue.toFixed(2)
  // UPDATE first: an INSERT ... ON CONFLICT checks the proposed row against the
  // credentials CHECK before it ever reaches the conflict, so advance/full on an
  // existing row would be refused. Only `venue` can reach the insert (no row yet
  // means no credentials, which the guard above enforces).
  const updated = await tx
    .update(paymentSettings)
    .set({ onlinePaymentMode: v.mode, advanceType: v.advanceType, advanceValue })
    .where(eq(paymentSettings.tenantId, tenantId))
    .returning({ tenantId: paymentSettings.tenantId })
  if (updated.length === 0) {
    await tx
      .insert(paymentSettings)
      .values({ tenantId, onlinePaymentMode: v.mode, advanceType: v.advanceType, advanceValue })
  }
  await tx.insert(auditLog).values({
    tenantId,
    actorMembershipId,
    action: 'payment_settings.booking_mode_changed',
    entityType: 'payment_settings',
    entityId: tenantId,
    before: modeSnapshot(before),
    after: { mode: v.mode, advanceType: v.advanceType, advanceValue: v.advanceValue },
  })
}

/** Remove the stored webhook secret. Leaves the API key secret untouched. */
export async function clearWebhookSecret(tx: Db, tenantId: string): Promise<void> {
  await tx
    .update(paymentSettings)
    .set({ razorpayWebhookSecretEncrypted: null })
    .where(eq(paymentSettings.tenantId, tenantId))
}
