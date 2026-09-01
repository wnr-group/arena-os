'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requirePlatformAdmin, PlatformError } from '@/lib/platform/guard'
import { DecryptionError } from '@/lib/security/encryption'
import { RazorpayApiError } from '@/lib/payments/razorpay'
import { PlatformGatewayNotConfiguredError } from '@/lib/platform/billing/credentials'
import { SubscriptionError } from '@/lib/platform/billing/subscribe'
import {
  compTenant,
  extendTenantTrial,
  forceCancelTenantSubscription,
  OverrideError,
  MAX_COMP_AMOUNT,
  MAX_TRIAL_EXTENSION_DAYS,
} from '@/lib/platform/billing/overrides'
import {
  PlatformRefundError,
  refundPlatformInvoice,
} from '@/lib/platform/billing/refunds'
import type { PlatformActor } from '@/lib/platform/billing/audit'
import { zodErrorMessage, pgError } from '@/lib/utils/errors'

/**
 * THE PLATFORM-ADMIN BILLING OVERRIDES, as server actions (AROS-114 §§8, 10).
 *
 * ══ AUTHORIZATION ═══════════════════════════════════════════════════════════
 *
 * EVERY export begins with `await requirePlatformAdmin()`, before it parses its
 * input and before it touches anything. That call — not a hidden button, not
 * the /admin layout, not a redirect — is the boundary. A server action is a
 * public POST endpoint: anything a signed-in tenant user can import, they can
 * invoke, so a guard that lives in a page or a component is no guard at all.
 *
 * This is the identical shape lib/actions/platform.ts and lib/actions/plans.ts
 * already use, and it is deliberately restated in every function rather than
 * factored into a wrapper: a guard you can forget to apply is one refactor away
 * from being forgotten.
 *
 * A tenant owner, manager or cashier reaching any of these gets a PlatformError
 * ("Platform administrators only.") and nothing happens. They cannot change
 * another tenant's plan, extend a trial, comp an account, refund a platform
 * payment, force-cancel a subscription, or read one byte of platform-wide
 * billing data through this module.
 *
 * ══ WHAT IS TRUSTED FROM THE CALLER ═════════════════════════════════════════
 *
 * A tenant id, an invoice id, a number of days, an amount and a reason. Nothing
 * else — and none of it is believed on its own:
 *
 *   * the ACTOR is resolved from the session, never sent;
 *   * the tenant a refund is booked against is read from the LOCKED INVOICE
 *     ROW, not from this input;
 *   * a refund amount is validated against that row's total minus the sum of
 *     prior refunds, under the lock, in paise;
 *   * a comp is validated against a ceiling and the tenant's live subscription;
 *   * a trial extension is refused outright when Razorpay owns the period.
 *
 * ══ WHAT IS NEVER RETURNED ══════════════════════════════════════════════════
 *
 * No Razorpay key id, no key secret, no webhook secret, no ciphertext. Nothing
 * in this module selects a column from `platform_payment_settings`; the
 * credentials are loaded inside lib/platform/billing/credentials.ts on the
 * owner connection and never leave the gateway call. A Razorpay error's text is
 * already sanitised and length-capped by the client before it can reach here.
 */

type Result = { error?: string }

function fail(e: unknown, op: string): Result {
  if (e instanceof PlatformError) return { error: e.message }
  if (e instanceof OverrideError) return { error: e.message }
  if (e instanceof PlatformRefundError) return { error: e.message }
  if (e instanceof SubscriptionError) return { error: e.message }
  if (e instanceof PlatformGatewayNotConfiguredError) return { error: e.message }
  if (e instanceof z.ZodError) return { error: zodErrorMessage(e) }

  if (e instanceof RazorpayApiError) {
    console.error(`[platform-billing] ${op}: gateway error ${e.status}`)
    return {
      error: e.retriable
        ? 'The payment gateway is temporarily unavailable. Nothing has changed — try again in a moment.'
        : e.message,
    }
  }
  if (e instanceof DecryptionError) {
    console.error(`[platform-billing] ${op}: platform credentials unusable`)
    return { error: 'The platform gateway credentials will not decrypt. Check the billing settings.' }
  }

  const { code } = pgError(e)
  if (code === '23505') return { error: 'That change is already in progress. Refresh and try again.' }
  if (code === '23503') return { error: 'That company, plan or invoice no longer exists.' }

  // The NAME only. A driver error's message can quote statement parameters,
  // which on this path would include billing figures.
  console.error(`[platform-billing] ${op} failed:`, e instanceof Error ? e.name : 'unknown error')
  return { error: 'Something went wrong. Please try again.' }
}

/** Refresh every surface a billing override can change. */
function revalidateBilling(tenantId: string): void {
  revalidatePath('/admin/revenue')
  revalidatePath(`/admin/revenue/${tenantId}`)
  revalidatePath(`/admin/companies/${tenantId}`)
}

/** The session-resolved actor. The ONLY way this module names who acted. */
async function actor(): Promise<PlatformActor> {
  const user = await requirePlatformAdmin()
  return { userId: user.id, email: user.email }
}

