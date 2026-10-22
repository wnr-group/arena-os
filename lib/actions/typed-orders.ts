'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { withUser } from '@/db'
import { requireContext, requireManager, AuthError } from '@/lib/auth/guard'
import { canManageWalkins } from '@/lib/auth/roles'
import { POS_PAYMENT_METHODS } from '@/lib/billing/payments'
import { BillingError } from '@/lib/billing/invoice'
import { PaymentError } from '@/lib/billing/payments'
import { EntitlementError, requireEntitlement } from '@/lib/platform/entitlement-guard'
import { OrderError, cancelOrderCore, findOrderByIdempotencyKey, MAX_SEAT_NO } from '@/lib/orders/service'
import {
  collectTypedOrderPaymentCore,
  createTypedOrderCore,
  handoverTypedOrderCore,
  saveTypedOrderSettingsCore,
} from '@/lib/orders/typed'
import { isValidPhone } from '@/lib/customers/phone'
import { zodErrorMessage, pgError } from '@/lib/utils/errors'

const MODULE = 'module.takeaway_delivery'

type Result = { error?: string }

function fail(e: unknown): { error: string } {
  if (e instanceof AuthError || e instanceof OrderError || e instanceof EntitlementError || e instanceof BillingError || e instanceof PaymentError) {
    return { error: e.message }
  }
  if (e instanceof z.ZodError) return { error: zodErrorMessage(e) }
  return { error: e instanceof Error ? e.message : 'Something went wrong.' }
}

/** Restaurant-only, plan-gated, front-of-house roles — enforced here, not by hiding the UI. */
async function requireStaff() {
  const ctx = await requireContext()
  if (ctx.tenant.industry !== 'restaurant') throw new AuthError('Takeaway and delivery are for restaurant venues.')
  if (!canManageWalkins(ctx.role)) throw new AuthError('You don’t have permission to manage takeaway and delivery orders.')
  await requireEntitlement(ctx, MODULE)
  return ctx
}

const phone = z
  .string()
  .trim()
  .optional()
  .refine((v) => !v || isValidPhone(v), 'Enter a valid 10-digit phone number.')

const createInput = z.object({
  branchId: z.string().uuid(),
  orderType: z.enum(['takeaway', 'delivery']),
  contactName: z.string().trim().min(1, 'Enter a name.').max(80),
  contactPhone: phone,
  pickupAt: z.string().datetime().optional(),
  deliveryAddress: z.string().trim().max(300).optional(),
  deliveryFee: z.coerce.number().min(0).max(100000).optional(),
  notes: z.string().trim().max(300).optional(),
  idempotencyKey: z.string().trim().min(8).max(128),
  items: z
    .array(
      z.object({
        menuItemId: z.string().uuid(),
        qty: z.coerce.number().int().min(1),
        specialInstructions: z.string().trim().optional(),
        modifierOptionIds: z.array(z.string().uuid()).optional(),
        seatNo: z.coerce.number().int().min(1).max(MAX_SEAT_NO).optional(),
      }),
    )
    .min(1, 'Add at least one item'),
})

/** Place a takeaway or delivery order (no table). Goes straight to the kitchen. */
export async function createTypedOrder(input: z.input<typeof createInput>): Promise<Result & { orderId?: string; orderNumber?: string }> {
  try {
    const ctx = await requireStaff()
    const v = createInput.parse(input)
    const result = await withUser(ctx.user.id, (tx) =>
      createTypedOrderCore(
        tx,
        { tenantId: ctx.tenant.id, timezone: ctx.tenant.timezone, membershipId: ctx.membershipId },
        { ...v, pickupAt: v.pickupAt ? new Date(v.pickupAt) : null },
      ),
    )
    revalidatePath('/orders/takeaway')
    revalidatePath('/kitchen')
    return { orderId: result.id, orderNumber: result.orderNumber }
  } catch (e) {
    // A double-tap that raced past the pre-check: hand back the winner's order.
    const { code, constraint } = pgError(e)
    if (code === '23505' && constraint === 'orders_tenant_idempotency_key') {
      try {
        const ctx = await requireStaff()
        const v = createInput.parse(input)
        const existing = await withUser(ctx.user.id, (tx) => findOrderByIdempotencyKey(tx, ctx.tenant.id, v.idempotencyKey))
        if (existing) return { orderId: existing.id, orderNumber: existing.orderNumber }
      } catch {
        // fall through
      }
    }
    return fail(e)
  }
}

