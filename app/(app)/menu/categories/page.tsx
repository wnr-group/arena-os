import { redirect } from 'next/navigation'
import { getActiveContext } from '@/lib/tenant/context'
import { isManager } from '@/lib/auth/roles'
import { listMenuCategories } from '@/lib/menu/data'
import { MenuCategoriesManager } from '@/components/settings/MenuCategoriesManager'

export default async function MenuCategoriesPage() {
  const ctx = await getActiveContext()
  if (!ctx) return null
  if (!isManager(ctx.role)) redirect('/dashboard')

  const categories = await listMenuCategories(ctx)

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
      <h1 className="text-2xl font-semibold">Menu Categories</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Group menu items into categories such as Starters, Mains, or Drinks.
      </p>
      <MenuCategoriesManager
        categories={categories.map((c) => ({
          id: c.id,
          name: c.name,
          sortOrder: c.sortOrder,
          isActive: c.isActive,
        }))}
      />
    </div>
  )
}
