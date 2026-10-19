/**
 * M34 #5 — performance of the multi-day list's data path (listRangeBookings +
 * the per-page loaders the bookings page runs after it).
 *
 *   A. the largest EXISTING tenant in the database (read-only), every preset
 *   B. a synthetic tenant with SYNTH_N bookings spread over the previous
 *      calendar year, last-year preset, as a non-owner RLS-bound role, plus
 *      EXPLAIN (ANALYZE, BUFFERS) of the slot scan and of the page query.
 *      Seeded rows are deleted afterwards.
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs scripts/perf-range-bookings.ts [SYNTH_N]
 */
import { Pool } from 'pg'
import { loadEnv } from './env'
import type { ActiveContext } from '../lib/tenant/context'
import { RANGE_PRESETS, resolveRange } from '../lib/booking/ranges'
import { todayInZone } from '../lib/booking/time'

const SYNTH_N = Number(process.argv[2] ?? 100_000)

async function main() {
  loadEnv()
  const { listRangeBookings } = await import('../lib/booking/data')
  const { listBookingPaymentStates } = await import('../lib/billing/data')
  const { listOrdersForBookings } = await import('../lib/orders/data')
  const owner = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })

  const ctxFor = (t: { id: string; slug: string; name: string; timezone: string; currency: string }, u: { id: string; membershipId: string }, role: string, branchId: string): ActiveContext => ({
    user: { id: u.id, email: 'perf@test', fullName: null, isPlatformAdmin: false },
    tenant: { id: t.id, slug: t.slug, name: t.name, industry: 'gaming', status: 'active', currency: t.currency, timezone: t.timezone },
    role: role as ActiveContext['role'],
    membershipId: u.membershipId,
    branchId,
  })

  async function timeAll(label: string, c: ActiveContext, branchId: string) {
    const today = todayInZone(c.tenant.timezone)
    for (const p of RANGE_PRESETS.filter((x) => x !== 'yesterday')) {
      const r = resolveRange(p, today, c.tenant.timezone)
      const t0 = performance.now()
      const res = await listRangeBookings(c, branchId, r.startUtc, r.endUtc, { page: 1 })
      const t1 = performance.now()
      const ids = res.rows.map((x) => x.bookingId)
      await listBookingPaymentStates(c, ids)
      await listOrdersForBookings(c, ids)
      const t2 = performance.now()
      console.log(
        `  ${label} ${p.padEnd(8)} total=${String(res.total).padStart(7)}  list=${(t1 - t0).toFixed(0).padStart(5)}ms  +extras=${(t2 - t1).toFixed(0).padStart(4)}ms`,
      )
    }
  }

  // ── A. largest existing tenant ────────────────────────────────────────────
  console.log('\n── A. largest existing tenant (read-only) ──')
  const big = await owner.query<{ id: string; slug: string; name: string; timezone: string; currency: string; n: number }>(
    `select t.id, t.slug, t.name, t.timezone, t.currency, count(b.id)::int n
       from tenants t join bookings b on b.tenant_id = t.id
      group by t.id order by n desc limit 1`,
  )
  if (big.rows[0]) {
    const t = big.rows[0]
    const slots = await owner.query<{ n: number }>('select count(*)::int n from booking_slots where tenant_id=$1', [t.id])
    console.log(`  ${t.slug}: ${t.n} bookings, ${slots.rows[0].n} slots, tz ${t.timezone}`)
    const br = await owner.query<{ id: string }>('select id from branches where tenant_id=$1 order by is_primary desc limit 1', [t.id])
    const m = await owner.query<{ user_id: string; id: string; role: string }>(
      `select user_id, id, role from memberships where tenant_id=$1 and status='active' order by (role='owner') desc limit 1`,
      [t.id],
    )
    if (br.rows[0] && m.rows[0]) {
      await timeAll(t.slug, ctxFor(t, { id: m.rows[0].user_id, membershipId: m.rows[0].id }, m.rows[0].role, br.rows[0].id), br.rows[0].id)
    }
  } else console.log('  (no bookings in this database)')

  // ── B. synthetic large tenant ─────────────────────────────────────────────
  console.log(`\n── B. synthetic tenant, ${SYNTH_N} bookings in the previous calendar year ──`)
  const slug = 'testperfrange'
  const tz = 'Asia/Kolkata'
  const tn = await owner.query<{ id: string }>(
    `insert into tenants (slug,name,status,timezone) values ($1,$1,'active',$2)
     on conflict (slug) do update set name=excluded.name returning id`,
    [slug, tz],
  )
  const tenantId = tn.rows[0].id
  const br = await owner.query<{ id: string }>(
    `insert into branches (tenant_id,name,is_primary) values ($1,'Main',true)
     on conflict (tenant_id,name) do update set is_primary=true returning id`,
    [tenantId],
  )
  const branchId = br.rows[0].id
  const rt = await owner.query<{ id: string }>(
    `insert into resource_types (tenant_id,name,hourly_rate) values ($1,'Table','250.00')
     on conflict (tenant_id,name) do update set hourly_rate='250.00' returning id`,
    [tenantId],
  )
  const res = await owner.query<{ id: string }>(
    `insert into resources (tenant_id,branch_id,resource_type_id,name,status) values ($1,$2,$3,'perf-T1','available')
     on conflict (tenant_id,name) do update set status='available' returning id`,
    [tenantId, branchId, rt.rows[0].id],
  )
  const u = await owner.query<{ id: string }>(
    `insert into users (email,password_hash) values ('cashier@testperfrange.test','x')
     on conflict (email) do update set email=excluded.email returning id`,
  )
  const mem = await owner.query<{ id: string }>(
    `insert into memberships (tenant_id,user_id,role,status) values ($1,$2,'cashier','active')
     on conflict (tenant_id,user_id) do update set role='cashier', status='active' returning id`,
    [tenantId, u.rows[0].id],
  )
  await owner.query('delete from booking_slots where tenant_id=$1', [tenantId])
  await owner.query('delete from bookings where tenant_id=$1', [tenantId])
  try {
    const lastYear = Number(todayInZone(tz).slice(0, 4)) - 1
    await owner.query(
      `insert into bookings (tenant_id,branch_id,booking_number,status,customer_name,subtotal,total)
       select $1,$2,'P-'||g,((array['completed','completed','completed','confirmed','cancelled','no_show'])[1+g%6])::booking_status,'P'||g,'0','250.00'
         from generate_series(1,$3) g`,
      [tenantId, branchId, SYNTH_N],
    )
    await owner.query(
      `insert into booking_slots (tenant_id,booking_id,resource_id,starts_at,ends_at,
         rate_applied,slot_total,resource_name,resource_type_name,active,backdated)
       select $1, b.id, $2, ts.v, ts.v + interval '1 hour','250.00','250.00','perf-T1','Table',true,true
         from (select id, row_number() over (order by id) rn from bookings where tenant_id=$1) b
        cross join lateral (select make_timestamptz($4,1,1,0,0,0,'UTC') + (b.rn * interval '1 year' / $3) as v) ts`,
      [tenantId, res.rows[0].id, SYNTH_N, lastYear],
    )
    await owner.query('analyze booking_slots')
    await owner.query('analyze bookings')
    const c = ctxFor({ id: tenantId, slug, name: slug, timezone: tz, currency: 'INR' }, { id: u.rows[0].id, membershipId: mem.rows[0].id }, 'cashier', branchId)

    // Cold then warm: the first call includes plan + connection setup.
    await timeAll('synthetic(cold)', c, branchId)
    await timeAll('synthetic(warm)', c, branchId)

    const r = resolveRange('lastyear', todayInZone(tz), tz)
    const ex = await owner.query<Record<string, string>>(
      `explain (analyze, buffers, costs off)
       with in_range as (
         select bs.booking_id, min(bs.starts_at) first_starts_at
           from booking_slots bs join bookings b on b.id = bs.booking_id
          where bs.tenant_id=$1 and b.tenant_id=$1 and b.branch_id=$2
            and bs.starts_at < $4 and (bs.ends_at is null or bs.ends_at > $3)
          group by bs.booking_id)
       select b.id, ir.first_starts_at
         from in_range ir join bookings b on b.id = ir.booking_id
        order by ir.first_starts_at desc, b.id asc limit 50 offset 0`,
      [tenantId, branchId, r.startUtc, r.endUtc],
    )
    console.log('\n  EXPLAIN (ANALYZE, BUFFERS) — page query, owner connection (no RLS filter), last year:')
    console.log(ex.rows.map((x) => '    ' + x['QUERY PLAN']).join('\n'))
  } finally {
    await owner.query('delete from booking_slots where tenant_id=$1', [tenantId])
    await owner.query('delete from bookings where tenant_id=$1', [tenantId])
    await owner.end()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
