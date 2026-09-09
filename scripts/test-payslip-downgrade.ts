/**
 * Already-issued payslips survive a downgrade.
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs \
 *           --import ./scripts/next-runtime-hook.mjs \
 *           scripts/test-payslip-downgrade.ts
 *
 * ── The boundary this pins ──────────────────────────────────────────────────
 *
 * M16's module gates ask "does this business's plan include Payroll?". That is
 * the right question for GENERATING payroll and for the manager's payroll
 * console. It is the wrong question for an employee opening a payslip they were
 * already issued: they are not the party that chose the plan, and a payslip is
 * their own financial document — routinely needed for a loan, a visa or a tax
 * filing. Gating the self-service read meant a tenant downgrading, or simply
 * lapsing, retroactively cut every member of staff off from their salary
 * records.
 *
 * So the line is drawn between generating and reading-your-own:
 *
 *   GATED     runPayrollForPeriod, salary structures, advances (all writes)
 *   GATED     listPayrollPeriods, listPayslipsForPeriod  (manager console)
 *   UNGATED   listMyPayslips, getPayslipById             (own records)
 *
 * Every one of those is asserted below, on ONE tenant moved from a
 * payroll-enabled plan to a payroll-less one — because the property is about
 * what happens ACROSS the downgrade, and checking either side alone would miss
 * a gate that never fired or one that never lifted.
 *
 * RLS is untouched and is still the boundary that decides WHOSE payslip is
 * readable; the last section proves removing the plan check did not widen it.
 */
import { randomBytes } from 'crypto'
import { Pool } from 'pg'
import { loadEnv } from './env'

loadEnv()

let pass = 0
let fail = 0
const check = (label: string, cond: boolean) => {
  console.log(`${cond ? '✓' : '✗ FAIL'}  ${label}`)
  if (cond) pass++
  else fail++
}
const section = (s: string) => console.log(`\n── ${s} ──`)

/** null when it ran, the message when it threw. */
async function refusal(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn()
    return null
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}

