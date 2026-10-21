'use server'

import { revalidatePath } from 'next/cache'
import { and, eq, sql } from 'drizzle-orm'
import { withUser } from '@/db'
import { kitchenStations, menuCategories, menuItems } from '@/db/schema'
import { requireManager, AuthError } from '@/lib/auth/guard'
import { requireEntitlement, EntitlementError } from '@/lib/platform/entitlement-guard'
import { KotError } from '@/lib/kots/service'

type Result = { error?: string }

function fail(e: unknown): Result {
  if (e instanceof AuthError || e instanceof KotError || e instanceof EntitlementError) return { error: e.message }
  const code = (e as { cause?: { code?: string } }).cause?.code
  if (code === '23505') return { error: 'A station with that name already exists.' }
  console.error('[stations] action failed:', e)
  return { error: 'Something went wrong. Please try again.' }
}

/** Manager/owner of a restaurant on a plan that includes the kitchen display. */
async function guard() {
  const ctx = await requireManager()
  if (ctx.tenant.industry !== 'restaurant') throw new AuthError('Stations are for restaurant venues.')
  await requireEntitlement(ctx, 'module.kitchen_display')
  return ctx
}

function cleanName(name: string): string {
  const n = name.trim()
  if (n.length < 1 || n.length > 40) throw new KotError('Station names are 1 to 40 characters.')
  return n
}

function done(): Result {
  revalidatePath('/kitchen')
  revalidatePath('/kitchen/stations')
  return {}
}

export async function createStation(name: string): Promise<Result> {
  try {
    const ctx = await guard()
    const n = cleanName(name)
    await withUser(ctx.user.id, async (tx) => {
      const [{ next }] = await tx
        .select({ next: sql<number>`coalesce(max(${kitchenStations.sortOrder}), -1) + 1` })
        .from(kitchenStations)
        .where(eq(kitchenStations.tenantId, ctx.tenant.id))
      await tx.insert(kitchenStations).values({ tenantId: ctx.tenant.id, name: n, sortOrder: next })
    })
    return done()
  } catch (e) {
    return fail(e)
  }
}

export async function renameStation(id: string, name: string): Promise<Result> {
  try {
    const ctx = await guard()
    const n = cleanName(name)
    await withUser(ctx.user.id, (tx) =>
      tx.update(kitchenStations).set({ name: n }).where(and(eq(kitchenStations.id, id), eq(kitchenStations.tenantId, ctx.tenant.id))),
    )
    return done()
  } catch (e) {
    return fail(e)
  }
}

/** Deactivating hides the station from new routing; orders already in the
 *  kitchen keep their snapshot. Deleting un-routes any menu mapping (set null). */
export async function setStationActive(id: string, isActive: boolean): Promise<Result> {
  try {
    const ctx = await guard()
    await withUser(ctx.user.id, (tx) =>
      tx.update(kitchenStations).set({ isActive }).where(and(eq(kitchenStations.id, id), eq(kitchenStations.tenantId, ctx.tenant.id))),
    )
    return done()
  } catch (e) {
    return fail(e)
  }
}

export async function deleteStation(id: string): Promise<Result> {
  try {
    const ctx = await guard()
    await withUser(ctx.user.id, (tx) =>
      tx.delete(kitchenStations).where(and(eq(kitchenStations.id, id), eq(kitchenStations.tenantId, ctx.tenant.id))),
    )
    return done()
  } catch (e) {
    return fail(e)
  }
}

/** Route a category's dishes (default) or one dish (override) to a station; null clears it. */
export async function assignStation(target: { kind: 'category' | 'item'; id: string }, stationId: string | null): Promise<Result> {
  try {
    const ctx = await guard()
    await withUser(ctx.user.id, async (tx) => {
      if (stationId) {
        const [s] = await tx
          .select({ id: kitchenStations.id })
          .from(kitchenStations)
          .where(and(eq(kitchenStations.id, stationId), eq(kitchenStations.tenantId, ctx.tenant.id)))
          .limit(1)
        if (!s) throw new KotError('Station not found.')
      }
      if (target.kind === 'category') {
        await tx
          .update(menuCategories)
          .set({ stationId })
          .where(and(eq(menuCategories.id, target.id), eq(menuCategories.tenantId, ctx.tenant.id)))
      } else {
        await tx
          .update(menuItems)
          .set({ stationId })
          .where(and(eq(menuItems.id, target.id), eq(menuItems.tenantId, ctx.tenant.id)))
      }
    })
    return done()
  } catch (e) {
    return fail(e)
  }
}
