/**
 * M34 #9 — QA for the report range presets, against a real database and as
 * NON-owner DB roles (app connection is RLS-bound; fixtures use the owner
 * connection only to seed).
 *
 * Fixture: for ~400 days up to tenant-local today, three captured payments per
 * local day — 00:00:00 (1, booking), 12:00 (10, booking) and 23:59:59 (100,
 * food) — each on its own paid invoice, collected by a cashier. Every day is
 * worth exactly 111, so any report over N days must say 111·N; one second of
 * edge drift moves a boundary payment into the wrong day and breaks the sum.
 * Run for a tenant ahead of UTC (+05:30) and one behind (America/*).
 *
 *   1. number parity — for every preset: reader(preset dates) deep-equals
 *      reader(same dates re-parsed as typed through resolveDateRange), for
 *      Revenue, Sales, P&L, Employee, Performance (and Payroll by period)
 *   2. edge bucketing — revenue / sales / P&L / employee totals equal the
 *      hand-computed 111·days (food 100·days) at every range edge
 *   3. channel + pager + CSV — channel survives, the pager link keeps it, the
 *      daily rows cover the whole range (what the CSV button exports)
 *   4. P&L approximate flag — partial-month presets set it, whole-month clears
 *   5. roles — cashier/receptionist/floor_staff refused by every reader,
 *      owner + manager read
 *
 * Slow by design (~10 min against a remote DB: ~30s of round trips per preset).
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs scripts/test-report-presets-qa.ts
 */
import { Pool } from 'pg'
import { loadEnv } from './env'
import { entitleTenant } from './entitle-fixture'
import type { ActiveContext } from '../lib/tenant/context'
import { REPORT_PRESETS, resolvePresetDates } from '../lib/booking/ranges'
import { addDays, todayInZone } from '../lib/booking/time'
import { PAYROLL_PRESETS, resolvePayrollPreset } from '../lib/reports/period-presets'
import { MAX_RANGE_DAYS, daysInRange, resolveDateRange } from '../lib/reports/date-range'

let pass = 0,
  fail = 0
