'use server'

import { revalidatePath } from 'next/cache'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { ownerDb } from '@/db'
import { platformBillingSettings } from '@/db/schema'
import { stateCodeFromGstin } from '@/lib/platform/billing/gst'
import { requirePlatformAdmin, PlatformError } from '@/lib/platform/guard'
import { EncryptionConfigError } from '@/lib/security/encryption'
import {
  clearPlatformKeySecret,
  clearPlatformWebhookSecret,
  savePlatformGatewaySettings,
} from '@/lib/platform/billing/credentials'

/**
 * Platform-admin configuration of ARENA OS's OWN Razorpay account (M16 #3).
 *
 * The account this configures charges BUSINESSES their Arena OS subscription.
 * It is not, and must never be confused with, the per-tenant gateway a venue
 * configures at /settings/payments to collect its own customers' deposits —
 * that one lives in lib/actions/payment-settings.ts and is manager-scoped
 * within a single tenant.
 *
 * ── The two boundaries ──────────────────────────────────────────────────────
 *
 *   1. AUTHORIZATION. Every export calls requirePlatformAdmin() first — the
 *      same rule lib/actions/platform.ts and lib/actions/plans.ts state. On top
 *      of that, `arena_app` (the role every tenant request runs as) has NO GRANT
 *      of any kind on platform_payment_settings (0079), so even an action
 *      somehow invoked without its guard would hit a 42501 rather than a write.
 *      There is no tenant-reachable path to this table at all.
 *
 *   2. THE RETURN TYPE. `{ error?, success? }` and nothing else. A server
 *      action's return value is serialised straight to the browser, so this file
 *      must never widen it to include a key secret, a webhook secret, or
 *      ciphertext — not even "just for the optimistic update".
 *
 * The plaintext secret travels one way only: browser → action → encrypt →
 * database. It is never echoed back, never logged, never stored in the clear.
 */

type Result = { error?: string; success?: true }

/** Only safe text reaches the UI — no exception message is ever passed through. */
function fail(e: unknown, op: string): Result {
  if (e instanceof PlatformError) return { error: e.message }
  if (e instanceof z.ZodError) return { error: e.issues[0]?.message ?? 'Check the values entered.' }
  if (e instanceof EncryptionConfigError) {
    // The message names the env var but never its value — safe to surface, and
    // far more useful to an operator than "something went wrong".
    console.error(`[platform-gateway] ${op} blocked: encryption is not configured.`)
    return {
      error:
        'Secret encryption is not configured on the server (PAYMENT_SETTINGS_ENCRYPTION_KEY). Set it before saving gateway credentials.',
    }
  }
  // Logs the operation and NOTHING from the input: the caught error could be a
  // driver error whose message quotes the parameters, which here would include
  // the Razorpay secret.
  console.error(`[platform-gateway] ${op} failed:`, e instanceof Error ? e.name : 'unknown error')
  return { error: 'Could not save the platform gateway settings. Please try again.' }
}

/**
 * Key ids look like `rzp_test_…` / `rzp_live_…`, but the exact alphabet is not
 * contractual, so this validates shape rather than guessing a regex that would
 * reject a legitimate key. The secrets are validated only for length — their
 * content is opaque by definition.
 */
