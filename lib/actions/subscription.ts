'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireOwner, AuthError } from '@/lib/auth/guard'
import { DecryptionError } from '@/lib/security/encryption'
import { RazorpayApiError } from '@/lib/payments/razorpay'
import { PlatformGatewayNotConfiguredError } from '@/lib/platform/billing/credentials'
import { subscribeTenantToPlan, SubscriptionError } from '@/lib/platform/billing/subscribe'
import { cancelTenantSubscription } from '@/lib/platform/billing/cancel'
import { previewPlanChangeFor, PreviewError, type PlanChangePreview } from '@/lib/platform/billing/preview'
import { paymentMethodUpdateFlow } from '@/lib/platform/billing/payment-method'
import { pgError } from '@/lib/utils/errors'

/**
 * The BUSINESS's own subscription actions — starting and stopping the Arena OS
 * plan it pays for (M16 #3).
 *
 * ── Who may call these ──────────────────────────────────────────────────────
 *
 * requireOwner(), not requireManager(). Committing a business to a recurring
 * charge is the same class of decision as editing its legal identity, which
 * lib/auth/guard.ts already reserves for owners ("the business's legal identity
 * is owner-only"). A manager runs the venue; only an owner signs for it.
 *
 * ── What is trusted from the caller ─────────────────────────────────────────
 *
 * A plan id and the word "monthly" or "annual". Nothing else — no price, no
 * amount, no currency, no gateway plan id, no tenant id. The tenant comes from
 * the authenticated context, and every figure that decides what is charged is
 * loaded server-side in lib/platform/billing/subscribe.ts, which also proves the
 * gateway plan's price matches the catalogue before creating anything.
 *
 * ── What is never returned ──────────────────────────────────────────────────
 *
 * No Razorpay key, no webhook secret, no decrypted anything. The one outward
 * value is `checkoutUrl` — Razorpay's own hosted authorisation page, a public
 * URL the payer is meant to open. Arriving back from it proves nothing: only
 * the signed webhook activates a subscription.
 */

type Result = { error?: string }

function fail(e: unknown, op: string): Result {
  if (e instanceof AuthError) return { error: e.message }
  if (e instanceof z.ZodError) return { error: e.issues[0]?.message ?? 'Check the values entered.' }
  if (e instanceof SubscriptionError) return { error: e.message }
  if (e instanceof PreviewError) return { error: e.message }
  if (e instanceof PlatformGatewayNotConfiguredError) return { error: e.message }

  if (e instanceof RazorpayApiError) {
    // Razorpay's own text about OUR request, already sanitised and length-capped
    // in the client. Never a credential.
    console.error(`[subscription] ${op}: gateway error ${e.status}`)
    return {
      error: e.retriable
        ? 'The payment gateway is temporarily unavailable. Nothing has been charged — please try again in a moment.'
        : e.message,
    }
  }
  if (e instanceof DecryptionError) {
    // The platform's stored credentials will not decrypt. An operator problem,
    // and one a business cannot act on, so it does not get the detail.
    console.error(`[subscription] ${op}: platform credentials unusable`)
    return { error: 'Subscription billing is temporarily unavailable. Contact Arena OS support.' }
  }

  const { code } = pgError(e)
  if (code === '23505') {
    // idx_tenant_subscriptions_one_live, almost certainly: two checkouts at
    // once. The row lock in subscribeTenantToPlan() makes this rare.
    return { error: 'A subscription change is already in progress. Refresh and try again.' }
  }
  if (code === '23503') return { error: 'That plan no longer exists.' }

  console.error(`[subscription] ${op} failed:`, e instanceof Error ? e.name : 'unknown error')
  return { error: 'Something went wrong. Please try again.' }
}

const subscribeInput = z.object({
  planId: z.string().uuid('Choose a plan.'),
  billingPeriod: z.enum(['monthly', 'annual']),
})

export type SubscribeActionResult = Result & { checkoutUrl?: string }

/**
 * Start, upgrade, downgrade or re-period a paid Arena OS plan.
 *
 * ONE action for all four, because to Razorpay they are one operation: M16 #3
 * changes a plan by cancelling the old subscription and creating a new one, so
 * "subscribe" and "change plan" execute the identical path. Splitting them into
 * two exported actions would be two names for one implementation — and the
 * second one would eventually drift.
 *
 * (Renamed from `subscribeToPlan` in M16 #5. Same function, same behaviour;
 * the new name simply describes what the billing portal uses it for.)
 *
 * Returns the Razorpay hosted-checkout URL for the owner to complete the
 * mandate. The local subscription row is created as `trialing` — live, but not
 * paid — and only the `subscription.charged` / `subscription.activated` webhook
 * moves it to `active` and the account to `active`.
 */
