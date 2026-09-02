'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { CreditCard, Clock3, CheckCircle2 } from 'lucide-react'
import { createDepositOrder } from '@/lib/actions/payments'
import { formatMoney } from '@/lib/format'
import { loadCheckoutScript, type RazorpayCtor } from '@/lib/payments/checkout-script'

/**
 * "Pay deposit" — opens Razorpay Checkout for a booking's deposit.
 *
 * ── What this component knows ───────────────────────────────────────────────
 * A booking id, the deposit amount FOR DISPLAY, and whether a deposit is
 * already pending or paid. The displayed amount is never what gets charged:
 * the server re-reads `bookings.deposit` under a row lock and creates the
 * gateway order from that. Tampering with the props changes the label and
 * nothing else.
 *
 * ── What it never receives ──────────────────────────────────────────────────
 * The Razorpay key secret. The action returns a publishable key id and an order
 * id, which is exactly and only what Checkout needs.
 *
 * ── What "success" means here ───────────────────────────────────────────────
 * Nothing, financially. Razorpay's browser callback is not proof of payment —
 * it is unauthenticated client input. This component therefore never reports
 * "paid"; it reports "confirming", and AROS-50's signed webhook is what
 * actually settles the deposit.
 */

export function DepositButton({
  bookingId,
  bookingNumber,
  /** Rupees, 2dp string, for the label only. */
  depositAmount,
  currency,
  venueName,
  customerName,
  customerPhone,
  depositStatus,
}: {
  bookingId: string
  bookingNumber: string
  depositAmount: string
  currency: string
  venueName: string
  customerName: string | null
  customerPhone: string | null
  depositStatus: 'none' | 'pending' | 'paid'
}) {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [pending, start] = useTransition()

  const amount = Number(depositAmount)
  if (!Number.isFinite(amount) || amount <= 0) return null

  if (depositStatus === 'paid') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-md bg-emerald-500/10 px-3 py-1.5 text-sm font-medium text-emerald-600">
        <CheckCircle2 size={15} /> Deposit paid
      </span>
    )
  }

  function pay() {
    if (pending) return
    setError(null)
    setNotice(null)

    start(async () => {
      // The server computes the amount. Only the booking id is sent.
      const r = await createDepositOrder({ bookingId })
      if (r.error || !r.checkout) {
        setError(r.error ?? 'Could not start the deposit payment.')
        return
      }
      const { orderId, amount: amountPaise, currency: orderCurrency, keyId } = r.checkout

      let Razorpay: RazorpayCtor
      try {
        Razorpay = await loadCheckoutScript()
      } catch {
        setError('Could not load the payment window. Check your connection and try again.')
        return
      }

      const checkout = new Razorpay({
        key: keyId,
        order_id: orderId,
        amount: amountPaise,
        currency: orderCurrency,
        name: venueName,
        description: `Deposit for ${bookingNumber}`,
        prefill: {
          ...(customerName ? { name: customerName } : {}),
          ...(customerPhone ? { contact: customerPhone } : {}),
        },
        // NOT a confirmation. Razorpay's callback is client-side and unsigned,
        // so it only tells us to stop showing the form and go wait for the
        // webhook. Nothing is marked paid from the browser.
        handler: () => {
          setNotice('Payment submitted — confirming with the gateway. This page will update once it clears.')
          router.refresh()
        },
        modal: {
          ondismiss: () => {
            setNotice('Payment window closed. The deposit order stays open — you can resume it.')
            router.refresh()
          },
        },
      })
      checkout.open()
    })
  }

  return (
    <div className="w-full">
      <button
        onClick={pay}
        disabled={pending}
        className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
      >
        {depositStatus === 'pending' ? <Clock3 size={15} /> : <CreditCard size={15} />}
        {pending
          ? 'Opening…'
          : depositStatus === 'pending'
            ? `Resume ${formatMoney(amount, currency)} deposit`
            : `Pay ${formatMoney(amount, currency)} deposit`}
      </button>

      {depositStatus === 'pending' && !notice && !error && (
        <p className="mt-1.5 text-xs text-amber-600">
          A deposit order is open and awaiting confirmation from the gateway.
        </p>
      )}
      {notice && <p className="mt-1.5 text-xs text-muted-foreground">{notice}</p>}
      {error && <p className="mt-1.5 text-xs text-destructive">{error}</p>}
    </div>
  )
}
