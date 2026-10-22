/**
 * Pure inventory rules (M10 / AROS-97, 98) — no database.
 *
 *   npx tsx scripts/test-inventory-rules.ts
 */
import { consumption, isLowStock, manualDelta, roundQty, validateIngredient, validateStockItem } from '../lib/inventory/rules'

let pass = 0,
  fail = 0
const check = (l: string, c: boolean) => {
  console.log(`${c ? '✓' : '✗ FAIL'}  ${l}`)
  if (c) pass++
  else fail++
}

check('purchase adds', manualDelta('purchase', 5) === 5)
check('opening adds', manualDelta('opening', 2.5) === 2.5)
check('wastage removes stock', manualDelta('wastage', 3) === -3)
check('a negative wastage quantity is refused (no double negatives)', typeof manualDelta('wastage', -3) === 'string')
check('adjustment keeps its sign (count corrections go either way)', manualDelta('adjustment', -1.25) === -1.25 && manualDelta('adjustment', 4) === 4)
check('a negative purchase is refused (type decides direction)', typeof manualDelta('purchase', -2) === 'string')
check('zero is refused', typeof manualDelta('adjustment', 0) === 'string' && typeof manualDelta('purchase', 0) === 'string')
check('NaN / Infinity refused', typeof manualDelta('purchase', NaN) === 'string' && typeof manualDelta('purchase', Infinity) === 'string')
check('absurd quantity refused', typeof manualDelta('purchase', 1e12) === 'string')
check('quantities round to 3 decimals (numeric(14,3))', roundQty(0.12349) === 0.123 && manualDelta('purchase', 1.00049) === 1)

check('low stock at or below the reorder level', isLowStock(5, 5) && isLowStock(2, 5) && !isLowStock(5.001, 5))
check('reorder level 0 means "no alert"', !isLowStock(0, 0) && !isLowStock(-3, 0))
check('negative stock below a real reorder level is low', isLowStock(-1, 5))

check('valid stock item', validateStockItem({ name: 'Paneer', unit: 'kg', reorderLevel: 2 }) === null)
check('blank name refused', validateStockItem({ name: '  ', unit: 'kg', reorderLevel: 0 }) !== null)
check('blank unit refused', validateStockItem({ name: 'A', unit: ' ', reorderLevel: 0 }) !== null)
check('negative reorder level refused', validateStockItem({ name: 'A', unit: 'kg', reorderLevel: -1 }) !== null)
check('over-long name refused', validateStockItem({ name: 'x'.repeat(81), unit: 'kg', reorderLevel: 0 }) !== null)

check('ingredient quantity must be above zero', validateIngredient({ quantity: 0 }) !== null && validateIngredient({ quantity: -1 }) !== null && validateIngredient({ quantity: 0.001 }) === null)
check('ingredient NaN refused', validateIngredient({ quantity: NaN }) !== null)

check('consumption = sold qty × per portion', consumption(3, 0.2) === 0.6 && consumption(1, 0.05) === 0.05)
check('consumption has no float dust', consumption(3, 0.1) === 0.3)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
