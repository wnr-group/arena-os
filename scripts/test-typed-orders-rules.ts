/**
 * Takeaway / delivery rules (M20 / AROS-182) — pure, no database.
 *
 *   npx tsx scripts/test-typed-orders-rules.ts
 */
import {
  FINAL_STAGES,
  isFinalStage,
  minutesUntil,
  nextHandovers,
  orderStage,
  typeEnabled,
  validateHandover,
  validateTypedOrder,
} from '../lib/orders/typed-rules'

let pass = 0,
  fail = 0
const check = (l: string, c: boolean) => {
  console.log(`${c ? '✓' : '✗ FAIL'}  ${l}`)
  if (c) pass++
  else fail++
}
const NOW = new Date('2026-10-23T12:00:00Z')

// ── stage = the kitchen ticket + the stored handover ────────────────────────
const st = (kotStatus: string | null, handoverStatus: 'out_for_delivery' | 'collected' | 'delivered' | null = null, orderStatus = 'open') =>
  orderStage({ orderStatus, kotStatus, handoverStatus })
check('a new ticket is "received"', st('pending') === 'received')
check('the cook started it: "preparing"', st('preparing') === 'preparing')
check('the cook finished it: "ready"', st('ready') === 'ready')
check('a served ticket still reads "ready" until it is handed over', st('served') === 'ready')
check('no ticket at all is "received" rather than an error', st(null) === 'received')
check('a handover step wins over the kitchen state', st('ready', 'out_for_delivery') === 'out_for_delivery' && st('served', 'delivered') === 'delivered' && st('served', 'collected') === 'collected')
check('a cancelled order is cancelled whatever the ticket says', st('ready', null, 'cancelled') === 'cancelled' && st('cancelled') === 'cancelled')
check('final stages are collected, delivered, cancelled', FINAL_STAGES.every(isFinalStage) && !isFinalStage('ready') && !isFinalStage('out_for_delivery'))

// ── what may happen next ────────────────────────────────────────────────────
check('takeaway: ready -> collected only', nextHandovers('takeaway', 'ready').join() === 'collected')
check('takeaway: nothing before ready, nothing after collected', nextHandovers('takeaway', 'received').length === 0 && nextHandovers('takeaway', 'preparing').length === 0 && nextHandovers('takeaway', 'collected').length === 0)
check('delivery: ready -> out for delivery, then -> delivered', nextHandovers('delivery', 'ready').join() === 'out_for_delivery' && nextHandovers('delivery', 'out_for_delivery').join() === 'delivered')
check('delivery cannot be "collected"', !nextHandovers('delivery', 'ready').includes('collected'))
check('dine-in has no handover at all', nextHandovers('dine_in', 'ready').length === 0)

const hv = (o: Parameters<typeof validateHandover>[0]) => validateHandover(o)
check('valid takeaway handover passes', hv({ orderType: 'takeaway', stage: 'ready', to: 'collected' }) === null)
check('before the kitchen is done is refused with that reason', /kitchen/i.test(hv({ orderType: 'takeaway', stage: 'preparing', to: 'collected' }) ?? ''))
check('a delivery cannot leave without a named driver', hv({ orderType: 'delivery', stage: 'ready', to: 'out_for_delivery' }) !== null && hv({ orderType: 'delivery', stage: 'ready', to: 'out_for_delivery', driverName: '  ' }) !== null)
check('...and can with one', hv({ orderType: 'delivery', stage: 'ready', to: 'out_for_delivery', driverName: 'Ravi' }) === null)
check('delivered after out for delivery passes (driver already on the order)', hv({ orderType: 'delivery', stage: 'out_for_delivery', to: 'delivered' }) === null)
check('skipping straight to delivered is refused', hv({ orderType: 'delivery', stage: 'ready', to: 'delivered', driverName: 'Ravi' }) !== null)
check('an order that is already over cannot move again', /already/i.test(hv({ orderType: 'takeaway', stage: 'collected', to: 'collected' }) ?? '') && hv({ orderType: 'delivery', stage: 'cancelled', to: 'out_for_delivery', driverName: 'R' }) !== null)
check('dine-in orders are refused', hv({ orderType: 'dine_in', stage: 'ready', to: 'collected' }) !== null)

// ── validating a new order ──────────────────────────────────────────────────
const base = { orderType: 'takeaway' as const, contactName: 'Priya' }
check('a minimal takeaway is valid', validateTypedOrder(base, NOW) === null)
check('takeaway needs a name', validateTypedOrder({ ...base, contactName: '  ' }, NOW) !== null)
check('takeaway cannot carry an address or a fee', validateTypedOrder({ ...base, deliveryAddress: '12 MG Road' }, NOW) !== null && validateTypedOrder({ ...base, deliveryFee: 30 }, NOW) !== null)
const dl = { orderType: 'delivery' as const, contactName: 'Priya', contactPhone: '9876543210', deliveryAddress: '12 MG Road, Pune' }
check('a full delivery is valid', validateTypedOrder(dl, NOW) === null && validateTypedOrder({ ...dl, deliveryFee: 40, deliveryFeeTaxRate: 18 }, NOW) === null)
check('delivery needs a phone', validateTypedOrder({ ...dl, contactPhone: '' }, NOW) !== null && validateTypedOrder({ ...dl, contactPhone: 'abc' }, NOW) !== null)
check('delivery needs an address', validateTypedOrder({ ...dl, deliveryAddress: ' ' }, NOW) !== null && validateTypedOrder({ ...dl, deliveryAddress: null }, NOW) !== null)
check('a negative / absurd / NaN fee is refused', validateTypedOrder({ ...dl, deliveryFee: -1 }, NOW) !== null && validateTypedOrder({ ...dl, deliveryFee: 1e9 }, NOW) !== null && validateTypedOrder({ ...dl, deliveryFee: NaN }, NOW) !== null)
check('GST on the fee must be 0–100', validateTypedOrder({ ...dl, deliveryFeeTaxRate: 101 }, NOW) !== null && validateTypedOrder({ ...dl, deliveryFeeTaxRate: -1 }, NOW) !== null)
check('a pickup time in the past is refused, a few minutes ago is fine', validateTypedOrder({ ...base, pickupAt: new Date(NOW.getTime() - 3_600_000) }, NOW) !== null && validateTypedOrder({ ...base, pickupAt: new Date(NOW.getTime() - 60_000) }, NOW) === null)
check('a future pickup time is fine', validateTypedOrder({ ...base, pickupAt: new Date(NOW.getTime() + 3_600_000) }, NOW) === null)
check('over-long name / address refused', validateTypedOrder({ ...base, contactName: 'x'.repeat(81) }, NOW) !== null && validateTypedOrder({ ...dl, deliveryAddress: 'x'.repeat(301) }, NOW) !== null)
check('an unknown type is refused', validateTypedOrder({ ...base, orderType: 'dine_in' as never }, NOW) !== null)

// ── settings gate + clock ───────────────────────────────────────────────────
check('each type is gated by its own switch', typeEnabled({ takeawayEnabled: true, deliveryEnabled: false }, 'takeaway') && !typeEnabled({ takeawayEnabled: true, deliveryEnabled: false }, 'delivery') && typeEnabled({ takeawayEnabled: false, deliveryEnabled: true }, 'delivery'))
check('minutes until a pickup (negative = overdue, null = no time asked)', minutesUntil(new Date(NOW.getTime() + 15 * 60_000), NOW) === 15 && minutesUntil(new Date(NOW.getTime() - 5 * 60_000), NOW) === -5 && minutesUntil(null, NOW) === null)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
