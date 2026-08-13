/**
 * Order → kitchen ticket integration tests against a real database.
 *
 * Drives the same code the server action drives (createOrderCore /
 * cancelOrderCore), on an RLS-scoped transaction through `arena_app`, so what
 * is proven here is what the waiter's "Place order" button actually does:
 *   - placing an order creates exactly one 'pending' KOT, in the SAME
 *     transaction, with the right order_id, tenant_id and branch_id
 *   - KOT numbers are sequential per tenant per day (KOT-YYYYMMDD-NNN)
 *   - a failed order (unknown menu item) leaves no order AND no KOT — the two
 *     save together or not at all
 *   - cancelling an order cancels its KOT, unless the KOT was already served
 *   - cancelling twice, or cancelling a billed order, is refused
 *   - another tenant's menu item is invisible (RLS)
 *   - cancelling a BOOKING (the only cancellation path reachable from the
 *     UI today) cascades: its open orders and their KOTs are cancelled too,
 *     billed orders are left alone, and a booking with no orders is a no-op
 *
 *   npx tsx scripts/test-kot-creation.ts
 */
import { Pool } from 'pg'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { sql } from 'drizzle-orm'
import * as schema from '../db/schema'
import { OrderError, createOrderCore, cancelOrderCore, cancelOpenOrdersForBooking } from '../lib/orders/service'
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

  /** Same contract as db/index.ts:withUser — an RLS-scoped transaction. */
  async function withUser<T>(userId: string, fn: (tx: Db) => Promise<T>): Promise<T> {
    return app.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`)
      return fn(tx as unknown as Db)
    })
  }

  // ── fixtures (owner connection, bypasses RLS) ─────────────────────────────
  async function makeTenant(slug: string) {
    const t = await ownerPool.query<{ id: string }>(
      `insert into tenants (slug,name,status,timezone) values ($1,$2,'active',$3)
       on conflict (slug) do update set name=excluded.name returning id`,
      [slug, `${slug} co`, TZ],
    )
    const tenantId = t.rows[0].id
    const b = await ownerPool.query<{ id: string }>(
      `insert into branches (tenant_id,name,is_primary) values ($1,'Main',true)
       on conflict (tenant_id,name) do update set is_primary=true returning id`,
      [tenantId],
    )
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
    // menu_items has no unique constraint to target with ON CONFLICT, so a
    // rerun after a crash leaves orphaned rows behind — harmless: each
    // successful run's final cleanup deletes the tenant, cascading these away.
    const burger = await ownerPool.query<{ id: string }>(
      `insert into menu_items (tenant_id,category_id,name,price) values ($1,$2,'Burger','150.00') returning id`,
      [tenantId, cat.rows[0].id],
    )
    const coke = await ownerPool.query<{ id: string }>(
      `insert into menu_items (tenant_id,category_id,name,price) values ($1,$2,'Coke','50.00') returning id`,
      [tenantId, cat.rows[0].id],
    )
    return {
      tenantId,
      branchId: b.rows[0].id,
      userId: u.rows[0].id,
      membershipId: m.rows[0].id,
      burgerId: burger.rows[0].id,
      cokeId: coke.rows[0].id,
    }
  }

  /** Run createOrderCore as `userId`; returns the result or the error message. */
  async function place(
    t: { tenantId: string; branchId: string; userId: string; membershipId: string },
    items: { menuItemId: string; qty: number; specialInstructions?: string }[],
  ) {
    try {
      const r = await withUser(t.userId, (tx) =>
        createOrderCore(tx, { tenantId: t.tenantId, timezone: TZ, membershipId: t.membershipId }, { branchId: t.branchId, items }),
      )
      return { ok: true as const, ...r }
    } catch (e) {
      return { ok: false as const, order: e instanceof OrderError, message: e instanceof Error ? e.message : String(e) }
    }
  }

  async function cancel(t: { tenantId: string; userId: string }, orderId: string) {
    try {
      await withUser(t.userId, (tx) => cancelOrderCore(tx, { tenantId: t.tenantId }, orderId))
      return { ok: true as const }
    } catch (e) {
      return { ok: false as const, order: e instanceof OrderError, message: e instanceof Error ? e.message : String(e) }
    }
  }

  async function kotFor(orderId: string) {
    const { rows } = await ownerPool.query(
      `select id, kot_number, status, tenant_id, branch_id from kots where order_id=$1`,
      [orderId],
    )
    return rows
  }

  let bookingSeq = 0
  /** A minimal booking — no slots needed, createOrderCore only checks it exists. */
  async function makeBooking(t: { tenantId: string; branchId: string }) {
    const n = ++bookingSeq
    const bk = await ownerPool.query<{ id: string }>(
      `insert into bookings (tenant_id,branch_id,booking_number,status,subtotal,total)
       values ($1,$2,$3,'confirmed','0','0') returning id`,
      [t.tenantId, t.branchId, `TB-KOT-${n}`],
    )
    return { bookingId: bk.rows[0].id }
  }

  async function cancelBookingOrders(t: { tenantId: string; userId: string }, bookingId: string) {
    await withUser(t.userId, (tx) => cancelOpenOrdersForBooking(tx, { tenantId: t.tenantId }, bookingId))
  }

  const A = await makeTenant('testkota')
  const B = await makeTenant('testkotb')

  // A clean slate, so the run is repeatable even if a previous one was killed
  // before its cleanup.
  const bothTenants = [[A.tenantId, B.tenantId]]
  await ownerPool.query('delete from kots where tenant_id = any($1)', bothTenants)
  await ownerPool.query('delete from order_items where tenant_id = any($1)', bothTenants)
  await ownerPool.query('delete from orders where tenant_id = any($1)', bothTenants)
  await ownerPool.query('delete from bookings where tenant_id = any($1)', bothTenants)

  // ── 1. placing an order creates exactly one pending KOT ──────────────────
  const r1 = await place(A, [
    { menuItemId: A.burgerId, qty: 2 },
    { menuItemId: A.cokeId, qty: 1, specialInstructions: 'No ice' },
  ])
  check('an order with two menu items places successfully', r1.ok)

  if (r1.ok) {
    const orderRow = (await ownerPool.query('select tenant_id, branch_id from orders where id=$1', [r1.id])).rows[0]
    check('the order carries the right tenant and branch', orderRow.tenant_id === A.tenantId && orderRow.branch_id === A.branchId)

    const kotRows = await kotFor(r1.id)
    check('exactly ONE kitchen ticket was created for the order', kotRows.length === 1)
    check("the ticket starts 'pending'", kotRows[0]?.status === 'pending')
    check('the ticket carries the right tenant and branch', kotRows[0]?.tenant_id === A.tenantId && kotRows[0]?.branch_id === A.branchId)
    check('the ticket number follows KOT-YYYYMMDD-NNN', /^KOT-\d{8}-\d{3}$/.test(kotRows[0]?.kot_number ?? ''))
    check('the KOT number is echoed back to the caller', r1.kotNumber === kotRows[0]?.kot_number)
  }

  // ── 2. KOT numbers are sequential per tenant per day ──────────────────────
  const r2 = await place(A, [{ menuItemId: A.cokeId, qty: 1 }])
  check('a second order for the same tenant places successfully', r2.ok)
  if (r1.ok && r2.ok) {
    const n1 = Number(r1.kotNumber.split('-').pop())
    const n2 = Number(r2.kotNumber.split('-').pop())
    check('its KOT number is the next one in sequence', n2 === n1 + 1)
  }

  // ── 3. a failed order leaves no order AND no KOT ──────────────────────────
  const before = (await ownerPool.query('select count(*)::int n from orders where tenant_id=$1', [A.tenantId])).rows[0].n
  const kotsBefore = (await ownerPool.query('select count(*)::int n from kots where tenant_id=$1', [A.tenantId])).rows[0].n
  const rBad = await place(A, [{ menuItemId: '00000000-0000-0000-0000-000000000000', qty: 1 }])
  check('ordering an unknown menu item is refused', !rBad.ok && rBad.order && /menu items were not found/i.test(rBad.message))
  const after = (await ownerPool.query('select count(*)::int n from orders where tenant_id=$1', [A.tenantId])).rows[0].n
  const kotsAfter = (await ownerPool.query('select count(*)::int n from kots where tenant_id=$1', [A.tenantId])).rows[0].n
  check('…no order was left behind', after === before)
  check('…and no ghost kitchen ticket either — order and KOT save together or not at all', kotsAfter === kotsBefore)

  // ── 4. tenant isolation: tenant B cannot order tenant A's menu item ──────
  const rCross = await place(B, [{ menuItemId: A.burgerId, qty: 1 }])
  check("tenant B cannot place an order using tenant A's menu item (RLS)", !rCross.ok && rCross.order)

  // ── 5. cancelling an order cancels its KOT ────────────────────────────────
  const r5 = await place(A, [{ menuItemId: A.burgerId, qty: 1 }])
  if (r5.ok) {
    const c5 = await cancel(A, r5.id)
    check('cancelling an open order succeeds', c5.ok)
    const orderStatus = (await ownerPool.query('select status from orders where id=$1', [r5.id])).rows[0].status
    check("…the order is marked 'cancelled'", orderStatus === 'cancelled')
    const kotRows = await kotFor(r5.id)
    check("…and its kitchen ticket is marked 'cancelled' too — the kitchen must not cook it", kotRows[0]?.status === 'cancelled')

    // Cancelling again is refused.
    const c5again = await cancel(A, r5.id)
    check('cancelling an already-cancelled order is refused', !c5again.ok && c5again.order && /already cancelled/i.test(c5again.message))
  }

  // ── 6. a SERVED ticket is left alone by order cancellation ───────────────
  const r6 = await place(A, [{ menuItemId: A.cokeId, qty: 1 }])
  if (r6.ok) {
    await ownerPool.query(`update kots set status='served' where order_id=$1`, [r6.id])
    const c6 = await cancel(A, r6.id)
    check('cancelling an order whose food was already served still succeeds', c6.ok)
    const kotRows = await kotFor(r6.id)
    check("…but the ticket stays 'served' — the food is already out the door", kotRows[0]?.status === 'served')
  }

  // ── 7. a billed order cannot be cancelled ─────────────────────────────────
  const r7 = await place(A, [{ menuItemId: A.burgerId, qty: 1 }])
  if (r7.ok) {
    await ownerPool.query(`update orders set status='billed' where id=$1`, [r7.id])
    const c7 = await cancel(A, r7.id)
    check('a billed order cannot be cancelled', !c7.ok && c7.order && /already been billed/i.test(c7.message))
    const kotRows = await kotFor(r7.id)
    check('…and its ticket is untouched', kotRows[0]?.status === 'pending')
  }

  // ── 8. cancelling a nonexistent order is refused ──────────────────────────
  const c8 = await cancel(A, '00000000-0000-0000-0000-000000000000')
  check('cancelling a nonexistent order is refused', !c8.ok && c8.order && /order not found/i.test(c8.message))

  // ── 9. cancelling a BOOKING cascades to its open orders + KOTs ────────────
  // This is the only cancellation path reachable from the UI today (there is
  // no standalone "cancel order" button) — lib/actions/bookings.ts calls
  // cancelOpenOrdersForBooking whenever a booking is cancelled.
  {
    const booking = await makeBooking(A)

    // An open order with a pending ticket — must be cancelled.
    const open1 = await place(A, [{ menuItemId: A.burgerId, qty: 1 }])
    // A second open order whose ticket is already preparing — must also be
    // cancelled, but its already-served sibling ticket state is exercised in
    // section 6, so here just prove the cascade reaches every open order.
    const open2 = await place(A, [{ menuItemId: A.cokeId, qty: 1 }])
    // A billed order attached to the same booking — must be left alone.
    const billed = await place(A, [{ menuItemId: A.burgerId, qty: 2 }])

    if (!open1.ok || !open2.ok || !billed.ok) {
      check('fixtures for the booking-cascade test placed successfully', false)
    } else {
      await ownerPool.query(
        `update orders set booking_id=$1 where id = any($2)`,
        [booking.bookingId, [open1.id, open2.id, billed.id]],
      )
      await ownerPool.query(`update orders set status='billed' where id=$1`, [billed.id])

      await cancelBookingOrders(A, booking.bookingId)

      const s1 = (await ownerPool.query('select status from orders where id=$1', [open1.id])).rows[0].status
      const s2 = (await ownerPool.query('select status from orders where id=$1', [open2.id])).rows[0].status
      check('cancelling the booking cancels its open orders', s1 === 'cancelled' && s2 === 'cancelled')

      const k1 = await kotFor(open1.id)
      const k2 = await kotFor(open2.id)
      check('…and their kitchen tickets — the kitchen must not keep cooking for it', k1[0]?.status === 'cancelled' && k2[0]?.status === 'cancelled')

      const billedStatus = (await ownerPool.query('select status from orders where id=$1', [billed.id])).rows[0].status
      check('…but a BILLED order on the same booking is left alone', billedStatus === 'billed')
      const billedKot = await kotFor(billed.id)
      check('…its ticket untouched too', billedKot[0]?.status === 'pending')
    }

    // A booking with no orders at all is a harmless no-op.
    const emptyBooking = await makeBooking(A)
    let threw = false
    try {
      await cancelBookingOrders(A, emptyBooking.bookingId)
    } catch {
      threw = true
    }
    check('cancelling a booking with no orders is a no-op, not an error', !threw)
  }

  // ── cleanup ───────────────────────────────────────────────────────────────
  await ownerPool.query('delete from tenants where id = any($1)', [[A.tenantId, B.tenantId]])
  await ownerPool.query(`delete from users where email like '%@testkot%.test'`)
  await ownerPool.end()
  await appPool.end()

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
