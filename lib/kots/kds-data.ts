import 'server-only'
import { and, asc, eq, inArray, isNull, ne } from 'drizzle-orm'
import { withUser } from '@/db'
import { kitchenStations, kots, kotItems, orders, orderItems, orderItemModifiers, resources } from '@/db/schema'
import type { ActiveContext } from '@/lib/tenant/context'
import { getKdsSettingsCore, type KdsSettings } from './kds'

export type KdsItem = {
  itemId: string
  menuItemId: string | null
  name: string
  qty: number
  notes: string | null
  modifiers: string[]
  bumped: boolean
  courseNo: number
  courseName: string | null
  /** Station snapshot (M19 #3); null = unrouted. */
  stationId: string | null
  stationName: string | null
}

/** Lines of one course that are on the ticket but not yet sent to the cook. */
export type KdsHeldGroup = { course: number; name: string; items: Pick<KdsItem, 'itemId' | 'name' | 'qty' | 'modifiers' | 'notes' | 'stationName'>[] }

export type KdsTicket = {
  orderId: string
  kotId: string
  kotNumber: string
  status: 'pending' | 'preparing' | 'ready'
  createdAt: string
  /** When the cook's clock for this ticket started: the oldest outstanding
   *  fired line's fire time (a fired course 2 starts its own timer), else the
   *  ticket's creation. */
  startedAt: string
  orderNumber: string
  channel: 'staff' | 'online'
  tableName: string | null
  /** Fired lines only — what the cook sees. */
  items: KdsItem[]
  /** Held lines, grouped by course, waiting for a Fire. */
  held: KdsHeldGroup[]
}

export type AllDayCount = { key: string; name: string; qty: number }

/** A station screen's scope: one station, or the lines with no station. */
export type StationFilter = { id: string | null }

export type KdsBoard = {
  settings: KdsSettings
  /** Active stations, for the station tabs (empty when routing is off). */
  stations: { id: string; name: string }[]
  /** Tickets with at least one fired line. */
  tickets: KdsTicket[]
  /** Tables whose whole order is still on hold — nothing for the cook yet. */
  heldOnly: KdsTicket[]
  allDay: AllDayCount[]
  /** Server clock at read time — the client derives its offset from this so
   *  timers aren't skewed by a wall display with a wrong clock. */
  serverNow: string
}

/**
 * Everything the KDS screen shows, in one read: pending/preparing/ready
 * tickets (oldest first) with per-line bump state, plus the all-day counts —
 * quantity still outstanding (not bumped, not voided) per dish across tickets
 * the kitchen hasn't finished.
 *
 * Voided lines are dropped here, which is what makes a void after firing
 * disappear from the board; comped lines stay (the food is still cooked).
 * Same accepted-orders gate as listActiveKots.
 */