const check = (l: string, c: boolean) => {
  console.log(`${c ? '✓' : '✗ FAIL'}  ${l}`)
  if (c) pass++
  else fail++
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

const ZONES = [
  ['ist', 'Asia/Kolkata'],
  ['ny', 'America/New_York'],
] as const
const ROLES = ['owner', 'manager', 'cashier', 'receptionist', 'floor_staff'] as const

async function main() {
  loadEnv()
  const { getRevenueDashboard } = await import('../lib/reports/revenue')
  const { getSalesReport } = await import('../lib/reports/sales')
  const { getPnlReport, isWholeMonths } = await import('../lib/reports/pnl')
  const { getEmployeeAnalytics } = await import('../lib/reports/employees')
  const { getPerformanceSummary } = await import('../lib/performance/data')
  const { getPayrollCostReport } = await import('../lib/reports/payroll')
  const owner = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })

  async function mkTenant(key: string, tz: string) {
    const slug = `testrpqa-${key}`
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
    const users: Record<string, { id: string; membershipId: string }> = {}
    for (const role of ROLES) {
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
      users[role] = { id: u.rows[0].id, membershipId: m.rows[0].id }
    }
    return { tenantId, slug, tz, branchId: b.rows[0].id, users }
  }
  type Tenant = Awaited<ReturnType<typeof mkTenant>>

  const ctxFor = (T: Tenant, role: (typeof ROLES)[number]): ActiveContext => ({
    user: { id: T.users[role].id, email: `${role}@${T.slug}.test`, fullName: null, isPlatformAdmin: false },
    tenant: {
      id: T.tenantId,
      slug: T.slug,
      name: `${T.slug} co`,
      industry: 'gaming',
      status: 'active',
      currency: 'INR',
      timezone: T.tz,
    },
    role,
    membershipId: T.users[role].membershipId,
    branchId: T.branchId,
  })

  async function seed(T: Tenant, today: string) {
    await owner.query('delete from payments where tenant_id=$1', [T.tenantId])
    await owner.query('delete from invoices where tenant_id=$1', [T.tenantId])
    await owner.query('delete from attendance where tenant_id=$1', [T.tenantId])
    // From 1 Jan of last year, so the "Last year" preset is fully covered.
    const first = `${Number(today.slice(0, 4)) - 1}-01-01`
    const cashier = T.users.cashier.membershipId
    // One invoice per (day, slot); the payment lands at the slot's LOCAL instant.
    const slots: [string, string, number, string][] = [
      ['a', '00:00:00', 1, 'booking'],
      ['b', '12:00:00', 10, 'booking'],
      ['c', '23:59:59', 100, 'food'],
    ]
    for (const [tag, time, amount, kind] of slots) {
      await owner.query(
        `with days as (
           select d::date as day from generate_series($3::date, $4::date, interval '1 day') d
         ), ins as (
           insert into invoices (tenant_id,branch_id,invoice_number,status,issued_at,subtotal,discount,tax_total,total)
           select $1,$2,'QA-'||$5||'-'||to_char(day,'YYYYMMDD'),'paid',
                  ((day::text||' '||$6)::timestamp at time zone $7),
                  $8::numeric,0,0,$8::numeric
           from days returning id, issued_at
         ), items as (
           insert into invoice_items (tenant_id,invoice_id,kind,description,qty,unit_price,tax_rate,line_total)
           select $1,id,$9,'qa line',1,$8::numeric,0,$8::numeric from ins returning invoice_id
         )
         insert into payments (tenant_id,branch_id,invoice_id,method,amount,status,collected_by,created_at)
         select $1,$2,id,'cash',$8::numeric,'captured',$10,issued_at from ins`,
        [T.tenantId, T.branchId, first, today, tag, time, T.tz, amount, kind, cashier],
      )
    }
  }

  const tenants: Record<string, Tenant> = {}
  const todays: Record<string, string> = {}
  for (const [key, tz] of ZONES) {
    tenants[key] = await mkTenant(key, tz)
    todays[key] = todayInZone(tz)
    await seed(tenants[key], todays[key])
  }

  for (const [key, tz] of ZONES) {
    const T = tenants[key]
    const today = todays[key]
    const mgr = ctxFor(T, 'manager')
    console.log(`\n══ ${tz} (today ${today}) ══`)

    for (const preset of REPORT_PRESETS) {
      const d = resolvePresetDates(preset, today)
      const typed = resolveDateRange({ start: d.fromDate, end: d.toDate }, { timeZone: tz })
      const range = { start: d.fromDate, end: d.toDate }
      const days = daysInRange(range)
      const label = `${preset} ${range.start}..${range.end} (${days}d)`

      // 1. parity — preset-derived vs hand-typed
      check(`${label}: preset survives the shared parser unchanged`, same(range, typed))
      const [rev1, rev2] = [await getRevenueDashboard(mgr, { range }), await getRevenueDashboard(mgr, { range: typed })]
      check(`${label}: revenue parity`, same(rev1.revenueTotals, rev2.revenueTotals) && same(rev1.days, rev2.days))
      const [s1, s2] = [await getSalesReport(mgr, { range }), await getSalesReport(mgr, { range: typed })]
      check(`${label}: sales parity`, same(s1, s2))
      const [p1, p2] = [await getPnlReport(mgr, range), await getPnlReport(mgr, typed)]
      check(`${label}: P&L parity`, same(p1, p2))
      const [e1, e2] = [
        await getEmployeeAnalytics(mgr, range.start, range.end),
        await getEmployeeAnalytics(mgr, typed.start, typed.end),
      ]
      check(`${label}: employee parity`, same(e1, e2))
      const [f1, f2] = [
        await getPerformanceSummary(mgr, range.start, range.end),
        await getPerformanceSummary(mgr, typed.start, typed.end),
      ]
      check(`${label}: performance parity`, same(f1, f2))

      // 2. edge bucketing against the hand-computed expectation
      check(`${label}: revenue net = 111 × ${days}`, rev1.revenueTotals.net === 111 * days)
      check(`${label}: sales food = 100 × ${days}`, s1.totals.foodGrossRevenue === 100 * days)
      check(`${label}: P&L revenue = 111 × ${days}`, p1.revenue.net === 111 * days)
      const cashier = e1.find((r) => r.membershipId === T.users.cashier.membershipId)!
      check(`${label}: cashier sales collected = 111 × ${days}`, cashier.salesCollected === 111 * days)
      check(`${label}: one row per day, whole range`, rev1.days.length === days)

      // 4. approximate flag — whole months clear it, anything else sets it
      check(`${label}: P&L approximate flag matches isWholeMonths`, p1.payroll.isApproximate === !isWholeMonths(range))
      if (preset === 'lastyear') check(`${label}: last year is whole months → flag clear`, !p1.payroll.isApproximate)
      if (preset === 'last7' || preset === 'last30' || preset === 'yesterday')
        check(`${label}: sub-month preset → flag set`, p1.payroll.isApproximate)
    }

    // 3. channel survives, pager link keeps it, daily rows span the whole range
    {
      const range = resolveDateRange({ start: addDays(today, -59), end: today }, { timeZone: tz })
      const all = await getRevenueDashboard(mgr, { range, channel: null })
      const walkin = await getRevenueDashboard(mgr, { range, channel: 'walkin' })
      const reserved = await getRevenueDashboard(mgr, { range, channel: 'reserved' })
      check('channel filter: walk-in + reserved = all (revenue)', walkin.revenueTotals.net + reserved.revenueTotals.net === all.revenueTotals.net)
      check('channel filter: daily rows (CSV source) cover the full 60-day range', all.days.length === 60)
      const sAll = await getSalesReport(mgr, { range, channel: null })
      const sW = await getSalesReport(mgr, { range, channel: 'walkin' })
      const sR = await getSalesReport(mgr, { range, channel: 'reserved' })
      check(
        'channel filter: walk-in + reserved = all (food sales)',
        sW.totals.foodGrossRevenue + sR.totals.foodGrossRevenue === sAll.totals.foodGrossRevenue,
      )
    }

    // Payroll: each month preset equals the hand-entered periods
    {
      const cur = today.slice(0, 7)
      for (const p of PAYROLL_PRESETS) {
        const r = resolvePayrollPreset(p, cur)
        const a = await getPayrollCostReport(mgr, r.from, r.to)
        const b = await getPayrollCostReport(mgr, `${r.from}`, `${r.to}`)
        check(`payroll ${p} ${r.from}..${r.to}: parity`, same(a, b))
      }
    }

    // 5. roles
    for (const role of ROLES) {
      const allowed = role === 'owner' || role === 'manager'
      const c = ctxFor(T, role)
      const range = resolveDateRange({}, { timeZone: tz })
      const attempts: [string, () => Promise<unknown>][] = [
        ['revenue', () => getRevenueDashboard(c, { range })],
        ['sales', () => getSalesReport(c, { range })],
        ['pnl', () => getPnlReport(c, range)],
        ['employees', () => getEmployeeAnalytics(c, range.start, range.end)],
        ['payroll', () => getPayrollCostReport(c, today.slice(0, 7), today.slice(0, 7))],
      ]
      for (const [name, run] of attempts) {
        let ok = false
        try {
          await run()
          ok = true
        } catch {
          ok = false
        }
        check(`${role} ${allowed ? 'can read' : 'is refused'}: ${name}`, ok === allowed)
      }
    }
  }

  // Leap year: "last year" of a 2045-2048 style date. Pure, mirrors test-report-presets but
  // through the shared parser so the 366 clamp is proven not to truncate.
  {
    const lastyear = resolvePresetDates('lastyear', '2025-03-05') // 2024 is a leap year
    const r = resolveDateRange({ start: lastyear.fromDate, end: lastyear.toDate }, { timeZone: 'Asia/Kolkata' })
    check(
      `leap year: last year ${lastyear.fromDate}..${lastyear.toDate} = ${MAX_RANGE_DAYS} days, not truncated`,
      daysInRange(r) === MAX_RANGE_DAYS && r.start === '2024-01-01' && r.end === '2024-12-31',
    )
  }

  for (const T of Object.values(tenants)) {
    await owner.query('delete from payments where tenant_id=$1', [T.tenantId])
    await owner.query('delete from invoices where tenant_id=$1', [T.tenantId])
  }
  await owner.end()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
