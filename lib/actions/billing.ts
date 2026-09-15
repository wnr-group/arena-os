'use server'

import { revalidatePath } from 'next/cache'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { withUser } from '@/db'
import { bookings } from '@/db/schema'
import { requireContext, AuthError } from '@/lib/auth/guard'
import { canBill } from '@/lib/auth/roles'
import { BillingError, issueInvoiceForBooking, loadBillLines } from '@/lib/billing/invoice'
import { resolveMembershipBenefit } from '@/lib/billing/membership-benefit'
import { priceBill } from '@/lib/billing/pricing'
import {
  issueSplitBillForBooking,
  loadSeatByOrderItemId,
  previewSplitChecks,
  type CheckPricing,
  type SplitInput,
} from '@/lib/billing/split'
import { zodErrorMessage } from '@/lib/utils/errors'

type CreateInvoiceResult = { error?: string; invoiceId?: string; invoiceNumber?: string }

/**
 * Errors a cashier is allowed to read. Anything else is a bug or a driver
 * error, and its text must not reach the till — the same shape as
 * lib/actions/bookings.ts:fail().
 */
function fail(e: unknown): CreateInvoiceResult {
  if (e instanceof AuthError || e instanceof BillingError) return { error: e.message }
  if (e instanceof z.ZodError) return { error: zodErrorMessage(e) }
  // 23505 = unique_violation on (tenant_id, invoice_number): a number collided
  // despite the atomic counter. Retrying is safe, so say so rather than leaking.
  if (e && typeof e === 'object' && 'code' in e && (e as { code?: string }).code === '23505') {
    return { error: 'That bill was just raised by someone else. Refresh and try again.' }
  }
  console.error('[billing] createInvoiceForBooking failed:', e)
  return { error: 'Could not raise the bill. Please try again.' }
}

const createInvoiceInput = z.object({
  bookingId: z.string().uuid(),
  // Non-negative and finite. priceBill caps it at the subtotal as well, so a
  // discount can never produce a negative total even if this were bypassed.
  discount: z.coerce.number().min(0, 'Discount cannot be negative.').finite().optional(),
  promoCode: z.string().trim().max(64).optional(),
  // Only a COUNT of loyalty points. The rupee value, the cap against what is
  // still owed, and the ledger debit are all decided server-side from the
  // tenant's rule and the customer's balance — never from the browser.
  redeemPoints: z.coerce
    .number()
    .int('Points must be a whole number.')
    .nonnegative('Points cannot be negative.')
    .finite()
    .optional(),
})

/**
 * Raise the invoice for a booking.
 *
 * The browser sends a booking id and (at most) a discount and promo code —
 * never prices, quantities, tax rates or totals. Every line and every rupee is
 * re-read from the database inside the transaction and recomputed by priceBill.
 */
export async function createInvoiceForBooking(
  input: z.input<typeof createInvoiceInput>,
): Promise<CreateInvoiceResult> {
  try {
    const ctx = await requireContext()
    if (!canBill(ctx.role)) {
      throw new AuthError('You do not have permission to raise a bill.')
    }
    const v = createInvoiceInput.parse(input)

    const issued = await withUser(ctx.user.id, (tx) =>
      issueInvoiceForBooking(tx, { id: ctx.tenant.id, timezone: ctx.tenant.timezone }, v),
    )

    revalidatePath('/bookings')
    return { invoiceId: issued.invoiceId, invoiceNumber: issued.invoiceNumber }
  } catch (e) {
    return fail(e)
  }
}

/**
 * Split-bill (M18 #2). One flat schema covers all three modes — `checkCount`
 * and `assignments` are validated per-mode inside lib/billing/split.ts's
 * resolveBuckets(), which already refuses a missing/invalid checkCount or an
 * unassigned line with a cashier-safe message, so this schema only checks
 * shape (never re-validates business rules the service layer already owns).
 */
