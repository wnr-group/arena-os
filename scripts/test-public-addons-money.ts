/**
 * M35 #5 — add-ons through the anonymous public booking path: money parity,
 * tampering, and last-unit concurrency. Real server actions, running as
 * arena_app (no BYPASSRLS); the owner pool only seeds and inspects.
 *
 *   parity       setup + add-ons: booking total = booking_addons sum = bill
 *                lines = deposit = the amount sent to the (stub) gateway
 *   pay-now off  add-ons still attach and total, deposit stays 0
 *   day rate     daily add-on = max(1, ceil(h/24)); hourly add-on = exact hours
 *   tampering    foreign / other-type / retired add-ons, bad quantities and
 *                client-supplied prices are refused or ignored; no booking row
 *   concurrency  two simultaneous anon bookings for the last unit: one wins,
 *                the other gets a clear error and leaves no booking behind
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs --import ./scripts/next-runtime-hook.mjs scripts/test-public-addons-money.ts
 */
import { randomBytes, randomInt } from 'node:crypto'
import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import * as schema from '../db/schema'
import { loadEnv } from './env'

loadEnv()

let pass = 0
let fail = 0
const check = (label: string, cond: boolean, got?: unknown) => {
  console.log(`${cond ? '✓' : '✗ FAIL'}  ${label}${cond ? '' : `  (got: ${JSON.stringify(got)})`}`)
  if (cond) pass++
  else fail++
}

