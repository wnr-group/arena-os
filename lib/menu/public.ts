import 'server-only'
import { cache } from 'react'
import { and, asc, eq, inArray } from 'drizzle-orm'
import { withPublicTenant } from '@/db'
import { menuCategories, menuItems, menuItemModifierGroups, modifierGroups, modifierOptions } from '@/db/schema'

export type PublicModifierOption = { id: string; name: string; priceDelta: string }
export type PublicModifierGroup = {
  id: string
  name: string
  minSelect: number
  maxSelect: number
  required: boolean
  options: PublicModifierOption[]
}

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
  /** Structured choices (M17 #8) — empty for an item with no groups. */
  modifierGroups: PublicModifierGroup[]
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

  // Modifier groups for every item on this menu, one query — same
  // "read once, group in memory" shape as the category grouping below.
  // modifier_groups_public_select/modifier_options_public_select/
  // menu_item_modifier_groups_public_select (migration 0069) are what make
  // this readable at all under the anonymous public connection.
  const itemIds = rows.map((r) => r.itemId)
  const groupRows =
    itemIds.length === 0
      ? []
      : await withPublicTenant(tenantId, (tx) =>
          tx
            .select({
              menuItemId: menuItemModifierGroups.menuItemId,
              itemGroupSortOrder: menuItemModifierGroups.sortOrder,
              groupId: modifierGroups.id,
              groupName: modifierGroups.name,
              minSelect: modifierGroups.minSelect,
              maxSelect: modifierGroups.maxSelect,
              required: modifierGroups.required,
              optionId: modifierOptions.id,
              optionName: modifierOptions.name,
              priceDelta: modifierOptions.priceDelta,
              optionSortOrder: modifierOptions.sortOrder,
            })
            .from(menuItemModifierGroups)
            .innerJoin(modifierGroups, eq(modifierGroups.id, menuItemModifierGroups.groupId))
            .leftJoin(modifierOptions, eq(modifierOptions.groupId, modifierGroups.id))
            .where(and(eq(menuItemModifierGroups.tenantId, tenantId), inArray(menuItemModifierGroups.menuItemId, itemIds)))
            .orderBy(
              asc(menuItemModifierGroups.sortOrder),
              asc(modifierGroups.sortOrder),
              asc(modifierOptions.sortOrder),
              asc(modifierOptions.name),
            ),
        )

  const groupsByItem = new Map<string, PublicModifierGroup[]>()
  for (const row of groupRows) {
    const groups = groupsByItem.get(row.menuItemId) ?? []
    if (groups.length === 0) groupsByItem.set(row.menuItemId, groups)
    let group = groups.find((g) => g.id === row.groupId)
    if (!group) {
      group = {
        id: row.groupId,
        name: row.groupName,
        minSelect: row.minSelect,
        maxSelect: row.maxSelect,
        required: row.required,
        options: [],
      }
      groups.push(group)
    }
    if (row.optionId) group.options.push({ id: row.optionId, name: row.optionName!, priceDelta: row.priceDelta! })
  }

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
      modifierGroups: groupsByItem.get(row.itemId) ?? [],
    })
  }
  return [...byCategory.values()]
})
