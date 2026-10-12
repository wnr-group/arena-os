/**
 * M35 #1 — getPublicStorefrontSetups: the flat, public list of every active
 * setup across all available sets, for the storefront first page.
 *
 * The fetcher runs through withPublicTenant (the `arena_app` role, no
 * BYPASSRLS), so this exercises the real public RLS — fixtures are seeded via
 * the owner pool only. Pins:
 *   - 1 set / 4 setups -> 4 rows
 *   - 2 sets x 2 identically-named setups -> 4 rows, each with its own set name
 *   - inactive setup, maintenance set, other branch, other tenant -> never returned
 *   - set with zero active setups -> no row
 *   - non-studio industry -> []
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs --import ./scripts/next-runtime-hook.mjs scripts/test-storefront-setups.ts
 */
import { randomBytes } from 'node:crypto'
import { Pool } from 'pg'
import { loadEnv } from './env'

loadEnv()

let pass = 0
let fail = 0
const check = (label: string, cond: boolean, got?: unknown) => {
  console.log(`${cond ? '✓' : '✗ FAIL'}  ${label}${cond ? '' : `  (got: ${JSON.stringify(got)})`}`)
  if (cond) pass++
  else fail++
}

async function main() {
  const { getPublicStorefrontSetups } = await import('../lib/booking/public-availability')
  const owner = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })
  const tag = randomBytes(3).toString('hex')
  const tenantIds: string[] = []

  async function seedTenant(name: string, industry: string) {
    const t = await owner.query<{ id: string }>(
      `insert into tenants (slug,name,status,timezone,industry) values ($1,$2,'active','Asia/Kolkata',$3) returning id`,
      [`sf-setups-${name}-${tag}`, `SF ${name}`, industry],
    )
    tenantIds.push(t.rows[0].id)
    const b = await owner.query<{ id: string }>(
      `insert into branches (tenant_id,name,is_primary,status) values ($1,'Main',true,'active') returning id`,
      [t.rows[0].id],
    )
    const rt = await owner.query<{ id: string }>(
      `insert into resource_types (tenant_id,name,hourly_rate) values ($1,'Studio','500.00') returning id`,
      [t.rows[0].id],
    )
    return { tenantId: t.rows[0].id, branchId: b.rows[0].id, typeId: rt.rows[0].id }
  }
  const addSet = async (s: { tenantId: string; branchId: string; typeId: string }, name: string, status = 'available') =>
    (
      await owner.query<{ id: string }>(
        `insert into resources (tenant_id,branch_id,resource_type_id,name,status) values ($1,$2,$3,$4,$5) returning id`,
        [s.tenantId, s.branchId, s.typeId, name, status],
      )
    ).rows[0].id
  const addSetup = async (tenantId: string, resourceId: string, name: string, rate = '800.00', unit = 'hour', active = true) =>
    owner.query(
      `insert into resource_setups (tenant_id,resource_id,name,rate,rate_unit,is_active) values ($1,$2,$3,$4,$5,$6)`,
      [tenantId, resourceId, name, rate, unit, active],
    )

  // ── 1 set / 4 setups ─────────────────────────────────────────────────────
  const a = await seedTenant('a', 'recording_studio')
  const setA = await addSet(a, 'Set A')
  for (const n of ['Kitchen', 'Royal', 'Podcast', 'Green Room']) await addSetup(a.tenantId, setA, n)
  const r1 = await getPublicStorefrontSetups(a.tenantId, a.branchId, 'recording_studio')
  check('1 set / 4 setups -> 4 rows', r1.length === 4, r1.length)
  check('rows carry set + type names', r1.every((r) => r.resourceName === 'Set A' && r.resourceTypeName === 'Studio'), r1)

  // ── hidden cases, all on tenant A ────────────────────────────────────────
  await addSetup(a.tenantId, setA, 'Retired', '800.00', 'hour', false)
  const maint = await addSet(a, 'Set Maint', 'maintenance')
  await addSetup(a.tenantId, maint, 'On Maintenance')
  await addSet(a, 'Empty Set')
  const otherBranch = (
    await owner.query<{ id: string }>(`insert into branches (tenant_id,name,is_primary,status) values ($1,'Other',false,'active') returning id`, [a.tenantId])
  ).rows[0].id
  const otherBranchSet = (
    await owner.query<{ id: string }>(
      `insert into resources (tenant_id,branch_id,resource_type_id,name,status) values ($1,$2,$3,'Set Far','available') returning id`,
      [a.tenantId, otherBranch, a.typeId],
    )
  ).rows[0].id
  await addSetup(a.tenantId, otherBranchSet, 'Far Setup')
  const b = await seedTenant('b', 'recording_studio')
  await addSetup(b.tenantId, await addSet(b, 'Set B'), 'Other Tenant Setup')

  const r2 = await getPublicStorefrontSetups(a.tenantId, a.branchId, 'recording_studio')
  const names = r2.map((r) => r.setupName).sort()
  check('inactive / maintenance / empty set / other branch / other tenant never returned', r2.length === 4 && !names.some((n) => ['Retired', 'On Maintenance', 'Far Setup', 'Other Tenant Setup'].includes(n)), names)

  // ── 2 sets x 2 same-named setups ─────────────────────────────────────────
  const c = await seedTenant('c', 'podcast_studio')
  const c1 = await addSet(c, 'Studio A')
  const c2 = await addSet(c, 'Studio B')
  for (const s of [c1, c2]) {
    await addSetup(c.tenantId, s, 'Podcast Setup', '1000.00')
    await addSetup(c.tenantId, s, 'Day Rental', '9000.00', 'day')
  }
  const r3 = await getPublicStorefrontSetups(c.tenantId, c.branchId, 'podcast_studio')
  check('2 sets x 2 same-named setups -> 4 rows', r3.length === 4, r3.length)
  check(
    'each same-named setup carries its own set name',
    r3.filter((r) => r.setupName === 'Podcast Setup').map((r) => r.resourceName).sort().join() === 'Studio A,Studio B',
    r3,
  )
  const day = r3.find((r) => r.setupName === 'Day Rental')
  check('rate + rateUnit pass through', day?.rateUnit === 'day' && day?.rate === '9000.00', day)
  check('ordered by set name within the type', r3[0].resourceName === 'Studio A' && r3[3].resourceName === 'Studio B', r3.map((r) => r.resourceName))

  // ── non-studio industry ──────────────────────────────────────────────────
  const g = await seedTenant('g', 'gaming_cafe')
  await addSetup(g.tenantId, await addSet(g, 'PS5-1'), 'Sneaky')
  const r4 = await getPublicStorefrontSetups(g.tenantId, g.branchId, 'gaming_cafe')
  check('non-studio industry -> []', r4.length === 0, r4)

  for (const id of tenantIds) await owner.query('delete from tenants where id = $1', [id])
  await owner.end()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
