/**
 * Pure inventory rules (M10 / AROS-97, 98) — no database.
 *
 *   npx tsx scripts/test-inventory-rules.ts
 */
import {
  buildFoodCostRows,
  consumption,
  foodCostBand,
  foodCostPct,
  isLowStock,
  manualDelta,
  recipeCost,
  roundQty,
  validateIngredient,
  validateStockItem,
  validateUnitCost,
} from '../lib/inventory/rules'

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

// ── food cost ───────────────────────────────────────────────────────────────
const rc = recipeCost([{ quantity: 0.2, unitCost: 400 }, { quantity: 0.3, unitCost: 60 }])
check('recipe cost = Σ qty × unit cost (0.2×400 + 0.3×60 = 98)', rc.cost === 98 && rc.complete && rc.hasRecipe)
const partial = recipeCost([{ quantity: 0.2, unitCost: 400 }, { quantity: 1, unitCost: null }])
check('an uncosted ingredient makes the dish PARTIAL, priced at what is known', partial.cost === 80 && !partial.complete && partial.hasRecipe)
const none = recipeCost([])
check('no recipe is "no recipe", never a free dish', !none.hasRecipe && none.cost === 0 && !none.complete)
check('a free ingredient (cost 0) is costed, not missing', recipeCost([{ quantity: 5, unitCost: 0 }]).complete)
check('cost rounds to paise', recipeCost([{ quantity: 0.333, unitCost: 10 }]).cost === 3.33)

check('food cost % = cost ÷ price', foodCostPct(98, 300) === 32.67)
check('...and 0 cost is 0%', foodCostPct(0, 300) === 0)
check('no price -> null, never Infinity', foodCostPct(10, 0) === null && foodCostPct(10, -5) === null)
check('bands: ≤30 good, ≤40 watch, above high', foodCostBand(30) === 'good' && foodCostBand(30.01) === 'watch' && foodCostBand(40) === 'watch' && foodCostBand(40.01) === 'high' && foodCostBand(null) === null)
check('unit cost validation', validateUnitCost(null) === null && validateUnitCost(0) === null && validateUnitCost(12.5) === null && validateUnitCost(-1) !== null && validateUnitCost(NaN) !== null)

const rows = buildFoodCostRows({
  menu: [{ id: 'pizza', name: 'Pizza', price: 300 }, { id: 'cola', name: 'Cola', price: 50 }, { id: 'salad', name: 'Salad', price: 150 }],
  stock: [{ id: 'cheese', unitCost: 400 }, { id: 'dough', unitCost: 60 }, { id: 'tomato', unitCost: null }],
  recipes: [
    { menuItemId: 'pizza', stockItemId: 'cheese', quantity: 0.2 },
    { menuItemId: 'pizza', stockItemId: 'dough', quantity: 0.3 },
    { menuItemId: 'salad', stockItemId: 'tomato', quantity: 0.1 },
  ],
  options: [
    { optionId: 'xcheese', groupId: 'toppings', groupName: 'Toppings', optionName: 'Extra cheese' },
    { optionId: 'olives', groupId: 'toppings', groupName: 'Toppings', optionName: 'Olives' },
    { optionId: 'noonion', groupId: 'toppings', groupName: 'Toppings', optionName: 'No onion' },
    { optionId: 'ice', groupId: 'drinks', groupName: 'Ice', optionName: 'Extra ice' },
  ],
  optionRecipes: [
    { optionId: 'xcheese', stockItemId: 'cheese', quantity: 0.03 },
    { optionId: 'olives', stockItemId: 'tomato', quantity: 0.02 },
    { optionId: 'ice', stockItemId: 'dough', quantity: 1 },
  ],
  menuGroups: [{ menuItemId: 'pizza', groupId: 'toppings' }, { menuItemId: 'cola', groupId: 'drinks' }],
})
const pz = rows.find((r) => r.menuItemId === 'pizza')!
check('pizza: cost 98, 32.67%', pz.cost === 98 && pz.pct === 32.67 && pz.complete && pz.hasRecipe)
check('pizza lists only options with ingredients that belong to its modifier groups (not "No onion", not Ice)', pz.options.map((o) => o.optionName).join() === 'Extra cheese,Olives')
check('extra cheese adds 0.03 × 400 = 12', pz.options[0].extraCost === 12)
check('an uncosted modifier ingredient is flagged partial', pz.options[1].complete === false)
const sl = rows.find((r) => r.menuItemId === 'salad')!
check('salad is partial (tomato has no cost) and has no % shown as complete', sl.hasRecipe && !sl.complete && sl.cost === 0)
const cola = rows.find((r) => r.menuItemId === 'cola')!
check('cola has no recipe of its own, so it has no cost/% (its options still attach)', !cola.hasRecipe && cola.pct === null && cola.options.length === 1)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
