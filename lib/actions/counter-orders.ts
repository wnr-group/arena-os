'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { withUser } from '@/db'
import { requireContext, AuthError } from '@/lib/auth/guard'
import { canManageWalkins } from '@/lib/auth/roles'
import { POS_PAYMENT_METHODS, PaymentError } from '@/lib/billing/payments'
import { BillingError } from '@/lib/billing/invoice'
import { EntitlementError } from '@/lib/platform/entitlement-guard'
import { CustomerError, findCustomerByRawPhone } from '@/lib/customers/service'
import { getMembershipBenefits } from '@/lib/memberships/customer-memberships'
import { OrderError, MAX_SEAT_NO } from '@/lib/orders/service'
import { createCounterOrderCore, previewCounterOrderCore, CounterPreviewResult, type CounterOrderResult, type CounterPreview } from '@/lib/orders/counter'
import { isValidPhone } from '@/lib/customers/phone'
import { zodErrorMessage, pgError } from '@/lib/utils/errors'

type Result = { error?: string }

function fail(e: unknown): { error: string } {
  if (
    e instanceof AuthError || e instanceof OrderError || e instanceof EntitlementError || e instanceof BillingError ||
    e instanceof PaymentError || e instanceof CustomerError
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
