/**
 * The P&L report (AROS-86): the formula, the breakdown, date boundaries,
 * authorization and tenant isolation — against a real database.
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs scripts/test-pnl-report.ts
 *
 * The audit that preceded this ticket recorded "no P&L test exists" as a
 * testing gap. This closes it, and covers the two things most likely to be
 * silently wrong: that the category breakdown reconciles to the expense total,
 * and that a day on either boundary of the range is counted exactly once.
 */
import { Client } from 'pg'
import { loadEnv } from './env'
import { entitleTenant } from './entitle-fixture'

loadEnv()

let pass = 0
let fail = 0
const check = (label: string, cond: boolean) => {
  console.log(`${cond ? '✓' : '✗ FAIL'}  ${label}`)
  if (cond) pass++
  else fail++
}
const money = (n: number) => n.toFixed(2)
const round2 = (n: number) => Math.round(n * 100) / 100

async function main() {
  const { getPayrollCostReport } = await import('../lib/reports/payroll')
  const { getPnlReport, monthsOverlapping, isWholeMonths, pnlCsvRows } = await import(
    '../lib/reports/pnl'
  )
  const { ReportAccessError } = await import('../lib/reports/daily-revenue')

  const owner = new Client({ connectionString: process.env.DATABASE_URL_OWNER })
  await owner.connect()

  // ── pure helpers first (no database needed) ───────────────────────────────
  console.log('\n── period maths ──')

  check(
    'a range inside one month yields one period',
    monthsOverlapping({ start: '2026-03-05', end: '2026-03-20' }).join(',') === '2026-03',
  )
  check(
    'a range spanning two months yields both',
    monthsOverlapping({ start: '2026-03-15', end: '2026-04-20' }).join(',') === '2026-03,2026-04',
  )
  check(
    'a range crossing a year boundary is ordered correctly',
    monthsOverlapping({ start: '2026-11-20', end: '2027-02-03' }).join(',') ===
      '2026-11,2026-12,2027-01,2027-02',
  )
  check('a whole month is recognised', isWholeMonths({ start: '2026-03-01', end: '2026-03-31' }))
  check('February leap year is recognised', isWholeMonths({ start: '2024-02-01', end: '2024-02-29' }))
  check('February non-leap is recognised', isWholeMonths({ start: '2026-02-01', end: '2026-02-28' }))
  check('a part month is NOT', !isWholeMonths({ start: '2026-03-02', end: '2026-03-31' }))
  check('…nor one ending early', !isWholeMonths({ start: '2026-03-01', end: '2026-03-30' }))
  check(
    'two whole months together count as whole',
    isWholeMonths({ start: '2026-03-01', end: '2026-04-30' }),
  )

  // ── fixtures ──────────────────────────────────────────────────────────────
  async function makeTenant(slug: string) {
    const t = await owner.query<{ id: string }>(
      `insert into tenants (slug, name, status, timezone) values ($1,$2,'active','Asia/Kolkata')
       on conflict (slug) do update set status='active' returning id`,
      [slug, `${slug} co`],
    )
    // Entitlement enforcement is fail-closed (M16 #2): a tenant with no
    // plan is granted nothing, so this fixture states that it is a paying
    // customer. See scripts/entitle-fixture.ts.
    await entitleTenant(owner, t.rows[0].id)
    const br = await owner.query<{ id: string }>(
      `insert into branches (tenant_id, name, is_primary) values ($1,'Main',true)
       on conflict (tenant_id, name) do update set is_primary=true returning id`,
      [t.rows[0].id],
    )
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
        [t.rows[0].id, u.rows[0].id, role, `${role} ${slug}`],
      )
      return { userId: u.rows[0].id, membershipId: m.rows[0].id }
    }
    return {
      tenantId: t.rows[0].id,
      branchId: br.rows[0].id,
      owner: await mk(`owner@${slug}.test`, 'owner'),
      manager: await mk(`manager@${slug}.test`, 'manager'),
      cashier: await mk(`cashier@${slug}.test`, 'cashier'),
    }
  }

  const tA = await makeTenant('pnla')
  const tB = await makeTenant('pnlb')
  const ids = [tA.tenantId, tB.tenantId]

  async function wipe() {
    await owner.query('delete from payslips where tenant_id = any($1)', [ids])
    await owner.query('delete from expenses where tenant_id = any($1)', [ids])
    await owner.query('delete from expense_categories where tenant_id = any($1)', [ids])
    await owner.query('delete from invoices where tenant_id = any($1)', [ids])
  }
  await wipe()

  /** An invoice on a given day, in the tenant's zone (Asia/Kolkata = +05:30). */
  let invSeq = 0
  async function invoice(t: typeof tA, day: string, total: string, status = 'issued') {
    invSeq++
    await owner.query(
      `insert into invoices (tenant_id, branch_id, invoice_number, status,
                             subtotal, discount, tax_total, total, issued_at)
       values ($1,$2,$3,$4::invoice_status,$5,0,0,$5, ($6 || ' 12:00')::timestamp at time zone 'Asia/Kolkata')`,
      [t.tenantId, t.branchId, `INV-PNL-${invSeq}`, status, total, day],
    )
  }

  async function category(t: typeof tA, name: string) {
    const c = await owner.query<{ id: string }>(
      `insert into expense_categories (tenant_id, name) values ($1,$2)
       on conflict do nothing returning id`,
      [t.tenantId, name],
    )
    if (c.rowCount) return c.rows[0].id
    const existing = await owner.query<{ id: string }>(
      'select id from expense_categories where tenant_id=$1 and name=$2',
      [t.tenantId, name],
    )
    return existing.rows[0].id
  }

  async function expense(t: typeof tA, categoryId: string, day: string, amount: string) {
    await owner.query(
      `insert into expenses (tenant_id, category_id, amount, spent_on) values ($1,$2,$3,$4)`,
      [t.tenantId, categoryId, amount, day],
    )
  }

  // gross and net_pay are seeded DELIBERATELY DIFFERENT (AROS-184). The P&L
  // payroll line must read gross — the withheld tax/PF is still money the
  // business spends, and an advance instalment is a loan repayment — so a
  // fixture where the two were equal could not tell a correct report from one
  // that summed net_pay.
  async function payslip(
    t: typeof tA,
    membershipId: string,
    period: string,
    gross: string,
    deductionsTotal = '0.00',
    advanceInstalment = '0.00',
  ) {
    const netPay = (Number(gross) - Number(deductionsTotal) - Number(advanceInstalment)).toFixed(2)
    await owner.query(
      `insert into payslips (tenant_id, membership_id, period, base, days_in_period, days_present,
                             gross, deductions_total, advance_instalment, net_pay)
       values ($1,$2,$3,$4,30,30,$4,$5,$6,$7)
       on conflict (membership_id, period) do update
         set gross = excluded.gross,
             deductions_total = excluded.deductions_total,
             advance_instalment = excluded.advance_instalment,
             net_pay = excluded.net_pay`,
      [t.tenantId, membershipId, period, gross, deductionsTotal, advanceInstalment, netPay],
    )
  }

  // March 2026: revenue 10000, expenses 3000 (Rent 2000 + Food 1000), payroll 4000.
  await invoice(tA, '2026-03-01', '4000.00', 'issued')
  await invoice(tA, '2026-03-15', '5000.00', 'paid')
  await invoice(tA, '2026-03-31', '1000.00', 'issued')
  // Must NOT count: draft/void, and days outside the range.
  await invoice(tA, '2026-03-10', '9999.00', 'draft')
  await invoice(tA, '2026-02-28', '7777.00', 'issued')
  await invoice(tA, '2026-04-01', '8888.00', 'issued')

  const rent = await category(tA, 'Rent')
  const food = await category(tA, 'Food supplies')
  await expense(tA, rent, '2026-03-01', '2000.00')
  await expense(tA, food, '2026-03-15', '600.00')
  await expense(tA, food, '2026-03-31', '400.00')
  await expense(tA, rent, '2026-02-28', '5555.00') // outside
  await expense(tA, rent, '2026-04-01', '6666.00') // outside

  // March gross 4000 (2500 + 1500); net_pay would only be 3200 (2500−400−100 +
  // 1500−300). The P&L must report 4000.
  await payslip(tA, tA.manager.membershipId, '2026-03', '2500.00', '400.00', '100.00')
  await payslip(tA, tA.cashier.membershipId, '2026-03', '1500.00', '300.00')
  await payslip(tA, tA.manager.membershipId, '2026-04', '9999.00', '999.00') // outside

  // Tenant B: unmistakable numbers that must never appear in A's report.
  const bCat = await category(tB, 'Rent')
  await invoice(tB, '2026-03-10', '123456.00', 'paid')
  await expense(tB, bCat, '2026-03-10', '54321.00')
  await payslip(tB, tB.manager.membershipId, '2026-03', '99999.00', '9999.00')

  // Revenue is read from v_daily_revenue, which sits on a MATERIALIZED view.
  // It does not see the invoices above until it is refreshed — the same reason
  // scripts/test-revenue-dashboard.ts refreshes, and the same staleness the
  // reports UI discloses ("npm run reports:refresh"). Expenses and payroll are
  // live tables, so only this line needs it.
  await owner.query('select public.refresh_daily_revenue()')

  const ctxFor = (t: typeof tA, who: 'owner' | 'manager' | 'cashier') =>
    ({
      user: { id: t[who].userId, email: 'x', fullName: null, isPlatformAdmin: false },
      tenant: {
        id: t.tenantId,
        slug: 'x',
        name: 'x',
        industry: 'gaming_cafe',
        status: 'active',
        currency: 'INR',
        timezone: 'Asia/Kolkata',
      },
      role: who,
      membershipId: t[who].membershipId,
      branchId: null,
    }) as Parameters<typeof getPnlReport>[0]

  const MARCH = { start: '2026-03-01', end: '2026-03-31' }

  // ══ the formula ═══════════════════════════════════════════════════════════
  console.log('\n── the P&L formula ──')

  const r = await getPnlReport(ctxFor(tA, 'manager'), MARCH)

  check('revenue counts issued + paid only', r.revenue.net === 10000)
  check('…excluding the draft invoice', r.revenue.net !== 19999)
  check('…and counts the invoices', r.revenue.invoiceCount === 3)
  check('expenses total 3000', r.expenses.total === 3000)
  check('…across 3 expense rows', r.expenses.count === 3)
  check('payroll totals 4000 from 2 payslips', r.payroll.total === 4000 && r.payroll.payslipCount === 2)
  // AROS-184: the wage bill is gross. Summing net_pay would report 3200 here
  // and inflate net profit by the 800 of withholding and advance recovery.
  check('…which is GROSS, not net pay (3200)', r.payroll.total !== 3200)
  check(
    'net profit = revenue − expenses − payroll = 3000',
    r.netProfit === 3000 && r.netProfit === r.revenue.net - r.expenses.total - r.payroll.total,
  )

  // ══ the breakdown reconciles ══════════════════════════════════════════════
  console.log('\n── category breakdown ──')

  const sumCats = r.expenses.byCategory.reduce((s, c) => s + c.amount, 0)
  check('the breakdown sums EXACTLY to the expense total', money(sumCats) === money(r.expenses.total))
  check('two categories are present', r.expenses.byCategory.length === 2)
  check('…ordered largest first', r.expenses.byCategory[0].categoryName === 'Rent')
  check('Rent is 2000', r.expenses.byCategory[0].amount === 2000)
  check('Food supplies is 1000 across 2 rows',
    r.expenses.byCategory[1].amount === 1000 && r.expenses.byCategory[1].expenseCount === 2)

  // ══ date boundaries ═══════════════════════════════════════════════════════
  console.log('\n── date boundaries ──')

  check('the 1st (first day) is included — it is in the 10000', r.revenue.net === 10000)
  check('the 31st (last day) is included', r.expenses.total === 3000)

  const oneDay = await getPnlReport(ctxFor(tA, 'manager'), { start: '2026-03-15', end: '2026-03-15' })
  check('a single-day range is one day, not empty', oneDay.revenue.net === 5000)
  check('…and picks up only that day’s expense', oneDay.expenses.total === 600)

  const firstOnly = await getPnlReport(ctxFor(tA, 'manager'), { start: '2026-03-01', end: '2026-03-01' })
  check('the boundary day is counted exactly once', firstOnly.revenue.net === 4000)

  const before = await getPnlReport(ctxFor(tA, 'manager'), { start: '2026-02-01', end: '2026-02-28' })
  check('February sees only February revenue', before.revenue.net === 7777)
  check('…and only February expenses', before.expenses.total === 5555)
  check('…and no March payroll', before.payroll.total === 0)

  // ══ payroll granularity ═══════════════════════════════════════════════════
  console.log('\n── payroll granularity ──')

  check('a whole month is not flagged approximate', r.payroll.isApproximate === false)
  check('…and names the period used', r.payroll.periods.join(',') === '2026-03')

  const partial = await getPnlReport(ctxFor(tA, 'manager'), { start: '2026-03-15', end: '2026-04-20' })
  check('a part-month range IS flagged approximate', partial.payroll.isApproximate === true)
  check('…covering both months', partial.payroll.periods.join(',') === '2026-03,2026-04')
  check('…so payroll includes April too (gross 4000 + 9999)', partial.payroll.total === 13999)

  // ══ empty ═════════════════════════════════════════════════════════════════
  console.log('\n── empty period ──')

  const empty = await getPnlReport(ctxFor(tA, 'manager'), { start: '2020-01-01', end: '2020-01-31' })
  check('an empty period is zeros, not an error', empty.revenue.net === 0 && empty.expenses.total === 0)
  check('…with an empty breakdown', empty.expenses.byCategory.length === 0)
  check('…and a net of 0', empty.netProfit === 0)

  // ══ reconciliation with the Payroll Cost Report ═══════════════════════════
  // The two reports read the same payslips and must land on the same wage bill.
  // Asserting each against a constant separately would not have caught the
  // AROS-184 bug — both were "correct" in isolation while disagreeing by the
  // withholding. Comparing them to EACH OTHER is what pins it.
  console.log('\n── the two payroll figures reconcile ──')

  const payrollReport = await getPayrollCostReport(ctxFor(tA, 'manager'), '2026-03', '2026-03')
  check(
    'P&L payroll === payroll report totalGross',
    r.payroll.total === payrollReport.totals.totalGross,
  )
  check(
    '…and the report does NOT agree on net, so the check has teeth',
    payrollReport.totals.totalNetPay !== payrollReport.totals.totalGross,
  )
  check(
    'the deductions and advance make up the difference exactly',
    round2(payrollReport.totals.totalGross - payrollReport.totals.totalNetPay) ===
      round2(payrollReport.totals.totalDeductions + payrollReport.totals.totalAdvanceRecovered),
  )
  check('both reports count the same payslips', r.payroll.payslipCount === payrollReport.totals.payslipCount)

  // ══ revenue staleness (migration 0050) ════════════════════════════════════
  // Revenue is a snapshot; expenses and payroll are live. The report has to be
  // able to say how old the snapshot is, or a manager cannot tell a genuine
  // loss from an un-refreshed one.
  console.log('\n── the revenue snapshot reports its own age ──')

  check('the report carries a refresh timestamp', r.revenueRefreshedAt instanceof Date)
  check(
    '…and it is the real one, not the epoch sentinel',
    r.revenueRefreshedAt !== null && r.revenueRefreshedAt.getTime() > 0,
  )
  // The suite refreshed just before reading, so the stamp must be recent. A
  // stamp that never moves is the failure this guards: the log has to be
  // written BY the refresh, not seeded once and left.
  check(
    '…written by the refresh itself, so it is current',
    r.revenueRefreshedAt !== null && Date.now() - r.revenueRefreshedAt.getTime() < 10 * 60_000,
  )

  const beforeRefresh = r.revenueRefreshedAt!
  await owner.query('select public.refresh_daily_revenue()')
  const afterRefresh = await getPnlReport(ctxFor(tA, 'manager'), MARCH)
  check(
    'a second refresh moves the timestamp forward',
    afterRefresh.revenueRefreshedAt !== null &&
      afterRefresh.revenueRefreshedAt.getTime() >= beforeRefresh.getTime(),
  )
  check('…and the figures are unchanged by it', afterRefresh.netProfit === r.netProfit)

  // ══ CSV ═══════════════════════════════════════════════════════════════════
  console.log('\n── CSV export ──')

  const rows = pnlCsvRows(r)
  const byLabel = new Map(rows.map((x) => [x.label, x.amount]))
  check('CSV has a Revenue row matching the report', byLabel.get('Revenue') === r.revenue.net)
  check('CSV expenses are negative', byLabel.get('Expenses') === -r.expenses.total)
  check('CSV payroll is negative', byLabel.get('Payroll') === -r.payroll.total)
  check('CSV net matches the report', byLabel.get('Net profit/loss') === r.netProfit)
  check(
    'the first four CSV rows sum to the net',
    money(rows.slice(0, 3).reduce((s, x) => s + x.amount, 0)) === money(r.netProfit),
  )
  check('every category appears in the CSV', rows.filter((x) => x.label.startsWith('Expenses — ')).length === 2)
  check('…as negative amounts', rows.filter((x) => x.label.startsWith('Expenses — ')).every((x) => x.amount < 0))

  // ══ authorization ═════════════════════════════════════════════════════════
  console.log('\n── authorization ──')

  const ownerReport = await getPnlReport(ctxFor(tA, 'owner'), MARCH)
  check('an OWNER can read the report', ownerReport.netProfit === 3000)

  let cashierRefused = false
  try {
    await getPnlReport(ctxFor(tA, 'cashier'), MARCH)
  } catch (e) {
    cashierRefused = e instanceof ReportAccessError
  }
  check('a CASHIER is refused by the READER, not just the page', cashierRefused)

  // ══ tenant isolation ══════════════════════════════════════════════════════
  console.log('\n── tenant isolation ──')

  check("tenant A's revenue excludes B's 123456", r.revenue.net === 10000)
  check("…expenses exclude B's 54321", r.expenses.total === 3000)
  check("…payroll excludes B's 99999", r.payroll.total === 4000)
  check("…and no category of B's leaks in", r.expenses.byCategory.every((c) => c.amount < 54321))

  const bReport = await getPnlReport(ctxFor(tB, 'manager'), MARCH)
  check('tenant B sees its own revenue', bReport.revenue.net === 123456)
  check('…its own expenses', bReport.expenses.total === 54321)
  check('…its own payroll', bReport.payroll.total === 99999)
  check("…and none of A's", bReport.netProfit === 123456 - 54321 - 99999)

  await wipe()
  await owner.end()

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
