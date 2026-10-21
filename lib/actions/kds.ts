'use server'

import { revalidatePath } from 'next/cache'
import { withUser } from '@/db'
import { requireContext, requireManager, AuthError } from '@/lib/auth/guard'
import { canFireCourse, canManageKitchen } from '@/lib/auth/roles'
import { KotError } from '@/lib/kots/service'
import {
  bumpKotCore,
  bumpKotItemCore,
  fireCourseCore,
  getCourseConfigCore,
  recallKotCore,
  recallKotItemCore,
  saveKdsSettingsCore,
  type KdsResult,
} from '@/lib/kots/kds'
import { requireEntitlement, EntitlementError } from '@/lib/platform/entitlement-guard'
import { sendOrderReadyNotification } from '@/lib/notifications/service'

type Result = { error?: string }

const KDS_MODULE = 'module.kitchen_display'

function fail(e: unknown): Result {
  if (e instanceof AuthError || e instanceof KotError || e instanceof EntitlementError) return { error: e.message }
  return { error: e instanceof Error ? e.message : 'Something went wrong.' }
}

/** Shared by the four bump/recall actions: kitchen roles only (matches the
 *  kot_items RLS policies), plan must include the KDS, then run `fn`. */
async function kdsAction(fn: (tx: Parameters<Parameters<typeof withUser>[1]>[0], actor: { tenantId: string; membershipId: string }) => Promise<KdsResult>): Promise<Result> {
  try {
    const ctx = await requireContext()
    if (!canManageKitchen(ctx.role)) {
      throw new AuthError('Only kitchen staff, managers and owners can bump tickets.')
    }
    if (ctx.tenant.industry !== 'restaurant') throw new AuthError('The kitchen display is for restaurant venues.')
    await requireEntitlement(ctx, KDS_MODULE)

    const r = await withUser(ctx.user.id, (tx) => fn(tx, { tenantId: ctx.tenant.id, membershipId: ctx.membershipId }))

    // Best-effort, after the bump has committed — same rule as updateKotStatus.
    if (r.becameReady) {
      try {
        await withUser(ctx.user.id, (tx) => sendOrderReadyNotification(tx, { tenantId: ctx.tenant.id }, r))
      } catch (e) {
        console.error('[kds] order-ready notification failed:', e instanceof Error ? e.message : e)
      }
    }
    revalidatePath('/kitchen')
    return {}
  } catch (e) {
    return fail(e)
  }
}

export async function bumpKotItem(kotId: string, orderItemId: string): Promise<Result> {
  return kdsAction((tx, a) => bumpKotItemCore(tx, a, kotId, orderItemId))
}
export async function recallKotItem(kotId: string, orderItemId: string): Promise<Result> {
  return kdsAction((tx, a) => recallKotItemCore(tx, a, kotId, orderItemId))
}
export async function bumpKot(kotId: string): Promise<Result> {
  return kdsAction((tx, a) => bumpKotCore(tx, a, kotId))
}
export async function recallKot(kotId: string): Promise<Result> {
  return kdsAction((tx, a) => recallKotCore(tx, a, kotId))
}

/** Turn the KDS on/off and set its timer thresholds — manager/owner only. */
export async function saveKdsSettings(v: {
  enabled: boolean
  warnMinutes: number
  lateMinutes: number
  coursesEnabled: boolean
  courseNames: string[]
}): Promise<Result> {
  try {
    const ctx = await requireManager()
    await requireEntitlement(ctx, KDS_MODULE)
    if (ctx.tenant.industry !== 'restaurant') throw new AuthError('The kitchen display is for restaurant venues.')
    await withUser(ctx.user.id, (tx) => saveKdsSettingsCore(tx, ctx.tenant.id, v))
    revalidatePath('/kitchen')
    return {}
  } catch (e) {
    return fail(e)
  }
}

/**
 * Fire a held course for an order — the waiter's "ready for mains" tap, also
 * offered on the KDS. Front-of-house + kitchen roles (fire_order_course
 * re-checks the role in SQL, so this gate is convenience, not the lock).
 */
export async function fireCourse(orderId: string, course: number): Promise<Result> {
  try {
    const ctx = await requireContext()
    if (!canFireCourse(ctx.role)) throw new AuthError('You are not allowed to fire courses.')
    if (ctx.tenant.industry !== 'restaurant') throw new AuthError('Course firing is for restaurant venues.')
    await requireEntitlement(ctx, KDS_MODULE)
    await withUser(ctx.user.id, (tx) => fireCourseCore(tx, orderId, course))
    revalidatePath('/kitchen')
    revalidatePath('/bookings')
    revalidatePath('/floor')
    return {}
  } catch (e) {
    return fail(e)
  }
}

/** For the waiter's order dialog: the course names to offer, or null when the
 *  venue doesn't use courses (the dialog then shows no course controls). */
export async function getCourseOptions(): Promise<string[] | null> {
  try {
    const ctx = await requireContext()
    if (ctx.tenant.industry !== 'restaurant') return null
    const cfg = await withUser(ctx.user.id, (tx) => getCourseConfigCore(tx, ctx.tenant.id))
    return cfg.enabled ? cfg.names : null
  } catch {
    return null
  }
}
