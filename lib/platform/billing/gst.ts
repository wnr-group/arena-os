import { round2 } from '@/lib/billing/pricing'

/**
 * GST for the Arena OS subscription fee — Arena OS as the SUPPLIER, the
 * business as the recipient.
 *
 * Deliberately NOT in lib/billing/pricing.ts. That module prices a VENUE's bill
 * to ITS CUSTOMER: many lines, many rates, a discount to allocate across rate
 * groups. This is one line at one rate, and it is tax-INCLUSIVE, which is the
 * opposite direction of arithmetic. Bolting a second mode onto priceBill()
 * would put a branch inside the function every POS bill in the product goes
 * through, to serve a case that has no lines at all.
 *
 * What it DOES reuse is the money rule itself: round2() from that same module,
 * the project's single half-up 2-decimal rounder. No second rounding
 * implementation exists here, and no float value produced here is persisted
 * without going through it.
 *
 * ── WHY TAX-INCLUSIVE ───────────────────────────────────────────────────────
 *
 * This is forced by the gateway integration, not chosen for convenience.
 * subscribeTenantToPlan() (M16 #3) refuses to create a subscription unless the
 * Razorpay plan's amount equals plans.monthly_price / annual_price EXACTLY:
 *
 *     if (gatewayPlan.item.amount !== expectedPaise) → refuse
 *
 * So the rupees Razorpay captures are precisely the catalogue price. Adding 18%
 * on top would produce an invoice for money nobody ever paid. The tax is
 * therefore extracted from the captured total:
 *
 *     taxable = total ÷ (1 + rate/100)
 *     tax     = total − taxable          ← subtraction, NOT taxable × rate
 *
 * Computing the tax by subtraction rather than by multiplying the rounded
 * taxable value is what guarantees `taxable + tax === total` to the paisa. The
 * multiplication route can miss by a paisa on values like ₹7999, and the CHECK
 * constraints in migration 0080 would (correctly) reject the insert.
 *
 * ── WHY THE CGST/SGST SPLIT IS NOT `tax/2` TWICE ────────────────────────────
 *
 * priceBill() writes `cgst: round2(tax/2), sgst: round2(tax/2)`. For an odd
 * number of paise that sums to one paisa MORE than the tax: ₹18.05 → 9.03 +
 * 9.03 = 18.06. On a POS bill nothing enforces the sum so it goes unnoticed.
 * Here, `tax_total = cgst + sgst + igst` is a database CHECK, so the same code
 * would fail to insert.
 *
 * So the half is rounded ONCE and the remainder is given to SGST:
 *
 *     cgst = round2(tax / 2)
 *     sgst = round2(tax − cgst)
 *
 * Deterministic, never more than one paisa apart, and exactly summing. This is
 * a refinement of the same idea, not a different rounding rule — and
 * priceBill() is deliberately left untouched, because changing it would alter
 * every POS invoice in the product for a one-paisa presentation detail.
 */

/**
 * Indian GST state codes — the first two digits of a GSTIN.
 *
 * Reference data, not business logic: the list is published by the government
 * and changes only when a state does. It lives here so that "are these two
 * parties in the same state?" can be answered from a GSTIN without a network
 * call or a new table, and so a free-text place of supply ("Tamil Nadu", "TN",
 * "33") can be normalised to the same key.
 */
export const GST_STATE_CODES: Readonly<Record<string, string>> = {
  '01': 'Jammu and Kashmir',
  '02': 'Himachal Pradesh',
  '03': 'Punjab',
  '04': 'Chandigarh',
  '05': 'Uttarakhand',
  '06': 'Haryana',
  '07': 'Delhi',
  '08': 'Rajasthan',
  '09': 'Uttar Pradesh',
  '10': 'Bihar',
  '11': 'Sikkim',
  '12': 'Arunachal Pradesh',
  '13': 'Nagaland',
  '14': 'Manipur',
  '15': 'Mizoram',
  '16': 'Tripura',
  '17': 'Meghalaya',
  '18': 'Assam',
  '19': 'West Bengal',
  '20': 'Jharkhand',
  '21': 'Odisha',
  '22': 'Chhattisgarh',
  '23': 'Madhya Pradesh',
  '24': 'Gujarat',
  '25': 'Daman and Diu',
  '26': 'Dadra and Nagar Haveli and Daman and Diu',
  '27': 'Maharashtra',
  '28': 'Andhra Pradesh',
  '29': 'Karnataka',
  '30': 'Goa',
  '31': 'Lakshadweep',
  '32': 'Kerala',
  '33': 'Tamil Nadu',
  '34': 'Puducherry',
  '35': 'Andaman and Nicobar Islands',
  '36': 'Telangana',
  '37': 'Andhra Pradesh',
  '38': 'Ladakh',
  '97': 'Other Territory',
}

