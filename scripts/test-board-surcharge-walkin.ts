/**
 * M29 #6 — the walk-in path (lib/booking/walkin.ts): startWalkinCore snapshots
 * the day-resolved extra-player rate, and previewWalkinCheckout /
 * checkoutWalkinCore price the COMBINED rate (base + max(0, players − included)
 * × extra) through the elapsed-time engine, composing with weekend, happy-hour
 * and holiday pricing exactly as priceBookingSlots does for a reserved booking.
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs scripts/test-board-surcharge-walkin.ts
 *
 * A walk-in must start within 30 minutes of now, so "today" is the date under
 * test; weekend/weekday is steered via business_profiles.weekend_days. Sessions
 * are backdated 10 minutes so they bill the 30-minute minimum (0.5h).
 *
 * Covers: default player count = included (no surcharge), a higher count at
 * checkout re-prices and persists, weekend rates, happy hour discounting the
 * combined rate, a holiday (flat, undiscounted), fewer players than included,
 * bad counts refused, per_head and plain walk-ins unchanged, a per_head type
 * with the surcharge columns set is not double-priced, and the bill reconciles.
 */
import { Pool } from 'pg'
import { loadEnv } from './env'

let pass = 0,
  fail = 0
const check = (l: string, c: boolean, got?: unknown) => {
  console.log(`${c ? '✓' : '✗ FAIL'}  ${l}${c ? '' : `  (got: ${JSON.stringify(got)})`}`)
  if (c) pass++
  else fail++
}

const TZ = 'Asia/Kolkata'

