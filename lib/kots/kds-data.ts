import 'server-only'
import { and, asc, eq, inArray, ne } from 'drizzle-orm'
import { withUser } from '@/db'
import { kots, kotItems, orders, orderItems, orderItemModifiers, resources } from '@/db/schema'
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
}

export type KdsTicket = {
  kotId: string
  kotNumber: string
  status: 'pending' | 'preparing' | 'ready'
  createdAt: string
  orderNumber: string
  channel: 'staff' | 'online'
  tableName: string | null
  items: KdsItem[]
}

export type AllDayCount = { key: string; name: string; qty: number }

export type KdsBoard = {
  settings: KdsSettings
  tickets: KdsTicket[]
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
export function getKdsBoard(ctx: ActiveContext, branchId: string): Promise<KdsBoard> {
  return withUser(ctx.user.id, async (tx) => {
    const settings = await getKdsSettingsCore(tx, ctx.tenant.id)

    const rows = await tx
      .select({
        kotId: kots.id,
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
    const counts = new Map<string, AllDayCount>()
    for (const r of rows) {
      let t = byKot.get(r.kotId)
      if (!t) {
        t = {
          kotId: r.kotId,
          kotNumber: r.kotNumber,
          status: r.status as KdsTicket['status'],
          createdAt: r.createdAt.toISOString(),
          orderNumber: r.orderNumber,
          channel: r.channel,
          tableName: r.tableName,
          items: [],
        }
        byKot.set(r.kotId, t)
      }
      const bumped = r.bumpedId !== null
      t.items.push({
        itemId: r.itemId,
        menuItemId: r.menuItemId,
        name: r.name,
        qty: r.qty,
        notes: r.notes,
        modifiers: modsByItem.get(r.itemId) ?? [],
        bumped,
      })
      if (!bumped && t.status !== 'ready') {
        const key = r.menuItemId ?? `name:${r.name}`
        const c = counts.get(key) ?? { key, name: r.name, qty: 0 }
        c.qty += r.qty
        counts.set(key, c)
      }
    }

    return {
      settings,
      tickets: [...byKot.values()],
      allDay: [...counts.values()].sort((a, b) => b.qty - a.qty || a.name.localeCompare(b.name)),
      serverNow: new Date().toISOString(),
    }
  })
}
