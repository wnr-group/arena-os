'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { withUser } from '@/db'
import { requireManager, AuthError } from '@/lib/auth/guard'
import { EncryptionConfigError } from '@/lib/security/encryption'
import {
  clearPaymentSecret,
  clearWebhookSecret,
  loadPaymentSettingsView,
  paymentSettingsSchema,
  upsertPaymentSettings,
} from '@/lib/settings/payment-settings'

/**
 * Payment settings actions.
 *
 * The RETURN TYPE is the security boundary: `{ error?, success? }` and nothing
 * else. A server action's return value is serialised straight to the browser,
 * so this file must never widen it to include settings, a key secret, or
 * ciphertext — not even "just for the optimistic update".
 *
 * The plaintext secret travels one way only: browser → server action → encrypt
 * → database. It is never echoed back, never logged, and never stored.
 */

type SaveResult = { error?: string; success?: true }

/** Only safe text reaches the UI — no exception message is ever passed through. */
function fail(e: unknown, op: string): SaveResult {
  if (e instanceof AuthError) return { error: e.message }
  if (e instanceof z.ZodError) return { error: e.issues[0]?.message ?? 'Check the values entered.' }
  if (e instanceof EncryptionConfigError) {
    // The message names the env var but never its value — safe to surface, and
    // far more useful to an operator than "something went wrong".
    console.error(`[payment-settings] ${op} blocked: encryption is not configured.`)
    return {
      error:
        'Payment credential encryption is not configured on the server. Contact your administrator.',
    }
  }

  // Deliberately logs the operation and NOTHING from the input: the caught
  // error could be a driver error whose message quotes the parameters, which on
  // this path would include the Razorpay secret.
  console.error(`[payment-settings] ${op} failed:`, e instanceof Error ? e.name : 'unknown error')
  return { error: 'Could not save the payment settings. Please try again.' }
}

/**
 * Save the tenant's Razorpay credentials.
 *
 * Manager-only at BOTH layers: requireManager() here, and the
 * `payment_settings_write` RLS policy (auth_is_manager) in the database. A
 * cashier who calls this action directly — bypassing the hidden sidebar entry
 * and the page redirect — is refused twice over.
 *
 * `tenant_id` comes from the authenticated context. Nothing about identity,
 * tenant, or role is ever taken from the input.
 *
 * Blank secret = keep the stored one. The form never pre-fills the secret, so
 * an empty field is the normal state of an edit that only touches the key id;
 * treating it as "erase" would silently break checkout.
 */
export async function savePaymentSettings(
  input: z.input<typeof paymentSettingsSchema>,
): Promise<SaveResult> {
  try {
    const ctx = await requireManager()
    const v = paymentSettingsSchema.parse(input)

    await withUser(ctx.user.id, async (tx) => {
      // A stored secret with no key id cannot call Razorpay, and the DB CHECK
      // would reject it anyway — catch it here for a message that explains why.
      if (!v.razorpayKeyId) {
        const existing = await loadPaymentSettingsView(tx, ctx.tenant.id)
        if (v.razorpayKeySecret || existing?.hasSecret) {
          throw new z.ZodError([
            {
              code: 'custom',
              path: ['razorpayKeyId'],
              message: 'A key ID is required whenever a key secret is stored.',
            },
          ])
        }
      }
      await upsertPaymentSettings(tx, ctx.tenant.id, v)
    })

    revalidatePath('/settings/payments')
    return { success: true }
  } catch (e) {
    return fail(e, 'save')
  }
}

/**
 * Remove the stored key secret.
 *
 * Explicit and separate from the save path, so clearing a secret can never
 * happen by accident. The key id is left in place — it is publishable, and
 * keeping it means re-entering only the half that is actually secret.
 */
export async function clearRazorpaySecret(): Promise<SaveResult> {
  try {
    const ctx = await requireManager()
    await withUser(ctx.user.id, (tx) => clearPaymentSecret(tx, ctx.tenant.id))
    revalidatePath('/settings/payments')
    return { success: true }
  } catch (e) {
    return fail(e, 'clear secret')
  }
}

/**
 * Remove the stored WEBHOOK signing secret.
 *
 * Separate from clearRazorpaySecret() because these are two different Razorpay
 * credentials: clearing the webhook secret stops deposits from being CONFIRMED
 * (AROS-50 can no longer verify a signature) while leaving order creation
 * working, which is a meaningfully different operational state.
 */
export async function clearRazorpayWebhookSecret(): Promise<SaveResult> {
  try {
    const ctx = await requireManager()
    await withUser(ctx.user.id, (tx) => clearWebhookSecret(tx, ctx.tenant.id))
    revalidatePath('/settings/payments')
    return { success: true }
  } catch (e) {
    return fail(e, 'clear webhook secret')
  }
}
