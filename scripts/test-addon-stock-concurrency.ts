/**
 * M33 #3 — the add-on stock check under real concurrency (needs migration
 * 0108). Postgres has no constraint backing add-on stock, so this proves the
 * lock-then-sum discipline in lib/booking/addons.ts actually holds:
 *
 *   race       N rounds of two parallel transactions (separate pool
 *              connections) fighting for the LAST unit → exactly one wins,
 *              never both (no oversell)
 *   deadlock   parallel bookings attaching the same two add-ons in OPPOSITE
 *              order → none fails with 40P01 (the fixed id lock order)
 *   cancelled  a cancelled booking's units are excluded from the sum
 *   open tab   a null ends_at (running open-tab walk-in) is unbounded and
 *              blocks a later window; a bounded earlier window does not
 *   headroom   addonHeadroom reports stock minus the overlapping sum
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs --import ./scripts/next-runtime-hook.mjs scripts/test-addon-stock-concurrency.ts
 */
import { Pool } from 'pg'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { sql } from 'drizzle-orm'
import * as schema from '../db/schema'
import { createBookingCore, BookingError } from '../lib/booking/service'
import { addonHeadroom, lockAddonCatalog } from '../lib/booking/addons'
import { loadEnv } from './env'

type Db = NodePgDatabase<typeof schema>

let pass = 0,
  fail = 0
const check = (l: string, c: boolean) => {
  console.log(`${c ? '✓' : '✗ FAIL'}  ${l}`)
  if (c) pass++
  else fail++
}

const TZ = 'Asia/Kolkata'
const HOUR = 3_600_000
const at = (days: number, hour: number) => {
  const d = new Date(Date.now() + days * 24 * HOUR)
  d.setUTCMinutes(0, 0, 0)
  d.setUTCHours(hour)
  return d
}
const errCode = (e: unknown) =>
  (e as { code?: string; cause?: { code?: string } })?.cause?.code ?? (e as { code?: string })?.code

