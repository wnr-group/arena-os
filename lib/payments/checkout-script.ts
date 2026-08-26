'use client'

/**
 * Loading Razorpay Checkout's script, lazily and once.
 *
 * Shared by every client component that opens Checkout — currently
 * DepositButton (booking deposits) and CheckoutClient's pay-now path
 * (standalone orders, M14 #6 v2) — so there is exactly one place that
 * decides how the script is fetched and cached, not two copies that could
 * drift.
 */

const CHECKOUT_SRC = 'https://checkout.razorpay.com/v1/checkout.js'

export type RazorpayOptions = {
  key: string
  order_id: string
  amount: number
  currency: string
  name: string
  description: string
  prefill?: { name?: string; contact?: string }
  modal?: { ondismiss?: () => void }
  handler?: () => void
}
export type RazorpayInstance = { open: () => void }
export type RazorpayCtor = new (options: RazorpayOptions) => RazorpayInstance

declare global {
  interface Window {
    Razorpay?: RazorpayCtor
  }
}

/** Load Checkout once, lazily — it is not needed until a "pay" button is pressed. */
export function loadCheckoutScript(): Promise<RazorpayCtor> {
  if (typeof window === 'undefined') return Promise.reject(new Error('not in a browser'))
  if (window.Razorpay) return Promise.resolve(window.Razorpay)

  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${CHECKOUT_SRC}"]`)
    const script = existing ?? document.createElement('script')

    const onLoad = () => {
      if (window.Razorpay) resolve(window.Razorpay)
      else reject(new Error('checkout unavailable'))
    }
    script.addEventListener('load', onLoad, { once: true })
    script.addEventListener('error', () => reject(new Error('checkout failed to load')), {
      once: true,
    })

    if (!existing) {
      script.src = CHECKOUT_SRC
      script.async = true
      document.body.appendChild(script)
    }
  })
}
