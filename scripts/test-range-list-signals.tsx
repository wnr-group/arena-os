/**
 * Multi-day bookings list (M34 #4) shows the same two payment signals as the
 * day table — static-markup render, no database and no browser:
 *
 *   - a cancelled booking with a paid online deposit (depositReviewRequired, #40)
 *     carries the red "Paid — refund required" pill: that flag is how staff find
 *     refunds owed, so it must not vanish on Last 7 days / This month
 *   - a pending_payment row shows "(expires hh:mm)" in the tenant's timezone
 *   - a plain cancelled row and an ordinary pending row show neither
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs --import ./scripts/next-runtime-hook.mjs scripts/test-range-list-signals.tsx
 */
import { renderToStaticMarkup } from 'react-dom/server'
import { AppRouterContext, type AppRouterInstance } from 'next/dist/shared/lib/app-router-context.shared-runtime'
import { ConfirmDialogProvider } from '../components/ui/ConfirmDialog'
import { BookingsRangeList, type RangeRow } from '../components/bookings/BookingsRangeList'
import { REFUND_REQUIRED_LABEL } from '../components/bookings/bookingBadges'

let pass = 0,
  fail = 0
const check = (l: string, c: boolean, got?: unknown) => {
  console.log(`${c ? '✓' : '✗ FAIL'}  ${l}${c ? '' : `  (got: ${String(got).slice(0, 300)})`}`)
  if (c) pass++
  else fail++
}
const count = (html: string, needle: string) => html.split(needle).length - 1

const TZ = 'Asia/Kolkata'
const row = (n: string, status: string, over: Partial<RangeRow> = {}): RangeRow => ({
  bookingId: `id-${n}`,
  bookingNumber: `B-${n}`,
  customerName: `Cust ${n}`,
  customerPhone: null,
  status,
  source: 'online',
  total: '500.00',
  deposit: '100.00',
  cancellationReason: null,
  paymentHoldExpiresAt: null,
  depositReviewRequired: false,
  backdated: false,
  bookingCreatedAt: '2045-04-09T05:00:00Z',
  firstStartsAt: '2045-04-10T05:30:00Z',
  lastEndsAt: '2045-04-10T06:30:00Z',
  isOpen: false,
  resourceNames: ['Table 1'],
  slotsTotal: '500.00',
  activeSlotsTotal: '500.00',
  advancePaid: '0.00',
  ...over,
})

// The detail panel calls useRouter(); nothing navigates in a static render.
const router = {} as AppRouterInstance
const render = (rows: RangeRow[]) =>
  renderToStaticMarkup(
    <AppRouterContext.Provider value={router}>
      <ConfirmDialogProvider>
    <BookingsRangeList
      rows={rows}
      fromDate="2045-04-10"
      rangeLabel="10 – 10 Apr 2045"
      summary={{ bookings: rows.length, byStatus: {} }}
      timeZone={TZ}
      currency="INR"
      venueName="Test"
      paymentStates={{}}
      depositStates={{}}
      ordersByBooking={{}}
      canRequestVoidComp={false}
      canEditAddons={false}
      showFoodOrdering={false}
    />
      </ConfirmDialogProvider>
    </AppRouterContext.Provider>,
  )
// The text of one booking's row button, so assertions can't be satisfied by another row.
const rowHtml = (html: string, n: string) => html.split('<button').find((b) => b.includes(`View booking B-${n}`)) ?? ''

// 09:00 UTC = 14:30 IST
const html = render([
  row('refund', 'cancelled', { depositReviewRequired: true, cancellationReason: 'Customer cancelled' }),
  row('plain', 'cancelled'),
  row('hold', 'pending_payment', { paymentHoldExpiresAt: '2045-04-10T09:00:00Z' }),
  row('nohold', 'pending_payment'),
  row('conf', 'confirmed'),
])

check('cancelled + paid deposit → refund pill', rowHtml(html, 'refund').includes(REFUND_REQUIRED_LABEL), rowHtml(html, 'refund'))
check('plain cancelled row → no refund pill', !rowHtml(html, 'plain').includes(REFUND_REQUIRED_LABEL))
check('refund pill appears exactly once across the list', count(html, REFUND_REQUIRED_LABEL) === 1, count(html, REFUND_REQUIRED_LABEL))
check('pending_payment with a hold → "(expires 14:30)" in the tenant timezone', rowHtml(html, 'hold').includes('Awaiting payment (expires 14:30)'), rowHtml(html, 'hold'))
check('pending_payment without a hold → no expiry text', !rowHtml(html, 'nohold').includes('expires'))
check('non-pending row never shows an expiry', !rowHtml(html, 'conf').includes('expires'))
check(
  'a stale hold on a non-pending row is ignored',
  !rowHtml(render([row('x', 'confirmed', { paymentHoldExpiresAt: '2045-04-10T09:00:00Z' })]), 'x').includes('expires'),
)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