async function main() {
  loadEnv()
  const ownerPool = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })
  const appPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 16 })
  const app = drizzle(appPool, { schema })
  const withUser = <T>(userId: string, fn: (tx: Db) => Promise<T>): Promise<T> =>
    app.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`)
      return fn(tx as unknown as Db)
    })
  const q = <T extends object>(text: string, params: unknown[] = []) => ownerPool.query<T>(text, params)

  const slug = 'testaddonstock'
  await q(`delete from tenants where slug=$1`, [slug])
  const tenantId = (
    await q<{ id: string }>(
      `insert into tenants (slug,name,status,timezone,industry) values ($1,$2,'active',$3,'gaming_cafe') returning id`,
      [slug, `${slug} co`, TZ],
    )
  ).rows[0].id
  const branchId = (
    await q<{ id: string }>(`insert into branches (tenant_id,name,is_primary) values ($1,'Main',true) returning id`, [tenantId])
  ).rows[0].id
  const userId = (
    await q<{ id: string }>(
      `insert into users (email,password_hash) values ($1,'x') on conflict (email) do update set email=excluded.email returning id`,
      [`owner@${slug}.test`],
    )
  ).rows[0].id
  const membershipId = (
    await q<{ id: string }>(`insert into memberships (tenant_id,user_id,role,status) values ($1,$2,'owner','active') returning id`, [tenantId, userId])
  ).rows[0].id
  await q(`insert into business_profiles (tenant_id) values ($1) on conflict (tenant_id) do nothing`, [tenantId])
  const typeId = (
    await q<{ id: string }>(`insert into resource_types (tenant_id,name,hourly_rate) values ($1,'Studio','100.00') returning id`, [tenantId])
  ).rows[0].id
  const resources: string[] = []
  for (let i = 0; i < 24; i++) {
    resources.push(
      (
        await q<{ id: string }>(
          `insert into resources (tenant_id,branch_id,resource_type_id,name,status) values ($1,$2,$3,$4,'available') returning id`,
          [tenantId, branchId, typeId, `Set ${i}`],
        )
      ).rows[0].id,
    )
  }
  const mkAddon = async (name: string, stock: number) =>
    (
      await q<{ id: string }>(
        `insert into resource_type_addons (tenant_id,branch_id,resource_type_id,name,rate,rate_unit,stock_quantity)
         values ($1,$2,$3,$4,'10.00','hour',$5) returning id`,
        [tenantId, branchId, typeId, name, stock],
      )
    ).rows[0].id

  const ctx = { tenantId, timezone: TZ, membershipId }
  const book = (resourceId: string, start: Date, hours: number, addons: { addonId: string; quantity: number }[]) =>
    withUser(userId, (tx) =>
      createBookingCore(tx, ctx, {
        branchId,
        customerName: 'T',
        customerPhone: '9876543210',
        source: 'staff',
        discount: 0,
        deposit: 0,
        slots: [
          {
            resourceId,
            startsAt: start.toISOString(),
            endsAt: new Date(start.getTime() + hours * HOUR).toISOString(),
            addons,
          },
        ],
      }),
    )

  // ── race for the last unit ────────────────────────────────────────────────
  const lastUnit = await mkAddon('Last unit', 1)
  const ROUNDS = 8
  let bothWon = 0
  let neitherWon = 0
  let unexpected = 0
  for (let i = 0; i < ROUNDS; i++) {
    const start = at(2 + i, 4) // a fresh, disjoint window each round
    const results = await Promise.allSettled([
      book(resources[0], start, 2, [{ addonId: lastUnit, quantity: 1 }]),
      book(resources[1], start, 2, [{ addonId: lastUnit, quantity: 1 }]),
    ])
    const won = results.filter((r) => r.status === 'fulfilled').length
    const refused = results.filter((r) => r.status === 'rejected' && (r.reason as unknown) instanceof BookingError).length
    if (won === 2) bothWon++
    else if (won === 0) neitherWon++
    if (won + refused !== 2) unexpected++
  }
  check(`R1 ${ROUNDS} races for the last unit: never both won (no oversell)`, bothWon === 0)
  check(`R2 …and in every round exactly one won (loser got a clean "out of stock")`, neitherWon === 0 && unexpected === 0)
  const oversold = await q<{ n: string }>(
    `select count(*) n from (
       select a.starts_at from booking_addons a where a.addon_id=$1 group by a.starts_at having sum(a.quantity) > 1
     ) x`,
    [lastUnit],
  )
  check('R3 database confirms no window holds more than 1 unit', Number(oversold.rows[0].n) === 0)

  // ── multi-add-on deadlock ─────────────────────────────────────────────────
  const camera = await mkAddon('Camera', 50)
  const lens = await mkAddon('Lens', 50)
  const PAIRS = 8
  const dl = await Promise.allSettled(
    Array.from({ length: PAIRS * 2 }, (_, i) =>
      book(
        resources[2 + (i % 20)],
        at(20 + Math.floor(i / 2), 4),
        1,
        // Even i: camera→lens, odd i: lens→camera — the classic ABBA order.
        i % 2 === 0
          ? [{ addonId: camera, quantity: 1 }, { addonId: lens, quantity: 1 }]
          : [{ addonId: lens, quantity: 1 }, { addonId: camera, quantity: 1 }],
      ),
    ),
  )
  const deadlocked = dl.filter((r) => r.status === 'rejected' && errCode(r.reason) === '40P01').length
  const failed = dl.filter((r) => r.status === 'rejected').length
  check(`D1 ${PAIRS * 2} opposite-order multi-add-on attaches: zero deadlocks (40P01)`, deadlocked === 0)
  check('D2 …and all of them succeeded', failed === 0)

  // The lock order is by id regardless of what the caller listed.
  const order = await withUser(userId, async (tx) => {
    const rows = await lockAddonCatalog(tx, tenantId, [lens, camera])
    return [...rows.keys()]
  })
  check('D3 lockAddonCatalog returns rows in id order whatever order was requested', order.join() === [camera, lens].sort().join())

  // ── cancelled exclusion + headroom ────────────────────────────────────────
  const gear = await mkAddon('Gear', 2)
  const start = at(60, 4)
  const b1 = await book(resources[0], start, 2, [{ addonId: gear, quantity: 2 }])
  const headroom = () =>
    withUser(userId, async (tx) => {
      const row = (await lockAddonCatalog(tx, tenantId, [gear])).get(gear)!
      return addonHeadroom(tx, tenantId, row, start, new Date(start.getTime() + 2 * HOUR))
    })
  check('C1 headroom with 2 of 2 held = 0', (await headroom()) === 0)
  await withUser(userId, (tx) => tx.execute(sql`update bookings set status='cancelled' where id=${b1.id}`))
  check('C2 cancelled booking no longer counts: headroom = 2', (await headroom()) === 2)
  const b2 = await book(resources[1], start, 2, [{ addonId: gear, quantity: 2 }])
  check('C3 the freed units can be booked again', Boolean(b2.id))
  check('C4 a half-overlapping window sees the same hold (headroom 0)', await withUser(userId, async (tx) => {
    const row = (await lockAddonCatalog(tx, tenantId, [gear])).get(gear)!
    return (await addonHeadroom(tx, tenantId, row, new Date(start.getTime() + HOUR), new Date(start.getTime() + 3 * HOUR))) === 0
  }))
  check('C5 an adjacent window [end, end+1h) is unaffected (headroom 2)', await withUser(userId, async (tx) => {
    const row = (await lockAddonCatalog(tx, tenantId, [gear])).get(gear)!
    return (await addonHeadroom(tx, tenantId, row, new Date(start.getTime() + 2 * HOUR), new Date(start.getTime() + 3 * HOUR))) === 2
  }))

  // ── open-ended (null ends_at) windows ─────────────────────────────────────
  const tab = await mkAddon('Tab gear', 1)
  const bTab = await book(resources[3], at(80, 4), 1, [{ addonId: tab, quantity: 1 }])
  // Turn that line into a running open tab: unbounded end.
  await q(`update booking_addons set ends_at=null where booking_id=$1`, [bTab.id])
  const probe = (s: Date, e: Date | null) =>
    withUser(userId, async (tx) => {
      const row = (await lockAddonCatalog(tx, tenantId, [tab])).get(tab)!
      return addonHeadroom(tx, tenantId, row, s, e)
    })
  check('O1 a later window is blocked by an open tab (null = unbounded)', (await probe(at(200, 4), new Date(at(200, 4).getTime() + HOUR))) === 0)
  check('O2 an open-ended request is blocked too', (await probe(at(300, 4), null)) === 0)
  check('O3 a window that ENDS before the open tab started is unaffected', (await probe(at(70, 4), new Date(at(70, 4).getTime() + HOUR))) === 1)

  // ── cleanup ───────────────────────────────────────────────────────────────
  await q(`delete from tenants where id=$1`, [tenantId])
  await q(`delete from users where email=$1`, [`owner@${slug}.test`])
  await ownerPool.end()
  await appPool.end()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