async function main() {
  loadEnv()
  const { startWalkinCore, previewWalkinCheckout, checkoutWalkinCore } = await import('../lib/booking/walkin')
  const { loadBookingLines } = await import('../lib/billing/invoice')
  const { priceBill, round2 } = await import('../lib/billing/pricing')
  const { todayInZone, weekdayInZone } = await import('../lib/booking/time')
  const { withUser } = await import('../db')

  const owner = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })
  const slug = 'testboardsurchargewalkin'
  await owner.query(`delete from tenants where slug = $1`, [slug])
  const tenantId = (
    await owner.query<{ id: string }>(
      `insert into tenants (slug,name,status,timezone,industry) values ($1,$2,'active',$3,'gaming_cafe') returning id`,
      [slug, `${slug} co`, TZ],
    )
  ).rows[0].id
  const branchId = (
    await owner.query<{ id: string }>(`insert into branches (tenant_id,name,is_primary) values ($1,'Main',true) returning id`, [tenantId])
  ).rows[0].id
  const email = `owner@${slug}.test`
  await owner.query(`delete from users where email = $1`, [email])
  const userId = (await owner.query<{ id: string }>(`insert into users (email,password_hash) values ($1,'x') returning id`, [email])).rows[0].id
  const membershipId = (
    await owner.query<{ id: string }>(
      `insert into memberships (tenant_id,user_id,role,status) values ($1,$2,'owner','active') returning id`,
      [tenantId, userId],
    )
  ).rows[0].id
  const ctx = { tenantId, timezone: TZ, membershipId }

  const today = todayInZone(TZ)
  const dow = weekdayInZone(today, TZ)
  const setWeekend = (days: number[]) =>
    owner.query(
      `insert into business_profiles (tenant_id, weekend_days) values ($1, $2::smallint[])
       on conflict (tenant_id) do update set weekend_days = excluded.weekend_days`,
      [tenantId, `{${days.join(',')}}`],
    )
  const WEEKDAY_MODE = [(dow + 1) % 7] // today is NOT a weekend day
  const WEEKEND_MODE = [dow] // today IS a weekend day

  async function makeType(name: string, cols: string, vals: unknown[]) {
    return (
      await owner.query<{ id: string }>(
        `insert into resource_types (tenant_id,name,${cols}) values ($1,$2,${vals.map((_, i) => `$${i + 3}`).join(',')}) returning id`,
        [tenantId, name, ...vals],
      )
    ).rows[0].id
  }
  let unitN = 0
  async function unit(typeId: string) {
    return (
      await owner.query<{ id: string }>(
        `insert into resources (tenant_id,branch_id,resource_type_id,name,status) values ($1,$2,$3,$4,'available') returning id`,
        [tenantId, branchId, typeId, `Unit-${++unitN}`],
      )
    ).rows[0].id
  }

  // Board: weekday 300, weekend 400, 2 included, extra 50 weekday / 80 weekend.
  const boardType = await makeType(
    'Board',
    'hourly_rate,weekend_rate,included_players,extra_player_rate,extra_player_weekend_rate',
    ['300.00', '400.00', 2, '50.00', '80.00'],
  )
  const plainType = await makeType('Plain', 'hourly_rate', ['200.00'])
  const headType = await makeType('Snooker', 'hourly_rate,pricing_mode,min_players', ['50.00', 'per_head', 2])
  const headSurchargeType = await makeType(
    'Head+cols',
    'hourly_rate,pricing_mode,min_players,included_players,extra_player_rate',
    ['50.00', 'per_head', 2, 1, '20.00'],
  )

  let phone = 9876500400
  async function start(resourceId: string, headCount?: number) {
    const b = await withUser(userId, (tx) =>
      startWalkinCore(tx, ctx, {
        branchId,
        resourceId,
        phone: String(phone++),
        startAt: new Date().toISOString(),
        mode: 'open_tab',
        headCount,
      }),
    )
    // Backdate 10 minutes → bills the 30-minute minimum (0.5h).
    await owner.query(`update booking_slots set starts_at = now() - interval '10 minutes' where booking_id = $1`, [b.id])
    return b.id
  }
  const preview = (bookingId: string, headCount?: number) =>
    withUser(userId, (tx) => previewWalkinCheckout(tx, ctx, { bookingId, headCount }))
  const checkout = (bookingId: string, headCount?: number) =>
    withUser(userId, (tx) => checkoutWalkinCore(tx, ctx, { bookingId, headCount }))
  async function slot(bookingId: string) {
    const { rows } = await owner.query(
      `select s.rate_applied, s.slot_total, s.head_count, s.extra_player_rate_applied as extra, s.holiday_rate_applied as hol,
              b.head_count as b_head
         from booking_slots s join bookings b on b.id = s.booking_id where s.booking_id = $1`,
      [bookingId],
    )
    return rows[0]
  }
  async function refused(fn: () => Promise<unknown>) {
    try {
      await fn()
      return null
    } catch (e) {
      return (e as Error).message
    }
  }

  // ══ 1. weekday: default count, then a higher count at checkout ═══════════
  console.log('\n── weekday walk-in ──')
  await setWeekend(WEEKDAY_MODE)
  {
    const id = await start(await unit(boardType))
    let s = await slot(id)
    check('start: no player count sent → defaults to the included players (2)', s.head_count === 2 && s.b_head === 2, s)
    check('start: base rate 300.00 and extra-rate snapshot 50.00', s.rate_applied === '300.00' && s.extra === '50.00', s)
    check('preview at the default count: 0.5h × 300 = 150.00', (await preview(id)).total === 150)
    const p4 = await preview(id, 4)
    check('preview at 4 players: 0.5h × (300 + 2×50) = 200.00', p4.total === 200, p4)
    const closed = await checkout(id, 4)
    check('checkout at 4 players = 200.00, matching the preview', closed.total === 200, closed)
    s = await slot(id)
    check('slot_total 200.00; head_count 4 persisted on slot and booking', s.slot_total === '200.00' && s.head_count === 4 && s.b_head === 4, s)
    const lines = await withUser(userId, (tx) => loadBookingLines(tx, tenantId, id, TZ))
    const bill = priceBill({ lines, discount: 15 })
    check('bill: one line of 200.00, reconciles to the paise', lines.length === 1 && bill.subtotal === 200 && round2(bill.subtotal - bill.discount + bill.taxTotal) === bill.total, bill)
  }
  {
    const id = await start(await unit(boardType), 1)
    const closed = await checkout(id)
    check('1 player (below the 2 included): no surcharge, 150.00', closed.total === 150, closed)
    const id2 = await start(await unit(boardType), 6)
    check('started at 6 players: default checkout keeps 6 → 0.5h × (300 + 4×50) = 250.00', (await checkout(id2)).total === 250)
  }

  // ══ 2. weekend ═══════════════════════════════════════════════════════════
  console.log('\n── weekend walk-in ──')
  await setWeekend(WEEKEND_MODE)
  {
    const id = await start(await unit(boardType), 5)
    const s = await slot(id)
    check('start: weekend base 400.00, weekend extra rate snapshot 80.00', s.rate_applied === '400.00' && s.extra === '80.00', s)
    check('checkout: 0.5h × (400 + 3×80) = 320.00', (await checkout(id)).total === 320)
  }

  // ══ 3. happy hour discounts the combined rate ════════════════════════════
  console.log('\n── happy hour ──')
  await setWeekend(WEEKDAY_MODE)
  await owner.query(
    `insert into happy_hours (tenant_id,name,days_of_week,start_time,end_time,discount_type,discount_value,is_active)
     values ($1,'All-day 50% off','{0,1,2,3,4,5,6}','00:00','23:59','percentage',50,true)`,
    [tenantId],
  )
  {
    const id = await start(await unit(boardType), 4)
    check('weekday, 4 players: 0.5h × (300 + 100) × 50% = 100.00 (combined rate discounted)', (await checkout(id)).total === 100)
    const plainId = await start(await unit(plainType))
    check('control: a plain walk-in is discounted too (0.5h × 200 × 50% = 50.00)', (await checkout(plainId)).total === 50)
  }

  // ══ 4. holiday: flat base + surcharge, undiscounted ══════════════════════
  console.log('\n── holiday ──')
  await owner.query(`insert into holiday_rates (tenant_id,resource_type_id,date,rate) values ($1,$2,$3,'500.00')`, [tenantId, boardType, today])
  {
    const id = await start(await unit(boardType), 4)
    const s = await slot(id)
    check('start: holiday base 500.00 snapshotted, holiday flag true, extra 50.00', s.rate_applied === '500.00' && s.hol === true && s.extra === '50.00', s)
    const closed = await checkout(id)
    check('checkout: 0.5h × (500 + 2×50) = 300.00 — the wide-open happy hour does NOT touch it', closed.total === 300, closed)
  }
  await owner.query(`delete from holiday_rates where tenant_id = $1`, [tenantId])

  // ══ 5. bad counts ════════════════════════════════════════════════════════
  console.log('\n── validation ──')
  {
    const id = await start(await unit(boardType), 3)
    for (const bad of [0, -1, 2.5]) {
      const msg = await refused(() => checkout(id, bad))
      check(`checkout with ${bad} players is refused`, /whole number of players/i.test(msg ?? ''), msg)
    }
    check('…and nothing was written', (await slot(id)).slot_total === '0.00')
    const badStart = await refused(async () => {
      await withUser(userId, (tx) =>
        startWalkinCore(tx, ctx, {
          branchId,
          resourceId: '00000000-0000-0000-0000-000000000000',
          phone: '9876599999',
          startAt: new Date().toISOString(),
          mode: 'open_tab',
        }),
      )
    })
    check('unknown station still refused', /Station not found/.test(badStart ?? ''), badStart)
    const unitId = await unit(boardType)
    const msg = await refused(() =>
      withUser(userId, (tx) =>
        startWalkinCore(tx, ctx, {
          branchId,
          resourceId: unitId,
          phone: String(phone++),
          startAt: new Date().toISOString(),
          mode: 'open_tab',
          headCount: 0,
        }),
      ),
    )
    check('start with 0 players on a surcharge board is refused', /priced per player/i.test(msg ?? ''), msg)
  }

  // ══ 5b. included_players is frozen at start (M29 #8) ═════════════════════
  console.log('\n── included_players snapshot ──')
  await owner.query(`update happy_hours set is_active = false where tenant_id = $1`, [tenantId])
  {
    const typeId = await makeType('Board freeze', 'hourly_rate,included_players,extra_player_rate', ['300.00', 2, '50.00'])
    const id = await start(await unit(typeId), 3)
    const snap = (await owner.query(`select included_players_applied as inc from booking_slots where booking_id=$1`, [id])).rows[0]
    check('start: included_players_applied = 2 snapshotted', snap.inc === 2, snap)
    check('baseline: 3 players, 2 included → 0.5h × (300 + 50) = 175.00', (await preview(id)).total === 175)

    await owner.query(`update resource_types set included_players = 4 where id = $1`, [typeId])
    check('owner RAISES included to 4 mid-session: preview still bills the start-time surcharge (175.00)', (await preview(id)).total === 175)
    await owner.query(`update resource_types set included_players = 1 where id = $1`, [typeId])
    check('owner LOWERS included to 1 mid-session: still 175.00 (no over-charge)', (await preview(id)).total === 175)
    const closed = await checkout(id)
    check('checkout bills 175.00 too', closed.total === 175, closed)

    // Legacy row (started before 0106): no snapshot → falls back to the live value.
    await owner.query(`update resource_types set included_players = 2 where id = $1`, [typeId])
    const legacy = await start(await unit(typeId), 3)
    await owner.query(`update booking_slots set included_players_applied = null where booking_id = $1`, [legacy])
    await owner.query(`update resource_types set included_players = 4 where id = $1`, [typeId])
    check('legacy slot (null snapshot) falls back to live included (4) → no surcharge, 150.00', (await checkout(legacy)).total === 150)

    // Legacy checkout freezes the threshold it priced with, so a LATER edit to
    // included_players can't hide the extra-player breakdown on the bill.
    await owner.query(`update resource_types set included_players = 2 where id = $1`, [typeId])
    const legacy2 = await start(await unit(typeId), 3)
    await owner.query(`update booking_slots set included_players_applied = null where booking_id = $1`, [legacy2])
    check('legacy checkout at included 2 → 175.00', (await checkout(legacy2)).total === 175)
    const frozen = (await owner.query(`select included_players_applied as inc from booking_slots where booking_id=$1`, [legacy2])).rows[0]
    check('legacy checkout persists the resolved included count (2)', frozen.inc === 2, frozen)
    await owner.query(`update resource_types set included_players = 4 where id = $1`, [typeId])
    const after = (await owner.query(`select included_players_applied as inc from booking_slots where booking_id=$1`, [legacy2])).rows[0]
    check('raising included to 4 afterwards leaves the frozen count at 2 (breakdown still shows 1 extra)', after.inc === 2, after)
  }

  // ══ 6. regressions ═══════════════════════════════════════════════════════
  console.log('\n── unchanged walk-ins ──')
  {
    const plain = await start(await unit(plainType))
    const s = await slot(plain)
    check('plain walk-in: no head_count, no extra rate', s.head_count === null && s.extra === null, s)
    const hh = await owner.query(`update happy_hours set is_active = false where tenant_id = $1`, [tenantId])
    void hh
    check('plain walk-in: 0.5h × 200 = 100.00', (await checkout(plain)).total === 100)

    const head = await start(await unit(headType), 3)
    const hs = await slot(head)
    check('per_head walk-in: head_count 3, no extra rate', hs.head_count === 3 && hs.extra === null, hs)
    check('per_head walk-in: 0.5h × 50 × 3 = 75.00', (await checkout(head)).total === 75)

    const trap = await start(await unit(headSurchargeType), 3)
    const ts = await slot(trap)
    check('per_head with surcharge columns set: extra rate snapshot stays null', ts.extra === null && ts.head_count === 3, ts)
    check('…and is NOT double-priced: 0.5h × 50 × 3 = 75.00', (await checkout(trap)).total === 75)
  }

  await owner.query(`delete from tenants where id = $1`, [tenantId])
  await owner.query(`delete from users where id = $1`, [userId])
  await owner.end()

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
