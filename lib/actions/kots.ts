'use server'

import { revalidatePath } from 'next/cache'
import { withUser } from '@/db'
import { requireContext, AuthError } from '@/lib/auth/guard'
import { canManageKitchen } from '@/lib/auth/roles'
import { KotError, updateKotStatusCore, type KotStatus } from '@/lib/kots/service'

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

    await withUser(ctx.user.id, (tx) => updateKotStatusCore(tx, { tenantId: ctx.tenant.id }, kotId, newStatus))

    revalidatePath('/kitchen')
    return {}
  } catch (e) {
    return fail(e)
  }
}