export async function changeSubscriptionPlan(
  input: z.input<typeof subscribeInput>,
): Promise<SubscribeActionResult> {
  try {
    const ctx = await requireOwner()
    const v = subscribeInput.parse(input)

    const result = await subscribeTenantToPlan({
      // From the session. Never from the input — there is no tenant field to
      // send, which is the point.
      tenantId: ctx.tenant.id,
      planId: v.planId,
      billingPeriod: v.billingPeriod,
    })

    revalidatePath('/settings/billing')
    return { checkoutUrl: result.checkoutUrl ?? undefined }
  } catch (e) {
    return fail(e, 'change plan')
  }
}

export type PreviewActionResult = Result & { preview?: PlanChangePreview }

/**
 * Quote a plan change without performing one (M16 #5).
 *
 * READ-ONLY. It exists so the confirmation dialog can state the consequences —
 * old plan, new plan, the proration credit, what Razorpay will capture — in
 * figures the SERVER computed, using the same arithmetic the mutation will use.
 *
 * Owner-guarded like every other action here, even though it writes nothing:
 * the catalogue and the tenant's own pricing position are not a manager's
 * business, and an action that leaks them would undo the point of the RLS
 * policy on the page.
 *
 * Nothing it returns is ever read back by changeSubscriptionPlan(), which
 * recomputes from the database — so a tampered preview cannot influence a
 * charge.
 */
export async function previewPlanChange(
  input: z.input<typeof subscribeInput>,
): Promise<PreviewActionResult> {
  try {
    const ctx = await requireOwner()
    const v = subscribeInput.parse(input)
    const preview = await previewPlanChangeFor(ctx.tenant.id, v.planId, v.billingPeriod)
    return { preview }
  } catch (e) {
    return fail(e, 'preview')
  }
}

export type PaymentMethodActionResult = Result & { url?: string; gatewayStatus?: string }

/**
 * Open Razorpay's hosted authorisation page for this tenant's mandate.
 *
 * The URL is fetched from Razorpay SERVER-SIDE using the PLATFORM credentials
 * (never a tenant's own Razorpay keys, which belong to a different account and
 * collect that venue's customers' money). What crosses back to the browser is
 * one public URL that Razorpay itself serves to payers — no key, no secret, no
 * ciphertext. See lib/platform/billing/payment-method.ts for what Razorpay does
 * and does not support here.
 */
export async function createPaymentMethodUpdateFlow(): Promise<PaymentMethodActionResult> {
  try {
    const ctx = await requireOwner()
    const flow = await paymentMethodUpdateFlow(ctx.tenant.id)
    return { url: flow.url, gatewayStatus: flow.gatewayStatus }
  } catch (e) {
    return fail(e, 'payment method')
  }
}

export type CancelActionResult = Result & { atPeriodEnd?: boolean; endsAt?: string }

/**
 * Cancel the business's Arena OS subscription.
 *
 * Razorpay is told first — see lib/platform/billing/cancel.ts for why, and for
 * the at-period-end vs immediate rule. The webhook remains the source of truth
 * for the final provider state.
 */
export async function cancelSubscription(): Promise<CancelActionResult> {
  try {
    const ctx = await requireOwner()
    const result = await cancelTenantSubscription(ctx.tenant.id)
    revalidatePath('/settings/billing')
    return {
      atPeriodEnd: result.atPeriodEnd,
      endsAt: result.currentPeriodEnd.toISOString(),
    }
  } catch (e) {
    return fail(e, 'cancel')
  }
}

/**
 * ── There is deliberately NO resumeSubscription() ───────────────────────────
 *
 * Razorpay's Subscriptions API exposes `/cancel`, `/pause` and `/resume`, and
 * `/resume` applies to a subscription that was PAUSED. It offers no way to
 * revoke a cancellation already scheduled with `cancel_at_cycle_end` — once
 * Razorpay has been told to stop at the end of the cycle, it stops.
 *
 * Clearing our own `cancel_at_period_end` flag would therefore be a lie: the UI
 * would say "your subscription will continue" while the gateway quietly wound
 * it down, and the business would discover the truth when its account was
 * suspended. A flag that does not control the thing it names is worse than no
 * button at all.
 *
 * So the portal offers no Resume. What it offers instead is honest and already
 * works: once the period ends and the subscription is cancelled, choosing a
 * plan again starts a fresh mandate through changeSubscriptionPlan(). The UI
 * says exactly that, with the date.
 *
 * If Razorpay ever exposes un-cancel, this is the file that gains the action —
 * and it must call the gateway first, like every other mutation here.
 */
