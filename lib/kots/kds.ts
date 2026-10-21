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
import { and, eq, inArray, ne, notExists, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type * as schema from '@/db/schema'
import { kots, kotItems, orderItems, orderSettings, orders } from '@/db/schema'
import { KotError, type KotOrderRef } from './service'

type Db = NodePgDatabase<typeof schema>

export type KdsSettings = { enabled: boolean; warnMinutes: number; lateMinutes: number }

/** A tenant with no order_settings row behaves exactly as before the KDS. */
export const DEFAULT_KDS_SETTINGS: KdsSettings = { enabled: false, warnMinutes: 8, lateMinutes: 15 }

export async function getKdsSettingsCore(tx: Db, tenantId: string): Promise<KdsSettings> {
  const [row] = await tx
    .select({
      enabled: orderSettings.kdsEnabled,
      warnMinutes: orderSettings.kdsWarnMinutes,
      lateMinutes: orderSettings.kdsLateMinutes,
    })
    .from(orderSettings)
    .where(eq(orderSettings.tenantId, tenantId))
    .limit(1)
  return row ?? DEFAULT_KDS_SETTINGS
}

export async function saveKdsSettingsCore(tx: Db, tenantId: string, v: KdsSettings): Promise<void> {
  const whole = (n: number) => Number.isInteger(n)
  if (!whole(v.warnMinutes) || !whole(v.lateMinutes) || v.warnMinutes < 1 || v.lateMinutes > 480) {
    throw new KotError('Timer thresholds must be whole minutes between 1 and 480.')
  }
  if (v.warnMinutes >= v.lateMinutes) {
    throw new KotError('The "slow" threshold must be shorter than the "late" threshold.')
  }
  const set = { kdsEnabled: v.enabled, kdsWarnMinutes: v.warnMinutes, kdsLateMinutes: v.lateMinutes }
  await tx
    .insert(orderSettings)
    .values({ tenantId, ...set })
    .onConflictDoUpdate({ target: orderSettings.tenantId, set })
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

/** Not-voided lines on the order with no bump row. */
async function outstandingLineIds(tx: Db, tenantId: string, orderId: string): Promise<string[]> {
  const rows = await tx
    .select({ id: orderItems.id })
    .from(orderItems)
    .where(
      and(
        eq(orderItems.tenantId, tenantId),
        eq(orderItems.orderId, orderId),
        ne(orderItems.voidStatus, 'voided'),
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
    .select({ id: orderItems.id, voidStatus: orderItems.voidStatus })
    .from(orderItems)
    .where(
      and(eq(orderItems.id, orderItemId), eq(orderItems.orderId, kot.orderId), eq(orderItems.tenantId, actor.tenantId)),
    )
    .limit(1)
  if (!line) throw new KotError('That item is not on this ticket.')
  if (line.voidStatus === 'voided') throw new KotError('That item was voided.')

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

/** Bump every outstanding line at once → ready. */
export async function bumpKotCore(tx: Db, actor: KdsActor, kotId: string): Promise<KdsResult> {
  await assertKdsEnabled(tx, actor.tenantId)
  const kot = await lockKot(tx, actor.tenantId, kotId)
  if (kot.status !== 'pending' && kot.status !== 'preparing') {
    throw new KotError(`A ${kot.status} ticket can't be bumped.`)
  }
  const left = await outstandingLineIds(tx, actor.tenantId, kot.orderId)
  if (left.length > 0) {
    await tx
      .insert(kotItems)
      .values(left.map((orderItemId) => ({ tenantId: actor.tenantId, kotId, orderItemId, bumpedBy: actor.membershipId })))
      .onConflictDoNothing({ target: kotItems.orderItemId })
  }
  await setStatus(tx, actor.tenantId, kotId, 'ready')
  return result(kot, 'ready', true)
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
    .where(and(eq(orderItems.orderId, orderId), eq(orderItems.tenantId, tenantId), ne(orderItems.voidStatus, 'voided')))
    .limit(1)
  if (!anyActive) return // nothing left at all — the caller cancels the ticket
  if ((await outstandingLineIds(tx, tenantId, orderId)).length > 0) return
  await tx
    .update(kots)
    .set({ status: 'ready' })
    .where(and(inArray(kots.id, open.map((k) => k.id)), eq(kots.tenantId, tenantId)))
}