const splitBillInput = z.object({
  bookingId: z.string().uuid(),
  mode: z.enum(['even', 'seat', 'item']),
  checkCount: z.coerce.number().int().min(2).max(20).optional(),
  // order_items.id (sourceId) → 0-based check index, 'item' mode only.
  assignments: z.record(z.string().uuid(), z.coerce.number().int().min(0)).optional(),
})

function toSplitInput(v: z.infer<typeof splitBillInput>): SplitInput {
  if (v.mode === 'even') return { mode: 'even', checkCount: v.checkCount ?? 0 }
  if (v.mode === 'seat') return { mode: 'seat' }
  return { mode: 'item', checkCount: v.checkCount ?? 0, assignments: v.assignments ?? {} }
}

type PreviewSplitResult = { error?: string; checks?: CheckPricing[] }

/**
 * Read-only preview of a split, for the dialog to show before committing.
 * Deliberately does NOT take the booking row lock issueSplitBill's real
 * commit does — a cashier flipping between "even 2-way" and "even 3-way" to
 * compare must never block a concurrent real bill on this same booking. May
 * therefore be a moment stale (an order placed mid-preview); the actual
 * commit re-reads and re-locks everything fresh, exactly like
 * createInvoiceForBooking's preview/commit split already works today.
 */
export async function previewSplitBill(input: z.input<typeof splitBillInput>): Promise<PreviewSplitResult> {
  try {
    const ctx = await requireContext()
    if (!canBill(ctx.role)) {
      throw new AuthError('You do not have permission to raise a bill.')
    }
    const v = splitBillInput.parse(input)
    const splitInput = toSplitInput(v)

    const checks = await withUser(ctx.user.id, async (tx) => {
      const lines = await loadBillLines(tx, ctx.tenant.id, v.bookingId, ctx.tenant.timezone)
      if (lines.length === 0) throw new BillingError('This booking has nothing to bill.')
      const gross = priceBill({ lines })

      const [booking] = await tx
        .select({ customerId: bookings.customerId })
        .from(bookings)
        .where(and(eq(bookings.id, v.bookingId), eq(bookings.tenantId, ctx.tenant.id)))
        .limit(1)
      if (!booking) throw new BillingError('Booking not found.')

      const membership = await resolveMembershipBenefit(tx, ctx.tenant.id, booking.customerId, gross.subtotal)
      const seatByOrderItemId =
        splitInput.mode === 'seat' ? await loadSeatByOrderItemId(tx, ctx.tenant.id, v.bookingId) : new Map()

      return previewSplitChecks(gross, membership?.discountAmount ?? 0, seatByOrderItemId, splitInput)
    })

    return { checks }
  } catch (e) {
    return fail(e)
  }
}

type IssueSplitResult = { error?: string; billGroupId?: string; checkCount?: number }

/**
 * Commit a split bill: N invoices sharing one bill_group_id, each settled
 * independently afterward through the existing payments flow. See
 * lib/billing/split.ts's issueSplitBillForBooking for the transactional core
 * and lib/billing/data.ts's getBillableForBooking for how the POS bill
 * screen then renders every check.
 */
export async function issueSplitBill(input: z.input<typeof splitBillInput>): Promise<IssueSplitResult> {
  try {
    const ctx = await requireContext()
    if (!canBill(ctx.role)) {
      throw new AuthError('You do not have permission to raise a bill.')
    }
    const v = splitBillInput.parse(input)
    const splitInput = toSplitInput(v)

    const result = await withUser(ctx.user.id, (tx) =>
      issueSplitBillForBooking(tx, { id: ctx.tenant.id, timezone: ctx.tenant.timezone }, { bookingId: v.bookingId, ...splitInput }),
    )

    revalidatePath('/bookings')
    revalidatePath('/floor')
    return { billGroupId: result.billGroupId, checkCount: result.checks.length }
  } catch (e) {
    return fail(e)
  }
}
