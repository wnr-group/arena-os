/**
 * M24 #2 — the studio-setups pricing engine: an optional named setup on a
 * booking slot, priced flat (hourly or per-day) INSTEAD OF the resource's own
 * weekend/happy-hour/per-head composition (lib/booking/service.ts's
 * priceBookingSlots, and the day-rate branch in loadBookingLines,
 * lib/billing/invoice.ts). This pins:
 *
 *   - an hourly setup bills flat rate × hours, ignoring an active weekend
 *     rate AND an active happy-hour rule that would otherwise fire
 *   - a per-day setup bills flat rate × daysInRange(startsAt, endsAt, tz),
 *     for both a single day and a multi-day range
 *   - per-head is a no-op for a setup slot even when the resource TYPE is
 *     pricing_mode='per_head' and a headCount is supplied
 *   - a setupId is re-validated server-side: wrong resource, inactive, or
 *     cross-tenant all fail closed with a BookingError, never a silent
 *     fallback to the base rate
 *   - the exclusion constraint still does its job for free: a setup booking
 *     and a base-rate/other-setup booking on the SAME physical resource can
 *     never overlap
 *   - setup_id/setup_name/rate_applied/rate_unit freeze at booking time — a
 *     later edit to the setup's rate never restates an existing booking
 *   - the no-setup path is byte-identical to before this ticket
 *   - loadBookingLines -> priceBill reconciles to the paise for both an
 *     hourly and a per-day setup line
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs scripts/test-studio-setups-pricing.ts
 */
import { Pool } from 'pg'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { sql } from 'drizzle-orm'
import * as schema from '../db/schema'
import { createBookingCore, priceBookingSlots, BookingError } from '../lib/booking/service'
import { loadBookingLines } from '../lib/billing/invoice'
import { priceBill, round2 } from '../lib/billing/pricing'
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
async function expectExclusionViolation(l: string, fn: () => Promise<unknown>) {
  try {
    await fn()
    check(l, false)
  } catch (e) {
    // drizzle wraps the raw pg error in a DrizzleQueryError — the pg error
    // (with .code) lives on .cause, not on the wrapper itself.
    const code = (e as { code?: string; cause?: { code?: string } })?.cause?.code ?? (e as { code?: string })?.code
    check(l, code === '23P01')
    if (code !== '23P01') console.log('   (unexpected)', e)
  }
}

const TZ = 'Asia/Kolkata'
/** Whole-hour IST wall-clock constructor. 2026-08-15 is a SATURDAY in IST — a
 *  weekend day, and inside the all-day happy-hour rule below — chosen
 *  deliberately so a setup booking on that day proves it ignores BOTH,
 *  unlike a base-rate booking on the same day. */
const ist = (y: number, m: number, d: number, hh: number, mm = 0) =>
  new Date(Date.UTC(y, m - 1, d, hh, mm) - (5 * 60 + 30) * 60_000)

