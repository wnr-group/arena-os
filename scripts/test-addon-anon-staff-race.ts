/**
 * M35 #6 — the last unit of an add-on contested by ONE anonymous online booking
 * and ONE staff booking at the same moment (different sets, same window). The
 * anon side runs as the public role, the staff side as a logged-in member; both
 * go through the same catalog lock, so exactly one must win, the loser must get
 * a clean refusal, and no half-created booking may remain. Repeated over several
 * rounds because a race only shows up some of the time.
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs --import ./scripts/next-runtime-hook.mjs scripts/test-addon-anon-staff-race.ts
 */
import { randomBytes, randomInt } from 'node:crypto'
import { Pool } from 'pg'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { sql } from 'drizzle-orm'
import * as schema from '../db/schema'
import { loadEnv } from './env'

loadEnv()
type Db = NodePgDatabase<typeof schema>

let pass = 0
let fail = 0
const check = (label: string, cond: boolean, got?: unknown) => {
  console.log(`${cond ? '✓' : '✗ FAIL'}  ${label}${cond ? '' : `  (got: ${JSON.stringify(got)})`}`)
  if (cond) pass++
  else fail++
}

async function main() {
  const { createPublicBooking } = await import('../lib/actions/public-booking')
  const { createBookingCore } = await import('../lib/booking/service')
  const owner = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })
  const appPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 })
  const app = drizzle(appPool, { schema })
  const q = <T extends object>(text: string, params: unknown[] = []) => owner.query<T>(text, params)
  const tag = randomBytes(3).toString('hex')
  const slug = `anon-staff-race-${tag}`
  const base = randomInt(0, 1_000_000)
  let seq = 0
  const nextPhone = () => `9${String(base * 100 + ++seq).padStart(9, '0')}`

  const tenantId = (await q<{ id: string }>(`insert into tenants (slug,name,status,timezone,industry) values ($1,'Race QA','active','Asia/Kolkata','recording_studio') returning id`, [slug])).rows[0].id
  const branchId = (await q<{ id: string }>(`insert into branches (tenant_id,name,is_primary,status) values ($1,'Main',true,'active') returning id`, [tenantId])).rows[0].id
  const typeId = (await q<{ id: string }>(`insert into resource_types (tenant_id,name,hourly_rate) values ($1,'Studio','500.00') returning id`, [tenantId])).rows[0].id
  const userId = (await q<{ id: string }>(`insert into users (email,password_hash) values ($1,'x') on conflict (email) do update set email=excluded.email returning id`, [`owner@${slug}.test`])).rows[0].id
  const membershipId = (await q<{ id: string }>(`insert into memberships (tenant_id,user_id,role,status) values ($1,$2,'receptionist','active') returning id`, [tenantId, userId])).rows[0].id
  await q(`insert into business_profiles (tenant_id) values ($1) on conflict (tenant_id) do nothing`, [tenantId])
  const mkSet = async (n: string) =>
    (await q<{ id: string }>(`insert into resources (tenant_id,branch_id,resource_type_id,name,status) values ($1,$2,$3,$4,'available') returning id`, [tenantId, branchId, typeId, n])).rows[0].id
  const setA = await mkSet('Set A')
  const setB = await mkSet('Set B')
  for (let dow = 0; dow <= 6; dow++) {
    await q(`insert into working_hours (tenant_id,branch_id,day_of_week,open_time,close_time,is_closed) values ($1,$2,$3,'09:00','22:00',false)`, [tenantId, branchId, dow])
  }
  const g = globalThis as { __ARENA_TEST_HEADERS?: Record<string, string> }
  const ctx = { tenantId, timezone: 'Asia/Kolkata', membershipId }

  const ROUNDS = 5
  let anonWins = 0
  let staffWins = 0
  for (let round = 0; round < ROUNDS; round++) {
    g.__ARENA_TEST_HEADERS = { 'x-tenant-slug': slug, 'x-forwarded-for': `10.8.${round}.1` }
    const addonId = (
      await q<{ id: string }>(
        `insert into resource_type_addons (tenant_id,branch_id,resource_type_id,name,rate,rate_unit,stock_quantity) values ($1,$2,$3,$4,'100.00','hour',1) returning id`,
        [tenantId, branchId, typeId, `Last ${round}`],
      )
    ).rows[0].id
    const start = new Date()
    start.setUTCDate(start.getUTCDate() + 3 + round)
    start.setUTCHours(4, 0, 0, 0)
    const end = new Date(start.getTime() + 2 * 3_600_000)
    const bookingsBefore = Number((await q<{ n: string }>(`select count(*) n from bookings where tenant_id=$1`, [tenantId])).rows[0].n)

    const anon = createPublicBooking({
      resourceId: setA,
      startsAt: start.toISOString(),
      endsAt: end.toISOString(),
      customerName: 'Anon',
      customerPhone: nextPhone(),
      addons: [{ addonId, quantity: 1 }],
      website: '',
    })
    const staff = app
      .transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`)
        return createBookingCore(tx as unknown as Db, ctx, {
          branchId,
          customerName: 'Staff',
          customerPhone: nextPhone(),
          source: 'staff',
          discount: 0,
          deposit: 0,
          slots: [{ resourceId: setB, startsAt: start.toISOString(), endsAt: end.toISOString(), addons: [{ addonId, quantity: 1 }] }],
        })
      })
      .then(
        (r) => ({ ok: true as const, id: r.id }),
        (e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }),
      )
    const [a, s] = await Promise.all([anon, staff])
    const anonOk = Boolean(a.bookingId) && !a.error
    const wins = Number(anonOk) + Number(s.ok)
    if (anonOk) anonWins++
    if (s.ok) staffWins++
    const held = Number((await q<{ s: string }>(`select coalesce(sum(quantity),0) s from booking_addons where addon_id=$1`, [addonId])).rows[0].s)
    const bookingsAfter = Number((await q<{ n: string }>(`select count(*) n from bookings where tenant_id=$1`, [tenantId])).rows[0].n)
    const loserMsg = anonOk ? (s.ok ? '' : s.error) : (a.error ?? '')
    check(
      `round ${round + 1}: exactly one winner, 1 unit held, 1 new booking, loser refused cleanly`,
      wins === 1 && held === 1 && bookingsAfter === bookingsBefore + 1 && /out of stock|left|no longer|just taken/i.test(loserMsg),
      { anon: a, staff: s, held, delta: bookingsAfter - bookingsBefore },
    )
  }
  console.log(`   (anon won ${anonWins}, staff won ${staffWins} of ${ROUNDS})`)

  await q('delete from tenants where id = $1', [tenantId])
  await owner.end()
  await appPool.end()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
