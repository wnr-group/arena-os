'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { withUser } from '@/db'
import { requireContext, requireManager, AuthError } from '@/lib/auth/guard'
import { canManageWalkins } from '@/lib/auth/roles'
import { POS_PAYMENT_METHODS, PaymentError } from '@/lib/billing/payments'
import { BillingError } from '@/lib/billing/invoice'
import { EntitlementError } from '@/lib/platform/entitlement-guard'
import { CustomerError, findCustomerByRawPhone } from '@/lib/customers/service'
import { getMembershipBenefits } from '@/lib/memberships/customer-memberships'
import { OrderError, MAX_SEAT_NO } from '@/lib/orders/service'
import {
  createCounterOrderCore,
  editCounterOrderLineCore,
  previewCounterOrderCore,
  previewRebillCounterOrderCore,
  rebillCounterOrderCore,
  voidCounterSaleCore,
  CounterPreviewResult,
  type CounterOrderResult,
  type CounterPreview,
} from '@/lib/orders/counter'
import { loadCounterSaleDetail, type CounterSaleDetail } from '@/lib/orders/counter-data'
import { RefundError } from '@/lib/billing/refunds'
import { isValidPhone } from '@/lib/customers/phone'
import { zodErrorMessage, pgError } from '@/lib/utils/errors'

type Result = { error?: string }

function fail(e: unknown): { error: string } {
  if (
    e instanceof AuthError || e instanceof OrderError || e instanceof EntitlementError || e instanceof BillingError ||
    e instanceof PaymentError || e instanceof CustomerError || e instanceof RefundError
  ) {
    return { error: e.message }
  }
  if (e instanceof z.ZodError) return { error: zodErrorMessage(e) }
  return { error: e instanceof Error ? e.message : 'Something went wrong.' }
}

const createInput = z.object({
  branchId: z.string().uuid(),
  customerPhone: z.string().trim().refine((v) => isValidPhone(v), 'Enter a valid 10-digit phone number.'),
  customerName: z.string().trim().max(80).optional(),
  method: z.enum(POS_PAYMENT_METHODS, { errorMap: () => ({ message: 'Choose cash, card or UPI.' }) }),
  promoCode: z.string().trim().max(64).optional(),
  cashTendered: z.coerce.number().finite().min(0).max(99_999_999.99).optional(),
  // 110 so the `counter:` payment-key prefix stays inside the payments column limit.
  idempotencyKey: z.string().trim().min(8).max(110),
  items: z
    .array(
      z.object({
        menuItemId: z.string().uuid(),
        qty: z.coerce.number().int().min(1).max(999),
        specialInstructions: z.string().trim().max(300).optional(),
        modifierOptionIds: z.array(z.string().uuid()).optional(),
        seatNo: z.coerce.number().int().min(1).max(MAX_SEAT_NO).optional(),
      }),
    )
    .min(1, 'Add at least one item'),
})

/**
 * Take a counter sale for a non-restaurant venue: order → kitchen → invoice →
 * payment in one transaction. Role, venue type and plan are all enforced inside
 * createCounterOrderCore as well; the early role check here just fails fast.
 */
export async function createCounterOrder(input: z.input<typeof createInput>): Promise<Result & { sale?: CounterOrderResult }> {
  try {
    const ctx = await requireContext()
    if (!canManageWalkins(ctx.role)) throw new AuthError('You don’t have permission to take counter sales.')
    const v = createInput.parse(input)
    const run = () =>
      withUser(ctx.user.id, (tx) =>
        createCounterOrderCore(tx, { tenantId: ctx.tenant.id, timezone: ctx.tenant.timezone, membershipId: ctx.membershipId, role: ctx.role }, v),
      )
    let sale: CounterOrderResult
    try {
      sale = await run()
    } catch (e) {
      // A double-tap that slipped past the advisory lock (it can't, but the unique
      // indexes are the backstop): the winner has committed, so replay it.
      const { code } = pgError(e)
      if (code !== '23505') throw e
      sale = await run()
    }
    revalidatePath('/bookings')
    revalidatePath('/kitchen')
    return { sale }
  } catch (e) {
    return fail(e)
  }
}

const previewInput = createInput.pick({ branchId: true, customerPhone: true, promoCode: true, items: true })

/**
 * The server-computed bill (membership + promo, GST) for the dialog to show
 * before payment. Writes nothing: the core rolls its own transaction back.
 */
export async function previewCounterOrder(input: z.input<typeof previewInput>): Promise<Result & { preview?: CounterPreview }> {
  try {
    const ctx = await requireContext()
    if (!canManageWalkins(ctx.role)) throw new AuthError('You don’t have permission to take counter sales.')
    const v = previewInput.parse(input)
    try {
      await withUser(ctx.user.id, (tx) =>
        previewCounterOrderCore(tx, { tenantId: ctx.tenant.id, timezone: ctx.tenant.timezone, membershipId: ctx.membershipId, role: ctx.role }, v),
      )
    } catch (e) {
      if (e instanceof CounterPreviewResult) return { preview: e.preview }
      throw e
    }
    return { error: 'Could not price this order.' }
  } catch (e) {
    return fail(e)
  }
}

/**
 * Fill the dialog from the phone number: the customer's name and, if they hold a
 * live membership, its plan name. Display only — the sale itself re-resolves the
 * customer and membership from the phone on the server.
 */
