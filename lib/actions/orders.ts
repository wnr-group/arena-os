'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { withUser } from '@/db'
import { requireContext, AuthError } from '@/lib/auth/guard'
import { canManageIncomingOrders } from '@/lib/auth/roles'
import {
  OrderError,
  createOrderCore,
  findOrderByIdempotencyKey,
  cancelOrderCore,
  acceptOrderCore,
  rejectOrderCore,
} from '@/lib/orders/service'
import { zodErrorMessage, pgError } from '@/lib/utils/errors'

type CreateResult = { error?: string; orderId?: string; orderNumber?: string }
type Result = { error?: string }

function fail(e: unknown): { error: string } {
  if (e instanceof AuthError || e instanceof OrderError) return { error: e.message }
  if (e instanceof z.ZodError) return { error: zodErrorMessage(e) }
  return { error: e instanceof Error ? e.message : 'Something went wrong.' }
}

const createInput = z.object({
  branchId: z.string().uuid(),
  bookingId: z.string().uuid().optional(),
  /**
   * Idempotency (migration 0058) — generated once by TakeOrderDialog per
   * take-order attempt and reused verbatim on any retry of that SAME attempt
   * (a network retry, or an impatient double-tap on "Place order"). Lets
   * createOrderCore recognise a retry and hand back the original order
   * instead of creating — and cooking — a second one.
   */
  idempotencyKey: z.string().uuid(),
  items: z
    .array(
      z.object({
        menuItemId: z.string().uuid(),
        qty: z.coerce.number().int().min(1),
        specialInstructions: z.string().trim().optional(),
      }),
    )
    .min(1, 'Add at least one item'),
})

export async function createOrder(input: z.input<typeof createInput>): Promise<CreateResult> {
  try {
    const ctx = await requireContext()
    const v = createInput.parse(input)

    const result = await withUser(ctx.user.id, (tx) =>
      createOrderCore(
        tx,
        { tenantId: ctx.tenant.id, timezone: ctx.tenant.timezone, membershipId: ctx.membershipId },
        v,
      ),
    )

    revalidatePath('/bookings')
    revalidatePath('/kitchen')
    return { orderId: result.id, orderNumber: result.orderNumber }
  } catch (e) {
    // Idempotency race: two requests with the same key both passed
    // createOrderCore's own pre-check and collided on
    // orders_tenant_idempotency_key — that transaction is already aborted,
    // so re-fetch the winner's order in a fresh one and return THAT, instead
    // of surfacing a raw conflict to whichever request lost the race.
    const { code, constraint } = pgError(e)
    if (code === '23505' && constraint === 'orders_tenant_idempotency_key') {
      try {
        const ctx = await requireContext()
        const v = createInput.parse(input)
        const existing = await withUser(ctx.user.id, (tx) =>
          findOrderByIdempotencyKey(tx, ctx.tenant.id, v.idempotencyKey),
        )
        if (existing) {
          revalidatePath('/bookings')
          revalidatePath('/kitchen')
          return { orderId: existing.id, orderNumber: existing.orderNumber }
        }
      } catch {
        // Fall through to the generic failure below.
      }
    }
    return fail(e)
  }
}

/**
 * Cancel a still-open order. Also cancels its kitchen ticket (unless already
 * served) — see cancelOrderCore for why.
 */
export async function cancelOrder(orderId: string): Promise<Result> {
  try {
    const ctx = await requireContext()
    await withUser(ctx.user.id, (tx) => cancelOrderCore(tx, { tenantId: ctx.tenant.id }, orderId))
    revalidatePath('/bookings')
    revalidatePath('/kitchen')
    return {}
  } catch (e) {
    return fail(e)
  }
}

/**
 * Accept a pending online order — moves it into the normal kitchen flow (its
 * KOT starts showing up on /kitchen). Front-of-house roles only; kitchen
 * staff act once an order is already accepted, not before.
 */
export async function acceptOnlineOrder(orderId: string): Promise<Result> {
  try {
    const ctx = await requireContext()
    if (!canManageIncomingOrders(ctx.role)) {
      throw new AuthError('Only front-of-house staff, managers and owners can accept online orders.')
    }
    await withUser(ctx.user.id, (tx) => acceptOrderCore(tx, { tenantId: ctx.tenant.id }, orderId))
    revalidatePath('/orders/incoming')
    revalidatePath('/kitchen')
    return {}
  } catch (e) {
    return fail(e)
  }
}

/**
 * Reject a pending online order — cancels the order and its kitchen ticket,
 * recording why. Same role gate as acceptOnlineOrder.
 */
export async function rejectOnlineOrder(orderId: string, reason: string): Promise<Result> {
  try {
    const ctx = await requireContext()
    if (!canManageIncomingOrders(ctx.role)) {
      throw new AuthError('Only front-of-house staff, managers and owners can reject online orders.')
    }
    const trimmed = reason.trim()
    if (!trimmed) throw new OrderError('A reason is required to reject an order.')
    await withUser(ctx.user.id, (tx) => rejectOrderCore(tx, { tenantId: ctx.tenant.id }, orderId, trimmed))
    revalidatePath('/orders/incoming')
    revalidatePath('/kitchen')
    return {}
  } catch (e) {
    return fail(e)
  }
}
