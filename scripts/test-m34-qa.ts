/**
 * M34 #5 — QA for the multi-day bookings list, against a real database and as
 * NON-owner DB roles (the app connection is RLS-bound; fixtures use the owner
 * connection only to seed).
 *
 *   1. role matrix   — owner, manager, cashier, receptionist, floor_staff each
 *                      load every preset; never another tenant's or branch's rows
 *   2. boundaries    — for +05:30 and two DST zones, with "today" mocked to
 *                      1 Jan, 29 Feb, 31 May, 31 Dec and both DST change days:
 *                      23:30 local on the last day and 00:30 local on the first
 *                      day are IN; 23:30 the day before and 00:30 the day after
 *                      are OUT, for every preset
 *   3. last year     — previous calendar year, never a rolling 12 months
 *   4. totals        — the list's total / all-slot sum / advance equal the
 *                      timeline's (listDayBookings) for the same bookings,
 *                      including a cancelled one (slots inactive)
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs scripts/test-m34-qa.ts
 */
import { Pool } from 'pg'
import { loadEnv } from './env'
import type { ActiveContext } from '../lib/tenant/context'
import { RANGE_PRESETS, resolveRange, type RangePreset } from '../lib/booking/ranges'
import { addDays, zonedTimeToUtc } from '../lib/booking/time'

let pass = 0,
  fail = 0
const check = (l: string, c: boolean) => {
  console.log(`${c ? '✓' : '✗ FAIL'}  ${l}`)
  if (c) pass++
  else fail++
}

const IST = 'Asia/Kolkata'
const NY = 'America/New_York' // DST: 2nd Sun Mar / 1st Sun Nov
const SYD = 'Australia/Sydney' // southern-hemisphere DST: 1st Sun Oct / 1st Sun Apr
const ROLES = ['owner', 'manager', 'cashier', 'receptionist', 'floor_staff'] as const

