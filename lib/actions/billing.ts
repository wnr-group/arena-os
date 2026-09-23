'use server'

import { revalidatePath } from 'next/cache'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { withUser } from '@/db'
import { bookings } from '@/db/schema'
import { requireContext, AuthError } from '@/lib/auth/guard'
import { canBill, canBillBooking, isManager, type MemberRole } from '@/lib/auth/roles'
import { previewPromoForBooking } from '@/lib/billing/data'
import { BillingError, issueInvoiceForBooking, loadBillLines } from '@/lib/billing/invoice'
import { BookingError, loadBookingChannel, updateBookingHeadCountCore } from '@/lib/booking/service'
import { resolveMembershipBenefit } from '@/lib/billing/membership-benefit'
import { computeServiceCharge, priceBill } from '@/lib/billing/pricing'
import { loadServiceChargeConfig } from '@/lib/settings/business-profile'
import {
  issueSplitBillForBooking,
  loadSeatByOrderItemId,
  previewSplitChecks,
  type CheckPricing,
  type SplitInput,
} from '@/lib/billing/split'
import { zodErrorMessage } from '@/lib/utils/errors'

type CreateInvoiceResult = { error?: string; invoiceId?: string; invoiceNumber?: string }

/** What a code is worth on this bill, or why it cannot be used. */
export type PromoPreviewResult = { error?: string; code?: string; discount?: number }

/**
 * Errors a cashier is allowed to read. Anything else is a bug or a driver
 * error, and its text must not reach the till — the same shape as
 * lib/actions/bookings.ts:fail().
 */
function fail(e: unknown): CreateInvoiceResult {
  if (e instanceof AuthError || e instanceof BillingError || e instanceof BookingError) return { error: e.message }
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
  // Bill-level comp/discount (M18 #5) — gated below, restaurant + manager
  // only. priceBill/issueInvoiceForBooking still cap it at the subtotal even
  // if this were bypassed, same belt-and-braces as `discount` above.
  compAmount: z.coerce.number().min(0, 'Comp amount cannot be negative.').finite().optional(),
  compReason: z.string().trim().max(500).optional(),
})

const previewPromoInput = z.object({
  bookingId: z.string().uuid(),
  promoCode: z.string().trim().min(1, 'Enter a promo code.').max(64),
})

/**
 * Price a promo code against a booking WITHOUT raising the bill.
 *
 * The bill screen needs the rupee figure to show the cashier before they
 * commit, and only the server can know it — the discount and its type live in
 * the promo_codes row, and a percentage is a percentage of a subtotal that is
 * itself re-read from the database. Nothing but the booking id and the typed
 * code travels.
 *
 * Takes no use and writes nothing: validatePromo() is pure, so a cashier may
 * preview the same code as often as they like. The use is consumed only by
 * createInvoiceForBooking(), which re-validates from scratch — this preview is
 * never trusted as an input to it.
 */
export async function previewPromoCodeForBooking(
  input: z.input<typeof previewPromoInput>,
): Promise<PromoPreviewResult> {
  try {
    const ctx = await requireContext()
    const v = previewPromoInput.parse(input)

    // Same gate as raising the bill: previewing a code reveals what it is
    // worth, so it is for the people who are allowed to apply it —
    // including canBillBooking's walk-in exception (see its own doc
    // comment), resolved from a trusted, server-side read of the channel,
    // never the client. A booking that doesn't exist (channel null) is left
    // to previewPromoForBooking's own "Booking not found" below, rather than
    // reported as a permission error here.
    const channel = await withUser(ctx.user.id, (tx) => loadBookingChannel(tx, ctx.tenant.id, v.bookingId))
    if (channel !== null && !canBillBooking(ctx.role, channel)) {
      throw new AuthError('You do not have permission to raise a bill.')
    }

    const promo = await previewPromoForBooking(ctx, v.bookingId, v.promoCode)
    // The reason is the cashier-readable text validatePromo() already produces
    // ("Promo code has expired."), the same words the bill would fail with.
    if (!promo.ok) return { error: promo.reason }
    return { code: promo.code, discount: promo.discount }
  } catch (e) {
    return { error: fail(e).error }
  }
}

/**
 * Bill-level comp/discount (M18 #5) — shared gate for both the unsplit and
 * split-bill actions below. Restaurant tenants only, manager/owner only (no
 * "cashier + override" flow exists in this codebase — see the manager
 * acting in their OWN session, same precedent as refundPayment/voidInvoice
 * in lib/actions/refunds.ts), and a reason is mandatory whenever an amount
 * is actually given. Returns undefined for an ordinary bill with no comp,
 * so every other tenant/role is entirely unaffected.
 */
