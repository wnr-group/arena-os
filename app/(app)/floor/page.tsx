import { redirect } from 'next/navigation'
import { and, eq } from 'drizzle-orm'
import { getActiveContext } from '@/lib/tenant/context'
import { withUser } from '@/db'
import { branches } from '@/db/schema'
import { listTables } from '@/lib/booking/data'
import { listMenuItems, listMostOrderedItemIds } from '@/lib/menu/data'
import { listOrdersForBookings } from '@/lib/orders/data'
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

  const [tables, menuItemRows, happyHourRows, popularItemRows] = await Promise.all([
    listTables(ctx, branch.id),
    listMenuItems(ctx),
    listHappyHours(ctx),
    listMostOrderedItemIds(ctx, branch.id),
  ])

  const bookingIds = [...new Set(tables.map((t) => t.bookingId).filter((id): id is string => Boolean(id)))]
  const [orderRows, kotRows, billingStates] = await Promise.all([
    listOrdersForBookings(ctx, bookingIds),
    listKotStatusesForBookings(ctx, bookingIds),
    listBookingBillingStates(ctx, bookingIds),
  ])

  const ordersByBooking: Record<string, OrderSummary[]> = {}
  // Distinct open orders per booking (a left-joined item row would otherwise
  // double-count the same order once per item).
  const openOrderIdsByBooking: Record<string, Set<string>> = {}
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
      })
    }
    if (row.status === 'open') {
      const set = (openOrderIdsByBooking[row.bookingId] ??= new Set())
      set.add(row.orderId)
    }
  }

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
  }))
  const popularItemIds = popularItemRows.map((r) => r.menuItemId)
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
        }
      })}
      categories={categories}
      menuItems={menuItems}
      happyHours={happyHours}
      popularItemIds={popularItemIds}
      ordersByBooking={ordersByBooking}
    />
  )
}
