/**
 * M21 per-head #2 — the shared time-pricing engine's head_count multiplier.
 *
 * Two functions carry the money for a per_head resource type
 * (pricing_mode='per_head', 0094_per_head_pricing.sql): priceBookingSlots
 * (lib/booking/service.ts, reserved bookings) and priceElapsedTime
 * (lib/billing/elapsed-time.ts, walk-in open-tab/timed sessions). Both now
 * take head_count as a plain multiplier over rate × time — this pins:
 *
 *   - 3 players × ₹50/hr × 2h = ₹300, in both functions
 *   - a per_resource type's price is byte-identical to before this ticket
 *     (head_count defaults to 1 / plays no part)
 *   - min_players is enforced server-side, with a clear rejection message
 *   - head_count/pricing_mode are snapshotted onto booking_slots, frozen
 *     against a later config change (same discipline as rate_applied)
 *   - the snapshot actually reaches the bill: loadBookingLines
 *     (lib/billing/invoice.ts) reconstructs slot_total exactly via
 *     qty × unitPrice, not just priceBookingSlots' own return value
 *   - happy-hour and a membership discount compose on the per-head total to
 *     the paise, via the SAME priceBill/membershipDiscountAmount path every
 *     other bill already uses
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs scripts/test-per-head-pricing.ts
 */
import { Pool } from 'pg'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { sql } from 'drizzle-orm'
import * as schema from '../db/schema'
import { createBookingCore, priceBookingSlots, updateBookingHeadCountCore, BookingError } from '../lib/booking/service'
import { loadBookingLines } from '../lib/billing/invoice'
import { priceElapsedTime } from '../lib/billing/elapsed-time'
import { priceBill, round2 } from '../lib/billing/pricing'
import { membershipDiscountAmount } from '../lib/billing/membership-benefit'
import type { HappyHourRule } from '../lib/happy-hours/apply'
import { loadEnv } from './env'

type Db = NodePgDatabase<typeof schema>

let pass = 0,
  fail = 0
const check = (l: string, c: boolean) => {
  console.log(`${c ? '✓' : '✗ FAIL'}  ${l}`)
  if (c) pass++
  else fail++
}
async function expectReject(l: string, fn: () => Promise<unknown>, messageIncludes?: string) {
  try {
    await fn()
    check(l, false)
  } catch (e) {
    const ok = e instanceof BookingError && (!messageIncludes || e.message.includes(messageIncludes))
    check(l, ok)
    if (!ok) console.log('   (unexpected)', e)
  }
}

const TZ = 'Asia/Kolkata'
/** 2026-08-11 is a Tuesday in IST, no happy hours running unless a test adds one. */
const at = (hhmm: string) => new Date(`2026-08-11T${hhmm}:00+05:30`)

const rule = (overrides: Partial<HappyHourRule> = {}): HappyHourRule => ({
  id: 'hh1',
  name: 'Happy Hour',
  daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
  startTime: '17:00',
  endTime: '18:00',
  discountType: 'fixed',
  discountValue: 40, // ₹120 → ₹80
  isActive: true,
  ...overrides,
})

