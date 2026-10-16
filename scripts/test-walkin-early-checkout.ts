/**
 * Timed walk-in checked out EARLY frees the resource at checkout, not at the
 * original end time — while the bill stays exactly as before.
 *
 *   E1  early checkout trims booking_slots.ends_at to ~now; bookings.committed_end_at
 *       (the original commitment) is untouched
 *   E2  the BILL is unchanged: slot_total and the add-on line are still priced
 *       over the full committed window
 *   E3  the add-on's ends_at follows the slot, so its stock is released at checkout
 *   E4  the same resource accepts a new walk-in starting at checkout time
 *   E5  the invoice line still shows the BOOKED end (a full-hour charge must not
 *       read as a shorter session)
 *   R1  undo checkout (reopen) restores ends_at from committed_end_at, unprices
 *       the slot and re-holds the add-on
 *   R2  reopen is REFUSED, with a clear message and nothing changed, once the
 *       freed time on the resource has been taken
 *   R3  reopen is REFUSED when the add-on's stock was taken in the freed window
 *   R4  an open tab is unaffected
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs --import ./scripts/next-runtime-hook.mjs scripts/test-walkin-early-checkout.ts
 */
import { Pool } from 'pg'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { sql } from 'drizzle-orm'
import * as schema from '../db/schema'
import { createBookingCore, BookingError } from '../lib/booking/service'
import { startWalkinCore, checkoutWalkinCore, reopenWalkinCore, earlyCheckoutEnd } from '../lib/booking/walkin'
import { addonHeadroom, lockAddonCatalog } from '../lib/booking/addons'
import { loadBookingLines } from '../lib/billing/invoice'
import { timeInZone } from '../lib/format'
import { loadEnv } from './env'
import { allowFarBookings } from './booking-window-fixture'

type Db = NodePgDatabase<typeof schema>

let pass = 0,
  fail = 0
const check = (l: string, c: boolean, got?: unknown) => {
  console.log(`${c ? '✓' : '✗ FAIL'}  ${l}${c ? '' : `  (got: ${JSON.stringify(got)})`}`)
  if (c) pass++
  else fail++
}

const TZ = 'Asia/Kolkata'
const MIN = 60_000
const HOUR = 60 * MIN