async function main() {
  const { getPublicBookingQuote, getPublicBookingDayRange, createPublicBooking } = await import('../lib/actions/public-booking')
  const { createBookingPaymentIntent } = await import('../lib/payments/booking-payment')
  const { withPublicTenant } = await import('../db')
  const { loadBillLines } = await import('../lib/billing/invoice')

  const owner = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })
  const ownerDb = drizzle(owner, { schema })
  const tag = randomBytes(3).toString('hex')
  const digits = String(randomInt(0, 1_000_000_000)).padStart(9, '0')
  let phoneSeq = 0
  const nextPhone = () => `9${String(Number(digits) + ++phoneSeq).padStart(9, '0')}`
  const q = <T extends object>(text: string, params: unknown[] = []) => owner.query<T>(text, params)
  const g = globalThis as { __ARENA_TEST_HEADERS?: Record<string, string> }
  const slug = `pub-money-${tag}`
  // Each phase gets its own client IP so the per-IP booking limit (5 / 10 min)
  // — which this test is not about — never gets in the way.
  let ipSeq = 0
  const freshIp = () => {
    g.__ARENA_TEST_HEADERS = { 'x-tenant-slug': slug, 'x-forwarded-for': `10.9.${tag.charCodeAt(0)}.${++ipSeq}` }
  }
  freshIp()

  const mkTenant = async (s: string) => {
    const tenantId = (
      await q<{ id: string }>(
        `insert into tenants (slug,name,status,timezone,industry) values ($1,'Money QA','active','Asia/Kolkata','recording_studio') returning id`,
        [s],
      )
    ).rows[0].id
    const branchId = (await q<{ id: string }>(`insert into branches (tenant_id,name,is_primary,status) values ($1,'Main',true,'active') returning id`, [tenantId])).rows[0].id
    const typeId = (await q<{ id: string }>(`insert into resource_types (tenant_id,name,hourly_rate) values ($1,'Studio Set','500.00') returning id`, [tenantId])).rows[0].id
    return { tenantId, branchId, typeId }
  }
  const T = await mkTenant(slug)
  const other = await mkTenant(`${slug}-x`)
  const otherTypeId = (await q<{ id: string }>(`insert into resource_types (tenant_id,name,hourly_rate) values ($1,'Booth','100.00') returning id`, [T.tenantId])).rows[0].id
  const mkSet = async (name: string) =>
    (await q<{ id: string }>(`insert into resources (tenant_id,branch_id,resource_type_id,name,status) values ($1,$2,$3,$4,'available') returning id`, [T.tenantId, T.branchId, T.typeId, name])).rows[0].id
  const setA = await mkSet('Set A')
  const setB = await mkSet('Set B')
  const mkSetup = async (resourceId: string, name: string, rate: string, unit: string) =>
    (await q<{ id: string }>(`insert into resource_setups (tenant_id,resource_id,name,rate,rate_unit,is_active) values ($1,$2,$3,$4,$5,true) returning id`, [T.tenantId, resourceId, name, rate, unit])).rows[0].id
  const podcast = await mkSetup(setA, 'Podcast', '800.00', 'hour')
  const royal = await mkSetup(setA, 'Royal', '6000.00', 'day')
  const mkAddon = async (t: { tenantId: string; branchId: string; typeId: string }, name: string, rate: string, unit: string, stock: number, active = true, typeOverride?: string) =>
    (
      await q<{ id: string }>(
        `insert into resource_type_addons (tenant_id,branch_id,resource_type_id,name,rate,rate_unit,stock_quantity,is_active) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
        [t.tenantId, t.branchId, typeOverride ?? t.typeId, name, rate, unit, stock, active],
      )
    ).rows[0].id
  const camera = await mkAddon(T, 'Camera', '300.00', 'hour', 10)
  const lens = await mkAddon(T, 'Lens', '150.00', 'day', 10)
  const last = await mkAddon(T, 'Last Light', '100.00', 'hour', 1)
  const retired = await mkAddon(T, 'Retired', '10.00', 'hour', 5, false)
  const wrongType = await mkAddon(T, 'Booth mic', '10.00', 'hour', 5, true, otherTypeId)
  const foreign = await mkAddon(other, 'Foreign', '10.00', 'hour', 5)
  await (await import('./seed-razorpay')).seedRazorpay(q, T.tenantId)
  for (let dow = 0; dow <= 6; dow++) {
    await q(`insert into working_hours (tenant_id,branch_id,day_of_week,open_time,close_time,is_closed) values ($1,$2,$3,'09:00','22:00',false)`, [T.tenantId, T.branchId, dow])
  }

  const day = (offset: number, hour: number) => {
    const d = new Date()
    d.setUTCDate(d.getUTCDate() + offset)
    d.setUTCHours(hour, 0, 0, 0)
    return d
  }
  const win = (resourceId: string, offset: number, hour: number, hours: number) => {
    const s = day(offset, hour)
    return { resourceId, startsAt: s.toISOString(), endsAt: new Date(s.getTime() + hours * 3_600_000).toISOString() }
  }
  const bookingCount = async () => Number((await q<{ n: string }>(`select count(*) n from bookings where tenant_id=$1`, [T.tenantId])).rows[0].n)

  // ── parity: setup + 2 add-ons, pay now ───────────────────────────────────
  // Podcast 2h = 1600; Camera 2 x 300 x 2h = 1200; Lens 1 x 150 x 1 day = 150
  const w1 = win(setA, 3, 4, 2)
  const addons1 = [{ addonId: camera, quantity: 2 }, { addonId: lens, quantity: 1 }]
  const quote1 = await getPublicBookingQuote({ ...w1, setupId: podcast, addons: addons1 })
  check('quote = setup 1600 + camera 1200 + lens 150 = 2950', quote1.total === 2950 && quote1.slotTotal === 1600, quote1)
  const created1 = await createPublicBooking({ ...w1, setupId: podcast, addons: addons1, customerName: 'Parity', customerPhone: nextPhone(), payNow: true, website: '' })
  check('booking created', Boolean(created1.bookingId) && !created1.error, created1)
  const b1 = (await q<{ subtotal: string; total: string; deposit: string }>(`select subtotal,total,deposit from bookings where id=$1`, [created1.bookingId])).rows[0]
  const lines1 = (await q<{ addon_name: string; rate_unit: string; rate_applied: string; quantity: number; line_total: string }>(`select addon_name,rate_unit,rate_applied,quantity,line_total from booking_addons where booking_id=$1 order by addon_name`, [created1.bookingId])).rows
  const addonSum = lines1.reduce((s, l) => s + Number(l.line_total), 0)
  check('booking total = deposit = quote = 2950.00', b1.total === '2950.00' && b1.deposit === '2950.00' && b1.subtotal === '2950.00', b1)
  check('booking_addons sum = 1350 and snapshot has name/unit/rate', addonSum === 1350 && lines1[0].addon_name === 'Camera' && lines1[0].rate_unit === 'hour' && lines1[0].rate_applied === '300.00', lines1)
  const bill = await loadBillLines(ownerDb as never, T.tenantId, created1.bookingId!, 'Asia/Kolkata')
  const billTotal = bill.filter((l) => l.kind === 'booking' || l.kind === 'addon').reduce((s, l) => s + l.unitPrice * l.qty, 0)
  check('invoice lines (booking + add-ons) = booking total', Math.round(billTotal * 100) === 295000, bill.map((l) => [l.kind, l.unitPrice, l.qty]))
  let gatewayPaise = -1
  const checkout = await createBookingPaymentIntent(
    { bookingId: created1.bookingId! },
    {
      runInTx: (fn) => withPublicTenant(T.tenantId, fn),
      credentials: { keyId: 'k', keySecret: 's' } as never,
      createOrder: async (_c, o) => {
        gatewayPaise = o.amountPaise
        return { id: 'order_test', amount: o.amountPaise, currency: 'INR', status: 'created', receipt: o.receipt ?? null }
      },
      actor: { tenantId: T.tenantId },
    },
  )
  check('amount sent to the gateway = booking total (295000 paise)', gatewayPaise === 295000 && checkout.amount === 295000, { gatewayPaise, checkout })

  // ── pay-now off: still attached, billed later ───────────────────────────
  freshIp()
  const w2 = win(setB, 3, 4, 2)
  const created2 = await createPublicBooking({ ...w2, addons: [{ addonId: camera, quantity: 1 }], customerName: 'Venue', customerPhone: nextPhone(), website: '' })
  const b2 = (await q<{ total: string; deposit: string }>(`select total,deposit from bookings where id=$1`, [created2.bookingId])).rows[0]
  const n2 = Number((await q<{ n: string }>(`select count(*) n from booking_addons where booking_id=$1`, [created2.bookingId])).rows[0].n)
  check('pay-now off: add-on attached, total 1000+600, deposit 0', n2 === 1 && b2.total === '1600.00' && b2.deposit === '0.00', b2)

  // ── day-rate setup + daily & hourly add-ons ──────────────────────────────
  freshIp()
  const range = await getPublicBookingDayRange({ resourceId: setA, startDate: day(10, 0).toISOString().slice(0, 10), endDate: day(12, 0).toISOString().slice(0, 10) })
  const hours = (new Date(range.endsAt!).getTime() - new Date(range.startsAt!).getTime()) / 3_600_000
  const dq = await getPublicBookingQuote({ resourceId: setA, startsAt: range.startsAt!, endsAt: range.endsAt!, setupId: royal, addons: [{ addonId: lens, quantity: 2 }, { addonId: camera, quantity: 1 }] })
  const lensL = dq.addons?.find((a) => a.name === 'Lens')
  const camL = dq.addons?.find((a) => a.name === 'Camera')
  const days = Math.max(1, Math.ceil(hours / 24 - 1e-9))
  check(`day-rate window ${hours}h: daily add-on = ${days} units, hourly = exact hours`, lensL?.units === days && camL?.units === hours && lensL.lineTotal === 150 * 2 * days && camL.lineTotal === 300 * hours, dq)
  check('day-rate total = 3 x 6000 + add-ons', dq.total === 18000 + 150 * 2 * days + 300 * hours, dq)

  // ── tampering ────────────────────────────────────────────────────────────
  freshIp()
  const before = await bookingCount()
  const w3 = win(setB, 5, 4, 2)
  const attempt = (addons: unknown, extra: Record<string, unknown> = {}) =>
    createPublicBooking({ ...w3, addons, customerName: 'Tamper', customerPhone: nextPhone(), website: '', ...extra } as never)
  const bad: [string, unknown][] = [
    ['foreign-tenant add-on', [{ addonId: foreign, quantity: 1 }]],
    ['other-type add-on', [{ addonId: wrongType, quantity: 1 }]],
    ['inactive add-on', [{ addonId: retired, quantity: 1 }]],
    ['unknown add-on', [{ addonId: '00000000-0000-4000-8000-000000000000', quantity: 1 }]],
    ['quantity 0', [{ addonId: camera, quantity: 0 }]],
    ['negative quantity', [{ addonId: camera, quantity: -3 }]],
    ['quantity above the cap', [{ addonId: camera, quantity: 21 }]],
    ['huge quantity', [{ addonId: camera, quantity: 1_000_000 }]],
    ['fractional quantity', [{ addonId: camera, quantity: 1.5 }]],
  ]
  for (const [label, addons] of bad) {
    const r = await attempt(addons)
    check(`${label} refused`, Boolean(r.error) && !r.bookingId, r)
  }
  check('no booking rows were created by any refused attempt', (await bookingCount()) === before, { before, after: await bookingCount() })
  const qBad = await getPublicBookingQuote({ ...w3, addons: [{ addonId: foreign, quantity: 1 }] } as never)
  check('quote refuses a foreign add-on too', Boolean(qBad.error), qBad)

  // client-supplied prices are ignored; duplicates merge rather than double-count
  freshIp()
  const priced = await createPublicBooking({
    ...win(setB, 6, 4, 2),
    addons: [{ addonId: camera, quantity: 1, rate: '0.01', lineTotal: 0, price: 1 }, { addonId: camera, quantity: 1 }],
    total: 1,
    subtotal: 1,
    deposit: 1,
    customerName: 'Price',
    customerPhone: nextPhone(),
    website: '',
  } as never)
  const pr = priced.bookingId
    ? (await q<{ total: string; q: number; rate_applied: string }>(`select b.total, sum(a.quantity)::int q, max(a.rate_applied) rate_applied from bookings b join booking_addons a on a.booking_id=b.id where b.id=$1 group by b.total`, [priced.bookingId])).rows[0]
    : undefined
  check('client price fields ignored: catalog rate 300, duplicates merged to 2, total 1000 + 1200', pr?.total === '2200.00' && pr?.q === 2 && pr?.rate_applied === '300.00', { priced, pr })

  // ── last-unit concurrency (two anon bookings, different sets, same window) ─
  freshIp()
  const w4a = win(setA, 8, 4, 2)
  const w4b = win(setB, 8, 4, 2)
  const before4 = await bookingCount()
  const [r1, r2] = await Promise.all([
    createPublicBooking({ ...w4a, addons: [{ addonId: last, quantity: 1 }], customerName: 'Race A', customerPhone: nextPhone(), website: '' }),
    createPublicBooking({ ...w4b, addons: [{ addonId: last, quantity: 1 }], customerName: 'Race B', customerPhone: nextPhone(), website: '' }),
  ])
  const winners = [r1, r2].filter((r) => r.bookingId && !r.error)
  const losers = [r1, r2].filter((r) => r.error)
  check('exactly one of two simultaneous bookings wins the last unit', winners.length === 1 && losers.length === 1, [r1, r2])
  check('the loser gets a clear stock message', /out of stock|left|just taken/i.test(losers[0]?.error ?? ''), losers[0])
  const held = Number((await q<{ s: string }>(`select coalesce(sum(quantity),0) s from booking_addons where addon_id=$1`, [last])).rows[0].s)
  check('exactly 1 unit held and exactly 1 new booking row (no half-created booking)', held === 1 && (await bookingCount()) === before4 + 1, { held, delta: (await bookingCount()) - before4 })

  await q('delete from tenants where id in ($1,$2)', [T.tenantId, other.tenantId])
  await owner.end()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
