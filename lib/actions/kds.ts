'use server'

import { revalidatePath } from 'next/cache'
import { withUser } from '@/db'
import { requireContext, requireManager, AuthError } from '@/lib/auth/guard'
import { canFireCourse, canManageKitchen } from '@/lib/auth/roles'
import { KotError } from '@/lib/kots/service'
import {
  bumpKotCore,
  bumpKotItemCore,
  KDS_MODULE,
  fireCourseCore,
  getCourseConfigCore,
  recallKotCore,
  recallKotItemCore,
  releaseHeldLinesIfCoursesOff,
  saveKdsSettingsCore,
  type KdsResult,
} from '@/lib/kots/kds'
import { requireEntitlement, EntitlementError } from '@/lib/platform/entitlement-guard'
import { enqueueKitchenTicketsForOrderBestEffort } from '@/lib/printing/jobs'
import { sendOrderReadyNotification } from '@/lib/notifications/service'

type Result = { error?: string }

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
/** `station` scopes the bump to one station's lines (a station screen's
 *  "Bump ticket"); omit for the whole ticket. `{ id: null }` = unrouted lines. */
export async function bumpKot(kotId: string, station?: { id: string | null }): Promise<Result> {
  return kdsAction((tx, a) => bumpKotCore(tx, a, kotId, station))
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
  stationsEnabled: boolean
}): Promise<Result> {
  try {
    const ctx = await requireManager()
    await requireEntitlement(ctx, KDS_MODULE)
    if (ctx.tenant.industry !== 'restaurant') throw new AuthError('The kitchen display is for restaurant venues.')
    await withUser(ctx.user.id, (tx) => saveKdsSettingsCore(tx, ctx.tenant.id, v, ctx.membershipId))
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
    await withUser(ctx.user.id, async (tx) => {
      const lineIds = await fireCourseCore(tx, orderId, course)
      // Kitchen paper for exactly the lines just fired (no-op without a printer).
      await enqueueKitchenTicketsForOrderBestEffort(tx, ctx.tenant.id, orderId, 'fire', ctx.membershipId, lineIds)
    })
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
    const cfg = await withUser(ctx.user.id, async (tx) => {
      const c = await getCourseConfigCore(tx, ctx.tenant.id)
      // Courses can't run (flags off, or the plan lost the KDS): free any line
      // still held so it cooks and bills, rather than strand it. Best-effort.
      if (!c.enabled) await releaseHeldLinesIfCoursesOff(tx, ctx.tenant.id, { membershipId: ctx.membershipId })
      return c
    })
    return cfg.enabled ? cfg.names : null
  } catch {
    return null
  }
}
