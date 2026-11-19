import 'server-only'
import { and, desc, eq, gte, ne, sql } from 'drizzle-orm'
import { withUser } from '@/db'
import { customers, orderItems, orders } from '@/db/schema'
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
  /** The live invoice, or — for a sale awaiting re-bill — the one that was voided. */
  invoiceId: string | null
  invoiceNumber: string | null
  total: string | null
  method: string | null
  /**
   * paid / refunded / void: the live invoice's state.
   * rebill: refunded and voided, the order is open again and waiting to be edited and billed.
   * cancelled: every line was removed after a void.
   */
  status: 'paid' | 'refunded' | 'void' | 'rebill' | 'cancelled'
}

/**
 * Counter sales for a branch over the last `days` days (today included), newest
 * first. Only order_type = 'counter' — a booking's food is never listed here —
 * and tenant-scoped by the query as well as by RLS. A voided sale is detached from
 * its invoice (so it can be billed again); it is found again through the invoice
 * lines that point at its order items.
 */
export async function listCounterSales(ctx: ActiveContext, branchId: string, days = 7): Promise<CounterSaleRow[]> {
  const tz = ctx.tenant.timezone
  const since = zonedTimeToUtc(addDays(todayInZone(tz), -(days - 1)), '00:00', tz)
  const lastInvoice = sql`coalesce(${orders.invoiceId}, (
    select ii.invoice_id from invoice_items ii
      join order_items oi on oi.id = ii.source_id and oi.tenant_id = ii.tenant_id
      join invoices i2 on i2.id = ii.invoice_id
     where oi.order_id = ${orders.id} and ii.tenant_id = ${orders.tenantId} and ii.kind = 'food'
     order by i2.created_at desc limit 1))`
  const rows = await withUser(ctx.user.id, (tx) =>
    tx
      .select({
        orderId: orders.id,
        orderNumber: orders.orderNumber,
        orderStatus: orders.status,
        createdAt: orders.createdAt,
        customerName: customers.name,
        customerPhone: customers.phone,
        invoiceId: sql<string | null>`inv.id`,
        invoiceNumber: sql<string | null>`inv.invoice_number`,
        total: sql<string | null>`inv.total`,
        invoiceStatus: sql<string | null>`inv.status`,
        method: sql<string | null>`(select p.method::text from payments p where p.invoice_id = inv.id and p.status in ('captured','refunded') order by p.created_at limit 1)`,
        refunded: sql<boolean>`exists (select 1 from payments p where p.invoice_id = inv.id and p.status = 'refunded')`,
      })
      .from(orders)
      .leftJoin(sql`invoices inv`, sql`inv.id = ${lastInvoice} and inv.tenant_id = ${orders.tenantId}`)
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
    status:
      r.orderStatus === 'cancelled'
        ? 'cancelled'
        : r.orderStatus === 'open'
          ? 'rebill'
          : r.invoiceStatus === 'void'
            ? 'void'
            : r.refunded
              ? 'refunded'
              : 'paid',
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

export type CounterSaleDetail = {
  orderId: string
  orderNumber: string
  /** billed = live invoice; open = voided, awaiting edit / re-bill; cancelled = nothing left. */
  state: 'billed' | 'open' | 'cancelled'
  customerPhone: string | null
  customerName: string | null
  /** Live invoice (billed) or the voided one (open). */
  invoiceNumber: string | null
  total: string | null
  /** Promo on the latest invoice, to pre-fill the re-bill. */
  promoCode: string | null
  lines: { itemId: string; name: string; qty: number; unitPrice: string }[]
}

/** What the Correct dialog needs for one counter sale (tenant-scoped; null if it is not one). */
export async function loadCounterSaleDetail(ctx: ActiveContext, orderId: string): Promise<CounterSaleDetail | null> {
  return withUser(ctx.user.id, async (tx) => {
    const [o] = await tx
      .select({
        id: orders.id,
        orderNumber: orders.orderNumber,
        status: orders.status,
        orderType: orders.orderType,
        customerName: customers.name,
        customerPhone: customers.phone,
      })
      .from(orders)
      .leftJoin(customers, eq(customers.id, orders.customerId))
      .where(and(eq(orders.id, orderId), eq(orders.tenantId, ctx.tenant.id)))
      .limit(1)
    if (!o || o.orderType !== 'counter') return null

    const inv = await tx.execute<{ invoice_number: string; total: string; code: string | null }>(sql`
      select i.invoice_number, i.total::text as total, pc.code
        from invoice_items ii
        join order_items oi on oi.id = ii.source_id and oi.tenant_id = ii.tenant_id
        join invoices i on i.id = ii.invoice_id and i.tenant_id = ii.tenant_id
        left join promo_codes pc on pc.id = i.promo_code_id and pc.tenant_id = i.tenant_id
       where oi.order_id = ${o.id} and ii.tenant_id = ${ctx.tenant.id} and ii.kind = 'food'
       order by i.created_at desc limit 1`)
    const lines = await tx
      .select({ itemId: orderItems.id, name: orderItems.itemName, qty: orderItems.qty, unitPrice: orderItems.unitPrice })
      .from(orderItems)
      .where(and(eq(orderItems.orderId, o.id), eq(orderItems.tenantId, ctx.tenant.id), ne(orderItems.voidStatus, 'voided')))
      .orderBy(orderItems.id)
    const last = inv.rows[0]
    return {
      orderId: o.id,
      orderNumber: o.orderNumber,
      state: o.status === 'billed' ? 'billed' : o.status === 'cancelled' ? 'cancelled' : 'open',
      customerPhone: o.customerPhone,
      customerName: o.customerName,
      invoiceNumber: last?.invoice_number ?? null,
      total: last?.total ?? null,
      promoCode: last?.code ?? null,
      lines,
    }
  })
}
