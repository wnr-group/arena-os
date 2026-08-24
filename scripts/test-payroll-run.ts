/**
 * Payroll run + payslip generation (AROS-104) — integration tests against a
 * real database.
 *
 * Drives runPayroll() (lib/payroll/run.ts) directly on RLS-scoped
 * transactions through `arena_app`, the same core the server action drives:
 *   - attendance proration (gross = (base+allowances) * daysPresent/daysInPeriod)
 *   - deductions are flat, NOT prorated by attendance
 *   - net pay is floored at 0, never negative
 *   - advance recovery is FIFO (oldest advance first), each clamped to its
 *     own outstanding balance AND to what the payslip can actually afford
 *   - the latest salary structure effective by the period's end is used,
 *     future-dated versions are ignored
 *   - an employee with no salary structure is skipped, not paid ₹0
 *   - a disabled membership is excluded entirely
 *   - re-running an already-run period is rejected outright (idempotency)
 *   - duplicate attendance rows for one day never double-count
 *   - payslips RLS is owner-only, independent of the action layer's guard
 *
 *   npx tsx scripts/test-payroll-run.ts
 */
import { Pool } from 'pg'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { sql } from 'drizzle-orm'
import * as schema from '../db/schema'
import { runPayroll, PayrollError } from '../lib/payroll/run'
import { loadEnv } from './env'

type Db = NodePgDatabase<typeof schema>

let pass = 0,
  fail = 0
const check = (l: string, c: boolean) => {
  console.log(`${c ? '✓' : '✗ FAIL'}  ${l}`)
  if (c) pass++
  else fail++
}

