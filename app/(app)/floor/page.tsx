import { redirect } from 'next/navigation'
import { and, eq } from 'drizzle-orm'
import { getActiveContext } from '@/lib/tenant/context'
import { canManageIncomingOrders, canManageKitchen, canManageWalkins } from '@/lib/auth/roles'
import { hasEntitlement } from '@/lib/platform/entitlement-guard'
import { todayInZone } from '@/lib/booking/time'
import { listServers } from '@/lib/sections/data'
import { isWaitlistEnabled, listActiveWaitlist } from '@/lib/waitlist/data'
import { dayBounds, getReservationSettings, listReservations } from '@/lib/reservations/data'
import { withUser } from '@/db'
import { branches } from '@/db/schema'
import { listTables } from '@/lib/booking/data'
import { listMenuItems, listMostOrderedItemIds, listMenuItemModifierGroups, groupModifierGroupsByMenuItem } from '@/lib/menu/data'
import {
  listOrdersForBookings,
  listOrderItemModifierNames,
  openOrderIdsByBooking as computeOpenOrderIdsByBooking,
} from '@/lib/orders/data'
import { listKotStatusesForBookings } from '@/lib/kots/data'
import { listBookingBillingStates } from '@/lib/billing/data'
import { listHappyHours } from '@/lib/happy-hours/data'
import { deriveTableStatus } from '@/lib/booking/table-status'
import { FloorView } from '@/components/tables/FloorView'
import type { OrderSummary } from '@/components/bookings/BookingsView'

/** KOT states the kitchen hasn't finished — see lib/booking/table-status.ts. */
const ACTIVE_KOT_STATUSES = new Set(['pending', 'preparing', 'ready'])

