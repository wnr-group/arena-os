/**
 * M33 #7 — add-on invoice line items: pricing, split-bill reconciliation,
 * bill-level comp, and the fixed daily-rate rule on a midnight-crossing
 * booking. Pure logic over priceBill / computeSplitChecks, no database:
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs scripts/test-addon-invoice-lines.ts
 *
 * Proves:
 *   - an add-on bills as ONE kind='addon' line at its frozen line_total
 *   - a day-rate add-on on an 11pm–1am booking (crosses midnight) is ONE
 *     day-block — ceil(elapsed hours / 24) — not two calendar dates
 *   - even / by-item splits reconcile to the whole bill exactly (subtotal,
 *     discount, tax, total) with add-on lines never re-priced
 *   - a by-item split keeps the add-on line, untouched, on its assigned check
 *   - a full bill-level comp zeroes the add-on lines along with the room charge
 *   - a partial comp reconciles across checks, add-on included
 */
import { priceBill, round2, type BillLine } from '../lib/billing/pricing'
import { computeSplitChecks } from '../lib/billing/split'
import { addonBillableUnits } from '../lib/booking/addon-pricing'

let pass = 0,
  fail = 0
const check = (l: string, c: boolean) => {
  console.log(`${c ? '✓' : '✗ FAIL'}  ${l}`)
  if (c) pass++
  else fail++
}

// Same formula as lib/booking/addons.ts's addonLineTotal (that module is DB-bound).
const addonLineTotal = (u: 'hour' | 'day', rate: number, qty: number, a: Date, b: Date) =>
  round2(rate * qty * addonBillableUnits(u, a, b))

const IST = (iso: string) => new Date(`${iso}+05:30`)

// 11pm–1am = 2 elapsed hours, crossing midnight.
const start = IST('2026-08-11T23:00:00')
const end = IST('2026-08-12T01:00:00')

const dayTotal = addonLineTotal('day', 500, 2, start, end)
check('day add-on, 2h crossing midnight = 1 day-block', addonBillableUnits('day', start, end) === 1)
check('day add-on line_total = rate × qty × 1 block', dayTotal === 1000)

const hourTotal = addonLineTotal('hour', 150, 1, start, end)
check('hour add-on, same window = 2 hours × rate', hourTotal === 300)

// Lines exactly as loadAddonLines shapes them: qty 1 at the frozen line_total,
// taxed at the parent slot's rate.
const lines: BillLine[] = [
  { description: 'Studio A · 11:00 PM–1:00 AM', kind: 'booking', sourceId: 'slot-1', qty: 2, unitPrice: 800, taxPercent: 18 },
  { description: 'Tripod × 2 · ₹500.00/day', kind: 'addon', sourceId: 'addon-1', qty: 1, unitPrice: dayTotal, taxPercent: 18 },
  { description: 'Lens × 1 · ₹150.00/hr', kind: 'addon', sourceId: 'addon-2', qty: 1, unitPrice: hourTotal, taxPercent: 18 },
]

const whole = priceBill({ lines })
const addonItems = whole.items.filter((i) => i.kind === 'addon')
check('invoice carries 2 kind=addon line items', addonItems.length === 2)
check('addon lines carry snapshotted line_total', addonItems[0].lineTotal === 1000 && addonItems[1].lineTotal === 300)
check('subtotal = room + add-ons', whole.subtotal === 1600 + 1000 + 300)

const sum = (xs: number[]) => round2(xs.reduce((a, b) => a + b, 0))
function reconciles(pricing: ReturnType<typeof priceBill>, checks: ReturnType<typeof computeSplitChecks>) {
  return (
    sum(checks.map((c) => c.subtotal)) === pricing.subtotal &&
    sum(checks.map((c) => c.discount)) === pricing.discount &&
    sum(checks.map((c) => c.taxTotal)) === pricing.taxTotal &&
    sum(checks.map((c) => c.total)) === pricing.total
  )
}

// ── split: even ─────────────────────────────────────────────────────────────
for (const n of [2, 3, 7]) {
  const checks = computeSplitChecks(whole, new Map(), { mode: 'even', checkCount: n })
  check(`even split ×${n} reconciles exactly`, reconciles(whole, checks))
}

// ── split: by item — add-on stays whole, un-repriced, on its check ──────────
const byItem = computeSplitChecks(whole, new Map(), {
  mode: 'item',
  checkCount: 2,
  assignments: { 'slot-1': 0, 'addon-1': 1, 'addon-2': 1 },
})
check('by-item split reconciles exactly', reconciles(whole, byItem))
const check2Addons = byItem[1].items.filter((i) => i.kind === 'addon')
check(
  'by-item: both add-on lines land on check 2 at their original line_total',
  check2Addons.length === 2 && check2Addons[0].lineTotal === 1000 && check2Addons[1].lineTotal === 300,
)
check('by-item: check 1 carries no add-on lines', byItem[0].items.every((i) => i.kind !== 'addon'))

// ── bill-level comp ─────────────────────────────────────────────────────────
const fullComp = priceBill({ lines, discount: whole.subtotal })
check('full comp: total is zero', fullComp.total === 0 && fullComp.taxTotal === 0)
check('full comp: add-on lines are zeroed too (taxable value 0)', fullComp.taxableValue === 0)

const partial = priceBill({ lines, discount: 777.77 })
const splitComp = computeSplitChecks(partial, new Map(), { mode: 'even', checkCount: 3 })
check('partial comp split reconciles exactly, add-ons included', reconciles(partial, splitComp))
const splitCompItem = computeSplitChecks(partial, new Map(), {
  mode: 'item',
  checkCount: 2,
  assignments: { 'slot-1': 0, 'addon-1': 1, 'addon-2': 1 },
})
check('partial comp by-item split reconciles exactly', reconciles(partial, splitCompItem))

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