async function main() {
  const { listMyPayslips, getPayslipById, listPayslipsForPeriod, listPayrollPeriods } =
    await import('../lib/payroll/payslips')

  const owner = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })
  const tag = randomBytes(3).toString('hex')

  // ── a tenant, an owner, and two ordinary employees ────────────────────────
  const t = await owner.query<{ id: string }>(
    `insert into tenants (slug, name, status) values ($1,'downgrade co','active') returning id`,
    [`dg${tag}`],
  )
  const tenantId = t.rows[0].id
  const br = await owner.query<{ id: string }>(
    `insert into branches (tenant_id, name, is_primary) values ($1,'Main',true) returning id`,
    [tenantId],
  )
  const branchId = br.rows[0].id

  async function member(label: string, role: string) {
    const u = await owner.query<{ id: string }>(
      `insert into users (email, password_hash, full_name) values ($1,'x',$2) returning id`,
      [`${label}-${tag}@example.test`, label],
    )
    const m = await owner.query<{ id: string }>(
      `insert into memberships (tenant_id, user_id, branch_id, role, status, full_name, email)
       values ($1,$2,$3,$4,'active',$5,$6) returning id`,
      [tenantId, u.rows[0].id, branchId, role, label, `${label}-${tag}@example.test`],
    )
    return { userId: u.rows[0].id, membershipId: m.rows[0].id }
  }

  const boss = await member('boss', 'owner')
  const staff = await member('staff', 'cashier')
  const other = await member('other', 'cashier')

  const ctxFor = (who: { userId: string; membershipId: string }, role: string) =>
    ({
      user: { id: who.userId, email: 'x@example.test', isPlatformAdmin: false },
      tenant: {
        id: tenantId,
        slug: `dg${tag}`,
        name: 'downgrade co',
        status: 'active',
        currency: 'INR',
        timezone: 'Asia/Kolkata',
        industry: 'gaming_cafe',
      },
      role,
      membershipId: who.membershipId,
      branchId,
    }) as unknown as Parameters<typeof listMyPayslips>[0]

  const staffCtx = ctxFor(staff, 'cashier')
  const otherCtx = ctxFor(other, 'cashier')
  const bossCtx = ctxFor(boss, 'owner')

  // ── two plans: one with Payroll, one without ─────────────────────────────
  async function makePlan(name: string, payroll: boolean) {
    const p = await owner.query<{ id: string }>(
      `insert into plans (name, monthly_price, annual_price, active) values ($1,1,1,true) returning id`,
      [name],
    )
    const id = p.rows[0].id
    for (const [k, v] of [
      ['module.payroll', payroll ? 'true' : 'false'],
      ['module.expenses', 'true'],
      ['module.reports', 'true'],
      ['max_branches', 'null'],
      ['max_staff', 'null'],
      ['max_resources', 'null'],
    ] as [string, string][]) {
      await owner.query(
        `insert into plan_entitlements (plan_id, key, value) values ($1,$2,$3::jsonb)`,
        [id, k, v],
      )
    }
    return id
  }
  const withPayroll = await makePlan(`DG With Payroll ${tag}`, true)
  const withoutPayroll = await makePlan(`DG No Payroll ${tag}`, false)

  async function subscribeTo(planId: string) {
    await owner.query(
      `update tenant_subscriptions set status='cancelled', cancelled_at=now()
        where tenant_id=$1 and status in ('trialing','active','past_due')`,
      [tenantId],
    )
    await owner.query(
      `insert into tenant_subscriptions
         (tenant_id, plan_id, status, current_period_start, current_period_end)
       values ($1,$2,'active', now() - interval '1 day', now() + interval '30 days')`,
      [tenantId, planId],
    )
  }

  // ── payslips issued while the plan DID include payroll ────────────────────
  await subscribeTo(withPayroll)

  async function issuePayslip(membershipId: string, period: string) {
    const r = await owner.query<{ id: string }>(
      `insert into payslips
         (tenant_id, membership_id, period, base, allowances, deductions,
          days_in_period, days_present, gross, deductions_total,
          advance_instalment, net_pay)
       values ($1,$2,$3, 30000, '[]'::jsonb, '[]'::jsonb, 30, 30, 30000, 0, 0, 30000)
       returning id`,
      [tenantId, membershipId, period],
    )
    return r.rows[0].id
  }
  const myPayslip = await issuePayslip(staff.membershipId, '2026-07')
  const othersPayslip = await issuePayslip(other.membershipId, '2026-07')

  section('while the plan INCLUDES payroll — everything works')
  check('the employee sees their payslip', (await listMyPayslips(staffCtx)).length === 1)
  check('…and can open it', (await getPayslipById(staffCtx, myPayslip)) !== null)
  check(
    'the manager console lists the period',
    (await refusal(() => listPayslipsForPeriod(bossCtx, '2026-07'))) === null,
  )

  // ══ THE DOWNGRADE ═════════════════════════════════════════════════════════
  await subscribeTo(withoutPayroll)

  section('after the downgrade — the employee keeps their own records')

  const mine = await listMyPayslips(staffCtx)
  check('listMyPayslips still returns the payslip', mine.length === 1)
  check(
    '…the same one, with its figures intact',
    mine[0]?.id === myPayslip && mine[0]?.netPay === '30000.00',
  )
  check('…and it does not throw', (await refusal(() => listMyPayslips(staffCtx))) === null)
  check('getPayslipById still opens it', (await getPayslipById(staffCtx, myPayslip)) !== null)

  section('after the downgrade — generating payroll is still refused')

  const { upsertSalaryStructure, recordAdvance, runPayrollForPeriod } = await import(
    '../lib/actions/payroll'
  )
  // These are server actions and return {error}; the readers throw. Both shapes
  // count as refusal — what matters is that none of them proceeds.
  const refusedAction = (r: unknown) =>
    typeof r === 'object' && r !== null && typeof (r as { error?: string }).error === 'string'

  check(
    'runPayrollForPeriod is refused',
    refusedAction(await runPayrollForPeriod('2026-08').catch((e) => ({ error: String(e) }))),
  )
  check(
    'upsertSalaryStructure is refused',
    refusedAction(
      await upsertSalaryStructure({
        membershipId: staff.membershipId,
        base: 30000,
        allowances: [],
        deductions: [],
        effectiveFrom: '2026-08-01',
      }).catch((e) => ({ error: String(e) })),
    ),
  )
  check(
    'recordAdvance is refused',
    refusedAction(
      await recordAdvance({
        membershipId: staff.membershipId,
        amount: 5000,
        instalmentAmount: 2500,
        givenAt: '2026-08-01',
      }).catch((e) => ({ error: String(e) })),
    ),
  )

  section('after the downgrade — the manager payroll console is still closed')

  const periodRefusal = await refusal(() => listPayslipsForPeriod(bossCtx, '2026-07'))
  check('listPayslipsForPeriod is refused', periodRefusal !== null)
  check('…for the right reason', /plan/i.test(periodRefusal ?? ''))
  check('listPayrollPeriods is refused', (await refusal(() => listPayrollPeriods(bossCtx))) !== null)

  section('removing the gate did not widen WHO can read what')
  // The important half of the change: RLS, not the plan check, was always the
  // security boundary. payslips_self_select scopes an employee to their own row.
  const othersList = await listMyPayslips(otherCtx)
  check('the other employee sees only their own payslip', othersList.length === 1)
  check('…and it is theirs, not the first employee’s', othersList[0]?.id === othersPayslip)
  check(
    'an employee cannot open a colleague’s payslip by id',
    (await getPayslipById(staffCtx, othersPayslip)) === null,
  )
  // Unchanged and deliberate: payslips_manager_select lets an owner/manager open
  // any single payslip. They still cannot enumerate them — that reader is gated.
  check(
    'an owner can still open any single payslip (RLS, unchanged)',
    (await getPayslipById(bossCtx, myPayslip)) !== null,
  )

  section('a tenant with NO plan at all behaves the same way')
  // The lapse case, not just the downgrade case: no live subscription is the
  // state every unsubscribed tenant is in, and it must not strand records either.
  await owner.query(
    `update tenant_subscriptions set status='cancelled', cancelled_at=now()
      where tenant_id=$1 and status in ('trialing','active','past_due')`,
    [tenantId],
  )
  check('the employee still sees their payslip', (await listMyPayslips(staffCtx)).length === 1)
  check('…and can still open it', (await getPayslipById(staffCtx, myPayslip)) !== null)
  check(
    'the manager console is still refused',
    (await refusal(() => listPayslipsForPeriod(bossCtx, '2026-07'))) !== null,
  )

  // ── cleanup ───────────────────────────────────────────────────────────────
  await owner.query(`delete from payslips where tenant_id = $1`, [tenantId])
  await owner.query(`delete from tenant_subscriptions where tenant_id = $1`, [tenantId])
  await owner.query(`delete from memberships where tenant_id = $1`, [tenantId])
  await owner.query(`delete from branches where tenant_id = $1`, [tenantId])
  await owner.query(`delete from tenants where id = $1`, [tenantId])
  await owner.query(`delete from plan_entitlements where plan_id = any($1)`, [
    [withPayroll, withoutPayroll],
  ])
  await owner.query(`delete from plans where id = any($1)`, [[withPayroll, withoutPayroll]])
  await owner.query(`delete from users where email like $1`, [`%-${tag}@example.test`])

  console.log(`\n${pass} passed, ${fail} failed`)
  await owner.end()
  if (fail > 0) process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
