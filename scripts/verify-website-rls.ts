/**
 * Proves the website builder tables' isolation and authorization guarantees
 * against a real database (M13 — migration 0044).
 *
 *   npx tsx scripts/verify-website-rls.ts
 *
 * Same shape as scripts/verify-expenses-rls.ts: provision two tenants as the
 * owner role (bypasses RLS), then connect as the restricted `arena_app` role
 * and assert what each identity can actually see and do. Covers three things
 * specific to this feature:
 *
 *   * website_sections / website_settings / website_pages are staff-read,
 *     manager-write, same as every other tenant-scoped settings table;
 *   * website_pages ALSO has a public-read policy (the only one of the three
 *     a stranger can ever see) — verified through the same
 *     app.public_tenant_id pinning withPublicTenant() uses, confirming a
 *     visitor pinned to tenant A never sees tenant B's published snapshot;
 *   * website_sections / website_settings have NO public policy at all — a
 *     public (or wrong-tenant) connection sees 0 rows even though the table
 *     itself is reachable.
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
      ownerId: await makeUser(tenantId, `site-owner@${slug}.test`, 'owner'),
      cashierId: await makeUser(tenantId, `site-cashier@${slug}.test`, 'cashier'),
    }
  }

  const alpha = await makeTenant('site-alpha')
  const beta = await makeTenant('site-beta')

  await owner.query('delete from website_sections where tenant_id = any($1)', [[alpha.tenantId, beta.tenantId]])
  await owner.query('delete from website_settings where tenant_id = any($1)', [[alpha.tenantId, beta.tenantId]])
  await owner.query('delete from website_pages where tenant_id = any($1)', [[alpha.tenantId, beta.tenantId]])

  async function seed(tenantId: string, tag: string) {
    const s = await owner.query<{ id: string }>(
      `insert into website_sections (tenant_id, type, heading, content, position)
       values ($1, 'text', $2, $3, 0) returning id`,
      [tenantId, `Hello ${tag}`, JSON.stringify({ body: `Body ${tag}` })],
    )
    await owner.query(
      `insert into website_settings (tenant_id, accent_color) values ($1, $2)
       on conflict (tenant_id) do update set accent_color = excluded.accent_color`,
      [tenantId, '#111111'],
    )
    const snapshot = {
      sections: [{ id: s.rows[0].id, type: 'text', heading: `Hello ${tag}`, position: 0, content: { body: `Body ${tag}` } }],
      settings: { logoUrl: null, accentColor: '#111111', heroImageUrl: null },
    }
    await owner.query(
      `insert into website_pages (tenant_id, published_snapshot, published_at) values ($1, $2, now())
       on conflict (tenant_id) do update set published_snapshot = excluded.published_snapshot, published_at = now()`,
      [tenantId, JSON.stringify(snapshot)],
    )
    return { sectionId: s.rows[0].id }
  }

  const aSeed = await seed(alpha.tenantId, 'A')
  const bSeed = await seed(beta.tenantId, 'B')
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

  async function asPublicTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    await app.query('begin')
    await app.query(`select set_config('app.public_tenant_id', $1, true)`, [tenantId])
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

  console.log('\n── tenant isolation: reads (staff) ──')
  await asUser(alpha.ownerId, async () => {
    const s = await app.query('select id from website_sections')
    check('alpha owner sees exactly 1 section, its own', s.rows.length === 1 && s.rows[0].id === aSeed.sectionId)
    const st = await app.query('select tenant_id from website_settings')
    check('alpha owner sees exactly 1 settings row, its own', st.rows.length === 1 && st.rows[0].tenant_id === alpha.tenantId)
    const p = await app.query('select tenant_id from website_pages')
    check('alpha owner sees exactly 1 pages row, its own', p.rows.length === 1 && p.rows[0].tenant_id === alpha.tenantId)
  })

  console.log('\n── tenant isolation: targeted reads by id ──')
  await asUser(alpha.ownerId, async () => {
    const s = await app.query('select id from website_sections where id = $1', [bSeed.sectionId])
    check('alpha owner cannot read beta’s section by direct id', s.rows.length === 0)
    const st = await app.query('select tenant_id from website_settings where tenant_id = $1', [beta.tenantId])
    check('alpha owner cannot read beta’s settings by direct tenant id', st.rows.length === 0)
    const p = await app.query('select tenant_id from website_pages where tenant_id = $1', [beta.tenantId])
    check('alpha owner cannot read beta’s pages row by direct tenant id', p.rows.length === 0)
  })

  console.log('\n── unauthenticated (no user, no public tenant) connection ──')
  await app.query('begin')
  {
    const s = await app.query('select id from website_sections')
    const st = await app.query('select tenant_id from website_settings')
    const p = await app.query('select tenant_id from website_pages')
    check('no identity set → 0 sections, 0 settings, 0 pages', s.rows.length === 0 && st.rows.length === 0 && p.rows.length === 0)
  }
  await app.query('commit')

  console.log('\n── public homepage read: website_pages only, pinned to one tenant ──')
  await asPublicTenant(alpha.tenantId, async () => {
    const p = await app.query('select tenant_id from website_pages')
    check('public visitor pinned to alpha sees exactly alpha’s pages row', p.rows.length === 1 && p.rows[0].tenant_id === alpha.tenantId)
    const s = await app.query('select id from website_sections')
    const st = await app.query('select tenant_id from website_settings')
    check('…but the DRAFT tables stay invisible even when pinned', s.rows.length === 0 && st.rows.length === 0)
  })
  await asPublicTenant(beta.tenantId, async () => {
    const p = await app.query('select tenant_id from website_pages')
    check('public visitor pinned to beta sees exactly beta’s pages row, not alpha’s', p.rows.length === 1 && p.rows[0].tenant_id === beta.tenantId)
  })

  console.log('\n── writes are owner/manager only ──')
  check(
    'cashier CANNOT insert a section',
    await refused(alpha.cashierId, `insert into website_sections (tenant_id, type, content) values ($1, 'text', '{}')`, [alpha.tenantId]),
  )
  check(
    'cashier CANNOT upsert settings',
    await refused(alpha.cashierId, `insert into website_settings (tenant_id, accent_color) values ($1, '#ffffff')`, [alpha.tenantId]),
  )
  check(
    'cashier CANNOT publish (insert into website_pages)',
    await refused(alpha.cashierId, `insert into website_pages (tenant_id, published_snapshot) values ($1, '{}')`, [alpha.tenantId]),
  )

  await asUser(alpha.cashierId, async () => {
    const u = await app.query(`update website_sections set heading = 'tampered' where id = $1`, [aSeed.sectionId])
    check('cashier UPDATE on a section affects 0 rows', u.rowCount === 0)
    const d = await app.query('delete from website_sections where id = $1', [aSeed.sectionId])
    check('cashier DELETE on a section affects 0 rows', d.rowCount === 0)
  })
  await asUser(alpha.cashierId, async () => {
    const r = await app.query('select heading from website_sections where id = $1', [aSeed.sectionId])
    check('…so the cashier CAN still read it, unchanged', r.rows[0]?.heading === 'Hello A')
  })

  console.log('\n── the owner CAN write, in their own tenant only ──')
  await asUser(alpha.ownerId, async () => {
    const u = await app.query(`update website_sections set heading = 'checked' where id = $1`, [aSeed.sectionId])
    check('alpha owner UPDATE on its own section affects 1 row', u.rowCount === 1)
  })
  check(
    'alpha owner CANNOT insert a section into beta',
    await refused(alpha.ownerId, `insert into website_sections (tenant_id, type, content) values ($1, 'text', '{}')`, [beta.tenantId]),
  )
  await asUser(alpha.ownerId, async () => {
    const u = await app.query(`update website_sections set heading = 'x' where id = $1`, [bSeed.sectionId])
    check('alpha owner UPDATE on beta’s section affects 0 rows', u.rowCount === 0)
  })

  await app.end()
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
