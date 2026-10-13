import { loadCheckoutScript, type RazorpayCtor } from '@/lib/payments/checkout-script'
import type { BookingPaymentCheckout } from '@/lib/payments/booking-payment'

/**
 * Open Razorpay Checkout for a booking's payment intent — shared by the two
 * booking pages (first attempt) and the confirmation page (retry).
 *
 * The success handler is UNAUTHENTICATED client input, never proof of payment:
 * it only means "go and wait for the webhook". Callers route to the
 * confirmation page, which polls the real booking status.
 */
export async function openBookingCheckout(opts: {
  checkout: BookingPaymentCheckout
  tenantName: string
  bookingNumber: string
  name?: string
  phone?: string
  onSubmitted: () => void
  onDismissed: () => void
}): Promise<{ ok: true } | { ok: false; error: string }> {
  let Razorpay: RazorpayCtor
  try {
    Razorpay = await loadCheckoutScript()
  } catch {
    return { ok: false, error: 'The payment window could not load. Check your connection and try again.' }
  }
  const { orderId, amount, currency, keyId } = opts.checkout
  const rzp = new Razorpay({
    key: keyId,
    order_id: orderId,
    amount,
    currency,
    name: opts.tenantName,
    description: `Booking #${opts.bookingNumber}`,
    prefill: {
      ...(opts.name ? { name: opts.name } : {}),
      ...(opts.phone ? { contact: opts.phone } : {}),
    },
    handler: () => opts.onSubmitted(),
    modal: { ondismiss: () => opts.onDismissed() },
  })
  rzp.open()
  return { ok: true }
}
