/**
 * Booking-level range feed — listRangeBookings (M34 #2).
 *
 * Proves, against a real database and as NON-owner roles (cashier /
 * receptionist — past RLS bugs AROS-183 / AROS-294 hid from owner fixtures):
 *   - a 3-slot booking is ONE row; its slotsTotal is the all-slot sum even
 *     when a slot lies outside the range
 *   - a booking straddling either range edge is included once
 *   - a slot ending exactly at startUtc / starting exactly at endUtc is not
 *   - an open-tab walk-in (null ends_at) is included
 *   - cancelled / no-show bookings are included with their status
 *   - paging: no dupes, no gaps, total matches, newest first, past-the-end
 *     page clamps to the last
 *   - summary counts the whole range, not the page
 *   - other tenant / other branch / non-member never returned
 *   - a few thousand bookings: result count + EXPLAIN of the slot scan
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs scripts/test-range-bookings.ts
 */
import { Pool } from 'pg'
import { loadEnv } from './env'
import type { ActiveContext } from '../lib/tenant/context'

let pass = 0,
  fail = 0
const check = (l: string, c: boolean) => {
  console.log(`${c ? '✓' : '✗ FAIL'}  ${l}`)
  if (c) pass++
  else fail++
}

const TZ = 'Asia/Kolkata'
const D = (n: number) => `2045-04-${String(n).padStart(2, '0')}`
const ist = (day: string, hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number)
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCMinutes(d.getUTCMinutes() + h * 60 + m - (5 * 60 + 30))
  return d
}