const TZ = 'Asia/Kolkata'
const PERIOD = '2026-08' // 31 days

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

  type Tenant = { tenantId: string; branchId: string; ownerUserId: string; ownerMembershipId: string; managerUserId: string; managerMembershipId: string }

  async function makeTenant(slug: string): Promise<Tenant> {
    const t = await ownerPool.query<{ id: string }>(
      `insert into tenants (slug,name,status,timezone) values ($1,$2,'active',$3)
       on conflict (slug) do update set name=excluded.name returning id`,
      [slug, `${slug} co`, TZ],
    )
    const tenantId = t.rows[0].id
    const b = await ownerPool.query<{ id: string }>(
      `insert into branches (tenant_id,name,is_primary) values ($1,'Main',true)
       on conflict (tenant_id,name) do update set is_primary=true returning id`,
      [tenantId],
    )
    const mkUser = async (email: string, role: string, status = 'active') => {
      const u = await ownerPool.query<{ id: string }>(
        `insert into users (email,password_hash) values ($1,'x')
         on conflict (email) do update set email=excluded.email returning id`,
        [email],
      )
      await ownerPool.query(
        `insert into memberships (tenant_id,user_id,role,status) values ($1,$2,$3,$4)
         on conflict (tenant_id,user_id) do update set role=excluded.role, status=excluded.status`,
        [tenantId, u.rows[0].id, role, status],
      )
      const m = await ownerPool.query<{ id: string }>('select id from memberships where tenant_id=$1 and user_id=$2', [
        tenantId,
        u.rows[0].id,
      ])
      return { userId: u.rows[0].id, membershipId: m.rows[0].id }
    }
    const owner = await mkUser(`owner@${slug}.test`, 'owner')
    const manager = await mkUser(`manager@${slug}.test`, 'manager')
    return {
      tenantId,
      branchId: b.rows[0].id,
      ownerUserId: owner.userId,
      ownerMembershipId: owner.membershipId,
      managerUserId: manager.userId,
      managerMembershipId: manager.membershipId,
    }
  }

  async function makeStaff(t: Tenant, email: string, status = 'active'): Promise<{ userId: string; membershipId: string }> {
    const u = await ownerPool.query<{ id: string }>(
      `insert into users (email,password_hash) values ($1,'x')
       on conflict (email) do update set email=excluded.email returning id`,
      [email],
    )
    await ownerPool.query(
      `insert into memberships (tenant_id,user_id,role,status) values ($1,$2,'floor_staff',$3)
       on conflict (tenant_id,user_id) do update set status=excluded.status`,
      [t.tenantId, u.rows[0].id, status],
    )
    const m = await ownerPool.query<{ id: string }>('select id from memberships where tenant_id=$1 and user_id=$2', [
      t.tenantId,
      u.rows[0].id,
    ])
    return { userId: u.rows[0].id, membershipId: m.rows[0].id }
  }

  async function setStructure(
    t: Tenant,
    membershipId: string,
    effectiveFrom: string,
    base: string,
    allowances: { label: string; amount: string }[] = [],
    deductions: { label: string; amount: string }[] = [],
  ) {
    await ownerPool.query(
      `insert into salary_structures (tenant_id,membership_id,base,allowances,deductions,effective_from)
       values ($1,$2,$3,$4,$5,$6)
       on conflict (membership_id,effective_from) do update set base=excluded.base, allowances=excluded.allowances, deductions=excluded.deductions`,
      [t.tenantId, membershipId, base, JSON.stringify(allowances), JSON.stringify(deductions), effectiveFrom],
    )
  }

  async function markPresent(t: Tenant, membershipId: string, dates: string[]) {
    for (const d of dates) {
      await ownerPool.query(
        `insert into attendance (tenant_id,branch_id,membership_id,work_date,clock_in,clock_out)
         values ($1,$2,$3,$4::date,$5::timestamptz,$5::timestamptz)`,
        [t.tenantId, t.branchId, membershipId, d, `${d}T09:00:00+05:30`],
      )
    }
  }

  async function giveAdvance(t: Tenant, membershipId: string, givenAt: string, amount: string, instalment: string): Promise<string> {
    const r = await ownerPool.query<{ id: string }>(
      `insert into employee_advances (tenant_id,membership_id,amount,instalment_amount,given_at) values ($1,$2,$3,$4,$5) returning id`,
      [t.tenantId, membershipId, amount, instalment, givenAt],
    )
    return r.rows[0].id
  }

  const outstanding = async (advanceId: string) =>
    (
      await ownerPool.query<{ o: string }>(
        `select (a.amount - coalesce((select sum(amount) from employee_advance_recoveries where advance_id=a.id),0))::text o
           from employee_advances a where a.id=$1`,
        [advanceId],
      )
    ).rows[0].o

  const payslipRow = async (membershipId: string, period: string) =>
    (
      await ownerPool.query(
        `select * from payslips where membership_id=$1 and period=$2`,
        [membershipId, period],
      )
    ).rows[0]

  const recoveryRows = async (advanceId: string) =>
    (await ownerPool.query(`select * from employee_advance_recoveries where advance_id=$1 order by created_at`, [advanceId])).rows

  const run = (t: Tenant, period: string, as = t.ownerUserId, actorMembership = t.ownerMembershipId) =>
    withUser(as, (tx) => runPayroll(tx, t.tenantId, period, actorMembership))

  const days = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `2026-08-${String(from + i).padStart(2, '0')}`)

  // ── setup ────────────────────────────────────────────────────────────────
  const T = await makeTenant('testpayroll')
  await ownerPool.query('delete from payslips where tenant_id=$1', [T.tenantId])
  await ownerPool.query('delete from employee_advance_recoveries where tenant_id=$1', [T.tenantId])
  await ownerPool.query('delete from employee_advances where tenant_id=$1', [T.tenantId])
  await ownerPool.query('delete from salary_structures where tenant_id=$1', [T.tenantId])
  await ownerPool.query('delete from attendance where tenant_id=$1', [T.tenantId])
  await ownerPool.query(`delete from memberships where tenant_id=$1 and user_id not in ($2,$3)`, [
    T.tenantId,
    T.ownerUserId,
    T.managerUserId,
  ])

  // ── 0. validation ────────────────────────────────────────────────────────
  {
    let threw = false
    try {
      await run(T, 'not-a-period')
    } catch (e) {
      threw = e instanceof PayrollError && /valid period/i.test(e.message)
    }
    check('V0 an invalid period is rejected before touching the database', threw)
  }

  // ── 1. attendance proration ─────────────────────────────────────────────
  const e1 = await makeStaff(T, 'e1@testpayroll.test')
  {
    await setStructure(T, e1.membershipId, '2026-07-01', '3100.00', [{ label: 'HRA', amount: '620.00' }], [
      { label: 'PF', amount: '200.00' },
    ])
    await markPresent(T, e1.membershipId, days(1, 28)) // 28 of 31 days
  }

  // ── 2. deductions exceed attendance-adjusted gross → floored at 0 ──────
  const e2 = await makeStaff(T, 'e2@testpayroll.test')
  {
    await setStructure(T, e2.membershipId, '2026-07-01', '100.00', [], [{ label: 'Loan EMI', amount: '50.00' }])
    await markPresent(T, e2.membershipId, ['2026-08-01'])
  }

  // ── 3. two advances, FIFO, both fully recovered ─────────────────────────
  const e3 = await makeStaff(T, 'e3@testpayroll.test')
  let adv1: string, adv2: string
  {
    await setStructure(T, e3.membershipId, '2026-07-01', '3100.00')
    await markPresent(T, e3.membershipId, days(1, 31)) // full attendance
    adv1 = await giveAdvance(T, e3.membershipId, '2026-07-01', '500.00', '400.00')
    adv2 = await giveAdvance(T, e3.membershipId, '2026-07-15', '1000.00', '1000.00')
  }

  // ── 4. advance instalment clamped by what the payslip can afford ───────
  const e4 = await makeStaff(T, 'e4@testpayroll.test')
  let adv4: string
  {
    await setStructure(T, e4.membershipId, '2026-07-01', '1000.00', [], [{ label: 'D', amount: '900.00' }])
    await markPresent(T, e4.membershipId, days(1, 31))
    adv4 = await giveAdvance(T, e4.membershipId, '2026-07-01', '5000.00', '2000.00')
  }

  // ── 5. no salary structure → skipped, not paid ₹0 ───────────────────────
  const e5 = await makeStaff(T, 'e5@testpayroll.test')

  // ── 6. disabled membership → excluded entirely ──────────────────────────
  const e6 = await makeStaff(T, 'e6@testpayroll.test', 'disabled')
  await setStructure(T, e6.membershipId, '2026-07-01', '1000.00')

  // ── 7. latest structure effective by period end wins ────────────────────
  const e7 = await makeStaff(T, 'e7@testpayroll.test')
  {
    await setStructure(T, e7.membershipId, '2026-01-01', '1000.00')
    await setStructure(T, e7.membershipId, '2026-08-15', '2000.00') // applies
    await setStructure(T, e7.membershipId, '2026-09-01', '3000.00') // future, ignored
    await markPresent(T, e7.membershipId, days(1, 31))
  }

  // ── 11. duplicate attendance rows for one day never double-count ────────
  const e8 = await makeStaff(T, 'e8@testpayroll.test')
  {
    await setStructure(T, e8.membershipId, '2026-07-01', '3100.00')
    await ownerPool.query(
      `insert into attendance (tenant_id,branch_id,membership_id,work_date,clock_in,clock_out)
       values ($1,$2,$3,'2026-08-01'::date,'2026-08-01T09:00:00+05:30'::timestamptz,'2026-08-01T18:00:00+05:30'::timestamptz),
              ($1,$2,$3,'2026-08-01'::date,'2026-08-01T09:05:00+05:30'::timestamptz,'2026-08-01T18:05:00+05:30'::timestamptz)`,
      [T.tenantId, T.branchId, e8.membershipId],
    )
  }

  // ── run it ────────────────────────────────────────────────────────────────
  const result = await run(T, PERIOD)

  check('R1 seven employees generated (e1,e2,e3,e4,e6-excluded,e7,e8)', result.generated.length === 6)
  check('R1 e5 is skipped, not generated', !result.generated.some((g) => g.membershipId === e5.membershipId))
  check(
    'R1 e5 skipped with the right reason',
    result.skipped.some((s) => s.membershipId === e5.membershipId && /no salary structure/i.test(s.reason)),
  )
  check('R1 e6 (disabled) appears in neither list', !result.generated.some((g) => g.membershipId === e6.membershipId) && !result.skipped.some((s) => s.membershipId === e6.membershipId))
  check('R1 no payslip row exists for e5', !(await payslipRow(e5.membershipId, PERIOD)))
  check('R1 no payslip row exists for e6', !(await payslipRow(e6.membershipId, PERIOD)))

  // ── verify scenario 1 ────────────────────────────────────────────────────
  {
    const p = await payslipRow(e1.membershipId, PERIOD)
    check('S1 days_in_period = 31', p.days_in_period === 31)
    check('S1 days_present = 28', p.days_present === 28)
    check('S1 gross = 3360.00 ((3100+620)*28/31)', p.gross === '3360.00')
    check('S1 deductions_total = 200.00 (flat, not prorated)', p.deductions_total === '200.00')
    check('S1 net_pay = 3160.00', p.net_pay === '3160.00')
    check('S1 allowances snapshot carries the HRA line', p.allowances[0]?.label === 'HRA' && p.allowances[0]?.amount === '620.00')
  }

  // ── verify scenario 2 ────────────────────────────────────────────────────
  {
    const p = await payslipRow(e2.membershipId, PERIOD)
    check('S2 gross = 3.23 (100 * 1/31, rounded)', p.gross === '3.23')
    check('S2 deductions_total stored honestly at 50.00 even though unaffordable', p.deductions_total === '50.00')
    check('S2 net_pay floored at 0.00, never negative', p.net_pay === '0.00')
    check('S2 advance_instalment = 0.00 (nothing to recover from)', p.advance_instalment === '0.00')
  }

  // ── verify scenario 3 ────────────────────────────────────────────────────
  {
    const p = await payslipRow(e3.membershipId, PERIOD)
    check('S3 gross = 3100.00 (full attendance)', p.gross === '3100.00')
    check('S3 advance_instalment = 1400.00 (400 + 1000, both fully recovered)', p.advance_instalment === '1400.00')
    check('S3 net_pay = 1700.00', p.net_pay === '1700.00')
    check('S3 adv1 outstanding now 100.00', (await outstanding(adv1)) === '100.00')
    check('S3 adv2 outstanding now 0.00 (fully repaid)', (await outstanding(adv2)) === '0.00')

    const r1 = await recoveryRows(adv1)
    const r2 = await recoveryRows(adv2)
    check('S3 adv1 got exactly one recovery row of 400.00', r1.length === 1 && r1[0].amount === '400.00')
    check('S3 adv2 got exactly one recovery row of 1000.00', r2.length === 1 && r2[0].amount === '1000.00')
    check("S3 recoveries carry source_type='payroll' and source_id=the payslip", r1[0].source_type === 'payroll' && r1[0].source_id === p.id && r2[0].source_id === p.id)
    check('S3 the older advance (adv1) was recovered before the newer (adv2)', new Date(r1[0].created_at) <= new Date(r2[0].created_at))
  }

  // ── verify scenario 4 ────────────────────────────────────────────────────
  {
    const p = await payslipRow(e4.membershipId, PERIOD)
    check('S4 gross = 1000.00, deductions_total = 900.00 → netBeforeAdvance = 100.00', p.gross === '1000.00' && p.deductions_total === '900.00')
    check('S4 advance_instalment clamped to the 100.00 available, not the 2000.00 instalment', p.advance_instalment === '100.00')
    check('S4 net_pay = 0.00', p.net_pay === '0.00')
    check('S4 advance stays mostly outstanding (4900.00 left)', (await outstanding(adv4)) === '4900.00')
  }

  // ── verify scenario 7 ────────────────────────────────────────────────────
  {
    const p = await payslipRow(e7.membershipId, PERIOD)
    check('S7 uses the 2000.00 structure effective 08-15, not 1000 or the future 3000', p.gross === '2000.00')
  }

  // ── verify scenario 8 ────────────────────────────────────────────────────
  {
    const p = await payslipRow(e8.membershipId, PERIOD)
    check('S8 two attendance rows for the same day still count as 1 day present', p.days_present === 1)
  }

  // ── idempotency ──────────────────────────────────────────────────────────
  {
    let threw = false
    let message = ''
    try {
      await run(T, PERIOD)
    } catch (e) {
      threw = e instanceof PayrollError
      message = e instanceof Error ? e.message : ''
    }
    check('I1 re-running the same period is rejected outright', threw && /already been run/i.test(message))
    const countAfter = await ownerPool.query('select count(*)::int c from payslips where tenant_id=$1 and period=$2', [
      T.tenantId,
      PERIOD,
    ])
    check('I1 the rejected re-run did not touch the payslip count', countAfter.rows[0].c === result.generated.length)
    const recoveriesAfter = await recoveryRows(adv1)
    check('I1 the rejected re-run did not post a second recovery for adv1', recoveriesAfter.length === 1)
  }

  // ── a fresh period is unaffected by the earlier block ───────────────────
  {
    const sep = await run(T, '2026-09')
    check('I2 a different period is unaffected — e1 gets a September payslip too', sep.generated.some((g) => g.membershipId === e1.membershipId))
  }

  // ── RLS, first line: salary_structures is owner-only for SELECT too, so a
  // manager driving runPayroll directly reads zero structures — RLS filters
  // silently rather than erroring, so every employee is just skipped and
  // nothing is ever written. No exception is expected here; the second,
  // independent line of defense (payslips' own owner-only INSERT policy) is
  // proven directly below, since this gate means runPayroll never even
  // reaches an insert when driven as a non-owner.
  {
    const asManager = await run(T, '2026-10', T.managerUserId, T.managerMembershipId)
    check(
      'RLS a MANAGER driving runPayroll directly sees no salary structures, generates nothing',
      asManager.generated.length === 0,
    )
    const octCount = await ownerPool.query('select count(*)::int c from payslips where tenant_id=$1 and period=$2', [
      T.tenantId,
      '2026-10',
    ])
    check('RLS …and no October payslip was written', octCount.rows[0].c === 0)
  }

  // ── RLS, second line: payslips' own owner-only INSERT policy, tested by
  // going around runPayroll entirely with a direct insert as the manager.
  {
    let threw = false
    try {
      await withUser(T.managerUserId, (tx) =>
        tx.execute(
          sql`insert into payslips (tenant_id, membership_id, period, base, gross, days_in_period, days_present)
              values (${T.tenantId}, ${e1.membershipId}, '2026-11', '100.00', '100.00', 30, 30)`,
        ),
      )
    } catch {
      threw = true
    }
    check('RLS payslips_owner_rw refuses a direct MANAGER insert', threw)
    const novCount = await ownerPool.query('select count(*)::int c from payslips where tenant_id=$1 and period=$2', [
      T.tenantId,
      '2026-11',
    ])
    check('RLS …and no row was written', novCount.rows[0].c === 0)
  }

  // ── cleanup ───────────────────────────────────────────────────────────────
  await ownerPool.query('delete from tenants where id = $1', [T.tenantId])
  await ownerPool.query(`delete from users where email like '%@testpayroll.test'`)
  await ownerPool.end()
  await appPool.end()

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
