/**
 * M34 #7 — getEmployeeAnalytics against a real database, as NON-owner DB roles
 * (the app connection is RLS-bound; fixtures use the owner connection to seed).
 *
 *   1. boundaries — tenant in +05:30 and in a DST zone (range spans the spring-
 *                   forward day): a payment / booking at 00:00:00 local on the
 *                   first day and 23:59:59 local on the last day are IN; one
 *                   second either side is OUT. Attendance is keyed on work_date.
 *   2. money      — only 'captured' payments count; another tenant's rows with
 *                   the same instants never leak in
 *   3. roles      — owner and manager read; cashier / receptionist / floor_staff
 *                   are refused
 *   4. range      — invalid / reversed / >366-day input resolves like /reports,
 *                   and every preset survives the shared parser unchanged
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs scripts/test-employee-analytics.ts
 */
import { Pool } from 'pg'
import { loadEnv } from './env'
import { entitleTenant } from './entitle-fixture'
import type { ActiveContext } from '../lib/tenant/context'
import { REPORT_PRESETS, resolvePresetDates } from '../lib/booking/ranges'
import { addDays, zonedTimeToUtc } from '../lib/booking/time'
import { MAX_RANGE_DAYS, daysInRange, resolveDateRange } from '../lib/reports/date-range'

let pass = 0,
  fail = 0
const check = (l: string, c: boolean) => {
  console.log(`${c ? '✓' : '✗ FAIL'}  ${l}`)
  if (c) pass++
  else fail++
}

const IST = 'Asia/Kolkata'
const NY = 'America/New_York' // DST starts Sun 2045-03-12
const ROLES = ['owner', 'manager', 'cashier', 'receptionist', 'floor_staff'] as const

