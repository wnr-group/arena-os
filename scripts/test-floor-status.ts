/**
 * Regression test: the floor map must not read a table as 'served' because
 * of an online order staff hasn't reviewed yet.
 *
 * lib/kots/data.ts's listKotStatusesForBookings (commit 2b6df40) scoped
 * hasActiveKot to acceptanceStatus='accepted', so an unreviewed QR order's
 * KOT (real, written by createOrderCore, but deliberately hidden from the
 * kitchen until accepted) no longer counts as active. But openOrderCount —
 * the other input to deriveTableStatus (lib/booking/table-status.ts) — had
 * no matching filter: app/(app)/floor/page.tsx counted every row with
 * status='open' regardless of acceptanceStatus. With autoAcceptOnlineOrders
 * defaulting to false, that gap meant a guest's QR order (acceptanceStatus
 * ='pending') counted toward openOrderCount but not hasActiveKot, and
 * deriveTableStatus read that combination as 'served' — food delivered —
 * before anyone on staff had even seen the order.
 *
 * The fix: lib/orders/data.ts's openOrderIdsByBooking applies the same
 * status='open' + acceptanceStatus='accepted' filter listKotStatusesForBookings
 * already used, so the two inputs can't disagree again. This test drives the
 * real data-layer functions (not a reimplementation of their filters) and
 * feeds their output straight into deriveTableStatus, the same way
 * app/(app)/floor/page.tsx does.
 *
 *   npx tsx scripts/test-floor-status.ts
 */
import { Pool } from 'pg'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { sql, eq } from 'drizzle-orm'
import * as schema from '../db/schema'
import { seatTableSessionCore } from '../lib/booking/service'
import { createOrderCore, acceptOrderCore } from '../lib/orders/service'
import { deriveTableStatus, type TableStatus } from '../lib/booking/table-status'
import type { ActiveContext } from '../lib/tenant/context'
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
const ACTIVE_KOT_STATUSES = new Set(['pending', 'preparing', 'ready'])

async function main() {
  loadEnv()

  // Dynamic, and after loadEnv(): lib/orders/data.ts and lib/kots/data.ts
  // import withUser from db/index.ts, which opens its pools from
  // process.env.DATABASE_URL at MODULE EVALUATION time (top-level
  // `drizzle(appPool(), ...)`). A static import would be hoisted above
  // loadEnv() and connect before DATABASE_URL exists.
  const { listOrdersForBookings, openOrderIdsByBooking } = await import('../lib/orders/data')
  const { listKotStatusesForBookings } = await import('../lib/kots/data')

  const ownerPool = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })
  const appPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 })
  const app = drizzle(appPool, { schema })

  async function withUser<T>(userId: string, fn: (tx: Db) => Promise<T>): Promise<T> {
    return app.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`)
      return fn(tx as unknown as Db)
    })
  }

  type Tenant = { tenantId: string; branchId: string; userId: string; membershipId: string; itemId: string; tableId: string }

  async function makeTenant(slug: string): Promise<Tenant> {
    const t = await ownerPool.query<{ id: string }>(
      `insert into tenants (slug,name,status,timezone,industry) values ($1,$2,'active',$3,'restaurant')
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
      [`waiter@${slug}.test`],
    )
    const m = await ownerPool.query<{ id: string }>(
      `insert into memberships (tenant_id,user_id,role,status) values ($1,$2,'floor_staff','active')
       on conflict (tenant_id,user_id) do update set role='floor_staff', status='active' returning id`,
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
      `insert into resource_types (tenant_id,name,hourly_rate) values ($1,'Table','0')
       on conflict (tenant_id,name) do update set name=excluded.name returning id`,
      [tenantId],
    )
    const table = await ownerPool.query<{ id: string }>(
      `insert into resources (tenant_id,branch_id,resource_type_id,name) values ($1,$2,$3,'T1') returning id`,
      [tenantId, branchId, rt.rows[0].id],
    )
    return {
      tenantId,
      branchId,
      userId: u.rows[0].id,
      membershipId: m.rows[0].id,
      itemId: item.rows[0].id,
      tableId: table.rows[0].id,
    }
  }

  // Reproduces exactly what app/(app)/floor/page.tsx does with the real
  // data-layer functions' output — not a second copy of their filters.
  async function floorStatusFor(t: Tenant, bookingId: string): Promise<TableStatus> {
    const ctx = { user: { id: t.userId }, tenant: { id: t.tenantId } } as unknown as ActiveContext
    const [orderRows, kotRows] = await Promise.all([
      listOrdersForBookings(ctx, [bookingId]),
      listKotStatusesForBookings(ctx, [bookingId]),
    ])
    const openIds = openOrderIdsByBooking(orderRows)
    const hasActiveKot = kotRows.some((r) => r.bookingId === bookingId && ACTIVE_KOT_STATUSES.has(r.status))
    return deriveTableStatus({
      hasBooking: true,
      hasLiveInvoice: false,
      billRequestedAt: null,
      openOrderCount: openIds[bookingId]?.size ?? 0,
      hasActiveKot,
    })
  }

  const A = await makeTenant('testfloorstatus-a')

  // ── 1. a pending (unreviewed) QR order must not read the table as 'served' ─
  {
    const session = await withUser(A.userId, (tx) =>
      seatTableSessionCore(tx, { tenantId: A.tenantId, timezone: TZ, membershipId: A.membershipId }, { branchId: A.branchId, resourceId: A.tableId, coverCount: 2 }),
    )

    // No orders yet: seated.
    check('freshly seated table with no orders reads seated', (await floorStatusFor(A, session.id)) === 'seated')

    // Guest scans the QR and orders — channel='online', acceptanceStatus
    // ='pending' is the default when autoAcceptOnlineOrders is off, exactly
    // like lib/actions/public-orders.ts.
    const order = await withUser(A.userId, (tx) =>
      createOrderCore(
        tx,
        { tenantId: A.tenantId, timezone: TZ, membershipId: null },
        { branchId: A.branchId, resourceId: A.tableId, channel: 'online', acceptanceStatus: 'pending', items: [{ menuItemId: A.itemId, qty: 1 }] },
      ),
    )
    const { rows: orderRow } = await ownerPool.query<{ booking_id: string | null }>(`select booking_id from orders where id = $1`, [order.id])
    check('the order attached to the open table session', orderRow[0]?.booking_id === session.id)

    const status = await floorStatusFor(A, session.id)
    check("an unreviewed QR order does NOT flip the table to 'served'", status !== 'served')
    check('the table stays seated until staff accepts the order', status === 'seated')

    // Once staff accepts it, its KOT becomes visible and the table should
    // read 'ordered' — the same "food ordered, not yet served" signal a
    // staff-placed order gives immediately.
    await withUser(A.userId, (tx) => acceptOrderCore(tx, { tenantId: A.tenantId }, order.id))
    const afterAccept = await floorStatusFor(A, session.id)
    check("accepting the order flips the table to 'ordered'", afterAccept === 'ordered')

    await withUser(A.userId, (tx) => tx.update(schema.bookings).set({ status: 'completed' }).where(eq(schema.bookings.id, session.id)))
  }

  // ── cleanup ───────────────────────────────────────────────────────────────
  await ownerPool.query('delete from tenants where id = $1', [A.tenantId])
  await ownerPool.query(`delete from users where email like '%@testfloorstatus-%.test'`)
  await ownerPool.end()
  await appPool.end()

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