// NOT exported: a "use server" module may only export async functions, and a
// Zod schema is an object. It has no call site outside this file anyway.
const platformGatewaySchema = z.object({
  razorpayKeyId: z
    .string()
    .trim()
    .max(100, 'That key ID is too long.')
    .optional()
    .nullable()
    .transform((v) => (v ? v : null)),
  /**
   * BLANK MEANS "LEAVE THE STORED SECRET ALONE". The form never pre-fills a
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
  /** The WEBHOOK signing secret — a different credential, rotated separately. */
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

/**
 * Save the platform's Razorpay credentials.
 *
 * A stored key secret with no key id cannot authenticate to Razorpay, so that
 * combination is refused here with a message that explains why rather than
 * being discovered at the moment a business tries to subscribe.
 */
export async function savePlatformGateway(
  input: z.input<typeof platformGatewaySchema>,
): Promise<Result> {
  try {
    await requirePlatformAdmin()
    const v = platformGatewaySchema.parse(input)

    if (!v.razorpayKeyId && v.razorpayKeySecret) {
      return { error: 'A key ID is required whenever a key secret is stored.' }
    }

    await savePlatformGatewaySettings(v)
    revalidatePath('/admin/billing')
    return { success: true }
  } catch (e) {
    return fail(e, 'save')
  }
}

/**
 * Remove the stored API key secret.
 *
 * Explicit and separate from the save path, so clearing a secret is never the
 * side effect of an empty form field. The key id is left in place — it is
 * publishable, and keeping it means re-entering only the half that is secret.
 */
export async function clearPlatformRazorpaySecret(): Promise<Result> {
  try {
    await requirePlatformAdmin()
    await clearPlatformKeySecret()
    revalidatePath('/admin/billing')
    return { success: true }
  } catch (e) {
    return fail(e, 'clear key secret')
  }
}

/**
 * Remove the stored WEBHOOK signing secret.
 *
 * Separate from clearPlatformRazorpaySecret() because the consequences differ:
 * without the webhook secret, no subscription state change can be CONFIRMED —
 * every delivery is rejected as unsigned — while subscription creation keeps
 * working. That is a meaningfully different broken state, and one an operator
 * may want to reach deliberately mid-rotation.
 */
export async function clearPlatformRazorpayWebhookSecret(): Promise<Result> {
  try {
    await requirePlatformAdmin()
    await clearPlatformWebhookSecret()
    revalidatePath('/admin/billing')
    return { success: true }
  } catch (e) {
    return fail(e, 'clear webhook secret')
  }
}

// ── the platform's GST letterhead (M16 #4) ───────────────────────────────────

/**
 * Who Arena OS is on the invoices it issues to businesses.
 *
 * Deliberately in this file rather than a new one: it is the same admin page,
 * the same requirePlatformAdmin() boundary, and the same `{ error?, success? }`
 * return contract. It is a SEPARATE TABLE from the gateway credentials
 * (migration 0080) because one holds secrets and the other is a letterhead —
 * but they are configured together, because an operator setting up billing
 * needs both before a single invoice can be raised.
 *
 * Nothing here is secret, and nothing here is read when RENDERING an invoice:
 * every value is snapshotted onto each invoice at issue time, so editing it
 * changes what FUTURE bills say and never rewrites a bill already filed.
 */

/** The two-digit GST state code of the supplier's registration. */
const stateCode = z
  .string()
  .trim()
  .regex(/^[0-9]{2}$/, 'Enter the 2-digit GST state code, e.g. 33 for Tamil Nadu.')
  .optional()
  .nullable()
  .or(z.literal(''))
  .transform((v) => (v ? String(v) : null))

const prefix = (label: string) =>
  z
    .string()
    .trim()
    .min(1, `${label} is required.`)
    // Same 4-character ceiling as business_profiles.invoice_prefix (0020), for
    // the same reason: the number format is PREFIX/YYYY/NNNNNN and a GST
    // invoice number may not exceed 16 characters.
    .max(4, `${label} must be 4 characters or fewer.`)
    .toUpperCase()

// Not exported, for the same reason as platformGatewaySchema above.
const platformBillingSchema = z.object({
  sellerLegalName: z.string().trim().max(200).optional().nullable().transform((v) => v || null),
  // GSTIN is length-checked only, matching lib/settings/business-profile.ts:
  // the project has no GSTIN validator and inventing one would reject
  // legitimate edge cases (SEZ, UIN-holders) for no benefit.
  sellerGstin: z.string().trim().max(20).optional().nullable().transform((v) => v || null),
  sellerAddress: z.string().trim().max(500).optional().nullable().transform((v) => v || null),
  sellerStateCode: stateCode,
  gstRate: z
    .string()
    .trim()
    .regex(/^\d{1,2}(\.\d{1,2})?$/, 'Enter a rate like 18 or 18.00')
    .refine((v) => Number(v) >= 0 && Number(v) <= 100, 'Rate must be between 0 and 100.'),
  invoicePrefix: prefix('Invoice prefix'),
  creditNotePrefix: prefix('Credit note prefix'),
})

export async function savePlatformBillingProfile(
  input: z.input<typeof platformBillingSchema>,
): Promise<Result> {
  try {
    await requirePlatformAdmin()
    const v = platformBillingSchema.parse(input)

    // A GSTIN whose state code contradicts the declared state would decide
    // CGST-vs-IGST one way while the document says another. Caught here, where
    // it can be explained, rather than producing quietly wrong tax later.
    const fromGstin = stateCodeFromGstin(v.sellerGstin)
    if (fromGstin && v.sellerStateCode && fromGstin !== v.sellerStateCode) {
      return {
        error: `The GSTIN begins with state code ${fromGstin}, which does not match the state code entered (${v.sellerStateCode}).`,
      }
    }

    await ownerDb
      .insert(platformBillingSettings)
      .values({
        id: true,
        ...v,
        // Fall back to the GSTIN's own state code when none was typed: it is
        // the same fact, and requiring it twice only invites disagreement.
        sellerStateCode: v.sellerStateCode ?? fromGstin,
      })
      .onConflictDoUpdate({
        target: platformBillingSettings.id,
        set: { ...v, sellerStateCode: v.sellerStateCode ?? fromGstin },
      })

    revalidatePath('/admin/billing')
    return { success: true }
  } catch (e) {
    return fail(e, 'save billing profile')
  }
}

/** The current letterhead, for the admin form. Nothing secret in it. */
export async function readPlatformBillingProfile() {
  await requirePlatformAdmin()
  const [row] = await ownerDb
    .select()
    .from(platformBillingSettings)
    .where(eq(platformBillingSettings.id, true))
    .limit(1)
  return row ?? null
}
