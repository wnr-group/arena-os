import 'server-only'
import { cache } from 'react'
import { and, asc, eq, inArray } from 'drizzle-orm'
import { withPublicTenant } from '@/db'
import { menuCategories, menuItems } from '@/db/schema'

export type PublicMenuItem = {
  id: string
  name: string
  description: string | null
  price: string
  imageUrl: string | null
  // false for 'out_of_stock' — still shown (greyed out / "Sold out"), unlike
  // 'hidden' which never reaches this reader at all. See 0049_public_order_
  // create.sql for the matching menu_items_public_select widening.
  available: boolean
}

export type PublicMenuCategory = {
  id: string
  name: string
  items: PublicMenuItem[]
}

/**
 * The tenant's public food menu — active categories, every item except
 * 'hidden' ones. 'out_of_stock' items ARE included (available: false) so a
 * customer sees they exist but can't be ordered, rather than the item
 * silently vanishing from a menu they were just looking at. No tax rate, no
 * happy-hour flag: nothing a browsing customer needs from this reader itself
 * — see lib/happy-hours/public.ts for the separate happy-hour preview.
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
        status: menuItems.status,
      })
      .from(menuCategories)
      .innerJoin(
        menuItems,
        and(eq(menuItems.categoryId, menuCategories.id), inArray(menuItems.status, ['available', 'out_of_stock'])),
      )
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
      available: row.status === 'available',
    })
  }
  return [...byCategory.values()]
})
