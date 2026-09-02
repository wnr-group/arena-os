'use server'

import { revalidatePath } from 'next/cache'
import { withUser } from '@/db'
import { requireContext, AuthError } from '@/lib/auth/guard'
import { canManageKitchen } from '@/lib/auth/roles'
import { KotError, updateKotStatusCore, type KotStatus } from '@/lib/kots/service'
import { sendOrderReadyNotification } from '@/lib/notifications/service'

type Result = { error?: string }

function fail(e: unknown): Result {
  if (e instanceof AuthError || e instanceof KotError) return { error: e.message }
  return { error: e instanceof Error ? e.message : 'Something went wrong.' }
}

/** Advance (or cancel) a kitchen ticket. Kitchen staff, managers and owners only — matches the kots_update RLS policy. */
export async function updateKotStatus(kotId: string, newStatus: KotStatus): Promise<Result> {
  try {
    const ctx = await requireContext()
    if (!canManageKitchen(ctx.role)) {
      throw new AuthError('Only kitchen staff, managers and owners can update tickets.')
    }

    const order = await withUser(ctx.user.id, (tx) =>
      updateKotStatusCore(tx, { tenantId: ctx.tenant.id }, kotId, newStatus),
    )

    // Best-effort, in its own transaction, AFTER the status update above has
    // committed — never let a notification hiccup fail (or delay) marking
    // food ready. See lib/notifications/service.ts's own doc comment for why
    // this must not share a transaction with the row-locking update.
    if (newStatus === 'ready') {
      try {
        await withUser(ctx.user.id, (tx) => sendOrderReadyNotification(tx, { tenantId: ctx.tenant.id }, order))
      } catch (e) {
        console.error('[kots] order-ready notification failed:', e instanceof Error ? e.message : e)
      }
    }

    revalidatePath('/kitchen')
    return {}
  } catch (e) {
    return fail(e)
  }
}
