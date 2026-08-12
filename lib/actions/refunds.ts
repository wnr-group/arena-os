'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { withUser } from '@/db'
import { requireManager, AuthError } from '@/lib/auth/guard'
import { MAX_PAYMENT_AMOUNT } from '@/lib/billing/payments'
import { RefundError, recordRefund, voidInvoiceRecord } from '@/lib/billing/refunds'

type ActionResult = { error?: string; success?: true }

/** Same shape as the other billing actions — only safe text reaches the UI. */
function fail(e: unknown): ActionResult {
  if (e instanceof AuthError || e instanceof RefundError) return { error: e.message }
  if (e instanceof z.ZodError) return { error: e.issues[0]?.message ?? 'Check the values entered.' }
  console.error('[refunds] action failed:', e)
  return { error: 'Could not complete the operation. Please try again.' }
}

const REASON = z
  .string()
  .trim()
  .min(1, 'A reason is required.')
  .max(500, 'That reason is too long.')

const refundInput = z.object({
  paymentId: z.string().uuid('That payment reference is not valid.'),
  amount: z.coerce
    .number({ invalid_type_error: 'Enter a valid amount.' })
    .finite('Enter a valid amount.')
    .positive('Enter a refund amount greater than zero.')
    .max(MAX_PAYMENT_AMOUNT, 'That amount is too large.'),
  reason: REASON,
})

const voidInput = z.object({
  invoiceId: z.string().uuid('That invoice reference is not valid.'),
  reason: REASON,
})

/**
 * Refund part or all of a captured payment.
 *
 * Manager-only at BOTH layers: requireManager() here, and the
 * refunds_manager_write RLS policy (auth_is_manager) in the database. Neither
 * replaces the other.
 *
 * The client sends a payment id, an amount and a reason — never a tenant, an
 * actor, a payment total or a refunded figure. All of those are read from the
 * locked row and the authenticated context.
 */
export async function refundPayment(
  input: z.input<typeof refundInput>,
): Promise<ActionResult & { refundId?: string; fullyRefunded?: boolean }> {
  try {
    const ctx = await requireManager()
    const v = refundInput.parse(input)

    const result = await withUser(ctx.user.id, (tx) =>
      recordRefund(tx, { tenantId: ctx.tenant.id, membershipId: ctx.membershipId }, v),
    )

    revalidatePath(`/invoices/${result.invoiceId}`)
    if (result.bookingId) revalidatePath(`/pos/${result.bookingId}`)

    return { success: true, refundId: result.refundId, fullyRefunded: result.fullyRefunded }
  } catch (e) {
    return fail(e)
  }
}

/**
 * Void an invoice.
 *
 * Refuses while any captured payment on it is not fully refunded — and never
 * refunds anything itself, so the two financial decisions stay separate and
 * each keeps its own audit row.
 */
export async function voidInvoice(
  input: z.input<typeof voidInput>,
): Promise<ActionResult & { invoiceNumber?: string }> {
  try {
    const ctx = await requireManager()
    const v = voidInput.parse(input)

    const result = await withUser(ctx.user.id, (tx) =>
      voidInvoiceRecord(tx, { tenantId: ctx.tenant.id, membershipId: ctx.membershipId }, v),
    )

    revalidatePath(`/invoices/${result.invoiceId}`)
    if (result.bookingId) revalidatePath(`/pos/${result.bookingId}`)
    revalidatePath('/bookings')

    return { success: true, invoiceNumber: result.invoiceNumber }
  } catch (e) {
    return fail(e)
  }
}
