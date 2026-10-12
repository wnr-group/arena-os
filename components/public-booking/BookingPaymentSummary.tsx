import { CreditCard, Wallet } from 'lucide-react'
import { formatMoney } from '@/lib/format'

/** What the server quote says the storefront will charge (getPublicBookingQuote). */
export type QuotePayment = {
  mode: 'optional_full' | 'venue' | 'advance' | 'full'
  paymentRequired: boolean
  chargeNow: number
  balanceDue: number
}

export type PaymentFlow = {
  /** The booking will be paid online at confirm time. */
  paysOnline: boolean
  /** Rupees collected now (the server's figure — never computed here). */
  amount: number
  /** Primary button text. */
  label: string
}

/**
 * The one place the booking pages decide what the final step does, from the
 * venue mode in the server quote. The customer's only choice is the legacy
 * `optional_full` toggle; advance / full / venue are not opt-outs.
 */
export function paymentFlow(
  payment: QuotePayment | null,
  o: { razorpayConfigured: boolean; payOnline: boolean; total: number | null; currency: string },
): PaymentFlow {
  const none = { paysOnline: false, amount: 0, label: 'Confirm booking' }
  if (!payment || o.total === null) return none
  if (payment.mode === 'advance' || payment.mode === 'full') {
    return payment.chargeNow > 0
      ? { paysOnline: true, amount: payment.chargeNow, label: `Pay ${formatMoney(payment.chargeNow, o.currency)} & confirm` }
      : none
  }
  if (payment.mode === 'optional_full') {
    const pays = o.razorpayConfigured && o.payOnline && o.total > 0
    return pays ? { paysOnline: true, amount: payment.chargeNow, label: 'Confirm & pay' } : none
  }
  return none
}

/**
 * Payment block of the booking summary. Reserves its space while the quote
 * refreshes (dimmed, not removed) so the page does not jump.
 */
export function BookingPaymentSummary({
  payment,
  total,
  currency,
  loading,
  razorpayConfigured,
  payOnline,
  onPayOnline,
}: {
  payment: QuotePayment | null
  total: number | null
  currency: string
  loading: boolean
  razorpayConfigured: boolean
  payOnline: boolean
  onPayOnline: (v: boolean) => void
}) {
  if (!payment || total === null || total <= 0) return null

  if (payment.mode === 'optional_full') {
    if (!razorpayConfigured) return null
    return (
      <div className="mt-6">
        <span className="mb-2 block text-sm font-semibold text-muted-foreground">How would you like to pay?</span>
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => onPayOnline(false)}
            aria-pressed={!payOnline}
            className={`flex items-center justify-center gap-1.5 rounded-xl border px-3 py-2.5 text-sm font-bold transition ${
              !payOnline ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:border-primary/40'
            }`}
          >
            <Wallet size={15} /> Pay at venue
          </button>
          <button
            type="button"
            onClick={() => onPayOnline(true)}
            aria-pressed={payOnline}
            className={`flex items-center justify-center gap-1.5 rounded-xl border px-3 py-2.5 text-sm font-bold transition ${
              payOnline ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:border-primary/40'
            }`}
          >
            <CreditCard size={15} /> Pay online now
          </button>
        </div>
      </div>
    )
  }

  if (payment.mode === 'venue' || payment.chargeNow <= 0) return null

  const hasBalance = payment.balanceDue > 0
  return (
    <div
      className={`mt-4 space-y-2 rounded-xl border border-primary/20 bg-primary/5 p-3 text-sm transition-opacity ${loading ? 'opacity-60' : ''}`}
      aria-live="polite"
      aria-busy={loading}
    >
      <div className="flex items-center justify-between font-bold text-foreground">
        <span className="flex items-center gap-1.5">
          <CreditCard size={15} className="text-primary" /> Pay now to confirm
        </span>
        <span className="tabular-nums text-primary">{formatMoney(payment.chargeNow, currency)}</span>
      </div>
      {hasBalance && (
        <div className="flex items-center justify-between text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <Wallet size={15} /> Balance payable at the venue
          </span>
          <span className="tabular-nums">{formatMoney(payment.balanceDue, currency)}</span>
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        Your booking is confirmed once the payment succeeds.
        {hasBalance && ` Remaining ${formatMoney(payment.balanceDue, currency)} to be paid at the venue.`}
      </p>
    </div>
  )
}