// ── 1. priceElapsedTime — pure, no DB ────────────────────────────────────────
function testElapsedTime() {
  // 3 players × ₹50/hr × 2h = ₹300 — the acceptance example, verbatim.
  {
    const r = priceElapsedTime(at('14:00'), at('16:00'), 50, [], TZ, 3)
    check('T1 3 players × ₹50/hr × 2h = ₹300', r.unitPrice === 300)
  }

  // Omitting head_count (every per_resource caller, every one that predates
  // this ticket) must be byte-identical to before.
  {
    const withDefault = priceElapsedTime(at('14:00'), at('16:00'), 100, [], TZ)
    const explicit1 = priceElapsedTime(at('14:00'), at('16:00'), 100, [], TZ, 1)
    check('T2 head_count omitted defaults to 1: unitPrice = 200 (2h @ ₹100/hr)', withDefault.unitPrice === 200)
    check('T2 …identical to passing head_count=1 explicitly', withDefault.unitPrice === explicit1.unitPrice)
  }

  // Composes with happy hour: the worked boundary-crossing example (₹135.33
  // at head_count=1, from test-elapsed-time-pricing.ts) × 3 players.
  //   17:38–18:00 (22min) @ HH ₹80  = 29.3333…
  //   18:00–18:53 (53min) @ full ₹120 = 106.0
  //   sum = 135.3333… × 3 players = 406.00 (a clean number — chosen so the
  //   multiplier's placement, before vs. after round2, cannot hide a bug)
  {
    const solo = priceElapsedTime(at('17:38'), at('18:49'), 120, [rule()], TZ, 1)
    const trio = priceElapsedTime(at('17:38'), at('18:49'), 120, [rule()], TZ, 3)
    check('T3 head_count=1 crossing a HH boundary: unitPrice = 135.33 (unchanged)', solo.unitPrice === 135.33)
    check('T3 the same session at head_count=3: unitPrice = 406.00', trio.unitPrice === 406)
  }

  // Composes with a membership discount, to the paise, via the same priceBill
  // path every other bill uses.
  {
    const line = { ...priceElapsedTime(at('17:38'), at('18:49'), 120, [rule()], TZ, 3), taxPercent: 18 }
    check('T4 pre-discount subtotal is the per-head total: 406.00', line.unitPrice === 406)
    const discount = membershipDiscountAmount(line.unitPrice, 10) // 10% member discount
    check('T4 10% membership discount on ₹406.00 = ₹40.60', discount === 40.6)
    const bill = priceBill({ lines: [line], discount })
    check('T4 …taxableValue = 365.40 after the discount', bill.taxableValue === 365.4)
    check('T4 …tax = 65.77 (18% of ₹365.40, rounded once)', bill.taxTotal === 65.77)
    check('T4 …total = 431.17', bill.total === 431.17)
    check(
      'T4 reconciles to the paise: subtotal − discount + taxTotal === total',
      round2(bill.subtotal - bill.discount + bill.taxTotal) === bill.total,
    )
  }
}

