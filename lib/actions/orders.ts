'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { withUser } from '@/db'
import { requireContext, AuthError } from '@/lib/auth/guard'
import { OrderError, createOrderCore, cancelOrderCore } from '@/lib/orders/service'
import { zodErrorMessage } from '@/lib/utils/errors'

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
