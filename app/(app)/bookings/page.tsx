import { and, eq } from 'drizzle-orm'
import { getActiveContext } from '@/lib/tenant/context'
import { canManageIncomingOrders, canManageKitchen } from '@/lib/auth/roles'
import { withUser } from '@/db'
import { branches } from '@/db/schema'
import { listResources, getWorkingHours, listDayBookings, addDays } from '@/lib/booking/data'
import { todayInZone, weekdayInZone } from '@/lib/booking/time'
import { listMenuItems, listMostOrderedItemIds } from '@/lib/menu/data'
import { listOrdersForBookings } from '@/lib/orders/data'
import { listDepositStates } from '@/lib/payments/data'
import { listHappyHours } from '@/lib/happy-hours/data'
import { BookingsView, type OrderSummary } from '@/components/bookings/BookingsView'

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

export default async function BookingsPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string }>
}) {
  const ctx = await getActiveContext()
  if (!ctx) return null
  const tz = ctx.tenant.timezone
  const sp = await searchParams
  const date = /^\d{4}-\d{2}-\d{2}$/.test(sp.date ?? '') ? sp.date! : todayInZone(tz)

  const [branch] = await withUser(ctx.user.id, (tx) =>
    tx
      .select({ id: branches.id, name: branches.name })
      .from(branches)
      .where(and(eq(branches.tenantId, ctx.tenant.id), eq(branches.isPrimary, true)))
      .limit(1),
  )
  if (!branch) return <div className="p-6 text-sm text-muted-foreground">No branch configured.</div>

  const [allResources, hours, slots, menuItemRows, happyHourRows, popularItemRows] = await Promise.all([
    listResources(ctx, branch.id),
    getWorkingHours(ctx, branch.id),
    listDayBookings(ctx, branch.id, date, tz),
    listMenuItems(ctx),
    listHappyHours(ctx),
    listMostOrderedItemIds(ctx, branch.id),
  ])

  const bookingIds = [...new Set(slots.map((s) => s.bookingId))]
  const orderRows = await listOrdersForBookings(ctx, bookingIds)
  // Which bookings already have a deposit order open or settled (AROS-49).
  const depositRows = await listDepositStates(ctx, bookingIds)
  const depositStates: Record<string, 'pending' | 'paid'> = {}
  for (const [bookingId, state] of Object.entries(depositRows)) {
    depositStates[bookingId] = state.status
  }

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
      })
    }
  }

  // Hidden items never reach the picker; out-of-stock ones do, shown
  // disabled with an "86'd" badge (TakeOrderDialog) instead of vanishing.
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
  }))
  // menuItemId is null for a row whose menu item has since been deleted
  // (order_items.menu_item_id is ON DELETE SET NULL) — nothing to quick-add.
  const popularItemIds = popularItemRows.map((r) => r.menuItemId).filter((id): id is string => id !== null)

  // Only what the take-order dialog needs to preview a discount client-side;
  // the server still decides for real when the order is placed.
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

  const dow = weekdayInZone(date, tz)
  const dayHours = hours.find((h) => h.dayOfWeek === dow)
  const closed = dayHours?.isClosed ?? false
  const openMin = dayHours && !dayHours.isClosed ? toMinutes(dayHours.openTime) : 600
  const closeMin = dayHours && !dayHours.isClosed ? toMinutes(dayHours.closeTime) : 1320

  const resources = allResources
    .filter((r) => r.status !== 'inactive')
    .map((r) => ({
      id: r.id,
      name: r.name,
      resourceTypeId: r.resourceTypeId,
      typeName: r.typeName,
      status: r.status,
      imageUrl: r.imageUrl ?? r.typeImageUrl,
    }))

  return (
    <BookingsView
      branchId={branch.id}
      branchName={branch.name}
      timeZone={tz}
      currency={ctx.tenant.currency}
      date={date}
      prevDate={addDays(date, -1)}
      nextDate={addDays(date, 1)}
      today={todayInZone(tz)}
      closed={closed}
      openMin={openMin}
      closeMin={closeMin}
      resources={resources}
      happyHours={happyHours}
      slots={slots.map((s) => ({
        slotId: s.slotId,
        resourceId: s.resourceId,
        startsAt: s.startsAt.toISOString(),
        endsAt: s.endsAt.toISOString(),
        bookingId: s.bookingId,
        bookingNumber: s.bookingNumber,
        customerName: s.customerName,
        customerPhone: s.customerPhone,
        status: s.status,
        source: s.source,
        total: s.total,
        deposit: s.deposit,
      }))}
      categories={categories}
      menuItems={menuItems}
      popularItemIds={popularItemIds}
      ordersByBooking={ordersByBooking}
      venueName={ctx.tenant.name}
      depositStates={depositStates}
      canRequestVoidComp={canManageIncomingOrders(ctx.role)}
      canToggle86={canManageKitchen(ctx.role)}
    />
  )
}
