import 'server-only'
import { asc, eq } from 'drizzle-orm'
import { withUser } from '@/db'
import { menuCategories, menuItems, taxRates } from '@/db/schema'
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
