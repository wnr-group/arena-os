/**
 * M22 #2 — weekday/weekend base-rate resolution in the shared pricing engine
 * (lib/booking/rate.ts:resolveDayRate), wired into priceBookingSlots
 * (lib/booking/service.ts, reserved) and startWalkinCore (lib/booking/walkin.ts,
 * walk-in). Pins:
 *
 *   - a weekday booking bills resourceTypes.hourlyRate (or the resource's own
 *     hourlyRateOverride); a weekend booking (start day in
 *     business_profiles.weekend_days) bills resourceTypes.weekendRate instead
 *   - weekendRate = null -> weekend prices identically to weekday (byte-identical
 *     to before this ticket)
 *   - a per-station override sets the WEEKDAY rate only — weekend ignores it
 *     and uses the type's own weekendRate for every station of that type
 *   - the whole session bills by its START day (a Fri 23:00->Sat 01:00 session
 *     bills Friday's rate throughout, never split mid-session)
 *   - business_profiles.weekend_days is tenant-configurable, not hardcoded
 *     Sat+Sun
 *   - per-head multiplies the resolved day rate by players
 *   - a walk-in resolves the same way, snapshotted onto rate_applied at
 *     START (checkout/extend read the snapshot back, never re-resolve it) and
 *     composes with happy-hour segment pricing on top through priceElapsedTime
 *   - the resolved rate freezes onto booking_slots.rate_applied — a later
 *     resource-type rate change can't reprice a booking already taken
 *
 * M22 #4 — the same resolution surfaces through the PUBLIC booking read path
 * (lib/booking/public-availability.ts's getPublicAvailableStarts/
 * getPublicAvailableStartsForType) so the online wizard's live estimate/
 * deposit quote the correct date-specific rate — never trusted at write
 * time regardless (createPublicBooking re-prices via createBookingCore ->
 * priceBookingSlots, the same engine #2 already pins above).
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs scripts/test-weekend-pricing.ts
 */
import { Pool } from 'pg'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { sql } from 'drizzle-orm'
import * as schema from '../db/schema'
import { createBookingCore, priceBookingSlots } from '../lib/booking/service'
import { loadBookingLines } from '../lib/billing/invoice'
import { priceBill, round2 } from '../lib/billing/pricing'
import { isWeekendDay, resolveDayRate } from '../lib/booking/rate'
import { loadEnv } from './env'
// lib/booking/walkin.ts statically imports @/db (for a `withUser` it never
// actually gets called from here — this test uses its own local `withUser`
// below) — @/db's pools are created from process.env.DATABASE_URL(_OWNER) at
// MODULE-EVALUATION time, so importing walkin.ts at this file's own top
// level would poison that singleton with undefined connection strings
// before loadEnv() (called inside testReservedBookings, below) ever runs.
// Deferred to a dynamic import in testWalkins() instead, after loadEnv() has
// already run via testReservedBookings() earlier in main() — same reasoning
// test-public-availability-grid.ts's own dynamic import documents.

type Db = NodePgDatabase<typeof schema>

let pass = 0,
  fail = 0
const check = (l: string, c: boolean) => {
  console.log(`${c ? '✓' : '✗ FAIL'}  ${l}`)
  if (c) pass++
  else fail++
}

const TZ = 'Asia/Kolkata'
// Confirmed fixed calendar: 2046-03-16 Fri, -17 Sat, -18 Sun, -19 Mon, -20 Tue.
// Far enough out to never collide with another suite's bookings.
const fri = (hhmm: string) => new Date(`2046-03-16T${hhmm}:00+05:30`)
const sat = (hhmm: string) => new Date(`2046-03-17T${hhmm}:00+05:30`)
const sun = (hhmm: string) => new Date(`2046-03-18T${hhmm}:00+05:30`)
const tue = (hhmm: string) => new Date(`2046-03-20T${hhmm}:00+05:30`)

