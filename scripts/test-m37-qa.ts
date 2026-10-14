/**
 * M37 #5 - QA for the advance-booking window, through the REAL server actions
 * (public: tenant resolved from the x-tenant-slug header; staff: a real session
 * behind the real requireContext()) and as NON-owner DB roles.
 *
 *   1. default unchanged - no row = 7 days, existing bookings untouched
 *   2. each preset 7/30/90/180 x {public, staff} x {create, quote, availability,
 *      day-range}: last bookable date accepted, the day after refused
 *   3. boundaries - month end, year end, leap day, and the DST change day in a
 *      180-day window (America/New_York) and +05:30: 00:00-local day edges, and
 *      a slot that starts on the last day and runs past midnight
 *   4. setting changes - raise 7 -> 90 opens dates; lower 90 -> 7 closes them
 *      while an existing far booking stays and can still be cancelled
 *   5. interplay - a far-future booking prices on the RIGHT day (holiday rate,
 *      weekend rate, hourly setup), holds and takes an advance (M36), a per-day
 *      setup keeps its exclusivity (M24/M35)
 *   6. not affected - customer-facing cancel/edit of a far booking, walk-in
 *      start-now, backdated entry (their own scripts also run in the regression)
 *   7. performance - the picker never fetches; each page reads the setting once
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs --import ./scripts/next-runtime-hook.mjs scripts/test-m37-qa.ts
 */
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { Pool } from 'pg'
import { loadEnv } from './env'
import { seedRazorpay } from './seed-razorpay'

let pass = 0,
  fail = 0
const check = (l: string, c: boolean, got?: unknown) => {
  console.log(`${c ? '✓' : '✗ FAIL'}  ${l}${c ? '' : `  (got: ${JSON.stringify(got)?.slice(0, 300)})`}`)
  if (c) pass++
  else fail++
}

type G = { __ARENA_TEST_SESSION?: string; __ARENA_TEST_HEADERS?: Record<string, string> }
const g = globalThis as G