async function main() {
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

  const slug = 'teststudiosetups2'
  const t = await ownerPool.query<{ id: string }>(
    `insert into tenants (slug,name,status,timezone,industry) values ($1,$2,'active',$3,'recording_studio')
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
  // priceBookingSlots (adversarial-review follow-up) now re-derives a
  // day-rate slot's expected D1-open -> Dn-close window from THIS branch's
  // real working_hours and refuses a mismatch — every other weekday here has
  // no row and falls back to the app's own DEFAULT_HOURS (10:00-22:00,
  // matching the hour literals below), but T3b/T3c's open24h boundary cases
  // need an explicit row: Monday (Jan 12, 2026's weekday) and Tuesday
  // (Jan 20, 2026's weekday) are set Open 24 Hours so those two scenarios'
  // hardcoded midnight boundaries are real, server-agreed windows.
  await ownerPool.query(
    `insert into working_hours (tenant_id,branch_id,day_of_week,open_24h) values ($1,$2,1,true),($1,$2,2,true)
     on conflict (branch_id,day_of_week) do update set open_24h=true`,
    [tenantId, branchId],
  )
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

  // The one physical set — base rate ₹500/hr weekday, ₹999/hr weekend (so a
  // weekend/happy-hour composition WOULD change the price if a setup didn't
  // bypass it).
  const setType = await ownerPool.query<{ id: string }>(
    `insert into resource_types (tenant_id,name,hourly_rate,weekend_rate) values ($1,'Studio Set','500.00','999.00')
     on conflict (tenant_id,name) do update set hourly_rate=excluded.hourly_rate, weekend_rate=excluded.weekend_rate returning id`,
    [tenantId],
  )
  const setResource = await ownerPool.query<{ id: string }>(
    `insert into resources (tenant_id,branch_id,resource_type_id,name,status) values ($1,$2,$3,'Set A','available')
     on conflict (tenant_id,name) do update set status='available' returning id`,
    [tenantId, branchId, setType.rows[0].id],
  )
  const resourceId = setResource.rows[0].id
  // Weekend business_profiles.weekend_days default is {0,6} (Sat+Sun) — no
  // override needed; 2026-08-15 is a Saturday.
  await ownerPool.query(
    `insert into business_profiles (tenant_id) values ($1) on conflict (tenant_id) do nothing`,
    [tenantId],
  )

  // An all-day, every-day happy hour so ANY hour of ANY day would otherwise
  // be discounted — the strongest possible proof a setup ignores it.
  await ownerPool.query(
    `insert into happy_hours (tenant_id,name,days_of_week,start_time,end_time,discount_type,discount_value,is_active)
     values ($1,'All Day',$2,'00:00','23:59','percentage',90,true)`,
    [tenantId, [0, 1, 2, 3, 4, 5, 6]],
  )

  // A second per_head resource type + setup, to prove per-head is a no-op
  // for a setup slot (v1 scoping).
  const perHeadType = await ownerPool.query<{ id: string }>(
    `insert into resource_types (tenant_id,name,hourly_rate,pricing_mode,min_players) values ($1,'Group Set','50.00','per_head',2)
     on conflict (tenant_id,name) do update set hourly_rate=excluded.hourly_rate returning id`,
    [tenantId],
  )
  const perHeadResource = await ownerPool.query<{ id: string }>(
    `insert into resources (tenant_id,branch_id,resource_type_id,name,status) values ($1,$2,$3,'Group A','available')
     on conflict (tenant_id,name) do update set status='available' returning id`,
    [tenantId, branchId, perHeadType.rows[0].id],
  )

  // ── setups ──────────────────────────────────────────────────────────────
  const kitchen = await ownerPool.query<{ id: string }>(
    `insert into resource_setups (tenant_id,resource_id,name,rate,rate_unit) values ($1,$2,'Kitchen','800.00','hour') returning id`,
    [tenantId, resourceId],
  )
  const kitchenId = kitchen.rows[0].id
  const royal = await ownerPool.query<{ id: string }>(
    `insert into resource_setups (tenant_id,resource_id,name,rate,rate_unit) values ($1,$2,'Royal','6000.00','day') returning id`,
    [tenantId, resourceId],
  )
  const royalId = royal.rows[0].id
  const groupSetup = await ownerPool.query<{ id: string }>(
    `insert into resource_setups (tenant_id,resource_id,name,rate,rate_unit) values ($1,$2,'Fixed Group Rate','1000.00','hour') returning id`,
    [tenantId, perHeadResource.rows[0].id],
  )
  const inactiveSetup = await ownerPool.query<{ id: string }>(
    `insert into resource_setups (tenant_id,resource_id,name,rate,rate_unit,is_active) values ($1,$2,'Retired','1.00','hour',false) returning id`,
    [tenantId, resourceId],
  )
  // Another tenant's setup, for the cross-tenant fail-closed check.
  const other = await ownerPool.query<{ id: string }>(
    `insert into tenants (slug,name,status,timezone) values ('teststudiosetups2other','other','active',$1)
     on conflict (slug) do update set name=excluded.name returning id`,
    [TZ],
  )
  const otherSetup = await ownerPool.query<{ id: string }>(
    `insert into resource_setups (tenant_id,resource_id,name,rate,rate_unit) values ($1,$2,'Theirs','1.00','hour') returning id`,
    [other.rows[0].id, resourceId],
  )

  const ctx = { tenantId, timezone: TZ, membershipId }

  // ══ 1. hourly setup — flat rate, ignores weekend + happy hour ═══════════
  console.log('\n── hourly setup ──')
  let kitchenBookingId = ''
  {
    const booking = await withUser(userId, (tx) =>
      createBookingCore(tx, ctx, {
        branchId,
        source: 'staff',
        discount: 0,
        deposit: 0,
        slots: [
          {
            resourceId,
            startsAt: ist(2026, 8, 15, 10).toISOString(), // Saturday, inside the HH window
            endsAt: ist(2026, 8, 15, 12).toISOString(),
            setupId: kitchenId,
          },
        ],
      }),
    )
    kitchenBookingId = booking.id
    const { rows } = await ownerPool.query(
      `select rate_applied, slot_total, rate_unit, setup_id, setup_name, head_count, pricing_mode, happy_hour_applied
       from booking_slots where booking_id = $1`,
      [booking.id],
    )
    const row = rows[0]
    check('T1 rate_applied = 800.00 (the flat setup rate, not the ₹999 weekend rate)', row.rate_applied === '800.00')
    check('T1 slot_total = 1600.00 (2h × ₹800, weekend + 90%-off happy hour both ignored)', row.slot_total === '1600.00')
    check("T1 rate_unit = 'hour'", row.rate_unit === 'hour')
    check('T1 setup_id snapshot matches Kitchen', row.setup_id === kitchenId)
    check("T1 setup_name snapshot = 'Kitchen'", row.setup_name === 'Kitchen')
    check('T1 head_count stays null for a setup slot', row.head_count === null)
    check('T1 happy_hour_applied stays false for a setup slot', row.happy_hour_applied === false)
  }

  // ── control: the SAME window with NO setup bills the weekend rate + HH ──
  {
    const quote = await withUser(userId, (tx) =>
      priceBookingSlots(tx, { tenantId, timezone: TZ }, {
        branchId,
        slots: [
          {
            resourceId,
            startsAt: ist(2026, 8, 15, 14).toISOString(),
            endsAt: ist(2026, 8, 15, 15).toISOString(),
          },
        ],
      }),
    )
    check(
      'control: the base-rate path on the same Saturday DOES discount (90% off ₹999 weekend rate ≈ ₹99.90) — proves setups are the exception, not a broken test',
      round2(quote.subtotal) === 99.9,
    )
  }

  // ══ 2. per-day setup — single day and a multi-day range ═════════════════
  console.log('\n── per-day setup ──')
  let royalOneDayId = ''
  {
    const booking = await withUser(userId, (tx) =>
      createBookingCore(tx, ctx, {
        branchId,
        source: 'staff',
        discount: 0,
        deposit: 0,
        slots: [
          {
            resourceId,
            // Sep 2 (Wednesday) — deliberately NOT Sep 1 (Tuesday), which
            // T3c below needs Open 24 Hours; a plain weekday here must stay
            // on the DEFAULT_HOURS fallback (10:00-22:00), matching the
            // hour literals below.
            startsAt: ist(2026, 9, 2, 10).toISOString(), // D1 open
            endsAt: ist(2026, 9, 2, 22).toISOString(), // D1 close — same calendar day
            setupId: royalId,
          },
        ],
      }),
    )
    royalOneDayId = booking.id
    const { rows } = await ownerPool.query(
      `select rate_applied, slot_total, rate_unit from booking_slots where booking_id = $1`,
      [booking.id],
    )
    check('T2 1-day range: rate_applied = 6000.00 (the flat day rate)', rows[0].rate_applied === '6000.00')
    check('T2 1-day range: slot_total = 6000.00 (1 day × ₹6000)', rows[0].slot_total === '6000.00')
    check("T2 1-day range: rate_unit = 'day'", rows[0].rate_unit === 'day')
  }

  let royalThreeDayId = ''
  {
    const booking = await withUser(userId, (tx) =>
      createBookingCore(tx, ctx, {
        branchId,
        source: 'staff',
        discount: 0,
        deposit: 0,
        slots: [
          {
            resourceId,
            startsAt: ist(2026, 9, 10, 10).toISOString(), // D1 open (Thursday, DEFAULT_HOURS)
            endsAt: ist(2026, 9, 12, 22).toISOString(), // D3 close — spans 3 calendar days
            setupId: royalId,
          },
        ],
      }),
    )
    royalThreeDayId = booking.id
    const { rows } = await ownerPool.query(`select slot_total from booking_slots where booking_id = $1`, [booking.id])
    check('T3 3-day range: slot_total = 18000.00 (3 days × ₹6000)', rows[0].slot_total === '18000.00')
  }

  // T3b: the range's LAST day is "Open 24 Hours" (0098_working_hours_24h.sql)
  // — dayWindow() correctly resolves that day's close to the NEXT calendar
  // day's midnight (an exclusive upper bound, right for the hourly slot
  // grid it was written for), but daysInRange must still read that as the
  // END of Jan 12, not the start of a phantom 4th day. Reproduces exactly
  // what getDayRangeWindow/getPublicDayRangeWindow would hand to
  // createBookingCore for a Jan 10 -> Jan 12 range where Jan 12 (a Monday)
  // is open24h per the working_hours row inserted above.
  let royalOpen24hId = ''
  {
    const booking = await withUser(userId, (tx) =>
      createBookingCore(tx, ctx, {
        branchId,
        source: 'staff',
        discount: 0,
        deposit: 0,
        slots: [
          {
            resourceId,
            startsAt: ist(2026, 1, 10, 10).toISOString(), // D1 open (Saturday, DEFAULT_HOURS)
            endsAt: ist(2026, 1, 13, 0).toISOString(), // Jan 12 is open24h -> close = Jan 13 00:00 IST
            setupId: royalId,
          },
        ],
      }),
    )
    royalOpen24hId = booking.id
    const { rows } = await ownerPool.query(`select slot_total from booking_slots where booking_id = $1`, [booking.id])
    check(
      'T3b 3-day range ending on an Open-24h day: slot_total = 18000.00 (3 days, NOT 4)',
      rows[0].slot_total === '18000.00',
    )
  }

  // T3c: a SINGLE day that is itself open24h (start AND end both land on
  // literal midnight) — must still price as exactly 1 day, not 0 or 2.
  {
    const booking = await withUser(userId, (tx) =>
      createBookingCore(tx, ctx, {
        branchId,
        source: 'staff',
        discount: 0,
        deposit: 0,
        slots: [
          {
            resourceId,
            startsAt: ist(2026, 1, 20, 0).toISOString(), // D1 open24h -> open = Jan 20 00:00 IST
            endsAt: ist(2026, 1, 21, 0).toISOString(), // same day's close = Jan 21 00:00 IST
            setupId: royalId,
          },
        ],
      }),
    )
    const { rows } = await ownerPool.query(`select slot_total from booking_slots where booking_id = $1`, [booking.id])
    check(
      'T3c a single open24h day: slot_total = 6000.00 (1 day, not 0 or 2)',
      rows[0].slot_total === '6000.00',
    )
  }

  // ══ 3. per-head is a no-op for a setup slot ═════════════════════════════
  console.log('\n── per-head + setup ──')
  {
    const booking = await withUser(userId, (tx) =>
      createBookingCore(tx, ctx, {
        branchId,
        source: 'staff',
        discount: 0,
        deposit: 0,
        headCount: 6, // supplied anyway — must be ignored for a setup slot
        slots: [
          {
            resourceId: perHeadResource.rows[0].id,
            startsAt: ist(2026, 9, 15, 10).toISOString(),
            endsAt: ist(2026, 9, 15, 12).toISOString(),
            setupId: groupSetup.rows[0].id,
          },
        ],
      }),
    )
    const { rows } = await ownerPool.query(
      `select slot_total, head_count from booking_slots where booking_id = $1`,
      [booking.id],
    )
    check(
      'T4 flat ₹1000/hr × 2h = 2000.00, NOT multiplied by the 6 players supplied',
      rows[0].slot_total === '2000.00',
    )
    check('T4 booking_slots.head_count stays null even though headCount=6 was supplied', rows[0].head_count === null)
  }

  // ══ 4. fail-closed validation ════════════════════════════════════════════
  console.log('\n── fail-closed validation ──')
  await expectReject(
    'T5 a setup belonging to a DIFFERENT resource is rejected',
    () =>
      withUser(userId, (tx) =>
        priceBookingSlots(tx, { tenantId, timezone: TZ }, {
          branchId,
          slots: [
            {
              resourceId: perHeadResource.rows[0].id,
              startsAt: ist(2026, 9, 20, 10).toISOString(),
              endsAt: ist(2026, 9, 20, 11).toISOString(),
              setupId: kitchenId, // Kitchen belongs to Set A, not Group A
            },
          ],
        }),
      ),
    'no longer available',
  )
  await expectReject(
    'T6 an INACTIVE setup is rejected',
    () =>
      withUser(userId, (tx) =>
        priceBookingSlots(tx, { tenantId, timezone: TZ }, {
          branchId,
          slots: [
            {
              resourceId,
              startsAt: ist(2026, 9, 20, 10).toISOString(),
              endsAt: ist(2026, 9, 20, 11).toISOString(),
              setupId: inactiveSetup.rows[0].id,
            },
          ],
        }),
      ),
    'no longer available',
  )
  await expectReject(
    "T7 another tenant's setup id is rejected (cross-tenant fail-closed)",
    () =>
      withUser(userId, (tx) =>
        priceBookingSlots(tx, { tenantId, timezone: TZ }, {
          branchId,
          slots: [
            {
              resourceId,
              startsAt: ist(2026, 9, 20, 10).toISOString(),
              endsAt: ist(2026, 9, 20, 11).toISOString(),
              setupId: otherSetup.rows[0].id,
            },
          ],
        }),
      ),
    'no longer available',
  )

  // T7b/T7c (adversarial review, PR #34): a day-rate setup's whole point is
  // that it blocks the physical set for the WHOLE day(s) booked — but
  // nothing re-derived that from the client's raw startsAt/endsAt until this
  // fix, so a crafted request naming a real, active Royal (day) setup with a
  // tiny sliver of a day got charged the full day rate (daysInRange's own
  // max(1,…) clamp) while only reserving that sliver, leaving the rest of
  // the day double-bookable on the exact feature whose exclusivity is the
  // point. Every legitimate caller (staff wizard, public booking page)
  // always submits the server-computed getDayRangeWindow/
  // getPublicDayRangeWindow window verbatim, so these can never reject a
  // real booking.
  await expectReject(
    'T7b a day-rate setup booked for a 5-minute sliver of a day (not D1-open -> D1-close) is rejected',
    () =>
      withUser(userId, (tx) =>
        priceBookingSlots(tx, { tenantId, timezone: TZ }, {
          branchId,
          slots: [{ resourceId, startsAt: ist(2026, 9, 23, 10).toISOString(), endsAt: ist(2026, 9, 23, 10, 5).toISOString(), setupId: royalId }],
        }),
      ),
    'whole calendar days',
  )
  await expectReject(
    'T7c a day-rate range off by an hour from the real working-hours boundary is rejected, not silently priced',
    () =>
      withUser(userId, (tx) =>
        priceBookingSlots(tx, { tenantId, timezone: TZ }, {
          branchId,
          // Sep 23, 2026 is a Wednesday — DEFAULT_HOURS (10:00-22:00)
          // applies (no working_hours row for this branch), so 11:00 open
          // is one hour late, not the real D1 open.
          slots: [{ resourceId, startsAt: ist(2026, 9, 23, 11).toISOString(), endsAt: ist(2026, 9, 25, 22).toISOString(), setupId: royalId }],
        }),
      ),
    'whole calendar days',
  )

  // ══ 5. mutual exclusion is free — a setup blocks every other setup/base ═
  console.log('\n── mutual exclusion (the existing GiST constraint) ──')
  await expectExclusionViolation(
    'T8 booking Kitchen (hourly) overlapping the 3-day Royal range on the SAME resource is rejected by the DB',
    () =>
      withUser(userId, (tx) =>
        createBookingCore(tx, ctx, {
          branchId,
          source: 'staff',
          discount: 0,
          deposit: 0,
          slots: [
            {
              resourceId,
              startsAt: ist(2026, 9, 11, 10).toISOString(), // inside the D1..D3 Royal range
              endsAt: ist(2026, 9, 11, 11).toISOString(),
              setupId: kitchenId,
            },
          ],
        }),
      ),
  )
  await expectExclusionViolation(
    'T9 a BASE-RATE (no setup) booking overlapping the same range is rejected too',
    () =>
      withUser(userId, (tx) =>
        createBookingCore(tx, ctx, {
          branchId,
          source: 'staff',
          discount: 0,
          deposit: 0,
          slots: [
            {
              resourceId,
              startsAt: ist(2026, 9, 11, 10).toISOString(),
              endsAt: ist(2026, 9, 11, 11).toISOString(),
            },
          ],
        }),
      ),
  )

  // ══ 6. base-rate path stays byte-identical to before this ticket ═══════
  console.log('\n── base-rate path, unaffected ──')
  {
    // A plain weekday (Tuesday), no setup: ₹500/hr × 2h = ₹1000, no HH rule
    // active outside... wait, the HH rule here is all-day/every-day, so
    // assert the base rate DOES discount here too — the point is only that
    // it behaves EXACTLY as M22/M23 already pin, i.e. this ticket changed
    // nothing about the no-setup path.
    const quote = await withUser(userId, (tx) =>
      priceBookingSlots(tx, { tenantId, timezone: TZ }, {
        branchId,
        slots: [
          {
            resourceId,
            startsAt: ist(2026, 9, 22, 10).toISOString(), // Tuesday — weekday
            endsAt: ist(2026, 9, 22, 12).toISOString(),
          },
        ],
      }),
    )
    check('T10 weekday, no setup: 90% off ₹500/hr × 2h = 100.00 (unchanged M23 behaviour)', quote.subtotal === 100)
    check('T10 slots[0].setupId is null', quote.slots[0].setupId === null)
    check('T10 slots[0].setupName is null', quote.slots[0].setupName === null)
    check("T10 slots[0].rateUnit = 'hour'", quote.slots[0].rateUnit === 'hour')
  }

  // ══ 7. snapshot freeze — a later rate edit never restates a taken booking ═
  console.log('\n── snapshot freeze ──')
  {
    await ownerPool.query(`update resource_setups set rate = '50000.00' where id = $1`, [kitchenId])
    const { rows } = await ownerPool.query(
      `select rate_applied, slot_total from booking_slots where booking_id = $1`,
      [kitchenBookingId],
    )
    check('T11 rate_applied stays frozen at 800.00 after Kitchen\'s rate changes to 50000.00', rows[0].rate_applied === '800.00')
    check('T11 slot_total stays frozen at 1600.00', rows[0].slot_total === '1600.00')

    await ownerPool.query(`update resource_setups set rate = '9999.00' where id = $1`, [royalId])
    const r2 = await ownerPool.query(`select slot_total from booking_slots where booking_id = $1`, [royalThreeDayId])
    check('T11 the 3-day Royal booking also stays frozen at 18000.00 after Royal\'s day rate changes', r2.rows[0].slot_total === '18000.00')
  }

  // ══ 8. loadBookingLines -> priceBill reconciles to the paise ════════════
  console.log('\n── loadBookingLines -> priceBill ──')
  {
    const lines = await withUser(userId, (tx) => loadBookingLines(tx, tenantId, kitchenBookingId, TZ))
    check('T12 hourly setup: exactly one line', lines.length === 1)
    check('T12 …qty=2 (hours), unitPrice=800 (the frozen setup rate)', lines[0].qty === 2 && lines[0].unitPrice === 800)
    const priced = priceBill({ lines: [{ ...lines[0], taxPercent: 18 }], discount: 160 })
    check('T12 …subtotal = 1600.00 through priceBill', priced.subtotal === 1600)
    check(
      'T12 …reconciles to the paise with a discount + tax on top: subtotal − discount + taxTotal = total',
      round2(priced.subtotal - priced.discount + priced.taxTotal) === priced.total,
    )
  }
  {
    const lines = await withUser(userId, (tx) => loadBookingLines(tx, tenantId, royalOneDayId, TZ))
    check('T13 per-day setup: exactly one line', lines.length === 1)
    check('T13 …qty=1 (day), unitPrice=6000 (the day rate)', lines[0].qty === 1 && lines[0].unitPrice === 6000)
    const priced = priceBill({ lines: [{ ...lines[0], taxPercent: 18 }] })
    check('T13 …prices to exactly 6000.00 through priceBill', priced.subtotal === 6000)
  }
  {
    const lines = await withUser(userId, (tx) => loadBookingLines(tx, tenantId, royalThreeDayId, TZ))
    check('T14 3-day setup: exactly one line', lines.length === 1)
    check('T14 …qty=3 (days), unitPrice=6000 (the ORIGINAL day rate — frozen, not the 9999 it was changed to)', lines[0].qty === 3 && lines[0].unitPrice === 6000)
    const priced = priceBill({ lines: [{ ...lines[0], taxPercent: 18 }] })
    check('T14 …prices to exactly 18000.00 through priceBill', priced.subtotal === 18000)
  }
  {
    // T14b: loadBookingLines is a SEPARATE call site of daysInRange from
    // priceBookingSlots (T3b already pinned the booking's own slot_total) —
    // reconstructing the bill for the SAME open24h-ending booking must also
    // read qty=3, not 4, or the invoice would disagree with what was charged.
    const lines = await withUser(userId, (tx) => loadBookingLines(tx, tenantId, royalOpen24hId, TZ))
    check('T14b open24h-ending 3-day setup: exactly one line', lines.length === 1)
    check('T14b …qty=3 (days, NOT 4), unitPrice=6000', lines[0].qty === 3 && lines[0].unitPrice === 6000)
    const priced = priceBill({ lines: [{ ...lines[0], taxPercent: 18 }] })
    check('T14b …prices to exactly 18000.00 through priceBill (not 24000.00)', priced.subtotal === 18000)
  }

  // ── cleanup ───────────────────────────────────────────────────────────────
  await ownerPool.query('delete from tenants where id = $1', [other.rows[0].id])
  await ownerPool.query('delete from tenants where id = $1', [tenantId])
  await ownerPool.query(`delete from users where email = $1`, [`owner@${slug}.test`])
  await ownerPool.end()
  await appPool.end()

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
