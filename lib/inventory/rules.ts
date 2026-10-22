/**
 * Pure inventory rules (M10 / AROS-97, 98) — no DB, no `server-only`.
 */

export const STOCK_UNITS = ['kg', 'g', 'l', 'ml', 'pcs', 'pack', 'unit'] as const

/** Movement kinds a person can record. 'order' is written only by the sale deduction. */
export const MANUAL_MOVEMENT_TYPES = ['opening', 'purchase', 'adjustment', 'wastage'] as const
export type ManualMovementType = (typeof MANUAL_MOVEMENT_TYPES)[number]

export const MAX_QTY = 99_999_999

/** numeric(14,3): three decimals. */
export const roundQty = (n: number): number => Math.round(n * 1000) / 1000

export function validateStockItem(i: { name: string; unit: string; reorderLevel: number }): string | null {
  if (!i.name.trim()) return 'Enter a name for the stock item.'
  if (i.name.trim().length > 80) return 'Stock item names can be at most 80 characters.'
  if (!i.unit.trim()) return 'Enter a unit (kg, litre, pcs…).'
  if (!Number.isFinite(i.reorderLevel) || i.reorderLevel < 0 || i.reorderLevel > MAX_QTY) {
    return 'Reorder level must be zero or more.'
  }
  return null
}

/**
 * The signed delta for a manual movement. Opening / purchase add stock,
 * wastage removes it, and an adjustment keeps whatever sign the user typed
 * (a count correction can go either way). A delta of zero is meaningless.
 */
export function manualDelta(type: ManualMovementType, amount: number): number | string {
  if (!Number.isFinite(amount) || amount === 0) return 'Enter a quantity other than zero.'
  if (Math.abs(amount) > MAX_QTY) return 'That quantity is too large.'
  if (type !== 'adjustment' && amount < 0) return 'Enter a positive quantity — the type decides the direction.'
  const v = type === 'wastage' ? -Math.abs(amount) : amount
  return roundQty(v)
}

export function isLowStock(quantity: number, reorderLevel: number): boolean {
  return reorderLevel > 0 && quantity <= reorderLevel
}

export function validateIngredient(i: { quantity: number }): string | null {
  if (!Number.isFinite(i.quantity) || i.quantity <= 0) return 'Each ingredient needs a quantity above zero.'
  if (i.quantity > MAX_QTY) return 'That quantity is too large.'
  return null
}

/** Stock a sold line consumes: sold qty × recipe amount per portion. */
export function consumption(soldQty: number, perPortion: number): number {
  return roundQty(soldQty * perPortion)
}

// ── food cost (M20 / AROS-180) ──────────────────────────────────────────────

export const roundCost = (n: number): number => Math.round(n * 10_000) / 10_000
const money2 = (n: number): number => Math.round(n * 100) / 100

export function validateUnitCost(c: number | null | undefined): string | null {
  if (c === null || c === undefined) return null
  if (!Number.isFinite(c) || c < 0) return 'Cost must be zero or more.'
  if (c > MAX_QTY) return 'That cost is too large.'
  return null
}

export type CostedIngredient = { quantity: number; unitCost: number | null }

/**
 * What one portion costs to make at current ingredient prices.
 *
 * `complete` is false when ANY ingredient has no cost yet — the figure is then a
 * floor, not the truth, and the UI says "partial" instead of presenting it as
 * the dish's cost. `hasRecipe` is false for a dish with no ingredients (nothing
 * to cost — shown as "no recipe", never as ₹0).
 */
export function recipeCost(ingredients: CostedIngredient[]): { cost: number; complete: boolean; hasRecipe: boolean } {
  if (ingredients.length === 0) return { cost: 0, complete: false, hasRecipe: false }
  let cost = 0
  let complete = true
  for (const i of ingredients) {
    if (i.unitCost === null) {
      complete = false
      continue
    }
    cost += i.quantity * i.unitCost
  }
  return { cost: money2(cost), complete, hasRecipe: true }
}

/** Food-cost % = cost ÷ selling price. Null when there is no price to divide by. */
export function foodCostPct(cost: number, price: number): number | null {
  if (!(price > 0) || !Number.isFinite(cost)) return null
  return Math.round((cost / price) * 10_000) / 100
}

/** Traffic light for a food-cost %: ≤30 healthy, ≤40 watch, above that high. */
export function foodCostBand(pct: number | null): 'good' | 'watch' | 'high' | null {
  if (pct === null) return null
  return pct <= 30 ? 'good' : pct <= 40 ? 'watch' : 'high'
}

export type FoodCostRow = {
  menuItemId: string
  name: string
  price: number
  hasRecipe: boolean
  complete: boolean
  cost: number
  pct: number | null
  /** Extra cost each modifier option on this dish would add, dearest first. */
  options: { optionId: string; groupName: string; optionName: string; extraCost: number; complete: boolean }[]
}

/**
 * Per-dish cost table from already-loaded rows. Pure so the UI, the report and
 * the tests share one definition. Modifier options are attached to the dishes
 * whose modifier groups contain them; an option's extra cost is shown beside
 * the base cost rather than folded in, because which option a guest picks
 * varies per order.
 */
export function buildFoodCostRows(input: {
  menu: { id: string; name: string; price: number }[]
  stock: { id: string; unitCost: number | null }[]
  recipes: { menuItemId: string; stockItemId: string; quantity: number }[]
  options: { optionId: string; groupId: string; groupName: string; optionName: string }[]
  optionRecipes: { optionId: string; stockItemId: string; quantity: number }[]
  menuGroups: { menuItemId: string; groupId: string }[]
}): FoodCostRow[] {
  const cost = new Map(input.stock.map((s) => [s.id, s.unitCost]))
  const ing = (rs: { stockItemId: string; quantity: number }[]) =>
    rs.map((r) => ({ quantity: r.quantity, unitCost: cost.get(r.stockItemId) ?? null }))
  return input.menu.map((m) => {
    const base = recipeCost(ing(input.recipes.filter((r) => r.menuItemId === m.id)))
    const groups = new Set(input.menuGroups.filter((g) => g.menuItemId === m.id).map((g) => g.groupId))
    const options = input.options
      .filter((o) => groups.has(o.groupId))
      .map((o) => {
        const rc = recipeCost(ing(input.optionRecipes.filter((r) => r.optionId === o.optionId)))
        return { optionId: o.optionId, groupName: o.groupName, optionName: o.optionName, extraCost: rc.cost, complete: rc.complete || !rc.hasRecipe, hasRecipe: rc.hasRecipe }
      })
      .filter((o) => o.hasRecipe)
      .map(({ hasRecipe: _h, ...o }) => o)
      .sort((a, b) => b.extraCost - a.extraCost)
    return {
      menuItemId: m.id,
      name: m.name,
      price: m.price,
      hasRecipe: base.hasRecipe,
      complete: base.complete,
      cost: base.cost,
      pct: base.hasRecipe ? foodCostPct(base.cost, m.price) : null,
      options,
    }
  })
}
