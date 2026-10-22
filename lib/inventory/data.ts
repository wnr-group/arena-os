import 'server-only'
import { and, asc, desc, eq } from 'drizzle-orm'
import { withUser } from '@/db'
import { menuItemIngredients, menuItemModifierGroups, menuItems, modifierGroups, modifierOptionIngredients, modifierOptions, stockItems, stockMovements } from '@/db/schema'
import type { ActiveContext } from '@/lib/tenant/context'

export type StockRow = {
  id: string
  name: string
  unit: string
  quantity: number
  reorderLevel: number
  /** Current cost of one unit; null = not costed. */
  unitCost: number | null
  active: boolean
}

export function listStockItems(ctx: ActiveContext, branchId: string): Promise<StockRow[]> {
  return withUser(ctx.user.id, async (tx) => {
    const rows = await tx
      .select({
        id: stockItems.id,
        name: stockItems.name,
        unit: stockItems.unit,
        quantity: stockItems.quantity,
        reorderLevel: stockItems.reorderLevel,
        unitCost: stockItems.unitCost,
        active: stockItems.active,
      })
      .from(stockItems)
      .where(and(eq(stockItems.tenantId, ctx.tenant.id), eq(stockItems.branchId, branchId)))
      .orderBy(desc(stockItems.active), asc(stockItems.name))
    return rows.map((r) => ({
      ...r,
      quantity: Number(r.quantity),
      reorderLevel: Number(r.reorderLevel),
      unitCost: r.unitCost === null ? null : Number(r.unitCost),
    }))
  })
}

export type RecipeRow = { menuItemId: string; stockItemId: string; quantity: number }

export function listRecipeRows(ctx: ActiveContext): Promise<RecipeRow[]> {
  return withUser(ctx.user.id, async (tx) => {
    const rows = await tx
      .select({ menuItemId: menuItemIngredients.menuItemId, stockItemId: menuItemIngredients.stockItemId, quantity: menuItemIngredients.quantity })
      .from(menuItemIngredients)
      .where(eq(menuItemIngredients.tenantId, ctx.tenant.id))
    return rows.map((r) => ({ ...r, quantity: Number(r.quantity) }))
  })
}

export type MovementRow = { id: string; stockItemId: string; delta: number; reason: string | null; sourceType: string; createdAt: Date }

/** Most recent ledger entries (all items) — what the "History" panel shows. */
export function listRecentMovements(ctx: ActiveContext, limit = 40): Promise<MovementRow[]> {
  return withUser(ctx.user.id, async (tx) => {
    const rows = await tx
      .select({
        id: stockMovements.id,
        stockItemId: stockMovements.stockItemId,
        delta: stockMovements.delta,
        reason: stockMovements.reason,
        sourceType: stockMovements.sourceType,
        createdAt: stockMovements.createdAt,
      })
      .from(stockMovements)
      .where(eq(stockMovements.tenantId, ctx.tenant.id))
      .orderBy(desc(stockMovements.createdAt))
      .limit(limit)
    return rows.map((r) => ({ ...r, delta: Number(r.delta) }))
  })
}

export type ModifierOptionRow = { optionId: string; groupId: string; groupName: string; optionName: string }
export type OptionRecipeRow = { optionId: string; stockItemId: string; quantity: number }

/** Every modifier option (with its group) plus which ones carry ingredients, and the menu→group links. */
export function getModifierCostInputs(ctx: ActiveContext) {
  return withUser(ctx.user.id, async (tx) => {
    const options = await tx
      .select({ optionId: modifierOptions.id, groupId: modifierOptions.groupId, groupName: modifierGroups.name, optionName: modifierOptions.name })
      .from(modifierOptions)
      .innerJoin(modifierGroups, eq(modifierGroups.id, modifierOptions.groupId))
      .where(eq(modifierOptions.tenantId, ctx.tenant.id))
      .orderBy(asc(modifierGroups.name), asc(modifierOptions.sortOrder), asc(modifierOptions.name))
    const optionRecipes = await tx
      .select({ optionId: modifierOptionIngredients.optionId, stockItemId: modifierOptionIngredients.stockItemId, quantity: modifierOptionIngredients.quantity })
      .from(modifierOptionIngredients)
      .where(eq(modifierOptionIngredients.tenantId, ctx.tenant.id))
    const menuGroups = await tx
      .select({ menuItemId: menuItemModifierGroups.menuItemId, groupId: menuItemModifierGroups.groupId })
      .from(menuItemModifierGroups)
      .where(eq(menuItemModifierGroups.tenantId, ctx.tenant.id))
    return {
      options: options as ModifierOptionRow[],
      optionRecipes: optionRecipes.map((r) => ({ ...r, quantity: Number(r.quantity) })) as OptionRecipeRow[],
      menuGroups,
    }
  })
}

export function listMenuPrices(ctx: ActiveContext) {
  return withUser(ctx.user.id, async (tx) => {
    const rows = await tx
      .select({ id: menuItems.id, name: menuItems.name, price: menuItems.price })
      .from(menuItems)
      .where(eq(menuItems.tenantId, ctx.tenant.id))
      .orderBy(asc(menuItems.name))
    return rows.map((r) => ({ id: r.id, name: r.name, price: Number(r.price) }))
  })
}

/** Tenant-wide ingredient costs (any branch) — what the food-cost table prices recipes with. */
export function listStockCosts(ctx: ActiveContext) {
  return withUser(ctx.user.id, async (tx) => {
    const rows = await tx
      .select({ id: stockItems.id, unitCost: stockItems.unitCost })
      .from(stockItems)
      .where(eq(stockItems.tenantId, ctx.tenant.id))
    return rows.map((r) => ({ id: r.id, unitCost: r.unitCost === null ? null : Number(r.unitCost) }))
  })
}