// ── 1. resolveDayRate / isWeekendDay — pure, no DB ───────────────────────────
function testPureResolver() {
  check('T1 Saturday is a weekend day under the default {0,6} set', isWeekendDay(sat('12:00'), TZ, [0, 6]))
  check('T1 Sunday is a weekend day under the default {0,6} set', isWeekendDay(sun('12:00'), TZ, [0, 6]))
  check('T1 Tuesday is NOT a weekend day under the default {0,6} set', !isWeekendDay(tue('12:00'), TZ, [0, 6]))
  check(
    'T1 weekend_days is tenant-configurable: Friday counts as weekend under a {5} set',
    isWeekendDay(fri('12:00'), TZ, [5]),
  )
  check(
    'T1 …and Saturday does NOT under that same {5} set',
    !isWeekendDay(sat('12:00'), TZ, [5]),
  )

  check('T2 weekday: resolveDayRate returns the weekday rate', resolveDayRate(100, 150, tue('12:00'), TZ, [0, 6]) === 100)
  check('T2 weekend: resolveDayRate returns the weekend rate', resolveDayRate(100, 150, sat('12:00'), TZ, [0, 6]) === 150)
  check(
    'T2 weekendRate = null -> weekend resolves to the weekday rate (opt-in, byte-identical to today)',
    resolveDayRate(100, null, sat('12:00'), TZ, [0, 6]) === 100,
  )
}

