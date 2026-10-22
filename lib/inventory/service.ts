/**
 * Inventory — stock items, the movement ledger and recipes (M10 / AROS-97, 98).
 * Owner/manager only (RLS agrees); the SALE deduction lives in ./deduct.ts.
 */
import 'server-only'
import { and, eq, inArray } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type * as schema from '@/db/schema'
import { auditLog, menuItemIngredients, menuItems, modifierOptionIngredients, modifierOptions, stockItems, stockMovements } from '@/db/schema'
import {
  manualDelta,
  roundCost,
  roundQty,
  validateIngredient,
  validateStockItem,
  validateUnitCost,
  type ManualMovementType,
} from './rules'

type Db = NodePgDatabase<typeof schema>
export type InventoryActor = { tenantId: string; membershipId: string | null }

export class InventoryError extends Error {}

export async function createStockItemCore(
  tx: Db,
  a: InventoryActor,
  input: { branchId: string; name: string; unit: string; reorderLevel: number; openingQuantity?: number; unitCost?: number | null },
): Promise<{ id: string }> {
  const problem = validateStockItem(input) ?? validateUnitCost(input.unitCost)
  if (problem) throw new InventoryError(problem)
  const opening = input.openingQuantity ?? 0
  if (!Number.isFinite(opening) || opening < 0) throw new InventoryError('Opening stock can’t be negative.')

  // Items always start empty — the database insists (quantity = 0) — and the
  // opening balance is the first ledger entry, so the ledger explains every unit.
  const [row] = await tx
    .insert(stockItems)
    .values({
      tenantId: a.tenantId,
      branchId: input.branchId,
      name: input.name.trim(),
      unit: input.unit.trim(),
      reorderLevel: String(roundQty(input.reorderLevel)),
      unitCost: input.unitCost === null || input.unitCost === undefined ? null : String(roundCost(input.unitCost)),
    })
    .returning({ id: stockItems.id })
  if (opening > 0) {
    await tx.insert(stockMovements).values({
      tenantId: a.tenantId,
      stockItemId: row.id,
      delta: String(roundQty(opening)),
      reason: 'Opening balance',
      sourceType: 'opening',
      createdBy: a.membershipId,
    })
  }
  return row
}

export async function updateStockItemCore(
  tx: Db,
  a: InventoryActor,
  id: string,
  /** `unitCost`: a number sets it, null clears it, undefined leaves it alone. */
  input: { name: string; unit: string; reorderLevel: number; active: boolean; unitCost?: number | null },
): Promise<void> {
  const problem = validateStockItem(input) ?? validateUnitCost(input.unitCost)
  if (problem) throw new InventoryError(problem)
  const [before] = await tx
    .select({ unitCost: stockItems.unitCost })
    .from(stockItems)
    .where(and(eq(stockItems.id, id), eq(stockItems.tenantId, a.tenantId)))
    .limit(1)
  const nextCost = input.unitCost === undefined ? undefined : input.unitCost === null ? null : String(roundCost(input.unitCost))
  const rows = await tx
    .update(stockItems)
    .set({
      name: input.name.trim(),
      unit: input.unit.trim(),
      reorderLevel: String(roundQty(input.reorderLevel)),
      active: input.active,
      ...(nextCost !== undefined && { unitCost: nextCost }),
      updatedAt: new Date(),
    })
    .where(and(eq(stockItems.id, id), eq(stockItems.tenantId, a.tenantId)))
    .returning({ id: stockItems.id })
  if (rows.length === 0) throw new InventoryError('Stock item not found.')
  // Food cost follows today's prices, so a price change is worth an audit trail.
  if (nextCost !== undefined && before && (before.unitCost === null ? null : Number(before.unitCost)) !== (nextCost === null ? null : Number(nextCost))) {
    await tx.insert(auditLog).values({
      tenantId: a.tenantId,
      actorMembershipId: a.membershipId,
      action: 'stock_item.cost_changed',
      entityType: 'stock_item',
      entityId: id,
      before: { unit_cost: before.unitCost },
      after: { unit_cost: nextCost },
    })
  }
}

/** Record a purchase / count correction / wastage / opening balance. */
export async function recordMovementCore(
  tx: Db,
  a: InventoryActor,
  input: { stockItemId: string; type: ManualMovementType; amount: number; reason?: string },
): Promise<{ id: string; delta: number }> {
  const delta = manualDelta(input.type, input.amount)
  if (typeof delta === 'string') throw new InventoryError(delta)
  const [item] = await tx
    .select({ id: stockItems.id, active: stockItems.active })
    .from(stockItems)
    .where(and(eq(stockItems.id, input.stockItemId), eq(stockItems.tenantId, a.tenantId)))
    .limit(1)
  if (!item) throw new InventoryError('Stock item not found.')
  if (!item.active) throw new InventoryError('This stock item is archived.')
  const [row] = await tx
    .insert(stockMovements)
    .values({
      tenantId: a.tenantId,
      stockItemId: item.id,
      delta: String(delta),
      reason: input.reason?.trim() || null,
      sourceType: input.type,
      createdBy: a.membershipId,
    })
    .returning({ id: stockMovements.id })
  return { id: row.id, delta }
}

