/**
 * Payslip self-view (AROS-105) — integration tests against a real database.
 *
 * lib/payroll/payslips.ts is a 'server-only' page reader (like
 * lib/billing/data.ts), not meant to be driven from a script — so, like
 * scripts/verify-rls.ts, this proves the RLS policies from
 * 0030_payslips_self_view.sql directly with the same shape of query the
 * reader runs, scoped as different actors via withUser():
 *   - a staff member sees ONLY their own payslips
 *   - a staff member selecting another employee's payslip id gets zero rows,
 *     the same "leaks nothing" shape as the invoice receipt page
 *   - owner AND manager can select every employee's payslip
 *   - INSERT is still owner-only — unchanged from AROS-104, re-verified here
 *     because 0030 replaced the policy that used to guarantee it
 *
 *   npx tsx scripts/test-payslip-view.ts
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
const PERIOD = '2026-08'

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

  type Tenant = {
    tenantId: string
    branchId: string
    ownerUserId: string
    ownerMembershipId: string
    managerUserId: string
    managerMembershipId: string
  }

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
      `insert into salary_structures (tenant_id,membership_id,base,effective_from) values ($1,$2,$3,'2026-07-01')
       on conflict (membership_id,effective_from) do update set base=excluded.base`,
      [t.tenantId, membershipId, base],
    )
  }

  // ── setup ────────────────────────────────────────────────────────────────
  const T = await makeTenant('testpayview')
  await ownerPool.query('delete from payslips where tenant_id=$1', [T.tenantId])
  await ownerPool.query('delete from salary_structures where tenant_id=$1', [T.tenantId])
  await ownerPool.query(`delete from memberships where tenant_id=$1 and user_id not in ($2,$3)`, [
    T.tenantId,
    T.ownerUserId,
    T.managerUserId,
  ])

  const staffA = await makeStaff(T, 'a@testpayview.test')
  const staffB = await makeStaff(T, 'b@testpayview.test')
  await setStructure(T, staffA.membershipId, '3000.00')
  await setStructure(T, staffB.membershipId, '4000.00')

  const result = await withUser(T.ownerUserId, (tx) => runPayroll(tx, T.tenantId, PERIOD, T.ownerMembershipId))
  check('setup: payroll ran, at least A and B got payslips', result.generated.length >= 2)

  const idFor = async (membershipId: string) =>
    (await ownerPool.query<{ id: string }>('select id from payslips where tenant_id=$1 and membership_id=$2 and period=$3', [
      T.tenantId,
      membershipId,
      PERIOD,
    ])).rows[0].id

  const payslipAId = await idFor(staffA.membershipId)
  const payslipBId = await idFor(staffB.membershipId)

  // Same shape of query listMyPayslips()/getPayslipById() run — what matters
  // for this ticket is that the ROWS returned differ by actor, which is the
  // RLS policies' job, not application code's.
  const myPayslips = (userId: string) =>
    withUser(userId, (tx) =>
      tx.execute<{ id: string }>(
        sql`select id from payslips where tenant_id = ${T.tenantId} order by period desc`,
      ),
    ).then((r) => r.rows.map((row) => row.id))

  const payslipById = (userId: string, id: string) =>
    withUser(userId, (tx) =>
      tx.execute<{ id: string }>(sql`select id from payslips where tenant_id = ${T.tenantId} and id = ${id}`),
    ).then((r) => r.rows[0]?.id ?? null)

  // ── staff A: sees only their own ────────────────────────────────────────
  {
    const mine = await myPayslips(staffA.userId)
    check("A: sees exactly A's own payslip", mine.length === 1 && mine[0] === payslipAId)

    const own = await payslipById(staffA.userId, payslipAId)
    check('A: can select their own payslip by id', own === payslipAId)

    const others = await payslipById(staffA.userId, payslipBId)
    check("A: selecting B's id returns zero rows (RLS, not a 403)", others === null)
  }

  // ── staff B: sees only their own ────────────────────────────────────────
  {
    const mine = await myPayslips(staffB.userId)
    check("B: sees exactly B's own payslip", mine.length === 1 && mine[0] === payslipBId)

    const others = await payslipById(staffB.userId, payslipAId)
    check("B: selecting A's id returns zero rows", others === null)
  }

  // ── owner: sees everyone's ──────────────────────────────────────────────
  {
    const all = await myPayslips(T.ownerUserId)
    check('Owner: sees both A and B', all.includes(payslipAId) && all.includes(payslipBId))

    const a = await payslipById(T.ownerUserId, payslipAId)
    const b = await payslipById(T.ownerUserId, payslipBId)
    check("Owner: can select both A's and B's payslip by id", a === payslipAId && b === payslipBId)
  }

  // ── manager: sees everyone's too ────────────────────────────────────────
  {
    const all = await myPayslips(T.managerUserId)
    check('Manager: sees both A and B', all.includes(payslipAId) && all.includes(payslipBId))

    const a = await payslipById(T.managerUserId, payslipAId)
    check("Manager: can select A's payslip by id", a === payslipAId)
  }

  // ── unknown id still returns zero rows, not an error ────────────────────
  {
    const UUID = '00000000-0000-4000-8000-000000000000'
    const none = await payslipById(T.ownerUserId, UUID)
    check('Owner: an unknown payslip id returns zero rows, not an error', none === null)
  }

  // ── write side unchanged: manager still cannot post a payslip directly ──
  {
    let threw = false
    try {
      await withUser(T.managerUserId, (tx) =>
        tx.execute(
          sql`insert into payslips (tenant_id, membership_id, period, base, gross, days_in_period, days_present)
              values (${T.tenantId}, ${staffA.membershipId}, '2026-09', '100.00', '100.00', 30, 30)`,
        ),
      )
    } catch {
      threw = true
    }
    check('Write: a MANAGER direct insert is still refused (payslips_owner_insert)', threw)
  }

  // ── cleanup ───────────────────────────────────────────────────────────────
  await ownerPool.query('delete from tenants where id = $1', [T.tenantId])
  await ownerPool.query(`delete from users where email like '%@testpayview.test'`)
  await ownerPool.end()
  await appPool.end()

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
