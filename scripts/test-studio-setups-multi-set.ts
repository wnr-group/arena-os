/**
 * M24 #6 — QA/regression: multi-set independence.
 *
 * Studio Setups' mutual exclusion (M24 #2, pinned by
 * test-studio-setups-pricing.ts's T8/T9) works because a setup booking still
 * reserves its own physical resource_id — the existing GiST exclusion on
 * booking_slots (0003) is keyed on resource_id, not on setup_id, so it can
 * only ever block a SECOND booking on the SAME set. This script pins the
 * other half of that same fact: two DIFFERENT physical sets, each with their
 * own setup, must be independently bookable for the exact same (or
 * overlapping) time window — the exclusion constraint must never leak
 * across resources.
 *
 *   - Set A's "Kitchen" (hourly) and Set B's "Loft" (per-day) both book
 *     successfully over the same overlapping wall-clock window
 *   - each prices correctly and independently (no cross-resource pricing
 *     bleed)
 *   - as a control, a SECOND booking on Set A overlapping the first IS still
 *     rejected — proves the independence above isn't just a broken
 *     exclusion check
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs scripts/test-studio-setups-multi-set.ts
 */
import { Pool } from 'pg'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { sql } from 'drizzle-orm'
import * as schema from '../db/schema'
import { createBookingCore } from '../lib/booking/service'
import { loadEnv } from './env'

type Db = NodePgDatabase<typeof schema>

let pass = 0,
  fail = 0
const check = (l: string, c: boolean, got?: unknown) => {
  console.log(`${c ? '✓' : '✗ FAIL'}  ${l}${c ? '' : `  (got: ${JSON.stringify(got)})`}`)
  if (c) pass++
  else fail++
}
async function expectExclusionViolation(l: string, fn: () => Promise<unknown>) {
  try {
    await fn()
    check(l, false)
  } catch (e) {
    const code = (e as { code?: string; cause?: { code?: string } })?.cause?.code ?? (e as { code?: string })?.code
    check(l, code === '23P01')
    if (code !== '23P01') console.log('   (unexpected)', e)
  }
}

const TZ = 'Asia/Kolkata'
const ist = (y: number, m: number, d: number, hh: number, mm = 0) =>
  new Date(Date.UTC(y, m - 1, d, hh, mm) - (5 * 60 + 30) * 60_000)

