/**
 * Exercises the Other income ledger's data layer + RLS (M40 / AROS-357).
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs scripts/test-income.ts
 *
 * Reads go through listIncome() as the page calls it. The server actions
 * resolve their tenant from the session, which a script cannot fake, so the
 * manager gate, tenant scoping and string-money round trip are asserted
 * directly against RLS as the `arena_app` role — the boundary a hand-crafted
 * request would meet. The action layer's entitlement gate is the same
 * requireEntitlement() call listIncome() makes, asserted on a plan-less tenant.
 */
import { Client } from 'pg'
import { loadEnv } from './env'
import { entitleTenant } from './entitle-fixture'

let passed = 0
let failed = 0
function check(label: string, cond: boolean, detail?: string) {
  console.log(`${cond ? '✓' : '✗ FAIL'}  ${label}${!cond && detail ? `  → ${detail}` : ''}`)
  if (cond) passed++
  else failed++
}

async function main() {
  loadEnv()
  const { listIncome } = await import('../lib/income/data')
  const { requireEntitlement } = await import('../lib/platform/entitlement-guard')

  const owner = new Client({ connectionString: process.env.DATABASE_URL_OWNER })
  await owner.connect()

  async function makeUser(tenantId: string, email: string, role: string) {
    const u = await owner.query<{ id: string }>(
      `insert into users (email, password_hash) values ($1,'x')
       on conflict (email) do update set email = excluded.email returning id`,
      [email],
    )
    await owner.query(
      `insert into memberships (tenant_id, user_id, role, status) values ($1,$2,$3,'active')
       on conflict (tenant_id, user_id) do update set role = excluded.role, status='active'`,
      [tenantId, u.rows[0].id, role],
    )
    return u.rows[0].id
  }

  async function makeTenant(slug: string, entitled: boolean) {
    const t = await owner.query<{ id: string }>(
      `insert into tenants (slug, name, status) values ($1,$2,'active')
       on conflict (slug) do update set name = excluded.name returning id`,
      [slug, `${slug} co`],
    )
    const tenantId = t.rows[0].id
    if (entitled) await entitleTenant(owner, tenantId)
    else await owner.query('delete from tenant_subscriptions where tenant_id = $1', [tenantId])
    return {
      tenantId,
      ownerId: await makeUser(tenantId, `inc357-owner@${slug}.test`, 'owner'),
      cashierId: await makeUser(tenantId, `inc357-cashier@${slug}.test`, 'cashier'),
      tenant: { id: tenantId, timezone: 'Asia/Kolkata', currency: 'INR', name: slug, slug },
    }
  }

  const A = await makeTenant('inc357-a', true)
  const B = await makeTenant('inc357-b', true)
  const N = await makeTenant('inc357-noplan', false)

  for (const t of [A.tenantId, B.tenantId, N.tenantId]) {
    await owner.query('delete from income where tenant_id = $1', [t])
  }
  const inc = async (t: string, amount: string, day: string, note: string | null = null) =>
    (
      await owner.query<{ id: string }>(
        `insert into income (tenant_id,amount,received_on,note) values ($1,$2,$3,$4) returning id`,
        [t, amount, day, note],
      )
    ).rows[0].id

  const aFirst = await inc(A.tenantId, '500000.00', '2026-08-01', 'owner investment')
  await inc(A.tenantId, '120.50', '2026-08-15', 'bank interest')
  await inc(A.tenantId, '9.25', '2026-09-01')
  const bRow = await inc(B.tenantId, '7777.77', '2026-08-01', 'B only')
  await inc(N.tenantId, '1.00', '2026-08-01')

  const ctxA = { user: { id: A.ownerId }, tenant: A.tenant, role: 'owner' } as never
  const ctxB = { user: { id: B.ownerId }, tenant: B.tenant, role: 'owner' } as never
  const ctxN = { user: { id: N.ownerId }, tenant: N.tenant, role: 'owner' } as never

  console.log('\n── listIncome ──')
  {
    const r = await listIncome(ctxA)
    check('3 rows', r.rows.length === 3 && r.count === 3, `got ${r.rows.length}`)
    check('SQL total is 500129.75', r.total === '500129.75', `got ${r.total}`)
    check('newest first', r.rows[0].receivedOn === '2026-09-01' && r.rows[2].receivedOn === '2026-08-01')
    check('amount is a STRING', typeof r.rows[0].amount === 'string')
    check('null note stays null', r.rows[0].note === null)
    const aug = await listIncome(ctxA, { from: '2026-08-01', to: '2026-08-31' })
    check('date range inclusive → 2 rows, 500120.50', aug.count === 2 && aug.total === '500120.50', `got ${aug.total}`)
    const day = await listIncome(ctxA, { from: '2026-08-01', to: '2026-08-01' })
    check('single day finds the 1st', day.count === 1 && day.total === '500000.00')
    const none = await listIncome(ctxA, { from: '2030-01-01' })
    check('empty → 0 rows, total 0.00', none.count === 0 && none.total === '0.00', `got ${none.total}`)
  }

  console.log('\n── tenant isolation (reader) ──')
  {
    const b = await listIncome(ctxB)
    check('B sees only its own row', b.count === 1 && b.total === '7777.77')
    const a = await listIncome(ctxA)
    check('A excludes B', a.rows.every((x) => x.amount !== '7777.77'))
  }

  console.log('\n── module.expenses off → refused ──')
  {
    let listErr = ''
    try {
      await listIncome(ctxN)
    } catch (e) {
      listErr = (e as Error).name
    }
    check('listIncome refused (EntitlementError)', listErr === 'EntitlementError', listErr || 'did not throw')
    // createIncome/updateIncome/deleteIncome all call this exact guard right
    // after requireManager().
    let gateErr = ''
    try {
      await requireEntitlement(ctxN, 'module.expenses')
    } catch (e) {
      gateErr = (e as Error).name
    }
    check('write-path gate refused (EntitlementError)', gateErr === 'EntitlementError', gateErr || 'did not throw')
  }

  console.log('\n── writes: manager only, tenant scoped (RLS as arena_app) ──')
  const app = new Client({ connectionString: process.env.DATABASE_URL })
  await app.connect()
  async function asUser(userId: string, sql: string, params: unknown[]) {
    await app.query('begin')
    await app.query(`select set_config('app.user_id',$1,true)`, [userId])
    try {
      const r = await app.query(sql, params)
      await app.query('commit')
      return { ok: true, rowCount: r.rowCount ?? 0, rows: r.rows }
    } catch {
      await app.query('rollback')
      return { ok: false, rowCount: 0, rows: [] as Record<string, unknown>[] }
    }
  }

  check(
    'cashier CANNOT insert income',
    !(await asUser(A.cashierId, `insert into income (tenant_id,amount,received_on) values ($1,'5.00','2026-08-02')`, [A.tenantId])).ok,
  )
  check('cashier UPDATE affects 0 rows', (await asUser(A.cashierId, `update income set note='x' where id=$1`, [aFirst])).rowCount === 0)
  check('cashier DELETE affects 0 rows', (await asUser(A.cashierId, 'delete from income where id=$1', [aFirst])).rowCount === 0)
  check('cashier CAN read (tenant members read)', (await asUser(A.cashierId, 'select id from income', [])).rowCount === 3)

  check(
    'A’s owner CAN insert its own',
    (await asUser(A.ownerId, `insert into income (tenant_id,amount,received_on) values ($1,'1.00','2026-08-02')`, [A.tenantId])).ok,
  )
  check('A’s owner CAN update its own', (await asUser(A.ownerId, `update income set note='ok' where id=$1`, [aFirst])).rowCount === 1)

  console.log('\n── cross-tenant (RLS) ──')
  {
    const seen = await asUser(A.ownerId, 'select id from income where id = $1', [bRow])
    check('A cannot READ B’s row', seen.rowCount === 0)
    check(
      'A cannot INSERT into B’s tenant',
      !(await asUser(A.ownerId, `insert into income (tenant_id,amount,received_on) values ($1,'1.00','2026-08-02')`, [B.tenantId])).ok,
    )
    check('A cannot UPDATE B’s row', (await asUser(A.ownerId, `update income set note='hax' where id=$1`, [bRow])).rowCount === 0)
    check('A cannot DELETE B’s row', (await asUser(A.ownerId, 'delete from income where id=$1', [bRow])).rowCount === 0)
  }

  console.log('\n── DB constraints + string money ──')
  {
    check(
      'negative amount rejected by CHECK',
      !(await asUser(A.ownerId, `insert into income (tenant_id,amount,received_on) values ($1,'-1.00','2026-08-02')`, [A.tenantId])).ok,
    )
    check(
      'note over 500 chars rejected by CHECK',
      !(await asUser(A.ownerId, `insert into income (tenant_id,amount,received_on,note) values ($1,'1.00','2026-08-02',$2)`, [A.tenantId, 'x'.repeat(501)])).ok,
    )
    // The action writes `amount.toFixed(2)`. Float-hostile values must survive
    // the string path exactly.
    for (const [num, expected] of [[0.1 + 0.2, '0.30'], [1.005, '1.00'], [99_999_999.99, '99999999.99'], [10, '10.00']] as const) {
      const s = num.toFixed(2)
      const ins = await asUser(
        A.ownerId,
        `insert into income (tenant_id,amount,received_on,note) values ($1,$2,'2026-10-01','rt') returning amount::text as amount`,
        [A.tenantId, s],
      )
      check(`round trip ${s} → ${expected}`, ins.ok && ins.rows[0]?.amount === expected, JSON.stringify(ins.rows))
    }
  }
  await app.end()

  await owner.query(`delete from income where tenant_id = any($1)`, [[A.tenantId, B.tenantId, N.tenantId]])
  await owner.end()

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
