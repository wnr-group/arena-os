/**
 * Exercises the Expenses page's data layer end-to-end (AROS-108).
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs scripts/test-expenses.ts
 *
 * Two tenants with their own categories, vendors and expenses, then every
 * filter combination the UI can produce — asserting BOTH the returned rows and
 * the SQL-computed total, because a total that disagrees with the rows under it
 * is the failure this ticket exists to prevent.
 *
 * Reads go through listExpenses() as the page calls it; writes go through the
 * real server actions where possible. The actions resolve their tenant from the
 * session, which a script has no way to fake, so tenant-scoping and the
 * manager gate are asserted directly against RLS as the `arena_app` role —
 * exactly the boundary a hand-crafted request would meet.
 */
import { Client } from 'pg'
import { loadEnv } from './env'

let passed = 0
let failed = 0
function check(label: string, cond: boolean, detail?: string) {
  console.log(`${cond ? '✓' : '✗ FAIL'}  ${label}${!cond && detail ? `  → ${detail}` : ''}`)
  if (cond) passed++
  else failed++
}

async function main() {
  loadEnv()
  const { listExpenses } = await import('../lib/expenses/data')
  const { listExpenseCategoryOptions, listVendorOptions } = await import('../lib/expenses/data')

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

  async function makeTenant(slug: string) {
    const t = await owner.query<{ id: string }>(
      `insert into tenants (slug, name, status) values ($1,$2,'active')
       on conflict (slug) do update set name = excluded.name returning id`,
      [slug, `${slug} co`],
    )
    const tenantId = t.rows[0].id
    return {
      tenantId,
      ownerId: await makeUser(tenantId, `exp108-owner@${slug}.test`, 'owner'),
      cashierId: await makeUser(tenantId, `exp108-cashier@${slug}.test`, 'cashier'),
      tenant: { id: tenantId, timezone: 'Asia/Kolkata', currency: 'INR', name: slug, slug },
    }
  }

  const A = await makeTenant('exp108-a')
  const B = await makeTenant('exp108-b')

  // Clean slate for both tenants.
  for (const t of [A.tenantId, B.tenantId]) {
    await owner.query('delete from expenses where tenant_id = $1', [t])
    await owner.query('delete from expense_categories where tenant_id = $1', [t])
    await owner.query('delete from vendors where tenant_id = $1', [t])
  }

  const cat = async (t: string, n: string) =>
    (await owner.query<{ id: string }>(`insert into expense_categories (tenant_id,name) values ($1,$2) returning id`, [t, n]))
      .rows[0].id
  const ven = async (t: string, n: string) =>
    (await owner.query<{ id: string }>(`insert into vendors (tenant_id,name) values ($1,$2) returning id`, [t, n])).rows[0].id
  const exp = async (t: string, c: string, v: string | null, amount: string, day: string, note = '') =>
    (
      await owner.query<{ id: string }>(
        `insert into expenses (tenant_id,category_id,vendor_id,amount,spent_on,note) values ($1,$2,$3,$4,$5,$6) returning id`,
        [t, c, v, amount, day, note],
      )
    ).rows[0].id

  // ── tenant A: 4 expenses across 2 categories, 2 vendors, 3 days ──────────
  const rentA = await cat(A.tenantId, 'Rent')
  const utilA = await cat(A.tenantId, 'Utilities')
  const landlordA = await ven(A.tenantId, 'Landlord')
  const powerA = await ven(A.tenantId, 'Power Co')
  await exp(A.tenantId, rentA, landlordA, '1000.00', '2026-08-01', 'August rent')
  await exp(A.tenantId, utilA, powerA, '250.50', '2026-08-05', 'electricity')
  await exp(A.tenantId, utilA, powerA, '100.25', '2026-08-20', 'water')
  const noVendorId = await exp(A.tenantId, rentA, null, '9.25', '2026-09-01', 'no vendor')
  // A's grand total: 1000.00 + 250.50 + 100.25 + 9.25 = 1360.00

  // ── tenant B: its own data, must never appear in A's results ─────────────
  const rentB = await cat(B.tenantId, 'Rent')
  const vendB = await ven(B.tenantId, 'Other Landlord')
  await exp(B.tenantId, rentB, vendB, '7777.77', '2026-08-01', 'B rent')
  await owner.end()

  const ctxA = { user: { id: A.ownerId }, tenant: A.tenant, role: 'owner' } as never
  const ctxB = { user: { id: B.ownerId }, tenant: B.tenant, role: 'owner' } as never

  console.log('\n── no filters: everything for this tenant ──')
  {
    const r = await listExpenses(ctxA)
    check('4 rows returned', r.rows.length === 4, `got ${r.rows.length}`)
    check('SQL total is 1360.00', r.total === '1360.00', `got ${r.total}`)
    check('count matches rows', r.count === 4)
    check('newest first', r.rows[0].spentOn === '2026-09-01' && r.rows[3].spentOn === '2026-08-01')
    check('amount is a STRING, not a float', typeof r.rows[0].amount === 'string')
    check('category name joined', r.rows[0].categoryName === 'Rent')
    check('null vendor renders as null, not a crash', r.rows[0].vendorName === null)
  }

  console.log('\n── tenant isolation ──')
  {
    const a = await listExpenses(ctxA)
    const b = await listExpenses(ctxB)
    check('B sees only its own single expense', b.rows.length === 1 && b.total === '7777.77')
    check('A total excludes B entirely', a.total === '1360.00')
    check('no B row leaks into A', a.rows.every((x) => x.amount !== '7777.77'))
  }

  console.log('\n── date range ──')
  {
    const r = await listExpenses(ctxA, { from: '2026-08-01', to: '2026-08-31' })
    check('August only → 3 rows', r.rows.length === 3, `got ${r.rows.length}`)
    check('August total is 1350.75', r.total === '1350.75', `got ${r.total}`)
    const inclusive = await listExpenses(ctxA, { from: '2026-08-01', to: '2026-08-01' })
    check('both ends INCLUSIVE (single day finds the 1st)', inclusive.count === 1 && inclusive.total === '1000.00')
    const openEnd = await listExpenses(ctxA, { from: '2026-08-20' })
    check('from-only is open ended → 2 rows', openEnd.count === 2 && openEnd.total === '109.50', `got ${openEnd.total}`)
  }

  console.log('\n── category filter ──')
  {
    const r = await listExpenses(ctxA, { categoryId: utilA })
    check('Utilities → 2 rows', r.rows.length === 2)
    check('Utilities total is 350.75', r.total === '350.75', `got ${r.total}`)
  }

  console.log('\n── vendor filter ──')
  {
    const r = await listExpenses(ctxA, { vendorId: powerA })
    check('Power Co → 2 rows, 350.75', r.rows.length === 2 && r.total === '350.75', `got ${r.total}`)
  }

  console.log('\n── combined filters (all must AND together) ──')
  {
    const r = await listExpenses(ctxA, {
      from: '2026-08-01',
      to: '2026-08-10',
      categoryId: utilA,
      vendorId: powerA,
    })
    check('date + category + vendor → exactly 1 row', r.rows.length === 1, `got ${r.rows.length}`)
    check('…and its total is that row alone (250.50)', r.total === '250.50', `got ${r.total}`)
    // Summed in integer paise so the assertion itself never depends on float
    // arithmetic — the property under test is "SQL total == the rows shown".
    const paise = (s: string) => Math.round(Number(s) * 100)
    const rowSum = r.rows.reduce((n, x) => n + paise(x.amount), 0)
    check('…the SQL total equals the sum of the rows shown', paise(r.total) === rowSum,
      `total ${r.total} vs rows ${rowSum / 100}`)
  }

  console.log('\n── empty result ──')
  {
    const r = await listExpenses(ctxA, { from: '2030-01-01', to: '2030-12-31' })
    check('no matches → 0 rows', r.rows.length === 0)
    check('…and total is 0.00, not null', r.total === '0.00', `got ${r.total}`)
    check('…and count is 0', r.count === 0)
  }

  console.log('\n── another tenant’s filter ids match nothing (never widen) ──')
  {
    const r = await listExpenses(ctxA, { categoryId: rentB })
    check('A filtering by B’s category → 0 rows, 0.00', r.rows.length === 0 && r.total === '0.00')
    const v = await listExpenses(ctxA, { vendorId: vendB })
    check('A filtering by B’s vendor → 0 rows, 0.00', v.rows.length === 0 && v.total === '0.00')
  }

  console.log('\n── default categories seed ──')
  {
    const { DEFAULT_EXPENSE_CATEGORIES } = await import('../lib/expenses/defaults')
    const seedC = new Client({ connectionString: process.env.DATABASE_URL_OWNER })
    await seedC.connect()
    // The exact statement scripts/seed-demo.ts runs, and the same set
    // lib/actions/platform.ts inserts when a tenant is provisioned.
    const seedSql = `insert into public.expense_categories (tenant_id, name)
                     select $1, unnest($2::text[]) on conflict do nothing`
    await seedC.query(seedSql, [B.tenantId, DEFAULT_EXPENSE_CATEGORIES as unknown as string[]])
    const first = await seedC.query<{ n: string }>(
      `select count(*)::text n from public.expense_categories where tenant_id=$1`, [B.tenantId])
    // B already had 'Rent' from the fixture above, so the six defaults add five.
    check('seeding adds the defaults', Number(first.rows[0].n) === DEFAULT_EXPENSE_CATEGORIES.length,
      `got ${first.rows[0].n}`)

    await seedC.query(seedSql, [B.tenantId, DEFAULT_EXPENSE_CATEGORIES as unknown as string[]])
    const second = await seedC.query<{ n: string }>(
      `select count(*)::text n from public.expense_categories where tenant_id=$1`, [B.tenantId])
    check('re-seeding is idempotent (no duplicates)', second.rows[0].n === first.rows[0].n,
      `${first.rows[0].n} → ${second.rows[0].n}`)

    const names = await seedC.query<{ name: string }>(
      `select name from public.expense_categories where tenant_id=$1 order by name`, [B.tenantId])
    check('…and every default is present',
      DEFAULT_EXPENSE_CATEGORIES.every((n) => names.rows.some((r) => r.name === n)))
    await seedC.end()
  }

  console.log('\n── selectors are tenant scoped ──')
  {
    const cats = await listExpenseCategoryOptions(ctxA)
    const vens = await listVendorOptions(ctxA)
    check('A sees exactly its 2 categories', cats.length === 2)
    check('…none of them B’s', !cats.some((c) => c.id === rentB))
    check('A sees exactly its 2 vendors', vens.length === 2)
    check('…none of them B’s', !vens.some((v) => v.id === vendB))
  }

  // ── the write boundary, asserted against RLS as the app role ─────────────
  console.log('\n── writes: manager only, tenant scoped (RLS) ──')
  const app = new Client({ connectionString: process.env.DATABASE_URL })
  await app.connect()
  async function asUser(userId: string, sql: string, params: unknown[]) {
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

  check(
    'cashier CANNOT insert an expense',
    !(await asUser(A.cashierId, `insert into expenses (tenant_id,category_id,amount,spent_on) values ($1,$2,'5.00','2026-08-02')`, [A.tenantId, rentA])).ok,
  )
  check(
    'cashier DELETE affects 0 rows',
    (await asUser(A.cashierId, 'delete from expenses where id = $1', [noVendorId])).rowCount === 0,
  )
  check(
    'cashier UPDATE affects 0 rows',
    (await asUser(A.cashierId, `update expenses set note='x' where id = $1`, [noVendorId])).rowCount === 0,
  )
  check(
    'A’s owner CANNOT delete B’s expense (tenant scoped)',
    (await asUser(A.ownerId, `delete from expenses where tenant_id = $1 and id in (select id from expenses)`, [B.tenantId])).rowCount === 0,
  )
  check(
    'A’s owner CAN update its own expense',
    (await asUser(A.ownerId, `update expenses set note='checked' where id = $1 and tenant_id = $2`, [noVendorId, A.tenantId])).rowCount === 1,
  )
  check(
    'an expense CANNOT reference another tenant’s category',
    !(await asUser(A.ownerId, `insert into expenses (tenant_id,category_id,amount,spent_on) values ($1,$2,'1.00','2026-08-02')`, [A.tenantId, rentB])).ok,
  )
  await app.end()

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