// ── 2. priceBookingSlots + loadBookingLines — against a real database ───────
async function testBookingSlots() {
  loadEnv()
  const ownerPool = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })
  const appPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 })
  const app = drizzle(appPool, { schema })

  async function withUser<T>(userId: string, fn: (tx: Db) => Promise<T>): Promise<T> {
    return app.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`)
      return fn(tx as unknown as Db)
    })
  }

  const slug = 'testperhead'
  const t = await ownerPool.query<{ id: string }>(
    `insert into tenants (slug,name,status,timezone,industry) values ($1,$2,'active',$3,'gaming_cafe')
     on conflict (slug) do update set name=excluded.name returning id`,
    [slug, `${slug} co`, TZ],
  )
  const tenantId = t.rows[0].id
  const b = await ownerPool.query<{ id: string }>(
    `insert into branches (tenant_id,name,is_primary) values ($1,'Main',true)
     on conflict (tenant_id,name) do update set is_primary=true returning id`,
    [tenantId],
  )
  const branchId = b.rows[0].id
  const u = await ownerPool.query<{ id: string }>(
    `insert into users (email,password_hash) values ($1,'x')
     on conflict (email) do update set email=excluded.email returning id`,
    [`owner@${slug}.test`],
  )
  const userId = u.rows[0].id
  const m = await ownerPool.query<{ id: string }>(
    `insert into memberships (tenant_id,user_id,role,status) values ($1,$2,'owner','active')
     on conflict (tenant_id,user_id) do update set role='owner', status='active' returning id`,
    [tenantId, userId],
  )
  const membershipId = m.rows[0].id

  // Snooker: per_head, min 2 players, ₹50/hr PER PLAYER.
  const snookerType = await ownerPool.query<{ id: string }>(
    `insert into resource_types (tenant_id,name,hourly_rate,pricing_mode,min_players) values ($1,'Snooker Table','50.00','per_head',2)
     on conflict (tenant_id,name) do update set hourly_rate=excluded.hourly_rate, pricing_mode=excluded.pricing_mode, min_players=excluded.min_players
     returning id`,
    [tenantId],
  )
  const snookerResource = await ownerPool.query<{ id: string }>(
    `insert into resources (tenant_id,branch_id,resource_type_id,name,status) values ($1,$2,$3,'Snooker 1','available')
     on conflict (tenant_id,name) do update set status='available' returning id`,
    [tenantId, branchId, snookerType.rows[0].id],
  )

  // PS5: per_resource (the default) — must stay exactly as it billed before this ticket.
  const ps5Type = await ownerPool.query<{ id: string }>(
    `insert into resource_types (tenant_id,name,hourly_rate) values ($1,'PS5 Station','100.00')
     on conflict (tenant_id,name) do update set hourly_rate=excluded.hourly_rate returning id`,
    [tenantId],
  )
  const ps5Resource = await ownerPool.query<{ id: string }>(
    `insert into resources (tenant_id,branch_id,resource_type_id,name,status) values ($1,$2,$3,'PS5 1','available')
     on conflict (tenant_id,name) do update set status='available' returning id`,
    [tenantId, branchId, ps5Type.rows[0].id],
  )

  const ctx = { tenantId, timezone: TZ, membershipId }
  const day = (h: number) => new Date(Date.UTC(2046, 2, 20, h, 0, 0)) // far future, collision-free

  // ── a. 3 players × ₹50/hr × 2h = ₹300, on the per_head type ───────────────
  let snookerBookingId = ''
  {
    const booking = await withUser(userId, (tx) =>
      createBookingCore(tx, ctx, {
        branchId,
        source: 'staff',
        discount: 0,
        deposit: 0,
        headCount: 3,
        slots: [{ resourceId: snookerResource.rows[0].id, startsAt: day(10).toISOString(), endsAt: day(12).toISOString() }],
      }),
    )
    snookerBookingId = booking.id
    const { rows } = await ownerPool.query(
      `select b.head_count as booking_head_count, b.subtotal, b.total,
              s.rate_applied, s.slot_total, s.head_count as slot_head_count, s.pricing_mode
       from bookings b join booking_slots s on s.booking_id = b.id where b.id = $1`,
      [booking.id],
    )
    const row = rows[0]
    check('T5 bookings.head_count = 3', row.booking_head_count === 3)
    check('T5 bookings.subtotal/total = 300.00', row.subtotal === '300.00' && row.total === '300.00')
    check('T5 booking_slots.rate_applied stays the PER-PLAYER rate: 50.00', row.rate_applied === '50.00')
    check('T5 booking_slots.slot_total = 300.00 (3 × ₹50 × 2h)', row.slot_total === '300.00')
    check('T5 booking_slots.head_count snapshot = 3', row.slot_head_count === 3)
    check("T5 booking_slots.pricing_mode snapshot = 'per_head'", row.pricing_mode === 'per_head')
  }

  // ── a2. editing the player count re-prices AND refreshes the stored total ──
  // (finding 1, PR #24 per-head review: loadBookingLines recomputes the invoice
  //  from head_count, but the denormalized bookings.subtotal/total shown to the
  //  customer — confirmation page, account pages, bookings list — must not go
  //  stale at the old count.)
  {
    // A DEDICATED booking (not the snapshot-freeze one T9/T10 rely on): start
    // at 3 players, edit to 5, and confirm the stored totals follow.
    const edited = await withUser(userId, (tx) =>
      createBookingCore(tx, ctx, {
        branchId,
        source: 'staff',
        discount: 0,
        deposit: 0,
        headCount: 3,
        slots: [{ resourceId: snookerResource.rows[0].id, startsAt: day(20).toISOString(), endsAt: day(22).toISOString() }],
      }),
    )
    await withUser(userId, (tx) =>
      updateBookingHeadCountCore(tx, { tenantId }, { bookingId: edited.id, headCount: 5 }),
    )
    const { rows } = await ownerPool.query(
      `select b.head_count as booking_head_count, b.subtotal, b.total,
              s.slot_total, s.head_count as slot_head_count
       from bookings b join booking_slots s on s.booking_id = b.id where b.id = $1`,
      [edited.id],
    )
    const row = rows[0]
    check('T5b edit to 5 players: bookings.head_count = 5', row.booking_head_count === 5)
    check(
      'T5b …bookings.subtotal/total refreshed to 500.00 (not left stale at 300)',
      row.subtotal === '500.00' && row.total === '500.00',
    )
    check('T5b …booking_slots.slot_total refreshed to 500.00', row.slot_total === '500.00')
    check('T5b …booking_slots.head_count snapshot = 5', row.slot_head_count === 5)

    const lines = await withUser(userId, (tx) => loadBookingLines(tx, tenantId, edited.id, TZ))
    const billed = round2(lines.reduce((s, l) => s + l.qty * l.unitPrice, 0))
    check('T5b …and the billed line reconciles to 500.00 (2h × 5 players × ₹50)', billed === 500)
  }

  // ── b. min_players enforced — 1 player on a 2-player-minimum type is rejected ─
  await expectReject(
    'T6 1 player on Snooker (min_players=2) is rejected server-side',
    () =>
      withUser(userId, (tx) =>
        createBookingCore(tx, ctx, {
          branchId,
          source: 'staff',
          discount: 0,
          deposit: 0,
          headCount: 1,
          slots: [{ resourceId: snookerResource.rows[0].id, startsAt: day(14).toISOString(), endsAt: day(15).toISOString() }],
        }),
      ),
    'needs at least 2 players',
  )

  // ── c. no head_count at all on a per_head type is rejected, not silently priced at 1 ─
  await expectReject(
    'T7 no head_count supplied on a per_head type is rejected (not defaulted to 1)',
    () =>
      withUser(userId, (tx) =>
        priceBookingSlots(tx, { tenantId, timezone: TZ }, { branchId, slots: [{ resourceId: snookerResource.rows[0].id, startsAt: day(14).toISOString(), endsAt: day(15).toISOString() }] }),
      ),
    'priced per player',
  )

  // ── d. per_resource type: byte-identical to before this ticket ────────────
  let ps5BookingId = ''
  {
    const booking = await withUser(userId, (tx) =>
      createBookingCore(tx, ctx, {
        branchId,
        source: 'staff',
        discount: 0,
        deposit: 0,
        // A head_count supplied anyway (e.g. a shared form) must be ignored,
        // not silently applied as a multiplier to a per_resource type.
        headCount: 4,
        slots: [{ resourceId: ps5Resource.rows[0].id, startsAt: day(10).toISOString(), endsAt: day(12).toISOString() }],
      }),
    )
    ps5BookingId = booking.id
    const { rows } = await ownerPool.query(
      `select b.head_count as booking_head_count, b.total, s.slot_total, s.head_count as slot_head_count, s.pricing_mode
       from bookings b join booking_slots s on s.booking_id = b.id where b.id = $1`,
      [booking.id],
    )
    const row = rows[0]
    check('T8 per_resource: total = 200.00 (₹100/hr × 2h — unaffected by head_count=4)', row.total === '200.00')
    check('T8 per_resource: slot_total = 200.00', row.slot_total === '200.00')
    check('T8 per_resource: booking_slots.head_count snapshot is null', row.slot_head_count === null)
    check("T8 per_resource: booking_slots.pricing_mode snapshot = 'per_resource'", row.pricing_mode === 'per_resource')
    // bookings.head_count itself still records what was asked for the booking
    // (it's a booking-level column, not slot-level) — only the SLOT declines
    // to bill by it for a per_resource resource.
    check('T8 bookings.head_count is still recorded at the booking level: 4', row.booking_head_count === 4)
  }

  // ── e. snapshots are frozen: a later config change can't move a raised bill ─
  {
    await ownerPool.query(`update resource_types set hourly_rate = '999.00', min_players = 5 where id = $1`, [snookerType.rows[0].id])
    const { rows } = await ownerPool.query(
      `select rate_applied, slot_total, head_count from booking_slots where booking_id = $1`,
      [snookerBookingId],
    )
    check('T9 rate_applied is frozen at 50.00 after the type\'s rate changes to 999.00', rows[0].rate_applied === '50.00')
    check('T9 slot_total stays 300.00 — the raised bill does not move', rows[0].slot_total === '300.00')
    check('T9 head_count snapshot stays 3 even though min_players later rose to 5', rows[0].head_count === 3)
  }

  // ── f. the snapshot actually reaches the bill (loadBookingLines) ──────────
  {
    const lines = await withUser(userId, (tx) => loadBookingLines(tx, tenantId, snookerBookingId, TZ))
    check('T10 loadBookingLines returns exactly one line for the per_head booking', lines.length === 1)
    const [line] = lines
    check('T10 …qty × unitPrice reconstructs slot_total: qty=6 (3 players × 2h), unitPrice=50', line.qty === 6 && line.unitPrice === 50)
    const priced = priceBill({ lines: [line] })
    check('T10 …prices to exactly 300.00 through priceBill (matches slot_total, not rate × hours alone)', priced.subtotal === 300)
  }
  {
    const lines = await withUser(userId, (tx) => loadBookingLines(tx, tenantId, ps5BookingId, TZ))
    const [line] = lines
    check('T11 per_resource booking: qty=2 (hours), unitPrice=100 — the pre-existing decomposition, untouched', line.qty === 2 && line.unitPrice === 100)
  }

  // ── cleanup ───────────────────────────────────────────────────────────────
  await ownerPool.query('delete from tenants where id = $1', [tenantId])
  await ownerPool.query(`delete from users where email = $1`, [`owner@${slug}.test`])
  await ownerPool.end()
  await appPool.end()
}

async function main() {
  testElapsedTime()
  await testBookingSlots()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