async function main() {
  loadEnv()
  const pub = await import('../lib/actions/public-booking')
  const staffAvail = await import('../lib/actions/availability')
  const staffBook = await import('../lib/actions/bookings')
  const { createBookingCore } = await import('../lib/booking/service')
  const { applyBookingWindow } = await import('../lib/booking/settings-write')
  const { withUser } = await import('../db')
  const { addDays, todayInZone, zonedTimeToUtc } = await import('../lib/booking/time')
  const { dayWindow } = await import('../lib/booking/availability')
  const { lastBookableDate } = await import('../lib/booking/horizon')

  const owner = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })
  const tag = randomBytes(3).toString('hex')

  type T = Awaited<ReturnType<typeof makeTenant>>
  async function makeTenant(key: string, tz: string) {
    const slug = `m37qa-${key}-${tag}`
    const t = await owner.query<{ id: string }>(
      `insert into tenants (slug,name,status,timezone,industry) values ($1,'M37 QA','active',$2,'recording_studio') returning id`,
      [slug, tz],
    )
    const tenantId = t.rows[0].id
    const b = await owner.query<{ id: string }>(
      `insert into branches (tenant_id,name,is_primary,status) values ($1,'Main',true,'active') returning id`,
      [tenantId],
    )
    const branchId = b.rows[0].id
    for (let dow = 0; dow <= 6; dow++) {
      await owner.query(
        `insert into working_hours (tenant_id,branch_id,day_of_week,open_time,close_time,is_closed) values ($1,$2,$3,'09:00','22:00',false)`,
        [tenantId, branchId, dow],
      )
    }
    const rt = await owner.query<{ id: string }>(
      `insert into resource_types (tenant_id,name,hourly_rate,weekend_rate) values ($1,'Studio','100.00','150.00') returning id`,
      [tenantId],
    )
    const r = await owner.query<{ id: string }>(
      `insert into resources (tenant_id,branch_id,resource_type_id,name,status) values ($1,$2,$3,'Set A','available') returning id`,
      [tenantId, branchId, rt.rows[0].id],
    )
    const hourly = await owner.query<{ id: string }>(
      `insert into resource_setups (tenant_id,resource_id,name,rate,rate_unit,is_active) values ($1,$2,'Kitchen','800.00','hour',true) returning id`,
      [tenantId, r.rows[0].id],
    )
    const daily = await owner.query<{ id: string }>(
      `insert into resource_setups (tenant_id,resource_id,name,rate,rate_unit,is_active) values ($1,$2,'Royal','6000.00','day',true) returning id`,
      [tenantId, r.rows[0].id],
    )
    await seedRazorpay((q, p) => owner.query(q, p), tenantId, 'optional_full')
    // staff: a manager and a cashier with real sessions
    const sessions: Record<string, { token: string; userId: string; membershipId: string }> = {}
    for (const role of ['manager', 'cashier']) {
      const u = await owner.query<{ id: string }>(
        `insert into users (email,password_hash,full_name) values ($1,'x',$2) returning id`,
        [`${role}-${key}-${tag}@example.test`, role],
      )
      const token = randomBytes(32).toString('hex')
      await owner.query(`insert into sessions (id, user_id, expires_at) values ($1,$2, now() + interval '1 day')`, [
        createHash('sha256').update(token).digest('hex'),
        u.rows[0].id,
      ])
      const m = await owner.query<{ id: string }>(
        `insert into memberships (tenant_id,user_id,branch_id,role,status,full_name) values ($1,$2,$3,$4::member_role,'active',$5) returning id`,
        [tenantId, u.rows[0].id, branchId, role, role],
      )
      sessions[role] = { token, userId: u.rows[0].id, membershipId: m.rows[0].id }
    }
    return {
      slug, tz, tenantId, branchId,
      typeId: rt.rows[0].id,
      resourceId: r.rows[0].id,
      hourlySetupId: hourly.rows[0].id,
      daySetupId: daily.rows[0].id,
      sessions,
    }
  }

  const IST_T = await makeTenant('ist', 'Asia/Kolkata')
  const NY_T = await makeTenant('ny', 'America/New_York')

  // ── helpers ────────────────────────────────────────────────────────────────
  let ipSeq = 0
  /** Every action call gets a fresh caller IP so the (in-memory) rate limiters never interfere. */
  const as = (T: T, who: 'public' | 'manager' | 'cashier') => {
    ipSeq++
    g.__ARENA_TEST_HEADERS = { 'x-tenant-slug': T.slug, 'x-forwarded-for': `10.${(ipSeq >> 16) & 255}.${(ipSeq >> 8) & 255}.${ipSeq & 255}` }
    g.__ARENA_TEST_SESSION = who === 'public' ? undefined : T.sessions[who].token
  }
  const setWindow = async (T: T, days: number | null) => {
    await owner.query('delete from booking_settings where tenant_id=$1', [T.tenantId])
    if (days !== null) await owner.query('insert into booking_settings (tenant_id,max_advance_days) values ($1,$2)', [T.tenantId, days])
  }
  const wipe = async (T: T) => {
    for (const q of ['delete from payment_intents where tenant_id=$1', 'delete from booking_slots where tenant_id=$1', 'delete from bookings where tenant_id=$1'])
      await owner.query(q, [T.tenantId]).catch(() => undefined)
  }
  const at = (T: T, d: string, hhmm: string) => zonedTimeToUtc(d, hhmm, T.tz)
  const plus = (d: Date, m: number) => new Date(d.getTime() + m * 60_000)
  let phoneSeq = 0
  const phone = () => `98${String(70000000 + ++phoneSeq + Math.floor(Math.random() * 1000) * 1000).slice(0, 8)}`
  const horizonRefusal = (e: string | undefined) => !!e && /can only be made up to/.test(e)
  const hours = { openTime: '09:00', closeTime: '22:00', isClosed: false, open24h: false }

  // ══ 1. default unchanged ═════════════════════════════════════════════════
  console.log('\n── default (no row) = 7 days; existing bookings untouched ──')
  {
    const T = IST_T
    await setWindow(T, null)
    await wipe(T)
    const today = todayInZone(T.tz)
    // A booking made earlier, far out, while the window was wide.
    await setWindow(T, 180)
    as(T, 'manager')
    const far = addDays(today, 100)
    const made = await staffBook.createBooking({
      branchId: T.branchId, customerName: 'Far', customerPhone: phone(),
      slots: [{ resourceId: T.resourceId, startsAt: at(T, far, '12:00').toISOString(), endsAt: at(T, far, '13:00').toISOString() }],
    } as never)
    check('a booking 100 days out is accepted under a 180-day window', !made.error && !!made.bookingId, made)
    await setWindow(T, null)
    const rows = await owner.query(`select status from bookings where tenant_id=$1`, [T.tenantId])
    check('after the window returns to the default 7, that booking is untouched', rows.rows.length === 1 && rows.rows[0].status === 'confirmed')
    as(T, 'public')
    const last = addDays(today, 6)
    const a1 = await pub.getPublicResourceAvailability({ resourceId: T.resourceId, date: last, durationMinutes: 60 })
    const a2 = await pub.getPublicResourceAvailability({ resourceId: T.resourceId, date: addDays(today, 7), durationMinutes: 60 })
    check('default: availability for today+6 works, today+7 is refused', !('error' in a1) && 'error' in a2 && horizonRefusal(a2.error), { a1: 'error' in a1 ? a1.error : 'ok', a2 })
    await wipe(T)
  }

  // ══ 2. each preset through the real actions ══════════════════════════════
  for (const n of [7, 30, 90, 180]) {
    console.log(`\n── preset ${n} days (+05:30), public and staff through the real actions ──`)
    const T = IST_T
    await setWindow(T, n)
    const today = todayInZone(T.tz)
    const last = lastBookableDate(today, n)
    const next = addDays(last, 1)

    for (const who of ['public', 'manager'] as const) {
      await wipe(T)
      // availability
      as(T, who)
      const availLast = who === 'public'
        ? await pub.getPublicResourceAvailability({ resourceId: T.resourceId, date: last, durationMinutes: 60 })
        : await staffAvail.getAvailableStarts({ branchId: T.branchId, resourceId: T.resourceId, date: last, durationMinutes: 60 })
      as(T, who)
      const availNext = who === 'public'
        ? await pub.getPublicResourceAvailability({ resourceId: T.resourceId, date: next, durationMinutes: 60 })
        : await staffAvail.getAvailableStarts({ branchId: T.branchId, resourceId: T.resourceId, date: next, durationMinutes: 60 })
      check(`${who} availability: ${last} ok, ${next} refused`, !('error' in availLast && availLast.error) && horizonRefusal((availNext as { error?: string }).error), { availLast: (availLast as { error?: string }).error, availNext })

      // type-level availability
      as(T, who)
      const tLast = who === 'public'
        ? await pub.getPublicAvailability({ resourceTypeId: T.typeId, date: last, durationMinutes: 60 })
        : await staffAvail.getAvailableStartsForType({ branchId: T.branchId, resourceTypeId: T.typeId, date: last, durationMinutes: 60 })
      as(T, who)
      const tNext = who === 'public'
        ? await pub.getPublicAvailability({ resourceTypeId: T.typeId, date: next, durationMinutes: 60 })
        : await staffAvail.getAvailableStartsForType({ branchId: T.branchId, resourceTypeId: T.typeId, date: next, durationMinutes: 60 })
      check(`${who} type availability: ${last} ok, ${next} refused`, !tLast.error && horizonRefusal(tNext.error), { tLast: tLast.error, tNext: tNext.error })

      // quote
      const slot = (d: string) => ({ startsAt: at(T, d, '12:00').toISOString(), endsAt: at(T, d, '13:00').toISOString() })
      as(T, who)
      const qLast = who === 'public'
        ? await pub.getPublicBookingQuote({ resourceId: T.resourceId, ...slot(last) })
        : await staffBook.quoteBooking({ branchId: T.branchId, resourceId: T.resourceId, ...slot(last) })
      as(T, who)
      const qNext = who === 'public'
        ? await pub.getPublicBookingQuote({ resourceId: T.resourceId, ...slot(next) })
        : await staffBook.quoteBooking({ branchId: T.branchId, resourceId: T.resourceId, ...slot(next) })
      check(`${who} quote: ${last} priced, ${next} refused`, qLast.total !== undefined && horizonRefusal(qNext.error), { qLast, qNext })

      // create: next day refused first (nothing to clean), then the last day accepted
      as(T, who)
      const cNext = who === 'public'
        ? await pub.createPublicBooking({ resourceId: T.resourceId, ...slot(next), customerName: 'QA', customerPhone: phone() })
        : await staffBook.createBooking({ branchId: T.branchId, customerName: 'QA', customerPhone: phone(), slots: [{ resourceId: T.resourceId, ...slot(next) }] } as never)
      check(`${who} create: the day after the last bookable date is refused`, horizonRefusal(cNext.error), cNext)
      as(T, who)
      const cLast = who === 'public'
        ? await pub.createPublicBooking({ resourceId: T.resourceId, ...slot(last), customerName: 'QA', customerPhone: phone() })
        : await staffBook.createBooking({ branchId: T.branchId, customerName: 'QA', customerPhone: phone(), slots: [{ resourceId: T.resourceId, ...slot(last) }] } as never)
      check(`${who} create: exactly the last bookable date is accepted`, !cLast.error && !!(cLast as { bookingId?: string }).bookingId, cLast)

      // day-range: ends on last ok, ends next refused, 32 days refused
      await wipe(T)
      const startR = n >= 30 ? addDays(last, -4) : today
      as(T, who)
      const dOk = who === 'public'
        ? await pub.getPublicBookingDayRange({ resourceId: T.resourceId, startDate: startR, endDate: last })
        : await staffAvail.getDayRangeWindow({ branchId: T.branchId, resourceId: T.resourceId, startDate: startR, endDate: last })
      as(T, who)
      const dBad = who === 'public'
        ? await pub.getPublicBookingDayRange({ resourceId: T.resourceId, startDate: startR, endDate: next })
        : await staffAvail.getDayRangeWindow({ branchId: T.branchId, resourceId: T.resourceId, startDate: startR, endDate: next })
      check(`${who} day-range: ending ${last} ok, ending ${next} refused`, !dOk.error && !!dOk.startsAt && horizonRefusal(dBad.error), { dOk, dBad })
      if (n >= 90) {
        as(T, who)
        const d31 = who === 'public'
          ? await pub.getPublicBookingDayRange({ resourceId: T.resourceId, startDate: addDays(today, 5), endDate: addDays(today, 35) })
          : await staffAvail.getDayRangeWindow({ branchId: T.branchId, resourceId: T.resourceId, startDate: addDays(today, 5), endDate: addDays(today, 35) })
        as(T, who)
        const d32 = who === 'public'
          ? await pub.getPublicBookingDayRange({ resourceId: T.resourceId, startDate: addDays(today, 5), endDate: addDays(today, 36) })
          : await staffAvail.getDayRangeWindow({ branchId: T.branchId, resourceId: T.resourceId, startDate: addDays(today, 5), endDate: addDays(today, 36) })
        check(`${who} day-range: 31 days accepted, 32 refused`, !d31.error && /at most 31/.test(d32.error ?? ''), { d31, d32 })
      }
    }
    await wipe(T)
  }

  // ══ 3. boundaries: month end, year end, leap day, DST ════════════════════
  console.log('\n── boundaries with a pinned clock (window 30; last bookable date = D) ──')
  {
    const cases: [string, 'ist' | 'ny', string][] = [
      ['month end', 'ist', '2045-04-30'],
      ['year end', 'ist', '2045-12-31'],
      ['year end (behind UTC)', 'ny', '2045-12-31'],
      ['leap day', 'ny', '2048-02-29'],
      ['day after leap day', 'ist', '2048-03-01'],
      ['DST start day (NY)', 'ny', '2045-03-12'],
      ['day after DST start (NY)', 'ny', '2045-03-13'],
      ['DST end day (NY)', 'ny', '2045-11-05'],
    ]
    for (const [label, key, D] of cases) {
      const T = key === 'ist' ? IST_T : NY_T
      await setWindow(T, 30)
      // pin "now" so the tenant-local today is D - 29 (noon UTC is the same calendar day in both zones)
      process.env.ARENA_TEST_NOW = `${addDays(D, -29)}T12:00:00Z`
      const ctx = { tenantId: T.tenantId, timezone: T.tz, membershipId: T.sessions.manager.membershipId }
      const tryCreate = async (start: Date, end: Date) => {
        await wipe(T)
        try {
          await withUser(T.sessions.manager.userId, (tx) =>
            createBookingCore(tx as never, ctx, {
              branchId: T.branchId, customerName: 'B', customerPhone: phone(), source: 'walk_in', discount: 0, deposit: 0,
              slots: [{ resourceId: T.resourceId, startsAt: start.toISOString(), endsAt: end.toISOString() }],
            } as never),
          )
          return 'ok'
        } catch (e) {
          return e instanceof Error && /can only be made up to/.test(e.message) ? 'horizon' : (e instanceof Error ? e.message : 'error')
        }
      }
      const r1 = await tryCreate(at(T, D, '00:00'), at(T, D, '01:00'))
      const r2 = await tryCreate(at(T, D, '23:00'), at(T, addDays(D, 1), '01:00'))
      const r3 = await tryCreate(at(T, addDays(D, 1), '00:00'), at(T, addDays(D, 1), '01:00'))
      const lastInstantBefore = new Date(at(T, addDays(D, 1), '00:00').getTime() - 1000)
      const r4 = await tryCreate(new Date(lastInstantBefore.getTime() - 30 * 60_000), lastInstantBefore)
      check(`${label} (${T.tz}, last=${D}): 00:00 local on the last day is accepted`, r1 === 'ok', r1)
      check(`${label}: a slot starting 23:00 on the last day and ending 01:00 after midnight is accepted (judged by start)`, r2 === 'ok', r2)
      check(`${label}: 00:00 local on the next day is refused`, r3 === 'horizon', r3)
      check(`${label}: the last second before that midnight is accepted`, r4 === 'ok', r4)
    }
    delete process.env.ARENA_TEST_NOW
    // a 180-day window straddling the NY DST change: today 2045-02-01, last = 2045-07-30
    const T = NY_T
    await setWindow(T, 180)
    process.env.ARENA_TEST_NOW = '2045-02-01T17:00:00Z'
    const ctx = { tenantId: T.tenantId, timezone: T.tz, membershipId: T.sessions.manager.membershipId }
    const tryAt = async (d: string, hhmm: string) => {
      await wipe(T)
      try {
        await withUser(T.sessions.manager.userId, (tx) =>
          createBookingCore(tx as never, ctx, {
            branchId: T.branchId, customerName: 'B', customerPhone: phone(), source: 'walk_in', discount: 0, deposit: 0,
            slots: [{ resourceId: T.resourceId, startsAt: at(T, d, hhmm).toISOString(), endsAt: plus(at(T, d, hhmm), 60).toISOString() }],
          } as never),
        )
        return 'ok'
      } catch (e) {
        return e instanceof Error && /can only be made up to/.test(e.message) ? 'horizon' : 'error'
      }
    }
    check('180-day window across DST: last bookable date (2045-07-30) accepted', (await tryAt('2045-07-30', '23:00')) === 'ok')
    check('…and 2045-07-31 refused', (await tryAt('2045-07-31', '00:00')) === 'horizon')
    check('…a date after the spring-forward (2045-03-20) is inside it', (await tryAt('2045-03-20', '12:00')) === 'ok')
    delete process.env.ARENA_TEST_NOW
  }

  // ══ 4. setting changes ═══════════════════════════════════════════════════
  console.log('\n── raising and lowering the window ──')
  {
    const T = IST_T
    await wipe(T)
    await setWindow(T, null)
    const today = todayInZone(T.tz)
    const d60 = addDays(today, 60)
    const slot = (d: string) => ({ startsAt: at(T, d, '12:00').toISOString(), endsAt: at(T, d, '13:00').toISOString() })
    as(T, 'public')
    const before = await pub.getPublicBookingQuote({ resourceId: T.resourceId, ...slot(d60) })
    check('7 days: a date 60 days out is not available', horizonRefusal(before.error), before)
    await withUser(T.sessions.manager.userId, (tx) =>
      applyBookingWindow(tx as never, { tenantId: T.tenantId, membershipId: T.sessions.manager.membershipId }, 90))
    as(T, 'public')
    const after = await pub.getPublicBookingQuote({ resourceId: T.resourceId, ...slot(d60) })
    check('raised to 90: the same date now quotes (no stale window)', after.total !== undefined, after)
    as(T, 'public')
    const booked = await pub.createPublicBooking({ resourceId: T.resourceId, ...slot(d60), customerName: 'QA', customerPhone: phone() })
    check('…and books', !!(booked as { bookingId?: string }).bookingId, booked)
    await withUser(T.sessions.manager.userId, (tx) =>
      applyBookingWindow(tx as never, { tenantId: T.tenantId, membershipId: T.sessions.manager.membershipId }, 7))
    as(T, 'public')
    const lowered = await pub.getPublicBookingQuote({ resourceId: T.resourceId, ...slot(d60) })
    check('lowered to 7: new dates close again', horizonRefusal(lowered.error), lowered)
    const row = await owner.query(`select id, status from bookings where id=$1`, [(booked as { bookingId?: string }).bookingId])
    check('…the far booking made earlier is still there, confirmed', row.rows.length === 1 && row.rows[0].status === 'confirmed')
    as(T, 'manager')
    const cancelled = await staffBook.cancelBooking(row.rows[0].id, 'qa')
    const after2 = await owner.query(`select status from bookings where id=$1`, [row.rows[0].id])
    check('…and staff can still cancel it (the window never blocks existing bookings)', !cancelled.error && after2.rows[0].status === 'cancelled', cancelled)
    const audit = await owner.query(
      `select before, after from audit_log where tenant_id=$1 and action='booking_settings.max_advance_days_changed' order by created_at`,
      [T.tenantId],
    )
    check('both changes were audited (7 -> 90, 90 -> 7)', audit.rows.length === 2 && audit.rows[0].after?.maxAdvanceDays === 90 && audit.rows[1].after?.maxAdvanceDays === 7, audit.rows)
  }

  // ══ 5. interplay: prices, holds, advance, per-day exclusivity ════════════
  console.log('\n── far-future bookings: pricing, hold + advance, exclusivity ──')
  {
    const T = IST_T
    await wipe(T)
    await setWindow(T, 180)
    const today = todayInZone(T.tz)
    // a weekday and a Saturday ~2 months out
    let wk = addDays(today, 60)
    while (new Date(`${wk}T12:00:00Z`).getUTCDay() === 0 || new Date(`${wk}T12:00:00Z`).getUTCDay() === 6) wk = addDays(wk, 1)
    let sat = addDays(today, 61)
    while (new Date(`${sat}T12:00:00Z`).getUTCDay() !== 6) sat = addDays(sat, 1)
    const hol = addDays(wk, 7) // same weekday a week later, with a holiday rate
    await owner.query(`delete from holiday_rates where tenant_id=$1`, [T.tenantId])
    await owner.query(`insert into holiday_rates (tenant_id,resource_type_id,date,rate) values ($1,$2,$3,'999.00')`, [T.tenantId, T.typeId, hol])
    const slot = (d: string, h = 1) => ({ startsAt: at(T, d, '12:00').toISOString(), endsAt: plus(at(T, d, '12:00'), 60 * h).toISOString() })
    const quote = async (d: string, extra: Record<string, unknown> = {}) => {
      as(T, 'public')
      return pub.getPublicBookingQuote({ resourceId: T.resourceId, ...slot(d), ...extra } as never)
    }
    check(`weekday ${wk} (60 days out) bills the weekday rate 100`, (await quote(wk)).slotTotal === 100)
    check(`Saturday ${sat} bills the weekend rate 150`, (await quote(sat)).slotTotal === 150)
    check(`holiday ${hol} bills the holiday rate 999, not the weekday rate`, (await quote(hol)).slotTotal === 999)
    check(`hourly setup on a far date bills the setup rate (800)`, (await quote(wk, { setupId: T.hourlySetupId })).slotTotal === 800)

    // M36: pay-now with an advance policy on a far date
    await seedRazorpay((q, p) => owner.query(q, p), T.tenantId, 'advance', { type: 'percent', value: 40 })
    as(T, 'public')
    const paid = await pub.createPublicBooking({ resourceId: T.resourceId, ...slot(wk), customerName: 'Pay', customerPhone: phone(), payNow: true })
    const pid = (paid as { bookingId?: string }).bookingId
    check('far-future pay-online booking is created awaiting payment', !!pid && (paid as { awaitingOnlinePayment?: boolean }).awaitingOnlinePayment === true, paid)
    if (pid) {
      const row = await owner.query(`select status, deposit, total, payment_hold_expires_at from bookings where id=$1`, [pid])
      const b = row.rows[0]
      check('…held as pending_payment with an expiry (M36)', b.status === 'pending_payment' && b.payment_hold_expires_at !== null, b)
      check('…and the advance is 40% of the far-date total', Math.abs(Number(b.deposit) - Number(b.total) * 0.4) < 0.011, b)
    }
    await seedRazorpay((q, p) => owner.query(q, p), T.tenantId, 'optional_full')
    await wipe(T)

    // per-day setup: price and exclusivity, 100 days out
    const dStart = addDays(today, 100)
    const dEnd = addDays(dStart, 2)
    const win = { start: dayWindow(dStart, T.tz, hours).open, end: dayWindow(dEnd, T.tz, hours).close }
    as(T, 'public')
    const q3 = await pub.getPublicBookingQuote({ resourceId: T.resourceId, startsAt: win.start.toISOString(), endsAt: win.end.toISOString(), setupId: T.daySetupId })
    check('a 3-day Royal booking 100 days out quotes 3 x 6000', q3.slotTotal === 18000, q3)
    as(T, 'public')
    const first = await pub.createPublicBooking({ resourceId: T.resourceId, startsAt: win.start.toISOString(), endsAt: win.end.toISOString(), setupId: T.daySetupId, customerName: 'D', customerPhone: phone() })
    check('…and books', !!(first as { bookingId?: string }).bookingId, first)
    as(T, 'public')
    const range2 = await pub.getPublicBookingDayRange({ resourceId: T.resourceId, startDate: addDays(dStart, 1), endDate: addDays(dStart, 3) })
    check('an overlapping range reports a conflict (exclusivity unchanged)', range2.conflict === true, range2)
    as(T, 'public')
    const second = await pub.createPublicBooking({ resourceId: T.resourceId, startsAt: dayWindow(addDays(dStart, 1), T.tz, hours).open.toISOString(), endsAt: dayWindow(addDays(dStart, 3), T.tz, hours).close.toISOString(), setupId: T.daySetupId, customerName: 'D2', customerPhone: phone() })
    check('…and an overlapping create is refused by the database, not the window', !!second.error && !horizonRefusal(second.error) && !(second as { bookingId?: string }).bookingId, second)
    as(T, 'public')
    const shifted = await pub.createPublicBooking({ resourceId: T.resourceId, startsAt: dayWindow(addDays(dStart, 1), T.tz, hours).open.toISOString(), endsAt: new Date(dayWindow(addDays(dStart, 3), T.tz, hours).close.getTime() - 3600_000).toISOString(), setupId: T.daySetupId, customerName: 'D3', customerPhone: phone() })
    check('a crafted day-range that is not the whole-day window is still refused', !!shifted.error && !(shifted as { bookingId?: string }).bookingId, shifted)
    await wipe(T)
  }

  // ══ 6. not affected ══════════════════════════════════════════════════════
  console.log('\n── flows that must not gain the horizon ──')
  {
    const T = IST_T
    await setWindow(T, 1) // the tightest window
    await wipe(T)
    const today = todayInZone(T.tz)
    // walk-in start-now (own core), through the real action
    as(T, 'manager')
    const w = await staffBook.startWalkin({
      branchId: T.branchId, resourceId: T.resourceId, phone: '9876501234', name: 'Walk', startAt: new Date().toISOString(), mode: 'open_tab',
    } as never)
    check('walk-in start-now works under a 1-day window', !w.error && !!w.bookingId, w)
    await wipe(T)
    // backdated entry
    const yesterday = addDays(today, -1)
    const { recordBackdatedBooking } = await import('../lib/actions/backdated-bookings')
    as(T, 'manager')
    const bd = await recordBackdatedBooking({
      branchId: T.branchId, customerName: 'Late', customerPhone: phone(),
      slots: [{ resourceId: T.resourceId, startsAt: at(T, yesterday, '10:00').toISOString(), endsAt: at(T, yesterday, '11:00').toISOString() }],
      amountCollected: 100, paymentMethod: 'cash',
    } as never)
    check('backdated entry works under a 1-day window', !bd.error && !!bd.bookingId, bd)
    await wipe(T)
  }

  // ══ 7. performance (static) ══════════════════════════════════════════════
  console.log('\n── performance ──')
  {
    const pages = ['app/(public)/book/[resourceId]/page.tsx', 'app/(public)/book-type/[resourceTypeId]/page.tsx', 'app/(app)/bookings/new/page.tsx']
    for (const p of pages) {
      const src = readFileSync(p, 'utf8')
      const reads = (src.match(/(publicMaxAdvanceDaysOrDefault|maxAdvanceDaysOrDefault)\(/g) ?? []).length
      check(`${p}: reads the setting exactly once per load`, reads === 1, reads)
    }
    const picker = readFileSync('components/ui/DatePicker.tsx', 'utf8')
    check('the picker makes no network or action calls (availability stays one call per selection, from the page)', !/lib\/actions|fetch\(|getPublic/.test(picker))
    const resPage = readFileSync('components/public-booking/ResourceBookingPage.tsx', 'utf8')
    check('the page fetches availability in one effect keyed on the selected date', /getPublicResourceAvailability\(\{ resourceId: resource\.id, date, durationMinutes: duration \}\)/.test(resPage))
  }

  await wipe(IST_T)
  await wipe(NY_T)
  await owner.end()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