async function main() {
  loadEnv()
  const { getEmployeeAnalytics } = await import('../lib/reports/employees')
  const owner = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })

  const mkTenant = async (slug: string, tz: string) => {
    const t = await owner.query<{ id: string }>(
      `insert into tenants (slug,name,status,timezone) values ($1,$2,'active',$3)
       on conflict (slug) do update set name=excluded.name, timezone=excluded.timezone returning id`,
      [slug, `${slug} co`, tz],
    )
    const tenantId = t.rows[0].id
    const b = await owner.query<{ id: string }>(
      `insert into branches (tenant_id,name,is_primary) values ($1,'Main',true)
       on conflict (tenant_id,name) do update set is_primary=true returning id`,
      [tenantId],
    )
    await entitleTenant(owner, tenantId)
    return { tenantId, slug, tz, branchId: b.rows[0].id }
  }
  type Tenant = Awaited<ReturnType<typeof mkTenant>>

  const mkUser = async (T: Tenant, role: string) => {
    const u = await owner.query<{ id: string }>(
      `insert into users (email,password_hash) values ($1,'x')
       on conflict (email) do update set email=excluded.email returning id`,
      [`${role}@${T.slug}.test`],
    )
    const m = await owner.query<{ id: string }>(
      `insert into memberships (tenant_id,user_id,role,status) values ($1,$2,$3,'active')
       on conflict (tenant_id,user_id) do update set role=excluded.role, status='active' returning id`,
      [T.tenantId, u.rows[0].id, role],
    )
    return { id: u.rows[0].id, membershipId: m.rows[0].id, role }
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
    ist: await mkTenant('testempan-ist', IST),
    ny: await mkTenant('testempan-ny', NY),
    other: await mkTenant('testempan-other', IST),
  }
  const wipe = async (T: Tenant) => {
    await owner.query('delete from payments where tenant_id=$1', [T.tenantId])
    await owner.query('delete from invoices where tenant_id=$1', [T.tenantId])
    await owner.query('delete from bookings where tenant_id=$1', [T.tenantId])
    await owner.query('delete from attendance where tenant_id=$1', [T.tenantId])
  }
  for (const T of Object.values(tenants)) await wipe(T)

  const users: Record<string, Awaited<ReturnType<typeof mkUser>>[]> = {}
  for (const [k, T] of Object.entries(tenants)) users[k] = await Promise.all(ROLES.map((r) => mkUser(T, r)))
  const cashierOf = (k: keyof typeof tenants) => users[k].find((u) => u.role === 'cashier')!

  let seq = 0
  async function invoice(T: Tenant) {
    seq++
    const r = await owner.query<{ id: string }>(
      `insert into invoices (tenant_id,branch_id,invoice_number,status,subtotal,tax_total,total)
       values ($1,$2,$3,'issued','0','0','0') returning id`,
      [T.tenantId, T.branchId, `EA-${T.slug}-${seq}`],
    )
    return r.rows[0].id
  }
  async function pay(T: Tenant, by: string, at: Date, amount: string, status = 'captured') {
    await owner.query(
      `insert into payments (tenant_id,branch_id,invoice_id,method,amount,status,collected_by,created_at)
       values ($1,$2,$3,'cash',$4,$5,$6,$7)`,
      [T.tenantId, T.branchId, await invoice(T), amount, status, by, at],
    )
  }
  async function book(T: Tenant, by: string, at: Date) {
    seq++
    await owner.query(
      `insert into bookings (tenant_id,branch_id,booking_number,status,customer_name,subtotal,total,created_by,created_at)
       values ($1,$2,$3,'confirmed','x','0','0',$4,$5)`,
      [T.tenantId, T.branchId, `EA-${T.slug}-${seq}`, by, at],
    )
  }
  async function attend(T: Tenant, by: string, day: string) {
    await owner.query(
      `insert into attendance (tenant_id,branch_id,membership_id,work_date,clock_in,clock_out)
       values ($1,$2,$3,$4,$5,$6)`,
      [
        T.tenantId,
        T.branchId,
        by,
        day,
        zonedTimeToUtc(day, '09:00', T.tz),
        zonedTimeToUtc(day, '11:00', T.tz),
      ],
    )
  }
  // Local wall-clock instant, second-precision (zonedTimeToUtc takes HH:mm).
  const at = (T: Tenant, day: string, hhmm: string, sec = 0) =>
    new Date(zonedTimeToUtc(day, hhmm, T.tz).getTime() + sec * 1000)

  // ══ 1+2. boundaries & money ══════════════════════════════════════════════
  const cases: [keyof typeof tenants, string, string][] = [
    ['ist', '2045-03-10', '2045-03-12'],
    ['ny', '2045-03-11', '2045-03-12'], // spans 2am→3am spring-forward
  ]
  for (const [k, from, to] of cases) {
    const T = tenants[k]
    console.log(`\n── ${T.tz}: ${from} .. ${to} ──`)
    const cashier = cashierOf(k)
    const before = addDays(from, -1)
    const after = addDays(to, 1)

    await pay(T, cashier.membershipId, at(T, from, '00:00'), '100.00') // IN  first instant
    await pay(T, cashier.membershipId, at(T, to, '23:59', 59), '200.00') // IN  last second
    await pay(T, cashier.membershipId, at(T, before, '23:59', 59), '1000.00') // OUT 1s before
    await pay(T, cashier.membershipId, at(T, after, '00:00'), '2000.00') // OUT exactly end
    await pay(T, cashier.membershipId, at(T, from, '12:00'), '4000.00', 'pending') // OUT not captured
    await pay(T, cashier.membershipId, at(T, from, '12:00'), '8000.00', 'failed') // OUT not captured

    await book(T, cashier.membershipId, at(T, from, '00:00'))
    await book(T, cashier.membershipId, at(T, to, '23:59', 59))
    await book(T, cashier.membershipId, at(T, before, '23:59', 59))
    await book(T, cashier.membershipId, at(T, after, '00:00'))

    await attend(T, cashier.membershipId, from)
    await attend(T, cashier.membershipId, to)
    await attend(T, cashier.membershipId, before)
    await attend(T, cashier.membershipId, after)

    const mgr = users[k].find((u) => u.role === 'manager')!
    const rows = await getEmployeeAnalytics(ctxFor(T, mgr, 'manager'), from, to)
    const mine = rows.find((r) => r.membershipId === cashier.membershipId)!
    check('sales: 00:00:00 first day + 23:59:59 last day in, ±1s out, non-captured out', mine.salesCollected === 300)
    check('bookings: same boundaries', mine.bookingsCreated === 2)
    check('attendance: first + last work_date in, neighbours out', mine.daysPresent === 2)
    check('hours: 2 present days × 2h', Math.abs(mine.hoursWorked - 4) < 1e-9)
    check('only this tenant’s members listed', rows.length === ROLES.length)

    // One day wide: exactly the first day.
    const one = await getEmployeeAnalytics(ctxFor(T, mgr, 'manager'), from, from)
    const m1 = one.find((r) => r.membershipId === cashier.membershipId)!
    check('single-day range: only that day’s 00:00:00 payment/booking', m1.salesCollected === 100 && m1.bookingsCreated === 1)
  }

  // Another tenant with rows at the same instants must not leak.
  {
    const T = tenants.other
    const c = cashierOf('other')
    await pay(T, c.membershipId, at(T, '2045-03-10', '00:00'), '555.00')
    await book(T, c.membershipId, at(T, '2045-03-10', '00:00'))
    const I = tenants.ist
    const mgr = users.ist.find((u) => u.role === 'manager')!
    const rows = await getEmployeeAnalytics(ctxFor(I, mgr, 'manager'), '2045-03-10', '2045-03-12')
    check('other tenant’s payments/bookings never counted', rows.reduce((s, r) => s + r.salesCollected, 0) === 300)
    check('other tenant’s members never listed', !rows.some((r) => r.membershipId === c.membershipId))
  }

  // ══ 3. roles ═════════════════════════════════════════════════════════════
  console.log('\n── roles ──')
  for (const u of users.ist) {
    const allowed = u.role === 'owner' || u.role === 'manager'
    let ok = false
    try {
      await getEmployeeAnalytics(ctxFor(tenants.ist, u, u.role), '2045-03-10', '2045-03-12')
      ok = true
    } catch {
      ok = false
    }
    check(`${u.role} ${allowed ? 'can read' : 'is refused'}`, ok === allowed)
  }

  // ══ 4. range parsing, shared with /reports ═══════════════════════════════
  console.log('\n── range parsing ──')
  {
    const now = new Date('2045-04-20T12:00:00Z')
    const r = (start: unknown, end: unknown) => resolveDateRange({ start, end }, { timeZone: IST, now })
    check('no params: last 30 days ending tenant today', JSON.stringify(r(undefined, undefined)) === JSON.stringify({ start: '2045-03-22', end: '2045-04-20' }))
    check('garbage dates fall back to default', JSON.stringify(r('nope', '2045-02-30')) === JSON.stringify(r(undefined, undefined)))
    check('reversed collapses to one day', JSON.stringify(r('2045-04-10', '2045-04-01')) === JSON.stringify({ start: '2045-04-01', end: '2045-04-01' }))
    const wide = r('2000-01-01', '2045-04-20')
    check(`>${MAX_RANGE_DAYS} days clamped, end kept`, daysInRange(wide) === MAX_RANGE_DAYS && wide.end === '2045-04-20')
    let allSame = true
    for (const tz of [IST, NY]) {
      const today = resolveDateRange({}, { timeZone: tz, now }).end
      for (const p of REPORT_PRESETS) {
        const d = resolvePresetDates(p, today)
        const got = resolveDateRange({ start: d.fromDate, end: d.toDate }, { timeZone: tz, now })
        if (got.start !== d.fromDate || got.end !== d.toDate) allSame = false
      }
    }
    check('every preset survives resolveDateRange unchanged', allSame)
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
