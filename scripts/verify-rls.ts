/**
 * Proves the tenant-isolation guarantee end-to-end against a real database.
 *
 *   npx tsx scripts/verify-rls.ts
 *
 * Sets up two tenants (demo + acme) with one owner each, then, connecting as the
 * restricted `arena_app` role, asserts that RLS confines each user to their own
 * tenant — for reads AND writes — and that an unset identity sees nothing.
 */
import { Client } from 'pg'
import { loadEnv } from './env'

let passed = 0
let failed = 0
function check(label: string, cond: boolean) {
  console.log(`${cond ? '✓' : '✗ FAIL'}  ${label}`)
  cond ? passed++ : failed++
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
      `insert into tenants (slug, name, status) values ($1, $2, 'active')
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
       on conflict (tenant_id, user_id) do update set role = 'owner'`,
      [t.rows[0].id, u.rows[0].id],
    )
    return { tenantId: t.rows[0].id, userId: u.rows[0].id }
  }

  const demo = await makeTenant('demo', 'owner@demo.test')
  const acme = await makeTenant('acme', 'owner@acme.test')
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

  // 1. demo owner sees only demo
  await asUser(demo.userId, async () => {
    const r = await app.query<{ slug: string }>('select slug from tenants')
    check('demo owner sees exactly [demo]', r.rows.length === 1 && r.rows[0].slug === 'demo')
  })

  // 2. acme owner sees only acme
  await asUser(acme.userId, async () => {
    const r = await app.query<{ slug: string }>('select slug from tenants')
    check('acme owner sees exactly [acme]', r.rows.length === 1 && r.rows[0].slug === 'acme')
  })

  // 3. no identity set → sees nothing
  await app.query('begin')
  {
    const r = await app.query('select slug from tenants')
    check('unauthenticated app connection sees 0 tenants', r.rows.length === 0)
  }
  await app.query('commit')

  // 4. demo owner cannot read acme's memberships even by direct id
  await asUser(demo.userId, async () => {
    const r = await app.query('select id from memberships where tenant_id = $1', [acme.tenantId])
    check('demo owner sees 0 of acme memberships', r.rows.length === 0)
  })

  // 5. demo owner cannot WRITE into acme (RLS WITH CHECK blocks it)
  await asUser(demo.userId, async () => {
    let blocked = false
    try {
      await app.query(
        `insert into branches (tenant_id, name) values ($1, 'sneaky')`,
        [acme.tenantId],
      )
    } catch {
      blocked = true
    }
    check('demo owner CANNOT insert a branch into acme', blocked)
  })

  // 6. demo owner CAN write into their own tenant
  await asUser(demo.userId, async () => {
    let ok = false
    try {
      await app.query(
        `insert into branches (tenant_id, name) values ($1, 'demo-branch-2')
         on conflict (tenant_id, name) do nothing`,
        [demo.tenantId],
      )
      ok = true
    } catch {
      ok = false
    }
    check('demo owner CAN insert a branch into demo', ok)
  })

  await app.end()

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
