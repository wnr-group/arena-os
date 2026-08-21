/**
 * Payroll Cost Report (M11, fifth ticket) — integration tests against a real
 * database.
 *
 * lib/reports/payroll.ts is a 'server-only' page reader, so — same as
 * scripts/test-payslip-view.ts — this drives the underlying aggregate query
 * directly via withUser() rather than importing the reader, and checks:
 *   - the report reconciles: totals equal the sum of the payslips that
 *     actually exist for the range (the ticket's "Done when")
 *   - a period range correctly includes/excludes payslips at its edges
 *   - one employee's payslips across two different months sum correctly
 *   - RLS: a manager/owner sees every employee; a plain staff member's own
 *     query (payslips_self_select) only ever returns their own row — never
 *     another tenant's or another employee's, even though this reader has
 *     no role check of its own
 *
 *   npx tsx scripts/test-payroll-cost-report.ts
 */
import { Pool } from 'pg'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { sql } from 'drizzle-orm'
import * as schema from '../db/schema'
import { runPayroll } from '../lib/payroll/run'
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

type ReportRow = {
  membership_id: string
  payslip_count: number
  total_gross: number
  total_deductions: number
  total_advance_recovered: number
  total_net_pay: number
}

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

  // Mirrors getPayrollCostReport()'s query exactly, scoped by whoever's
  // app.user_id is set — RLS decides which rows come back, not this SQL.
  const reportFor = async (userId: string, tenantId: string, from: string, to: string): Promise<ReportRow[]> =>
    withUser(userId, (tx) =>
      tx
        .execute<ReportRow>(
          sql`select membership_id,
                     count(*)::int as payslip_count,
                     coalesce(sum(gross), 0)::float as total_gross,
                     coalesce(sum(deductions_total), 0)::float as total_deductions,
                     coalesce(sum(advance_instalment), 0)::float as total_advance_recovered,
                     coalesce(sum(net_pay), 0)::float as total_net_pay
                from payslips
               where tenant_id = ${tenantId} and period >= ${from} and period <= ${to}
               group by membership_id`,
        )
        .then((r) => r.rows),
    )

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
    const mkUser = async (email: string, role: string) => {
      const u = await ownerPool.query<{ id: string }>(
        `insert into users (email,password_hash) values ($1,'x')
         on conflict (email) do update set email=excluded.email returning id`,
        [email],
      )
      await ownerPool.query(
        `insert into memberships (tenant_id,user_id,role,status) values ($1,$2,$3,'active')
         on conflict (tenant_id,user_id) do update set role=excluded.role, status='active'`,
        [tenantId, u.rows[0].id, role],
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

  async function makeStaff(t: Tenant, email: string): Promise<{ userId: string; membershipId: string }> {
    const u = await ownerPool.query<{ id: string }>(
      `insert into users (email,password_hash) values ($1,'x')
       on conflict (email) do update set email=excluded.email returning id`,
      [email],
    )
    await ownerPool.query(
      `insert into memberships (tenant_id,user_id,role,status) values ($1,$2,'floor_staff','active')
       on conflict (tenant_id,user_id) do update set status='active'`,
      [t.tenantId, u.rows[0].id],
    )
    const m = await ownerPool.query<{ id: string }>('select id from memberships where tenant_id=$1 and user_id=$2', [
      t.tenantId,
      u.rows[0].id,
    ])
    return { userId: u.rows[0].id, membershipId: m.rows[0].id }
  }

  async function setStructure(t: Tenant, membershipId: string, base: string) {
    await ownerPool.query(
      `insert into salary_structures (tenant_id,membership_id,base,effective_from) values ($1,$2,$3,'2026-01-01')
       on conflict (membership_id,effective_from) do update set base=excluded.base`,
      [t.tenantId, membershipId, base],
    )
  }

  // ── setup ────────────────────────────────────────────────────────────────
  const T = await makeTenant('testpayrollcost')
  await ownerPool.query('delete from payslips where tenant_id=$1', [T.tenantId])
  await ownerPool.query('delete from salary_structures where tenant_id=$1', [T.tenantId])
  await ownerPool.query(`delete from memberships where tenant_id=$1 and user_id not in ($2,$3)`, [
    T.tenantId,
    T.ownerUserId,
    T.managerUserId,
  ])

  const staffA = await makeStaff(T, 'a@testpayrollcost.test')
  const staffB = await makeStaff(T, 'b@testpayrollcost.test')
  await setStructure(T, staffA.membershipId, '3000.00')
  await setStructure(T, staffB.membershipId, '4000.00')

  // Three consecutive months so a range query has an edge to exclude and an
  // employee (A) has payslips in two different months to sum across.
  const june = await withUser(T.ownerUserId, (tx) => runPayroll(tx, T.tenantId, '2026-06', T.ownerMembershipId))
  const july = await withUser(T.ownerUserId, (tx) => runPayroll(tx, T.tenantId, '2026-07', T.ownerMembershipId))
  const august = await withUser(T.ownerUserId, (tx) => runPayroll(tx, T.tenantId, '2026-08', T.ownerMembershipId))
  check('setup: three payroll runs each generated payslips', june.generated.length > 0 && july.generated.length > 0 && august.generated.length > 0)

  // ── reconciliation: report totals match the raw payslip rows ───────────
  {
    const raw = await ownerPool.query<{ n: string }>(
      `select coalesce(sum(net_pay),0)::text n from payslips where tenant_id=$1 and period in ('2026-06','2026-07','2026-08')`,
      [T.tenantId],
    )
    const report = await reportFor(T.ownerUserId, T.tenantId, '2026-06', '2026-08')
    const reportTotal = report.reduce((sum, r) => sum + r.total_net_pay, 0)
    check('R1 report total net pay reconciles with the sum of raw payslips', Math.abs(reportTotal - Number(raw.rows[0].n)) < 0.005)
  }

  // ── one employee, two months, summed correctly ──────────────────────────
  {
    const raw = await ownerPool.query<{ n: string }>(
      `select coalesce(sum(net_pay),0)::text n from payslips where tenant_id=$1 and membership_id=$2 and period in ('2026-06','2026-07')`,
      [T.tenantId, staffA.membershipId],
    )
    const report = await reportFor(T.ownerUserId, T.tenantId, '2026-06', '2026-07')
    const rowA = report.find((r) => r.membership_id === staffA.membershipId)
    check('R2 A\'s two-month total matches the sum of A\'s June + July payslips', !!rowA && Math.abs(rowA.total_net_pay - Number(raw.rows[0].n)) < 0.005)
    check('R2 A has exactly 2 payslips counted in the two-month range', rowA?.payslip_count === 2)
  }

  // ── range edges: August excluded when to='2026-07' ──────────────────────
  {
    const report = await reportFor(T.ownerUserId, T.tenantId, '2026-01', '2026-07')
    const rowA = report.find((r) => r.membership_id === staffA.membershipId)
    check('R3 August is excluded when the range ends at July (count stays at 2, not 3)', rowA?.payslip_count === 2)
  }

  // ── single-month range ───────────────────────────────────────────────────
  {
    const report = await reportFor(T.ownerUserId, T.tenantId, '2026-08', '2026-08')
    check('R4 a single-month range (from=to) returns both employees', report.length === 2)
    check('R4 …each with exactly 1 payslip counted', report.every((r) => r.payslip_count === 1))
  }

  // ── RLS: owner and manager both see every employee ──────────────────────
  {
    const asOwner = await reportFor(T.ownerUserId, T.tenantId, '2026-06', '2026-08')
    const asManager = await reportFor(T.managerUserId, T.tenantId, '2026-06', '2026-08')
    check('R5 owner sees both A and B', asOwner.some((r) => r.membership_id === staffA.membershipId) && asOwner.some((r) => r.membership_id === staffB.membershipId))
    check('R5 manager sees both A and B too', asManager.some((r) => r.membership_id === staffA.membershipId) && asManager.some((r) => r.membership_id === staffB.membershipId))
  }

  // ── RLS: a plain staff member's own query only ever returns their own row,
  // even though this reader has no role check — the page guard is a UX
  // convenience, RLS is the actual boundary. ─────────────────────────────
  {
    const asStaffA = await reportFor(staffA.userId, T.tenantId, '2026-06', '2026-08')
    check('R6 staff A driving the same query directly gets ONLY their own row', asStaffA.length === 1 && asStaffA[0].membership_id === staffA.membershipId)
  }

  // ── cleanup ───────────────────────────────────────────────────────────────
  await ownerPool.query('delete from tenants where id = $1', [T.tenantId])
  await ownerPool.query(`delete from users where email like '%@testpayrollcost.test'`)
  await ownerPool.end()
  await appPool.end()

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
