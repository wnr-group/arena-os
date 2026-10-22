import { redirect } from 'next/navigation'
import { and, eq } from 'drizzle-orm'
import { getActiveContext } from '@/lib/tenant/context'
import { isManager } from '@/lib/auth/roles'
import { withUser } from '@/db'
import { branches } from '@/db/schema'
import { hasEntitlement } from '@/lib/platform/entitlement-guard'
import { listMenuItems } from '@/lib/menu/data'
import { getModifierCostInputs, listRecentMovements, listRecipeRows, listStockItems } from '@/lib/inventory/data'
import { InventoryManager } from '@/components/inventory/InventoryManager'

/**
 * Inventory (M10): stock items, the movement ledger, and menu → stock recipes.
 * Owner/manager + plan with Inventory; every action re-checks both.
 */
export default async function InventoryPage() {
  const ctx = await getActiveContext()
  if (!ctx) return null
  if (!isManager(ctx.role)) redirect('/dashboard')
  if (!(await hasEntitlement(ctx, 'module.inventory'))) redirect('/dashboard')

  const [branch] = await withUser(ctx.user.id, (tx) =>
    tx
      .select({ id: branches.id })
      .from(branches)
      .where(and(eq(branches.tenantId, ctx.tenant.id), eq(branches.isPrimary, true)))
      .limit(1),
  )
  if (!branch) return <div className="p-6 text-sm text-muted-foreground">No branch configured.</div>

  const [items, recipes, menu, movements, mods] = await Promise.all([
    listStockItems(ctx, branch.id),
    listRecipeRows(ctx),
    listMenuItems(ctx),
    listRecentMovements(ctx),
    getModifierCostInputs(ctx),
  ])

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
      <h1 className="text-2xl font-semibold">Inventory</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Track what you hold, and link dishes to ingredients so stock comes off automatically when they&apos;re sold.
      </p>
      <InventoryManager
        branchId={branch.id}
        timeZone={ctx.tenant.timezone}
        currency={ctx.tenant.currency}
        items={items}
        recipes={recipes}
        options={mods.options}
        optionRecipes={mods.optionRecipes}
        menuGroups={mods.menuGroups}
        menu={menu.map((m) => ({ id: m.id, name: m.name, price: Number(m.price) }))}
        movements={movements.map((m) => ({ id: m.id, stockItemId: m.stockItemId, delta: m.delta, reason: m.reason, sourceType: m.sourceType, at: m.createdAt.toISOString() }))}
      />
    </div>
  )
}
