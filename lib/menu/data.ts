import 'server-only'
import { and, asc, desc, eq, gte, ne, sql } from 'drizzle-orm'
import { withUser } from '@/db'
import { menuCategories, menuItems, orderItems, orders, taxRates } from '@/db/schema'
import type { ActiveContext } from '@/lib/tenant/context'

export { listTaxRates } from '@/lib/tax-rates/data'

export function listMenuCategories(ctx: ActiveContext) {
  return withUser(ctx.user.id, (tx) =>
    tx
      .select()
      .from(menuCategories)
      .where(eq(menuCategories.tenantId, ctx.tenant.id))
      .orderBy(asc(menuCategories.sortOrder), asc(menuCategories.name)),
  )
}

/** Menu items joined with their category name and (optional) tax rate. */
export function listMenuItems(ctx: ActiveContext) {
  return withUser(ctx.user.id, (tx) =>
    tx
      .select({
        id: menuItems.id,
        name: menuItems.name,
        description: menuItems.description,
        price: menuItems.price,
        status: menuItems.status,
        imageUrl: menuItems.imageUrl,
        sortOrder: menuItems.sortOrder,
        categoryId: menuItems.categoryId,
        categoryName: menuCategories.name,
        taxRateId: menuItems.taxRateId,
        taxRateName: taxRates.name,
        taxPercent: taxRates.percent,
      })
      .from(menuItems)
      .innerJoin(menuCategories, eq(menuCategories.id, menuItems.categoryId))
      .leftJoin(taxRates, eq(taxRates.id, menuItems.taxRateId))
      .where(eq(menuItems.tenantId, ctx.tenant.id))
      .orderBy(asc(menuItems.categoryId), asc(menuItems.sortOrder), asc(menuItems.name)),
  )
}

/**
 * The branch's top ordered menu items over a trailing window — the "Popular"
 * quick-add row on the fast-order screen (M17 #3), so a waiter can fire the
 * usual round without searching or hunting through categories. Excludes
 * cancelled orders (never actually served) but otherwise counts every
 * channel, staff and online alike.
 */
export function listMostOrderedItemIds(
  ctx: ActiveContext,
  branchId: string,
  opts: { limit?: number; sinceDays?: number } = {},
) {
  const limit = opts.limit ?? 8
  const since = new Date(Date.now() - (opts.sinceDays ?? 30) * 24 * 60 * 60 * 1000)
  return withUser(ctx.user.id, (tx) =>
    tx
      .select({
        menuItemId: orderItems.menuItemId,
        totalQty: sql<number>`sum(${orderItems.qty})::int`,
      })
      .from(orderItems)
      .innerJoin(orders, eq(orders.id, orderItems.orderId))
      .where(
        and(
          eq(orders.tenantId, ctx.tenant.id),
          eq(orders.branchId, branchId),
          ne(orders.status, 'cancelled'),
          gte(orders.createdAt, since),
        ),
      )
      .groupBy(orderItems.menuItemId)
      .orderBy(desc(sql`sum(${orderItems.qty})`))
      .limit(limit),
  )
}
