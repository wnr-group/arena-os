'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { withUser } from '@/db'
import { requireContext, requireManager, AuthError } from '@/lib/auth/guard'
import { canManageIncomingOrders } from '@/lib/auth/roles'
import {
  OrderError,
  createOrderCore,
  findOrderByIdempotencyKey,
  cancelOrderCore,
  acceptOrderCore,
  rejectOrderCore,
  requestVoidOrderItemCore,
  decideVoidRequestCore,
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
   * Idempotency (migration 0065) — generated once by TakeOrderDialog per
   * take-order attempt and reused verbatim on any retry of that SAME attempt
   * (a network retry, or an impatient double-tap on "Place order"). Lets
   * createOrderCore recognise a retry and hand back the original order
   * instead of creating — and cooking — a second one.
   */
  idempotencyKey: z.string().trim().min(8).max(128),
  items: z
    .array(
      z.object({
        menuItemId: z.string().uuid(),
        qty: z.coerce.number().int().min(1),
        specialInstructions: z.string().trim().optional(),
        // Structured choices (M17 #8) — see CreateOrderItemInput's doc
        // comment (lib/orders/service.ts) for what createOrderCore does
        // with these.
        modifierOptionIds: z.array(z.string().uuid()).optional(),
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

const requestVoidOrderItemInput = z.object({
  orderItemId: z.string().uuid(),
  mode: z.enum(['void', 'comp']),
  reason: z.string().trim().min(1, 'A reason is required.'),
})

type VoidRequestResultDTO = Result & { status?: 'pending' | 'approved' }

/**
 * Raise a void/comp request on one line of an open order — front-of-house
 * roles and up (same gate as accept/reject online orders); money actually
 * coming off the tab still requires a manager, but the REQUEST itself is a
 * waiter's job. See requestVoidOrderItemCore (lib/orders/service.ts): a
 * manager/owner raising their own request is applied immediately in the same
 * transaction, so `status` comes back 'approved' for them and 'pending' for
 * everyone else — decideVoidRequest below is what a manager then uses to
 * approve or reject someone else's.
 */
export async function requestVoidOrderItem(
  input: z.input<typeof requestVoidOrderItemInput>,
): Promise<VoidRequestResultDTO> {
  try {
    const ctx = await requireContext()
    if (ctx.tenant.industry !== 'restaurant') {
      throw new AuthError('Void/comp is only available for restaurant tenants.')
    }
    if (!canManageIncomingOrders(ctx.role)) {
      throw new AuthError('Only front-of-house staff, managers and owners can request a void or comp.')
    }
    const v = requestVoidOrderItemInput.parse(input)
    const result = await withUser(ctx.user.id, (tx) =>
      requestVoidOrderItemCore(tx, { tenantId: ctx.tenant.id, membershipId: ctx.membershipId, role: ctx.role }, v),
    )
    revalidatePath('/bookings')
    revalidatePath('/floor')
    if (result.status === 'approved') revalidatePath('/kitchen')
    else revalidatePath('/orders/void-requests')
    return { status: result.status }
  } catch (e) {
    return fail(e)
  }
}

const decideVoidRequestInput = z.object({
  requestId: z.string().uuid(),
  decision: z.enum(['approve', 'reject']),
  note: z.string().trim().optional(),
})

/**
 * Approve or reject a pending void/comp request — manager (or owner) only,
 * per lib/billing/refunds.ts's precedent that money coming off a tab is a
 * manager-gated, audited action, never a UI-only restriction. See
 * decideVoidRequestCore for what actually happens on approval: the line is
 * flagged, never deleted, excluded from billing, and reflected on the
 * kitchen ticket if that was the last active item on the order.
 */
export async function decideVoidRequest(input: z.input<typeof decideVoidRequestInput>): Promise<Result> {
  try {
    const ctx = await requireManager()
    if (ctx.tenant.industry !== 'restaurant') {
      throw new AuthError('Void/comp is only available for restaurant tenants.')
    }
    const v = decideVoidRequestInput.parse(input)
    await withUser(ctx.user.id, (tx) =>
      decideVoidRequestCore(tx, { tenantId: ctx.tenant.id, membershipId: ctx.membershipId }, v),
    )
    revalidatePath('/bookings')
    revalidatePath('/floor')
    revalidatePath('/kitchen')
    revalidatePath('/orders/void-requests')
    return {}
  } catch (e) {
    return fail(e)
  }
}
