import { and, eq } from 'drizzle-orm'
import { getActiveContext, type ActiveContext } from '@/lib/tenant/context'
import { sweepTenantHolds } from '@/lib/booking/payment-hold'
import { canManageIncomingOrders, canManageKitchen, canManageWalkins, isManager } from '@/lib/auth/roles'
import { withUser } from '@/db'
import { branches } from '@/db/schema'
import { listResources, getWorkingHours, listDayBookings, listRangeBookings, addDays } from '@/lib/booking/data'
import { todayInZone, weekdayInZone } from '@/lib/booking/time'
import { parseRangePreset, resolveRange } from '@/lib/booking/ranges'
import { listMenuItems, listMostOrderedItemIds, listMenuItemModifierGroups, groupModifierGroupsByMenuItem } from '@/lib/menu/data'
import { listOrdersForBookings, listOrderItemModifierNames } from '@/lib/orders/data'
import { listDepositStates } from '@/lib/payments/data'
import { listBookingPaymentStates } from '@/lib/billing/data'
import { listHappyHours } from '@/lib/happy-hours/data'
import { industryHasStudioSetups } from '@/lib/booking/studio-setups'
import { BookingsView, type OrderSummary } from '@/components/bookings/BookingsView'
import { BookingsRangeView } from '@/components/bookings/BookingsRangeView'
import { BookingsRangeList } from '@/components/bookings/BookingsRangeList'
import { Pager } from '@/components/portal/Pager'
import { rangeSpan, rangeSummary } from '@/components/bookings/RangePresetBar'

/**
 * Everything the booking detail panel needs per booking id — food orders (with
 * modifier names for restaurants), till state and online-deposit state. Shared
 * by the single-day timeline and the multi-day list so both feed the same panel.
 */
async function loadBookingExtras(ctx: ActiveContext, bookingIds: string[], isRestaurant: boolean) {
  const orderRows = await listOrdersForBookings(ctx, bookingIds)
  const orderItemIds = orderRows.map((r) => r.itemId).filter((id): id is string => id !== null)
  const modifiersByOrderItem = isRestaurant
    ? await listOrderItemModifierNames(ctx, orderItemIds)
    : new Map<string, string[]>()
  // Where each booking stands with the till — billed, part-paid, settled.
  const paymentStates = await listBookingPaymentStates(ctx, bookingIds)

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
        modifiers: modifiersByOrderItem.get(row.itemId) ?? [],
      })
    }
  }

  return { ordersByBooking, paymentStates, depositStates }
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

function isRealDate(raw: unknown): raw is string {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return false
  const [y, m, d] = raw.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d))
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d
}

