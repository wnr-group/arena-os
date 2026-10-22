import { redirect } from 'next/navigation'
import { asc, eq } from 'drizzle-orm'
import { getActiveContext } from '@/lib/tenant/context'
import { withUser } from '@/db'
import { kitchenStations, menuCategories, menuItems } from '@/db/schema'
import { isManager } from '@/lib/auth/roles'
import { hasEntitlement } from '@/lib/platform/entitlement-guard'
import { StationsManager } from '@/components/kitchen/StationsManager'

export default async function StationsPage() {
  const ctx = await getActiveContext()
  if (!ctx) return null
  if (!isManager(ctx.role) || ctx.tenant.industry !== 'restaurant' || !(await hasEntitlement(ctx, 'module.kitchen_display'))) {
    redirect('/kitchen')
  }

  const { stations, categories, items } = await withUser(ctx.user.id, async (tx) => ({
    stations: await tx
      .select({ id: kitchenStations.id, name: kitchenStations.name, isActive: kitchenStations.isActive })
      .from(kitchenStations)
      .where(eq(kitchenStations.tenantId, ctx.tenant.id))
      .orderBy(asc(kitchenStations.sortOrder), asc(kitchenStations.name)),
    categories: await tx
      .select({ id: menuCategories.id, name: menuCategories.name, stationId: menuCategories.stationId })
      .from(menuCategories)
      .where(eq(menuCategories.tenantId, ctx.tenant.id))
      .orderBy(asc(menuCategories.sortOrder), asc(menuCategories.name)),
    items: await tx
      .select({ id: menuItems.id, name: menuItems.name, categoryId: menuItems.categoryId, stationId: menuItems.stationId })
      .from(menuItems)
      .where(eq(menuItems.tenantId, ctx.tenant.id))
      .orderBy(asc(menuItems.sortOrder), asc(menuItems.name)),
  }))

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6 lg:px-8">
      <h1 className="text-2xl font-semibold">Kitchen stations</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Each dish goes to its own station&apos;s screen. A dish&apos;s station wins; otherwise its category&apos;s. Orders already in the
        kitchen keep the station they were sent to.
      </p>
      <StationsManager stations={stations} categories={categories} items={items} />
    </div>
  )
}