/** Lowercased state name → code, built once. Handles the two duplicate names. */
const NAME_TO_CODE: Readonly<Record<string, string>> = (() => {
  const map: Record<string, string> = {}
  for (const [code, name] of Object.entries(GST_STATE_CODES)) {
    const key = name.toLowerCase()
    // '28' (old Andhra Pradesh) and '25' (old Daman and Diu) were superseded;
    // when a name maps to two codes the LOWEST is not what a new registration
    // would carry, so the later code wins.
    map[key] = code
  }
  return map
})()

/** A few unambiguous abbreviations an operator is likely to type. */
const ABBREVIATIONS: Readonly<Record<string, string>> = {
  tn: '33',
  ka: '29',
  mh: '27',
  dl: '07',
  ts: '36',
  ap: '37',
  kl: '32',
  gj: '24',
  up: '09',
  wb: '19',
  rj: '08',
  hr: '06',
  pb: '03',
  mp: '23',
  br: '10',
  or: '21',
  od: '21',
  as: '18',
  ga: '30',
}

/**
 * The state code inside a GSTIN.
 *
 * A GSTIN is 15 characters: 2-digit state code, 10-character PAN, entity digit,
 * 'Z', checksum. Only the first two are needed here, and they are validated
 * against the published list rather than merely being "two digits" — an
 * unrecognised code means we cannot say which state, and guessing would decide
 * CGST-vs-IGST on a typo.
 */
export function stateCodeFromGstin(gstin: string | null | undefined): string | null {
  const value = gstin?.trim().toUpperCase()
  if (!value || value.length < 2) return null
  const code = value.slice(0, 2)
  return Object.hasOwn(GST_STATE_CODES, code) ? code : null
}

/**
 * Normalise whatever is stored in `business_profiles.place_of_supply` — which
 * is free text (migration 0020 puts no shape on it) — to a state code.
 *
 * Accepts a bare code ('33'), an abbreviation ('TN'), or a state name in any
 * case. Returns null when it cannot be recognised, which the caller must treat
 * as "unknown", never as "same state".
 *
 * ── Object.hasOwn, NOT `key in map`. This decides a tax ─────────────────────
 *
 * These maps are plain object literals, so `in` also answers true for every
 * member of Object.prototype. This field is FREE TEXT a tenant owner types
 * (0020 puts no shape on it), so `'constructor'` and `'__proto__'` reached the
 * lookup and returned a Function and Object.prototype respectively — from a
 * function declared to return `string | null`.
 *
 * That was not cosmetic. resolveSupplyPlace() then compared a non-string
 * against the seller's code, found them unequal, and declared the supply
 * INTER-STATE: an owner who typed either word got IGST instead of CGST+SGST on
 * a GST invoice, with `"function Object() { [native code] }-…"` snapshotted
 * into `place_of_supply`. The 0080 CHECKs could not catch it because the
 * totals still reconcile — only the tax HEAD is wrong, on a document that is
 * never rewritten.
 *
 * Same reasoning, and the same fix, as decideLimit() in
 * lib/platform/entitlement-guard.ts. Applied to every lookup in this file
 * rather than only the reachable one, so the class is gone rather than the
 * instance.
 */
export function stateCodeFromPlaceOfSupply(text: string | null | undefined): string | null {
  const value = text?.trim()
  if (!value) return null

  if (/^[0-9]{1,2}$/.test(value)) {
    const padded = value.padStart(2, '0')
    return Object.hasOwn(GST_STATE_CODES, padded) ? padded : null
  }

  const lower = value.toLowerCase()
  if (Object.hasOwn(NAME_TO_CODE, lower)) return NAME_TO_CODE[lower]
  if (lower.length === 2 && Object.hasOwn(ABBREVIATIONS, lower)) return ABBREVIATIONS[lower]
  return null
}

