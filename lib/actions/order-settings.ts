'use server'

import { revalidatePath } from 'next/cache'
import { withUser } from '@/db'
import { requireManager, AuthError } from '@/lib/auth/guard'
import { setAutoAcceptOnlineOrders } from '@/lib/orders/settings'

type Result = { error?: string }

/**
 * Toggle the tenant's auto-accept setting — manager/owner only, same gate as
 * every other per-tenant module toggle (see lib/actions/payment-settings.ts).
 * When on, placeOnlineOrder (lib/actions/public-orders.ts) skips the
 * accept/reject queue entirely for new online orders.
 */
export async function saveAutoAcceptOnlineOrders(value: boolean): Promise<Result> {
  try {
    const ctx = await requireManager()
    await withUser(ctx.user.id, (tx) => setAutoAcceptOnlineOrders(tx, ctx.tenant.id, value))
    revalidatePath('/orders/incoming')
    return {}
  } catch (e) {
    if (e instanceof AuthError) return { error: e.message }
    return { error: e instanceof Error ? e.message : 'Something went wrong.' }
  }
}
