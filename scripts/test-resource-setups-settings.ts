/**
 * M24 #3 — the owner settings actions for a set's setups: upsertResourceSetup
 * / deleteResourceSetup (lib/actions/resources.ts). Drives the REAL server
 * actions behind the REAL requireManager() guard, exactly like
 * scripts/test-m16-authorization.ts — only next/headers + next/cache are
 * faked (a cookie jar and a no-op cache invalidator); the session lookup,
 * the role check, and every DB write are the genuine code path.
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs \
 *           --import ./scripts/next-runtime-hook.mjs \
 *           scripts/test-resource-setups-settings.ts
 *
 * Pins:
 *   - a cashier is refused (requireManager), a manager/owner is not
 *   - a manager can create an hourly (Kitchen) and a per-day (Royal) setup
 *   - blank, non-numeric, and negative rates are all rejected server-side
 *   - a resourceId belonging to another tenant is rejected ("Resource not
 *     found"), not silently attached
 *   - editing updates the row; deactivating flips is_active without deleting
 *   - a duplicate name on the same resource is rejected (unique constraint)
 *   - delete removes the row; a setup on a DIFFERENT tenant is untouched by
 *     either an edit or a delete attempted under the wrong tenant
 */
import { createHash, randomBytes } from 'node:crypto'
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
  const { upsertResourceSetup, deleteResourceSetup } = await import('../lib/actions/resources')

  const owner = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })
  const tag = randomBytes(3).toString('hex')

  async function makeUser(label: string) {
    const email = `setups-${label}-${tag}@example.test`
    const u = await owner.query<{ id: string }>(
      `insert into users (email, password_hash, full_name) values ($1,'x',$2) returning id`,
      [email, label],
    )
    const token = randomBytes(32).toString('hex')
    await owner.query(`insert into sessions (id, user_id, expires_at) values ($1,$2, now() + interval '1 day')`, [
      createHash('sha256').update(token).digest('hex'),
      u.rows[0].id,
    ])
    return { id: u.rows[0].id, token }
  }

  const OWNER_U = await makeUser('owner')
  const MANAGER = await makeUser('manager')
  const CASHIER = await makeUser('cashier')

  const slug = `setups${tag}`
  const t = await owner.query<{ id: string }>(
    `insert into tenants (slug,name,status,timezone,industry) values ($1,'Setups Co','active','Asia/Kolkata','recording_studio') returning id`,
    [slug],
  )
  const tenantId = t.rows[0].id
  const br = await owner.query<{ id: string }>(
    `insert into branches (tenant_id,name,is_primary) values ($1,'Main',true) returning id`,
    [tenantId],
  )
  const branchId = br.rows[0].id
  for (const [u, role] of [
    [OWNER_U, 'owner'],
    [MANAGER, 'manager'],
    [CASHIER, 'cashier'],
  ] as Array<[{ id: string }, string]>) {
    await owner.query(
      `insert into memberships (tenant_id,user_id,branch_id,role,status,full_name) values ($1,$2,$3,$4::member_role,'active',$5)`,
      [tenantId, u.id, branchId, role, role],
    )
  }
  const rt = await owner.query<{ id: string }>(
    `insert into resource_types (tenant_id,name,hourly_rate) values ($1,'Studio Set','500.00') returning id`,
    [tenantId],
  )
  const res = await owner.query<{ id: string }>(
    `insert into resources (tenant_id,branch_id,resource_type_id,name,status) values ($1,$2,$3,'Set A','available') returning id`,
    [tenantId, branchId, rt.rows[0].id],
  )
  const resourceId = res.rows[0].id

  // A second, unrelated tenant + resource — for the cross-tenant checks.
  const other = await owner.query<{ id: string }>(
    `insert into tenants (slug,name,status,timezone) values ($1,'Other Co','active','Asia/Kolkata') returning id`,
    [`setupsother${tag}`],
  )
  const otherBr = await owner.query<{ id: string }>(
    `insert into branches (tenant_id,name,is_primary) values ($1,'Main',true) returning id`,
    [other.rows[0].id],
  )
  const otherRt = await owner.query<{ id: string }>(
    `insert into resource_types (tenant_id,name,hourly_rate) values ($1,'Other Set','100.00') returning id`,
    [other.rows[0].id],
  )
  const otherRes = await owner.query<{ id: string }>(
    `insert into resources (tenant_id,branch_id,resource_type_id,name,status) values ($1,$2,$3,'Other A','available') returning id`,
    [other.rows[0].id, otherBr.rows[0].id, otherRt.rows[0].id],
  )
  const otherResourceId = otherRes.rows[0].id
  const otherSetup = await owner.query<{ id: string }>(
    `insert into resource_setups (tenant_id,resource_id,name,rate,rate_unit) values ($1,$2,'Theirs','1.00','hour') returning id`,
    [other.rows[0].id, otherResourceId],
  )
  const otherSetupId = otherSetup.rows[0].id

  // ── the harness switches (see test-m16-authorization.ts) ────────────────
  const g = globalThis as { __ARENA_TEST_SESSION?: string; __ARENA_TEST_HEADERS?: Record<string, string> }
  const signedInAs = (token?: string) => {
    g.__ARENA_TEST_SESSION = token
  }
  g.__ARENA_TEST_HEADERS = { 'x-tenant-slug': slug }

  const OWNER_REFUSAL = /owners and managers/i

  // ══ 1. a cashier is refused; owner/manager are not ═══════════════════════
  console.log('\n── role gate ──')
  signedInAs(CASHIER.token)
  const cashierAttempt = await upsertResourceSetup({ resourceId, name: 'Kitchen', rate: 800, rateUnit: 'hour' })
  check('cashier is refused', OWNER_REFUSAL.test(cashierAttempt.error ?? ''), cashierAttempt)

  const { rows: afterCashier } = await owner.query('select 1 from resource_setups where resource_id=$1', [resourceId])
  check('…and nothing was written', afterCashier.length === 0)

  // ══ 2. manager creates an hourly setup and a per-day setup ═══════════════
  console.log('\n── manager creates setups ──')
  signedInAs(MANAGER.token)
  const kitchenResult = await upsertResourceSetup({ resourceId, name: 'Kitchen', rate: 800, rateUnit: 'hour' })
  check('manager creates "Kitchen" (hour)', !kitchenResult.error, kitchenResult)
  const royalResult = await upsertResourceSetup({ resourceId, name: 'Royal', rate: 6000, rateUnit: 'day' })
  check('manager creates "Royal" (day)', !royalResult.error, royalResult)

  const { rows: created } = await owner.query<{ id: string; name: string; rate: string; rate_unit: string; is_active: boolean }>(
    'select id, name, rate, rate_unit, is_active from resource_setups where resource_id=$1 order by name',
    [resourceId],
  )
  check('both rows exist', created.length === 2)
  const kitchen = created.find((r) => r.name === 'Kitchen')!
  const royal = created.find((r) => r.name === 'Royal')!
  check('Kitchen: rate=800.00, unit=hour, active', kitchen.rate === '800.00' && kitchen.rate_unit === 'hour' && kitchen.is_active)
  check('Royal: rate=6000.00, unit=day, active', royal.rate === '6000.00' && royal.rate_unit === 'day' && royal.is_active)

  // ══ 3. validation: blank / invalid / negative rate all rejected ══════════
  console.log('\n── rate validation ──')
  const blank = await upsertResourceSetup({ resourceId, name: 'Blank', rate: '' as unknown as number, rateUnit: 'hour' })
  check('blank rate is rejected', /rate/i.test(blank.error ?? ''), blank)
  const invalid = await upsertResourceSetup({ resourceId, name: 'Invalid', rate: 'abc' as unknown as number, rateUnit: 'hour' })
  check('non-numeric rate is rejected', /rate/i.test(invalid.error ?? ''), invalid)
  const negative = await upsertResourceSetup({ resourceId, name: 'Negative', rate: -5, rateUnit: 'hour' })
  check('negative rate is rejected', /rate/i.test(negative.error ?? ''), negative)
  const { rows: afterBadRates } = await owner.query(
    "select 1 from resource_setups where resource_id=$1 and name in ('Blank','Invalid','Negative')",
    [resourceId],
  )
  check('…none of the three were written', afterBadRates.length === 0)

  // ══ 4. a resourceId on another tenant is rejected, not silently attached ═
  console.log('\n── cross-tenant fail-closed ──')
  const crossTenant = await upsertResourceSetup({ resourceId: otherResourceId, name: 'Sneaky', rate: 1, rateUnit: 'hour' })
  check('a resourceId belonging to another tenant is rejected', /not found/i.test(crossTenant.error ?? ''), crossTenant)

  // Editing the OTHER tenant's setup id — but paired with a resourceId that
  // DOES belong to this tenant, so the resource-ownership pre-check passes —
  // must still not touch it: the UPDATE's own WHERE clause is tenant-scoped
  // on top of that, so it matches zero rows and silently no-ops rather than
  // hijacking someone else's row.
  await upsertResourceSetup({ id: otherSetupId, resourceId, name: 'Hijacked', rate: 999, rateUnit: 'hour' })
  const { rows: otherAfterEdit } = await owner.query('select name, rate from resource_setups where id=$1', [otherSetupId])
  check('editing another tenant\'s setup id is a no-op, not a hijack', otherAfterEdit[0].name === 'Theirs' && otherAfterEdit[0].rate === '1.00')

  await deleteResourceSetup(otherSetupId)
  const { rows: otherAfterDelete } = await owner.query('select 1 from resource_setups where id=$1', [otherSetupId])
  check('deleting another tenant\'s setup id is a no-op, not a deletion', otherAfterDelete.length === 1)

  // ══ 5. edit + deactivate ══════════════════════════════════════════════════
  console.log('\n── edit + deactivate ──')
  const editResult = await upsertResourceSetup({ id: kitchen.id, resourceId, name: 'Kitchen', rate: 1500, rateUnit: 'hour', isActive: true })
  check('editing Kitchen\'s rate succeeds', !editResult.error, editResult)
  const deactivateResult = await upsertResourceSetup({ id: royal.id, resourceId, name: 'Royal', rate: 6000, rateUnit: 'day', isActive: false })
  check('deactivating Royal succeeds', !deactivateResult.error, deactivateResult)

  const { rows: afterEdits } = await owner.query<{ name: string; rate: string; is_active: boolean }>(
    'select name, rate, is_active from resource_setups where resource_id=$1 order by name',
    [resourceId],
  )
  const kitchenAfter = afterEdits.find((r) => r.name === 'Kitchen')!
  const royalAfter = afterEdits.find((r) => r.name === 'Royal')!
  check('Kitchen rate updated to 1500.00, still active', kitchenAfter.rate === '1500.00' && kitchenAfter.is_active)
  check('Royal deactivated (is_active=false), rate unchanged', royalAfter.is_active === false && royalAfter.rate === '6000.00')

  // ══ 6. duplicate name on the same resource is rejected ═══════════════════
  console.log('\n── duplicate name ──')
  const dup = await upsertResourceSetup({ resourceId, name: 'Kitchen', rate: 1, rateUnit: 'hour' })
  check('a duplicate name on the same resource is rejected', /already in use/i.test(dup.error ?? ''), dup)

  // ══ 7. delete ═════════════════════════════════════════════════════════════
  console.log('\n── delete ──')
  const del = await deleteResourceSetup(kitchen.id)
  check('deleting Kitchen succeeds', !del.error, del)
  const { rows: afterDelete } = await owner.query('select 1 from resource_setups where id=$1', [kitchen.id])
  check('…and it is actually gone', afterDelete.length === 0)

  // ── cleanup ───────────────────────────────────────────────────────────────
  await owner.query('delete from tenants where id = $1', [other.rows[0].id])
  await owner.query('delete from tenants where id = $1', [tenantId])
  await owner.query('delete from users where id = any($1)', [[OWNER_U.id, MANAGER.id, CASHIER.id]])
  await owner.end()

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
