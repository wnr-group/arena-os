import 'server-only'
import { and, desc, eq, gte, sql } from 'drizzle-orm'
import { withUser } from '@/db'
import { customers, invoices, orders } from '@/db/schema'
import type { ActiveContext } from '@/lib/tenant/context'
import { canManageWalkins } from '@/lib/auth/roles'
import { hasEntitlement } from '@/lib/platform/entitlement-guard'
import { COUNTER_ORDERS_MODULE } from './counter'
import { listMenuItems, listMenuItemModifierGroups, groupModifierGroupsByMenuItem } from '@/lib/menu/data'
import { listHappyHours } from '@/lib/happy-hours/data'
import { addDays } from '@/lib/booking/data'
import { todayInZone, zonedTimeToUtc } from '@/lib/booking/time'

/**
 * Whether this viewer is offered counter sales at all. A display decision only —
 * createCounterOrder / previewCounterOrder re-check venue type, role and plan
 * server-side, so hiding the button is never the gate.
 */
export async function counterOrdersAvailable(ctx: ActiveContext): Promise<boolean> {
  if (ctx.tenant.industry === 'restaurant') return false
  if (!canManageWalkins(ctx.role)) return false
  return hasEntitlement(ctx, COUNTER_ORDERS_MODULE)
}

export type CounterSaleRow = {
  orderId: string
  orderNumber: string
  createdAt: Date
  customerName: string | null
  customerPhone: string | null
  invoiceId: string
  invoiceNumber: string
  total: string
  method: string | null
  /** 'paid' | 'refunded' | 'void' — what the till sees now, not what happened first. */
  status: 'paid' | 'refunded' | 'void'
}

/**
 * Counter sales for a branch over the last `days` days (today included), newest
 * first. Only order_type = 'counter' — a booking's food is never listed here —
 * and tenant-scoped by the query as well as by RLS.
 */
export async function listCounterSales(ctx: ActiveContext, branchId: string, days = 7): Promise<CounterSaleRow[]> {
  const tz = ctx.tenant.timezone
  const since = zonedTimeToUtc(addDays(todayInZone(tz), -(days - 1)), '00:00', tz)
  const rows = await withUser(ctx.user.id, (tx) =>
    tx
      .select({
        orderId: orders.id,
        orderNumber: orders.orderNumber,
        createdAt: orders.createdAt,
        customerName: customers.name,
        customerPhone: customers.phone,
        invoiceId: invoices.id,
        invoiceNumber: invoices.invoiceNumber,
        total: invoices.total,
        invoiceStatus: invoices.status,
        method: sql<string | null>`(select p.method::text from payments p where p.invoice_id = ${invoices.id} and p.status in ('captured','refunded') order by p.created_at limit 1)`,
        refunded: sql<boolean>`exists (select 1 from payments p where p.invoice_id = ${invoices.id} and p.status = 'refunded')`,
      })
      .from(orders)
      .innerJoin(invoices, and(eq(invoices.id, orders.invoiceId), eq(invoices.tenantId, orders.tenantId)))
      .leftJoin(customers, eq(customers.id, orders.customerId))
      .where(
        and(
          eq(orders.tenantId, ctx.tenant.id),
          eq(orders.branchId, branchId),
          eq(orders.orderType, 'counter'),
          gte(orders.createdAt, since),
        ),
      )
      .orderBy(desc(orders.createdAt))
      .limit(100),
  )
  return rows.map((r) => ({
    orderId: r.orderId,
    orderNumber: r.orderNumber,
    createdAt: r.createdAt,
    customerName: r.customerName,
    customerPhone: r.customerPhone,
    invoiceId: r.invoiceId,
    invoiceNumber: r.invoiceNumber,
    total: r.total,
    method: r.method,
    status: r.invoiceStatus === 'void' ? 'void' : r.refunded ? 'refunded' : 'paid',
  }))
}

/** The menu a counter sale can order from — same shape the Take order dialog already takes. */
export async function loadCounterMenu(ctx: ActiveContext, branchId: string) {
  void branchId
  const [menuItemRows, happyHourRows, groupRows] = await Promise.all([
    listMenuItems(ctx),
    listHappyHours(ctx),
    listMenuItemModifierGroups(ctx),
  ])
  const groups = groupModifierGroupsByMenuItem(groupRows)
  const orderable = menuItemRows.filter((i) => i.status !== 'hidden')
  const categoryMap = new Map<string, string>()
  for (const i of orderable) categoryMap.set(i.categoryId, i.categoryName)
  return {
    categories: [...categoryMap.entries()].map(([id, name]) => ({ id, name })),
    menuItems: orderable.map((i) => ({
      id: i.id,
      name: i.name,
      price: i.price,
      categoryId: i.categoryId,
      categoryName: i.categoryName,
      taxPercent: i.taxPercent,
      status: i.status,
      modifierGroups: groups.get(i.id) ?? [],
    })),
    happyHours: happyHourRows.map((h) => ({
      id: h.id,
      name: h.name,
      daysOfWeek: h.daysOfWeek,
      startTime: h.startTime,
      endTime: h.endTime,
      discountType: h.discountType,
      discountValue: h.discountValue,
      isActive: h.isActive,
    })),
  }
}
