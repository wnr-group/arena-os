/**
 * Pricing & GST — what a bill actually costs.
 */
/** Significant digits kept before rounding, enough to strip IEEE-754 noise. */
const PRECISION_DIGITS = 12

/** Round to 2 decimal places (whole paise), stripping IEEE-754 float noise first. */
export function round2(value: number): number {
  if (!Number.isFinite(value)) return 0
  const scaled = Number((value * 100).toPrecision(PRECISION_DIGITS))
  const rounded = scaled < 0 ? -Math.floor(-scaled + 0.5) : Math.floor(scaled + 0.5)
  // `|| 0` normalises -0 to 0 so a zero total never prints as "-0.00".
  return rounded / 100 || 0
}

/** A caller-supplied number that must not be allowed to poison the arithmetic. */
function finite(value: number): number {
  return Number.isFinite(value) ? value : 0
}

/**
 * Money as whole paise.
 *
 * Every financial comparison in the codebase goes through this: floats that
 * look equal (800 vs 799.9999999999999) compare wrong, and `>=` on rupees is
 * exactly the bug that lets an invoice be overpaid by a hundredth of a paisa.
 * round2() first, then scale to an integer, and compare integers.
 *
 * Lives HERE, in the dependency-free money module, rather than in ./payments —
 * it is pure arithmetic that several modules need, and keeping it in payments
 * forced a circular import (payments → loyalty → payments). ./payments still
 * re-exports it, so every existing import site is unchanged.
 */
export function paise(amount: number): number {
  return Math.round(round2(amount) * 100)
}

/** Clamp to zero. Used wherever a negative would produce a negative total. */
function atLeastZero(value: number): number {
  return value > 0 ? value : 0
}

// ── types ────────────────────────────────────────────────────────────────────

export type BillLine = {
  description: string
  kind: 'booking' | 'food' | 'membership' | 'adjustment' | 'wallet_topup' | 'service_charge'
  sourceId?: string
  qty: number
  unitPrice: number
  taxPercent: number
}

export type PricingInput = {
  lines: BillLine[]
  discount?: number
}

export type PricedItem = BillLine & {
  lineTotal: number
}

export type PricingResult = {
  subtotal: number
  discount: number
  taxableValue: number
  taxBreakup: {
    percent: number
    cgst: number
    sgst: number
  }[]
  taxTotal: number
  total: number
  items: PricedItem[]
}

/**
 * One tax-rate group's full breakdown — the richer, internal-use shape
 * `priceBill` computes on its way to the public `taxBreakup` (which only
 * exposes `percent`/`cgst`/`sgst`). Exported so bill-splitting (M18 #2) can
 * read the same subtotal/discount/tax figures `priceBill` already derived,
 * instead of re-deriving them a second, potentially divergent way.
 */
export type TaxGroup = {
  percent: number
  subtotal: number
  discount: number
  taxable: number
  tax: number
  cgst: number
  sgst: number
}

/**
 * Group already-priced items by tax rate and allocate `discount` across the
 * groups pro-rata by cumulative subtotal — the exact computation `priceBill`
 * needs for its own `taxBreakup`/`taxTotal`, factored out so a caller that
 * already HAS a `PricingResult` (bill-splitting) can rebuild the same
 * per-group figures deterministically, without re-pricing a single line.
 * Calling this twice with the same `(items, discount)` always reproduces
 * identical groups — it is a pure function of already-rounded inputs.
 */
