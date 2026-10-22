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
