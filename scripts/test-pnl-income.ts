/**
 * Other income + opening balance on the P&L (M40 / AROS-358).
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs scripts/test-pnl-income.ts
 *
 * The existing P&L suite (test-pnl-report.ts) is the regression for revenue /
 * expenses / payroll maths; this covers only what the ticket adds: the other-
 * income line in netProfit, the range filter, the CSV row, and the opening-
 * balance reference (audit, unset, and — crucially — excluded from netProfit).
 */
import { Client } from 'pg'
import { loadEnv } from './env'
import { entitleTenant } from './entitle-fixture'

loadEnv()

let pass = 0
let fail = 0
const check = (label: string, cond: boolean, detail?: string) => {
  console.log(`${cond ? '✓' : '✗ FAIL'}  ${label}${!cond && detail ? `  → ${detail}` : ''}`)
  if (cond) pass++
  else fail++
}
const round2 = (n: number) => Math.round(n * 100) / 100

async function main() {
  const { getPnlReport, pnlCsvRows } = await import('../lib/reports/pnl')
  const { setOpeningBalance, getFinancialSettings, OpeningBalanceError } = await import(
    '../lib/reports/financial-settings'
  )
  const { withUser } = await import('../db')

  const owner = new Client({ connectionString: process.env.DATABASE_URL_OWNER })
  await owner.connect()

  async function makeTenant(slug: string) {
    const t = await owner.query<{ id: string }>(
      `insert into tenants (slug, name, status, timezone) values ($1,$2,'active','Asia/Kolkata')
       on conflict (slug) do update set status='active' returning id`,
      [slug, `${slug} co`],
    )
    const tenantId = t.rows[0].id
    await entitleTenant(owner, tenantId)
    const mk = async (email: string, role: string) => {
      const u = await owner.query<{ id: string }>(
        `insert into users (email, password_hash) values ($1,'x')
         on conflict (email) do update set email=excluded.email returning id`,
        [email],
      )
      const m = await owner.query<{ id: string }>(
        `insert into memberships (tenant_id, user_id, role, status, full_name)
         values ($1,$2,$3::member_role,'active',$4)
         on conflict (tenant_id, user_id) do update set role=excluded.role, status='active'
         returning id`,
        [tenantId, u.rows[0].id, role, `${role} ${slug}`],
      )
      return { userId: u.rows[0].id, membershipId: m.rows[0].id }
    }
    return {
      tenantId,
      manager: await mk(`mgr@${slug}.test`, 'manager'),
      cashier: await mk(`cash@${slug}.test`, 'cashier'),
    }
  }

  const A = await makeTenant('pnlinc-a')
  const B = await makeTenant('pnlinc-b')
  const ids = [A.tenantId, B.tenantId]
  const wipe = async () => {
    await owner.query('delete from income where tenant_id = any($1)', [ids])
    await owner.query('delete from expenses where tenant_id = any($1)', [ids])
    await owner.query('delete from expense_categories where tenant_id = any($1)', [ids])
    await owner.query('delete from financial_settings where tenant_id = any($1)', [ids])
    await owner.query(`delete from audit_log where tenant_id = any($1) and entity_type='financial_settings'`, [ids])
  }
  await wipe()

  const ctxFor = (t: typeof A) =>
    ({
      user: { id: t.manager.userId },
      tenant: {
        id: t.tenantId,
        slug: 'x',
        name: 'x',
        industry: 'gaming_cafe',
        status: 'active',
        currency: 'INR',
        timezone: 'Asia/Kolkata',
      },
      role: 'manager',
      membershipId: t.manager.membershipId,
      branchId: null,
    }) as Parameters<typeof getPnlReport>[0]
  const actor = (t: typeof A) => ({ tenantId: t.tenantId, membershipId: t.manager.membershipId })

  const MARCH = { start: '2026-03-01', end: '2026-03-31' }
  const inc = (t: string, amt: string, day: string, note: string | null = null) =>
    owner.query(`insert into income (tenant_id,amount,received_on,note) values ($1,$2,$3,$4)`, [t, amt, day, note])

  // March: 1000.50 (on the 1st) + 250 (on the 31st). Outside: Feb 28, Apr 1.
  await inc(A.tenantId, '1000.50', '2026-03-01', 'investment')
  await inc(A.tenantId, '250.00', '2026-03-31')
  await inc(A.tenantId, '9999.00', '2026-02-28')
  await inc(A.tenantId, '8888.00', '2026-04-01')
  await inc(B.tenantId, '7777.00', '2026-03-15')
  const cat = (
    await owner.query<{ id: string }>(
      `insert into expense_categories (tenant_id,name) values ($1,'Rent') returning id`,
      [A.tenantId],
    )
  ).rows[0].id
  await owner.query(
    `insert into expenses (tenant_id,category_id,amount,spent_on) values ($1,$2,'300.25','2026-03-10')`,
    [A.tenantId, cat],
  )

  console.log('\n── other income line ──')
  const r = await getPnlReport(ctxFor(A), MARCH)
  check('total is 1250.50, range inclusive on both ends', r.otherIncome.total === 1250.5, `got ${r.otherIncome.total}`)
  check('…2 entries; Feb 28 / Apr 1 excluded', r.otherIncome.count === 2 && r.otherIncome.rows.length === 2)
  check('…rows newest first', r.otherIncome.rows[0].receivedOn === '2026-03-31')
  check('other tenant’s 7777 does not leak', r.otherIncome.rows.every((x) => x.amount !== 7777))
  check(
    'netProfit = revenue + other income − expenses − payroll',
    r.netProfit === round2(r.revenue.net + r.otherIncome.total - r.expenses.total - r.payroll.total),
  )
  check('…= 950.25 here (0 revenue, 0 payroll)', r.netProfit === 950.25, `got ${r.netProfit}`)
  check('expenses line unchanged by income', r.expenses.total === 300.25)

  console.log('\n── CSV ──')
  {
    const rows = pnlCsvRows(r)
    const by = new Map(rows.map((x) => [x.label, x.amount]))
    check('has an Other income row (positive)', by.get('Other income') === 1250.5)
    check('four lines sum to the net', round2(rows.slice(0, 4).reduce((s, x) => s + x.amount, 0)) === r.netProfit)
    check('no opening-balance row when unset', !rows.some((x) => x.label.startsWith('Opening balance')))
  }

  console.log('\n── opening balance: unset ──')
  check('report carries null, not 0 or a crash', r.openingBalance === null)
  check('getFinancialSettings → null', (await getFinancialSettings(ctxFor(A))).openingBalance === null)

  console.log('\n── opening balance: set + audit ──')
  const auditRows = async () =>
    (
      await owner.query<{
        actor_membership_id: string
        before: Record<string, unknown>
        after: Record<string, unknown>
      }>(
        `select actor_membership_id, before, after from audit_log
          where tenant_id=$1 and entity_type='financial_settings' order by created_at, id`,
        [A.tenantId],
      )
    ).rows
  const set = (amount: string, asOf: string | null) =>
    withUser(A.manager.userId, (tx) => setOpeningBalance(tx, actor(A), { amount, asOf }))

  const prev1 = await set('50000', '2026-01-01')
  check('first set returns previous = null', prev1 === null)
  let a = await auditRows()
  check(
    'one audit row, null → 50000.00',
    a.length === 1 && a[0].before.openingBalance === null && a[0].after.openingBalance === '50000.00',
    JSON.stringify(a),
  )
  check('…with the actor', a[0].actor_membership_id === A.manager.membershipId)

  await set('50000.00', '2026-01-01')
  check('a no-op save writes no audit row', (await auditRows()).length === 1)

  const prev2 = await set('75000.5', '2026-02-01')
  a = await auditRows()
  check('edit returns the old value', prev2?.amount === '50000.00')
  check(
    '…and audits old → new',
    a.length === 2 && a[1].before.openingBalance === '50000.00' && a[1].after.openingBalance === '75000.50',
    JSON.stringify(a[1]),
  )

  console.log('\n── opening balance: excluded from netProfit ──')
  const r2 = await getPnlReport(ctxFor(A), MARCH)
  check('report returns the reference', r2.openingBalance?.amount === '75000.50' && r2.openingBalance?.asOf === '2026-02-01')
  check('netProfit UNCHANGED by setting it', r2.netProfit === r.netProfit, `${r.netProfit} → ${r2.netProfit}`)
  await set('-123456.78', null)
  const r3 = await getPnlReport(ctxFor(A), MARCH)
  check(
    '…nor by changing it again (even to a negative)',
    r3.netProfit === r.netProfit && r3.openingBalance?.amount === '-123456.78',
  )
  check(
    'CSV shows it as a trailing reference row',
    pnlCsvRows(r3).some((x) => x.label.startsWith('Opening balance') && x.amount === -123456.78),
  )
  check(
    '…and every other CSV row is unchanged',
    pnlCsvRows(r3).filter((x) => !x.label.startsWith('Opening balance')).length === pnlCsvRows(r).length,
  )

  console.log('\n── opening balance: clear + validation + isolation ──')
  await withUser(A.manager.userId, (tx) => setOpeningBalance(tx, actor(A), null))
  check('clearing returns the report to null', (await getPnlReport(ctxFor(A), MARCH)).openingBalance === null)
  for (const bad of ['abc', '1.234', '', '1e5', '12345678901']) {
    let refused = false
    try {
      await set(bad, null)
    } catch (e) {
      refused = e instanceof OpeningBalanceError
    }
    check(`rejects amount "${bad}"`, refused)
  }
  let badDate = false
  try {
    await set('1', '2026-02-30')
  } catch (e) {
    badDate = e instanceof OpeningBalanceError
  }
  check('rejects an impossible as-of date', badDate)
  check('tenant B never sees A’s opening balance', (await getPnlReport(ctxFor(B), MARCH)).openingBalance === null)

  console.log('\n── RLS: financial_settings is manager-write, tenant-scoped ──')
  const app = new Client({ connectionString: process.env.DATABASE_URL })
  await app.connect()
  async function asUser(userId: string, sql: string, params: unknown[]) {
    await app.query('begin')
    await app.query(`select set_config('app.user_id',$1,true)`, [userId])
    try {
      await app.query(sql, params)
      await app.query('commit')
      return true
    } catch {
      await app.query('rollback')
      return false
    }
  }
  const ins = `insert into financial_settings (tenant_id,opening_balance) values ($1,'1')`
  check('cashier CANNOT write', !(await asUser(A.cashier.userId, ins, [A.tenantId])))
  check('A’s manager CANNOT write B’s row', !(await asUser(A.manager.userId, ins, [B.tenantId])))
  check(
    'A’s manager CAN write its own',
    await asUser(A.manager.userId, `insert into financial_settings (tenant_id,opening_balance) values ($1,'1') on conflict (tenant_id) do update set opening_balance='1'`, [A.tenantId]),
  )
  await app.end()

  await wipe()
  await owner.end()

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
