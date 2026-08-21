import 'server-only'
import { cache } from 'react'
import { and, asc, eq } from 'drizzle-orm'
import { withPublicTenant } from '@/db'
import { menuCategories, menuItems } from '@/db/schema'

export type PublicMenuItem = {
  id: string
  name: string
  description: string | null
  price: string
  imageUrl: string | null
}

export type PublicMenuCategory = {
  id: string
  name: string
  items: PublicMenuItem[]
}

/**
 * The tenant's public food menu — active categories, available items only.
 * No tax rate, no happy-hour flag: nothing a browsing customer needs, same
 * "only what a stranger needs" discipline as lib/booking/public-availability.ts.
 */
export const getPublicMenu = cache(async function getPublicMenu(tenantId: string): Promise<PublicMenuCategory[]> {
  const rows = await withPublicTenant(tenantId, (tx) =>
    tx
      .select({
        categoryId: menuCategories.id,
        categoryName: menuCategories.name,
        itemId: menuItems.id,
        itemName: menuItems.name,
        description: menuItems.description,
        price: menuItems.price,
        imageUrl: menuItems.imageUrl,
      })
      .from(menuCategories)
      .innerJoin(menuItems, and(eq(menuItems.categoryId, menuCategories.id), eq(menuItems.status, 'available')))
      .where(and(eq(menuCategories.tenantId, tenantId), eq(menuCategories.isActive, true)))
      .orderBy(asc(menuCategories.sortOrder), asc(menuCategories.name), asc(menuItems.sortOrder), asc(menuItems.name)),
  )

  const byCategory = new Map<string, PublicMenuCategory>()
  for (const row of rows) {
    let category = byCategory.get(row.categoryId)
    if (!category) {
      category = { id: row.categoryId, name: row.categoryName, items: [] }
      byCategory.set(row.categoryId, category)
    }
    category.items.push({
      id: row.itemId,
      name: row.itemName,
      description: row.description,
      price: row.price,
      imageUrl: row.imageUrl,
    })
  }
  return [...byCategory.values()]
})