/**
 * Replace a menu item's recipe. An empty list removes the recipe entirely — the
 * item is then "unlinked" and never deducted. Past sales are untouched: a recipe
 * only governs orders billed AFTER the change.
 */
export async function setRecipeCore(
  tx: Db,
  a: InventoryActor,
  menuItemId: string,
  ingredients: { stockItemId: string; quantity: number }[],
): Promise<{ count: number }> {
  const [menu] = await tx
    .select({ id: menuItems.id, name: menuItems.name })
    .from(menuItems)
    .where(and(eq(menuItems.id, menuItemId), eq(menuItems.tenantId, a.tenantId)))
    .limit(1)
  if (!menu) throw new InventoryError('Menu item not found.')

  const ids = ingredients.map((i) => i.stockItemId)
  if (new Set(ids).size !== ids.length) throw new InventoryError('List each ingredient once.')
  for (const i of ingredients) {
    const p = validateIngredient(i)
    if (p) throw new InventoryError(p)
  }
  if (ids.length > 0) {
    const found = await tx
      .select({ id: stockItems.id })
      .from(stockItems)
      .where(and(eq(stockItems.tenantId, a.tenantId), eq(stockItems.active, true), inArray(stockItems.id, ids)))
    if (found.length !== ids.length) throw new InventoryError('An ingredient is missing or archived.')
  }

  await tx.delete(menuItemIngredients).where(and(eq(menuItemIngredients.menuItemId, menu.id), eq(menuItemIngredients.tenantId, a.tenantId)))
  if (ingredients.length > 0) {
    await tx.insert(menuItemIngredients).values(
      ingredients.map((i) => ({
        tenantId: a.tenantId,
        menuItemId: menu.id,
        stockItemId: i.stockItemId,
        quantity: String(roundQty(i.quantity)),
      })),
    )
  }
  await tx.insert(auditLog).values({
    tenantId: a.tenantId,
    actorMembershipId: a.membershipId,
    action: 'menu_item.recipe_set',
    entityType: 'menu_item',
    entityId: menu.id,
    before: {},
    after: { item_name: menu.name, ingredients: ingredients.length },
  })
  return { count: ingredients.length }
}

/**
 * Replace a modifier option's ingredients ("Extra cheese" = 0.03 kg Cheese).
 * Like a dish recipe: empty list = not linked; only orders billed afterwards
 * are affected.
 */
export async function setModifierRecipeCore(
  tx: Db,
  a: InventoryActor,
  optionId: string,
  ingredients: { stockItemId: string; quantity: number }[],
): Promise<{ count: number }> {
  const [opt] = await tx
    .select({ id: modifierOptions.id, name: modifierOptions.name })
    .from(modifierOptions)
    .where(and(eq(modifierOptions.id, optionId), eq(modifierOptions.tenantId, a.tenantId)))
    .limit(1)
  if (!opt) throw new InventoryError('Modifier option not found.')

  const ids = ingredients.map((i) => i.stockItemId)
  if (new Set(ids).size !== ids.length) throw new InventoryError('List each ingredient once.')
  for (const i of ingredients) {
    const p = validateIngredient(i)
    if (p) throw new InventoryError(p)
  }
  if (ids.length > 0) {
    const found = await tx
      .select({ id: stockItems.id })
      .from(stockItems)
      .where(and(eq(stockItems.tenantId, a.tenantId), eq(stockItems.active, true), inArray(stockItems.id, ids)))
    if (found.length !== ids.length) throw new InventoryError('An ingredient is missing or archived.')
  }

  await tx
    .delete(modifierOptionIngredients)
    .where(and(eq(modifierOptionIngredients.optionId, opt.id), eq(modifierOptionIngredients.tenantId, a.tenantId)))
  if (ingredients.length > 0) {
    await tx.insert(modifierOptionIngredients).values(
      ingredients.map((i) => ({
        tenantId: a.tenantId,
        optionId: opt.id,
        stockItemId: i.stockItemId,
        quantity: String(roundQty(i.quantity)),
      })),
    )
  }
  await tx.insert(auditLog).values({
    tenantId: a.tenantId,
    actorMembershipId: a.membershipId,
    action: 'modifier_option.recipe_set',
    entityType: 'modifier_option',
    entityId: opt.id,
    before: {},
    after: { option_name: opt.name, ingredients: ingredients.length },
  })
  return { count: ingredients.length }
}
