/**
 * Kitchen Display System core (M19 / AROS-172) — item-level bump/recall on top
 * of the order-level KOT status in ./service.ts.
 *
 * Takes a `tx` (same pattern as ./service.ts) and is deliberately free of
 * 'server-only' so the standalone tsx test scripts can import it.
 *
 * Model: `kot_items` is SPARSE — a row means the order line was bumped, no row
 * means still outstanding (migration 0146). The ticket's own status is derived
 * from it, so every existing reader of kots.status (public-status.ts, /floor,
 * cancelKotsForOrders, the print page) keeps working unchanged:
 *   first bump           pending   → preparing
 *   last line bumped     preparing → ready
 *   recall (any line)    ready     → preparing
 * A voided line never counts as outstanding, and a removed line takes its
 * kot_items row with it (ON DELETE CASCADE).
 */
import { and, eq, inArray, isNull, ne, notExists, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type * as schema from '@/db/schema'
import { kitchenStations, kots, kotItems, orderItems, orderSettings, orders } from '@/db/schema'
import { KotError, type KotOrderRef } from './service'

type Db = NodePgDatabase<typeof schema>

export type KdsSettings = {
  enabled: boolean
  warnMinutes: number
  lateMinutes: number
  /** Course firing (M19 #2) — only meaningful when `enabled` too. */
  coursesEnabled: boolean
  courseNames: string[]
  /** Station routing (M19 #3) — only meaningful when `enabled` too. */
  stationsEnabled: boolean
}

/** A tenant with no order_settings row behaves exactly as before the KDS. */
export const DEFAULT_COURSE_NAMES = ['Starters', 'Mains', 'Desserts']
export const DEFAULT_KDS_SETTINGS: KdsSettings = {
  enabled: false,
  warnMinutes: 8,
  lateMinutes: 15,
  coursesEnabled: false,
  courseNames: DEFAULT_COURSE_NAMES,
  stationsEnabled: false,
}

export async function getKdsSettingsCore(tx: Db, tenantId: string): Promise<KdsSettings> {
  const [row] = await tx
    .select({
      enabled: orderSettings.kdsEnabled,
      warnMinutes: orderSettings.kdsWarnMinutes,
      lateMinutes: orderSettings.kdsLateMinutes,
      coursesEnabled: orderSettings.coursesEnabled,
      courseNames: orderSettings.courseNames,
      stationsEnabled: orderSettings.stationsEnabled,
    })
    .from(orderSettings)
    .where(eq(orderSettings.tenantId, tenantId))
    .limit(1)
  return row ?? DEFAULT_KDS_SETTINGS
}

export async function saveKdsSettingsCore(
  tx: Db,
  tenantId: string,
  v: Omit<KdsSettings, 'stationsEnabled'> & { stationsEnabled?: boolean },
): Promise<void> {
  const whole = (n: number) => Number.isInteger(n)
  if (!whole(v.warnMinutes) || !whole(v.lateMinutes) || v.warnMinutes < 1 || v.lateMinutes > 480) {
    throw new KotError('Timer thresholds must be whole minutes between 1 and 480.')
  }
  if (v.warnMinutes >= v.lateMinutes) {
    throw new KotError('The "slow" threshold must be shorter than the "late" threshold.')
  }
  const names = v.courseNames.map((n) => n.trim())
  if (names.length < 2 || names.length > 6 || names.some((n) => n.length === 0 || n.length > 30)) {
    throw new KotError('Give 2 to 6 course names, each up to 30 characters.')
  }
  if (new Set(names.map((n) => n.toLowerCase())).size !== names.length) {
    throw new KotError('Course names must be different from each other.')
  }
  const set = {
    kdsEnabled: v.enabled,
    kdsWarnMinutes: v.warnMinutes,
    kdsLateMinutes: v.lateMinutes,
    coursesEnabled: v.coursesEnabled,
    courseNames: names,
    // Omitted = leave the stored value alone (callers predating stations).
    ...(v.stationsEnabled === undefined ? {} : { stationsEnabled: v.stationsEnabled }),
  }
  await tx
    .insert(orderSettings)
    .values({ tenantId, ...set })
    .onConflictDoUpdate({ target: orderSettings.tenantId, set })
  // Course firing needs both flags. Once it can no longer run, nobody can fire a
  // held course (fire_order_course refuses), so release what is still held rather
  // than leave billed-but-never-cooked lines behind.
  if (!(v.enabled && v.coursesEnabled)) await releaseHeldLinesCore(tx, tenantId)
}

/**
 * Fire every still-held line on the tenant's open orders, and put a ticket the
 * kitchen had finished / the floor had served back to `preparing` — the same
 * effect as fireCourseCore, minus the flag check, for when course firing is
 * being switched off. Returns the number of lines released.
 */
export async function releaseHeldLinesCore(tx: Db, tenantId: string): Promise<number> {
  const openOrders = tx
    .select({ id: orders.id })
    .from(orders)
    .where(and(eq(orders.tenantId, tenantId), eq(orders.status, 'open')))
  const released = await tx
    .update(orderItems)
    .set({ fireStatus: 'fired', firedAt: new Date() })
    .where(
      and(
        eq(orderItems.tenantId, tenantId),
        eq(orderItems.fireStatus, 'held'),
        ne(orderItems.voidStatus, 'voided'),
        inArray(orderItems.orderId, openOrders),
      ),
    )
    .returning({ orderId: orderItems.orderId })
  const orderIds = [...new Set(released.map((r) => r.orderId))]
  if (orderIds.length > 0) {
    await tx
      .update(kots)
      .set({ status: 'preparing' })
      .where(and(eq(kots.tenantId, tenantId), inArray(kots.orderId, orderIds), inArray(kots.status, ['ready', 'served'])))
  }
  return released.length
}

async function assertKdsEnabled(tx: Db, tenantId: string): Promise<void> {
  if (!(await getKdsSettingsCore(tx, tenantId)).enabled) {
    throw new KotError('The kitchen display is not turned on for this venue.')
  }
}

export type KdsActor = { tenantId: string; membershipId: string | null }
export type KdsResult = KotOrderRef & { kotId: string; status: 'pending' | 'preparing' | 'ready'; becameReady: boolean }

/** Lock the ticket for the whole bump so two screens tapping at once can't both
 *  decide "I bumped the last line". */
async function lockKot(tx: Db, tenantId: string, kotId: string) {
  const [kot] = await tx
    .select({
      id: kots.id,
      status: kots.status,
      orderId: kots.orderId,
      orderNumber: orders.orderNumber,
      customerId: orders.customerId,
    })
    .from(kots)
    .innerJoin(orders, eq(orders.id, kots.orderId))
    .where(and(eq(kots.id, kotId), eq(kots.tenantId, tenantId)))
    .for('update', { of: kots })
    .limit(1)
  if (!kot) throw new KotError('Ticket not found.')
  return kot
}

/** Which station's lines an operation covers: `{ id }` = that station, `{ id: null }`
 *  = lines with no station, undefined = every line on the ticket. */
export type StationScope = { id: string | null } | undefined

/** Not-voided, fired lines on the order with no bump row (optionally one station's). */
async function outstandingLineIds(tx: Db, tenantId: string, orderId: string, station?: StationScope): Promise<string[]> {
  const rows = await tx
    .select({ id: orderItems.id })
    .from(orderItems)
    .where(
      and(
        eq(orderItems.tenantId, tenantId),
        eq(orderItems.orderId, orderId),
        ne(orderItems.voidStatus, 'voided'),
        // Held lines aren't the cook's yet — they never block "ready".
        eq(orderItems.fireStatus, 'fired'),
        station === undefined
          ? undefined
          : station.id === null
            ? isNull(orderItems.stationId)
            : eq(orderItems.stationId, station.id),
        notExists(tx.select({ one: sql`1` }).from(kotItems).where(eq(kotItems.orderItemId, orderItems.id))),
      ),
    )
  return rows.map((r) => r.id)
}

async function setStatus(tx: Db, tenantId: string, kotId: string, status: 'pending' | 'preparing' | 'ready') {
  await tx.update(kots).set({ status }).where(and(eq(kots.id, kotId), eq(kots.tenantId, tenantId)))
}

function result(kot: Awaited<ReturnType<typeof lockKot>>, status: KdsResult['status'], becameReady: boolean): KdsResult {
  return {
    kotId: kot.id,
    orderId: kot.orderId,
    orderNumber: kot.orderNumber,
    customerId: kot.customerId,
    status,
    becameReady,
  }
}

/** Mark one line cooked. Idempotent: bumping an already-bumped line is a no-op. */
export async function bumpKotItemCore(tx: Db, actor: KdsActor, kotId: string, orderItemId: string): Promise<KdsResult> {
  await assertKdsEnabled(tx, actor.tenantId)
  const kot = await lockKot(tx, actor.tenantId, kotId)
  if (kot.status !== 'pending' && kot.status !== 'preparing') {
    throw new KotError(`A ${kot.status} ticket can't be changed${kot.status === 'ready' ? ' — recall it first' : ''}.`)
  }

  const [line] = await tx
    .select({ id: orderItems.id, voidStatus: orderItems.voidStatus, fireStatus: orderItems.fireStatus })
    .from(orderItems)
    .where(
      and(eq(orderItems.id, orderItemId), eq(orderItems.orderId, kot.orderId), eq(orderItems.tenantId, actor.tenantId)),
    )
    .limit(1)
  if (!line) throw new KotError('That item is not on this ticket.')
  if (line.voidStatus === 'voided') throw new KotError('That item was voided.')
  if (line.fireStatus === 'held') throw new KotError('That course is on hold — fire it first.')

  await tx
    .insert(kotItems)
    .values({ tenantId: actor.tenantId, kotId, orderItemId, bumpedBy: actor.membershipId })
    .onConflictDoNothing({ target: kotItems.orderItemId })

  const left = await outstandingLineIds(tx, actor.tenantId, kot.orderId)
  const next = left.length === 0 ? 'ready' : 'preparing'
  if (next !== kot.status) await setStatus(tx, actor.tenantId, kotId, next)
  return result(kot, next, next === 'ready')
}

/** Un-bump one line. A ready ticket drops back to preparing. */
export async function recallKotItemCore(tx: Db, actor: KdsActor, kotId: string, orderItemId: string): Promise<KdsResult> {
  await assertKdsEnabled(tx, actor.tenantId)
  const kot = await lockKot(tx, actor.tenantId, kotId)
  if (kot.status !== 'preparing' && kot.status !== 'ready') {
    throw new KotError(`A ${kot.status} ticket can't be recalled.`)
  }
  await tx
    .delete(kotItems)
    .where(and(eq(kotItems.kotId, kotId), eq(kotItems.orderItemId, orderItemId), eq(kotItems.tenantId, actor.tenantId)))
  if (kot.status === 'ready') await setStatus(tx, actor.tenantId, kotId, 'preparing')
  return result(kot, 'preparing', false)
}

/**
 * Bump every outstanding line at once. Without `station` that completes the
 * ticket (→ ready). With one, only that station's lines are bumped and the
 * ticket becomes ready only if that left nothing outstanding anywhere — the
 * other stations are still cooking otherwise.
 */
export async function bumpKotCore(tx: Db, actor: KdsActor, kotId: string, station?: StationScope): Promise<KdsResult> {
  await assertKdsEnabled(tx, actor.tenantId)
  const kot = await lockKot(tx, actor.tenantId, kotId)
  if (kot.status !== 'pending' && kot.status !== 'preparing') {
    throw new KotError(`A ${kot.status} ticket can't be bumped.`)
  }
  const left = await outstandingLineIds(tx, actor.tenantId, kot.orderId, station)
  if (left.length > 0) {
    await tx
      .insert(kotItems)
      .values(left.map((orderItemId) => ({ tenantId: actor.tenantId, kotId, orderItemId, bumpedBy: actor.membershipId })))
      .onConflictDoNothing({ target: kotItems.orderItemId })
  }
  const stillCooking = station === undefined ? 0 : (await outstandingLineIds(tx, actor.tenantId, kot.orderId)).length
  const next = stillCooking > 0 ? 'preparing' : 'ready'
  await setStatus(tx, actor.tenantId, kotId, next)
  return result(kot, next, next === 'ready')
}

/** Recall a completed ticket: every line back to outstanding, ticket → preparing. */
export async function recallKotCore(tx: Db, actor: KdsActor, kotId: string): Promise<KdsResult> {
  await assertKdsEnabled(tx, actor.tenantId)
  const kot = await lockKot(tx, actor.tenantId, kotId)
  if (kot.status !== 'ready') throw new KotError('Only a ready ticket can be recalled.')
  await tx.delete(kotItems).where(and(eq(kotItems.kotId, kotId), eq(kotItems.tenantId, actor.tenantId)))
  await setStatus(tx, actor.tenantId, kotId, 'preparing')
  return result(kot, 'preparing', false)
}

/**
 * A line left the ticket (voided or removed) — if everything still on it was
 * already bumped, the ticket is done. Called from lib/orders/service.ts; a
 * no-op for tenants without the KDS so the legacy flow is untouched.
 */
export async function reconcileKotAfterLineChange(tx: Db, tenantId: string, orderId: string): Promise<void> {
  if (!(await getKdsSettingsCore(tx, tenantId)).enabled) return
  const open = await tx
    .select({ id: kots.id })
    .from(kots)
    .where(
      and(eq(kots.orderId, orderId), eq(kots.tenantId, tenantId), inArray(kots.status, ['pending', 'preparing'])),
    )
    .for('update')
  if (open.length === 0) return
  const [anyActive] = await tx
    .select({ id: orderItems.id })
    .from(orderItems)
    .where(
      and(
        eq(orderItems.orderId, orderId),
        eq(orderItems.tenantId, tenantId),
        ne(orderItems.voidStatus, 'voided'),
        eq(orderItems.fireStatus, 'fired'),
      ),
    )
    .limit(1)
  // Nothing fired and live: either nothing left at all (the caller cancels the
  // ticket) or only held lines remain, which must NOT read as "done".
  if (!anyActive) return
  if ((await outstandingLineIds(tx, tenantId, orderId)).length > 0) return
  await tx
    .update(kots)
    .set({ status: 'ready' })
    .where(and(inArray(kots.id, open.map((k) => k.id)), eq(kots.tenantId, tenantId)))
}

/** Course config as the order path sees it: usable only with the KDS on too. */
export async function getCourseConfigCore(tx: Db, tenantId: string): Promise<{ enabled: boolean; names: string[] }> {
  const s = await getKdsSettingsCore(tx, tenantId)
  return { enabled: s.enabled && s.coursesEnabled, names: s.courseNames }
}

/**
 * Fire a held course on an order: its held lines become active, and a ticket
 * the kitchen had finished / the floor had served goes back to `preparing`.
 * Runs through fire_order_course (migration 0147), which checks the caller's
 * role itself — waiters and cashiers can't UPDATE kots directly.
 */
export async function fireCourseCore(tx: Db, orderId: string, course: number): Promise<string[]> {
  if (!Number.isInteger(course) || course < 1 || course > 6) throw new KotError('Unknown course.')
  let fired: string[]
  try {
    const r = await tx.execute(sql`select public.fire_order_course(${orderId}::uuid, ${course}::smallint)::text[] as ids`)
    fired = (r.rows[0] as { ids: string[] }).ids ?? []
  } catch (e) {
    const err = (e as { cause?: { message?: string } }).cause ?? (e as { message?: string })
    throw new KotError(err.message?.replace(/^error: /i, '') || 'Could not fire that course.')
  }
  if (fired.length === 0) throw new KotError('Nothing is being held for that course.')
  return fired
}

/**
 * Station routing as the order path sees it: id → name of the tenant's active
 * stations, or null when routing is off (no KDS, or stations not enabled), in
 * which case no order line is given a station.
 */
export async function getStationRoutingCore(tx: Db, tenantId: string): Promise<Map<string, string> | null> {
  const s = await getKdsSettingsCore(tx, tenantId)
  if (!(s.enabled && s.stationsEnabled)) return null
  const rows = await tx
    .select({ id: kitchenStations.id, name: kitchenStations.name })
    .from(kitchenStations)
    .where(and(eq(kitchenStations.tenantId, tenantId), eq(kitchenStations.isActive, true)))
  return new Map(rows.map((r) => [r.id, r.name]))
}
