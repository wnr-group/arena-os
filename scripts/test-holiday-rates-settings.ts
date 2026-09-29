/**
 * M27 #3 — the owner settings actions for holiday rates: upsertHolidayRate /
 * deleteHolidayRate (lib/actions/resources.ts). Drives the REAL server
 * actions behind the REAL requireManager() guard, same shape
 * scripts/test-resource-setups-settings.ts already uses for the M24
 * precedent this ticket mirrors.
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs \
 *           --import ./scripts/next-runtime-hook.mjs \
 *           scripts/test-holiday-rates-settings.ts
 *
 * Pins:
 *   - a cashier is refused (requireManager), a manager/owner is not
 *   - a manager can add a holiday rate for a resource type
 *   - blank, non-numeric, and negative rates are all rejected server-side
 *   - a resourceTypeId belonging to another tenant is rejected ("Resource
 *     type not found"), not silently attached
 *   - a duplicate (resourceTypeId, date) on ADD is a clean upsert-in-place
 *     (the new rate wins, no raw unique-constraint error) — the one place
 *     this deliberately behaves differently from resource_setups' own
 *     duplicate-name-is-rejected precedent
 *   - editing a specific row by id updates it; editing its date to collide
 *     with a DIFFERENT existing row for the same type is rejected with a
 *     friendly message, not silently merged
 *   - a holiday-rate id on a DIFFERENT tenant is untouched by an edit OR a
 *     delete attempted under the wrong tenant (no hijack)
 *   - delete removes the row
 *   - listHolidayRates returns exactly what was written, scoped to the
 *     caller's own tenant
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
  const { upsertHolidayRate, deleteHolidayRate } = await import('../lib/actions/resources')
  const { listHolidayRates } = await import('../lib/booking/data')

  const owner = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })
  const tag = randomBytes(3).toString('hex')

  async function makeUser(label: string) {
    const email = `holiday-${label}-${tag}@example.test`
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

  const slug = `holiday${tag}`
  const t = await owner.query<{ id: string }>(
    `insert into tenants (slug,name,status,timezone,industry) values ($1,'Holiday Co','active','Asia/Kolkata','gaming_cafe') returning id`,
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
    `insert into resource_types (tenant_id,name,hourly_rate) values ($1,'PS5','200.00') returning id`,
    [tenantId],
  )
  const resourceTypeId = rt.rows[0].id

  // A second, unrelated tenant + resource type — for the cross-tenant checks.
  const other = await owner.query<{ id: string }>(
    `insert into tenants (slug,name,status,timezone) values ($1,'Other Co','active','Asia/Kolkata') returning id`,
    [`holidayother${tag}`],
  )
  const otherRt = await owner.query<{ id: string }>(
    `insert into resource_types (tenant_id,name,hourly_rate) values ($1,'Their PS5','100.00') returning id`,
    [other.rows[0].id],
  )
  const otherResourceTypeId = otherRt.rows[0].id
  const otherHoliday = await owner.query<{ id: string }>(
    `insert into holiday_rates (tenant_id,resource_type_id,date,rate) values ($1,$2,'2046-01-26','1.00') returning id`,
    [other.rows[0].id, otherResourceTypeId],
  )
  const otherHolidayId = otherHoliday.rows[0].id

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
  const cashierAttempt = await upsertHolidayRate({ resourceTypeId, date: '2046-10-02', rate: 500 })
  check('cashier is refused', OWNER_REFUSAL.test(cashierAttempt.error ?? ''), cashierAttempt)
  const { rows: afterCashier } = await owner.query('select 1 from holiday_rates where resource_type_id=$1', [resourceTypeId])
  check('…and nothing was written', afterCashier.length === 0)

  // ══ 2. manager adds a holiday rate ════════════════════════════════════════
  console.log('\n── manager adds a holiday rate ──')
  signedInAs(MANAGER.token)
  const added = await upsertHolidayRate({ resourceTypeId, date: '2046-10-02', rate: 500 })
  check('manager adds a rate for 2046-10-02', !added.error, added)
  const { rows: createdRows } = await owner.query<{ id: string; date: string; rate: string }>(
    "select id, date::text as date, rate from holiday_rates where resource_type_id=$1 and date='2046-10-02'",
    [resourceTypeId],
  )
  check('the row exists at the right rate', createdRows.length === 1 && createdRows[0].rate === '500.00')
  const gandhiJayantiId = createdRows[0].id

  // ══ 3. validation: blank / invalid / negative rate all rejected ══════════
  console.log('\n── rate validation ──')
  const blank = await upsertHolidayRate({ resourceTypeId, date: '2046-12-25', rate: '' as unknown as number })
  check('blank rate is rejected', /rate/i.test(blank.error ?? ''), blank)
  const invalid = await upsertHolidayRate({ resourceTypeId, date: '2046-12-25', rate: 'abc' as unknown as number })
  check('non-numeric rate is rejected', /rate/i.test(invalid.error ?? ''), invalid)
  const negative = await upsertHolidayRate({ resourceTypeId, date: '2046-12-25', rate: -5 })
  check('negative rate is rejected', /rate/i.test(negative.error ?? ''), negative)
  const { rows: afterBadRates } = await owner.query(
    "select 1 from holiday_rates where resource_type_id=$1 and date='2046-12-25'",
    [resourceTypeId],
  )
  check('…none of the three were written', afterBadRates.length === 0)

  const missingDate = await upsertHolidayRate({ resourceTypeId, date: '', rate: 100 })
  check('a blank date is rejected', Boolean(missingDate.error), missingDate)

  // ══ 4. a resourceTypeId on another tenant is rejected, not silently attached ═
  console.log('\n── cross-tenant fail-closed ──')
  const crossTenant = await upsertHolidayRate({ resourceTypeId: otherResourceTypeId, date: '2046-08-15', rate: 1 })
  check('a resourceTypeId belonging to another tenant is rejected', /not found/i.test(crossTenant.error ?? ''), crossTenant)
  const { rows: crossTenantCheck } = await owner.query('select 1 from holiday_rates where resource_type_id=$1 and date=$2', [
    otherResourceTypeId,
    '2046-08-15',
  ])
  check('…and nothing was written under the other tenant either', crossTenantCheck.length === 0)

  // Editing the OTHER tenant's holiday-rate id — but paired with a
  // resourceTypeId that DOES belong to this tenant, so the type-ownership
  // pre-check passes — must still not touch it: the UPDATE's own WHERE
  // clause is tenant-scoped on top of that, so it matches zero rows and
  // silently no-ops rather than hijacking someone else's row.
  await upsertHolidayRate({ id: otherHolidayId, resourceTypeId, date: '2046-01-26', rate: 999 })
  const { rows: otherAfterEdit } = await owner.query<{ rate: string; date: string }>(
    "select rate, date::text as date from holiday_rates where id=$1",
    [otherHolidayId],
  )
  check(
    "editing another tenant's holiday-rate id is a no-op, not a hijack",
    otherAfterEdit[0].rate === '1.00' && otherAfterEdit[0].date === '2046-01-26',
  )

  await deleteHolidayRate(otherHolidayId)
  const { rows: otherAfterDelete } = await owner.query('select 1 from holiday_rates where id=$1', [otherHolidayId])
  check("deleting another tenant's holiday-rate id is a no-op, not a deletion", otherAfterDelete.length === 1)

  // ══ 5. a duplicate (resourceTypeId, date) on ADD is a clean upsert ═══════
  console.log('\n── duplicate date on ADD: upsert-in-place, not an error ──')
  const resaved = await upsertHolidayRate({ resourceTypeId, date: '2046-10-02', rate: 750 })
  check('re-saving the SAME date with no id succeeds (no raw unique-constraint error)', !resaved.error, resaved)
  const { rows: afterResave } = await owner.query<{ id: string; rate: string }>(
    "select id, rate from holiday_rates where resource_type_id=$1 and date='2046-10-02'",
    [resourceTypeId],
  )
  check('still exactly one row for that date', afterResave.length === 1)
  check('…now at the new rate: 750.00', afterResave[0].rate === '750.00')
  check('…the SAME underlying row (same id), not a second one', afterResave[0].id === gandhiJayantiId)

  // ══ 6. editing by id: changing rate, and changing date onto a genuine
  //       collision with a DIFFERENT row is rejected ═══════════════════════
  console.log('\n── edit by id ──')
  const editRate = await upsertHolidayRate({ id: gandhiJayantiId, resourceTypeId, date: '2046-10-02', rate: 900 })
  check('editing the rate on the same date succeeds', !editRate.error, editRate)
  const { rows: afterRateEdit } = await owner.query('select rate from holiday_rates where id=$1', [gandhiJayantiId])
  check('…rate updated to 900.00', afterRateEdit[0].rate === '900.00')

  const otherDated = await upsertHolidayRate({ resourceTypeId, date: '2046-11-01', rate: 300 })
  check('a second, distinct date is added cleanly', !otherDated.error, otherDated)
  const collideEdit = await upsertHolidayRate({ id: gandhiJayantiId, resourceTypeId, date: '2046-11-01', rate: 1 })
  check(
    'editing a row onto a date a DIFFERENT row already owns is rejected, not silently merged',
    /already/i.test(collideEdit.error ?? ''),
    collideEdit,
  )
  const { rows: afterCollideAttempt } = await owner.query('select date::text as date from holiday_rates where id=$1', [
    gandhiJayantiId,
  ])
  check('…the original row keeps its own date, untouched', afterCollideAttempt[0].date === '2046-10-02')

  // ══ 7. listHolidayRates reads back exactly this tenant's own rows ════════
  console.log('\n── listHolidayRates ──')
  const { getActiveContext } = await import('../lib/tenant/context')
  const ctx = await getActiveContext()
  if (!ctx) throw new Error('expected an active context under the manager session')
  const listed = await listHolidayRates(ctx)
  check('lists exactly the 2 rows this tenant owns (not the other tenant\'s)', listed.length === 2, listed)
  check(
    'both dates present with the right rates',
    listed.some((r) => r.date === '2046-10-02' && r.rate === '900.00') &&
      listed.some((r) => r.date === '2046-11-01' && r.rate === '300.00'),
    listed,
  )

  // ══ 8. delete ═════════════════════════════════════════════════════════════
  console.log('\n── delete ──')
  const del = await deleteHolidayRate(gandhiJayantiId)
  check('deleting succeeds', !del.error, del)
  const { rows: afterDelete } = await owner.query('select 1 from holiday_rates where id=$1', [gandhiJayantiId])
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
