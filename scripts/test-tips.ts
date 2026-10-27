/**
 * Tips management (M20 / AROS-181) against a real database: attribution of
 * captured tips, direct vs pooled + tip-out from real attendance, monthly
 * finalise / reopen, payout through payroll onto the payslip, the by-server /
 * by-day report, and RLS.
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs scripts/test-tips.ts
 */
import { Pool } from 'pg'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { sql } from 'drizzle-orm'
import * as schema from '../db/schema'
import { loadEnv } from './env'
import { entitleTenant } from './entitle-fixture'

type Db = NodePgDatabase<typeof schema>
let pass = 0,
  fail = 0
const check = (l: string, c: boolean) => {
  console.log(`${c ? '✓' : '✗ FAIL'}  ${l}`)
  if (c) pass++
  else fail++
}
const near = (a: number | null | undefined, b: number, eps = 0.011) => a !== null && a !== undefined && Math.abs(a - b) <= eps
const TZ = 'Asia/Kolkata'
const ROLES = ['owner', 'manager', 'cashier', 'floor_staff', 'floor_staff2', 'kitchen_staff'] as const
type Role = (typeof ROLES)[number]
const P = '2026-08'

async function main() {
  loadEnv()
  const svc = await import('../lib/tips/service')
  const { runPayroll, PayrollError } = await import('../lib/payroll/run')
  const rep = await import('../lib/reports/tips')
  const { ReportAccessError } = await import('../lib/reports/daily-revenue')

  const ownerPool = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })
  const appPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 })
  const app = drizzle(appPool, { schema })
  const withUser = <T>(userId: string, fn: (tx: Db) => Promise<T>): Promise<T> =>
    app.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`)
      return fn(tx as unknown as Db)
    })
  const q = async (text: string, params: unknown[] = []) => (await ownerPool.query(text, params)).rows

  async function makeTenant(slug: string, industry = 'restaurant', entitled = true) {
    const t = await q(
      `insert into tenants (slug,name,status,timezone,industry) values ($1,$2,'active',$3,$4)
       on conflict (slug) do update set name=excluded.name, industry=$4 returning id`,
      [slug, `${slug} co`, TZ, industry],
    )
    const tenantId = t[0].id as string
    const b = await q(
      `insert into branches (tenant_id,name,is_primary) values ($1,'Main',true)
       on conflict (tenant_id,name) do update set is_primary=true returning id`,
      [tenantId],
    )
    const members = {} as Record<Role, { userId: string; membershipId: string }>
    const roleOf: Record<Role, string> = { owner: 'owner', manager: 'manager', cashier: 'cashier', floor_staff: 'floor_staff', floor_staff2: 'floor_staff', kitchen_staff: 'kitchen_staff' }
    for (const key of ROLES) {
      const u = await q(`insert into users (email,password_hash) values ($1,'x') on conflict (email) do update set email=excluded.email returning id`, [`${key}@${slug}.test`])
      const m = await q(
        `insert into memberships (tenant_id,user_id,role,status,full_name) values ($1,$2,$3,'active',$4)
         on conflict (tenant_id,user_id) do update set role=$3, status='active', full_name=$4 returning id`,
        [tenantId, u[0].id, roleOf[key], key === 'floor_staff' ? 'Ann' : key === 'floor_staff2' ? 'Bob' : key === 'kitchen_staff' ? 'Kim' : `${key} person`],
      )
      members[key] = { userId: u[0].id, membershipId: m[0].id }
    }
    const rt = await q(`insert into resource_types (tenant_id,name,hourly_rate) values ($1,'Table','0') on conflict (tenant_id,name) do update set hourly_rate='0' returning id`, [tenantId])
    const table = await q(`insert into resources (tenant_id,branch_id,resource_type_id,name) values ($1,$2,$3,'T1') on conflict (tenant_id,name) do update set status='available' returning id`, [tenantId, b[0].id, rt[0].id])
    if (entitled) await entitleTenant(ownerPool, tenantId)
    return { tenantId, branchId: b[0].id as string, members, table: table[0].id as string, industry }
  }
  type T = Awaited<ReturnType<typeof makeTenant>>

  async function attempt<R>(fn: () => Promise<R>) {
    try {
      return { ok: true as const, v: await fn() }
    } catch (e) {
      const cause = (e as { cause?: { code?: string } }).cause
      const raw = e as { code?: string }
      return { ok: false as const, err: e, msg: e instanceof Error ? e.message : String(e), code: cause?.code ?? raw.code }
    }
  }
  const as = <R>(t: T, role: Role, fn: (tx: Db) => Promise<R>) => withUser(t.members[role].userId, fn)
  const act = (t: T, role: Role = 'manager') => ({ tenantId: t.tenantId, membershipId: t.members[role].membershipId })
  const cx = (t: T, role: Role = 'manager') =>
    ({ user: { id: t.members[role].userId }, tenant: { id: t.tenantId, industry: t.industry, timezone: TZ, currency: 'INR', name: 'T' }, role, membershipId: t.members[role].membershipId }) as never
  const m = (t: T, k: Role) => t.members[k].membershipId

  const A = await makeTenant('testtipsa')
  const B = await makeTenant('testtipsb')
  const G = await makeTenant('testtipsg', 'gaming_cafe')
  const N = await makeTenant('testtipsn', 'restaurant', false)
  const ids = [A.tenantId, B.tenantId, G.tenantId, N.tenantId]
  for (const tbl of ['tip_payouts', 'tip_periods', 'tip_settings', 'payslips', 'salary_structures', 'attendance', 'payments', 'invoice_items', 'invoices', 'audit_log', 'bookings']) {
    await q(`delete from ${tbl} where tenant_id = any($1)`, [ids])
  }

  // ── seed: attendance (hours) ──────────────────────────────────────────────
  const shift = async (t: T, who: Role, day: string, hours: number) =>
    q(`insert into attendance (tenant_id,branch_id,membership_id,work_date,clock_in,clock_out) values ($1,$2,$3,$4,$5,$6)`, [
      t.tenantId, t.branchId, m(t, who), day, `${day}T04:00:00Z`, new Date(Date.parse(`${day}T04:00:00Z`) + hours * 3_600_000).toISOString(),
    ])
  for (const d of ['2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06']) await shift(A, 'floor_staff', d, 10) // Ann 40h
  for (const d of ['2026-08-03', '2026-08-04']) await shift(A, 'floor_staff2', d, 10) // Bob 20h
  for (const d of ['2026-08-03', '2026-08-04', '2026-08-05']) await shift(A, 'kitchen_staff', d, 10) // Kim 30h
  await q(`insert into attendance (tenant_id,branch_id,membership_id,work_date,clock_in) values ($1,$2,$3,'2026-08-10','2026-08-10T04:00:00Z')`, [A.tenantId, A.branchId, m(A, 'floor_staff2')]) // never clocked out
  await shift(A, 'floor_staff', '2026-09-02', 10) // next month: must not count

  // ── seed: sessions, invoices, tips ────────────────────────────────────────
  let seq = 0
  async function tip(o: { server: Role | null; tip: number; at: string; recipient?: Role; status?: string; invoiceStatus?: string }) {
    const bk = await q(
      `insert into bookings (tenant_id,branch_id,booking_number,status,source,cover_count,resource_id,server_id,checked_in_at,completed_at)
       values ($1,$2,$3,'completed','walk_in',2,$4,$5,$6,$6) returning id`,
      [A.tenantId, A.branchId, `BK-TIP-${++seq}`, A.table, o.server ? m(A, o.server) : null, o.at],
    )
    const inv = await q(
      `insert into invoices (tenant_id,branch_id,invoice_number,booking_id,subtotal,total,tip_amount,status) values ($1,$2,$3,$4,1000,1000,$5,$6) returning id`,
      [A.tenantId, A.branchId, `INV-TIP-${++seq}`, bk[0].id, o.tip, o.invoiceStatus ?? 'paid'],
    )
    await q(
      `insert into payments (tenant_id,branch_id,invoice_id,method,amount,status,tip_amount,tip_recipient_membership_id,created_at) values ($1,$2,$3,'cash',1000,$4,$5,$6,$7)`,
      [A.tenantId, A.branchId, inv[0].id, o.status ?? 'captured', o.tip, o.recipient ? m(A, o.recipient) : null, o.at],
    )
  }
  await tip({ server: 'floor_staff', tip: 1000, at: '2026-08-10T10:00:00Z' }) // Ann's table
  await tip({ server: 'floor_staff2', tip: 400, at: '2026-08-11T10:00:00Z' }) // Bob's table
  await tip({ server: null, tip: 300, at: '2026-08-12T10:00:00Z' }) // nobody's table
  await tip({ server: 'floor_staff', tip: 200, at: '2026-08-13T10:00:00Z', recipient: 'floor_staff2' }) // Ann's table, but the cashier named Bob
  await tip({ server: 'floor_staff', tip: 50, at: '2026-07-31T19:00:00Z' }) // 00:30 IST on Aug 1 -> August
  await tip({ server: 'floor_staff', tip: 999, at: '2026-08-31T19:00:00Z' }) // 00:30 IST on Sep 1 -> NOT August
  await tip({ server: 'floor_staff', tip: 500, at: '2026-08-14T10:00:00Z', status: 'refunded' }) // refunded: excluded
  await tip({ server: 'floor_staff', tip: 700, at: '2026-08-15T10:00:00Z', invoiceStatus: 'void' }) // voided bill: excluded
  await tip({ server: 'floor_staff', tip: 0, at: '2026-08-16T10:00:00Z' }) // no tip
  await q(`insert into reservation_settings (tenant_id,enabled) values ($1,false) on conflict do nothing`, [A.tenantId])

  const preview = (t: T, p = P) => as(t, 'manager', (tx) => svc.previewTipPeriodCore(tx, t.tenantId, p))
  const pay = (r: Awaited<ReturnType<typeof preview>>, who: Role) => r.payouts.find((p) => p.membershipId === m(A, who))

  // ── 1. attribution + dating ───────────────────────────────────────────────
  const entries = await as(A, 'manager', (tx) => svc.loadTipsByRecipient(tx, A.tenantId, { start: '2026-08-01', end: '2026-08-31' }))
  const sum = (id: string | null) => entries.filter((e) => e.recipientId === id).reduce((n, e) => n + e.amount, 0)
  check('Ann is credited the tips on her tables + the 00:30 IST Aug 1 tip = 1050', near(sum(m(A, 'floor_staff')), 1050))
  check('a tip the cashier NAMED goes to that person, not the table server: Bob = 400 + 200', near(sum(m(A, 'floor_staff2')), 600))
  check('a table with no server is unattributed (300)', near(sum(null), 300))
  check('the Sep 1 00:30 IST tip (999), the refunded (500), the voided-bill (700) and the zero tips are excluded', near(entries.reduce((n, e) => n + e.amount, 0), 1950))

  const hours = await as(A, 'manager', (tx) => svc.loadHoursWorked(tx, A.tenantId, { start: '2026-08-01', end: '2026-08-31' }))
  const hrs = (r: Role) => hours.find((h) => h.membershipId === m(A, r))?.hours
  check('hours come from clock-in/out: Ann 40, Bob 20 (the open clock-in counts for nothing), Kim 30', hrs('floor_staff') === 40 && hrs('floor_staff2') === 20 && hrs('kitchen_staff') === 30)
  check("next month's shifts are not counted", near(hrs('floor_staff'), 40))

  // ── 2. rules ──────────────────────────────────────────────────────────────
  const d0 = await preview(A)
  check('default rules are direct with no tip-out', d0.rules.mode === 'direct' && d0.rules.tipOutPct === 0)
  check('direct: Ann 1050 own + 200 of the unattributed 300 (40h:20h) = 1250', near(pay(d0, 'floor_staff')?.amount, 1250))
  check('direct: Bob 600 own + 100 = 700', near(pay(d0, 'floor_staff2')?.amount, 700))
  check('direct: nothing for Kim, total exact (1950)', !pay(d0, 'kitchen_staff') && near(d0.result.distributed + d0.result.undistributed, 1950))

  const badSave = (r: Partial<Parameters<typeof svc.saveTipRulesCore>[2]>) =>
    attempt(() => as(A, 'manager', (tx) => svc.saveTipRulesCore(tx, act(A), { mode: 'pooled', tipOutPct: 10, poolRoles: ['floor_staff'], tipOutRoles: ['kitchen_staff'], ...r })))
  check('tip-out % with nobody to receive it refused', !(await badSave({ tipOutRoles: [] })).ok)
  check('a role cannot be both pooled and tipped out to', !(await badSave({ tipOutRoles: ['floor_staff'] })).ok)
  check('unknown role refused', !(await badSave({ poolRoles: ['wizard'] })).ok)
  check('tip-out over 100% refused', !(await badSave({ tipOutPct: 120 })).ok)
  for (const role of ROLES) {
    const should = role === 'owner' || role === 'manager'
    const r = await attempt(() => as(A, role, (tx) => svc.saveTipRulesCore(tx, act(A, role), { mode: 'pooled', tipOutPct: 10, poolRoles: ['floor_staff'], tipOutRoles: ['kitchen_staff'] })))
    check(`${role} ${should ? 'can' : 'cannot'} save tip rules`, should ? r.ok : !r.ok)
  }
  await as(A, 'manager', (tx) => svc.saveTipRulesCore(tx, act(A), { mode: 'pooled', tipOutPct: 10, poolRoles: ['floor_staff'], tipOutRoles: ['kitchen_staff'] }))
  check('rule changes are audited', (await q(`select 1 from audit_log where tenant_id=$1 and action='tip_settings.changed'`, [A.tenantId])).length >= 1)

  const p0 = await preview(A)
  check('pooled + 10% tip-out: Kim receives 195 (10% of 1950)', near(pay(p0, 'kitchen_staff')?.amount, 195))
  check('...the floor splits 1755 by hours: Ann 1170, Bob 585', near(pay(p0, 'floor_staff')?.amount, 1170) && near(pay(p0, 'floor_staff2')?.amount, 585))
  check('...to the paisa', near(p0.result.distributed + p0.result.undistributed, 1950, 0.001))

  // ── 3. finalise ───────────────────────────────────────────────────────────
  const early = await attempt(() => as(A, 'manager', (tx) => svc.finalizeTipPeriodCore(tx, act(A), '2026-10', '2026-10-22')))
  check('the current month cannot be finalised until it is over', !early.ok && /isn.t over/i.test(early.msg))
  check('a malformed month is refused', !(await attempt(() => as(A, 'manager', (tx) => svc.finalizeTipPeriodCore(tx, act(A), '2026-8', '2026-10-22')))).ok)
  for (const role of ['cashier', 'floor_staff', 'kitchen_staff'] as const) {
    const r = await attempt(() => as(A, role, (tx) => svc.finalizeTipPeriodCore(tx, act(A, role), P, '2026-10-22')))
    check(`${role} cannot finalise (RLS)`, !r.ok)
  }
  check('...and nothing was written by those refusals', (await q('select 1 from tip_periods where tenant_id=$1', [A.tenantId])).length === 0)

  const fin = await as(A, 'manager', (tx) => svc.finalizeTipPeriodCore(tx, act(A), P, '2026-10-22'))
  check('finalise freezes the month with its totals', fin.finalized !== null && near(fin.finalized.totalTips, 1950) && near(fin.finalized.distributed, 1950))
  const rows = await q('select * from tip_payouts where tenant_id=$1 and period=$2', [A.tenantId, P])
  check('one pending payout per person: Ann, Bob, Kim', rows.length === 3 && rows.every((r) => r.status === 'pending'))
  check('payout rows equal the preview and sum to the pool', near(rows.reduce((n, r) => n + Number(r.amount), 0), 1950, 0.001))
  check('each payout keeps its breakdown (hours, shares)', rows.every((r) => r.breakdown && typeof r.breakdown.hours === 'number'))
  check('finalising twice is refused (idempotent)', !(await attempt(() => as(A, 'manager', (tx) => svc.finalizeTipPeriodCore(tx, act(A), P, '2026-10-22')))).ok)

  await as(A, 'manager', (tx) => svc.saveTipRulesCore(tx, act(A), { mode: 'direct', tipOutPct: 0, poolRoles: ['floor_staff'], tipOutRoles: [] }))
  const frozen = await preview(A)
  check('changing the rules afterwards does NOT rewrite a finalised month', frozen.finalized !== null && frozen.rules.mode === 'pooled' && near(pay(frozen, 'kitchen_staff')?.amount, 195))

  // reopen / re-finalise under new rules
  await as(A, 'manager', (tx) => svc.reopenTipPeriodCore(tx, act(A), P))
  check('a month with nothing paid can be reopened', (await q('select 1 from tip_periods where tenant_id=$1', [A.tenantId])).length === 0 && (await q('select 1 from tip_payouts where tenant_id=$1', [A.tenantId])).length === 0)
  await as(A, 'manager', (tx) => svc.finalizeTipPeriodCore(tx, act(A), P, '2026-10-22'))
  const dd = await q('select m.full_name n, p.amount from tip_payouts p join memberships m on m.id=p.membership_id where p.tenant_id=$1', [A.tenantId])
  check('...and re-finalising uses the new (direct) rules: Ann 1250, Bob 700, Kim none', dd.length === 2 && near(Number(dd.find((r) => r.n === 'Ann')?.amount), 1250) && near(Number(dd.find((r) => r.n === 'Bob')?.amount), 700))
  // Kim gets tips only under tip-out: bring it back for the payroll leg
  await as(A, 'manager', (tx) => svc.reopenTipPeriodCore(tx, act(A), P))
  await as(A, 'manager', (tx) => svc.saveTipRulesCore(tx, act(A), { mode: 'pooled', tipOutPct: 10, poolRoles: ['floor_staff'], tipOutRoles: ['kitchen_staff'] }))
  await as(A, 'manager', (tx) => svc.finalizeTipPeriodCore(tx, act(A), P, '2026-10-22'))

  // ── 4. payroll pays them on the payslip ───────────────────────────────────
  for (const who of ['floor_staff', 'floor_staff2'] as const) {
    await q(`insert into salary_structures (tenant_id,membership_id,base,allowances,deductions,effective_from) values ($1,$2,31000,'[]','[]','2026-01-01')`, [A.tenantId, m(A, who)])
  }
  // Kim has NO salary structure: payroll will skip them, so their tip stays pending.
  const run = await as(A, 'owner', (tx) => runPayroll(tx, A.tenantId, P, m(A, 'owner')))
  check('payroll generated payslips for Ann and Bob, skipped Kim (no structure)', run.generated.length === 2 && run.skipped.some((s) => s.fullName === 'Kim'))
  const slip = async (who: Role) => (await q('select * from payslips where tenant_id=$1 and membership_id=$2 and period=$3', [A.tenantId, m(A, who), P]))[0]
  const annSlip = await slip('floor_staff')
  check("Ann's payslip carries her tips: 1170", near(Number(annSlip.tip_payout), 1170))
  check('...but gross / net_pay are the salary only (31000 × 4/31 days = 4000) — tips are not wages', near(Number(annSlip.gross), 4000) && near(Number(annSlip.net_pay), 4000))
  check("Bob's payslip tips: 585 (hours 20 — his open clock-in earns no tip hours) while payroll still counts that day present: salary 31000 × 3/31 = 3000", near(Number((await slip('floor_staff2')).tip_payout), 585) && near(Number((await slip('floor_staff2')).net_pay), 3000))
  const after = await q('select * from tip_payouts where tenant_id=$1 order by amount desc', [A.tenantId])
  check("Ann's and Bob's payouts are marked paid and linked to their payslips", after.filter((r) => r.status === 'paid' && r.payslip_id).length === 2)
  check("Kim's payout is still pending (no payslip to put it on)", after.filter((r) => r.status === 'pending').length === 1)
  check('a month with paid tips can no longer be reopened', !(await attempt(() => as(A, 'manager', (tx) => svc.reopenTipPeriodCore(tx, act(A), P)))).ok)
  const rerun = await attempt(() => as(A, 'owner', (tx) => runPayroll(tx, A.tenantId, P, m(A, 'owner'))))
  check('payroll cannot be run twice for the month (so tips cannot be paid twice)', !rerun.ok && rerun.err instanceof PayrollError)

  const kimPayout = after.find((r) => r.status === 'pending')!
  await as(A, 'manager', (tx) => svc.markTipPayoutPaidCore(tx, act(A), kimPayout.id))
  check('a manager can settle a payout outside payroll', (await q('select status, payslip_id from tip_payouts where id=$1', [kimPayout.id]))[0].status === 'paid')
  await as(A, 'manager', (tx) => svc.markTipPayoutPaidCore(tx, act(A), kimPayout.id))
  check('...marking it again is a harmless no-op', (await q(`select 1 from audit_log where entity_id=$1 and action='tips.payout_marked_paid'`, [kimPayout.id])).length === 1)

  // a payout finalised AFTER payroll ran stays pending (not silently lost)
  const late = '2026-07'
  await tip({ server: 'floor_staff', tip: 80, at: '2026-07-10T10:00:00Z' })
  await shift(A, 'floor_staff', '2026-07-10', 8)
  await as(A, 'manager', (tx) => svc.finalizeTipPeriodCore(tx, act(A), late, '2026-10-22'))
  check('a month finalised with no payroll run yet stays pending until payroll runs for it', (await q(`select status from tip_payouts where tenant_id=$1 and period=$2`, [A.tenantId, late]))[0].status === 'pending')

  // ── 5. report ─────────────────────────────────────────────────────────────
  const r = await rep.getTipsReport(cx(A), { range: { start: '2026-08-01', end: '2026-08-31' } })
  check('report: total 1950, of which 300 unattributed', near(r.total, 1950) && near(r.unattributed, 300))
  const bs = (n: string) => r.byServer.find((s) => s.serverName === n)
  check('report by server: Ann 1050, Bob 600, Unattributed 300 — best first', near(bs('Ann')?.tips, 1050) && near(bs('Bob')?.tips, 600) && near(bs('Unattributed')?.tips, 300) && r.byServer[0].serverName === 'Ann')
  check('report by day: Aug 1 holds the 00:30 IST tip, Sep 1 is absent', r.byDay.some((d) => d.date === '2026-08-01' && near(d.tips, 50)) && !r.byDay.some((d) => d.date === '2026-09-01'))
  check('report by day: the unattributed 300 is on Aug 12', r.byDay.find((d) => d.date === '2026-08-12')?.unattributed === 300)
  check('report by day adds back to the total', near(r.byDay.reduce((n, d) => n + d.tips, 0), r.total))
  const empty = await rep.getTipsReport(cx(A), { range: { start: '2026-01-01', end: '2026-01-02' } })
  check('an empty range is zeros, not an error', empty.total === 0 && empty.byServer.length === 0)
  for (const role of ['cashier', 'floor_staff', 'kitchen_staff'] as const) {
    const g = await attempt(() => rep.getTipsReport(cx(A, role), { range: { start: P + '-01', end: P + '-28' } }))
    check(`report refuses ${role}`, !g.ok && g.err instanceof ReportAccessError)
  }
  const gg = await attempt(() => rep.getTipsReport(cx(G, 'owner'), { range: { start: P + '-01', end: P + '-28' } }))
  check('report refuses a non-restaurant tenant', !gg.ok && gg.err instanceof ReportAccessError)
  await q(`delete from plan_entitlements where key='module.tips' and plan_id = (select id from plans where lower(btrim(name)) = lower(btrim('Test Fixture (all modules)')))`)
  const nn = await attempt(() => rep.getTipsReport(cx(A, 'owner'), { range: { start: P + '-01', end: P + '-28' } }))
  check('report refuses a plan without module.tips', !nn.ok)
  await q(`insert into plan_entitlements (plan_id, key, value) select id, 'module.tips', 'true'::jsonb from plans where lower(btrim(name)) = lower(btrim('Test Fixture (all modules)')) on conflict (plan_id, key) do update set value = excluded.value`)
  const rb = await rep.getTipsReport(cx(B, 'owner'), { range: { start: '2026-08-01', end: '2026-08-31' } })
  check("another tenant's report never includes A's tips", rb.total === 0)

  // ── 6. RLS ────────────────────────────────────────────────────────────────
  const mine = async (role: Role) => as(A, role, (tx) => tx.select().from(schema.tipPayouts))
  const mgrSees = await mine('manager')
  check('manager sees every payout', mgrSees.length >= 3)
  const annSees = await mine('floor_staff')
  check('a staff member sees only their OWN tip payouts', annSees.length >= 1 && annSees.every((p) => p.membershipId === m(A, 'floor_staff')))
  const bobSees = await mine('floor_staff2')
  check("...Bob cannot see Ann's", bobSees.every((p) => p.membershipId === m(A, 'floor_staff2')))
  check('cashier with no payout sees none', (await mine('cashier')).length === 0)
  for (const role of ROLES) {
    const should = role === 'owner' || role === 'manager'
    const s = await as(A, role, (tx) => tx.select().from(schema.tipSettings))
    const per = await as(A, role, (tx) => tx.select().from(schema.tipPeriods))
    check(`${role} ${should ? 'can' : 'cannot'} read tip rules and period totals`, should ? s.length === 1 && per.length >= 1 : s.length === 0 && per.length === 0)
  }
  const wr = await attempt(() => as(A, 'cashier', (tx) => tx.insert(schema.tipPayouts).values({ tenantId: A.tenantId, period: late, membershipId: m(A, 'cashier'), amount: '5' })))
  check('a cashier cannot write payouts', !wr.ok && wr.code === '42501')
  const upd = await as(A, 'floor_staff', (tx) => tx.update(schema.tipPayouts).set({ amount: '99999' }).where(sql`membership_id = ${m(A, 'floor_staff')}`).returning({ id: schema.tipPayouts.id }))
  check('...and a staff member cannot raise their own payout', upd.length === 0)
  const orphan = await attempt(() => q(`insert into tip_payouts (tenant_id,period,membership_id,amount) values ($1,'2026-05',$2,5)`, [A.tenantId, m(A, 'cashier')]))
  check('a payout needs a finalised period (FK)', !orphan.ok && orphan.code === '23503')
  const xTen = await attempt(() => q(`insert into tip_periods (tenant_id,period,settings,total_tips,distributed) values ($1,'2026-05','{}',0,0)`, [A.tenantId]).then(() => q(`insert into tip_payouts (tenant_id,period,membership_id,amount) values ($1,'2026-05',$2,5)`, [A.tenantId, m(B, 'cashier')])))
  check("a payout can't name another tenant's person (composite FK)", !xTen.ok && xTen.code === '23503')
  const xr = await as(B, 'owner', (tx) => tx.select().from(schema.tipPayouts))
  check("another tenant's owner sees none of A's payouts", xr.every((p) => p.tenantId === B.tenantId))

  const ent = await q(`select lower(btrim(p.name)) n, pe.value::text v from plan_entitlements pe join plans p on p.id=pe.plan_id where pe.key='module.tips'`)
  const vOf = (n: string) => ent.find((e) => e.n === n)?.v
  check('module.tips: Pro and Enterprise on, Starter off', vOf('pro') === 'true' && vOf('enterprise') === 'true' && vOf('starter') === 'false')

  for (const tbl of ['tip_payouts', 'tip_periods', 'tip_settings', 'payslips', 'salary_structures', 'attendance', 'payments', 'invoice_items', 'invoices', 'audit_log', 'bookings']) {
    await q(`delete from ${tbl} where tenant_id = any($1)`, [ids])
  }
  await q('delete from tenants where id = any($1)', [ids])
  console.log(`\n${pass} passed, ${fail} failed`)
  await ownerPool.end()
  await appPool.end()
  process.exit(fail ? 1 : 0)
}
main().catch((e) => {
  console.error(e)
  process.exit(1)
})
