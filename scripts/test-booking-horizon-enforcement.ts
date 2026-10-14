/**
 * M37 #2 — the advance-booking horizon is enforced SERVER-SIDE, against a real
 * database and as a non-owner DB role (staff via withUser, the storefront via
 * withPublicTenant). Drives the same createBookingCore both create paths use.
 *
 *   1. default window (no row = 7): last bookable date accepted, the day after
 *      refused, for staff AND for the anonymous storefront
 *   2. configured windows 30 / 90 / 180: same boundary
 *   3. timezones: a tenant at +05:30 and one behind UTC — 23:59 local on the
 *      last day accepted, 00:00 local the day after refused; a slot starting on
 *      the last day and running past midnight is accepted (judged by its start)
 *   4. the quote refuses what create refuses (assertWithinAdvanceWindow)
 *   5. day-rate range: 31 days accepted, 32 refused, end beyond the window refused
 *   6. regressions: backdated entry is not judged by the window; shrinking the
 *      window leaves an existing far-future booking, which can still be cancelled
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs --import ./scripts/next-runtime-hook.mjs scripts/test-booking-horizon-enforcement.ts
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

const IST = 'Asia/Kolkata'
const NY = 'America/New_York'

async function main() {
  loadEnv()
  const { createBookingCore, assertWithinAdvanceWindow, priceBookingSlots, BookingError } = await import('../lib/booking/service')
  const { recordBackdatedBookingCore } = await import('../lib/booking/backdated')
  const { withUser, withPublicTenant } = await import('../db')
  const { addDays, todayInZone, zonedTimeToUtc } = await import('../lib/booking/time')
  const { dayWindow } = await import('../lib/booking/availability')

  const owner = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })

  async function makeTenant(slug: string, tz: string) {
    const t = await owner.query<{ id: string }>(
      `insert into tenants (slug,name,status,timezone,industry) values ($1,$2,'active',$3,'gaming_cafe')
       on conflict (slug) do update set name=excluded.name, timezone=excluded.timezone returning id`,
      [slug, `${slug} co`, tz],
    )
    const tenantId = t.rows[0].id
    const b = await owner.query<{ id: string }>(
      `insert into branches (tenant_id,name,is_primary) values ($1,'Main',true)
       on conflict (tenant_id,name) do update set is_primary=true returning id`,
      [tenantId],
    )
    const u = await owner.query<{ id: string }>(
      `insert into users (email,password_hash) values ($1,'x')
       on conflict (email) do update set email=excluded.email returning id`,
      [`manager@${slug}.test`],
    )
    const m = await owner.query<{ id: string }>(
      `insert into memberships (tenant_id,user_id,role,status) values ($1,$2,'manager','active')
       on conflict (tenant_id,user_id) do update set role='manager', status='active' returning id`,
      [tenantId, u.rows[0].id],
    )
    for (const q of [
      'delete from audit_log where tenant_id=$1',
      'delete from payments where tenant_id=$1',
      'delete from invoices where tenant_id=$1',
      'delete from booking_slots where tenant_id=$1',
      'delete from bookings where tenant_id=$1',
      'delete from booking_settings where tenant_id=$1',
      'delete from sequences where tenant_id=$1',
    ])
      await owner.query(q, [tenantId])
    const rt = await owner.query<{ id: string }>(
      `insert into resource_types (tenant_id,name,hourly_rate) values ($1,'Console','100.00')
       on conflict (tenant_id,name) do update set hourly_rate=excluded.hourly_rate returning id`,
      [tenantId],
    )
    const res = await owner.query<{ id: string }>(
      `insert into resources (tenant_id,branch_id,resource_type_id,name,status) values ($1,$2,$3,$4,'available')
       on conflict (tenant_id,name) do update set status='available' returning id`,
      [tenantId, b.rows[0].id, rt.rows[0].id, `${slug}-R1`],
    )
    const setup = await owner.query<{ id: string }>(
      `insert into resource_setups (tenant_id,resource_id,name,rate,rate_unit) values ($1,$2,'Day pass','1000.00','day')
       on conflict (resource_id,name) do update set rate='1000.00', rate_unit='day', is_active=true returning id`,
      [tenantId, res.rows[0].id],
    )
    return {
      tenantId,
      tz,
      branchId: b.rows[0].id,
      userId: u.rows[0].id,
      membershipId: m.rows[0].id,
      resourceId: res.rows[0].id,
      setupId: setup.rows[0].id,
    }
  }
  type Tenant = Awaited<ReturnType<typeof makeTenant>>

  const setWindow = async (T: Tenant, days: number | null) => {
    await owner.query('delete from booking_settings where tenant_id=$1', [T.tenantId])
    if (days !== null)
      await owner.query('insert into booking_settings (tenant_id,max_advance_days) values ($1,$2)', [T.tenantId, days])
  }
  const wipeBookings = async (T: Tenant) => {
    await owner.query('delete from booking_slots where tenant_id=$1', [T.tenantId])
    await owner.query('delete from bookings where tenant_id=$1', [T.tenantId])
  }

  type Who = 'staff' | 'public'
  let seq = 0
  /** Try to create one hourly slot; true if accepted, false if refused with the horizon error. */
  async function tryCreate(T: Tenant, who: Who, start: Date, end: Date, extra: Record<string, unknown> = {}) {
    seq++
    const input = {
      branchId: T.branchId,
      customerName: 'Horizon',
      customerPhone: `98765${String(10000 + seq).slice(-5)}`,
      source: who === 'staff' ? ('staff' as const) : ('online' as const),
      discount: 0,
      deposit: 0,
      slots: [{ resourceId: T.resourceId, startsAt: start.toISOString(), endsAt: end.toISOString(), ...extra }],
    }
    const ctx = { tenantId: T.tenantId, timezone: T.tz, membershipId: who === 'staff' ? T.membershipId : null }
    try {
      if (who === 'staff') await withUser(T.userId, (tx) => createBookingCore(tx as never, ctx, input as never))
      else await withPublicTenant(T.tenantId, (tx) => createBookingCore(tx as never, ctx, input as never))
      return { ok: true as const }
    } catch (e) {
      return { ok: false as const, horizon: e instanceof BookingError && /can only be made up to/.test(e.message), msg: e instanceof Error ? e.message : '' }
    }
  }
  const at = (T: Tenant, day: string, hhmm: string) => zonedTimeToUtc(day, hhmm, T.tz)
  const plus = (d: Date, mins: number) => new Date(d.getTime() + mins * 60_000)

  const IST_T = await makeTenant('testhz-ist', IST)
  const NY_T = await makeTenant('testhz-ny', NY)

  // ══ 1 + 2. boundary for every window, both identities ═════════════════════
  for (const [label, days] of [['default (no row)', null], ['7', 7], ['30', 30], ['90', 90], ['180', 180]] as const) {
    console.log(`\n── window ${label} ──`)
    const T = IST_T
    const n = days ?? 7
    await setWindow(T, days)
    const today = todayInZone(T.tz)
    const last = addDays(today, n - 1)
    for (const who of ['staff', 'public'] as const) {
      await wipeBookings(T)
      const okLast = await tryCreate(T, who, at(T, last, '12:00'), at(T, last, '13:00'))
      check(`${who}: exactly the last bookable date (${last}) is accepted`, okLast.ok, okLast)
      const dayAfter = await tryCreate(T, who, at(T, addDays(last, 1), '12:00'), at(T, addDays(last, 1), '13:00'))
      check(`${who}: the day after is refused with the horizon message`, !dayAfter.ok && dayAfter.horizon, dayAfter)
      const crafted = await tryCreate(T, who, at(T, addDays(today, 400), '12:00'), at(T, addDays(today, 400), '13:00'))
      check(`${who}: a crafted date 400 days out is refused`, !crafted.ok && crafted.horizon, crafted)
      const todayOk = await tryCreate(T, who, plus(new Date(), 60), plus(new Date(), 120))
      check(`${who}: a booking later today is accepted`, todayOk.ok || !('horizon' in todayOk && todayOk.horizon), todayOk)
    }
  }

  // ══ 3. timezones near local midnight ═════════════════════════════════════
  for (const T of [IST_T, NY_T]) {
    console.log(`\n── ${T.tz}: local midnight on the last day (window 7) ──`)
    await setWindow(T, 7)
    const today = todayInZone(T.tz)
    const last = addDays(today, 6)
    for (const who of ['staff', 'public'] as const) {
      await wipeBookings(T)
      const lateOk = await tryCreate(T, who, at(T, last, '23:30'), at(T, last, '23:59'))
      check(`${who}: 23:30 local on the last day is accepted`, lateOk.ok, lateOk)
      await wipeBookings(T)
      const overnight = await tryCreate(T, who, at(T, last, '23:00'), at(T, addDays(last, 1), '01:00'))
      check(`${who}: a slot starting on the last day and running past midnight is accepted (judged by start)`, overnight.ok, overnight)
      const midnight = await tryCreate(T, who, at(T, addDays(last, 1), '00:00'), at(T, addDays(last, 1), '01:00'))
      check(`${who}: 00:00 local the day after is refused`, !midnight.ok && midnight.horizon, midnight)
    }
  }

  // ══ 4. the quote refuses what create refuses ═════════════════════════════
  console.log('\n── quote parity ──')
  {
    const T = IST_T
    await setWindow(T, 7)
    const today = todayInZone(T.tz)
    const quote = async (day: string) => {
      try {
        await withPublicTenant(T.tenantId, async (tx) => {
          const priced = await priceBookingSlots(tx as never, { tenantId: T.tenantId, timezone: T.tz }, {
            branchId: T.branchId,
            slots: [{ resourceId: T.resourceId, startsAt: at(T, day, '12:00').toISOString(), endsAt: at(T, day, '13:00').toISOString() }],
          } as never)
          await assertWithinAdvanceWindow(tx as never, { tenantId: T.tenantId, timezone: T.tz }, priced.slots)
        })
        return true
      } catch {
        return false
      }
    }
    check('quote for the last bookable date succeeds', await quote(addDays(today, 6)))
    check('quote for the day after is refused', !(await quote(addDays(today, 7))))
  }

  // ══ 5. day-rate ranges ═══════════════════════════════════════════════════
  console.log('\n── day-rate ranges ──')
  {
    const T = IST_T
    const today = todayInZone(T.tz)
    const hours = { openTime: '10:00', closeTime: '22:00', isClosed: false, open24h: false }
    const range = (from: string, to: string) => ({
      start: dayWindow(from, T.tz, hours).open,
      end: dayWindow(to, T.tz, hours).close,
    })
    for (const who of ['staff', 'public'] as const) {
      await setWindow(T, 180)
      await wipeBookings(T)
      const r31 = range(addDays(today, 10), addDays(today, 40))
      const ok31 = await tryCreate(T, who, r31.start, r31.end, { setupId: T.setupId })
      check(`${who}: a 31-day range is accepted`, ok31.ok, ok31)
      await wipeBookings(T)
      const r32 = range(addDays(today, 10), addDays(today, 41))
      const bad32 = await tryCreate(T, who, r32.start, r32.end, { setupId: T.setupId })
      check(`${who}: a 32-day range is refused`, !bad32.ok && /at most 31 days/.test(bad32.msg), bad32)

      await setWindow(T, 30)
      await wipeBookings(T)
      const rEdge = range(addDays(today, 25), addDays(today, 29))
      const okEdge = await tryCreate(T, who, rEdge.start, rEdge.end, { setupId: T.setupId })
      check(`${who}: a range ending on the last bookable date is accepted`, okEdge.ok, okEdge)
      await wipeBookings(T)
      const rOver = range(addDays(today, 25), addDays(today, 30))
      const bad = await tryCreate(T, who, rOver.start, rOver.end, { setupId: T.setupId })
      check(`${who}: a range ending the day after the last bookable date is refused`, !bad.ok && bad.horizon, bad)
    }
  }

  // ══ 6. regressions ═══════════════════════════════════════════════════════
  console.log('\n── regressions ──')
  {
    const T = IST_T
    await setWindow(T, 7)
    await wipeBookings(T)
    const today = todayInZone(T.tz)
    // Backdated entry (M28): a past booking is never judged by the window, even at 1 day.
    await setWindow(T, 1)
    const yesterday = addDays(today, -1)
    let backdatedOk = true
    try {
      await withUser(T.userId, (tx) =>
        recordBackdatedBookingCore(tx as never, { tenantId: T.tenantId, timezone: T.tz, membershipId: T.membershipId }, {
          branchId: T.branchId,
          customerName: 'Late',
          customerPhone: '9876500777',
          slots: [{ resourceId: T.resourceId, startsAt: at(T, yesterday, '08:00').toISOString(), endsAt: at(T, yesterday, '09:00').toISOString() }],
          amountCollected: 100,
          paymentMethod: 'cash',
        } as never),
      )
    } catch (e) {
      backdatedOk = false
      console.log(e)
    }
    check('backdated entry is unaffected by a 1-day window', backdatedOk)
    await wipeBookings(T)

    // Shrink 180 → 7: an existing far-future booking stays, and can still be cancelled.
    await setWindow(T, 180)
    const far = addDays(today, 120)
    const made = await tryCreate(T, 'staff', at(T, far, '12:00'), at(T, far, '13:00'))
    check('a booking 120 days out is accepted under a 180-day window', made.ok, made)
    await setWindow(T, 7)
    const still = await owner.query(`select id, status from bookings where tenant_id=$1`, [T.tenantId])
    check('after shrinking to 7 the far-future booking is still there, confirmed', still.rows.length === 1 && still.rows[0].status === 'confirmed')
    let cancelled = false
    try {
      await withUser(T.userId, async (tx) => {
        const r = await (tx as never as { execute: (q: unknown) => Promise<{ rowCount: number | null }> }).execute(
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          (await import('drizzle-orm')).sql`update bookings set status='cancelled' where id=${still.rows[0].id}`,
        )
        cancelled = (r.rowCount ?? 0) === 1
      })
    } catch {
      cancelled = false
    }
    const after = await owner.query(`select status from bookings where id=$1`, [still.rows[0].id])
    const slotsActive = await owner.query(`select active from booking_slots where booking_id=$1`, [still.rows[0].id])
    check('…and cancelling it still works, freeing its slot', cancelled && after.rows[0].status === 'cancelled' && slotsActive.rows.every((r) => r.active === false))
  }

  for (const T of [IST_T, NY_T]) {
    await wipeBookings(T)
    await setWindow(T, null)
  }
  await owner.end()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
