import { redirect } from 'next/navigation'
import { and, eq } from 'drizzle-orm'
import { getActiveContext } from '@/lib/tenant/context'
import { withUser } from '@/db'
import { branches } from '@/db/schema'
import { listTables } from '@/lib/booking/data'
import { listMenuItems } from '@/lib/menu/data'
import { listOrdersForBookings } from '@/lib/orders/data'
import { listHappyHours } from '@/lib/happy-hours/data'
import { TablesView } from '@/components/tables/TablesView'
import type { OrderSummary } from '@/components/bookings/BookingsView'

export default async function TablesPage() {
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

  const [tables, menuItemRows, happyHourRows] = await Promise.all([
    listTables(ctx, branch.id),
    listMenuItems(ctx),
    listHappyHours(ctx),
  ])

  const bookingIds = [...new Set(tables.map((t) => t.bookingId).filter((id): id is string => Boolean(id)))]
  const orderRows = await listOrdersForBookings(ctx, bookingIds)

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
      })
    }
  }

  const availableItems = menuItemRows.filter((i) => i.status === 'available')
  const categoryMap = new Map<string, string>()
  for (const i of availableItems) categoryMap.set(i.categoryId, i.categoryName)
  const categories = [...categoryMap.entries()].map(([id, name]) => ({ id, name }))
  const menuItems = availableItems.map((i) => ({
    id: i.id,
    name: i.name,
    price: i.price,
    categoryId: i.categoryId,
    categoryName: i.categoryName,
    taxPercent: i.taxPercent,
  }))
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
    <TablesView
      branchId={branch.id}
      currency={ctx.tenant.currency}
      timeZone={ctx.tenant.timezone}
      tables={tables.map((t) => ({
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
      }))}
      categories={categories}
      menuItems={menuItems}
      happyHours={happyHours}
      ordersByBooking={ordersByBooking}
    />
  )
}