export function groupByTaxRate(items: PricedItem[], discount: number): TaxGroup[] {
  // Group by distinct rate. The percent is rounded first, so 18 and
  // 18.000000000000004 are the same group and no rate can appear twice.
  // Insertion order is irrelevant: the groups are sorted by percent below.
  const groups = new Map<number, number>()
  for (const item of items) {
    groups.set(item.taxPercent, round2((groups.get(item.taxPercent) ?? 0) + item.lineTotal))
  }
  const percents = [...groups.keys()].sort((a, b) => a - b)

  const subtotal = round2([...groups.values()].reduce((sum, v) => sum + v, 0))

  const result: TaxGroup[] = []
  let cumulativeSubtotal = 0
  let allocatedDiscount = 0

  for (const percent of percents) {
    const groupSubtotal = groups.get(percent) ?? 0
    cumulativeSubtotal = round2(cumulativeSubtotal + groupSubtotal)

    // subtotal === 0 only when every line is zero, in which case there is
    // nothing to discount and the ratio is undefined — allocate nothing.
    const cumulativeDiscount =
      subtotal > 0 ? round2((discount * cumulativeSubtotal) / subtotal) : 0
    const groupDiscount = round2(cumulativeDiscount - allocatedDiscount)
    allocatedDiscount = cumulativeDiscount

    const groupTaxable = atLeastZero(round2(groupSubtotal - groupDiscount))
    const tax = round2((groupTaxable * percent) / 100)
    // Rounded ONCE; sgst takes the remainder, so cgst + sgst === tax exactly
    // even for an odd paisa (e.g. tax 0.01 must not become 0.01 + 0.01).
    const cgst = round2(tax / 2)
    const sgst = round2(tax - cgst)

    result.push({
      percent,
      subtotal: groupSubtotal,
      discount: groupDiscount,
      taxable: groupTaxable,
      tax,
      cgst,
      sgst,
    })
  }

  return result
}

/**
 * Split a fixed `total` into `weights.length` paise-exact shares, in
 * proportion to `weights`. The defining guarantee — the one bill-splitting
 * (M18 #2) depends on — is that `sum(shares) === round2(total)` ALWAYS,
 * including odd/prime amounts and zero weights: each share but the last is
 * `round2(total × cumulativeWeight / totalWeight)` minus what was already
 * allocated (the same telescoping trick `groupByTaxRate` uses to allocate
 * discount across tax groups); the LAST share is whatever remains, by
 * construction, rather than independently rounded. Equal weights ⇒ an even
 * N-way split; item-value weights ⇒ a proportional split. Never used to
 * recompute a price — only to divide an already-priced figure.
 */
export function splitProportional(total: number, weights: number[]): number[] {
  const fixedTotal = round2(finite(total))
  const safeWeights = weights.map((w) => atLeastZero(finite(w)))
  const totalWeight = safeWeights.reduce((sum, w) => sum + w, 0)
  if (safeWeights.length === 0) return []
  // No signal to split by (everyone weighted zero) — put it all on the last
  // share deterministically, same "remainder goes to one bucket" rule.
  if (totalWeight <= 0) {
    return safeWeights.map((_, i) => (i === safeWeights.length - 1 ? fixedTotal : 0))
  }

  const shares: number[] = []
  let cumulativeWeight = 0
  let allocated = 0
  for (let i = 0; i < safeWeights.length; i++) {
    cumulativeWeight += safeWeights[i]
    const isLast = i === safeWeights.length - 1
    const cumulativeShare = isLast ? fixedTotal : round2((fixedTotal * cumulativeWeight) / totalWeight)
    const share = round2(cumulativeShare - allocated)
    shares.push(share)
    allocated = cumulativeShare
  }
  return shares
}

/** Tenant-configured service charge inputs (M18 #3) — resolved server-side
 *  from business_profiles + tax_rates, never from the browser. `taxPercent`
 *  is 0 when the tenant hasn't tied the service charge to a tax rate (a
 *  legitimate, deliberately non-default configuration: an untaxed service
 *  charge). */
export type ServiceChargeConfig = { percent: number; taxPercent: number }

export type ServiceChargeResult = {
  percent: number
  amount: number
  taxPercent: number
  tax: number
  cgst: number
  sgst: number
}

/**
 * A restaurant's service charge — a tenant-configured % of the bill,
 * optionally taxed at its own configured GST rate. `subtotal <= 0` or
 * `config.percent <= 0` (the off switch — 0 is the column default) yields an
 * all-zero result, so a caller never needs to special-case "service charge
 * disabled" — it just folds in as zero everywhere.
 *
 * Computed on the PRE-DISCOUNT subtotal (a deliberate choice, documented at
 * the call site in lib/billing/invoice.ts): a discount is a concession on
 * the food, not on the venue's own service charge.
 */
