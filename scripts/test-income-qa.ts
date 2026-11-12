/**
 * M40 #4 — QA: adversarial + regression coverage for the Other income ledger and
 * the opening-balance reference (AROS-357/358/359).
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs \
 *           --import ./scripts/next-runtime-hook.mjs scripts/test-income-qa.ts
 *
 * Drives the REAL server actions behind the REAL requireManager() guard (sessions
 * + tenant header, as scripts/test-board-surcharge-settings.ts does), and the REAL
 * readers, so a refusal here is the genuine one. The authoring tests
 * (test-income.ts, test-pnl-income.ts) are the happy path; this is the attack:
 *
 *   1  entitlement   false / null / missing / "true"-the-string / no plan, at the
 *                    reader AND all three actions AND saveOpeningBalance — fails closed
 *   2  role gate     every non-manager role + a disabled manager, at the action AND
 *                    directly against RLS as arena_app
 *   3  tenant        cross-tenant read / update / delete / re-home, by id and by list
 *   4  money         0, 0.01, 99999999.99, float-hostile values, and what is refused
 *   5  P&L math      a mix of revenue, income, expenses and payroll, exactly; CSV
 *                    equals the on-screen figures line for line
 *   6  date edges    one day outside excluded, one day inside included
 *   7  opening bal.  bit-for-bit unchanged net; unset tenant has no line; one audit row
 *   8  revenue       Revenue & Bookings / sales / daily revenue IDENTICAL before and
 *      isolation     after income is inserted — plus a source scan that nothing but the
 *                    P&L reads the income table
 */
import { createHash, randomBytes } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { Client, Pool } from 'pg'
import { loadEnv } from './env'

loadEnv()

let pass = 0
let fail = 0
const check = (label: string, cond: boolean, got?: unknown) => {
  console.log(`${cond ? '✓' : '✗ FAIL'}  ${label}${cond || got === undefined ? '' : `  (got: ${JSON.stringify(got)})`}`)
  if (cond) pass++
  else fail++
}
const round2 = (n: number) => Math.round(n * 100) / 100

const NON_MANAGER_ROLES = ['cashier', 'floor_staff', 'kitchen_staff', 'receptionist'] as const
const MARCH = { start: '2026-03-01', end: '2026-03-31' }