export default async function BookingsPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string; range?: string; page?: string }>
}) {
  const ctx = await getActiveContext()
  if (!ctx) return null
  // Release lapsed unpaid online holds so the calendar/availability never shows a dead slot as taken.
  await sweepTenantHolds(ctx.tenant.id)
  const tz = ctx.tenant.timezone
  const sp = await searchParams
  const today = todayInZone(tz)
  // Precedence: valid ?date= (single-day timeline) -> valid ?range= -> today.
  const validDate = isRealDate(sp.date) ? sp.date : null
  const preset = validDate ? null : parseRangePreset(sp.range)
  const range = preset ? resolveRange(preset, today, tz) : null
  // Yesterday is one day: same timeline as ?date=<yesterday>, canonical ?range=yesterday.
  const date = validDate ?? (range?.isSingleDay ? range.fromDate : today)

  const [branch] = await withUser(ctx.user.id, (tx) =>
    tx
      .select({ id: branches.id, name: branches.name })
      .from(branches)
      .where(and(eq(branches.tenantId, ctx.tenant.id), eq(branches.isPrimary, true)))
      .limit(1),
  )
  if (!branch) return <div className="p-6 text-sm text-muted-foreground">No branch configured.</div>

  // Void/comp (M17 #6) and modifiers (M17 #8) are restaurant-only — every
  // other industry gets neither the request button nor a modifier picker on
  // this cross-industry order screen, same scoping as /floor's own gate.
  const isRestaurant = ctx.tenant.industry === 'restaurant'
  // A studio tenant (recording_studio/podcast_studio/dance_studio/
  // vr_centre) doesn't sell food — hides "Take order" and the per-booking
  // Food orders panel entirely on this page. Every other industry
  // (gaming_cafe, restaurant) is unaffected.
  const showFoodOrdering = !industryHasStudioSetups(ctx.tenant.industry)

  // Multi-day presets skip the single-day loaders below (timeline, menu); the
  // list loads one page of bookings plus what the shared detail panel needs.
  if (range && !range.isSingleDay) {
    const result = await listRangeBookings(ctx, branch.id, range.startUtc, range.endUtc, {
      page: Number(sp.page),
    })
    const { ordersByBooking, paymentStates, depositStates } = await loadBookingExtras(
      ctx,
      result.rows.map((r) => r.bookingId),
      isRestaurant,
    )
    const pageCount = Math.max(1, Math.ceil(result.total / result.pageSize))
    const rangeHref = (n: number) => `/bookings?range=${range.preset}${n > 1 ? `&page=${n}` : ''}`
    return (
      <BookingsRangeView branchName={branch.name} preset={range.preset} summary={rangeSummary(range)}>
        <BookingsRangeList
          rows={result.rows.map((r) => ({
            bookingId: r.bookingId,
            bookingNumber: r.bookingNumber,
            customerName: r.customerName,
            customerPhone: r.customerPhone,
            status: r.status,
            source: r.source,
            total: r.total,
            deposit: r.deposit,
            cancellationReason: r.cancellationReason,
            paymentHoldExpiresAt: r.paymentHoldExpiresAt?.toISOString() ?? null,
            depositReviewRequired: r.depositReviewRequired,
            backdated: r.backdated,
            bookingCreatedAt: r.bookingCreatedAt.toISOString(),
            firstStartsAt: r.firstStartsAt.toISOString(),
            lastEndsAt: r.lastEndsAt ? r.lastEndsAt.toISOString() : null,
            isOpen: r.isOpen,
            resourceNames: r.resourceNames ?? [],
            slotsTotal: r.slotsTotal,
            activeSlotsTotal: r.activeSlotsTotal,
            advancePaid: r.advancePaid,
          }))}
          fromDate={range.fromDate}
          rangeLabel={rangeSpan(range)}
          summary={result.summary}
          timeZone={tz}
          currency={ctx.tenant.currency}
          venueName={ctx.tenant.name}
          paymentStates={paymentStates}
          depositStates={depositStates}
          ordersByBooking={ordersByBooking}
          canRequestVoidComp={isRestaurant && canManageIncomingOrders(ctx.role)}
          canEditAddons={canManageWalkins(ctx.role)}
          showFoodOrdering={showFoodOrdering}
          footer={
            <Pager
              info={{ page: result.page, pageSize: result.pageSize, total: result.total, pageCount }}
              label="Bookings"
              hrefFor={rangeHref}
            />
          }
        />
      </BookingsRangeView>
    )
  }

  const [allResources, hours, slots, menuItemRows, happyHourRows, popularItemRows, menuItemGroupRows] =
    await Promise.all([
      listResources(ctx, branch.id),
      getWorkingHours(ctx, branch.id),
      listDayBookings(ctx, branch.id, date, tz),
      listMenuItems(ctx),
      listHappyHours(ctx),
      listMostOrderedItemIds(ctx, branch.id),
      isRestaurant ? listMenuItemModifierGroups(ctx) : Promise.resolve([]),
    ])
  const modifierGroupsByItem = groupModifierGroupsByMenuItem(menuItemGroupRows)

  const bookingIds = [...new Set(slots.map((s) => s.bookingId))]
  const { ordersByBooking, paymentStates, depositStates } = await loadBookingExtras(ctx, bookingIds, isRestaurant)

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
    modifierGroups: modifierGroupsByItem.get(i.id) ?? [],
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
      today={today}
      activeRange={range?.preset ?? null}
      hasExplicitDate={validDate !== null}
      closed={closed}
      openMin={openMin}
      closeMin={closeMin}
      resources={resources}
      happyHours={happyHours}
      slots={slots.map((s) => ({
        slotId: s.slotId,
        resourceId: s.resourceId,
        startsAt: s.startsAt.toISOString(),
        endsAt: s.endsAt ? s.endsAt.toISOString() : null,
        bookingId: s.bookingId,
        bookingNumber: s.bookingNumber,
        customerName: s.customerName,
        customerPhone: s.customerPhone,
        status: s.status,
        source: s.source,
        total: s.total,
        deposit: s.deposit,
        slotTotal: s.slotTotal,
        advancePaid: s.advancePaid,
        bookingActiveSlotTotal: s.bookingActiveSlotTotal,
        active: s.active,
        cancellationReason: s.cancellationReason,
        backdated: s.backdated,
        bookingCreatedAt: s.bookingCreatedAt.toISOString(),
      }))}
      categories={categories}
      menuItems={menuItems}
      popularItemIds={popularItemIds}
      ordersByBooking={ordersByBooking}
      venueName={ctx.tenant.name}
      depositStates={depositStates}
      paymentStates={paymentStates}
      canRequestVoidComp={isRestaurant && canManageIncomingOrders(ctx.role)}
      canToggle86={canManageKitchen(ctx.role)}
      showFoodOrdering={showFoodOrdering}
      canRecordBackdated={isManager(ctx.role)}
      canEditAddons={canManageWalkins(ctx.role)}
    />
  )
}
