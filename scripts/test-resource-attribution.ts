/**
 * getActiveBookingForResource / createOrderCore's resourceId attribution path
 * against a real database — covers the gap found in review of PR #17 (M17
 * table sessions): a resource/QR-attributed order didn't fold into an open
 * table session because the M17 session has no booking_slots row (see
 * migration 0071) and the resolver only ever looked there.
 *
 *   - restaurant: an order placed with resourceId (no bookingId) against a
 *     seated table attaches to that table's open session
 *   - restaurant: the same table, once its session is completed, produces a
 *     standalone order instead (no stale attribution)
 *   - restaurant: a table with no session at all produces a standalone order
 *   - gaming (unaffected path): a resource with an active timed booking_slots
 *     row still attaches via the existing slot lookup, unchanged
 *   - gaming: a resource with no active slot produces a standalone order
 *   - tenant isolation: tenant B's resourceId never resolves to tenant A's
 *     session
 *
 *   npx tsx scripts/test-resource-attribution.ts
 */
import { Pool } from 'pg'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { sql, eq } from 'drizzle-orm'
import * as schema from '../db/schema'
import { seatTableSessionCore, createBookingCore } from '../lib/booking/service'
import { getActiveBookingForResource } from '../lib/booking/attribution'
import { createOrderCore } from '../lib/orders/service'
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

  type Tenant = { tenantId: string; branchId: string; userId: string; membershipId: string; itemId: string; resources: string[] }

  async function makeTenant(
    slug: string,
    industry: 'restaurant' | 'gaming_cafe',
    resourceCount = 3,
  ): Promise<Tenant> {
    // A "table" (seatTableSessionCore) is any resource whose type carries no
    // hourly rate (0071 / lib/booking/data.ts:listTables); a timed resource
    // needs a real rate for priceBookingSlots to charge against.
    const hourlyRate = industry === 'restaurant' ? '0' : '100'
    const t = await ownerPool.query<{ id: string }>(
      `insert into tenants (slug,name,status,timezone,industry) values ($1,$2,'active',$3,$4)
       on conflict (slug) do update set name=excluded.name returning id`,
      [slug, `${slug} co`, TZ, industry],
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
    const m = await ownerPool.query<{ id: string }>(
      `insert into memberships (tenant_id,user_id,role,status) values ($1,$2,'owner','active')
       on conflict (tenant_id,user_id) do update set role='owner', status='active' returning id`,
      [tenantId, u.rows[0].id],
    )
    const cat = await ownerPool.query<{ id: string }>(
      `insert into menu_categories (tenant_id,name) values ($1,'Snacks')
       on conflict (tenant_id,name) do update set name=excluded.name returning id`,
      [tenantId],
    )
    const item = await ownerPool.query<{ id: string }>(
      `insert into menu_items (tenant_id,category_id,name,price) values ($1,$2,'Fries','80.00') returning id`,
      [tenantId, cat.rows[0].id],
    )
    const rt = await ownerPool.query<{ id: string }>(
      `insert into resource_types (tenant_id,name,hourly_rate) values ($1,'Station',$2)
       on conflict (tenant_id,name) do update set hourly_rate=excluded.hourly_rate returning id`,
      [tenantId, hourlyRate],
    )
    const resourceIds: string[] = []
    for (let i = 0; i < resourceCount; i++) {
      const r = await ownerPool.query<{ id: string }>(
        `insert into resources (tenant_id,branch_id,resource_type_id,name) values ($1,$2,$3,$4) returning id`,
        [tenantId, branchId, rt.rows[0].id, `R${i + 1}`],
      )
      resourceIds.push(r.rows[0].id)
    }
    return { tenantId, branchId, userId: u.rows[0].id, membershipId: m.rows[0].id, itemId: item.rows[0].id, resources: resourceIds }
  }

  async function orderByResource(t: Tenant, resourceId: string) {
    return withUser(t.userId, (tx) =>
      createOrderCore(
        tx,
        { tenantId: t.tenantId, timezone: TZ, membershipId: t.membershipId },
        { branchId: t.branchId, resourceId, items: [{ menuItemId: t.itemId, qty: 1 }] },
      ),
    )
  }

  async function orderBookingId(id: string) {
    const { rows } = await ownerPool.query(`select booking_id from orders where id=$1`, [id])
    return rows[0].booking_id as string | null
  }

  const R = await makeTenant('testresattr-r', 'restaurant')
  const G = await makeTenant('testresattr-g', 'gaming_cafe')

  // ── 1. restaurant: order by resourceId folds into the open table session ───
  {
    const session = await withUser(R.userId, (tx) =>
      seatTableSessionCore(tx, { tenantId: R.tenantId, timezone: TZ, membershipId: R.membershipId }, { branchId: R.branchId, resourceId: R.resources[0], coverCount: 2 }),
    )

    const resolved = await withUser(R.userId, (tx) => getActiveBookingForResource(tx, R.tenantId, R.resources[0]))
    check('getActiveBookingForResource resolves the seated table to its session booking', resolved === session.id)

    const order = await orderByResource(R, R.resources[0])
    check('a resourceId-attributed order attaches to the open table session', (await orderBookingId(order.id)) === session.id)

    await withUser(R.userId, (tx) => tx.update(schema.bookings).set({ status: 'completed' }).where(eq(schema.bookings.id, session.id)))
  }

  // ── 2. restaurant: once the session is closed, the table resolves to nothing ─
  {
    const resolved = await withUser(R.userId, (tx) => getActiveBookingForResource(tx, R.tenantId, R.resources[0]))
    check('a completed session no longer resolves (table is free again)', resolved === null)

    const order = await orderByResource(R, R.resources[0])
    check('an order against a free table stays standalone', (await orderBookingId(order.id)) === null)
  }

  // ── 3. restaurant: a table that was never seated stays standalone ──────────
  {
    const order = await orderByResource(R, R.resources[1])
    check('an order against a never-seated table stays standalone', (await orderBookingId(order.id)) === null)
  }

  // ── 4. gaming: unaffected — a timed slot still resolves via booking_slots ──
  {
    const now = new Date()
    const starts = new Date(now.getTime() - 15 * 60_000)
    const ends = new Date(now.getTime() + 45 * 60_000)
    const booking = await withUser(G.userId, (tx) =>
      createBookingCore(
        tx,
        { tenantId: G.tenantId, timezone: TZ, membershipId: G.membershipId },
        { branchId: G.branchId, source: 'staff', discount: 0, deposit: 0, slots: [{ resourceId: G.resources[0], startsAt: starts.toISOString(), endsAt: ends.toISOString() }] },
      ),
    )

    const resolved = await withUser(G.userId, (tx) => getActiveBookingForResource(tx, G.tenantId, G.resources[0]))
    check('a timed-slot resource still resolves via booking_slots, unchanged', resolved === booking.id)

    const order = await orderByResource(G, G.resources[0])
    check('a resourceId-attributed order attaches to the active timed booking', (await orderBookingId(order.id)) === booking.id)

    await withUser(G.userId, (tx) => tx.update(schema.bookings).set({ status: 'completed' }).where(eq(schema.bookings.id, booking.id)))
  }

  // ── 5. gaming: a station with no active slot stays standalone ──────────────
  {
    const order = await orderByResource(G, G.resources[1])
    check('a station with no active slot stays standalone', (await orderBookingId(order.id)) === null)
  }

  // ── 6. tenant isolation: RLS hides the other tenant's session entirely ─────
  {
    const session = await withUser(R.userId, (tx) =>
      seatTableSessionCore(tx, { tenantId: R.tenantId, timezone: TZ, membershipId: R.membershipId }, { branchId: R.branchId, resourceId: R.resources[2], coverCount: 2 }),
    )
    // Same resourceId value queried from tenant G's scope resolves to nothing —
    // RLS scopes the lookup by tenant regardless of the id passed in.
    const crossResolved = await withUser(G.userId, (tx) => getActiveBookingForResource(tx, G.tenantId, R.resources[2]))
    check("tenant G's scope never resolves tenant R's table", crossResolved === null)

    await withUser(R.userId, (tx) => tx.update(schema.bookings).set({ status: 'completed' }).where(eq(schema.bookings.id, session.id)))
  }

  // ── cleanup ───────────────────────────────────────────────────────────────
  await ownerPool.query('delete from tenants where id = any($1)', [[R.tenantId, G.tenantId]])
  await ownerPool.query(`delete from users where email like '%@testresattr-%.test'`)
  await ownerPool.end()
  await appPool.end()

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
