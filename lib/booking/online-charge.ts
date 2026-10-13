import { MAX_PAYMENT_AMOUNT } from '@/lib/billing/payments'
import { paise, round2 } from '@/lib/billing/pricing'

/**
 * What the storefront charges at booking time (M36 #2) — one pure function, so
 * the quote the customer sees, the deposit createPublicBooking persists and the
 * test table all come from the same arithmetic.
 *
 * Basis is the pre-tax booking subtotal (room/setup + add-ons), the same base
 * the old "pay online now" used. Tax is added at invoicing and the POS bill
 * collects invoice total − captured payments, so advance + balance at the venue
 * always equals the final invoice; the confirmation page labels the amounts
 * "before tax" accordingly.
 */

export type OnlinePaymentPolicy = {
  mode: 'optional_full' | 'venue' | 'advance' | 'full'
  advanceType: 'fixed' | 'percent' | null
  advanceValue: number | null
}

export type OnlineCharge = {
  /** The booking cannot be confirmed without paying `amount` online. */
  required: boolean
  /** Rupees to charge now (0 = nothing online). Always a whole number of paise. */
  amount: number
  /** subtotal − amount: settled later at the venue. */
  balance: number
}

/** Razorpay's smallest chargeable order is ₹1.00. */
export const MIN_ONLINE_CHARGE = 1

/** How long an unpaid advance/full booking holds its slot (M36 #3). Constant for v1;
 *  #4 releases a hold that outlives it. */
export const PAYMENT_HOLD_MINUTES = 15

export class OnlineChargeError extends Error {}

/**
 * - venue            → nothing online
 * - full             → the whole subtotal
 * - advance fixed    → min(value, subtotal)
 * - advance percent  → round2(subtotal × value/100), never above subtotal
 * - optional_full    → legacy: charged (in full) only when the client asks (`payNow`)
 *
 * Any positive charge is raised to MIN_ONLINE_CHARGE (a 1% advance on ₹50 is
 * ₹0.50, which the gateway would reject) and never exceeds the subtotal. A
 * subtotal under ₹1 cannot be charged online at all, and a zero subtotal never
 * creates a gateway order — both come back as "nothing online". Throws when the
 * charge would exceed MAX_PAYMENT_AMOUNT.
 */
export function resolveOnlineCharge(
  policy: OnlinePaymentPolicy,
  subtotal: number,
  opts: { payNow?: boolean } = {},
): OnlineCharge {
  const total = round2(subtotal)
  const none: OnlineCharge = { required: false, amount: 0, balance: Math.max(total, 0) }
  if (!Number.isFinite(total) || total < MIN_ONLINE_CHARGE) return none

  let raw: number
  let required = true
  switch (policy.mode) {
    case 'venue':
      return none
    case 'full':
      raw = total
      break
    case 'advance': {
      const v = policy.advanceValue
      if (!policy.advanceType || v == null || !(v > 0)) {
        throw new OnlineChargeError('This venue’s advance is not configured correctly.')
      }
      raw = policy.advanceType === 'fixed' ? v : round2((total * v) / 100)
      break
    }
    case 'optional_full':
      if (!opts.payNow) return none
      raw = total
      required = false
      break
  }
  const amount = round2(Math.min(total, Math.max(raw, MIN_ONLINE_CHARGE)))
  if (amount > MAX_PAYMENT_AMOUNT || !Number.isSafeInteger(paise(amount))) {
    throw new OnlineChargeError('This booking total is too large to pay online.')
  }
  return { required, amount, balance: round2(total - amount) }
}
