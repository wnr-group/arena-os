/**
 * M36 #2 — resolveOnlineCharge, table-driven (pure; no database).
 *   npx tsx --import ./scripts/server-only-hook.mjs scripts/test-online-charge.ts
 */
import { resolveOnlineCharge, OnlineChargeError, type OnlinePaymentPolicy } from '../lib/booking/online-charge'

let pass = 0
let fail = 0
const check = (label: string, cond: boolean, got?: unknown) => {
  console.log(`${cond ? '✓' : '✗ FAIL'}  ${label}${cond ? '' : `  (got: ${JSON.stringify(got)})`}`)
  if (cond) pass++
  else fail++
}
const P = (mode: OnlinePaymentPolicy['mode'], advanceType: 'fixed' | 'percent' | null = null, advanceValue: number | null = null): OnlinePaymentPolicy => ({ mode, advanceType, advanceValue })

const rows: [string, OnlinePaymentPolicy, number, { payNow?: boolean }, { required: boolean; amount: number; balance: number }][] = [
  ['venue', P('venue'), 2950, {}, { required: false, amount: 0, balance: 2950 }],
  ['venue ignores payNow', P('venue'), 2950, { payNow: true }, { required: false, amount: 0, balance: 2950 }],
  ['full', P('full'), 2950, {}, { required: true, amount: 2950, balance: 0 }],
  ['full ignores payNow:false', P('full'), 2950, { payNow: false }, { required: true, amount: 2950, balance: 0 }],
  ['full rounds to paise', P('full'), 100.005, {}, { required: true, amount: 100.01, balance: 0 }],
  ['advance fixed 500 of 4000', P('advance', 'fixed', 500), 4000, {}, { required: true, amount: 500, balance: 3500 }],
  ['advance fixed > total is capped', P('advance', 'fixed', 500), 300, {}, { required: true, amount: 300, balance: 0 }],
  ['advance fixed == total', P('advance', 'fixed', 300), 300, {}, { required: true, amount: 300, balance: 0 }],
  ['advance 25% of 4000', P('advance', 'percent', 25), 4000, {}, { required: true, amount: 1000, balance: 3000 }],
  ['advance 33.333% of 1000 rounds to 2dp', P('advance', 'percent', 33.333), 1000, {}, { required: true, amount: 333.33, balance: 666.67 }],
  ['advance 33.33% of 100.01', P('advance', 'percent', 33.33), 100.01, {}, { required: true, amount: 33.33, balance: 66.68 }],
  ['advance 99.99% never above total', P('advance', 'percent', 99.99), 1, {}, { required: true, amount: 1, balance: 0 }],
  ['advance 1% of 50 (₹0.50) is raised to the ₹1 minimum', P('advance', 'percent', 1), 50, {}, { required: true, amount: 1, balance: 49 }],
  ['advance fixed ₹0.25 is raised to ₹1', P('advance', 'fixed', 0.25), 800, {}, { required: true, amount: 1, balance: 799 }],
  ['tiny total ₹1 charges ₹1', P('full'), 1, {}, { required: true, amount: 1, balance: 0 }],
  ['total under ₹1 cannot be charged online', P('full'), 0.5, {}, { required: false, amount: 0, balance: 0.5 }],
  ['zero total: nothing in full', P('full'), 0, {}, { required: false, amount: 0, balance: 0 }],
  ['zero total: nothing in advance', P('advance', 'percent', 50), 0, {}, { required: false, amount: 0, balance: 0 }],
  ['negative total: nothing', P('full'), -5, {}, { required: false, amount: 0, balance: 0 }],
  ['legacy without payNow', P('optional_full'), 2950, {}, { required: false, amount: 0, balance: 2950 }],
  ['legacy with payNow = full, not required', P('optional_full'), 2950, { payNow: true }, { required: false, amount: 2950, balance: 0 }],
]
for (const [label, policy, subtotal, opts, want] of rows) {
  const got = resolveOnlineCharge(policy, subtotal, opts)
  check(label, got.required === want.required && got.amount === want.amount && got.balance === want.balance, got)
}
const throws = (label: string, fn: () => unknown) => {
  try {
    fn()
    check(label, false, 'did not throw')
  } catch (e) {
    check(label, e instanceof OnlineChargeError, String(e))
  }
}
throws('full above MAX_PAYMENT_AMOUNT refused', () => resolveOnlineCharge(P('full'), 100_000_000))
throws('advance with no value is a config error', () => resolveOnlineCharge(P('advance'), 1000))
throws('advance with value 0 is a config error', () => resolveOnlineCharge(P('advance', 'fixed', 0), 1000))
check('advance below the cap on a huge total is allowed', resolveOnlineCharge(P('advance', 'fixed', 500), 100_000_000).amount === 500)
check('amount + balance always equals the total', [0.1, 1, 33.33, 999.99, 12345.67].every((t) => {
  const c = resolveOnlineCharge(P('advance', 'percent', 33.333), t)
  return Math.round((c.amount + c.balance) * 100) === Math.round(t * 100) || c.amount === 0
}))
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