export async function lookupCounterCustomer(phone: string): Promise<Result & { found?: boolean; name?: string | null; membershipPlan?: string | null }> {
  try {
    const ctx = await requireContext()
    if (ctx.tenant.industry === 'restaurant' || !canManageWalkins(ctx.role)) throw new AuthError('You don’t have permission to take counter sales.')
    const p = z.string().trim().parse(phone)
    if (!isValidPhone(p)) return { found: false }
    return await withUser(ctx.user.id, async (tx) => {
      const c = await findCustomerByRawPhone(tx, ctx.tenant.id, p)
      if (!c) return { found: false }
      const m = await getMembershipBenefits(tx, ctx.tenant.id, c.id, new Date())
      return { found: true, name: c.name, membershipPlan: m?.membership.planName ?? null }
    })
  } catch (e) {
    return fail(e)
  }
}

// ── corrections (M41 ticket 4) ───────────────────────────────────────────────

const orderIdInput = z.object({ orderId: z.string().uuid() })

/** Everything the Correct dialog shows for one counter sale. */
export async function getCounterSaleDetail(orderId: string): Promise<Result & { detail?: CounterSaleDetail }> {
  try {
    const ctx = await requireContext()
    if (!canManageWalkins(ctx.role)) throw new AuthError('You don’t have permission to change counter sales.')
    const v = orderIdInput.parse({ orderId })
    const detail = await loadCounterSaleDetail(ctx, v.orderId)
    if (!detail) throw new OrderError('Counter sale not found.')
    return { detail }
  } catch (e) {
    return fail(e)
  }
}

const voidInput = orderIdInput.extend({ reason: z.string().trim().min(1, 'A reason is required.').max(500) })

/**
 * Refund the payment(s) in full and void the invoice, atomically. Manager/owner
 * only — requireManager() here, the same check in the core, and the refunds RLS
 * policy underneath: three independent layers, as for booking bills.
 */
export async function voidCounterSale(input: z.input<typeof voidInput>): Promise<Result & { invoiceNumber?: string; refunded?: number }> {
  try {
    const ctx = await requireManager()
    const v = voidInput.parse(input)
    const r = await withUser(ctx.user.id, (tx) =>
      voidCounterSaleCore(tx, { tenantId: ctx.tenant.id, membershipId: ctx.membershipId, role: ctx.role }, v),
    )
    revalidatePath('/bookings')
    revalidatePath('/kitchen')
    return { invoiceNumber: r.invoiceNumber, refunded: r.refunded }
  } catch (e) {
    return fail(e)
  }
}

const rebillPreviewInput = orderIdInput.extend({ promoCode: z.string().trim().max(64).optional() })

export async function previewRebillCounterSale(input: z.input<typeof rebillPreviewInput>): Promise<Result & { preview?: CounterPreview }> {
  try {
    const ctx = await requireContext()
    if (!canManageWalkins(ctx.role)) throw new AuthError('You don’t have permission to take counter sales.')
    const v = rebillPreviewInput.parse(input)
    try {
      await withUser(ctx.user.id, (tx) =>
        previewRebillCounterOrderCore(tx, { tenantId: ctx.tenant.id, timezone: ctx.tenant.timezone, membershipId: ctx.membershipId, role: ctx.role }, v),
      )
    } catch (e) {
      if (e instanceof CounterPreviewResult) return { preview: e.preview }
      throw e
    }
    return { error: 'Could not price this order.' }
  } catch (e) {
    return fail(e)
  }
}

const rebillInput = rebillPreviewInput.extend({
  method: z.enum(POS_PAYMENT_METHODS, { errorMap: () => ({ message: 'Choose cash, card or UPI.' }) }),
  cashTendered: z.coerce.number().finite().min(0).max(99_999_999.99).optional(),
  idempotencyKey: z.string().trim().min(8).max(110),
})

/** Bill a voided (unbilled) counter order again: fresh invoice number, new payment. */
export async function rebillCounterSale(input: z.input<typeof rebillInput>): Promise<Result & { sale?: CounterOrderResult }> {
  try {
    const ctx = await requireContext()
    if (!canManageWalkins(ctx.role)) throw new AuthError('You don’t have permission to take counter sales.')
    const v = rebillInput.parse(input)
    const sale = await withUser(ctx.user.id, (tx) =>
      rebillCounterOrderCore(tx, { tenantId: ctx.tenant.id, timezone: ctx.tenant.timezone, membershipId: ctx.membershipId, role: ctx.role }, v),
    )
    revalidatePath('/bookings')
    return { sale }
  } catch (e) {
    return fail(e)
  }
}

const editLineInput = z.object({ orderItemId: z.string().uuid(), newQty: z.coerce.number().int().min(0).max(999) })

/** Change a line's quantity (0 removes it) on an unbilled counter order. */
export async function editCounterOrderLine(input: z.input<typeof editLineInput>): Promise<Result & { removed?: boolean }> {
  try {
    const ctx = await requireContext()
    const v = editLineInput.parse(input)
    const r = await withUser(ctx.user.id, (tx) =>
      editCounterOrderLineCore(tx, { tenantId: ctx.tenant.id, membershipId: ctx.membershipId, role: ctx.role }, v),
    )
    revalidatePath('/bookings')
    revalidatePath('/kitchen')
    return { removed: r.removed }
  } catch (e) {
    return fail(e)
  }
}