export default async function FloorPage() {
  const ctx = await getActiveContext()
  if (!ctx) return null
  // Restaurant-only surface (M17): gated here, not just by hiding the nav
  // entry, so a non-restaurant tenant can never reach it by URL either.
  if (ctx.tenant.industry !== 'restaurant') redirect('/dashboard')

  const [branch] = await withUser(ctx.user.id, (tx) =>
    tx
      .select({ id: branches.id, name: branches.name })
      .from(branches)
      .where(and(eq(branches.tenantId, ctx.tenant.id), eq(branches.isPrimary, true)))
      .limit(1),
  )
  if (!branch) return <div className="p-6 text-sm text-muted-foreground">No branch configured.</div>

  const [tables, menuItemRows, happyHourRows, popularItemRows, menuItemGroupRows] = await Promise.all([
    listTables(ctx, branch.id),
    listMenuItems(ctx),
    listHappyHours(ctx),
    listMostOrderedItemIds(ctx, branch.id),
    listMenuItemModifierGroups(ctx),
  ])
  const modifierGroupsByItem = groupModifierGroupsByMenuItem(menuItemGroupRows)

  // M20: today's still-to-come reservations, shown on their tables. Off (and
  // no query beyond the settings read) unless the venue opted in on a plan that has it.
  const reservationsOn =
    canManageWalkins(ctx.role) &&
    (await hasEntitlement(ctx, 'module.table_reservations')) &&
    (await getReservationSettings(ctx)).enabled
  // M20: the host's waitlist headline (count + longest wait) for the floor header.
  const waitlistOn =
    canManageWalkins(ctx.role) && (await hasEntitlement(ctx, 'module.waitlist')) && (await isWaitlistEnabled(ctx))
  const waitlistEntries = waitlistOn ? await listActiveWaitlist(ctx, branch.id) : []
  // M20: floor sections / server assignment. Reassigning a running table is a front-of-house job.
  const sectionsOn = canManageWalkins(ctx.role) && (await hasEntitlement(ctx, 'module.floor_sections'))
  const servers = sectionsOn ? await listServers(ctx) : []
  const upcomingReservations = reservationsOn
    ? (await listReservations(ctx, branch.id, dayBounds(todayInZone(ctx.tenant.timezone), ctx.tenant.timezone)))
        .filter((r) => r.status === 'confirmed' && !r.seatedTableId && r.tableId)
        .map((r) => ({
          bookingId: r.bookingId,
          tableId: r.tableId!,
          guestName: r.customerName,
          partySize: r.partySize,
          reservedFor: r.reservedFor.toISOString(),
        }))
    : []

  const bookingIds = [...new Set(tables.map((t) => t.bookingId).filter((id): id is string => Boolean(id)))]
  const [orderRows, kotRows, billingStates] = await Promise.all([
    listOrdersForBookings(ctx, bookingIds),
    listKotStatusesForBookings(ctx, bookingIds),
    listBookingBillingStates(ctx, bookingIds),
  ])
  // /floor is restaurant-only already (the redirect above), so no industry
  // check needed here — unlike /bookings, which is cross-industry.
  const modifiersByOrderItem = await listOrderItemModifierNames(
    ctx,
    orderRows.map((r) => r.itemId).filter((id): id is string => id !== null),
  )

  const ordersByBooking: Record<string, OrderSummary[]> = {}
  for (const row of orderRows) {
    if (!row.bookingId) continue
    const list = (ordersByBooking[row.bookingId] ??= [])
    let order = list.find((o) => o.orderId === row.orderId)
    if (!order) {
      order = { orderId: row.orderId, orderNumber: row.orderNumber, status: row.status, items: [] }
      list.push(order)
    }
    if (row.itemId) {
      order.items.push({
        itemId: row.itemId,
        itemName: row.itemName!,
        unitPrice: row.unitPrice!,
        qty: row.qty!,
        specialInstructions: row.specialInstructions,
        happyHourName: row.happyHourName,
        originalUnitPrice: row.originalUnitPrice,
        happyHourDiscountType: row.happyHourDiscountType,
        happyHourDiscountValue: row.happyHourDiscountValue,
        voidStatus: row.voidStatus!,
        voidReason: row.voidReason,
        pendingVoidMode: row.pendingVoidMode,
        modifiers: modifiersByOrderItem.get(row.itemId) ?? [],
        courseNo: row.courseNo!,
        courseName: row.courseName,
        held: row.fireStatus === 'held',
      })
    }
  }
  // Distinct open orders per booking (a left-joined item row would otherwise
  // double-count the same order once per item) — filtered the same way as
  // activeKotByBooking below, so a still-unreviewed QR order can't count as
  // "open" here while also failing to set hasActiveKot (see
  // openOrderIdsByBooking's doc comment in lib/orders/data.ts).
  const openOrderIdsByBooking = computeOpenOrderIdsByBooking(orderRows)

  const activeKotByBooking = new Set<string>()
  for (const row of kotRows) {
    if (row.bookingId && ACTIVE_KOT_STATUSES.has(row.status)) activeKotByBooking.add(row.bookingId)
  }

  // Hidden items never reach the picker; out-of-stock ones do, shown
  // disabled with an "86'd" badge (TakeOrderDialog) instead of vanishing —
  // a waiter should still be able to tell a guest something's out, and
  // createOrderCore rejects ordering it either way.
  const orderableItems = menuItemRows.filter((i) => i.status !== 'hidden')
  const categoryMap = new Map<string, string>()
  for (const i of orderableItems) categoryMap.set(i.categoryId, i.categoryName)
  const categories = [...categoryMap.entries()].map(([id, name]) => ({ id, name }))
  const menuItems = orderableItems.map((i) => ({
    id: i.id,
    name: i.name,
    price: i.price,
    categoryId: i.categoryId,
    categoryName: i.categoryName,
    taxPercent: i.taxPercent,
    status: i.status,
    modifierGroups: modifierGroupsByItem.get(i.id) ?? [],
  }))
  // menuItemId is null for a row whose menu item has since been deleted
  // (order_items.menu_item_id is ON DELETE SET NULL) — nothing to quick-add.
  const popularItemIds = popularItemRows.map((r) => r.menuItemId).filter((id): id is string => id !== null)
  const happyHours = happyHourRows.map((h) => ({
    id: h.id,
    name: h.name,
    daysOfWeek: h.daysOfWeek,
    startTime: h.startTime,
    endTime: h.endTime,
    discountType: h.discountType,
    discountValue: h.discountValue,
    isActive: h.isActive,
  }))

  return (
    <FloorView
      branchId={branch.id}
      reservationsOn={reservationsOn}
      upcomingReservations={upcomingReservations}
      waitlistOn={waitlistOn}
      servers={servers}
      waitlist={waitlistEntries.map((w) => ({ createdAt: w.createdAt.toISOString() }))}
      currency={ctx.tenant.currency}
      timeZone={ctx.tenant.timezone}
      tables={tables.map((t) => {
        const billing = t.bookingId ? billingStates[t.bookingId] : undefined
        const status = deriveTableStatus({
          hasBooking: Boolean(t.bookingId),
          hasLiveInvoice: billing?.hasLiveInvoice ?? false,
          billRequestedAt: t.billRequestedAt,
          openOrderCount: t.bookingId ? (openOrderIdsByBooking[t.bookingId]?.size ?? 0) : 0,
          hasActiveKot: t.bookingId ? activeKotByBooking.has(t.bookingId) : false,
        })
        return {
          id: t.id,
          name: t.name,
          typeName: t.typeName,
          color: t.color,
          bookingId: t.bookingId,
          bookingNumber: t.bookingNumber,
          coverCount: t.coverCount,
          customerName: t.customerName,
          customerPhone: t.customerPhone,
          checkedInAt: t.checkedInAt ? t.checkedInAt.toISOString() : null,
          billRequestedAt: t.billRequestedAt ? t.billRequestedAt.toISOString() : null,
          status,
          runningTotal: billing?.runningTotal ?? 0,
          sectionId: t.sectionId,
          sectionName: t.sectionName,
          sectionSort: t.sectionSort,
          sessionServerId: t.sessionServerId,
          serverName: t.bookingId ? t.sessionServerName : t.assignedServerName,
        }
      })}
      categories={categories}
      menuItems={menuItems}
      happyHours={happyHours}
      popularItemIds={popularItemIds}
      ordersByBooking={ordersByBooking}
      canRequestVoidComp={canManageIncomingOrders(ctx.role)}
      canToggle86={canManageKitchen(ctx.role)}
    />
  )
}