async function main() {
  loadEnv()
  const ownerPool = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })
  const appPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 })
  const app = drizzle(appPool, { schema })

  async function withUser<T>(userId: string, fn: (tx: Db) => Promise<T>): Promise<T> {
    return app.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`)
      return fn(tx as unknown as Db)
    })
  }

  const slug = 'teststudiomultiset'
  const t = await ownerPool.query<{ id: string }>(
    `insert into tenants (slug,name,status,timezone,industry) values ($1,$2,'active',$3,'recording_studio')
     on conflict (slug) do update set name=excluded.name returning id`,
    [slug, `${slug} co`, TZ],
  )
  const tenantId = t.rows[0].id
  const b = await ownerPool.query<{ id: string }>(
    `insert into branches (tenant_id,name,is_primary) values ($1,'Main',true)
     on conflict (tenant_id,name) do update set is_primary=true returning id`,
    [tenantId],
  )
  const branchId = b.rows[0].id
  const u = await ownerPool.query<{ id: string }>(
    `insert into users (email,password_hash) values ($1,'x')
     on conflict (email) do update set email=excluded.email returning id`,
    [`owner@${slug}.test`],
  )
  const userId = u.rows[0].id
  const m = await ownerPool.query<{ id: string }>(
    `insert into memberships (tenant_id,user_id,role,status) values ($1,$2,'owner','active')
     on conflict (tenant_id,user_id) do update set role='owner', status='active' returning id`,
    [tenantId, userId],
  )
  const membershipId = m.rows[0].id

  const setType = await ownerPool.query<{ id: string }>(
    `insert into resource_types (tenant_id,name,hourly_rate) values ($1,'Studio Set','500.00')
     on conflict (tenant_id,name) do update set hourly_rate=excluded.hourly_rate returning id`,
    [tenantId],
  )
  const setA = await ownerPool.query<{ id: string }>(
    `insert into resources (tenant_id,branch_id,resource_type_id,name,status) values ($1,$2,$3,'Set A','available')
     on conflict (tenant_id,name) do update set status='available' returning id`,
    [tenantId, branchId, setType.rows[0].id],
  )
  const setB = await ownerPool.query<{ id: string }>(
    `insert into resources (tenant_id,branch_id,resource_type_id,name,status) values ($1,$2,$3,'Set B','available')
     on conflict (tenant_id,name) do update set status='available' returning id`,
    [tenantId, branchId, setType.rows[0].id],
  )
  const setAId = setA.rows[0].id
  const setBId = setB.rows[0].id

  const kitchen = await ownerPool.query<{ id: string }>(
    `insert into resource_setups (tenant_id,resource_id,name,rate,rate_unit) values ($1,$2,'Kitchen','800.00','hour')
     on conflict (resource_id,name) do update set rate=excluded.rate returning id`,
    [tenantId, setAId],
  )
  const loft = await ownerPool.query<{ id: string }>(
    `insert into resource_setups (tenant_id,resource_id,name,rate,rate_unit) values ($1,$2,'Loft','5000.00','day')
     on conflict (resource_id,name) do update set rate=excluded.rate returning id`,
    [tenantId, setBId],
  )
  const kitchenId = kitchen.rows[0].id
  const loftId = loft.rows[0].id

  const ctx = { tenantId, timezone: TZ, membershipId }
  const base = {
    branchId,
    customerName: 'Test',
    customerPhone: '9999900001',
    source: 'staff' as const,
    discount: 0,
    deposit: 0,
  }

  // Set A: Kitchen, 2h on Aug 15 morning.
  const setAStart = ist(2026, 8, 15, 10)
  const setAEnd = ist(2026, 8, 15, 12)
  // Set B: Loft, a 3-day range D1 10:00 (this branch has no working_hours
  // row, so priceBookingSlots' day-range-alignment check falls back to
  // DEFAULT_HOURS, 10:00-22:00, same as getDayRangeWindow would) -> D3 22:00
  // — deliberately OVERLAPS Set A's window in wall-clock time (same days),
  // to prove the exclusion constraint is scoped per-resource, not
  // per-tenant/per-window.
  const setBStart = ist(2026, 8, 15, 10)
  const setBEnd = ist(2026, 8, 17, 22)

  const bookingA = await withUser(userId, (tx) =>
    createBookingCore(tx, ctx, {
      ...base,
      customerPhone: '9999900001',
      slots: [{ resourceId: setAId, startsAt: setAStart.toISOString(), endsAt: setAEnd.toISOString(), setupId: kitchenId }],
    }),
  )
  check('Set A (Kitchen, hourly) books successfully', Boolean(bookingA.id))

  const bookingB = await withUser(userId, (tx) =>
    createBookingCore(tx, ctx, {
      ...base,
      customerPhone: '9999900002',
      slots: [{ resourceId: setBId, startsAt: setBStart.toISOString(), endsAt: setBEnd.toISOString(), setupId: loftId }],
    }),
  )
  check(
    'Set B (Loft, 3-day) books successfully over the SAME wall-clock window — no cross-resource conflict',
    Boolean(bookingB.id),
  )

  const [slotA] = (
    await ownerPool.query<{ rate_applied: string; slot_total: string; setup_name: string }>(
      `select rate_applied, slot_total, setup_name from booking_slots where booking_id=$1`,
      [bookingA.id],
    )
  ).rows
  check('Set A prices independently: rate_applied=800.00, slot_total=1600.00 (2h)', slotA?.rate_applied === '800.00' && slotA?.slot_total === '1600.00', slotA)
  check('Set A setup_name = Kitchen', slotA?.setup_name === 'Kitchen', slotA)

  const [slotB] = (
    await ownerPool.query<{ rate_applied: string; slot_total: string; setup_name: string }>(
      `select rate_applied, slot_total, setup_name from booking_slots where booking_id=$1`,
      [bookingB.id],
    )
  ).rows
  check('Set B prices independently: rate_applied=5000.00, slot_total=15000.00 (3 days)', slotB?.rate_applied === '5000.00' && slotB?.slot_total === '15000.00', slotB)
  check('Set B setup_name = Loft', slotB?.setup_name === 'Loft', slotB)

  // Control: a SECOND booking on Set A overlapping the first IS still
  // rejected — proves the independence above is real, not a broken/no-op
  // exclusion constraint.
  await expectExclusionViolation('control: a second overlapping booking on Set A itself is still rejected', () =>
    withUser(userId, (tx) =>
      createBookingCore(tx, ctx, {
        ...base,
        customerPhone: '9999900003',
        slots: [{ resourceId: setAId, startsAt: ist(2026, 8, 15, 11).toISOString(), endsAt: ist(2026, 8, 15, 13).toISOString() }],
      }),
    ),
  )

  await ownerPool.query('delete from tenants where id = $1', [tenantId])
  await ownerPool.query(`delete from users where email = $1`, [`owner@${slug}.test`])
  await ownerPool.end()
  await appPool.end()

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
