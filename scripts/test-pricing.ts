/**
 * Proves the pricing & GST rules in lib/billing/pricing.ts:
 *   - each line is rounded to paise BEFORE the subtotal is summed
 *   - the discount lands BEFORE tax, is capped at the subtotal, never negative
 *   - GST is computed per distinct rate, on that rate's share of the DISCOUNTED
 *     value, with the discount split proportionally across the rate groups
 *   - CGST/SGST are each round2(tax / 2) — including the odd-paise case where
 *     the two halves add up to more than the group tax
 *   - subtotal − discount + taxTotal === total, always
 *
 * Pure logic, so unlike the other scripts here it needs no database.
 *
 *   npx tsx scripts/test-pricing.ts
 */
import { priceBill, round2, type BillLine, type PricingInput } from '../lib/billing/pricing'

let pass = 0,
  fail = 0
const check = (l: string, c: boolean) => {
  console.log(`${c ? '✓' : '✗ FAIL'}  ${l}`)
  if (c) pass++
  else fail++
}

/** A booking line, so each test only spells out the numbers it cares about. */
const line = (unitPrice: number, taxPercent: number, qty = 1, description = 'Line'): BillLine => ({
  description,
  kind: 'booking',
  qty,
  unitPrice,
  taxPercent,
})

const json = (v: unknown) => JSON.stringify(v)

