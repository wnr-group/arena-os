import 'server-only'
import { and, asc, desc, eq } from 'drizzle-orm'
import { withUser } from '@/db'
import { menuItemIngredients, stockItems, stockMovements } from '@/db/schema'
import type { ActiveContext } from '@/lib/tenant/context'

export type StockRow = {
  id: string
  name: string
  unit: string
  quantity: number
  reorderLevel: number
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
        active: stockItems.active,
      })
      .from(stockItems)
      .where(and(eq(stockItems.tenantId, ctx.tenant.id), eq(stockItems.branchId, branchId)))
      .orderBy(desc(stockItems.active), asc(stockItems.name))
    return rows.map((r) => ({ ...r, quantity: Number(r.quantity), reorderLevel: Number(r.reorderLevel) }))
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