/** The printable name for a code, or the code itself when unknown. */
export function stateName(code: string | null | undefined): string | null {
  if (!code) return null
  return GST_STATE_CODES[code] ?? code
}

export type SupplyPlace = {
  /** The recipient's state code, or null when it could not be determined. */
  stateCode: string | null
  /** What goes on the invoice's "Place of supply" line. */
  placeOfSupply: string | null
  /** true → IGST; false → CGST + SGST. */
  interstate: boolean
}

/**
 * Decide the place of supply, and with it CGST+SGST vs IGST.
 *
 * ── The rule, stated plainly because it decides a tax ───────────────────────
 *
 *   1. The recipient's state comes from its GSTIN when it has one. A registered
 *      business's GSTIN is the authoritative statement of where it is
 *      registered, and it outranks a free-text profile field an owner typed.
 *   2. Failing that, from `business_profiles.place_of_supply`, normalised.
 *   3. Failing that, the supply is treated as INTRA-STATE (CGST + SGST).
 *
 * Step 3 is a deliberate, conservative default and not a guess dressed up as
 * one. Arena OS is a domestic Indian SaaS; the overwhelmingly common case is an
 * unregistered small business in the supplier's own state, and CGST+SGST is
 * also what every existing invoice in this codebase produces (priceBill() emits
 * nothing else). Defaulting to IGST instead would mean quietly asserting an
 * inter-state supply we have no evidence for.
 *
 * If the SUPPLIER's own state is unknown — the platform letterhead has not been
 * configured — the same intra-state default applies, because there is then no
 * pair of states to compare and inventing a difference would be worse.
 */
export function resolveSupplyPlace(input: {
  sellerStateCode: string | null
  buyerGstin: string | null
  buyerPlaceOfSupply: string | null
}): SupplyPlace {
  const buyerCode =
    stateCodeFromGstin(input.buyerGstin) ??
    stateCodeFromPlaceOfSupply(input.buyerPlaceOfSupply)

  const seller = input.sellerStateCode
  // Only a KNOWN pair of DIFFERENT states makes a supply inter-state.
  const interstate = buyerCode !== null && seller !== null && buyerCode !== seller

  const placeOfSupply = buyerCode
    ? `${buyerCode}-${stateName(buyerCode)}`
    : (input.buyerPlaceOfSupply?.trim() || null)

  return { stateCode: buyerCode, placeOfSupply, interstate }
}

export type GstSplit = {
  /** Value excluding tax. */
  taxableValue: number
  cgst: number
  sgst: number
  igst: number
  taxTotal: number
  /** Gross, tax-inclusive. Equals the input, and equals taxableValue + taxTotal. */
  total: number
}

/**
 * Extract GST from a tax-INCLUSIVE gross amount.
 *
 * Every value returned has been through round2(), and the identities
 *
 *     taxableValue + taxTotal === total
 *     cgst + sgst + igst      === taxTotal
 *
 * hold exactly — which is what migration 0080's CHECK constraints require, and
 * why the tax is derived by subtraction and the second half of the split by
 * subtraction again.
 *
 * A zero or negative gross, or a zero rate, yields an all-zero split rather
 * than throwing: a fully credited bill is a legitimate document.
 */
export function splitGstInclusive(
  grossAmount: number,
  ratePercent: number,
  interstate: boolean,
): GstSplit {
  const total = round2(Math.max(0, Number.isFinite(grossAmount) ? grossAmount : 0))
  const rate = Math.max(0, Number.isFinite(ratePercent) ? ratePercent : 0)

  if (total === 0 || rate === 0) {
    return { taxableValue: total, cgst: 0, sgst: 0, igst: 0, taxTotal: 0, total }
  }

  const taxableValue = round2(total / (1 + rate / 100))
  // By subtraction, so the two always sum to the gross that was actually paid.
  const taxTotal = round2(total - taxableValue)

  if (interstate) {
    return { taxableValue, cgst: 0, sgst: 0, igst: taxTotal, taxTotal, total }
  }

  const cgst = round2(taxTotal / 2)
  // The remainder, so cgst + sgst is exactly taxTotal even for an odd paisa.
  const sgst = round2(taxTotal - cgst)
  return { taxableValue, cgst, sgst, igst: 0, taxTotal, total }
}

/** numeric(10,2) wants a fixed 2-decimal string, never a float. */
export function money(value: number): string {
  return round2(value).toFixed(2)
}