function main() {
  // ── 1. single GST rate ────────────────────────────────────────────────────
  {
    const r = priceBill({ lines: [line(100, 18)] })
    check('T1 ₹100 @18%: subtotal = 100', r.subtotal === 100)
    check('T1 taxableValue = 100 (no discount)', r.taxableValue === 100)
    check('T1 one tax group at 18%', r.taxBreakup.length === 1 && r.taxBreakup[0].percent === 18)
    check('T1 taxTotal = 18', r.taxTotal === 18)
    check('T1 cgst = 9 and sgst = 9', r.taxBreakup[0].cgst === 9 && r.taxBreakup[0].sgst === 9)
    check('T1 total = 118', r.total === 118)
    check('T1 the priced item carries lineTotal = 100', r.items.length === 1 && r.items[0].lineTotal === 100)
  }

  // ── 2. multiple GST rates ─────────────────────────────────────────────────
  {
    const r = priceBill({ lines: [line(100, 5), line(200, 18)] })
    check('T2 ₹100@5% + ₹200@18%: subtotal = 300', r.subtotal === 300)
    check('T2 two separate tax groups', r.taxBreakup.length === 2)
    check('T2 groups are ordered by ascending percent', json(r.taxBreakup.map((g) => g.percent)) === json([5, 18]))
    check('T2 5% group: cgst 2.50 / sgst 2.50', r.taxBreakup[0].cgst === 2.5 && r.taxBreakup[0].sgst === 2.5)
    check('T2 18% group: cgst 18 / sgst 18', r.taxBreakup[1].cgst === 18 && r.taxBreakup[1].sgst === 18)
    check('T2 taxTotal = 41 (5 + 36)', r.taxTotal === 41)
    check('T2 total = 341', r.total === 341)
  }
  {
    // Same rate on several lines must collapse into ONE breakup entry.
    const r = priceBill({ lines: [line(100, 5), line(50, 5), line(200, 18)] })
    const percents = r.taxBreakup.map((g) => g.percent)
    check('T2 three lines over two rates give two groups', r.taxBreakup.length === 2)
    check('T2 no duplicate tax-rate entries', new Set(percents).size === percents.length)
    check('T2 5% group taxes the combined ₹150 → cgst/sgst 3.75', r.taxBreakup[0].cgst === 3.75 && r.taxBreakup[0].sgst === 3.75)
    check('T2 taxTotal = 43.50 (7.50 + 36)', r.taxTotal === 43.5)
    check('T2 total = 393.50', r.total === 393.5)
  }

  // ── 3. discount lands BEFORE tax ──────────────────────────────────────────
  {
    const r = priceBill({ lines: [line(100, 18)], discount: 20 })
    check('T3 subtotal = 100', r.subtotal === 100)
    check('T3 discount = 20', r.discount === 20)
    check('T3 taxableValue = 80', r.taxableValue === 80)
    check('T3 tax is 14.40, i.e. 18% of 80 — NOT of 100', r.taxTotal === 14.4)
    check('T3 cgst = 7.20 and sgst = 7.20', r.taxBreakup[0].cgst === 7.2 && r.taxBreakup[0].sgst === 7.2)
    check('T3 total = 94.40', r.total === 94.4)
    check('T3 tax on the undiscounted ₹100 (18.00) was NOT used', r.taxTotal !== 18)
  }
  {
    // The ticket's own multi-rate example: ₹100@5% + ₹200@18%, ₹30 off. The
    // discount must be split 10/20 by value, not taken from one group.
    const r = priceBill({ lines: [line(100, 5), line(200, 18)], discount: 30 })
    check('T3 multi-rate discount: taxableValue = 270', r.taxableValue === 270)
    check('T3 5% group taxed on ₹90 → tax 4.50, cgst/sgst 2.25', r.taxBreakup[0].cgst === 2.25 && r.taxBreakup[0].sgst === 2.25)
    check('T3 18% group taxed on ₹180 → tax 32.40, cgst/sgst 16.20', r.taxBreakup[1].cgst === 16.2 && r.taxBreakup[1].sgst === 16.2)
    check('T3 taxTotal = 36.90 (4.50 + 32.40)', r.taxTotal === 36.9)
    check('T3 total = 306.90', r.total === 306.9)
    check(
      'T3 the whole ₹30 was NOT applied to the 18% group alone (which would give tax 34.50)',
      r.taxTotal !== 34.5,
    )
  }
  {
    // Proportional allocation still adds up exactly when the split does not
    // divide evenly: ₹33.33 of a ₹100 discount lands on the 5% group.
    const r = priceBill({ lines: [line(100, 5), line(200, 18)], discount: 100 })
    check('T3 uneven split: taxableValue = 200', r.taxableValue === 200)
    check(
      'T3 uneven split reconciles: subtotal − discount + taxTotal === total',
      round2(r.subtotal - r.discount + r.taxTotal) === r.total,
    )
  }

  // ── 4. the discount can never exceed the subtotal ─────────────────────────
  {
    const r = priceBill({ lines: [line(100, 18)], discount: 150 })
    check('T4 a ₹150 discount on a ₹100 bill is capped at 100', r.discount === 100)
    check('T4 taxableValue = 0', r.taxableValue === 0)
    check('T4 taxTotal = 0', r.taxTotal === 0)
    check('T4 total = 0', r.total === 0)
    check('T4 total is not negative', r.total >= 0)
  }
  {
    const r = priceBill({ lines: [line(100, 18)], discount: 100 })
    check('T4 a discount exactly equal to the subtotal zeroes the bill', r.discount === 100 && r.taxableValue === 0 && r.total === 0)
  }
  {
    // A negative discount is a surcharge in disguise — normalise it to 0 rather
    // than quietly inflating the bill.
    const r = priceBill({ lines: [line(100, 18)], discount: -50 })
    check('T4 a NEGATIVE discount is normalised to 0', r.discount === 0)
    check('T4 …and does not inflate the total (still 118)', r.total === 118)
  }
  {
    const r = priceBill({ lines: [line(100, 18)] })
    check('T4 a missing discount is treated as 0', r.discount === 0 && r.total === 118)
  }

  // ── 5. CGST/SGST rounding on an odd paise ─────────────────────────────────
  {
    // 18% of ₹0.06 = ₹0.0108 → tax rounds to ₹0.01. Each half is rounded
    // INDEPENDENTLY per the ticket: round2(0.005) = 0.01 on both sides, so the
    // halves sum to 0.02 while the group tax — and taxTotal — stay 0.01.
    const r = priceBill({ lines: [line(0.06, 18)] })
    check('T5 tax on ₹0.06 @18% rounds to 0.01', r.taxTotal === 0.01)
    check('T5 cgst = round2(0.01 / 2) = 0.01', r.taxBreakup[0].cgst === 0.01)
    check('T5 sgst = round2(0.01 / 2) = 0.01', r.taxBreakup[0].sgst === 0.01)
    check(
      'T5 DOCUMENTED: cgst + sgst (0.02) exceeds the group tax (0.01) — each half rounds up',
      round2(r.taxBreakup[0].cgst + r.taxBreakup[0].sgst) === 0.02 && r.taxTotal === 0.01,
    )
    check('T5 taxTotal sums the GROUP TAX, not the two halves', r.taxTotal === 0.01)
    check('T5 total = 0.07 (0.06 + 0.01), so the bill still reconciles', r.total === 0.07)
    check(
      'T5 reconciliation holds despite the split: subtotal − discount + taxTotal === total',
      round2(r.subtotal - r.discount + r.taxTotal) === r.total,
    )
  }
  {
    // A realistic odd-paise case: 5% of ₹2.50 = ₹0.125 → 0.13; halves 0.065 → 0.07.
    const r = priceBill({ lines: [line(2.5, 5)] })
    check('T5 tax on ₹2.50 @5% = 0.125 rounds half-up to 0.13', r.taxTotal === 0.13)
    check('T5 cgst = sgst = round2(0.065) = 0.07', r.taxBreakup[0].cgst === 0.07 && r.taxBreakup[0].sgst === 0.07)
    check('T5 halves sum to 0.14 while taxTotal stays 0.13', round2(r.taxBreakup[0].cgst + r.taxBreakup[0].sgst) === 0.14)
    check('T5 total = 2.63 (2.50 + 0.13)', r.total === 2.63)
  }

  // ── 6. line-level rounding happens BEFORE aggregation ─────────────────────
  {
    // 3 × ₹0.125 → each line rounds to 0.13, so subtotal = 0.39. Summing the raw
    // 0.375 and rounding once would give 0.38 — this is the discriminating case.
    const r = priceBill({ lines: [line(0.125, 0), line(0.125, 0), line(0.125, 0)] })
    check('T6 each 0.125 line rounds to 0.13', r.items.every((i) => i.lineTotal === 0.13))
    check('T6 subtotal = 0.39 (sum of ROUNDED lines)', r.subtotal === 0.39)
    check('T6 …not 0.38 (which is round2 of the unrounded 0.375)', r.subtotal !== 0.38)
  }
  {
    // Decimal qty × decimal unitPrice: 2.5 × 33.333 = 83.3325 → 83.33.
    const r = priceBill({ lines: [line(33.333, 18, 2.5)] })
    check('T6 2.5 × 33.333 = 83.3325 rounds to 83.33', r.items[0].lineTotal === 83.33)
    check('T6 subtotal takes the rounded 83.33', r.subtotal === 83.33)
    check('T6 tax = 18% of 83.33 = 15.00 (14.9994 rounded)', r.taxTotal === 15)
    check('T6 total = 98.33', r.total === 98.33)
  }
  {
    // A float-noise boundary: 3 × 1.045 is stored as 3.1350000000000002.
    const r = priceBill({ lines: [line(1.045, 0, 3)] })
    check('T6 3 × 1.045 = 3.135 rounds half-up to 3.14', r.items[0].lineTotal === 3.14)
  }
  {
    // round2 itself, on the .005 boundaries the ticket calls out. The naive
    // Math.round(x * 100) / 100 gets 1.005 and 8.615 wrong.
    check('T6 round2(10.125) = 10.13', round2(10.125) === 10.13)
    check('T6 round2(1.005) = 1.01 (naive rounding gives 1.00)', round2(1.005) === 1.01)
    check('T6 round2(2.675) = 2.68 (naive rounding gives 2.67)', round2(2.675) === 2.68)
    check('T6 round2(8.615) = 8.62 (naive rounding gives 8.61)', round2(8.615) === 8.62)
    check('T6 round2(0.005) = 0.01', round2(0.005) === 0.01)
    check('T6 round2(1.004) = 1.00 (below the boundary, rounds down)', round2(1.004) === 1)
    check('T6 round2(0.1 + 0.2) = 0.30', round2(0.1 + 0.2) === 0.3)
  }

  // ── 7. reconciliation across a spread of bills ────────────────────────────
  {
    const cases: { name: string; input: PricingInput }[] = [
      { name: 'single rate', input: { lines: [line(100, 18)] } },
      { name: 'single rate + discount', input: { lines: [line(100, 18)], discount: 20 } },
      { name: 'two rates', input: { lines: [line(100, 5), line(200, 18)] } },
      { name: 'two rates + discount', input: { lines: [line(100, 5), line(200, 18)], discount: 30 } },
      { name: 'three rates + awkward discount', input: { lines: [line(99.99, 5), line(149.5, 12), line(200.01, 18)], discount: 77.77 } },
      { name: 'decimal qty and price', input: { lines: [line(33.333, 18, 2.5), line(19.995, 5, 3)], discount: 5.55 } },
      { name: 'discount = subtotal', input: { lines: [line(100, 18), line(50, 5)], discount: 150 } },
      { name: 'discount > subtotal', input: { lines: [line(100, 18)], discount: 999 } },
      { name: 'zero-rated only', input: { lines: [line(100, 0)], discount: 10 } },
      { name: 'tiny amounts', input: { lines: [line(0.01, 18), line(0.02, 5)] } },
      { name: 'many same-rate lines', input: { lines: Array.from({ length: 7 }, () => line(14.29, 18)), discount: 13.37 } },
      { name: 'mixed rates, no discount', input: { lines: [line(0.07, 28), line(1234.56, 18), line(9.99, 12), line(5, 0)] } },
    ]

    let reconciled = 0
    let taxableOk = 0
    let nonNegative = 0
    let noDupes = 0
    let sorted = 0
    for (const c of cases) {
      const r = priceBill(c.input)
      if (round2(r.subtotal - r.discount + r.taxTotal) === r.total) reconciled++
      else console.log(`   ↳ ${c.name}: ${r.subtotal} − ${r.discount} + ${r.taxTotal} ≠ ${r.total}`)
      if (r.taxableValue === round2(r.subtotal - r.discount)) taxableOk++
      if (r.subtotal >= 0 && r.discount >= 0 && r.taxableValue >= 0 && r.taxTotal >= 0 && r.total >= 0) nonNegative++
      const percents = r.taxBreakup.map((g) => g.percent)
      if (new Set(percents).size === percents.length) noDupes++
      if (json(percents) === json([...percents].sort((a, b) => a - b))) sorted++
    }
    check(`T7 subtotal − discount + taxTotal === total in all ${cases.length} cases`, reconciled === cases.length)
    check(`T7 taxableValue === subtotal − discount in all ${cases.length} cases`, taxableOk === cases.length)
    check(`T7 no negative money in any of the ${cases.length} cases`, nonNegative === cases.length)
    check(`T7 no duplicate tax rates in any of the ${cases.length} cases`, noDupes === cases.length)
    check(`T7 taxBreakup ascending by percent in all ${cases.length} cases`, sorted === cases.length)
  }

  // ── 8. edge cases ─────────────────────────────────────────────────────────
  {
    const r = priceBill({ lines: [] })
    check('T8 empty lines: everything is zero', r.subtotal === 0 && r.discount === 0 && r.taxableValue === 0 && r.taxTotal === 0 && r.total === 0)
    check('T8 empty lines: no tax groups and no items', r.taxBreakup.length === 0 && r.items.length === 0)
  }
  {
    const r = priceBill({ lines: [], discount: 50 })
    check('T8 a discount on an empty bill is capped to 0', r.discount === 0 && r.total === 0)
  }
  {
    const r = priceBill({ lines: [line(500, 18, 0)] })
    check('T8 zero qty → lineTotal 0, total 0', r.items[0].lineTotal === 0 && r.total === 0)
  }
  {
    const r = priceBill({ lines: [line(0, 18, 5)] })
    check('T8 zero unit price → lineTotal 0, total 0', r.items[0].lineTotal === 0 && r.total === 0)
  }
  {
    const r = priceBill({ lines: [line(100, 0)] })
    check('T8 zero tax rate: taxTotal 0 and total = subtotal', r.taxTotal === 0 && r.total === 100)
    check('T8 the 0% group still appears in taxBreakup (exempt supplies are reported)', json(r.taxBreakup) === json([{ percent: 0, cgst: 0, sgst: 0 }]))
  }
  {
    const r = priceBill({ lines: [line(100, 0), line(100, 18)] })
    check('T8 a 0% line does not attract tax from the 18% line', r.taxTotal === 18)
    check('T8 …and the two rates stay in separate groups', json(r.taxBreakup.map((g) => g.percent)) === json([0, 18]))
  }
  {
    const r = priceBill({ lines: [line(0.01, 18)] })
    check('T8 very small GST (18% of 0.01 = 0.0018) rounds to 0', r.taxTotal === 0)
    check('T8 …and the total is just the line', r.total === 0.01)
  }
  {
    // Negative inputs are normalised rather than allowed to produce a credit
    // note — invoice_items CHECKs qty > 0 and line_total >= 0 (migration 0010).
    const r = priceBill({ lines: [line(-100, 18), line(50, 18)] })
    check('T8 a negative unit price is clamped to 0', r.items[0].lineTotal === 0)
    check('T8 …so the subtotal is the remaining ₹50', r.subtotal === 50)
    const q = priceBill({ lines: [line(100, 18, -2)] })
    check('T8 a negative qty is clamped to 0', q.items[0].lineTotal === 0 && q.total === 0)
    const t = priceBill({ lines: [line(100, -18)] })
    check('T8 a negative tax percent is clamped to 0', t.taxTotal === 0 && t.total === 100)
  }
  {
    const r = priceBill({ lines: [line(NaN, 18), line(100, Number.POSITIVE_INFINITY)] })
    check('T8 a non-finite unit price counts as 0', r.items[0].lineTotal === 0)
    check('T8 a non-finite tax percent counts as 0', r.taxTotal === 0)
    check('T8 nothing leaks NaN into the result', Number.isFinite(r.subtotal) && Number.isFinite(r.total))
    const d = priceBill({ lines: [line(100, 18)], discount: NaN })
    check('T8 a non-finite discount counts as 0', d.discount === 0 && d.total === 118)
  }
  {
    const r = priceBill({ lines: [line(10, 18), line(20, 18), line(30, 18)] })
    check('T8 many lines at the same rate collapse to one group', r.taxBreakup.length === 1)
    check('T8 …taxed on the combined ₹60 → 10.80', r.taxTotal === 10.8)
  }
  {
    const r = priceBill({ lines: [line(100, 18.5)] })
    check('T8 a fractional tax rate (18.5%) works', r.taxTotal === 18.5 && r.taxBreakup[0].percent === 18.5)
  }

  // ── 9. purity: no mutation, fully deterministic ───────────────────────────
  {
    const lines: BillLine[] = [
      { description: 'PS5 · 2h', kind: 'booking', sourceId: 'slot-1', qty: 2, unitPrice: 450, taxPercent: 18 },
      { description: 'Cold coffee', kind: 'food', qty: 3, unitPrice: 89.5, taxPercent: 5 },
    ]
    const input: PricingInput = { lines, discount: 50 }
    const snapshot = json(input)

    const first = priceBill(input)
    const second = priceBill(input)

    check('T9 the input object is not mutated', json(input) === snapshot)
    check('T9 the input lines array is the same length and order', input.lines.length === 2 && input.lines[0].description === 'PS5 · 2h')
    check('T9 the same input twice gives an identical result', json(first) === json(second))
    check('T9 the result does not alias the input lines', first.items[0] !== input.lines[0])

    first.items[0].lineTotal = 9999
    first.taxBreakup[0].cgst = 9999
    check('T9 mutating the result does not affect the input', input.lines[0].qty === 2 && input.lines[0].unitPrice === 450)
    check('T9 …nor a freshly computed result', priceBill(input).items[0].lineTotal === 900)

    check('T9 optional sourceId is carried through to the priced item', priceBill(input).items[0].sourceId === 'slot-1')
    check('T9 description and kind are carried through', priceBill(input).items[1].kind === 'food' && priceBill(input).items[1].description === 'Cold coffee')
  }

  // ── 10. a realistic mixed bill, end to end ────────────────────────────────
  {
    // 2h of PS5 at ₹450 (18%) + 3 cold coffees at ₹89.50 (5%), ₹50 off.
    const r = priceBill({
      lines: [
        { description: 'PS5 Station 1 · 2h', kind: 'booking', qty: 2, unitPrice: 450, taxPercent: 18 },
        { description: 'Cold coffee', kind: 'food', qty: 3, unitPrice: 89.5, taxPercent: 5 },
      ],
      discount: 50,
    })
    check('T10 subtotal = 1168.50 (900 + 268.50)', r.subtotal === 1168.5)
    check('T10 taxableValue = 1118.50', r.taxableValue === 1118.5)
    check('T10 two groups, 5% then 18%', json(r.taxBreakup.map((g) => g.percent)) === json([5, 18]))
    check('T10 reconciles: subtotal − discount + taxTotal === total', round2(r.subtotal - r.discount + r.taxTotal) === r.total)
    check('T10 every money field is a clean 2-decimal value', [r.subtotal, r.discount, r.taxableValue, r.taxTotal, r.total, ...r.taxBreakup.flatMap((g) => [g.cgst, g.sgst]), ...r.items.map((i) => i.lineTotal)].every((n) => round2(n) === n))
    console.log(`   ↳ ${json(r.taxBreakup)}  taxTotal=${r.taxTotal}  total=${r.total}`)
  }

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main()