async function main() {
  loadEnv()
  const ownerPool = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })
  const appPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 })
  const app = drizzle(appPool, { schema })
  const withUser = <T>(userId: string, fn: (tx: Db) => Promise<T>): Promise<T> =>
    app.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`)
      return fn(tx as unknown as Db)
    })
  const q = <T extends object>(text: string, params: unknown[] = []) => ownerPool.query<T>(text, params)

  const slug = 'testwalkinearlyco'
  await q(`delete from tenants where slug=$1`, [slug])
  const tenantId = (
    await q<{ id: string }>(
      `insert into tenants (slug,name,status,timezone,industry) values ($1,$2,'active',$3,'gaming_cafe') returning id`,
      [slug, `${slug} co`, TZ],
    )
  ).rows[0].id
  await allowFarBookings((t, p) => q(t, p), tenantId)
  const branchId = (
    await q<{ id: string }>(`insert into branches (tenant_id,name,is_primary) values ($1,'Main',true) returning id`, [tenantId])
  ).rows[0].id
  const userId = (
    await q<{ id: string }>(
      `insert into users (email,password_hash) values ($1,'x') on conflict (email) do update set email=excluded.email returning id`,
      [`owner@${slug}.test`],
    )
  ).rows[0].id
  const membershipId = (
    await q<{ id: string }>(`insert into memberships (tenant_id,user_id,role,status) values ($1,$2,'owner','active') returning id`, [tenantId, userId])
  ).rows[0].id
  await q(`insert into business_profiles (tenant_id) values ($1) on conflict (tenant_id) do nothing`, [tenantId])
  const typeId = (
    await q<{ id: string }>(`insert into resource_types (tenant_id,name,hourly_rate) values ($1,'Station','100.00') returning id`, [tenantId])
  ).rows[0].id
  const mkResource = async (name: string) =>
    (
      await q<{ id: string }>(
        `insert into resources (tenant_id,branch_id,resource_type_id,name,status) values ($1,$2,$3,$4,'available') returning id`,
        [tenantId, branchId, typeId, name],
      )
    ).rows[0].id
  const mkAddon = async (name: string, rate: string, stock: number) =>
    (
      await q<{ id: string }>(
        `insert into resource_type_addons (tenant_id,branch_id,resource_type_id,name,rate,rate_unit,stock_quantity)
         values ($1,$2,$3,$4,$5,'hour',$6) returning id`,
        [tenantId, branchId, typeId, name, rate, stock],
      )
    ).rows[0].id

  const ctx = { tenantId, timezone: TZ, membershipId }
  const startTimed = (resourceId: string, durationMin: number, addonId?: string) =>
    withUser(userId, (tx) =>
      startWalkinCore(tx, ctx, {
        branchId,
        resourceId,
        phone: '9876543210',
        startAt: new Date().toISOString(),
        mode: 'timed',
        durationMin,
        addons: addonId ? [{ addonId, quantity: 1 }] : undefined,
      }),
    )
  const checkout = (bookingId: string) => withUser(userId, (tx) => checkoutWalkinCore(tx, ctx, { bookingId }))
  const reopen = (bookingId: string) => withUser(userId, (tx) => reopenWalkinCore(tx, ctx, bookingId))
  const slot = async (bookingId: string) =>
    (
      await q<{ starts_at: Date; ends_at: Date | null; slot_total: string }>(
        `select starts_at, ends_at, slot_total from booking_slots where booking_id=$1`,
        [bookingId],
      )
    ).rows[0]
  const committed = async (bookingId: string) =>
    (await q<{ committed_end_at: Date | null }>(`select committed_end_at from bookings where id=$1`, [bookingId])).rows[0].committed_end_at
  const addonRow = async (bookingId: string) =>
    (await q<{ ends_at: Date | null; line_total: string }>(`select ends_at,line_total from booking_addons where booking_id=$1`, [bookingId])).rows[0]
  const headroom = (addonId: string, from: Date, to: Date | null) =>
    withUser(userId, async (tx) => {
      const row = (await lockAddonCatalog(tx, tenantId, [addonId])).get(addonId)!
      return addonHeadroom(tx, tenantId, row, from, to)
    })
  const errOf = async (p: Promise<unknown>) => {
    try {
      await p
      return null
    } catch (e) {
      return e instanceof BookingError ? e.message : `non-BookingError: ${String(e)}`
    }
  }

  // ── E1–E5: early checkout frees the resource, bill unchanged ──────────────
  console.log('\n── early checkout ──')
  const camera = await mkAddon('Camera', '50.00', 1)
  const rA = await mkResource('Station A')
  const w = await startTimed(rA, 60, camera)
  const committedEnd = (await committed(w.id))!
  const before = await slot(w.id)
  check('start: slot ends_at = committed_end_at (60 min)', +before.ends_at! === +committedEnd && +committedEnd - +before.starts_at === HOUR)

  const checkedOutAt = Date.now()
  const co = await checkout(w.id)
  const after = await slot(w.id)
  check(
    'E1 slot ends_at trimmed to ~checkout time (well before the committed end)',
    after.ends_at !== null && Math.abs(+after.ends_at - checkedOutAt) < 15_000 && +after.ends_at < +committedEnd - 30 * MIN,
    after,
  )
  check('E1 bookings.committed_end_at is untouched (original commitment kept)', +(await committed(w.id))! === +committedEnd)
  check('E2 slot_total still the FULL booked hour (100.00)', after.slot_total === '100.00', after.slot_total)
  const ad = await addonRow(w.id)
  check('E2 add-on line still priced over the committed hour (50.00); booking total 150', ad.line_total === '50.00' && co.total === 150, { line: ad.line_total, total: co.total })
  check('E3 add-on ends_at follows the trimmed slot end', ad.ends_at !== null && +ad.ends_at === +after.ends_at!, ad.ends_at)
  check(
    'E3 add-on stock is released: a window after checkout has headroom 1',
    (await headroom(camera, new Date(+after.ends_at! + MIN), new Date(+after.ends_at! + 30 * MIN))) === 1,
  )
  check(
    'E3 ...but a window overlapping the session itself is still held (0)',
    (await headroom(camera, new Date(+before.starts_at - MIN), new Date(+before.starts_at + MIN))) === 0,
  )

  const lines = await withUser(userId, (tx) => loadBookingLines(tx, tenantId, w.id, TZ))
  check(
    'E5 invoice line shows the BOOKED end, not the early leave time',
    lines.length === 1 && lines[0].description.endsWith(`–${timeInZone(committedEnd, TZ)}`) && lines[0].unitPrice === 100,
    lines[0]?.description,
  )

  const next = await startTimed(rA, 30)
    .then((r) => ({ ok: true as const, id: r.id }))
    .catch((e) => ({ ok: false as const, e: String(e) }))
  check('E4 the freed resource accepts a new walk-in starting at checkout time', next.ok, next)

  // ── R2: reopen refused once the freed time is taken ───────────────────────
  console.log('\n── reopen ──')
  const rejected = await errOf(reopen(w.id))
  check('R2 reopen refused when the station was booked after checkout, with a clear message', !!rejected && /booked after/i.test(rejected), rejected)
  const stillOut = await slot(w.id)
  check('R2 ...nothing changed: still trimmed and still billed', +stillOut.ends_at! === +after.ends_at! && stillOut.slot_total === '100.00')

  // ── R1: reopen succeeds when the time is still free ───────────────────────
  const rB = await mkResource('Station B')
  const w2 = await startTimed(rB, 60, camera)
  const committed2 = (await committed(w2.id))!
  await checkout(w2.id)
  check('R1 setup: checked out early (trimmed)', +(await slot(w2.id)).ends_at! < +committed2 - 30 * MIN)
  const re = await errOf(reopen(w2.id))
  check('R1 reopen succeeds when the freed time is still free', re === null, re)
  const re2 = await slot(w2.id)
  check('R1 ends_at restored from committed_end_at, slot unpriced', +re2.ends_at! === +committed2 && re2.slot_total === '0.00', re2)
  const reAd = await addonRow(w2.id)
  check('R1 add-on holds the full window again and is unpriced', reAd.ends_at !== null && +reAd.ends_at === +committed2 && reAd.line_total === '0.00', reAd)
  check('R1 reopened session blocks its station again (a new walk-in is refused)', (await errOf(startTimed(rB, 30))) !== null)
  const co2 = await checkout(w2.id)
    .then(() => true)
    .catch(() => false)
  check('R1 ...and it can be checked out again', co2)

  // ── R3: reopen refused when the add-on stock was taken meanwhile ──────────
  const lens = await mkAddon('Lens', '40.00', 1)
  const rC = await mkResource('Station C')
  const rD = await mkResource('Station D')
  const w3 = await startTimed(rC, 60, lens)
  await checkout(w3.id)
  const freedFrom = new Date(Date.now() + 5 * MIN)
  const took = await withUser(userId, (tx) =>
    createBookingCore(tx, ctx, {
      branchId,
      customerName: 'T',
      customerPhone: '9876543211',
      source: 'staff',
      discount: 0,
      deposit: 0,
      slots: [
        {
          resourceId: rD,
          startsAt: freedFrom.toISOString(),
          endsAt: new Date(+freedFrom + HOUR).toISOString(),
          addons: [{ addonId: lens, quantity: 1 }],
        },
      ],
    }),
  )
    .then(() => true as const)
    .catch((e) => String(e))
  check('R3 setup: the lens unit was bookable in the freed window', took === true, took)
  const stock = await errOf(reopen(w3.id))
  check('R3 reopen refused when the add-on stock was taken, with a BookingError', !!stock && !stock.startsWith('non-BookingError'), stock)
  const w3slot = await slot(w3.id)
  check('R3 ...nothing changed: still billed', Number(w3slot.slot_total) > 0, w3slot)

  // ── R4: an open tab is unaffected ─────────────────────────────────────────
  const rE = await mkResource('Station E')
  const tab = await withUser(userId, (tx) =>
    startWalkinCore(tx, ctx, { branchId, resourceId: rE, phone: '9876543210', startAt: new Date().toISOString(), mode: 'open_tab' }),
  )
  await checkout(tab.id)
  const tabSlot = await slot(tab.id)
  check('R4 open-tab checkout still stamps a bounded ends_at', tabSlot.ends_at !== null && Number(tabSlot.slot_total) > 0)
  const tabRe = await errOf(reopen(tab.id))
  check('R4 open-tab reopen still works and unbounds ends_at', tabRe === null && (await slot(tab.id)).ends_at === null, tabRe)

  // ── pure: which instant a checkout trims to (injected clock) ─────────────
  console.log('\n── earlyCheckoutEnd (pure) ──')
  const s0 = new Date('2045-04-10T10:00:00Z')
  const c0 = new Date(+s0 + HOUR)
  const w0 = { startsAt: s0, committedEndAt: c0 }
  const at = (m: number) => new Date(+s0 + m * MIN)
  check('45 minutes in: trims to that instant', +earlyCheckoutEnd(w0, at(45))! === +at(45))
  check('exactly at the committed end: nothing to trim', earlyCheckoutEnd(w0, at(60)) === null)
  check('after the committed end: nothing to trim', earlyCheckoutEnd(w0, at(75)) === null)
  check('at the start instant: not trimmed (would break ends_at > starts_at)', earlyCheckoutEnd(w0, at(0)) === null)
  check('before the start (clock skew): not trimmed', earlyCheckoutEnd(w0, at(-1)) === null)
  check('no committed end (open tab): not trimmed', earlyCheckoutEnd({ startsAt: s0, committedEndAt: null }, at(30)) === null)

  await q(`delete from tenants where slug=$1`, [slug])
  await ownerPool.end()
  await appPool.end()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