export function getKdsBoard(ctx: ActiveContext, branchId: string, station?: StationFilter): Promise<KdsBoard> {
  return withUser(ctx.user.id, async (tx) => {
    const settings = await getKdsSettingsCore(tx, ctx.tenant.id)
    const routing = settings.enabled && settings.stationsEnabled
    const stations = routing
      ? await tx
          .select({ id: kitchenStations.id, name: kitchenStations.name })
          .from(kitchenStations)
          .where(and(eq(kitchenStations.tenantId, ctx.tenant.id), eq(kitchenStations.isActive, true)))
          .orderBy(asc(kitchenStations.sortOrder), asc(kitchenStations.name))
      : []
    // A station screen sees only its own lines (a stale ?station= with
    // routing off is ignored rather than showing an empty board).
    const scope = routing ? station : undefined

    const rows = await tx
      .select({
        kotId: kots.id,
        orderId: orders.id,
        kotNumber: kots.kotNumber,
        status: kots.status,
        createdAt: kots.createdAt,
        orderNumber: orders.orderNumber,
        channel: orders.channel,
        tableName: resources.name,
        itemId: orderItems.id,
        menuItemId: orderItems.menuItemId,
        name: orderItems.itemName,
        qty: orderItems.qty,
        notes: orderItems.specialInstructions,
        bumpedId: kotItems.id,
        courseNo: orderItems.courseNo,
        courseName: orderItems.courseName,
        fireStatus: orderItems.fireStatus,
        firedAt: orderItems.firedAt,
        stationId: orderItems.stationId,
        stationName: orderItems.stationName,
      })
      .from(kots)
      .innerJoin(orders, eq(orders.id, kots.orderId))
      .innerJoin(orderItems, and(eq(orderItems.orderId, orders.id), ne(orderItems.voidStatus, 'voided')))
      .leftJoin(kotItems, eq(kotItems.orderItemId, orderItems.id))
      .leftJoin(resources, eq(resources.id, orders.resourceId))
      .where(
        and(
          eq(kots.tenantId, ctx.tenant.id),
          eq(kots.branchId, branchId),
          inArray(kots.status, ['pending', 'preparing', 'ready']),
          eq(orders.acceptanceStatus, 'accepted'),
          scope === undefined
            ? undefined
            : scope.id === null
              ? isNull(orderItems.stationId)
              : eq(orderItems.stationId, scope.id),
        ),
      )
      .orderBy(asc(kots.createdAt), asc(kots.id), asc(orderItems.id))

    const modsByItem = new Map<string, string[]>()
    const itemIds = rows.map((r) => r.itemId)
    if (itemIds.length > 0) {
      const mods = await tx
        .select({ orderItemId: orderItemModifiers.orderItemId, optionName: orderItemModifiers.optionName })
        .from(orderItemModifiers)
        .where(and(eq(orderItemModifiers.tenantId, ctx.tenant.id), inArray(orderItemModifiers.orderItemId, itemIds)))
      for (const m of mods) {
        const list = modsByItem.get(m.orderItemId) ?? []
        if (list.length === 0) modsByItem.set(m.orderItemId, list)
        list.push(m.optionName)
      }
    }

    const byKot = new Map<string, KdsTicket>()
    const heldByKot = new Map<string, Map<number, KdsHeldGroup>>()
    const startMs = new Map<string, number>()
    const counts = new Map<string, AllDayCount>()
    for (const r of rows) {
      let t = byKot.get(r.kotId)
      if (!t) {
        t = {
          orderId: r.orderId,
          kotId: r.kotId,
          kotNumber: r.kotNumber,
          status: r.status as KdsTicket['status'],
          createdAt: r.createdAt.toISOString(),
          startedAt: r.createdAt.toISOString(),
          orderNumber: r.orderNumber,
          channel: r.channel,
          tableName: r.tableName,
          items: [],
          held: [],
        }
        byKot.set(r.kotId, t)
      }
      const bumped = r.bumpedId !== null
      if (r.fireStatus === 'held') {
        const groups = heldByKot.get(r.kotId) ?? new Map<number, KdsHeldGroup>()
        heldByKot.set(r.kotId, groups)
        const g = groups.get(r.courseNo) ?? { course: r.courseNo, name: r.courseName ?? `Course ${r.courseNo}`, items: [] }
        groups.set(r.courseNo, g)
        g.items.push({ itemId: r.itemId, name: r.name, qty: r.qty, modifiers: modsByItem.get(r.itemId) ?? [], notes: r.notes, stationName: r.stationName })
        continue
      }
      if (!bumped) {
        const at = (r.firedAt ?? r.createdAt).getTime()
        startMs.set(r.kotId, Math.min(startMs.get(r.kotId) ?? at, at))
      }
      t.items.push({
        itemId: r.itemId,
        menuItemId: r.menuItemId,
        name: r.name,
        qty: r.qty,
        notes: r.notes,
        modifiers: modsByItem.get(r.itemId) ?? [],
        bumped,
        courseNo: r.courseNo,
        courseName: r.courseName,
        stationId: r.stationId,
        stationName: r.stationName,
      })
      if (!bumped && t.status !== 'ready') {
        const key = r.menuItemId ?? `name:${r.name}`
        const c = counts.get(key) ?? { key, name: r.name, qty: 0 }
        c.qty += r.qty
        counts.set(key, c)
      }
    }

    for (const t of byKot.values()) {
      t.held = [...(heldByKot.get(t.kotId)?.values() ?? [])].sort((a, b) => a.course - b.course)
      const s = startMs.get(t.kotId)
      if (s !== undefined) t.startedAt = new Date(s).toISOString()
    }
    const all = [...byKot.values()]

    // A station screen drops a ticket once ALL of that station's lines are
    // bumped (its work is done); the expo view (no scope) keeps everything.
    const visible = scope === undefined ? all : all.filter((t) => t.items.length === 0 || t.items.some((i) => !i.bumped))

    return {
      settings,
      stations,
      tickets: visible.filter((t) => t.items.length > 0),
      heldOnly: visible.filter((t) => t.items.length === 0 && t.held.length > 0),
      allDay: [...counts.values()].sort((a, b) => b.qty - a.qty || a.name.localeCompare(b.name)),
      serverNow: new Date().toISOString(),
    }
  })
}
