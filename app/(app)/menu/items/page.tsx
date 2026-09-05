import { redirect } from 'next/navigation'
import { getActiveContext } from '@/lib/tenant/context'
import { isManager } from '@/lib/auth/roles'
import {
  listMenuCategories,
  listMenuItems,
  listTaxRates,
  listModifierGroups,
  listMenuItemModifierGroupLinks,
} from '@/lib/menu/data'
import { MenuItemsManager } from '@/components/settings/MenuItemsManager'

export default async function MenuItemsPage() {
  const ctx = await getActiveContext()
  if (!ctx) return null
  if (!isManager(ctx.role)) redirect('/dashboard')

  // Modifiers are a restaurant-only feature (M17 #8) — skip the extra
  // queries entirely for every other industry, same scoping as /floor and
  // /orders/void-requests.
  const isRestaurant = ctx.tenant.industry === 'restaurant'
  const [categories, items, taxRates, modifierGroupRows, itemGroupLinks] = await Promise.all([
    listMenuCategories(ctx),
    listMenuItems(ctx),
    listTaxRates(ctx),
    isRestaurant ? listModifierGroups(ctx) : Promise.resolve([]),
    isRestaurant ? listMenuItemModifierGroupLinks(ctx) : Promise.resolve([]),
  ])

  // Dedupe to one row per group (listModifierGroups is one row per option).
  const modifierGroupsById = new Map<string, { id: string; name: string }>()
  for (const g of modifierGroupRows) {
    if (!modifierGroupsById.has(g.groupId)) modifierGroupsById.set(g.groupId, { id: g.groupId, name: g.groupName })
  }

  const itemModifierGroupIds: Record<string, string[]> = {}
  for (const link of itemGroupLinks) {
    ;(itemModifierGroupIds[link.menuItemId] ??= []).push(link.groupId)
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
      <h1 className="text-2xl font-semibold">Menu Items</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Price, tax, image, and availability for everything on the menu.
      </p>
      <MenuItemsManager
        currency={ctx.tenant.currency}
        categories={categories.map((c) => ({ id: c.id, name: c.name, isActive: c.isActive }))}
        taxRates={taxRates.map((t) => ({ id: t.id, name: t.name, percent: t.percent }))}
        items={items.map((i) => ({
          id: i.id,
          name: i.name,
          description: i.description,
          price: i.price,
          status: i.status,
          imageUrl: i.imageUrl,
          sortOrder: i.sortOrder,
          categoryId: i.categoryId,
          categoryName: i.categoryName,
          taxRateId: i.taxRateId,
          taxRateName: i.taxRateName,
        }))}
        modifierGroups={[...modifierGroupsById.values()]}
        itemModifierGroupIds={itemModifierGroupIds}
        showModifiers={isRestaurant}
      />
    </div>
  )
}
