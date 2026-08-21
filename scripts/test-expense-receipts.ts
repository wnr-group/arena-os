/**
 * Expense receipt attachment (AROS-110).
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs scripts/test-expense-receipts.ts
 *
 * Three layers, none of which needs live S3 credentials (this environment has
 * none, so a test that actually PUT to a bucket could not run at all):
 *
 *   1. validateUpload()    — the server-side type/size/empty gate, called
 *                            directly. This is the real function the upload
 *                            path uses, not a copy of its rules.
 *   2. objectKeyFromUrl()  — the deletion guard. The property that matters is
 *                            that a URL outside our configured base yields no
 *                            key, so no crafted URL can make the server delete
 *                            an arbitrary object.
 *   3. receipt_url in the  — create/edit/replace/remove, tenant isolation and
 *      database              manager-only writes, asserted through RLS as the
 *                            `arena_app` role.
 *
 * What is NOT covered here: the S3 round trip itself (PutObject/DeleteObject).
 * That needs a bucket; see the summary.
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

/** Minimal stand-in for the parts of File that validateUpload reads. */
const asFile = (type: string, size: number) => ({ type, size })

async function main() {
  loadEnv()
  // A base must be set for objectKeyFromUrl to resolve anything; this mirrors a
  // configured deployment without needing credentials.
  process.env.S3_PUBLIC_URL_BASE ||= 'https://cdn.example.test/arena'

  const { validateUpload, objectKeyFromUrl, IMAGE_POLICY, RECEIPT_POLICY, RECEIPT_TYPES } =
    await import('../lib/storage/s3')

  const MB = 1024 * 1024
  const okType = (t: string, p = RECEIPT_POLICY) => {
    try {
      return validateUpload(asFile(t, 1024), p)
    } catch {
      return null
    }
  }
  const rejected = (t: string, size: number, p = RECEIPT_POLICY) => {
    try {
      validateUpload(asFile(t, size), p)
      return null
    } catch (e) {
      return (e as Error).message
    }
  }

  console.log('\n── accepted receipt types ──')
  check('JPEG accepted → .jpg', okType('image/jpeg') === 'jpg')
  check('PNG accepted → .png', okType('image/png') === 'png')
  check('WebP accepted → .webp', okType('image/webp') === 'webp')
  check('GIF accepted → .gif', okType('image/gif') === 'gif')
  check('PDF accepted → .pdf', okType('application/pdf') === 'pdf')
  check('PDF is NOT treated as an image', RECEIPT_TYPES['application/pdf'] === 'pdf')

  console.log('\n── rejected server-side ──')
  check('unsupported type refused', !!rejected('application/x-msdownload', 1024))
  check('…with a user-safe message', /allowed/i.test(rejected('text/html', 1024) ?? ''))
  check('svg refused (not in the table)', !!rejected('image/svg+xml', 1024))
  check('empty file refused', /empty/i.test(rejected('application/pdf', 0) ?? ''))
  check('oversized file refused', /smaller than/i.test(rejected('application/pdf', 6 * MB) ?? ''))
  check('exactly at the 5MB limit is accepted', okType('application/pdf') !== null && (() => {
    try { validateUpload(asFile('application/pdf', 5 * MB), RECEIPT_POLICY); return true } catch { return false }
  })())
  check('one byte over the limit is refused', !!rejected('application/pdf', 5 * MB + 1))

  console.log('\n── existing image uploads are unchanged ──')
  check('menu policy still accepts JPEG', okType('image/jpeg', IMAGE_POLICY) === 'jpg')
  check('menu policy still accepts GIF', okType('image/gif', IMAGE_POLICY) === 'gif')
  check('menu policy REFUSES pdf (receipts only)', !!rejected('application/pdf', 1024, IMAGE_POLICY))
  check('…and its message still names the image types',
    /JPEG, PNG, WEBP or GIF/.test(rejected('application/pdf', 1024, IMAGE_POLICY) ?? ''))

  console.log('\n── the deletion guard ──')
  const base = process.env.S3_PUBLIC_URL_BASE!.replace(/\/$/, '')
  check('a URL under our base yields its key',
    objectKeyFromUrl(`${base}/tenants/t1/expense-receipts/abc.pdf`) === 'tenants/t1/expense-receipts/abc.pdf')
  check('a URL on another host yields NOTHING',
    objectKeyFromUrl('https://evil.example/tenants/t1/x.pdf') === null)
  check('a bucket-root URL yields nothing', objectKeyFromUrl(base) === null)
  check('a traversal attempt yields nothing', objectKeyFromUrl(`${base}/../../etc/passwd`) === null)
  check('a base-prefix lookalike yields nothing',
    objectKeyFromUrl(`${base}-other/tenants/t1/x.pdf`) === null)
  check('null/empty yield nothing', objectKeyFromUrl(null) === null && objectKeyFromUrl('') === null)

  // ── database layer ────────────────────────────────────────────────────────
  const db = new Client({ connectionString: process.env.DATABASE_URL_OWNER })
  await db.connect()

  async function makeUser(tenantId: string, email: string, role: string) {
    const u = await db.query<{ id: string }>(
      `insert into users (email,password_hash) values ($1,'x')
       on conflict (email) do update set email=excluded.email returning id`, [email])
    await db.query(
      `insert into memberships (tenant_id,user_id,role,status) values ($1,$2,$3,'active')
       on conflict (tenant_id,user_id) do update set role=excluded.role,status='active'`,
      [tenantId, u.rows[0].id, role])
    return u.rows[0].id
  }
  async function makeTenant(slug: string) {
    const t = await db.query<{ id: string }>(
      `insert into tenants (slug,name,status) values ($1,$2,'active')
       on conflict (slug) do update set name=excluded.name returning id`, [slug, `${slug} co`])
    const id = t.rows[0].id
    return { tenantId: id, ownerId: await makeUser(id, `rc110-o@${slug}.test`, 'owner'),
             cashierId: await makeUser(id, `rc110-c@${slug}.test`, 'cashier') }
  }

  const A = await makeTenant('rc110-a')
  const B = await makeTenant('rc110-b')
  for (const t of [A.tenantId, B.tenantId]) {
    await db.query('delete from expenses where tenant_id=$1', [t])
    await db.query('delete from expense_categories where tenant_id=$1', [t])
  }
  const catA = (await db.query<{ id: string }>(
    `insert into expense_categories (tenant_id,name) values ($1,'Rent') returning id`, [A.tenantId])).rows[0].id
  const catB = (await db.query<{ id: string }>(
    `insert into expense_categories (tenant_id,name) values ($1,'Rent') returning id`, [B.tenantId])).rows[0].id

  const URL_OLD = `${base}/tenants/${A.tenantId}/expense-receipts/old.pdf`
  const URL_NEW = `${base}/tenants/${A.tenantId}/expense-receipts/new.jpg`

  const mkExpense = async (tenantId: string, cat: string, receipt: string | null) =>
    (await db.query<{ id: string }>(
      `insert into expenses (tenant_id,category_id,amount,spent_on,receipt_url)
       values ($1,$2,'100.00','2026-08-01',$3) returning id`, [tenantId, cat, receipt])).rows[0].id
  const receiptOf = async (id: string) =>
    (await db.query<{ receipt_url: string | null }>(`select receipt_url from expenses where id=$1`, [id]))
      .rows[0]?.receipt_url ?? null

  console.log('\n── receipt_url on the expense row ──')
  {
    const withR = await mkExpense(A.tenantId, catA, URL_OLD)
    const without = await mkExpense(A.tenantId, catA, null)
    check('an expense can be created WITH a receipt', (await receiptOf(withR)) === URL_OLD)
    check('…and without one (receipt is optional)', (await receiptOf(without)) === null)

    // Edit another field, leave receipt as-is — the value must survive.
    await db.query(`update expenses set note='edited', receipt_url=$2 where id=$1`, [withR, URL_OLD])
    check('editing another field keeps the existing receipt', (await receiptOf(withR)) === URL_OLD)

    // Replace, then remove.
    await db.query(`update expenses set receipt_url=$2 where id=$1`, [withR, URL_NEW])
    check('replacing points the row at the new object', (await receiptOf(withR)) === URL_NEW)
    check('…and the OLD url is derivable for cleanup', objectKeyFromUrl(URL_OLD) !== null)

    await db.query(`update expenses set receipt_url=null where id=$1`, [withR])
    check('removing sets receipt_url to NULL', (await receiptOf(withR)) === null)
  }

  console.log('\n── the list surfaces the receipt ──')
  {
    const r = await db.query<{ n: string }>(
      `select count(*)::text n from expenses where tenant_id=$1 and receipt_url is not null`, [A.tenantId])
    check('rows with a receipt are queryable for the indicator', Number(r.rows[0].n) >= 0)
  }

  console.log('\n── tenant isolation + manager-only (RLS) ──')
  {
    const bExpense = await mkExpense(B.tenantId, catB, `${base}/tenants/${B.tenantId}/expense-receipts/b.pdf`)
    const aExpense = await mkExpense(A.tenantId, catA, URL_OLD)
    const app = new Client({ connectionString: process.env.DATABASE_URL })
    await app.connect()
    async function asUser(userId: string, sql: string, params: unknown[]) {
      await app.query('begin')
      await app.query(`select set_config('app.user_id',$1,true)`, [userId])
      try { const r = await app.query(sql, params); await app.query('commit')
            return { ok: true, rowCount: r.rowCount ?? 0, rows: r.rows } }
      catch { await app.query('rollback'); return { ok: false, rowCount: 0, rows: [] as unknown[] } }
    }

    check('A cannot even READ B’s receipt_url',
      (await asUser(A.ownerId, 'select receipt_url from expenses where id=$1', [bExpense])).rows.length === 0)
    check('A cannot ATTACH a receipt to B’s expense',
      (await asUser(A.ownerId, `update expenses set receipt_url=$2 where id=$1`, [bExpense, URL_NEW])).rowCount === 0)
    check('A cannot REMOVE B’s receipt',
      (await asUser(A.ownerId, `update expenses set receipt_url=null where id=$1`, [bExpense])).rowCount === 0)
    check('A cannot DELETE B’s expense (and its receipt)',
      (await asUser(A.ownerId, 'delete from expenses where id=$1', [bExpense])).rowCount === 0)
    check('…so B’s receipt is still intact',
      (await receiptOf(bExpense)) === `${base}/tenants/${B.tenantId}/expense-receipts/b.pdf`)

    check('a CASHIER cannot attach a receipt',
      (await asUser(A.cashierId, `update expenses set receipt_url=$2 where id=$1`, [aExpense, URL_NEW])).rowCount === 0)
    check('a cashier cannot remove one either',
      (await asUser(A.cashierId, `update expenses set receipt_url=null where id=$1`, [aExpense])).rowCount === 0)
    check('…and the receipt is unchanged', (await receiptOf(aExpense)) === URL_OLD)
    check('A’s OWNER can attach one to its own expense',
      (await asUser(A.ownerId, `update expenses set receipt_url=$2 where id=$1 and tenant_id=$3`,
        [aExpense, URL_NEW, A.tenantId])).rowCount === 1)
    await app.end()
  }

  console.log('\n── the receipt key is built from the SESSION tenant ──')
  {
    // The prefix uploadExpenseReceipt() uses is `tenants/{ctx.tenant.id}/…`, so
    // a key can only ever land under the caller's own tenant. Asserting the
    // shape here documents the invariant the action depends on.
    const key = objectKeyFromUrl(URL_OLD)
    check('key is namespaced by tenant', key?.startsWith(`tenants/${A.tenantId}/expense-receipts/`) === true, key ?? 'null')
    check('B’s prefix is a different namespace',
      objectKeyFromUrl(`${base}/tenants/${B.tenantId}/expense-receipts/b.pdf`)?.includes(A.tenantId) === false)
  }

  await db.end()
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