// ── 2. priceBookingSlots / createBookingCore — reserved bookings, real DB ────
async function testReservedBookings() {
  loadEnv()
  // Dynamic, AFTER loadEnv(): public-availability.ts pulls in @/db, whose
  // pool reads process.env.DATABASE_URL at module-load time — a static
  // top-level import here would evaluate that before loadEnv() ran and
  // connect to nothing (ECONNREFUSED 127.0.0.1:5432), same reasoning
  // test-public-availability-grid.ts's own dynamic import already documents.
  const { getPublicAvailableStarts, getPublicAvailableStartsForType } = await import('../lib/booking/public-availability')
  const ownerPool = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })
  const appPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 })
  const app = drizzle(appPool, { schema })

  async function withUser<T>(userId: string, fn: (tx: Db) => Promise<T>): Promise<T> {
    return app.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`)
      return fn(tx as unknown as Db)
    })
  }

  const slug = 'testweekendpricing'
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

  // Idempotent against a previous run that died mid-way (e.g. a dropped DB
  // connection) before reaching its own cleanup at the bottom — the
  // tenant/resources upsert cleanly by (tenant_id,name), but a stale booking
  // at the SAME fixed test date would otherwise collide with this run's via
  // the exclusion constraint.
  await ownerPool.query(`delete from booking_slots where tenant_id = $1`, [tenantId])
  await ownerPool.query(`delete from bookings where tenant_id = $1`, [tenantId])

  // No business_profiles row yet — loadWeekendDays must fall back to the
  // column's own default {0,6}, same as a tenant that has never opened Settings.
  await ownerPool.query(`delete from business_profiles where tenant_id = $1`, [tenantId])

  // PS5: weekday ₹100/hr, weekend ₹150/hr.
  const ps5Type = await ownerPool.query<{ id: string }>(
    `insert into resource_types (tenant_id,name,hourly_rate,weekend_rate) values ($1,'PS5 Weekend','100.00','150.00')
     on conflict (tenant_id,name) do update set hourly_rate=excluded.hourly_rate, weekend_rate=excluded.weekend_rate
     returning id`,
    [tenantId],
  )
  const ps5A = await ownerPool.query<{ id: string }>(
    `insert into resources (tenant_id,branch_id,resource_type_id,name,status) values ($1,$2,$3,'PS5-A','available')
     on conflict (tenant_id,name) do update set status='available' returning id`,
    [tenantId, branchId, ps5Type.rows[0].id],
  )
  // Per-station override — weekday only. On a weekend this station must use
  // the TYPE's weekend_rate, not its own override.
  const ps5B = await ownerPool.query<{ id: string }>(
    `insert into resources (tenant_id,branch_id,resource_type_id,name,status,hourly_rate_override) values ($1,$2,$3,'PS5-B','available','70.00')
     on conflict (tenant_id,name) do update set status='available', hourly_rate_override='70.00' returning id`,
    [tenantId, branchId, ps5Type.rows[0].id],
  )

  // Pool table: no weekend_rate configured — opt-in, must price identically
  // on a weekend as on a weekday.
  const poolType = await ownerPool.query<{ id: string }>(
    `insert into resource_types (tenant_id,name,hourly_rate,weekend_rate) values ($1,'Pool No-Weekend','120.00',null)
     on conflict (tenant_id,name) do update set hourly_rate=excluded.hourly_rate, weekend_rate=null returning id`,
    [tenantId],
  )
  const poolA = await ownerPool.query<{ id: string }>(
    `insert into resources (tenant_id,branch_id,resource_type_id,name,status) values ($1,$2,$3,'Pool-A','available')
     on conflict (tenant_id,name) do update set status='available' returning id`,
    [tenantId, branchId, poolType.rows[0].id],
  )

  // Snooker: per_head, min 2 players — weekday ₹50/hr/player, weekend ₹80/hr/player.
  const snookerType = await ownerPool.query<{ id: string }>(
    `insert into resource_types (tenant_id,name,hourly_rate,weekend_rate,pricing_mode,min_players)
     values ($1,'Snooker Weekend','50.00','80.00','per_head',2)
     on conflict (tenant_id,name) do update set hourly_rate=excluded.hourly_rate, weekend_rate=excluded.weekend_rate,
       pricing_mode=excluded.pricing_mode, min_players=excluded.min_players returning id`,
    [tenantId],
  )
  const snookerA = await ownerPool.query<{ id: string }>(
    `insert into resources (tenant_id,branch_id,resource_type_id,name,status) values ($1,$2,$3,'Snooker-A','available')
     on conflict (tenant_id,name) do update set status='available' returning id`,
    [tenantId, branchId, snookerType.rows[0].id],
  )

  const ctx = { tenantId, timezone: TZ, membershipId }

  async function bookAndLoad(resourceId: string, startsAt: Date, endsAt: Date, headCount?: number) {
    const booking = await withUser(userId, (tx) =>
      createBookingCore(tx, ctx, {
        branchId,
        source: 'staff',
        discount: 0,
        deposit: 0,
        headCount,
        slots: [{ resourceId, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() }],
      }),
    )
    const { rows } = await ownerPool.query(
      `select rate_applied, slot_total from booking_slots where booking_id = $1`,
      [booking.id],
    )
    return { bookingId: booking.id, rateApplied: rows[0].rate_applied, slotTotal: rows[0].slot_total }
  }

  // ── a. weekday booking bills the weekday rate ────────────────────────────
  {
    const r = await bookAndLoad(ps5A.rows[0].id, tue('10:00'), tue('12:00'))
    check('T3 Tuesday (weekday) booking on PS5-A: rate_applied = 100.00', r.rateApplied === '100.00')
    check('T3 …slot_total = 200.00 (2h × ₹100)', r.slotTotal === '200.00')
  }

  // ── b. weekend booking (default weekend_days = {0,6}) bills the weekend rate ─
  {
    const rSat = await bookAndLoad(ps5A.rows[0].id, sat('10:00'), sat('12:00'))
    check('T4 Saturday booking on PS5-A: rate_applied = 150.00 (the weekend rate)', rSat.rateApplied === '150.00')
    check('T4 …slot_total = 300.00 (2h × ₹150)', rSat.slotTotal === '300.00')

    const rSun = await bookAndLoad(ps5A.rows[0].id, sun('10:00'), sun('12:00'))
    check('T4 Sunday booking on PS5-A also bills the weekend rate: 150.00', rSun.rateApplied === '150.00')
  }

  // ── c. weekend_rate = null -> weekend prices identically to weekday ──────
  {
    const rWeekday = await bookAndLoad(poolA.rows[0].id, tue('14:00'), tue('16:00'))
    const rWeekend = await bookAndLoad(poolA.rows[0].id, sat('14:00'), sat('16:00'))
    check('T5 Pool (no weekend_rate): weekday rate_applied = 120.00', rWeekday.rateApplied === '120.00')
    check(
      'T5 …weekend rate_applied is IDENTICAL (120.00) — opt-in, byte-identical to before this ticket',
      rWeekend.rateApplied === '120.00',
    )
  }

  // ── d. per-station override is weekday-only; weekend uses the TYPE's rate ─
  {
    const rWeekday = await bookAndLoad(ps5B.rows[0].id, tue('10:00'), tue('12:00'))
    check('T6 PS5-B (₹70 weekday override) on a weekday: rate_applied = 70.00', rWeekday.rateApplied === '70.00')

    const rWeekend = await bookAndLoad(ps5B.rows[0].id, sat('14:00'), sat('16:00'))
    check(
      "T6 …on a weekend, the override is IGNORED — rate_applied = 150.00 (the type's weekend_rate)",
      rWeekend.rateApplied === '150.00',
    )
  }

  // ── e. the whole session bills by its START day ──────────────────────────
  {
    const r = await bookAndLoad(ps5A.rows[0].id, fri('23:00'), sat('01:00'))
    check(
      'T7 a Fri 23:00 -> Sat 01:00 session bills the FRIDAY (weekday) rate throughout: rate_applied = 100.00',
      r.rateApplied === '100.00',
    )
    check('T7 …slot_total = 200.00 (2h × ₹100, not split at midnight)', r.slotTotal === '200.00')
  }

  // ── f. per-head multiplies the resolved day rate by players ──────────────
  let snookerBookingIdForT8 = ''
  {
    const r = await bookAndLoad(snookerA.rows[0].id, sat('10:00'), sat('12:00'), 3)
    check('T8 Snooker on a weekend: rate_applied stays the PER-PLAYER weekend rate: 80.00', r.rateApplied === '80.00')
    check('T8 …slot_total = 480.00 (3 players × ₹80 × 2h)', r.slotTotal === '480.00')
    snookerBookingIdForT8 = r.bookingId
  }

  // ── g. business_profiles.weekend_days is tenant-configurable ─────────────
  {
    await ownerPool.query(
      `insert into business_profiles (tenant_id, weekend_days) values ($1, '{5}')
       on conflict (tenant_id) do update set weekend_days = excluded.weekend_days`,
      [tenantId],
    )
    const rFri = await bookAndLoad(ps5A.rows[0].id, fri('10:00'), fri('12:00'))
    check(
      'T9 with weekend_days={5} (Friday only): a Friday booking now bills the WEEKEND rate: 150.00',
      rFri.rateApplied === '150.00',
    )
    const rSat = await bookAndLoad(ps5A.rows[0].id, sat('16:00'), sat('18:00'))
    check(
      'T9 …and Saturday now bills the WEEKDAY rate: 100.00 (no longer in the configured set)',
      rSat.rateApplied === '100.00',
    )
    // Restore the default for the remaining tests.
    await ownerPool.query(`update business_profiles set weekend_days = '{0,6}' where tenant_id = $1`, [tenantId])
  }

  // ── h. M22 #4: the public availability read path quotes the same
  // date-specific rate the wizard's live estimate/deposit should show —
  // must run BEFORE the next block mutates the type's rates.
  {
    const WD_TUE = '2046-03-20'
    const WD_FRI = '2046-03-16'
    const WD_SAT = '2046-03-17'

    async function rateFor(resourceId: string, date: string) {
      const r = await getPublicAvailableStarts({
        tenantId,
        branchId,
        resourceId,
        timeZone: TZ,
        date,
        durationMinutes: 60,
      })
      if ('error' in r) throw new Error(r.error)
      return r.rate
    }
    async function typeRateFor(resourceTypeId: string, date: string) {
      const r = await getPublicAvailableStartsForType({
        tenantId,
        branchId,
        resourceTypeId,
        timeZone: TZ,
        date,
        durationMinutes: 60,
      })
      if ('error' in r) throw new Error(r.error)
      return r.rate
    }

    check(
      'T16 public single-resource quote on a weekday: PS5-A = 100.00',
      (await rateFor(ps5A.rows[0].id, WD_TUE)) === '100.00',
    )
    check(
      'T16 …on a weekend: PS5-A = 150.00 (the weekend rate)',
      (await rateFor(ps5A.rows[0].id, WD_SAT)) === '150.00',
    )
    check(
      "T16 …PS5-B's weekday override applies on a weekday: 70.00",
      (await rateFor(ps5B.rows[0].id, WD_TUE)) === '70.00',
    )
    check(
      "T16 …but is IGNORED on a weekend — PS5-B quotes the type's weekend rate: 150.00",
      (await rateFor(ps5B.rows[0].id, WD_SAT)) === '150.00',
    )
    check(
      'T16 …a type with no weekend_rate quotes the same price every day: Pool-A = 120.00 on Fri',
      (await rateFor(poolA.rows[0].id, WD_FRI)) === '120.00',
    )
    check(
      'T16 …Pool-A on a weekend too: 120.00 (opt-in, unaffected)',
      (await rateFor(poolA.rows[0].id, WD_SAT)) === '120.00',
    )
    check(
      'T16 public type-level quote (auto-assigned unit) on a weekday: PS5 Weekend type = 100.00',
      (await typeRateFor(ps5Type.rows[0].id, WD_TUE)) === '100.00',
    )
    check(
      'T16 …on a weekend: 150.00',
      (await typeRateFor(ps5Type.rows[0].id, WD_SAT)) === '150.00',
    )
  }

  // ── i. priceBookingSlots resolves the same way called directly (not just
  // through createBookingCore) — must run BEFORE the next block mutates the
  // type's rates.
  {
    const priced = await withUser(userId, (tx) =>
      priceBookingSlots(tx, { tenantId, timezone: TZ }, {
        branchId,
        slots: [{ resourceId: ps5A.rows[0].id, startsAt: sat('10:00').toISOString(), endsAt: sat('11:00').toISOString() }],
      }),
    )
    check('T11 priceBookingSlots called directly resolves the same weekend rate: subtotal = 150', priced.subtotal === 150)
  }

  // ── j. snapshot freeze: a later resource-type rate change can't reprice ──
  {
    const r = await bookAndLoad(ps5A.rows[0].id, sat('20:00'), sat('22:00'))
    await ownerPool.query(`update resource_types set weekend_rate = '999.00', hourly_rate = '999.00' where id = $1`, [
      ps5Type.rows[0].id,
    ])
    const { rows } = await ownerPool.query(`select rate_applied, slot_total from booking_slots where booking_id = $1`, [
      r.bookingId,
    ])
    check('T10 rate_applied stays frozen at 150.00 after the type\'s rates change to 999.00', rows[0].rate_applied === '150.00')
    check('T10 …slot_total stays frozen at 300.00 — the raised bill does not move', rows[0].slot_total === '300.00')
  }

  // ── k. M22 #5: snapshot freeze also holds against a WEEKEND_DAYS change —
  // not just a resource-type rate change (block j above). A booking taken
  // while Saturday counted as weekend must keep its weekend rate even after
  // the tenant later redefines its weekend days to exclude Saturday.
  {
    // Snooker (per-head, weekend_rate=80) — not Pool, whose weekend_rate is
    // null and so wouldn't distinguish a real freeze from "was already the
    // same price either way."
    const r2 = await bookAndLoad(snookerA.rows[0].id, sat('14:00'), sat('16:00'), 2)
    check('T17 setup: Saturday booking on Snooker bills the weekend rate before the change: 80.00', r2.rateApplied === '80.00')

    await ownerPool.query(`update business_profiles set weekend_days = '{}' where tenant_id = $1`, [tenantId])
    const { rows } = await ownerPool.query(`select rate_applied, slot_total from booking_slots where booking_id = $1`, [
      r2.bookingId,
    ])
    check(
      'T17 …rate_applied STAYS 80.00 after weekend_days is cleared to {} (no day is weekend anymore)',
      rows[0].rate_applied === '80.00',
    )
    check('T17 …slot_total stays frozen too: 320.00 (2 players × ₹80 × 2h)', rows[0].slot_total === '320.00')

    // A NEW booking on the same Saturday, taken AFTER the change, correctly
    // gets the now-current (weekday) rate — proves this is a freeze on the
    // old booking, not a resolver that's stuck reading a stale weekend_days.
    const r3 = await bookAndLoad(snookerA.rows[0].id, sat('17:00'), sat('18:00'), 2)
    check(
      'T17 …but a NEW Saturday booking taken after the change bills the current (weekday) rate: 50.00',
      r3.rateApplied === '50.00',
    )

    // Restore the default for anything after this block.
    await ownerPool.query(`update business_profiles set weekend_days = '{0,6}' where tenant_id = $1`, [tenantId])
  }

  // ── l. M22 #5: reconciles to the paise through the SAME billing path a
  // raised invoice uses (loadBookingLines -> priceBill) — not just
  // priceBookingSlots' own return value. Reuses the T8 per-head weekend
  // booking (Snooker, 3 players × ₹80/hr weekend rate × 2h = ₹480.00).
  {
    const lines = await withUser(userId, (tx) => loadBookingLines(tx, tenantId, snookerBookingIdForT8, TZ))
    check('T18 loadBookingLines returns exactly one line for the weekend per-head booking', lines.length === 1)
    const [line] = lines
    check(
      'T18 …qty × unitPrice reconstructs the weekend total: qty=6 (3 players × 2h), unitPrice=80',
      line.qty === 6 && line.unitPrice === 80,
    )
    const bill = priceBill({ lines: [line], discount: round2(480 * 0.1) })
    check('T18 …prices to exactly 480.00 through priceBill before any discount', round2(line.qty * line.unitPrice) === 480)
    check(
      'T18 …a 10% discount on top of the weekend total reconciles to the paise: subtotal − discount + tax = total',
      round2(bill.subtotal - bill.discount + bill.taxTotal) === bill.total,
    )
  }

  await ownerPool.query('delete from tenants where id = $1', [tenantId])
  await ownerPool.query(`delete from users where email = $1`, [`owner@${slug}.test`])
  await ownerPool.end()
  await appPool.end()
}

// ── 3. startWalkinCore / checkoutWalkinCore — walk-ins, real DB ─────────────
// A walk-in's start time is gated to within 30 minutes of the REAL "now"
// (WALKIN_START_WINDOW_MINUTES), so its calendar day can't be forced the way
// a reserved booking's can. Instead these tests hold TIME fixed at "now" and
// swing business_profiles.weekend_days to include/exclude TODAY's actual
// weekday — proving the same resolution regardless of which day this suite
// happens to run on.
async function testWalkins() {
  const { startWalkinCore, checkoutWalkinCore } = await import('../lib/booking/walkin')
  const ownerPool = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })
  const appPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 })
  const app = drizzle(appPool, { schema })

  async function withUser<T>(userId: string, fn: (tx: Db) => Promise<T>): Promise<T> {
    return app.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`)
      return fn(tx as unknown as Db)
    })
  }

  const slug = 'testweekendwalkin'
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

  // Idempotent against a previous run that died mid-way — see the matching
  // comment in testReservedBookings. A leftover open-tab walk-in (ends_at
  // still null) would otherwise block this run's walk-in on the same station.
  await ownerPool.query(`delete from booking_slots where tenant_id = $1`, [tenantId])
  await ownerPool.query(`delete from bookings where tenant_id = $1`, [tenantId])
  await ownerPool.query(`delete from happy_hours where tenant_id = $1`, [tenantId])

  const psType = await ownerPool.query<{ id: string }>(
    `insert into resource_types (tenant_id,name,hourly_rate,weekend_rate) values ($1,'PS5 WalkinWeekend','100.00','200.00')
     on conflict (tenant_id,name) do update set hourly_rate=excluded.hourly_rate, weekend_rate=excluded.weekend_rate
     returning id`,
    [tenantId],
  )
  const noWeekendType = await ownerPool.query<{ id: string }>(
    `insert into resource_types (tenant_id,name,hourly_rate,weekend_rate) values ($1,'Table WalkinNoWeekend','90.00',null)
     on conflict (tenant_id,name) do update set hourly_rate=excluded.hourly_rate, weekend_rate=null returning id`,
    [tenantId],
  )
  const stationWeekend = await ownerPool.query<{ id: string }>(
    `insert into resources (tenant_id,branch_id,resource_type_id,name,status) values ($1,$2,$3,'PS-W1','available')
     on conflict (tenant_id,name) do update set status='available' returning id`,
    [tenantId, branchId, psType.rows[0].id],
  )
  const stationNoWeekendActive = await ownerPool.query<{ id: string }>(
    `insert into resources (tenant_id,branch_id,resource_type_id,name,status) values ($1,$2,$3,'PS-W2','available')
     on conflict (tenant_id,name) do update set status='available' returning id`,
    [tenantId, branchId, psType.rows[0].id],
  )
  const tableNoWeekend = await ownerPool.query<{ id: string }>(
    `insert into resources (tenant_id,branch_id,resource_type_id,name,status) values ($1,$2,$3,'Table-W1','available')
     on conflict (tenant_id,name) do update set status='available' returning id`,
    [tenantId, branchId, noWeekendType.rows[0].id],
  )

  const ctx = { tenantId, timezone: TZ, membershipId }
  const todayWeekday = new Date().getDay()
  const notTodayWeekday = (todayWeekday + 1) % 7

  async function rateApplied(bookingId: string): Promise<string> {
    const { rows } = await ownerPool.query(`select rate_applied from booking_slots where booking_id = $1`, [bookingId])
    return rows[0].rate_applied
  }

  // ── a. today counts as weekend -> the walk-in snapshots the weekend rate ──
  await ownerPool.query(
    `insert into business_profiles (tenant_id, weekend_days) values ($1, $2)
     on conflict (tenant_id) do update set weekend_days = excluded.weekend_days`,
    [tenantId, [todayWeekday]],
  )
  {
    const walkin = await withUser(userId, (tx) =>
      startWalkinCore(tx, ctx, {
        branchId,
        resourceId: stationWeekend.rows[0].id,
        phone: '9990000001',
        startAt: new Date().toISOString(),
        mode: 'open_tab',
      }),
    )
    check(
      'T12 today configured as weekend: open-tab walk-in snapshots rate_applied = 200.00 (the weekend rate)',
      (await rateApplied(walkin.id)) === '200.00',
    )

    // ── composition: happy hour applies ON TOP of the weekend rate ─────────
    await ownerPool.query(
      `insert into happy_hours (tenant_id,name,days_of_week,start_time,end_time,discount_type,discount_value,is_active)
       values ($1,'All-day 50% off','{0,1,2,3,4,5,6}','00:00','23:59','percentage',50,true)
       on conflict do nothing`,
      [tenantId],
    )
    const checkout = await withUser(userId, (tx) => checkoutWalkinCore(tx, ctx, { bookingId: walkin.id }))
    // Instant checkout bills the 30-min minimum: 0.5h × (₹200 × 50% off) = ₹50.
    check(
      'T13 checkout composes the weekend rate with an active happy hour: total = 50.00 (30-min minimum × ₹200/hr weekend rate × 50% off)',
      checkout.total === 50,
    )
    await ownerPool.query(`delete from happy_hours where tenant_id = $1`, [tenantId])
  }

  // ── b. today does NOT count as weekend -> the walk-in bills the weekday rate ─
  await ownerPool.query(`update business_profiles set weekend_days = $1 where tenant_id = $2`, [
    [notTodayWeekday],
    tenantId,
  ])
  {
    const walkin = await withUser(userId, (tx) =>
      startWalkinCore(tx, ctx, {
        branchId,
        resourceId: stationNoWeekendActive.rows[0].id,
        phone: '9990000002',
        startAt: new Date().toISOString(),
        mode: 'open_tab',
      }),
    )
    check(
      'T14 today NOT configured as weekend: open-tab walk-in snapshots rate_applied = 100.00 (the weekday rate)',
      (await rateApplied(walkin.id)) === '100.00',
    )
  }

  // ── c. weekend_rate = null -> a walk-in on a "no weekend pricing" type
  // prices identically whether today counts as weekend or not.
  await ownerPool.query(`update business_profiles set weekend_days = $1 where tenant_id = $2`, [[todayWeekday], tenantId])
  {
    const walkin = await withUser(userId, (tx) =>
      startWalkinCore(tx, ctx, {
        branchId,
        resourceId: tableNoWeekend.rows[0].id,
        phone: '9990000003',
        startAt: new Date().toISOString(),
        mode: 'open_tab',
      }),
    )
    check(
      'T15 today IS weekend, but the type has no weekend_rate: rate_applied stays 90.00 (opt-in, unaffected)',
      (await rateApplied(walkin.id)) === '90.00',
    )
  }

  await ownerPool.query('delete from tenants where id = $1', [tenantId])
  await ownerPool.query(`delete from users where email = $1`, [`owner@${slug}.test`])
  await ownerPool.end()
  await appPool.end()
}

async function main() {
  testPureResolver()
  await testReservedBookings()
  await testWalkins()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
