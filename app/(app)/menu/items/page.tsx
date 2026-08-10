import { redirect } from 'next/navigation'
import { getActiveContext } from '@/lib/tenant/context'
import { isManager } from '@/lib/auth/roles'
import { listMenuCategories, listMenuItems, listTaxRates } from '@/lib/menu/data'
import { MenuItemsManager } from '@/components/settings/MenuItemsManager'

export default async function MenuItemsPage() {
  const ctx = await getActiveContext()
  if (!ctx) return null
  if (!isManager(ctx.role)) redirect('/dashboard')

  const [categories, items, taxRates] = await Promise.all([
    listMenuCategories(ctx),
    listMenuItems(ctx),
    listTaxRates(ctx),
  ])

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
      />
    </div>
  )
}
