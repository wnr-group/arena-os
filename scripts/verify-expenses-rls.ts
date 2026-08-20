/**
 * Proves the expense tables' isolation and authorization guarantees against a
 * real database (AROS-107).
 *
 *   npx tsx scripts/verify-expenses-rls.ts
 *
 * Same shape as scripts/verify-rls.ts: provision two tenants as the owner role
 * (which bypasses RLS), then connect as the restricted `arena_app` role and
 * assert what each identity can actually see and do. Three things are checked
 * that a SELECT-only test would miss:
 *
 *   * INSERT / UPDATE / DELETE are manager-gated, not just SELECT;
 *   * a cashier — an ordinary active member — can READ but not WRITE;
 *   * the composite (tenant_id, id) FKs make a cross-tenant category or vendor
 *     reference fail in the DATABASE, not merely in application code.
 */
import { Client } from 'pg'
import { loadEnv } from './env'

let passed = 0
let failed = 0
function check(label: string, cond: boolean) {
  console.log(`${cond ? '✓' : '✗ FAIL'}  ${label}`)
  if (cond) passed++
  else failed++
}

async function main() {
  loadEnv()
  const ownerUrl = process.env.DATABASE_URL_OWNER!
  const appUrl = process.env.DATABASE_URL!

  // ── provisioning as owner (bypasses RLS) ──────────────────────────────────
  const owner = new Client({ connectionString: ownerUrl })
  await owner.connect()

  async function makeUser(tenantId: string, email: string, role: string) {
    const u = await owner.query<{ id: string }>(
      `insert into users (email, password_hash) values ($1, 'x')
       on conflict (email) do update set email = excluded.email returning id`,
      [email],
    )
    await owner.query(
      `insert into memberships (tenant_id, user_id, role, status)
       values ($1, $2, $3, 'active')
       on conflict (tenant_id, user_id) do update set role = excluded.role, status = 'active'`,
      [tenantId, u.rows[0].id, role],
    )
    return u.rows[0].id
  }

  async function makeTenant(slug: string) {
    const t = await owner.query<{ id: string }>(
      `insert into tenants (slug, name, status) values ($1, $2, 'active')
       on conflict (slug) do update set name = excluded.name returning id`,
      [slug, `${slug} co`],
    )
    const tenantId = t.rows[0].id
    return {
      tenantId,
      ownerId: await makeUser(tenantId, `exp-owner@${slug}.test`, 'owner'),
      cashierId: await makeUser(tenantId, `exp-cashier@${slug}.test`, 'cashier'),
    }
  }

  const alpha = await makeTenant('exp-alpha')
  const beta = await makeTenant('exp-beta')

  // A category + vendor + expense for each tenant, inserted as owner so the
  // assertions below start from a known, RLS-independent state.
  await owner.query('delete from expenses where tenant_id = any($1)', [[alpha.tenantId, beta.tenantId]])
  await owner.query('delete from expense_categories where tenant_id = any($1)', [[alpha.tenantId, beta.tenantId]])
  await owner.query('delete from vendors where tenant_id = any($1)', [[alpha.tenantId, beta.tenantId]])

  async function seed(tenantId: string, tag: string, amount: string) {
    const c = await owner.query<{ id: string }>(
      `insert into expense_categories (tenant_id, name) values ($1, $2) returning id`,
      [tenantId, `Rent ${tag}`],
    )
    const v = await owner.query<{ id: string }>(
      `insert into vendors (tenant_id, name, phone) values ($1, $2, '020-1234') returning id`,
      [tenantId, `Landlord ${tag}`],
    )
    const e = await owner.query<{ id: string }>(
      `insert into expenses (tenant_id, category_id, vendor_id, amount, spent_on, note)
       values ($1, $2, $3, $4, '2026-08-01', $5) returning id`,
      [tenantId, c.rows[0].id, v.rows[0].id, amount, `rent ${tag}`],
    )
    return { categoryId: c.rows[0].id, vendorId: v.rows[0].id, expenseId: e.rows[0].id }
  }

  const aSeed = await seed(alpha.tenantId, 'A', '1111.00')
  const bSeed = await seed(beta.tenantId, 'B', '2222.00')
  await owner.end()

  // ── assertions as the restricted app role (RLS enforced) ──────────────────
  const app = new Client({ connectionString: appUrl })
  await app.connect()

  async function asUser<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    await app.query('begin')
    await app.query(`select set_config('app.user_id', $1, true)`, [userId])
    try {
      return await fn()
    } finally {
      await app.query('commit')
    }
  }

  /** Runs `fn` in its own transaction and reports whether the DB refused it. */
  async function refused(userId: string, sql: string, params: unknown[]): Promise<boolean> {
    await app.query('begin')
    await app.query(`select set_config('app.user_id', $1, true)`, [userId])
    try {
      await app.query(sql, params)
      await app.query('commit')
      return false
    } catch {
      await app.query('rollback')
      return true
    }
  }

  console.log('\n── tenant isolation: reads ──')
  await asUser(alpha.ownerId, async () => {
    const c = await app.query('select id from expense_categories')
    check('alpha owner sees exactly 1 expense category', c.rows.length === 1)
    check('…and it is alpha’s', c.rows[0]?.id === aSeed.categoryId)
    const v = await app.query('select id from vendors')
    check('alpha owner sees exactly 1 vendor, its own', v.rows.length === 1 && v.rows[0].id === aSeed.vendorId)
    const e = await app.query('select id from expenses')
    check('alpha owner sees exactly 1 expense, its own', e.rows.length === 1 && e.rows[0].id === aSeed.expenseId)
  })

  await asUser(beta.ownerId, async () => {
    const e = await app.query<{ id: string; amount: string }>('select id, amount from expenses')
    check('beta owner sees only beta’s expense', e.rows.length === 1 && e.rows[0].id === bSeed.expenseId)
    check('money arrives as a STRING, not a float', typeof e.rows[0].amount === 'string')
    check('…at 2dp exactly', e.rows[0].amount === '2222.00')
  })

  console.log('\n── tenant isolation: targeted reads by id ──')
  await asUser(alpha.ownerId, async () => {
    const r = await app.query('select id from expenses where id = $1', [bSeed.expenseId])
    check('alpha owner cannot read beta’s expense by direct id', r.rows.length === 0)
    const c = await app.query('select id from expense_categories where id = $1', [bSeed.categoryId])
    check('alpha owner cannot read beta’s category by direct id', c.rows.length === 0)
    const v = await app.query('select id from vendors where id = $1', [bSeed.vendorId])
    check('alpha owner cannot read beta’s vendor by direct id', v.rows.length === 0)
  })

  console.log('\n── unauthenticated connection ──')
  await app.query('begin')
  {
    const e = await app.query('select id from expenses')
    const c = await app.query('select id from expense_categories')
    const v = await app.query('select id from vendors')
    check('no identity set → 0 expenses, 0 categories, 0 vendors',
      e.rows.length === 0 && c.rows.length === 0 && v.rows.length === 0)
  }
  await app.query('commit')

  console.log('\n── writes are owner/manager only ──')
  check(
    'cashier CANNOT insert an expense',
    await refused(alpha.cashierId,
      `insert into expenses (tenant_id, category_id, amount, spent_on) values ($1, $2, '5.00', '2026-08-02')`,
      [alpha.tenantId, aSeed.categoryId]),
  )
  check(
    'cashier CANNOT insert a category',
    await refused(alpha.cashierId, `insert into expense_categories (tenant_id, name) values ($1, 'Sneaky')`, [alpha.tenantId]),
  )
  check(
    'cashier CANNOT insert a vendor',
    await refused(alpha.cashierId, `insert into vendors (tenant_id, name) values ($1, 'Sneaky')`, [alpha.tenantId]),
  )

  // UPDATE/DELETE silently affect 0 rows under RLS rather than raising, so they
  // are asserted on the row count — the failure mode a SELECT-only test misses.
  await asUser(alpha.cashierId, async () => {
    const u = await app.query(`update expenses set note = 'tampered' where id = $1`, [aSeed.expenseId])
    check('cashier UPDATE on an expense affects 0 rows', u.rowCount === 0)
    const d = await app.query('delete from expenses where id = $1', [aSeed.expenseId])
    check('cashier DELETE on an expense affects 0 rows', d.rowCount === 0)
    const dc = await app.query('delete from expense_categories where id = $1', [aSeed.categoryId])
    check('cashier DELETE on a category affects 0 rows', dc.rowCount === 0)
    const dv = await app.query('delete from vendors where id = $1', [aSeed.vendorId])
    check('cashier DELETE on a vendor affects 0 rows', dv.rowCount === 0)
  })

  await asUser(alpha.cashierId, async () => {
    const r = await app.query('select note from expenses where id = $1', [aSeed.expenseId])
    check('…so the cashier CAN still read it, unchanged', r.rows[0]?.note === 'rent A')
  })

  console.log('\n── the owner CAN write, in their own tenant only ──')
  await asUser(alpha.ownerId, async () => {
    const u = await app.query(`update expenses set note = 'checked' where id = $1`, [aSeed.expenseId])
    check('alpha owner UPDATE on its own expense affects 1 row', u.rowCount === 1)
  })
  check(
    'alpha owner CANNOT insert an expense into beta',
    await refused(alpha.ownerId,
      `insert into expenses (tenant_id, category_id, amount, spent_on) values ($1, $2, '9.00', '2026-08-02')`,
      [beta.tenantId, bSeed.categoryId]),
  )
  check(
    'alpha owner CANNOT insert a vendor into beta',
    await refused(alpha.ownerId, `insert into vendors (tenant_id, name) values ($1, 'Cross')`, [beta.tenantId]),
  )
  await asUser(alpha.ownerId, async () => {
    const u = await app.query(`update expenses set note = 'x' where id = $1`, [bSeed.expenseId])
    check('alpha owner UPDATE on beta’s expense affects 0 rows', u.rowCount === 0)
  })

  console.log('\n── composite FKs block cross-tenant linkage in the DATABASE ──')
  check(
    'an expense in alpha CANNOT reference beta’s category',
    await refused(alpha.ownerId,
      `insert into expenses (tenant_id, category_id, amount, spent_on) values ($1, $2, '1.00', '2026-08-02')`,
      [alpha.tenantId, bSeed.categoryId]),
  )
  check(
    'an expense in alpha CANNOT reference beta’s vendor',
    await refused(alpha.ownerId,
      `insert into expenses (tenant_id, category_id, vendor_id, amount, spent_on)
       values ($1, $2, $3, '1.00', '2026-08-02')`,
      [alpha.tenantId, aSeed.categoryId, bSeed.vendorId]),
  )

  console.log('\n── referential rules ──')
  check(
    'deleting a category that has expenses FAILS (no silent history loss)',
    await refused(alpha.ownerId, 'delete from expense_categories where id = $1', [aSeed.categoryId]),
  )
  await asUser(alpha.ownerId, async () => {
    const d = await app.query('delete from vendors where id = $1', [aSeed.vendorId])
    check('deleting a vendor succeeds', d.rowCount === 1)
    const e = await app.query<{ vendor_id: string | null }>('select vendor_id from expenses where id = $1', [aSeed.expenseId])
    check('…and its expense survives with vendor_id set to null', e.rows.length === 1 && e.rows[0].vendor_id === null)
  })

  await app.end()
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
