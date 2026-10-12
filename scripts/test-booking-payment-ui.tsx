/**
 * M36 #5 — static render checks for the storefront payment step:
 * BookingPaymentSummary / paymentFlow (labels and amounts per venue mode) and
 * PendingPaymentPanel (confirming / held / expired). The amounts shown are
 * the server quote's own numbers; the server side (charge == deposit == Razorpay
 * order amount) is covered by test-public-booking-payment-modes.ts and
 * test-booking-pending-payment.ts.
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs --import ./scripts/next-runtime-hook.mjs scripts/test-booking-payment-ui.tsx
 */
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime'
import { loadEnv } from './env'

loadEnv()

let pass = 0
let fail = 0
const check = (label: string, cond: boolean, got?: unknown) => {
  console.log(`${cond ? '✓' : '✗ FAIL'}  ${label}${cond ? '' : `  (got: ${typeof got === 'string' ? got.slice(0, 400) : JSON.stringify(got)})`}`)
  if (cond) pass++
  else fail++
}

async function main() {
  const { BookingPaymentSummary, paymentFlow } = await import('../components/public-booking/BookingPaymentSummary')
  const { PendingPaymentPanel } = await import('../components/public-booking/PendingPaymentPanel')

  const router = { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} }
  const render = (el: React.ReactElement) =>
    renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: router as never }, el))
  const noop = () => {}
  const summary = (payment: Parameters<typeof BookingPaymentSummary>[0]['payment'], o: { total?: number | null; rz?: boolean; payOnline?: boolean; loading?: boolean } = {}) =>
    render(
      <BookingPaymentSummary
        payment={payment}
        total={o.total === undefined ? 4000 : o.total}
        currency="INR"
        loading={o.loading ?? false}
        razorpayConfigured={o.rz ?? true}
        payOnline={o.payOnline ?? false}
        onPayOnline={noop}
      />,
    )
  const flow = (payment: Parameters<typeof BookingPaymentSummary>[0]['payment'], o: { total?: number | null; rz?: boolean; payOnline?: boolean } = {}) =>
    paymentFlow(payment, { razorpayConfigured: o.rz ?? true, payOnline: o.payOnline ?? false, total: o.total === undefined ? 4000 : o.total, currency: 'INR' })

  const venue = { mode: 'venue' as const, paymentRequired: false, chargeNow: 0, balanceDue: 4000 }
  const advance = { mode: 'advance' as const, paymentRequired: true, chargeNow: 500, balanceDue: 3500 }
  const full = { mode: 'full' as const, paymentRequired: true, chargeNow: 4000, balanceDue: 0 }
  const legacy = { mode: 'optional_full' as const, paymentRequired: false, chargeNow: 4000, balanceDue: 0 }

  console.log('\n── pay at venue ──')
  check('venue: no payment UI at all', summary(venue) === '')
  check('venue: button says "Confirm booking", nothing paid online', flow(venue).label === 'Confirm booking' && flow(venue).paysOnline === false)
  check('venue with Razorpay not configured: still no payment UI', summary(venue, { rz: false }) === '' && flow(venue, { rz: false }).label === 'Confirm booking')

  console.log('\n── collect advance ──')
  const adv = summary(advance)
  check('advance: shows Pay now ₹500 and balance ₹3,500 at the venue', adv.includes('Pay now to confirm') && adv.includes('₹500') && adv.includes('Balance payable at the venue') && adv.includes('₹3,500'), adv)
  check('advance: helper text "Remaining ₹3,500 to be paid at the venue"', adv.includes('Remaining') && adv.includes('to be paid at the venue'), adv)
  check('advance: no opt-out toggle', !adv.includes('Pay at venue</button>') && !adv.includes('How would you like to pay'))
  check('advance: button "Pay ₹500.00 & confirm" and pays online', /^Pay ₹500(.00)? & confirm$/.test(flow(advance).label) && flow(advance).paysOnline && flow(advance).amount === 500, flow(advance))
  check('advance: payOnline state is irrelevant (not an opt-out)', flow(advance, { payOnline: false }).paysOnline === true)
  check('advance: a refreshing quote dims the block instead of removing it (no layout shift)', summary(advance, { loading: true }).includes('opacity-60') && summary(advance, { loading: true }).includes('₹500'))
  check('advance: live region for screen readers', adv.includes('aria-live="polite"'))

  console.log('\n── collect full ──')
  const fu = summary(full)
  check('full: shows Pay now ₹4,000 and no balance line', fu.includes('₹4,000') && !fu.includes('Balance payable'), fu)
  check('full: button "Pay ₹4,000.00 & confirm"', flow(full).label === 'Pay ₹4,000.00 & confirm' && flow(full).paysOnline, flow(full))

  console.log('\n── legacy optional_full (unchanged) ──')
  const lg = summary(legacy)
  check('legacy: the Pay at venue / Pay online now toggle is still there', lg.includes('How would you like to pay?') && lg.includes('Pay at venue') && lg.includes('Pay online now'))
  check('legacy: toggle off -> "Confirm booking"; on -> "Confirm & pay"', flow(legacy).label === 'Confirm booking' && flow(legacy, { payOnline: true }).label === 'Confirm & pay' && flow(legacy, { payOnline: true }).paysOnline)
  check('legacy without Razorpay configured: no toggle, never pays online', summary(legacy, { rz: false }) === '' && flow(legacy, { rz: false, payOnline: true }).paysOnline === false)

  console.log('\n── edge cases ──')
  check('quote not loaded yet: nothing rendered, plain label', summary(null) === '' && flow(null).label === 'Confirm booking')
  check('free booking (total 0): no payment UI', summary({ ...advance, chargeNow: 0, balanceDue: 0 }, { total: 0 }) === '' && flow({ ...advance, chargeNow: 0, balanceDue: 0 }, { total: 0 }).paysOnline === false)

  console.log('\n── confirmation page panel ──')
  const future = new Date(Date.now() + 10 * 60_000).toISOString()
  const past = new Date(Date.now() - 60_000).toISOString()
  const panel = (o: { justPaid?: boolean; holdExpiresAt?: string | null; holdReleased?: boolean } = {}) =>
    render(
      <PendingPaymentPanel
        token="11111111-1111-4111-8111-111111111111"
        bookingNumber="BK-1"
        deposit="500.00"
        holdExpiresAt={o.holdExpiresAt === undefined ? future : o.holdExpiresAt}
        holdReleased={o.holdReleased ?? false}
        justPaid={o.justPaid ?? false}
        tenantName="Venue"
        timeZone="Asia/Kolkata"
        currency="INR"
        customerName="QA"
      />,
    )
  const held = panel()
  check('dismissed checkout: "Payment not completed — your slot is held until hh:mm"', /Payment not completed — your slot is held until \d{2}:\d{2}\s?[AP]M/.test(held), held)
  check('…with a Retry payment button and a Start over link', held.includes('Retry payment') && held.includes('Start over') && held.includes('href="/resources"'))
  check('…showing the amount due', held.includes('₹500'))
  const paid = panel({ justPaid: true })
  check('after success: "Confirming your payment…" status, no Retry (never a second payment)', paid.includes('Confirming your payment') && paid.includes('role="status"') && !paid.includes('Retry payment'), paid)
  const exp = panel({ holdExpiresAt: past })
  check('expired hold: "This hold expired" with a way to pick a time again', exp.includes('This hold expired') && exp.includes('Pick a time again') && !exp.includes('Retry payment'), exp)
  const rel = panel({ holdReleased: true, holdExpiresAt: null })
  check('released by the sweep: same expired state', rel.includes('This hold expired') && !rel.includes('Retry payment'))
  check('tap targets are at least 44px tall (min-h-11)', held.split('min-h-11').length >= 3)

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
