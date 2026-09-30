/**
 * M29 #2 — board extra-player surcharge settings on a resource type:
 * upsertResourceType (lib/actions/resources.ts). Drives the REAL server action
 * behind the REAL requireManager() guard, same shape as
 * scripts/test-holiday-rates-settings.ts.
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs \
 *           --import ./scripts/next-runtime-hook.mjs \
 *           scripts/test-board-surcharge-settings.ts
 *
 * Pins:
 *   - a cashier is refused and nothing is written
 *   - a manager can turn the surcharge on for a per_resource type (included
 *     players + both extra-player rates) and it reads back
 *   - a per_head type with an extra rate (base OR weekend) is rejected
 *     server-side, and switching a surcharged type to per_head clears it
 *   - a weekend extra rate without a base extra rate is rejected
 *   - includedPlayers must be a positive integer; negative rates are rejected
 *   - blank extra rates land as null (off), not 0
 *   - a non-gaming_cafe tenant cannot set a surcharge
 *   - SNAPSHOT FREEZE: editing a type's surcharge numbers never changes what
 *     an already-taken booking slot was charged (rate_applied,
 *     extra_player_rate_applied, slot_total, head_count are frozen snapshots)
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
  const { upsertResourceType } = await import('../lib/actions/resources')

  const owner = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })
  const tag = randomBytes(3).toString('hex')

  async function makeUser(label: string) {
    const u = await owner.query<{ id: string }>(
      `insert into users (email, password_hash, full_name) values ($1,'x',$2) returning id`,
      [`surcharge-${label}-${tag}@example.test`, label],
    )
    const token = randomBytes(32).toString('hex')
    await owner.query(`insert into sessions (id, user_id, expires_at) values ($1,$2, now() + interval '1 day')`, [
      createHash('sha256').update(token).digest('hex'),
      u.rows[0].id,
    ])
    return { id: u.rows[0].id, token }
  }
  async function makeTenant(slug: string, industry: string, users: Array<[{ id: string }, string]>) {
    const t = await owner.query<{ id: string }>(
      `insert into tenants (slug,name,status,timezone,industry) values ($1,'Surcharge Co','active','Asia/Kolkata',$2) returning id`,
      [slug, industry],
    )
    const br = await owner.query<{ id: string }>(
      `insert into branches (tenant_id,name,is_primary) values ($1,'Main',true) returning id`,
      [t.rows[0].id],
    )
    for (const [u, role] of users) {
      await owner.query(
        `insert into memberships (tenant_id,user_id,branch_id,role,status,full_name) values ($1,$2,$3,$4::member_role,'active',$5)`,
        [t.rows[0].id, u.id, br.rows[0].id, role, role],
      )
    }
    return { tenantId: t.rows[0].id, branchId: br.rows[0].id }
  }

  const MANAGER = await makeUser('manager')
  const CASHIER = await makeUser('cashier')
  const OTHER_MANAGER = await makeUser('othermanager')

  const slug = `surcharge${tag}`
  const { tenantId, branchId } = await makeTenant(slug, 'gaming_cafe', [
    [MANAGER, 'manager'],
    [CASHIER, 'cashier'],
  ])
  const otherSlug = `surchargeother${tag}`
  const other = await makeTenant(otherSlug, 'vr_centre', [[OTHER_MANAGER, 'manager']])

  const g = globalThis as { __ARENA_TEST_SESSION?: string; __ARENA_TEST_HEADERS?: Record<string, string> }
  const signedInAs = (token?: string, tenantSlug = slug) => {
    g.__ARENA_TEST_SESSION = token
    g.__ARENA_TEST_HEADERS = { 'x-tenant-slug': tenantSlug }
  }

  const readType = async (id: string) =>
    (
      await owner.query<{
        pricing_mode: string
        included_players: number
        extra_player_rate: string | null
        extra_player_weekend_rate: string | null
      }>(
        'select pricing_mode, included_players, extra_player_rate, extra_player_weekend_rate from resource_types where id=$1',
        [id],
      )
    ).rows[0]

  const base = { name: 'Snooker', hourlyRate: 300 }

  // ══ 1. role gate ══════════════════════════════════════════════════════════
  console.log('\n── role gate ──')
  signedInAs(CASHIER.token)
  const cashier = await upsertResourceType({ ...base, includedPlayers: 2, extraPlayerRate: 50 })
  check('cashier is refused', /owners and managers/i.test(cashier.error ?? ''), cashier)
  const { rows: none } = await owner.query('select 1 from resource_types where tenant_id=$1', [tenantId])
  check('…and nothing was written', none.length === 0)

  // ══ 2. manager turns the surcharge on ═════════════════════════════════════
  console.log('\n── manager configures surcharge ──')
  signedInAs(MANAGER.token)
  const created = await upsertResourceType({
    ...base,
    pricingMode: 'per_resource',
    includedPlayers: 2,
    extraPlayerRate: 50,
    extraPlayerWeekendRate: 75,
  })
  check('manager creates a per_resource type with surcharge', !created.error, created)
  const { rows: made } = await owner.query<{ id: string }>('select id from resource_types where tenant_id=$1', [tenantId])
  const typeId = made[0].id
  const t1 = await readType(typeId)
  check(
    'included players + both rates read back',
    t1.included_players === 2 && t1.extra_player_rate === '50.00' && t1.extra_player_weekend_rate === '75.00',
    t1,
  )

  const baseOnly = await upsertResourceType({
    ...base,
    id: typeId,
    includedPlayers: 2,
    extraPlayerRate: 50,
    extraPlayerWeekendRate: '' as unknown as null,
  })
  check('base-only surcharge accepted', !baseOnly.error, baseOnly)
  const t2 = await readType(typeId)
  check('blank weekend extra rate lands as null, not 0', t2.extra_player_weekend_rate === null, t2)

  const off = await upsertResourceType({ ...base, id: typeId, includedPlayers: 1, extraPlayerRate: '' as unknown as null })
  check('blank extra rate turns it off', !off.error, off)
  const t3 = await readType(typeId)
  check('…stored as null, not 0', t3.extra_player_rate === null && t3.extra_player_weekend_rate === null, t3)

  // ══ 3. validation ═════════════════════════════════════════════════════════
  console.log('\n── validation ──')
  const weekendOnly = await upsertResourceType({ ...base, id: typeId, extraPlayerWeekendRate: 75 })
  check('weekend extra rate without base is rejected', /extra player rate/i.test(weekendOnly.error ?? ''), weekendOnly)
  check('…and nothing changed', (await readType(typeId)).extra_player_weekend_rate === null)
  for (const bad of [0, -1, 1.5]) {
    const r = await upsertResourceType({ ...base, id: typeId, includedPlayers: bad, extraPlayerRate: 50 })
    check(`includedPlayers=${bad} is rejected`, !!r.error, r)
  }
  const negBase = await upsertResourceType({ ...base, id: typeId, includedPlayers: 2, extraPlayerRate: -5 })
  check('negative extra rate is rejected', !!negBase.error, negBase)
  const negWk = await upsertResourceType({
    ...base,
    id: typeId,
    includedPlayers: 2,
    extraPlayerRate: 5,
    extraPlayerWeekendRate: -5,
  })
  check('negative weekend extra rate is rejected', !!negWk.error, negWk)
  const zero = await upsertResourceType({ ...base, id: typeId, includedPlayers: 2, extraPlayerRate: 0 })
  check(
    'an explicit 0 extra rate is allowed (free extra players)',
    !zero.error && (await readType(typeId)).extra_player_rate === '0.00',
    zero,
  )

  // ══ 4. per_head is rejected server-side ═══════════════════════════════════
  console.log('\n── per_head gate ──')
  const headBase = await upsertResourceType({ name: 'Pool', hourlyRate: 100, pricingMode: 'per_head', extraPlayerRate: 50 })
  check('per_head + extra rate is rejected', /per-station/i.test(headBase.error ?? ''), headBase)
  const headWk = await upsertResourceType({
    name: 'Pool',
    hourlyRate: 100,
    pricingMode: 'per_head',
    extraPlayerRate: 50,
    extraPlayerWeekendRate: 60,
  })
  check('per_head + weekend extra rate is rejected', !!headWk.error, headWk)
  const { rows: noPool } = await owner.query("select 1 from resource_types where tenant_id=$1 and name='Pool'", [tenantId])
  check('…and no per_head row was created', noPool.length === 0)
  const toHead = await upsertResourceType({ ...base, id: typeId, pricingMode: 'per_head', includedPlayers: 3, extraPlayerRate: null })
  check('switching to per_head with no extra rate is fine', !toHead.error, toHead)
  const t4 = await readType(typeId)
  check('…and clears surcharge state (included players reset to 1)', t4.included_players === 1 && t4.extra_player_rate === null, t4)
  const toHeadWithRate = await upsertResourceType({ ...base, id: typeId, pricingMode: 'per_head', extraPlayerRate: 10 })
  check('switching an existing type to per_head WITH an extra rate is rejected', !!toHeadWithRate.error, toHeadWithRate)

  // ══ 5. industry gate ══════════════════════════════════════════════════════
  console.log('\n── industry gate ──')
  signedInAs(OTHER_MANAGER.token, otherSlug)
  const wrongIndustry = await upsertResourceType({ ...base, includedPlayers: 2, extraPlayerRate: 50 })
  check('non-gaming_cafe tenant cannot set a surcharge', !!wrongIndustry.error, wrongIndustry)
  const plain = await upsertResourceType({ ...base, includedPlayers: 1 })
  check('…but can still save a normal type', !plain.error, plain)

  // ══ 6. snapshot freeze ════════════════════════════════════════════════════
  console.log('\n── editing a type never reprices a taken booking ──')
  signedInAs(MANAGER.token)
  const setOn = await upsertResourceType({
    ...base,
    id: typeId,
    pricingMode: 'per_resource',
    includedPlayers: 2,
    extraPlayerRate: 50,
    extraPlayerWeekendRate: 75,
  })
  check('surcharge on again for the freeze check', !setOn.error, setOn)
  const res = await owner.query<{ id: string }>(
    `insert into resources (tenant_id,branch_id,resource_type_id,name) values ($1,$2,$3,'Table 1') returning id`,
    [tenantId, branchId, typeId],
  )
  const bk = await owner.query<{ id: string }>(
    `insert into bookings (tenant_id,branch_id,booking_number,status,subtotal,total)
     values ($1,$2,$3,'confirmed','350.00','350.00') returning id`,
    [tenantId, branchId, `SUR-${tag}`],
  )
  // 1h, 3 players (2 included + 1 extra): 300 base + 1 x 50 extra = 350, frozen as booked.
  const slot = await owner.query<{ id: string }>(
    `insert into booking_slots (tenant_id,booking_id,resource_id,resource_name,resource_type_name,starts_at,ends_at,rate_applied,slot_total,head_count,extra_player_rate_applied)
     values ($1,$2,$3,'Table 1','Snooker', now() + interval '1 day', now() + interval '1 day 1 hour','300.00','350.00',3,'50.00') returning id`,
    [tenantId, bk.rows[0].id, res.rows[0].id],
  )
  const snap = async () =>
    (
      await owner.query(
        'select rate_applied, slot_total, head_count, extra_player_rate_applied from booking_slots where id=$1',
        [slot.rows[0].id],
      )
    ).rows[0]
  const before = await snap()
  const edit = await upsertResourceType({
    ...base,
    hourlyRate: 999,
    id: typeId,
    includedPlayers: 4,
    extraPlayerRate: 500,
    extraPlayerWeekendRate: 600,
  })
  check('manager edits the type rates + surcharge', !edit.error, edit)
  const t5 = await readType(typeId)
  check('the type config did change', t5.included_players === 4 && t5.extra_player_rate === '500.00', t5)
  const afterEdit = await snap()
  check('booking slot snapshot is unchanged', JSON.stringify(afterEdit) === JSON.stringify(before), { before, afterEdit })
  const off2 = await upsertResourceType({ ...base, id: typeId, extraPlayerRate: null })
  check('turning the surcharge off succeeds', !off2.error, off2)
  check('…and still leaves the slot snapshot untouched', JSON.stringify(await snap()) === JSON.stringify(before))
  const { rows: bkAfter } = await owner.query('select subtotal, total from bookings where id=$1', [bk.rows[0].id])
  check('…and the booking totals untouched', bkAfter[0].subtotal === '350.00' && bkAfter[0].total === '350.00', bkAfter)

  // ── cleanup ───────────────────────────────────────────────────────────────
  await owner.query('delete from tenants where id = any($1)', [[tenantId, other.tenantId]])
  await owner.query('delete from users where id = any($1)', [[MANAGER.id, CASHIER.id, OTHER_MANAGER.id]])
  await owner.end()

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
