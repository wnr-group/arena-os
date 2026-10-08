/**
 * M33 #5 — walk-in add-ons: ends_at lockstep + checkout pricing (needs
 * migration 0108). booking_addons.ends_at must track booking_slots.ends_at at
 * EVERY site that writes the latter, or live availability corrupts:
 *
 *   extend         timed walk-in extended → add-on ends_at moves with it
 *   correct (M31)  end time corrected earlier AND later → add-on follows
 *   open tab       while active (null ends_at) it BLOCKS a conflicting attach;
 *                  checkout stamps the end and frees the units immediately —
 *                  not before, not after
 *   late checkout  (M32) a checkout entered in the past stamps THAT end, so
 *                  stock frees from the real end, not from "now"
 *   reopen (M25)   the tab is unbounded again → blocks again, lines unpriced
 *   pricing        add-on line_total is computed only at checkout; extend and
 *                  correct never reprice. Daily-rate = ceil(elapsed h / 24)
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs --import ./scripts/next-runtime-hook.mjs scripts/test-walkin-addon-lockstep.ts
 */
import { Pool } from 'pg'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { sql } from 'drizzle-orm'
import * as schema from '../db/schema'
import { createBookingCore, BookingError } from '../lib/booking/service'
import {
  startWalkinCore,
  extendWalkinCore,
  correctWalkinEndTimeCore,
  checkoutWalkinCore,
  reopenWalkinCore,
} from '../lib/booking/walkin'
import { addonHeadroom, lockAddonCatalog } from '../lib/booking/addons'
import { loadEnv } from './env'

type Db = NodePgDatabase<typeof schema>

let pass = 0,
  fail = 0
