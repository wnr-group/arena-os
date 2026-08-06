import { redirect } from 'next/navigation'
import { getActiveContext } from '@/lib/tenant/context'
import { isManager } from '@/lib/auth/roles'
import { listMenuCategories, listTaxRates, listMenuItems } from '@/lib/menu/data'
import { MenuManager } from '@/components/settings/MenuManager'

export default async function MenuSettingsPage() {
  const ctx = await getActiveContext()
  if (!ctx) return null
  if (!isManager(ctx.role)) redirect('/dashboard')

  const [categories, taxRates, items] = await Promise.all([
    listMenuCategories(ctx),
    listTaxRates(ctx),
    listMenuItems(ctx),
  ])

  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      <h1 className="text-2xl font-semibold">Menu</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Manage menu categories, tax rates, and items — price, tax, image, and availability.
      </p>
      <MenuManager
        currency={ctx.tenant.currency}
        categories={categories.map((c) => ({
          id: c.id,
          name: c.name,
          sortOrder: c.sortOrder,
          isActive: c.isActive,
        }))}
        taxRates={taxRates.map((t) => ({
          id: t.id,
          name: t.name,
          percent: t.percent,
          isActive: t.isActive,
        }))}
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