function resolveCompInput(
  ctx: { tenant: { industry: string }; role: MemberRole | null; membershipId: string },
  compAmount: number | undefined,
  compReason: string | undefined,
): { amount: number; reason: string; membershipId: string } | undefined {
  if (!compAmount || compAmount <= 0) return undefined
  if (ctx.tenant.industry !== 'restaurant') {
    throw new AuthError('Bill comps are only available for restaurant tenants.')
  }
  if (!isManager(ctx.role)) {
    throw new AuthError('Only owners and managers can comp or discount a bill.')
  }
  if (!compReason || compReason.trim() === '') {
    throw new BillingError('A reason is required to comp or discount a bill.')
  }
  return { amount: compAmount, reason: compReason.trim(), membershipId: ctx.membershipId }
}

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
    const v = createInvoiceInput.parse(input)
    const comp = resolveCompInput(ctx, v.compAmount, v.compReason)

    const issued = await withUser(ctx.user.id, async (tx) => {
      // Gated on the booking's OWN channel, resolved fresh inside this same
      // transaction (never trusted from the client) — canBillBooking's
      // walk-in exception (see its own doc comment) is why this can no
      // longer be a flat canBill(ctx.role) check up front. A booking that
      // doesn't exist (channel null) is left to issueInvoiceForBooking's own
      // "Booking not found" below, rather than reported as a permission
      // error here.
      const channel = await loadBookingChannel(tx, ctx.tenant.id, v.bookingId)
      if (channel !== null && !canBillBooking(ctx.role, channel)) {
        throw new AuthError('You do not have permission to raise a bill.')
      }
      return issueInvoiceForBooking(tx, { id: ctx.tenant.id, timezone: ctx.tenant.timezone }, { ...v, comp })
    })

    revalidatePath('/bookings')
    return { invoiceId: issued.invoiceId, invoiceNumber: issued.invoiceNumber }
  } catch (e) {
    return fail(e)
  }
}

const updateHeadCountInput = z.object({
  bookingId: z.string().uuid(),
  headCount: z.coerce.number().int().min(1, 'Enter at least 1 player.'),
})

type UpdateHeadCountResult = { error?: string; headCount?: number }

/**
 * Edit a per-head (reserved) booking's player count from the POS bill screen
 * (M21 per-head #4) — re-prices the whole session, since loadBookingLines
 * (lib/billing/invoice.ts) recomputes qty (hours × head_count) from
 * booking_slots on every read. Same gate as raising the bill itself: this
 * changes what the bill will charge, so it's for the people allowed to
 * charge it. updateBookingHeadCountCore refuses once a bill already exists —
 * pricing is frozen with it, same as every other pre-bill-only edit.
 */
export async function updateBookingHeadCount(
  input: z.input<typeof updateHeadCountInput>,
): Promise<UpdateHeadCountResult> {
  try {
    const ctx = await requireContext()
    if (!canBill(ctx.role)) {
      throw new AuthError('You do not have permission to raise a bill.')
    }
    const v = updateHeadCountInput.parse(input)
    const result = await withUser(ctx.user.id, (tx) =>
      updateBookingHeadCountCore(tx, { tenantId: ctx.tenant.id }, v),
    )
    revalidatePath(`/pos/${v.bookingId}`)
    return { headCount: result.headCount }
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
  // Bill-level comp/discount (M18 #5) — see resolveCompInput above. Applied
  // to the whole bill BEFORE splitting, same as the membership discount.
  compAmount: z.coerce.number().min(0, 'Comp amount cannot be negative.').finite().optional(),
  compReason: z.string().trim().max(500).optional(),
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
    if (ctx.tenant.industry !== 'restaurant') {
      throw new AuthError('Splitting a bill is only available for restaurant tenants.')
    }
    if (!canBill(ctx.role)) {
      throw new AuthError('You do not have permission to raise a bill.')
    }
    const v = splitBillInput.parse(input)
    const splitInput = toSplitInput(v)
    const comp = resolveCompInput(ctx, v.compAmount, v.compReason)

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
      const serviceChargeConfig = await loadServiceChargeConfig(tx, ctx.tenant.id)
      const serviceCharge = computeServiceCharge(gross.subtotal, serviceChargeConfig)
      const seatByOrderItemId =
        splitInput.mode === 'seat' ? await loadSeatByOrderItemId(tx, ctx.tenant.id, v.bookingId) : new Map()

      return previewSplitChecks(
        gross,
        membership?.discountAmount ?? 0,
        serviceCharge,
        seatByOrderItemId,
        splitInput,
        comp?.amount ?? 0,
      )
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
    if (ctx.tenant.industry !== 'restaurant') {
      throw new AuthError('Splitting a bill is only available for restaurant tenants.')
    }
    if (!canBill(ctx.role)) {
      throw new AuthError('You do not have permission to raise a bill.')
    }
    const v = splitBillInput.parse(input)
    const splitInput = toSplitInput(v)
    const comp = resolveCompInput(ctx, v.compAmount, v.compReason)

    const result = await withUser(ctx.user.id, (tx) =>
      issueSplitBillForBooking(
        tx,
        { id: ctx.tenant.id, timezone: ctx.tenant.timezone },
        { bookingId: v.bookingId, comp, ...splitInput },
      ),
    )

    revalidatePath('/bookings')
    revalidatePath('/floor')
    return { billGroupId: result.billGroupId, checkCount: result.checks.length }
  } catch (e) {
    return fail(e)
  }
}