export function computeServiceCharge(subtotal: number, config: ServiceChargeConfig): ServiceChargeResult {
  const percent = atLeastZero(finite(config.percent))
  if (percent <= 0 || atLeastZero(finite(subtotal)) <= 0) {
    return { percent: 0, amount: 0, taxPercent: 0, tax: 0, cgst: 0, sgst: 0 }
  }
  const amount = round2(atLeastZero(finite(subtotal)) * (percent / 100))
  const taxPercent = round2(atLeastZero(finite(config.taxPercent)))
  const tax = taxPercent > 0 ? round2(amount * (taxPercent / 100)) : 0
  // Rounded ONCE; sgst takes the remainder, so cgst + sgst === tax exactly
  // even for an odd paisa.
  const cgst = round2(tax / 2)
  const sgst = round2(tax - cgst)
  return { percent, amount, taxPercent: tax > 0 ? taxPercent : 0, tax, cgst, sgst }
}

/**
 * Fold one more {percent, cgst, sgst} group into a `taxBreakup` array — used
 * to add the service charge's own tax (M18 #3) onto a bill's/check's
 * existing food taxBreakup. Merges into the matching-rate group when one
 * already exists (a real invoice can otherwise end up with two "5%" rows,
 * which is confusing on a GST receipt and wrong for reporting "tax by
 * rate"), otherwise appends a new group and keeps the array sorted by rate,
 * matching priceBill's own ascending-percent ordering. A zero addition is a
 * no-op — the common case, since most bills have no service charge.
 */
export function mergeTaxBreakup(
  breakup: { percent: number; cgst: number; sgst: number }[],
  addition: { percent: number; cgst: number; sgst: number },
): { percent: number; cgst: number; sgst: number }[] {
  if (paise(addition.cgst) === 0 && paise(addition.sgst) === 0) return breakup
  const idx = breakup.findIndex((g) => g.percent === addition.percent)
  if (idx === -1) {
    return [...breakup, addition].sort((a, b) => a.percent - b.percent)
  }
  const merged = [...breakup]
  merged[idx] = {
    percent: addition.percent,
    cgst: round2(merged[idx].cgst + addition.cgst),
    sgst: round2(merged[idx].sgst + addition.sgst),
  }
  return merged
}

// ── the calculation

/**
 * Price a bill.
 */
export function priceBill(input: PricingInput): PricingResult {
  // Step 1 — each line, rounded to paise BEFORE anything is summed. Summing raw
  // qty × unitPrice and rounding once at the end would drift from the line
  // amounts actually printed on the invoice.
  const items: PricedItem[] = (input.lines ?? []).map((line) => {
    const qty = atLeastZero(finite(line.qty))
    const unitPrice = atLeastZero(finite(line.unitPrice))
    const taxPercent = round2(atLeastZero(finite(line.taxPercent)))
    return {
      ...line,
      qty,
      unitPrice,
      taxPercent,
      lineTotal: atLeastZero(round2(qty * unitPrice)),
    }
  })

  // Subtotal is the sum of the ROUNDED line totals — the figure a customer can
  // verify by adding up the printed lines. round2 again because repeated float
  // addition of exact 2-decimal values still drifts (0.1 + 0.2 = 0.30000000000000004).
  const subtotal = round2(items.reduce((sum, i) => sum + i.lineTotal, 0))

  // Step 2 — discount, applied BEFORE tax and capped at the subtotal.
  const discount = Math.min(round2(atLeastZero(finite(input.discount ?? 0))), subtotal)
  const taxableValue = round2(subtotal - discount)

  // Step 3 — per-rate grouping and discount allocation, factored out into
  // groupByTaxRate (above) so bill-splitting can reproduce these exact same
  // per-group figures later without re-deriving them differently.
  const groups = groupByTaxRate(items, discount)
  const taxBreakup: PricingResult['taxBreakup'] = groups.map((g) => ({
    percent: g.percent,
    cgst: g.cgst,
    sgst: g.sgst,
  }))
  const taxTotal = round2(groups.reduce((sum, g) => sum + g.tax, 0))

  const total = round2(taxableValue + taxTotal)

  return { subtotal, discount, taxableValue, taxBreakup, taxTotal, total, items }
}