const check = (l: string, c: boolean) => {
  console.log(`${c ? '✓' : '✗ FAIL'}  ${l}`)
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

  const slug = 'testwalkinaddons'
  await q(`delete from tenants where slug=$1`, [slug])
  const tenantId = (
    await q<{ id: string }>(
      `insert into tenants (slug,name,status,timezone,industry) values ($1,$2,'active',$3,'gaming_cafe') returning id`,
      [slug, `${slug} co`, TZ],
    )
  ).rows[0].id
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
  const mkAddon = async (name: string, rate: string, unit: 'hour' | 'day', stock: number) =>
    (
      await q<{ id: string }>(
        `insert into resource_type_addons (tenant_id,branch_id,resource_type_id,name,rate,rate_unit,stock_quantity)
         values ($1,$2,$3,$4,$5,$6,$7) returning id`,
        [tenantId, branchId, typeId, name, rate, unit, stock],
      )
    ).rows[0].id

  const ctx = { tenantId, timezone: TZ, membershipId }
  const startWalkin = (resourceId: string, mode: 'timed' | 'open_tab', addonId: string, durationMin?: number) =>
    withUser(userId, (tx) =>
      startWalkinCore(tx, ctx, {
        branchId,
        resourceId,
        phone: '9876543210',
        startAt: new Date().toISOString(),
        mode,
        durationMin,
        addons: [{ addonId, quantity: 1 }],
      }),
    )
  const addonRow = async (bookingId: string) =>
    (await q<{ ends_at: Date | null; line_total: string }>(`select ends_at,line_total from booking_addons where booking_id=$1`, [bookingId])).rows[0]
  const slotEnd = async (bookingId: string) =>
    (await q<{ ends_at: Date | null }>(`select ends_at from booking_slots where booking_id=$1`, [bookingId])).rows[0].ends_at
  const same = (a: Date | null, b: Date | null) => (a === null ? b === null : b !== null && +a === +b)
  const headroom = (addonId: string, from: Date, to: Date | null) =>
    withUser(userId, async (tx) => {
      const row = (await lockAddonCatalog(tx, tenantId, [addonId])).get(addonId)!
      return addonHeadroom(tx, tenantId, row, from, to)
    })
  const reservedBooking = (resourceId: string, start: Date) =>
    withUser(userId, (tx) =>
      createBookingCore(tx, ctx, {
        branchId,
        customerName: 'T',
        customerPhone: '9876543211',
        source: 'staff',
        discount: 0,
        deposit: 0,
        slots: [{ resourceId, startsAt: start.toISOString(), endsAt: new Date(+start + HOUR).toISOString(), addons: [{ addonId: tracked, quantity: 1 }] }],
      }),
    )

  // ── timed walk-in: extend + correct move the add-on with the slot ─────────
  const camera = await mkAddon('Camera', '100.00', 'hour', 5)
  const rTimed = await mkResource('Timed 1')
  const w = await startWalkin(rTimed, 'timed', camera, 60)
  const t0 = await slotEnd(w.id)
  check('T1 at start, add-on window = slot window', same((await addonRow(w.id)).ends_at, t0))

  await withUser(userId, (tx) => extendWalkinCore(tx, { tenantId }, { bookingId: w.id, addMinutes: 45 }))
  const extended = await slotEnd(w.id)
  check('T2 extend: slot end moved +45min', +extended! === +t0! + 45 * MIN)
  check('T3 extend: add-on ends_at moved with it', same((await addonRow(w.id)).ends_at, extended))
  check('T4 extend did NOT reprice the add-on (still 0.00)', (await addonRow(w.id)).line_total === '0.00')

  const later = new Date(Date.now() + 5 * HOUR)
  await withUser(userId, (tx) => correctWalkinEndTimeCore(tx, ctx, { bookingId: w.id, newEndAt: later.toISOString() }))
  check('T5 correct LATER (M31): add-on follows the slot', same((await addonRow(w.id)).ends_at, await slotEnd(w.id)) && +(await slotEnd(w.id))! === +later)
  const earlier = new Date(Date.now() + 90 * MIN)
  await withUser(userId, (tx) => correctWalkinEndTimeCore(tx, ctx, { bookingId: w.id, newEndAt: earlier.toISOString() }))
  check('T6 correct EARLIER (M31): add-on follows the slot', same((await addonRow(w.id)).ends_at, await slotEnd(w.id)) && +(await slotEnd(w.id))! === +earlier)
  check('T7 correct did NOT reprice the add-on', (await addonRow(w.id)).line_total === '0.00')

  // ── open tab: blocks while active, frees exactly at checkout ──────────────
  const tracked = await mkAddon('Tracked', '50.00', 'hour', 1)
  const rTab = await mkResource('Tab 1')
  const rOther = await mkResource('Other 1')
  const tab = await startWalkin(rTab, 'open_tab', tracked)
  check('O1 open tab: add-on ends_at is NULL while active', (await addonRow(tab.id)).ends_at === null)
  const farFuture = new Date(Date.now() + 30 * 24 * HOUR)
  let blocked = false
  try {
    await reservedBooking(rOther, farFuture)
  } catch (e) {
    blocked = e instanceof BookingError
  }
  check('O2 a conflicting attach on another booking is refused while the tab is active', blocked)
  check('O3 headroom is 0 for any later window while active', (await headroom(tracked, farFuture, new Date(+farFuture + HOUR))) === 0)

  const checkoutAt = new Date()
  await withUser(userId, (tx) => checkoutWalkinCore(tx, ctx, { bookingId: tab.id, endAt: checkoutAt.toISOString() }))
  const stamped = (await addonRow(tab.id)).ends_at
  check('O4 checkout stamps add-on ends_at = the slot ends_at (set, not null)', stamped !== null && same(stamped, await slotEnd(tab.id)))
  check('O5 a window AFTER the end is free immediately (headroom 1)', (await headroom(tracked, new Date(+checkoutAt + MIN), new Date(+checkoutAt + HOUR))) === 1)
  const booked = await reservedBooking(rOther, farFuture).catch(() => null)
  check('O6 …and the same far-future attach that was refused now succeeds', booked !== null)
  const tabStart = (await q<{ starts_at: Date }>(`select starts_at from booking_slots where booking_id=$1`, [tab.id])).rows[0].starts_at
  check('O7 a window that overlaps the session itself is still held (headroom 0)', (await headroom(tracked, new Date(+tabStart - MIN), new Date(+tabStart + 1000))) === 0)

  // ── reopen: unbounded again ───────────────────────────────────────────────
  await q(`update bookings set status='cancelled' where id=$1`, [booked?.id ?? null]) // free the far-future unit
  await withUser(userId, (tx) => reopenWalkinCore(tx, ctx, tab.id))
  const reopened = await addonRow(tab.id)
  check('R1 reopen: add-on ends_at back to NULL and line unpriced', reopened.ends_at === null && reopened.line_total === '0.00')
  check('R2 reopened tab blocks later windows again', (await headroom(tracked, farFuture, new Date(+farFuture + HOUR))) === 0)

  // ── late checkout (M32) + daily rate ──────────────────────────────────────
  // Walk back the open tab's start 50h (owner pool, same as a forgotten tab),
  // then check it out with an end 2h ago: 48h elapsed.
  const lens = await mkAddon('Lens', '500.00', 'day', 1)
  const rLate = await mkResource('Late 1')
  const late = await startWalkin(rLate, 'open_tab', lens)
  const longAgo = new Date(Date.now() - 50 * HOUR)
  await q(`update booking_slots set starts_at=$2 where booking_id=$1`, [late.id, longAgo])
  await q(`update booking_addons set starts_at=$2 where booking_id=$1`, [late.id, longAgo])
  // Derived from longAgo, not a second Date.now(): exactly 48h elapsed.
  const lateEnd = new Date(+longAgo + 48 * HOUR)
  await withUser(userId, (tx) => checkoutWalkinCore(tx, ctx, { bookingId: late.id, endAt: lateEnd.toISOString() }))
  const lateRow = await addonRow(late.id)
  check('L1 late checkout stamps the ENTERED end on the add-on (not "now")', lateRow.ends_at !== null && +lateRow.ends_at === +lateEnd && same(lateRow.ends_at, await slotEnd(late.id)))
  check('L2 daily add-on: 48h elapsed = 2 day-blocks → 1000.00', lateRow.line_total === '1000.00')
  check('L3 stock frees from the real end: a window after it is free', (await headroom(lens, new Date(+lateEnd + MIN), new Date(+lateEnd + HOUR))) === 1)
  const total = (await q<{ subtotal: string }>(`select subtotal from bookings where id=$1`, [late.id])).rows[0].subtotal
  const slotTotal = (await q<{ slot_total: string }>(`select slot_total from booking_slots where booking_id=$1`, [late.id])).rows[0].slot_total
  check('L4 booking subtotal = room + add-on', Number(total) === Number(slotTotal) + 1000)

  // 49h → 3 blocks, via a second late walk-in (ceil, not round)
  const rLate2 = await mkResource('Late 2')
  const lens2 = await mkAddon('Lens 2', '500.00', 'day', 1)
  const late2 = await startWalkin(rLate2, 'open_tab', lens2)
  await q(`update booking_slots set starts_at=$2 where booking_id=$1`, [late2.id, new Date(Date.now() - 51 * HOUR)])
  await q(`update booking_addons set starts_at=$2 where booking_id=$1`, [late2.id, new Date(Date.now() - 51 * HOUR)])
  await withUser(userId, (tx) => checkoutWalkinCore(tx, ctx, { bookingId: late2.id, endAt: new Date(Date.now() - 2 * HOUR).toISOString() }))
  check('L5 49h elapsed = 3 day-blocks (ceil) → 1500.00', (await addonRow(late2.id)).line_total === '1500.00')

  // ── cleanup ───────────────────────────────────────────────────────────────
  await q(`delete from tenants where id=$1`, [tenantId])
  await q(`delete from users where email=$1`, [`owner@${slug}.test`])
  await ownerPool.end()
  await appPool.end()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