async function main() {
  loadEnv()
  const { listRangeBookings } = await import('../lib/booking/data')
  const owner = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })

  const mkTenant = async (slug: string) => {
    const t = await owner.query<{ id: string }>(
      `insert into tenants (slug,name,status,timezone) values ($1,$2,'active',$3)
       on conflict (slug) do update set name=excluded.name returning id`,
      [slug, `${slug} co`, TZ],
    )
    const tenantId = t.rows[0].id
    const b = await owner.query<{ id: string }>(
      `insert into branches (tenant_id,name,is_primary) values ($1,'Main',true)
       on conflict (tenant_id,name) do update set is_primary=true returning id`,
      [tenantId],
    )
    const b2 = await owner.query<{ id: string }>(
      `insert into branches (tenant_id,name,is_primary) values ($1,'Second',false)
       on conflict (tenant_id,name) do update set is_primary=false returning id`,
      [tenantId],
    )
    const rt = await owner.query<{ id: string }>(
      `insert into resource_types (tenant_id,name,hourly_rate) values ($1,'Table','250.00')
       on conflict (tenant_id,name) do update set hourly_rate='250.00' returning id`,
      [tenantId],
    )
    const mkRes = async (branchId: string, name: string) =>
      (
        await owner.query<{ id: string }>(
          `insert into resources (tenant_id,branch_id,resource_type_id,name,status)
           values ($1,$2,$3,$4,'available')
           on conflict (tenant_id,name) do update set status='available', branch_id=excluded.branch_id
           returning id`,
          [tenantId, branchId, rt.rows[0].id, name],
        )
      ).rows[0].id
    return {
      tenantId,
      branchId: b.rows[0].id,
      branch2Id: b2.rows[0].id,
      r1: await mkRes(b.rows[0].id, `${slug}-T1`),
      r2: await mkRes(b.rows[0].id, `${slug}-T2`),
      r3: await mkRes(b.rows[0].id, `${slug}-T3`),
      rb2: await mkRes(b2.rows[0].id, `${slug}-B2-T1`),
    }
  }
  const mkUser = async (tenantId: string | null, slug: string, role: string) => {
    const u = await owner.query<{ id: string }>(
      `insert into users (email,password_hash) values ($1,'x')
       on conflict (email) do update set email=excluded.email returning id`,
      [`${role}@${slug}.test`],
    )
    let membershipId = ''
    if (tenantId) {
      membershipId = (
        await owner.query<{ id: string }>(
          `insert into memberships (tenant_id,user_id,role,status) values ($1,$2,$3,'active')
           on conflict (tenant_id,user_id) do update set role=excluded.role, status='active' returning id`,
          [tenantId, u.rows[0].id, role],
        )
      ).rows[0].id
    }
    return { id: u.rows[0].id, membershipId }
  }

  const slug = 'testrangebk'
  const T = await mkTenant(slug)
  const O = await mkTenant('testrangeother')
  const cashier = await mkUser(T.tenantId, slug, 'cashier')
  const recep = await mkUser(T.tenantId, slug, 'receptionist')
  const stranger = await mkUser(null, 'stranger', 'cashier') // member of nothing

  const ctxFor = (u: { id: string; membershipId: string }, role: string): ActiveContext => ({
    user: { id: u.id, email: `${role}@${slug}.test`, fullName: null, isPlatformAdmin: false },
    tenant: {
      id: T.tenantId,
      slug,
      name: `${slug} co`,
      industry: 'gaming',
      status: 'active',
      currency: 'INR',
      timezone: TZ,
    },
    role: role as ActiveContext['role'],
    membershipId: u.membershipId,
    branchId: T.branchId,
  })
  const ctx = ctxFor(cashier, 'cashier')

  const wipe = async () => {
    for (const id of [T.tenantId, O.tenantId]) {
      await owner.query('delete from booking_slots where tenant_id=$1', [id])
      await owner.query('delete from bookings where tenant_id=$1', [id])
    }
  }
  await wipe()

  let seq = 0
  async function booking(
    tenant: { tenantId: string },
    branchId: string,
    name: string,
    status: string,
    slots: { res: string; from: Date; to: Date | null; total?: string }[],
  ) {
    seq++
    const bk = await owner.query<{ id: string }>(
      `insert into bookings (tenant_id,branch_id,booking_number,status,customer_name,subtotal,total)
       values ($1,$2,$3,'confirmed',$4,'0','0') returning id`,
      [tenant.tenantId, branchId, `${name}-${seq}`, name],
    )
    for (const s of slots) {
      await owner.query(
        `insert into booking_slots (tenant_id,booking_id,resource_id,starts_at,ends_at,
           rate_applied,slot_total,resource_name,resource_type_name,active,backdated)
         values ($1,$2,$3,$4,$5,'250.00',$6,$7,'Table',true,true)`,
        [tenant.tenantId, bk.rows[0].id, s.res, s.from, s.to, s.total ?? '250.00', `R-${s.res.slice(0, 8)}`],
      )
    }
    if (status !== 'confirmed')
      await owner.query('update bookings set status=$2 where id=$1', [bk.rows[0].id, status])
    return bk.rows[0].id
  }

  const range = (a: number, b: number) => ({ start: ist(D(a), '00:00'), end: ist(D(b + 1), '00:00') })
  const list = (c: ActiveContext, a: number, b: number, o: { page?: number; pageSize?: number } = {}) => {
    const r = range(a, b)
    return listRangeBookings(c, T.branchId, r.start, r.end, o)
  }
  const names = (r: Awaited<ReturnType<typeof list>>) => r.rows.map((x) => x.customerName).sort()

  // ══ 1. slots collapse; total is all-slot sum ═════════════════════════════
  console.log('\n── collapse + all-slot total ──')
  {
    await wipe()
    await booking(T, T.branchId, 'MULTI', 'confirmed', [
      { res: T.r1, from: ist(D(10), '10:00'), to: ist(D(10), '11:00'), total: '100.00' },
      { res: T.r2, from: ist(D(10), '12:00'), to: ist(D(10), '13:00'), total: '200.00' },
      { res: T.r3, from: ist(D(20), '12:00'), to: ist(D(20), '13:00'), total: '400.00' }, // outside
    ])
    const r = await list(ctx, 9, 11)
    check('3 slots (2 in range) → 1 row', r.rows.length === 1 && r.total === 1)
    check('slotsTotal sums ALL slots incl. the one outside the range', Number(r.rows[0]?.slotsTotal) === 700)
    check('slotCount is 3', r.rows[0]?.slotCount === 3)
    check('resourceNames lists the in-range resources', r.rows[0]?.resourceNames.length === 2)
    check(
      'firstStartsAt is the earliest in-range slot',
      r.rows[0]?.firstStartsAt.getTime() === ist(D(10), '10:00').getTime(),
    )
  }

  // ══ 2. edges ═════════════════════════════════════════════════════════════
  console.log('\n── range edges ──')
  {
    await wipe()
    await booking(T, T.branchId, 'IN-FROM-BEFORE', 'confirmed', [
      { res: T.r1, from: ist(D(9), '22:00'), to: ist(D(10), '02:00') },
    ])
    await booking(T, T.branchId, 'OUT-TO-AFTER', 'confirmed', [
      { res: T.r1, from: ist(D(12), '22:00'), to: ist(D(13), '02:00') },
    ])
    await booking(T, T.branchId, 'ENDS-AT-START', 'confirmed', [
      { res: T.r2, from: ist(D(9), '23:00'), to: ist(D(10), '00:00') },
    ])
    await booking(T, T.branchId, 'STARTS-AT-END', 'confirmed', [
      { res: T.r2, from: ist(D(13), '00:00'), to: ist(D(13), '01:00') },
    ])
    await booking(T, T.branchId, 'OPEN-TAB', 'checked_in', [{ res: T.r3, from: ist(D(11), '15:00'), to: null }])
    const r = await list(ctx, 10, 12)
    check(
      'straddling-start, straddling-end and open-tab each included once',
      JSON.stringify(names(r)) === JSON.stringify(['IN-FROM-BEFORE', 'OPEN-TAB', 'OUT-TO-AFTER']),
    )
    check(
      'ends exactly at startUtc / starts exactly at endUtc excluded',
      !names(r).includes('ENDS-AT-START') && !names(r).includes('STARTS-AT-END'),
    )
    const open = r.rows.find((x) => x.customerName === 'OPEN-TAB')
    check('open-tab walk-in has isOpen and null lastEndsAt', open?.isOpen === true && open?.lastEndsAt === null)
  }

  // ══ 3. cancelled / no-show visible, summary ══════════════════════════════
  console.log('\n── statuses + summary ──')
  {
    await wipe()
    const one = (h: number) => [{ res: T.r1, from: ist(D(10), `${h}:00`), to: ist(D(10), `${h}:30`) }]
    await booking(T, T.branchId, 'C1', 'confirmed', one(10))
    await booking(T, T.branchId, 'C2', 'confirmed', one(12))
    await booking(T, T.branchId, 'D1', 'completed', one(14))
    await booking(T, T.branchId, 'X1', 'cancelled', one(16))
    await booking(T, T.branchId, 'N1', 'no_show', one(18))
    const r = await list(ctx, 10, 10, { pageSize: 2 })
    const s = r.summary.byStatus
    check(
      'summary counts the whole range, not the page',
      r.rows.length === 2 && r.total === 5 && r.summary.bookings === 5,
    )
    check('per-status counts', s.confirmed === 2 && s.completed === 1 && s.cancelled === 1 && s.no_show === 1)
    const all = await list(ctx, 10, 10)
    check('cancelled booking is returned, flagged by status', all.rows.find((q) => q.customerName === 'X1')?.status === 'cancelled')
    check('no-show returned', all.rows.some((q) => q.status === 'no_show'))

    // Refund-owed + payment-hold signals reach the multi-day list (the day table shows both).
    const xRefund = await booking(T, T.branchId, 'X2', 'cancelled', one(17))
    await owner.query('update bookings set deposit_review_required=true where id=$1', [xRefund])
    const hold = new Date('2045-04-10T09:00:00Z')
    const pRow = await booking(T, T.branchId, 'P1', 'pending_payment', one(19))
    await owner.query('update bookings set payment_hold_expires_at=$2 where id=$1', [pRow, hold])
    const sig = await list(ctx, 10, 10)
    const byName = (n: string) => sig.rows.find((q) => q.customerName === n)
    check('cancelled booking with a paid deposit carries depositReviewRequired', byName('X2')?.depositReviewRequired === true)
    check('a plain cancelled booking is not flagged', byName('X1')?.depositReviewRequired === false)
    check('pending_payment row carries its hold expiry', byName('P1')?.paymentHoldExpiresAt?.getTime() === hold.getTime())
    check('a booking with no hold has a null expiry', byName('C1')?.paymentHoldExpiresAt === null)
  }

  // ══ 4. pagination ════════════════════════════════════════════════════════
  console.log('\n── pagination ──')
  {
    await wipe()
    // 23 bookings; several share an identical start to exercise the tie-break.
    for (let i = 0; i < 23; i++) {
      const hour = String(8 + Math.floor(i / 3)).padStart(2, '0')
      await booking(T, T.branchId, `P${String(i).padStart(2, '0')}`, 'confirmed', [
        { res: [T.r1, T.r2, T.r3][i % 3], from: ist(D(10), `${hour}:00`), to: ist(D(10), `${hour}:30`) },
      ])
    }
    const seen: string[] = []
    let total = 0
    for (let p = 1; p <= 5; p++) {
      const r = await list(ctx, 10, 10, { page: p, pageSize: 5 })
      total = r.total
      seen.push(...r.rows.map((x) => x.bookingId))
    }
    check('total is 23', total === 23)
    check('5 pages × 5 cover 23 rows: no dupes, no gaps', seen.length === 23 && new Set(seen).size === 23)
    const p1 = await list(ctx, 10, 10, { page: 1, pageSize: 5 })
    const starts = p1.rows.map((x) => x.firstStartsAt.getTime())
    check('newest first', starts.every((v, i) => i === 0 || starts[i - 1] >= v))
    const again = await list(ctx, 10, 10, { page: 1, pageSize: 5 })
    check(
      'ordering is stable across calls',
      JSON.stringify(again.rows.map((x) => x.bookingId)) === JSON.stringify(p1.rows.map((x) => x.bookingId)),
    )
    const past = await list(ctx, 10, 10, { page: 99, pageSize: 5 })
    check('page past the end clamps to the last page', past.page === 5 && past.rows.length === 3)
    const def = await list(ctx, 10, 10)
    check('default page size is 50', def.pageSize === 50 && def.rows.length === 23)
    const junk = await list(ctx, 10, 10, { page: Number.NaN, pageSize: -4 })
    check('junk page/pageSize fall back safely', junk.page === 1 && junk.pageSize >= 1)
    const empty = await list(ctx, 25, 26)
    check('empty range → no rows, total 0, page 1', empty.rows.length === 0 && empty.total === 0 && empty.page === 1)
  }

  // ══ 5. isolation, as non-owner roles ═════════════════════════════════════
  console.log('\n── isolation (cashier / receptionist) ──')
  {
    await wipe()
    const slot = (res: string) => [{ res, from: ist(D(10), '10:00'), to: ist(D(10), '11:00') }]
    await booking(T, T.branchId, 'MINE', 'confirmed', slot(T.r1))
    await booking(T, T.branch2Id, 'OTHER-BRANCH', 'confirmed', slot(T.rb2))
    await booking(O, O.branchId, 'OTHER-TENANT', 'confirmed', slot(O.r1))
    for (const [u, role] of [
      [cashier, 'cashier'],
      [recep, 'receptionist'],
    ] as const) {
      const r = await list(ctxFor(u, role), 10, 10)
      check(`${role}: only this tenant + branch`, JSON.stringify(names(r)) === JSON.stringify(['MINE']))
    }
    const rr = range(10, 10)
    const sneaky = await listRangeBookings(ctx, O.branchId, rr.start, rr.end)
    check("cashier cannot read another tenant's branch by id", sneaky.rows.length === 0 && sneaky.total === 0)
    const none = await listRangeBookings(ctxFor(stranger, 'cashier'), T.branchId, rr.start, rr.end)
    check('a user with no membership sees nothing', none.rows.length === 0 && none.total === 0)
    const b2 = await listRangeBookings(ctx, T.branch2Id, rr.start, rr.end)
    check('other-branch rows only via that branch', names(b2).join() === 'OTHER-BRANCH')
  }

  // ══ 6. scale + plan ══════════════════════════════════════════════════════
  console.log('\n── a few thousand bookings ──')
  {
    await wipe()
    const N = 4000
    await owner.query(
      `insert into bookings (tenant_id,branch_id,booking_number,status,customer_name,subtotal,total)
       select $1,$2,'S-'||g,'confirmed','S'||g,'0','0' from generate_series(1,$3) g`,
      [T.tenantId, T.branchId, N],
    )
    // One slot per booking, one every 4h from 2044-01-01 (~2 years).
    await owner.query(
      `insert into booking_slots (tenant_id,booking_id,resource_id,starts_at,ends_at,
         rate_applied,slot_total,resource_name,resource_type_name,active,backdated)
       select $1, b.id, $2, ts.v, ts.v + interval '1 hour', '250.00','250.00','T','Table', true, true
       from (select id, row_number() over (order by id) as rn from bookings where tenant_id=$1) b
       cross join lateral (select timestamptz '2044-01-01 00:00+00' + (b.rn * interval '4 hours') as v) ts`,
      [T.tenantId, T.r1],
    )
    await owner.query('analyze booking_slots')
    await owner.query('analyze bookings')
    const start = ist('2044-06-01', '00:00')
    const end = ist('2044-07-01', '00:00')
    const expected = (
      await owner.query<{ n: number }>(
        `select count(distinct booking_id)::int n from booking_slots
         where tenant_id=$1 and starts_at < $3 and (ends_at is null or ends_at > $2)`,
        [T.tenantId, start, end],
      )
    ).rows[0].n
    const t0 = Date.now()
    const r = await listRangeBookings(ctx, T.branchId, start, end, { pageSize: 50 })
    const ms = Date.now() - t0
    check(
      `month window: ${r.total} bookings (SQL says ${expected}), first page of 50 in ${ms}ms`,
      r.total === expected && r.rows.length === 50 && ms < 2000,
    )
    const yr = await listRangeBookings(ctx, T.branchId, ist('2044-01-01', '00:00'), ist('2045-01-01', '00:00'))
    check('whole-year window returns one page, never unbounded', yr.rows.length === 50 && yr.total > 50)

    const plan = await owner.query<Record<string, string>>(
      `explain select booking_id, min(starts_at) from booking_slots
       where tenant_id=$1 and starts_at < $3 and (ends_at is null or ends_at > $2) group by booking_id`,
      [T.tenantId, start, end],
    )
    console.log(plan.rows.map((x) => '    ' + x['QUERY PLAN']).join('\n'))
    // At 4k rows the planner rightly prefers a seq scan. Forbid it to prove the
    // 0122 indexes are usable for the overlap predicate (cancelled rows included).
    const c = await owner.connect()
    try {
      await c.query('begin')
      await c.query('set local enable_seqscan = off')
      const forced = await c.query<Record<string, string>>(
        `explain select booking_id from booking_slots
         where tenant_id=$1 and starts_at < $3 and (ends_at is null or ends_at > $2)`,
        [T.tenantId, start, end],
      )
      const text = forced.rows.map((x) => x['QUERY PLAN']).join('\n')
      check('with seq scan disabled the plan uses a 0122 tenant index', /idx_booking_slots_tenant_(starts|ends)/.test(text))
      await c.query('rollback')
    } finally {
      c.release()
    }
  }

  await wipe()
  await owner.end()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