const handoverInput = z.object({
  orderId: z.string().uuid(),
  to: z.enum(['out_for_delivery', 'collected', 'delivered']),
  driverName: z.string().trim().max(80).optional(),
  driverPhone: phone,
})

/** Collected / out for delivery / delivered — once the kitchen has finished the order. */
export async function handoverOrder(input: z.input<typeof handoverInput>): Promise<Result> {
  try {
    const ctx = await requireStaff()
    const v = handoverInput.parse(input)
    await withUser(ctx.user.id, (tx) => handoverTypedOrderCore(tx, { tenantId: ctx.tenant.id, membershipId: ctx.membershipId }, v))
    revalidatePath('/orders/takeaway')
    revalidatePath('/kitchen')
    return {}
  } catch (e) {
    return fail(e)
  }
}

const payInput = z.object({
  orderId: z.string().uuid(),
  method: z.enum(POS_PAYMENT_METHODS),
  tipAmount: z.coerce.number().min(0).max(100000).optional(),
  idempotencyKey: z.string().trim().min(8).max(128).optional(),
})

/** Take payment (cash / card / UPI) for a takeaway or delivery order — on collection, or up front. */
export async function collectOrderPayment(
  input: z.input<typeof payInput>,
): Promise<Result & { invoiceId?: string; invoiceNumber?: string; total?: number; alreadyPaid?: boolean }> {
  try {
    const ctx = await requireStaff()
    const v = payInput.parse(input)
    const r = await withUser(ctx.user.id, (tx) =>
      collectTypedOrderPaymentCore(tx, { tenantId: ctx.tenant.id, timezone: ctx.tenant.timezone, membershipId: ctx.membershipId }, v),
    )
    revalidatePath('/orders/takeaway')
    return { invoiceId: r.invoiceId, invoiceNumber: r.invoiceNumber, total: r.total, alreadyPaid: r.alreadyPaid }
  } catch (e) {
    return fail(e)
  }
}

/** Cancel an order that hasn't been billed; its kitchen ticket is cancelled with it. */
export async function cancelTypedOrder(orderId: string): Promise<Result> {
  try {
    const ctx = await requireStaff()
    const id = z.string().uuid().parse(orderId)
    await withUser(ctx.user.id, (tx) => cancelOrderCore(tx, { tenantId: ctx.tenant.id }, id))
    revalidatePath('/orders/takeaway')
    revalidatePath('/kitchen')
    return {}
  } catch (e) {
    return fail(e)
  }
}

const settingsInput = z.object({
  takeawayEnabled: z.boolean(),
  deliveryEnabled: z.boolean(),
  defaultDeliveryFee: z.coerce.number().finite(),
  deliveryFeeTaxRate: z.coerce.number().finite(),
})

/** Turn takeaway / delivery on, and set the default delivery fee + its GST — owner/manager. */
export async function saveTypedOrderSettings(input: z.input<typeof settingsInput>): Promise<Result> {
  try {
    const ctx = await requireManager()
    if (ctx.tenant.industry !== 'restaurant') throw new AuthError('Takeaway and delivery are for restaurant venues.')
    await requireEntitlement(ctx, MODULE)
    const v = settingsInput.parse(input)
    await withUser(ctx.user.id, (tx) => saveTypedOrderSettingsCore(tx, { tenantId: ctx.tenant.id, membershipId: ctx.membershipId }, v))
    revalidatePath('/settings/takeaway-delivery')
    revalidatePath('/orders/takeaway')
    return {}
  } catch (e) {
    return fail(e)
  }
}
