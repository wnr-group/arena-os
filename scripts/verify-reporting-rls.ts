/**
 * Proves the reporting isolation guarantee end-to-end against a real database
 * (AROS-64) — the reporting sibling of verify-rls.ts, same shape.
 *
 *   npx tsx scripts/verify-reporting-rls.ts
 *
 * WHY THIS SCRIPT EXISTS SEPARATELY. A materialized view does NOT inherit the
 * RLS policies of the tables it was built from, and RLS cannot be enabled on
 * one. mv_daily_revenue therefore holds every tenant's revenue in a single
 * unprotected relation, and the entire isolation guarantee rests on two things
 * that must be verified rather than assumed:
 *
 *   1. arena_app has NO grant on the materialized view, and
 *   2. public.v_daily_revenue re-applies auth_tenant_ids() behind a
 *      security_barrier.
 *
 * Reading the SQL is not proof. This connects as the restricted `arena_app`
 * role — the role the application actually uses — and asserts the behaviour.
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

  async function makeTenant(slug: string, email: string) {
    const t = await owner.query<{ id: string }>(
      `insert into tenants (slug, name, status, timezone) values ($1, $2, 'active', 'Asia/Kolkata')
       on conflict (slug) do update set name = excluded.name returning id`,
      [slug, `${slug} co`],
    )
    const u = await owner.query<{ id: string }>(
      `insert into users (email, password_hash) values ($1, 'x')
       on conflict (email) do update set email = excluded.email returning id`,
      [email],
    )
    await owner.query(
      `insert into memberships (tenant_id, user_id, role, status)
       values ($1, $2, 'owner', 'active')
       on conflict (tenant_id, user_id) do update set role = 'owner', status = 'active'`,
      [t.rows[0].id, u.rows[0].id],
    )
    const b = await owner.query<{ id: string }>(
      `insert into branches (tenant_id, name) values ($1, $2)
       on conflict (tenant_id, name) do update set name = excluded.name returning id`,
      [t.rows[0].id, `${slug}-branch`],
    )
    return { tenantId: t.rows[0].id, userId: u.rows[0].id, branchId: b.rows[0].id }
  }

  const alpha = await makeTenant('rls-alpha', 'owner@rls-alpha.test')
  const beta = await makeTenant('rls-beta', 'owner@rls-beta.test')

  // An OUTSIDER: a real user with a real session who belongs to neither tenant.
  const outsider = await owner.query<{ id: string }>(
    `insert into users (email, password_hash) values ('outsider@rls.test', 'x')
     on conflict (email) do update set email = excluded.email returning id`,
  )
  const outsiderId = outsider.rows[0].id

  // A user whose membership of alpha is DISABLED — auth_tenant_ids() only
  // returns tenants with an ACTIVE membership, so revoking access must revoke
  // the reports too.
  const exStaff = await owner.query<{ id: string }>(
    `insert into users (email, password_hash) values ('exstaff@rls.test', 'x')
     on conflict (email) do update set email = excluded.email returning id`,
  )
  const exStaffId = exStaff.rows[0].id
  await owner.query(
    `insert into memberships (tenant_id, user_id, role, status)
     values ($1, $2, 'manager', 'disabled')
     on conflict (tenant_id, user_id) do update set status = 'disabled'`,
    [alpha.tenantId, exStaffId],
  )

  // Revenue for each tenant, on the same day, with distinguishable figures.
  await owner.query('delete from invoices where tenant_id = any($1)', [[alpha.tenantId, beta.tenantId]])
  await owner.query(
    `insert into invoices (tenant_id, branch_id, invoice_number, status, issued_at, subtotal, discount, tax_total, total)
     values ($1, $2, 'RLS-A-1', 'issued', '2026-05-01T06:00:00Z', 1111.00, 0, 0, 1111.00)`,
    [alpha.tenantId, alpha.branchId],
  )
  await owner.query(
    `insert into invoices (tenant_id, branch_id, invoice_number, status, issued_at, subtotal, discount, tax_total, total)
     values ($1, $2, 'RLS-B-1', 'paid', '2026-05-01T06:00:00Z', 2222.00, 0, 0, 2222.00)`,
    [beta.tenantId, beta.branchId],
  )
  await owner.query('select public.refresh_daily_revenue()')

  // Both rows really are in the materialized view — otherwise "tenant B sees
  // nothing of tenant A" would pass for the wrong reason.
  const inMv = await owner.query<{ n: string }>(
    `select count(*)::text n from public.mv_daily_revenue where tenant_id = any($1)`,
    [[alpha.tenantId, beta.tenantId]],
  )
  check('both tenants have a row in the materialized view (owner’s view)', inMv.rows[0].n === '2')
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

  type RevRow = { tenant_id: string; net: string }
  const readAll = () => app.query<RevRow>('select tenant_id, net from public.v_daily_revenue')

  // 1. alpha's owner sees exactly alpha's revenue
  await asUser(alpha.userId, async () => {
    const r = await readAll()
    check('alpha owner sees exactly 1 revenue row', r.rows.length === 1)
    check('…it is alpha’s tenant', r.rows[0]?.tenant_id === alpha.tenantId)
    check('…with alpha’s figure (1111.00)', r.rows[0]?.net === '1111.00')
    check('…and NOTHING of beta', !r.rows.some((x) => x.tenant_id === beta.tenantId))
  })

  // 2. beta's owner sees exactly beta's revenue — the mirror image
  await asUser(beta.userId, async () => {
    const r = await readAll()
    check('beta owner sees exactly 1 revenue row', r.rows.length === 1)
    check('…it is beta’s tenant', r.rows[0]?.tenant_id === beta.tenantId)
    check('…with beta’s figure (2222.00)', r.rows[0]?.net === '2222.00')
    check('…and NOTHING of alpha', !r.rows.some((x) => x.tenant_id === alpha.tenantId))
  })

  // 3. naming the other tenant explicitly does not help — the barrier predicate
  //    is ANDed with whatever the caller asks for, it is not a default filter.
  await asUser(beta.userId, async () => {
    const r = await app.query('select * from public.v_daily_revenue where tenant_id = $1', [alpha.tenantId])
    check('beta owner asking for alpha’s tenant_id BY ID gets 0 rows', r.rows.length === 0)
  })

  // 4. aggregates leak nothing either: a SUM over another tenant is over an
  //    empty set, not over hidden rows.
  await asUser(beta.userId, async () => {
    const r = await app.query<{ total: string | null; n: string }>(
      'select sum(net)::text total, count(*)::text n from public.v_daily_revenue where tenant_id = $1',
      [alpha.tenantId],
    )
    check('…and SUM(net) over alpha’s rows is NULL, not 1111.00', r.rows[0].total === null && r.rows[0].n === '0')
  })

  // 5. an authenticated user who is a member of NEITHER tenant sees nothing
  await asUser(outsiderId, async () => {
    const r = await readAll()
    check('a signed-in non-member sees 0 revenue rows', r.rows.length === 0)
  })

  // 6. a DISABLED membership grants nothing — auth_tenant_ids() requires active
  await asUser(exStaffId, async () => {
    const r = await readAll()
    check('a disabled member of alpha sees 0 revenue rows', r.rows.length === 0)
  })

  // 7. no identity set at all → nothing
  await app.query('begin')
  {
    const r = await readAll()
    check('an unauthenticated app connection sees 0 revenue rows', r.rows.length === 0)
  }
  await app.query('commit')

  // 8. THE backstop: the raw materialized view is not readable at all, so no
  //    forgotten join or hand-written query can bypass the barrier view.
  {
    let denied = false
    let message = ''
    try {
      await app.query('select * from public.mv_daily_revenue limit 1')
    } catch (e) {
      denied = true
      message = e instanceof Error ? e.message : String(e)
    }
    check('the app role CANNOT select from mv_daily_revenue', denied)
    check('…and is refused for lack of privilege', /permission denied/i.test(message))
  }

  // 9. the app role cannot refresh it either (that is an owner operation, and a
  //    refresh is expensive enough to be a denial-of-service lever).
  await asUser(alpha.userId, async () => {
    let denied = false
    try {
      await app.query('select public.refresh_daily_revenue()')
    } catch {
      denied = true
    }
    check('the app role CANNOT call refresh_daily_revenue()', denied)
  })

  // 10. and it cannot write to the reporting surface at all
  await asUser(alpha.userId, async () => {
    let denied = false
    try {
      await app.query('delete from public.v_daily_revenue')
    } catch {
      denied = true
    }
    check('the app role CANNOT write through the barrier view', denied)
  })

  // 11. the view is genuinely a security_barrier — the property is what stops a
  //     leaky user-defined function in a caller's WHERE from seeing other rows.
  {
    const r = await app.query<{ opts: string | null }>(
      `select array_to_string(c.reloptions, ',') opts
         from pg_class c where c.relname = 'v_daily_revenue'`,
    )
    check('v_daily_revenue is declared security_barrier', /security_barrier=true/.test(r.rows[0]?.opts ?? ''))
  }

  await app.end()

  // ── cleanup ───────────────────────────────────────────────────────────────
  const cleanup = new Client({ connectionString: ownerUrl })
  await cleanup.connect()
  await cleanup.query('delete from tenants where id = any($1)', [[alpha.tenantId, beta.tenantId]])
  await cleanup.query(`delete from users where email like '%@rls-%.test' or email like '%@rls.test'`)
  await cleanup.query('select public.refresh_daily_revenue()')
  await cleanup.end()

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