// ── extend trial ─────────────────────────────────────────────────────────────

const extendInput = z.object({
  tenantId: z.string().uuid(),
  days: z.coerce
    .number()
    .int('Enter a whole number of days.')
    .min(1, 'Enter at least one day.')
    .max(MAX_TRIAL_EXTENSION_DAYS, `At most ${MAX_TRIAL_EXTENSION_DAYS} days.`),
  reason: z.string().trim().max(500).optional(),
})

export type ExtendTrialActionResult = Result & { newEnd?: string }

export async function extendTrialAction(
  input: z.input<typeof extendInput>,
): Promise<ExtendTrialActionResult> {
  try {
    const who = await actor()
    const v = extendInput.parse(input)
    const result = await extendTenantTrial(who, v)
    revalidateBilling(v.tenantId)
    return { newEnd: result.newEnd.toISOString() }
  } catch (e) {
    return fail(e, 'extend trial')
  }
}

// ── comp / discount ──────────────────────────────────────────────────────────

const compInput = z.object({
  tenantId: z.string().uuid(),
  amount: z.coerce
    .number()
    .positive('Enter an amount greater than zero.')
    .max(MAX_COMP_AMOUNT, `At most ${MAX_COMP_AMOUNT}.`),
  reason: z.string().trim().min(1, 'A reason is required.').max(500),
})

export type CompActionResult = Result & { creditNoteNumber?: string; amount?: number }

/**
 * Issue a comp as a CREDIT NOTE against the next invoice.
 *
 * See lib/platform/billing/overrides.ts for why this reuses the credit-note
 * model AROS-4 already built instead of adding a discount system, and for the
 * whole-note rule an operator needs to know about.
 */
export async function compTenantAction(
  input: z.input<typeof compInput>,
): Promise<CompActionResult> {
  try {
    const who = await actor()
    const v = compInput.parse(input)
    const result = await compTenant(who, v)
    revalidateBilling(v.tenantId)
    return { creditNoteNumber: result.creditNoteNumber, amount: result.amount }
  } catch (e) {
    return fail(e, 'comp')
  }
}

// ── refund ───────────────────────────────────────────────────────────────────

const refundInput = z.object({
  invoiceId: z.string().uuid(),
  amount: z.coerce.number().positive('Enter an amount greater than zero.'),
  reason: z.string().trim().min(1, 'A reason is required.').max(500),
  /**
   * The caller's retry token (lib/utils/idempotency-key.ts). Not a secret and
   * grants nothing — it is only ever accepted alongside a platform-admin
   * session, and its sole job is letting the server recognise a double-clicked
   * button as one refund rather than two.
   */
  requestKey: z.string().trim().min(8).max(64).optional(),
})

export type RefundActionResult = Result & {
  refundId?: string
  status?: 'pending' | 'processed' | 'failed'
  amount?: number
  /** Set when the same request key had already been used — nothing new happened. */
  deduplicated?: boolean
  /** Set when the gateway did not confirm in time. */
  note?: string
}

/**
 * Refund part or all of a paid platform invoice.
 *
 * NOTE the deliberate absence of a `tenantId` parameter. The tenant is read
 * from the locked invoice row inside refundPlatformInvoice(), so there is no
 * field here through which a caller could book a refund against a business
 * other than the one that was actually billed.
 */
export async function refundInvoiceAction(
  input: z.input<typeof refundInput>,
): Promise<RefundActionResult> {
  try {
    const who = await actor()
    const v = refundInput.parse(input)
    const result = await refundPlatformInvoice(who, {
      invoiceId: v.invoiceId,
      amount: v.amount,
      reason: v.reason,
      requestKey: v.requestKey ?? null,
    })
    // The tenant is not known to this layer until the refund returns, so the
    // dashboard is refreshed broadly rather than by id.
    revalidatePath('/admin/revenue')
    return {
      refundId: result.refundId,
      status: result.status,
      amount: result.amount,
      deduplicated: result.deduplicated,
      note: result.note,
    }
  } catch (e) {
    return fail(e, 'refund')
  }
}

// ── force cancel ─────────────────────────────────────────────────────────────

const forceCancelInput = z.object({
  tenantId: z.string().uuid(),
  /**
   * Ends the subscription NOW instead of at the end of the paid period. A
   * platform-admin-only override with no route from the owner portal — see
   * lib/platform/billing/cancel.ts.
   */
  immediate: z.boolean().default(false),
  reason: z.string().trim().max(500).optional(),
})

export type ForceCancelActionResult = Result & {
  atPeriodEnd?: boolean
  effectiveAt?: string
}

export async function forceCancelAction(
  input: z.input<typeof forceCancelInput>,
): Promise<ForceCancelActionResult> {
  try {
    const who = await actor()
    const v = forceCancelInput.parse(input)
    const result = await forceCancelTenantSubscription(who, v)
    revalidateBilling(v.tenantId)
    return {
      atPeriodEnd: result.atPeriodEnd,
      effectiveAt: result.currentPeriodEnd.toISOString(),
    }
  } catch (e) {
    return fail(e, 'force cancel')
  }
}