async function main() {
  loadEnv()
  const { listRangeBookings, listDayBookings } = await import('../lib/booking/data')
  const owner = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })

  const mkTenant = async (slug: string, tz: string) => {
    const t = await owner.query<{ id: string }>(
      `insert into tenants (slug,name,status,timezone) values ($1,$2,'active',$3)
       on conflict (slug) do update set name=excluded.name, timezone=excluded.timezone returning id`,
      [slug, `${slug} co`, tz],
    )
    const tenantId = t.rows[0].id
    const mkBranch = async (name: string, primary: boolean) =>
      (
        await owner.query<{ id: string }>(
          `insert into branches (tenant_id,name,is_primary) values ($1,$2,$3)
           on conflict (tenant_id,name) do update set is_primary=excluded.is_primary returning id`,
          [tenantId, name, primary],
        )
      ).rows[0].id
    const branchId = await mkBranch('Main', true)
    const branch2Id = await mkBranch('Second', false)
    const rt = await owner.query<{ id: string }>(
      `insert into resource_types (tenant_id,name,hourly_rate) values ($1,'Table','250.00')
       on conflict (tenant_id,name) do update set hourly_rate='250.00' returning id`,
      [tenantId],
    )
    const mkRes = async (b: string, name: string) =>
      (
        await owner.query<{ id: string }>(
          `insert into resources (tenant_id,branch_id,resource_type_id,name,status)
           values ($1,$2,$3,$4,'available')
           on conflict (tenant_id,name) do update set status='available', branch_id=excluded.branch_id
           returning id`,
          [tenantId, b, rt.rows[0].id, name],
        )
      ).rows[0].id
    return {
      tenantId,
      slug,
      tz,
      branchId,
      branch2Id,
      r1: await mkRes(branchId, `${slug}-T1`),
      r2: await mkRes(branchId, `${slug}-T2`),
      rb2: await mkRes(branch2Id, `${slug}-B2-T1`),
    }
  }
  type Tenant = Awaited<ReturnType<typeof mkTenant>>

  const mkUser = async (tenantId: string, slug: string, role: string) => {
    const u = await owner.query<{ id: string }>(
      `insert into users (email,password_hash) values ($1,'x')
       on conflict (email) do update set email=excluded.email returning id`,
      [`${role}@${slug}.test`],
    )
    const m = await owner.query<{ id: string }>(
      `insert into memberships (tenant_id,user_id,role,status) values ($1,$2,$3,'active')
       on conflict (tenant_id,user_id) do update set role=excluded.role, status='active' returning id`,
      [tenantId, u.rows[0].id, role],
    )
    return { id: u.rows[0].id, membershipId: m.rows[0].id }
  }

  const ctxFor = (T: Tenant, u: { id: string; membershipId: string }, role: string): ActiveContext => ({
    user: { id: u.id, email: `${role}@${T.slug}.test`, fullName: null, isPlatformAdmin: false },
    tenant: {
      id: T.tenantId,
      slug: T.slug,
      name: `${T.slug} co`,
      industry: 'gaming',
      status: 'active',
      currency: 'INR',
      timezone: T.tz,
    },
    role: role as ActiveContext['role'],
    membershipId: u.membershipId,
    branchId: T.branchId,
  })

  const tenants = {
    ist: await mkTenant('testm34qa-ist', IST),
    ny: await mkTenant('testm34qa-ny', NY),
    syd: await mkTenant('testm34qa-syd', SYD),
    other: await mkTenant('testm34qa-other', IST),
  }
  const wipe = async (T: Tenant) => {
    await owner.query('delete from booking_slots where tenant_id=$1', [T.tenantId])
    await owner.query('delete from bookings where tenant_id=$1', [T.tenantId])
  }
  for (const T of Object.values(tenants)) await wipe(T)

  async function booking(
    T: Tenant,
    branchId: string,
    name: string,
    status: string,
    slots: { res: string; from: Date; to: Date | null; total?: string }[],
    o: { total?: string; advance?: string } = {},
  ) {
    const bk = await owner.query<{ id: string }>(
      `insert into bookings (tenant_id,branch_id,booking_number,status,customer_name,subtotal,total)
       values ($1,$2,$3,'confirmed',$4,'0',$5) returning id`,
      [T.tenantId, branchId, `${name}`, name, o.total ?? '0'],
    )
    for (const s of slots) {
      await owner.query(
        `insert into booking_slots (tenant_id,booking_id,resource_id,starts_at,ends_at,
           rate_applied,slot_total,resource_name,resource_type_name,active,backdated)
         values ($1,$2,$3,$4,$5,'250.00',$6,$7,'Table',true,true)`,
        [T.tenantId, bk.rows[0].id, s.res, s.from, s.to, s.total ?? '250.00', `R-${s.res.slice(0, 8)}`],
      )
    }
    if (status !== 'confirmed') await owner.query('update bookings set status=$2 where id=$1', [bk.rows[0].id, status])
    return bk.rows[0].id
  }
  const at = (T: Tenant, day: string, hhmm: string) => zonedTimeToUtc(day, hhmm, T.tz)
  const one = (T: Tenant, day: string, hhmm: string, mins = 20) => {
    const from = at(T, day, hhmm)
    return [{ res: T.r1, from, to: new Date(from.getTime() + mins * 60_000) }]
  }

  // ══ 1. role matrix ═══════════════════════════════════════════════════════
  console.log('\n── role matrix: 5 roles × 5 presets, own tenant + branch only ──')
  {
    const T = tenants.ist
    const O = tenants.other
    const today = '2045-04-20'
    // MINE-* sit inside every preset's window (lastyear is the previous calendar year).
    const mine: Record<RangePreset, string> = {
      yesterday: '2045-04-19',
      last7: '2045-04-16',
      month: '2045-04-05',
      last3m: '2045-02-10',
      lastyear: '2044-06-15',
    }
    for (const p of RANGE_PRESETS) {
      await booking(T, T.branchId, `MINE-${p}`, 'confirmed', one(T, mine[p], '10:00'))
      await booking(T, T.branch2Id, `BRANCH2-${p}`, 'confirmed', [
        { res: T.rb2, from: at(T, mine[p], '10:00'), to: at(T, mine[p], '10:20') },
      ])
      await booking(O, O.branchId, `OTHERTENANT-${p}`, 'confirmed', one(O, mine[p], '10:00'))
    }
    for (const role of ROLES) {
      const u = await mkUser(T.tenantId, T.slug, role)
      const c = ctxFor(T, u, role)
      for (const p of RANGE_PRESETS) {
        const r = resolveRange(p, today, T.tz)
        let names: string[] = []
        let threw = false
        try {
          const res = await listRangeBookings(c, T.branchId, r.startUtc, r.endUtc)
          names = res.rows.map((x) => x.customerName ?? '')
          if (res.total !== res.rows.length) threw = true // < 50 rows: page must hold everything
        } catch {
          threw = true
        }
        const expectedHere = RANGE_PRESETS.filter((q) => {
          const rq = resolveRange(q, today, T.tz)
          return mine[q] >= rq.fromDate && mine[q] <= rq.toDate && rq.fromDate <= r.toDate && rq.toDate >= r.fromDate
        })
        void expectedHere
        const leaked = names.filter((n) => !n.startsWith('MINE-'))
        const own = names.includes(`MINE-${p}`)
        check(`${role} / ${p}: loads, sees own booking, nothing foreign`, !threw && own && leaked.length === 0)
      }
      // Asking for another branch / tenant by id must not widen visibility.
      const r = resolveRange('lastyear', today, T.tz)
      const sneaky = await listRangeBookings(c, O.branchId, r.startUtc, r.endUtc)
      check(`${role}: other tenant's branch by id → nothing`, sneaky.rows.length === 0 && sneaky.total === 0)
    }
  }

  // ══ 2 + 3. timezone + boundary dates + last year ═════════════════════════
  console.log('\n── boundaries: 23:30 last day / 00:30 first day, every preset ──')
  const cases: { tz: 'ist' | 'ny' | 'syd'; today: string; note: string }[] = [
    { tz: 'ist', today: '2045-01-01', note: '1 Jan' },
    { tz: 'ist', today: '2044-02-29', note: '29 Feb (leap)' },
    { tz: 'ist', today: '2045-05-31', note: '31 May' },
    { tz: 'ist', today: '2044-05-31', note: '31 May (leap yr: last3m → 29 Feb)' },
    { tz: 'ist', today: '2044-12-31', note: '31 Dec' },
    { tz: 'ny', today: '2045-01-01', note: '1 Jan' },
    { tz: 'ny', today: '2044-02-29', note: '29 Feb (leap)' },
    { tz: 'ny', today: '2045-05-31', note: '31 May' },
    { tz: 'ny', today: '2044-12-31', note: '31 Dec' },
    { tz: 'ny', today: '2045-06-12', note: 'last3m starts on US DST-start day 12 Mar' },
    { tz: 'ny', today: '2045-03-12', note: 'today IS the US DST-start day' },
    { tz: 'ny', today: '2045-11-05', note: 'today IS the US DST-end day' },
    { tz: 'ny', today: '2045-02-05', note: 'last3m starts 5 Nov (DST-end day)' },
    { tz: 'syd', today: '2045-01-01', note: '1 Jan' },
    { tz: 'syd', today: '2045-10-01', note: 'AU DST-start day (1st Sun Oct)' },
    { tz: 'syd', today: '2045-04-02', note: 'AU DST-end day (1st Sun Apr)' },
    { tz: 'syd', today: '2044-12-31', note: '31 Dec' },
  ]
  for (const k of cases) {
    const T = tenants[k.tz]
    const u = await mkUser(T.tenantId, T.slug, 'cashier')
    const c = ctxFor(T, u, 'cashier')
    for (const p of RANGE_PRESETS) {
      const r = resolveRange(p, k.today, T.tz)
      await wipe(T)
      await booking(T, T.branchId, 'IN-LAST-2330', 'confirmed', one(T, r.toDate, '23:30'))
      await booking(T, T.branchId, 'IN-FIRST-0030', 'confirmed', one(T, r.fromDate, '00:30'))
      await booking(T, T.branchId, 'OUT-BEFORE-2330', 'confirmed', one(T, addDays(r.fromDate, -1), '23:30'))
      await booking(T, T.branchId, 'OUT-AFTER-0030', 'confirmed', one(T, addDays(r.toDate, 1), '00:30'))
      // Straddlers: ends 00:10 inside the first day / starts 23:50 on the day before… and the converse.
      await booking(T, T.branchId, 'IN-STRADDLE-INTO-FIRST', 'confirmed', [
        { res: T.r2, from: at(T, addDays(r.fromDate, -1), '23:50'), to: at(T, r.fromDate, '00:10') },
      ])
      await booking(T, T.branchId, 'IN-STRADDLE-OUT-OF-LAST', 'confirmed', [
        { res: T.r2, from: at(T, r.toDate, '23:50'), to: at(T, addDays(r.toDate, 1), '00:10') },
      ])
      const res = await listRangeBookings(c, T.branchId, r.startUtc, r.endUtc)
      const got = res.rows.map((x) => x.customerName).sort()
      const want = ['IN-FIRST-0030', 'IN-LAST-2330', 'IN-STRADDLE-INTO-FIRST', 'IN-STRADDLE-OUT-OF-LAST']
      check(
        `${k.tz} ${k.note} / ${p} [${r.fromDate}..${r.toDate}]: ${want.length} in, 2 out`,
        JSON.stringify(got) === JSON.stringify(want) && res.total === want.length,
      )
    }
  }

  console.log('\n── explicit boundary values ──')
  {
    const e = (today: string, p: RangePreset, from: string, to: string) => {
      const r = resolveRange(p, today, IST)
      check(`${today} ${p} → ${from}..${to}`, r.fromDate === from && r.toDate === to)
    }
    e('2045-01-01', 'last7', '2044-12-26', '2045-01-01')
    e('2045-01-01', 'month', '2045-01-01', '2045-01-01')
    e('2045-01-01', 'last3m', '2044-10-01', '2045-01-01')
    e('2045-01-01', 'lastyear', '2044-01-01', '2044-12-31')
    e('2044-02-29', 'month', '2044-02-01', '2044-02-29')
    e('2044-02-29', 'lastyear', '2043-01-01', '2043-12-31')
    e('2044-02-29', 'last3m', '2043-11-29', '2044-02-29')
    e('2045-05-31', 'last3m', '2045-02-28', '2045-05-31') // clamps: no 31 Feb
    e('2044-05-31', 'last3m', '2044-02-29', '2044-05-31') // clamps to the leap day
    e('2044-12-31', 'lastyear', '2043-01-01', '2043-12-31')
    e('2044-12-31', 'last3m', '2044-09-30', '2044-12-31')
    // Last year is the previous CALENDAR year: the same on 1 Jan and on 31 Dec.
    const a = resolveRange('lastyear', '2045-01-01', IST)
    const b = resolveRange('lastyear', '2045-12-31', IST)
    check('lastyear is calendar-year based, identical on 1 Jan and 31 Dec', a.fromDate === b.fromDate && a.toDate === b.toDate)
    const rolling = addDays('2045-06-15', -364)
    check('lastyear on 15 Jun 2045 is NOT a rolling 12 months', resolveRange('lastyear', '2045-06-15', IST).fromDate !== rolling)
  }

  // ══ 4. totals: list view == timeline ═════════════════════════════════════
  console.log('\n── totals: list vs timeline (listDayBookings) ──')
  {
    const T = tenants.ist
    await wipe(T)
    const u = await mkUser(T.tenantId, T.slug, 'cashier')
    const c = ctxFor(T, u, 'cashier')
    const day = '2045-04-10'
    const single = await booking(
      T, T.branchId, 'SINGLE', 'confirmed',
      [{ res: T.r1, from: at(T, day, '10:00'), to: at(T, day, '11:00'), total: '250.00' }],
      { total: '250.00' },
    )
    await booking(
      T, T.branchId, 'MULTI-RES-MULTI-DAY', 'confirmed',
      [
        { res: T.r1, from: at(T, day, '14:00'), to: at(T, day, '15:00'), total: '250.00' },
        { res: T.r2, from: at(T, day, '14:00'), to: at(T, day, '16:00'), total: '500.00' },
        { res: T.r1, from: at(T, addDays(day, 3), '14:00'), to: at(T, addDays(day, 3), '15:00'), total: '250.00' },
      ],
      { total: '900.00' },
    )
    await booking(
      T, T.branchId, 'CANCELLED', 'cancelled',
      [{ res: T.r2, from: at(T, day, '18:00'), to: at(T, day, '19:00'), total: '250.00' }],
      { total: '250.00' },
    )
    await booking(T, T.branchId, 'OPEN-TAB', 'checked_in', [{ res: T.r1, from: at(T, day, '20:00'), to: null, total: '0.00' }])
    void single

    const dayRows = await listDayBookings(c, T.branchId, day, T.tz)
    const r = resolveRange('month', '2045-04-20', T.tz)
    const list = await listRangeBookings(c, T.branchId, r.startUtc, r.endUtc)
    const byName = new Map(list.rows.map((x) => [x.customerName, x]))
    for (const name of ['SINGLE', 'MULTI-RES-MULTI-DAY', 'CANCELLED', 'OPEN-TAB']) {
      const slots = dayRows.filter((s) => s.customerName === name)
      const row = byName.get(name)
      check(`${name}: present in both feeds`, slots.length > 0 && !!row)
      if (!row || slots.length === 0) continue
      const s0 = slots[0]
      check(`${name}: bookings.total equal (${s0.total} vs ${row.total})`, Number(s0.total) === Number(row.total))
      check(`${name}: advance paid equal`, Number(s0.advancePaid) === Number(row.advancePaid))
      check(`${name}: deposit equal`, Number(s0.deposit) === Number(row.deposit))
      // The list derives bookingActiveSlotTotal from slotsTotal (0 for cancelled/no-show).
      const derived = row.status === 'cancelled' || row.status === 'no_show' ? 0 : Number(row.slotsTotal)
      check(
        `${name}: active slot total equal (timeline ${s0.bookingActiveSlotTotal} vs list-derived ${derived})`,
        Number(s0.bookingActiveSlotTotal) === derived,
      )
    }
    check('multi-day booking appears once in the list', list.rows.filter((x) => x.customerName === 'MULTI-RES-MULTI-DAY').length === 1)
    check('its all-slot total includes the out-of-day slot (1000.00)', Number(byName.get('MULTI-RES-MULTI-DAY')?.slotsTotal) === 1000)
    check('cancelled booking slots are inactive (trigger assumption behind the 0.00 mapping)', dayRows.filter((s) => s.customerName === 'CANCELLED').every((s) => s.active === false))
    check('summary counts the whole range', list.summary.bookings === 4 && list.summary.byStatus.cancelled === 1)
  }

  for (const T of Object.values(tenants)) await wipe(T)
  await owner.end()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
