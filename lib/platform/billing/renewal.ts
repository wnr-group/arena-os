import { round2 } from '@/lib/billing/pricing'
import type {
  PlatformPaymentEntity,
  PlatformSubscriptionEntity,
} from './webhook'

/**
 * Deciding whether a verified delivery is a BILLABLE CHARGE (M16 #4).
 *
 * Small, pure, and its own module on purpose: "did money move, and how much?"
 * is the question that decides whether an invoice exists, and it deserves to be
 * testable without a database, a transaction or a signature.
 *
 * ── ONE EVENT BILLS. EXACTLY ONE ────────────────────────────────────────────
 *
 * The platform Razorpay account emits several events for a single renewal:
 * `subscription.charged`, then `payment.captured` for the same rupees, and
 * often `invoice.paid` as well. Each is a different VIEW of one charge. Acting
 * on more than one would invoice a business two or three times for one month —
 * and the delivery-level event-id claim would not catch it, because those are
 * genuinely different events with different ids.
 *
 * So exactly one family is authoritative here, and it is `subscription.charged`:
 * it is the only event that carries BOTH the subscription (which says whose
 * subscription and for what period) and the payment (which says how much). The
 * route already drops `payment.*` and `invoice.*` as unhandled, and this is the
 * second place the same rule is stated, at the point where money is read.
 *
 * `subscription.activated`, `resumed` and `updated` all describe a subscription
 * without a new charge. They move state and bill nothing.
 *
 * ── THE AMOUNT IS THE GATEWAY'S, NOT THE CATALOGUE'S ────────────────────────
 *
 * `payment.entity.amount` — the rupees Razorpay actually captured — is what the
 * invoice totals. The catalogue price is snapshotted beside it for comparison,
 * but never substituted for it: an invoice that disagrees with the bank
 * statement is worse than no invoice. This is also the ticket's rule about not
 * calculating a second charge when the gateway already provides the
 * authoritative amount, applied at the only place the amount enters the system.
 */

/** The only event that raises an invoice. */
export const CHARGE_EVENT = 'subscription.charged'

/**
 * Razorpay payment states that mean the money is actually in the account.
 *
 * `authorized` is a HOLD, not a capture — the same distinction
 * lib/payments/razorpay-webhook.ts draws for tenant deposits, where only
 * `payment.captured` is allowed to settle an intent. A `subscription.charged`
 * carrying a payment that failed or is merely authorised must not produce a
 * paid invoice.
 *
 * Razorpay marks subscription charges `captured`. `refunded` is deliberately
 * excluded: a refunded payment still had an invoice raised at capture time, and
 * inventing a second one on the refund event would double-count.
 */
const CAPTURED_STATUSES = new Set(['captured'])

export type BillableCharge = {
  paymentId: string
  /** The captured amount in RUPEES, converted once, here. */
  grossRupees: number
  currency: string
  gatewayInvoiceId: string | null
}

/**
 * Is this delivery a charge that should be invoiced, and for how much?
 *
 * Returns null for everything that is not — a different event, a missing
 * payment, an uncaptured payment, a zero or nonsensical amount, or a
 * subscription entity that cannot say what was charged. Every one of those is a
 * normal outcome the caller acknowledges without billing, never an exception:
 * a verified webhook we choose not to bill is not a fault.
 */
export function billableChargeFor(
  eventType: string,
  subscription: PlatformSubscriptionEntity | null,
  payment: PlatformPaymentEntity | null,
): BillableCharge | null {
  if (eventType !== CHARGE_EVENT) return null
  if (!subscription || !payment) return null

  // A payment that is not captured is not money. Absent status is treated as
  // captured because `subscription.charged` only fires on a successful charge —
  // but an EXPLICIT non-captured status is believed over that assumption.
  if (payment.status !== undefined && !CAPTURED_STATUSES.has(payment.status)) return null

  const amountPaise = payment.amount
  if (typeof amountPaise !== 'number' || !Number.isSafeInteger(amountPaise) || amountPaise <= 0) {
    return null
  }

  return {
    paymentId: payment.id,
    // Paise → rupees, through round2 so the value that reaches a numeric(10,2)
    // column has been near the project's money helper rather than a raw float.
    grossRupees: round2(amountPaise / 100),
    currency: payment.currency ?? 'INR',
    gatewayInvoiceId: payment.invoice_id ?? null,
  }
}