async function main() {
  const { createIncome, updateIncome, deleteIncome } = await import('../lib/actions/income')
  const { saveOpeningBalance } = await import('../lib/actions/financial-settings')
  const { listIncome } = await import('../lib/income/data')
  const { getPnlReport, pnlCsvRows } = await import('../lib/reports/pnl')
  const { getRevenueDashboard } = await import('../lib/reports/revenue')
  const { getDailyRevenue } = await import('../lib/reports/daily-revenue')
  const { getSalesReport } = await import('../lib/reports/sales')
  const { EntitlementError } = await import('../lib/platform/entitlement-guard')
  const { entitleTenant } = await import('./entitle-fixture')

  const owner = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })
  const q = <T extends object>(text: string, params: unknown[] = []) => owner.query<T>(text, params)
  const tag = randomBytes(3).toString('hex')
  const slugs = { a: `qa357a${tag}`, b: `qa357b${tag}`, p: `qa357p${tag}`, e: `qa357e${tag}`, z: `qa357z${tag}` }

  // ── fixtures ──────────────────────────────────────────────────────────────
  async function makeUser(label: string) {
    const u = await q<{ id: string }>(
      `insert into users (email, password_hash, full_name) values ($1,'x',$2) returning id`,
      [`qa357-${label}-${tag}@example.test`, label],
    )
    const token = randomBytes(32).toString('hex')
    await q(`insert into sessions (id, user_id, expires_at) values ($1,$2, now() + interval '1 day')`, [
      createHash('sha256').update(token).digest('hex'),
      u.rows[0].id,
    ])
    return { id: u.rows[0].id, token, membershipId: '' }
  }
  type User = Awaited<ReturnType<typeof makeUser>>

  async function makeTenant(slug: string, members: Array<[User, string, string?]>) {
    const t = await q<{ id: string }>(
      `insert into tenants (slug,name,status,timezone,industry) values ($1,$2,'active','Asia/Kolkata','gaming_cafe') returning id`,
      [slug, `${slug} co`],
    )
    const tenantId = t.rows[0].id
    const br = await q<{ id: string }>(
      `insert into branches (tenant_id,name,is_primary) values ($1,'Main',true) returning id`,
      [tenantId],
    )
    for (const [u, role, status = 'active'] of members) {
      const m = await q<{ id: string }>(
        `insert into memberships (tenant_id,user_id,branch_id,role,status,full_name)
         values ($1,$2,$3,$4::member_role,$5::member_status,$4) returning id`,
        [tenantId, u.id, br.rows[0].id, role, status],
      )
      u.membershipId = m.rows[0].id
    }
    return { tenantId, branchId: br.rows[0].id, slug }
  }

  for (const s of Object.values(slugs)) await q(`delete from tenants where slug=$1`, [s])

  const U = {
    aOwner: await makeUser('a-owner'),
    aManager: await makeUser('a-manager'),
    aCashier: await makeUser('a-cashier'),
    aFloor: await makeUser('a-floor'),
    aKitchen: await makeUser('a-kitchen'),
    aReception: await makeUser('a-reception'),
    aDisabled: await makeUser('a-disabled'),
    bManager: await makeUser('b-manager'),
    pManager: await makeUser('p-manager'),
    pCashier: await makeUser('p-cashier'),
    eManager: await makeUser('e-manager'),
    zManager: await makeUser('z-manager'),
  }
  const A = await makeTenant(slugs.a, [
    [U.aOwner, 'owner'],
    [U.aManager, 'manager'],
    [U.aCashier, 'cashier'],
    [U.aFloor, 'floor_staff'],
    [U.aKitchen, 'kitchen_staff'],
    [U.aReception, 'receptionist'],
    [U.aDisabled, 'manager', 'disabled'],
  ])
  const B = await makeTenant(slugs.b, [[U.bManager, 'manager']])
  const P = await makeTenant(slugs.p, [
    [U.pManager, 'manager'],
    [U.pCashier, 'cashier'],
  ])
  const E = await makeTenant(slugs.e, [[U.eManager, 'manager']])
  const Z = await makeTenant(slugs.z, [[U.zManager, 'manager']])
  for (const t of [A, B, P, Z]) await entitleTenant(owner, t.tenantId)

  const g = globalThis as { __ARENA_TEST_SESSION?: string; __ARENA_TEST_HEADERS?: Record<string, string> }
  const signIn = (u: User | null, slug: string) => {
    g.__ARENA_TEST_SESSION = u?.token
    g.__ARENA_TEST_HEADERS = { 'x-tenant-slug': slug }
  }
  const ctxOf = (t: { tenantId: string; slug: string }, u: User, role = 'manager') =>
    ({
      user: { id: u.id },
      tenant: { id: t.tenantId, slug: t.slug, name: t.slug, industry: 'gaming_cafe', status: 'active', currency: 'INR', timezone: 'Asia/Kolkata' },
      role,
      membershipId: u.membershipId,
      branchId: null,
    }) as never

  const incomeRows = async (tenantId: string) =>
    (await q<{ id: string; amount: string; received_on: string; note: string | null }>(
      `select id, amount::text, received_on::text, note from income where tenant_id=$1 order by id`,
      [tenantId],
    )).rows
  const seedIncome = async (tenantId: string, amount: string, day: string, note: string | null = null) =>
    (await q<{ id: string }>(
      `insert into income (tenant_id,amount,received_on,note) values ($1,$2,$3,$4) returning id`,
      [tenantId, amount, day, note],
    )).rows[0].id
  const rowById = async (id: string) =>
    (await q<{ amount: string; received_on: string; note: string | null }>(
      `select amount::text, received_on::text, note from income where id=$1`,
      [id],
    )).rows[0]
  const auditCount = async (tenantId: string) =>
    Number((await q<{ n: string }>(
      `select count(*)::text n from audit_log where tenant_id=$1 and entity_type='financial_settings'`,
      [tenantId],
    )).rows[0].n)

  // arena_app, bypassing every action.
  const app = new Client({ connectionString: process.env.DATABASE_URL })
  await app.connect()
  async function asUser(userId: string, sql: string, params: unknown[] = []) {
    await app.query('begin')
    await app.query(`select set_config('app.user_id',$1,true)`, [userId])
    try {
      const r = await app.query(sql, params)
      await app.query('commit')
      return { ok: true, rowCount: r.rowCount ?? 0 }
    } catch {
      await app.query('rollback')
      return { ok: false, rowCount: 0 }
    }
  }

  // ═══ 1 · ENTITLEMENT — fail closed ═══════════════════════════════════════════
  console.log('\n── 1 · module.expenses: only an explicit boolean true grants ──')
  async function setPlan(tenantId: string, variant: 'true' | 'false' | 'null' | 'missing' | 'string-true' | 'none') {
    await q(`delete from tenant_subscriptions where tenant_id=$1`, [tenantId])
    if (variant === 'none') return
    const plan = await q<{ id: string }>(
      `insert into plans (name, monthly_price, annual_price, active) values ($1,0,0,false)
       on conflict (lower(btrim(name))) do update set active=false returning id`,
      [`QA income ${variant}`],
    )
    const planId = plan.rows[0].id
    await q(`delete from plan_entitlements where plan_id=$1`, [planId])
    await q(`insert into plan_entitlements (plan_id,key,value) values ($1,'module.reports','true'::jsonb)`, [planId])
    if (variant !== 'missing') {
      const json = variant === 'string-true' ? '"true"' : variant
      await q(`insert into plan_entitlements (plan_id,key,value) values ($1,'module.expenses',$2::jsonb)`, [planId, json])
    }
    await q(
      `insert into tenant_subscriptions (tenant_id,plan_id,status,current_period_start,current_period_end)
       values ($1,$2,'active',now(),now() + interval '365 days')`,
      [tenantId, planId],
    )
  }

  const target = await seedIncome(E.tenantId, '100.00', '2026-03-10', 'seed')
  const before = await rowById(target)
  const auditBefore = await auditCount(E.tenantId)
  for (const variant of ['false', 'null', 'missing', 'none'] as const) {
    await setPlan(E.tenantId, variant)
    signIn(U.eManager, E.slug)
    let readerErr: unknown = null
    try {
      await listIncome(ctxOf(E, U.eManager))
    } catch (e) {
      readerErr = e
    }
    check(`[${variant}] listIncome refused with EntitlementError`, readerErr instanceof EntitlementError, String(readerErr))
    const c = await createIncome({ amount: 5, receivedOn: '2026-03-11', note: `qa-ent-${variant}` })
    const u = await updateIncome(target, { amount: 999, receivedOn: '2026-03-12', note: 'hacked' })
    const d = await deleteIncome(target)
    const o = await saveOpeningBalance({ amount: '1', asOf: '2026-01-01' })
    for (const [name, r] of [['createIncome', c], ['updateIncome', u], ['deleteIncome', d], ['saveOpeningBalance', o]] as const) {
      check(`[${variant}] ${name} refused for the plan (not the role)`, !!r.error && !/Only owners and managers/.test(r.error), r)
    }
    check(`[${variant}] …and nothing was written`, (await incomeRows(E.tenantId)).length === 1 && JSON.stringify(await rowById(target)) === JSON.stringify(before))
    check(`[${variant}] …no opening-balance audit`, (await auditCount(E.tenantId)) === auditBefore)
  }
  await setPlan(E.tenantId, 'true')
  signIn(U.eManager, E.slug)
  {
    const r = await listIncome(ctxOf(E, U.eManager)).then(() => null, (e) => e)
    check('[true] control: reader allowed', r === null, String(r))
    const c = await createIncome({ amount: 5, receivedOn: '2026-03-11', note: 'qa-ent-true' })
    check('[true] control: createIncome allowed', !c.error, c)
    const u = await updateIncome(target, { amount: 101, receivedOn: '2026-03-10', note: 'ok' })
    check('[true] control: updateIncome allowed', !u.error && (await rowById(target)).amount === '101.00', u)
    const d = await deleteIncome(target)
    check('[true] control: deleteIncome allowed', !d.error && !(await rowById(target)), d)
  }

  // ═══ 2 · ROLE GATE ═══════════════════════════════════════════════════════════
  console.log('\n── 2 · role gate: action layer ──')
  const aRow = await seedIncome(A.tenantId, '250.00', '2026-03-05', 'a-seed')
  const aSnap = JSON.stringify(await rowById(aRow))
  const refused = (r: { error?: string }) => r.error === 'Only owners and managers can do this.'
  for (const [role, user] of [['cashier', U.aCashier], ['floor_staff', U.aFloor], ['kitchen_staff', U.aKitchen], ['receptionist', U.aReception]] as const) {
    signIn(user, A.slug)
    const c = await createIncome({ amount: 1, receivedOn: '2026-03-06', note: `qa-role-${role}` })
    const u = await updateIncome(aRow, { amount: 1, receivedOn: '2026-03-06', note: 'x' })
    const d = await deleteIncome(aRow)
    const o = await saveOpeningBalance({ amount: '1', asOf: '2026-01-01' })
    check(`${role}: create / update / delete / opening balance all refused by requireManager`, [c, u, d, o].every(refused), { c, u, d, o })
    check(`${role}: …nothing changed`, JSON.stringify(await rowById(aRow)) === aSnap && (await incomeRows(A.tenantId)).length === 1)
  }
  signIn(U.aDisabled, A.slug)
  {
    const c = await createIncome({ amount: 1, receivedOn: '2026-03-06', note: 'qa-disabled' })
    const d = await deleteIncome(aRow)
    check('a DISABLED manager is refused (not signed in to the workspace)', !!c.error && !!d.error && (await incomeRows(A.tenantId)).length === 1, { c, d })
  }
  signIn(null, A.slug)
  check('no session at all → refused', !!(await createIncome({ amount: 1, receivedOn: '2026-03-06' })).error)
  for (const [role, user] of [['owner', U.aOwner], ['manager', U.aManager]] as const) {
    signIn(user, A.slug)
    const c = await createIncome({ amount: 2, receivedOn: '2026-03-07', note: `qa-pos-${role}` })
    check(`${role}: positive control — create works`, !c.error, c)
  }
  await q(`delete from income where tenant_id=$1 and note like 'qa-pos-%'`, [A.tenantId])

  console.log('\n── 2 · role gate: straight to the database as arena_app (no action) ──')
  const insSql = `insert into income (tenant_id,amount,received_on) values ($1,'5.00','2026-03-06')`
  for (const [role, user] of [['cashier', U.aCashier], ['floor_staff', U.aFloor], ['kitchen_staff', U.aKitchen], ['receptionist', U.aReception], ['disabled manager', U.aDisabled]] as const) {
    check(`${role}: INSERT refused by income_write`, !(await asUser(user.id, insSql, [A.tenantId])).ok)
    check(`${role}: UPDATE affects 0 rows`, (await asUser(user.id, `update income set note='x' where id=$1`, [aRow])).rowCount === 0)
    check(`${role}: DELETE affects 0 rows`, (await asUser(user.id, `delete from income where id=$1`, [aRow])).rowCount === 0)
    check(`${role}: opening-balance INSERT refused`, !(await asUser(user.id, `insert into financial_settings (tenant_id,opening_balance) values ($1,'1')`, [A.tenantId])).ok)
  }
  check('non-managers can still READ their tenant (income_select)', (await asUser(U.aCashier.id, `select id from income`)).rowCount === 1)
  check('a disabled member can NOT read', (await asUser(U.aDisabled.id, `select id from income`)).rowCount === 0)
  check('owner: INSERT allowed by RLS', (await asUser(U.aOwner.id, insSql, [A.tenantId])).ok)
  check('manager: INSERT allowed by RLS', (await asUser(U.aManager.id, insSql, [A.tenantId])).ok)
  await q(`delete from income where tenant_id=$1 and id<>$2`, [A.tenantId, aRow])

  // ═══ 3 · TENANT ISOLATION ════════════════════════════════════════════════════
  console.log('\n── 3 · tenant isolation ──')
  const bRow = await seedIncome(B.tenantId, '7777.77', '2026-03-09', 'b-secret')
  const bSnap = JSON.stringify(await rowById(bRow))
  signIn(U.aManager, A.slug)
  {
    const u = await updateIncome(bRow, { amount: 1, receivedOn: '2026-03-01', note: 'hax' })
    const d = await deleteIncome(bRow)
    check('A’s manager: update of B’s id refused ("no longer exists")', !!u.error, u)
    check('A’s manager: delete of B’s id removes nothing', JSON.stringify(await rowById(bRow)) === bSnap, d)
    const list = await listIncome(ctxOf(A, U.aManager))
    check('A’s listing never contains B’s row', list.rows.every((r) => r.id !== bRow) && list.total === '250.00', list)
  }
  signIn(U.bManager, B.slug)
  {
    const list = await listIncome(ctxOf(B, U.bManager))
    check('B’s listing contains only B’s row', list.count === 1 && list.rows[0].id === bRow)
    await updateIncome(aRow, { amount: 1, receivedOn: '2026-03-01', note: 'hax' })
    await deleteIncome(aRow)
    check('…and B’s manager cannot touch A’s row either', JSON.stringify(await rowById(aRow)) === aSnap)
  }
  check('RLS: A reads 0 of B’s rows by id', (await asUser(U.aManager.id, `select id from income where id=$1`, [bRow])).rowCount === 0)
  check('RLS: B reads 0 of A’s rows by id', (await asUser(U.bManager.id, `select id from income where id=$1`, [aRow])).rowCount === 0)
  check('RLS: A cannot UPDATE B’s row', (await asUser(U.aManager.id, `update income set note='x' where id=$1`, [bRow])).rowCount === 0)
  check('RLS: A cannot DELETE B’s row', (await asUser(U.aManager.id, `delete from income where id=$1`, [bRow])).rowCount === 0)
  check('RLS: A cannot INSERT into B’s tenant', !(await asUser(U.aManager.id, insSql, [B.tenantId])).ok)
  check('RLS: A cannot RE-HOME its own row into B (WITH CHECK)', !(await asUser(U.aManager.id, `update income set tenant_id=$2 where id=$1`, [aRow, B.tenantId])).ok)
  check('…the row is still A’s', JSON.stringify(await rowById(aRow)) === aSnap)
  check('opening balance: A cannot write B’s financial_settings', !(await asUser(U.aManager.id, `insert into financial_settings (tenant_id,opening_balance) values ($1,'1')`, [B.tenantId])).ok)
  signIn(U.aManager, A.slug)
  check('malformed id → validation error, not a crash', !!(await updateIncome('not-a-uuid', { amount: 1, receivedOn: '2026-03-01' })).error && !!(await deleteIncome('1 or 1=1')).error)
  check('well-formed but absent id → update refused', !!(await updateIncome('00000000-0000-4000-8000-000000000000', { amount: 1, receivedOn: '2026-03-01' })).error)

  // ═══ 4 · MONEY ═══════════════════════════════════════════════════════════════
  console.log('\n── 4 · money correctness ──')
  signIn(U.zManager, Z.slug)
  const stored = async (note: string) => (await q<{ amount: string }>(`select amount::text from income where tenant_id=$1 and note=$2`, [Z.tenantId, note])).rows[0]?.amount
  const accept: Array<[unknown, string]> = [
    [0, '0.00'],
    [0.01, '0.01'],
    [99_999_999.99, '99999999.99'],
    [10, '10.00'],
    [0.1 + 0.2, '0.30'],
    ['12.5', '12.50'],
    [' 7 ', '7.00'],
    [1234567.891, '1234567.89'],
  ]
  for (const [input, expected] of accept) {
    const note = `m-${String(input).trim()}`
    const r = await createIncome({ amount: input as number, receivedOn: '2026-03-02', note })
    check(`accepts ${JSON.stringify(input)} → stored exactly ${expected}`, !r.error && (await stored(note)) === expected, { r, got: await stored(note) })
  }
  const zList = await listIncome(ctxOf(Z, U.zManager))
  check('the reader returns every amount as a STRING', zList.rows.every((r) => typeof r.amount === 'string') && typeof zList.total === 'string')
  const zRef = (await q<{ s: string }>(`select sum(amount)::numeric(12,2)::text s from income where tenant_id=$1`, [Z.tenantId])).rows[0].s
  check('the SQL total equals the database’s own sum, to the paise', zList.total === zRef, { total: zList.total, zRef })
  await q(`delete from income where tenant_id=$1`, [Z.tenantId])
  {
    for (let i = 0; i < 3; i++) await createIncome({ amount: 0.1, receivedOn: '2026-03-02', note: 'tenth' })
    check('three × 0.10 totals exactly 0.30 (no float drift)', (await listIncome(ctxOf(Z, U.zManager))).total === '0.30')
    await q(`delete from income where tenant_id=$1`, [Z.tenantId])
  }
  const reject: Array<[string, Partial<Record<'amount' | 'receivedOn' | 'note', unknown>>]> = [
    ['100000000 (over the cap)', { amount: 100_000_000 }],
    ['99999999.995 (over the cap by half a paisa)', { amount: 99_999_999.995 }],
    ['-0.01', { amount: -0.01 }],
    ['"abc"', { amount: 'abc' }],
    ['"" (blank must not become 0.00)', { amount: '' }],
    ['"   " (whitespace)', { amount: '   ' }],
    ['null', { amount: null }],
    ['NaN', { amount: NaN }],
    ['Infinity', { amount: Infinity }],
    ['date 2026-02-30', { receivedOn: '2026-02-30' }],
    ['date 2026-02-29 (non-leap)', { receivedOn: '2026-02-29' }],
    ['date 2026-13-01', { receivedOn: '2026-13-01' }],
    ['date 2026-1-1', { receivedOn: '2026-1-1' }],
    ['date ""', { receivedOn: '' }],
    ['note of 501 chars', { note: 'x'.repeat(501) }],
  ]
  for (const [label, patch] of reject) {
    const r = await createIncome({ amount: 1, receivedOn: '2026-03-02', note: 'rej', ...patch } as never)
    check(`refuses ${label}`, !!r.error, r)
  }
  check('…and none of the refused attempts wrote a row', (await incomeRows(Z.tenantId)).length === 0)
  {
    const ok1 = await createIncome({ amount: 1, receivedOn: '2024-02-29', note: 'x'.repeat(500) })
    const ok2 = await createIncome({ amount: 1, receivedOn: '2026-03-02', note: '   ' })
    const ok3 = await createIncome({ amount: 1, receivedOn: '2026-03-02', note: '  padded  ' })
    const ok4 = await createIncome({ amount: 1, receivedOn: '2026-03-02', note: null })
    const rows = await incomeRows(Z.tenantId)
    check('accepts a leap day and a 500-char note', !ok1.error)
    check('whitespace-only note is stored as NULL', !ok2.error && rows.some((r) => r.note === null))
    check('a note is trimmed', !ok3.error && rows.some((r) => r.note === 'padded'))
    check('an explicit null note is accepted', !ok4.error)
    const upd = await updateIncome(rows[0].id, { amount: 3.5, receivedOn: '2026-03-03', note: 'edited' })
    const after = await rowById(rows[0].id)
    check('update rewrites the full shape, amount as 3.50', !upd.error && after.amount === '3.50' && after.note === 'edited', after)
    check('update refuses a bad amount and leaves the row alone', !!(await updateIncome(rows[0].id, { amount: -1, receivedOn: '2026-03-03' })).error && (await rowById(rows[0].id)).amount === '3.50')
  }
  await q(`delete from income where tenant_id=$1`, [Z.tenantId])

  // ═══ 5 · P&L MATH + CSV ══════════════════════════════════════════════════════
  console.log('\n── 5 · P&L: revenue + other income − expenses − payroll ──')
  let invSeq = 0
  async function invoice(day: string, total: string, status = 'issued') {
    invSeq++
    const inv = await q<{ id: string }>(
      `insert into invoices (tenant_id,branch_id,invoice_number,status,subtotal,discount,tax_total,total,issued_at)
       values ($1,$2,$3,$4::invoice_status,$5,0,0,$5,($6 || ' 12:00')::timestamp at time zone 'Asia/Kolkata') returning id`,
      [P.tenantId, P.branchId, `INV-QA357-${tag}-${invSeq}`, status, total, day],
    )
    await q(
      `insert into invoice_items (tenant_id,invoice_id,kind,description,qty,unit_price,tax_rate,line_total)
       values ($1,$2,'booking','line',1,$3,0,$3)`,
      [P.tenantId, inv.rows[0].id, total],
    )
    await q(
      `insert into payments (tenant_id,branch_id,invoice_id,method,amount,status,created_at)
       values ($1,$2,$3,'cash',$4,'captured',($5 || ' 12:00')::timestamp at time zone 'Asia/Kolkata')`,
      [P.tenantId, P.branchId, inv.rows[0].id, total, day],
    )
  }
  const cat = (await q<{ id: string }>(`insert into expense_categories (tenant_id,name) values ($1,'Rent') returning id`, [P.tenantId])).rows[0].id
  const expense = (amt: string, day: string) =>
    q(`insert into expenses (tenant_id,category_id,amount,spent_on) values ($1,$2,$3,$4)`, [P.tenantId, cat, amt, day])
  const payslip = (membershipId: string, period: string, gross: string) =>
    q(
      `insert into payslips (tenant_id,membership_id,period,base,days_in_period,days_present,gross,deductions_total,advance_instalment,net_pay)
       values ($1,$2,$3,$4,30,30,$4,0,0,$4)`,
      [P.tenantId, membershipId, period, gross],
    )

  // March: revenue 10000, income 1250.50, expenses 3000.25, payroll 4000 → 4250.25
  await invoice('2026-03-01', '4000.00')
  await invoice('2026-03-15', '5000.00')
  await invoice('2026-03-31', '1000.00')
  await seedIncome(P.tenantId, '1000.50', '2026-03-01', 'investment')
  await seedIncome(P.tenantId, '250.00', '2026-03-31', 'interest')
  await expense('2000.25', '2026-03-01')
  await expense('1000.00', '2026-03-31')
  await payslip(U.pManager.membershipId, '2026-03', '2500.00')
  await payslip(U.pCashier.membershipId, '2026-03', '1500.00')
  // April, float-hostile: 0.10 + 0.20 − 0.30 must be exactly 0, not 5.5e-17.
  await invoice('2026-04-10', '0.10')
  await seedIncome(P.tenantId, '0.20', '2026-04-10')
  await expense('0.30', '2026-04-10')
  // May, at the cap: 99999999.99 − 0.01.
  await seedIncome(P.tenantId, '99999999.99', '2026-05-05')
  await expense('0.01', '2026-05-05')
  // Rows dated just OUTSIDE March that must not count.
  await seedIncome(P.tenantId, '8888.00', '2026-02-28')
  await seedIncome(P.tenantId, '9999.00', '2026-04-01') // lands in April's range, not March's

  const ctxP = ctxOf(P, U.pManager)
  const r = await getPnlReport(ctxP, MARCH)
  check('revenue 10000', r.revenue.net === 10000, r.revenue.net)
  check('other income 1250.50', r.otherIncome.total === 1250.5, r.otherIncome.total)
  check('expenses 3000.25', r.expenses.total === 3000.25, r.expenses.total)
  check('payroll 4000', r.payroll.total === 4000, r.payroll.total)
  check('netProfit is EXACTLY 4250.25', r.netProfit === 4250.25, r.netProfit)
  check('…and equals the formula to the paise', r.netProfit === round2(r.revenue.net + r.otherIncome.total - r.expenses.total - r.payroll.total))
  const apr = await getPnlReport(ctxP, { start: '2026-04-01', end: '2026-04-30' })
  check('0.10 + 0.20 − 0.30 (+ the 9999 on Apr 1) has no float residue', apr.netProfit === round2(0.1 + 9999.2 - 0.3), apr.netProfit)
  const may = await getPnlReport(ctxP, { start: '2026-05-01', end: '2026-05-31' })
  check('99999999.99 income − 0.01 expense = 99999999.98 exactly', may.netProfit === 99_999_999.98, may.netProfit)

  console.log('\n── 5 · CSV equals the screen, line for line ──')
  {
    const rows = pnlCsvRows(r)
    const by = new Map(rows.map((x) => [x.label, x.amount]))
    check('Revenue row = revenue.net', by.get('Revenue') === r.revenue.net)
    check('Other income row = otherIncome.total (positive)', by.get('Other income') === r.otherIncome.total)
    check('Expenses row = −expenses.total', by.get('Expenses') === -r.expenses.total)
    check('Payroll row = −payroll.total', by.get('Payroll') === -r.payroll.total)
    check('Net row = netProfit', by.get('Net profit/loss') === r.netProfit)
    check('the four lines sum to the net, to the paise', round2(rows.slice(0, 4).reduce((s, x) => s + x.amount, 0)) === r.netProfit)
    check('labels appear once each (no duplicate lines)', new Set(rows.map((x) => x.label)).size === rows.length)
    check('no opening-balance row for an unset tenant', !rows.some((x) => /opening/i.test(x.label)))
    check('the Other income detail states the entry count and range', /2 entries, 2026-03-01 to 2026-03-31/.test(rows[1].detail), rows[1].detail)
  }

  // ═══ 6 · DATE EDGES ══════════════════════════════════════════════════════════
  console.log('\n── 6 · date filtering at the edges ──')
  {
    const e = { tenantId: Z.tenantId, slug: Z.slug }
    const ctxZ = ctxOf(e, U.zManager)
    for (const [d, a] of [['2026-02-28', '1'], ['2026-03-01', '2'], ['2026-03-31', '4'], ['2026-04-01', '8']]) await seedIncome(Z.tenantId, a, d)
    const r1 = await getPnlReport(ctxZ, MARCH)
    check('Feb 28 and Apr 1 excluded; Mar 1 and Mar 31 included (=6)', r1.otherIncome.total === 6 && r1.otherIncome.count === 2, r1.otherIncome)
    const day = await getPnlReport(ctxZ, { start: '2026-03-31', end: '2026-03-31' })
    check('a one-day range finds exactly that day', day.otherIncome.total === 4 && day.otherIncome.count === 1)
    const none = await getPnlReport(ctxZ, { start: '2026-03-02', end: '2026-03-30' })
    check('a range strictly between the rows finds nothing', none.otherIncome.total === 0 && none.otherIncome.count === 0)
    const reader = await listIncome(ctxZ, { from: '2026-03-01', to: '2026-03-31' })
    check('the /income reader agrees with the P&L on the same range', reader.total === '6.00' && reader.count === 2, reader)
    await seedIncome(Z.tenantId, '16', '2024-02-29')
    const leap = await getPnlReport(ctxZ, { start: '2024-02-29', end: '2024-02-29' })
    check('a leap day is found', leap.otherIncome.total === 16)
    const other = await getPnlReport({ ...(ctxZ as object), tenant: { ...(ctxZ as { tenant: object }).tenant, timezone: 'Pacific/Kiritimati' } } as never, MARCH)
    check('the tenant timezone cannot shift a DATE row across a boundary', other.otherIncome.total === 6)
    await q(`delete from income where tenant_id=$1`, [Z.tenantId])
  }

  // ═══ 7 · OPENING BALANCE ═════════════════════════════════════════════════════
  console.log('\n── 7 · opening balance never leaks into the math ──')
  const strip = (x: Awaited<ReturnType<typeof getPnlReport>>) => JSON.stringify({ ...x, openingBalance: undefined })
  {
    const unset = await getPnlReport(ctxP, MARCH)
    check('UNSET tenant: openingBalance is null (not 0, no crash)', unset.openingBalance === null)
    const baseline = strip(unset)
    signIn(U.pManager, P.slug)
    const set1 = await saveOpeningBalance({ amount: '9999999999.99', asOf: '2026-01-01' })
    const big = await getPnlReport(ctxP, MARCH)
    check('set via the real action, no error', !set1.error, set1)
    check('report shows the huge reference value', big.openingBalance?.amount === '9999999999.99')
    check('netProfit is bit-for-bit unchanged', Object.is(big.netProfit, unset.netProfit) && big.netProfit === 4250.25)
    check('EVERY other field of the report is identical', strip(big) === baseline)
    const wasNeg = await saveOpeningBalance({ amount: '-9999999999.99', asOf: '2020-01-01' })
    const neg = await getPnlReport(ctxP, MARCH)
    check('…also unchanged when set hugely NEGATIVE', !wasNeg.error && Object.is(neg.netProfit, unset.netProfit) && strip(neg) === baseline)
    check('exactly 2 audit rows after 2 changes', (await auditCount(P.tenantId)) === 2)
    await saveOpeningBalance({ amount: '-9999999999.99', asOf: '2020-01-01' })
    check('re-saving the same value adds no audit row', (await auditCount(P.tenantId)) === 2)
    const last = (await q<{ before: { openingBalance: string }; after: { openingBalance: string }; actor_membership_id: string }>(
      `select before, after, actor_membership_id from audit_log where tenant_id=$1 and entity_type='financial_settings' order by created_at desc, id desc limit 1`,
      [P.tenantId],
    )).rows[0]
    check('latest audit row is old → new with the actor', last.before.openingBalance === '9999999999.99' && last.after.openingBalance === '-9999999999.99' && last.actor_membership_id === U.pManager.membershipId, last)
    check('amount beyond numeric(12,2) is refused', !!(await saveOpeningBalance({ amount: '100000000000', asOf: null })).error)
    await saveOpeningBalance(null)
    check('cleared → report is back to null', (await getPnlReport(ctxP, MARCH)).openingBalance === null)
    check('…and the clear is audited (3 rows)', (await auditCount(P.tenantId)) === 3)
  }
  signIn(U.pCashier, P.slug)
  {
    const o = await saveOpeningBalance({ amount: '5', asOf: '2026-01-01' })
    check('a cashier cannot set it, and nothing is audited', refused(o) && (await auditCount(P.tenantId)) === 3, o)
  }

  // ═══ 8 · REVENUE ISOLATION ═══════════════════════════════════════════════════
  console.log('\n── 8 · revenue is bit-for-bit identical with and without income ──')
  {
    const range = { start: '2026-03-01', end: '2026-03-31' }
    const snapshot = async () =>
      JSON.stringify({
        dashboard: await getRevenueDashboard(ctxP, { range }),
        daily: await getDailyRevenue(ctxP, { range }),
        sales: await getSalesReport(ctxP, { range }),
        pnlRevenue: (await getPnlReport(ctxP, MARCH)).revenue,
      })
    const baseline = await snapshot()
    const dashBefore = await getRevenueDashboard(ctxP, { range })
    // Inside the range, on days WITH sales and days with none, huge and tiny.
    await seedIncome(P.tenantId, '99999999.99', '2026-03-15', 'huge')
    await seedIncome(P.tenantId, '0.01', '2026-03-02')
    await seedIncome(P.tenantId, '500000.00', '2026-03-20', 'owner investment')
    signIn(U.pManager, P.slug)
    await createIncome({ amount: 123456.78, receivedOn: '2026-03-31', note: 'via the action' })
    await updateIncome((await incomeRows(P.tenantId))[0].id, { amount: 2, receivedOn: '2026-03-10' })
    const after = await snapshot()
    check('dashboard + daily revenue + sales report + P&L revenue block: IDENTICAL', after === baseline)
    const dashAfter = await getRevenueDashboard(ctxP, { range })
    check('Revenue & Bookings headline totals unchanged', JSON.stringify([dashAfter.revenueTotals, dashAfter.channelTotals]) === JSON.stringify([dashBefore.revenueTotals, dashBefore.channelTotals]), { b: dashBefore.revenueTotals, a: dashAfter.revenueTotals })
    check('…whereas the P&L Other income line DID move', (await getPnlReport(ctxP, MARCH)).otherIncome.total > 1250.5)

    // Source scan: the guard against someone "simplifying" income into revenue.
    const ALLOWED = new Set(['lib/income/data.ts', 'lib/actions/income.ts', 'lib/reports/pnl.ts'])
    const files: string[] = []
    const walk = (dir: string) => {
      for (const n of readdirSync(dir)) {
        if (['node_modules', '.next', '.git'].includes(n)) continue
        const p = join(dir, n)
        if (statSync(p).isDirectory()) walk(p)
        else if (/\.(ts|tsx)$/.test(n)) files.push(p)
      }
    }
    for (const d of ['lib', 'app', 'components']) walk(join(process.cwd(), d))
    const importsIncome = (src: string) =>
      [...src.matchAll(/import\s*\{([^}]*)\}\s*from\s*'@\/db\/schema'/g)].some((m) =>
        m[1].split(',').some((id) => id.trim().split(/\s+as\s+/)[0] === 'income'),
      )
    const rawSql = (src: string) => /\b(from|join|into|update)\s+(public\.)?income\b/i.test(src)
    const offenders = files
      .map((f) => relative(process.cwd(), f).split(sep).join('/'))
      .filter((rel) => {
        const src = readFileSync(rel, 'utf8')
        return (importsIncome(src) || rawSql(src)) && !ALLOWED.has(rel)
      })
    check('nothing outside the ledger + P&L reads the income table', offenders.length === 0, offenders)
    for (const f of ['lib/reports/revenue-basis.ts', 'lib/reports/revenue.ts', 'lib/reports/daily-revenue.ts', 'lib/reports/sales.ts', 'lib/reports/bookings.ts']) {
      const src = readFileSync(f, 'utf8')
      check(`${f} does not reference income`, !importsIncome(src) && !rawSql(src))
    }
  }

  // ── clean up ──────────────────────────────────────────────────────────────
  await app.end()
  for (const s of Object.values(slugs)) await q(`delete from tenants where slug=$1`, [s])
  await q(`delete from users where email like $1`, [`qa357-%-${tag}@example.test`])
  await q(`delete from plans where name like 'QA income %'`).catch(() => {})
  await owner.end()

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
