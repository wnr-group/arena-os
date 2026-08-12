/**
 * Pricing & GST — what a bill actually costs.
/** Significant digits kept before rounding, enough to strip IEEE-754 noise. */
const PRECISION_DIGITS = 12

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

/** Clamp to zero. Used wherever a negative would produce a negative total. */
function atLeastZero(value: number): number {
  return value > 0 ? value : 0
}

// ── types ────────────────────────────────────────────────────────────────────

export type BillLine = {
  description: string
  kind: 'booking' | 'food' | 'membership' | 'adjustment'
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

  // Step 3 — group by distinct rate. The percent is rounded first, so 18 and
  // 18.000000000000004 are the same group and no rate can appear twice.
  // Insertion order is irrelevant: the groups are sorted by percent below.
  const groups = new Map<number, number>()
  for (const item of items) {
    groups.set(item.taxPercent, round2((groups.get(item.taxPercent) ?? 0) + item.lineTotal))
  }
  const percents = [...groups.keys()].sort((a, b) => a - b)

  const taxBreakup: PricingResult['taxBreakup'] = []
  let cumulativeSubtotal = 0
  let allocatedDiscount = 0
  let taxTotal = 0

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

    taxBreakup.push({ percent, cgst: round2(tax / 2), sgst: round2(tax / 2) })
    taxTotal = round2(taxTotal + tax)
  }

  const total = round2(taxableValue + taxTotal)

  return { subtotal, discount, taxableValue, taxBreakup, taxTotal, total, items }
}
