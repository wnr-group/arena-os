/**
 * Seat/guest tagging on order_items (M18 #1) — the prerequisite for by-seat
 * bill splitting. Integration tests against a real database, same shape as
 * scripts/test-modifiers.ts. Drives createOrderCore (lib/orders/service.ts)
 * directly:
 *
 *   - an item ordered with no seatNo stores seat_no = null (unassigned/shared)
 *   - an item ordered with a seatNo stores it verbatim
 *   - two lines on the same order can carry different seat numbers
 *   - seat_no never changes unit_price/line_total — pricing is identical
 *     with or without a seat tag
 *   - a non-positive or non-integer seatNo is refused
 *   - seatNo is not checked against the booking's cover_count — tagging must
 *     never block placing an order
 *
 *   npx tsx scripts/test-seat-tagging.ts
 */
import { Pool } from 'pg'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { sql } from 'drizzle-orm'
import * as schema from '../db/schema'
import { seatTableSessionCore } from '../lib/booking/service'
import { createOrderCore, OrderError } from '../lib/orders/service'
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

  type Tenant = {
    tenantId: string
    branchId: string
    userId: string
    membershipId: string
    itemId: string
    tables: string[]
  }

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
      `insert into menu_categories (tenant_id,name) values ($1,'Mains')
       on conflict (tenant_id,name) do update set name=excluded.name returning id`,
      [tenantId],
    )
    const item = await ownerPool.query<{ id: string }>(
      `insert into menu_items (tenant_id,category_id,name,price) values ($1,$2,'Pasta','150.00') returning id`,
      [tenantId, cat.rows[0].id],
    )
    const rt = await ownerPool.query<{ id: string }>(
      `insert into resource_types (tenant_id,name,hourly_rate) values ($1,'Table','0')
       on conflict (tenant_id,name) do update set name=excluded.name returning id`,
      [tenantId],
    )
    const r = await ownerPool.query<{ id: string }>(
      `insert into resources (tenant_id,branch_id,resource_type_id,name) values ($1,$2,$3,'T1') returning id`,
      [tenantId, branchId, rt.rows[0].id],
    )
    return {
      tenantId,
      branchId,
      userId: u.rows[0].id,
      membershipId: m.rows[0].id,
      itemId: item.rows[0].id,
      tables: [r.rows[0].id],
    }
  }

  async function seat(t: Tenant, resourceId: string, coverCount: number) {
    return withUser(t.userId, (tx) =>
      seatTableSessionCore(
        tx,
        { tenantId: t.tenantId, timezone: TZ, membershipId: t.membershipId },
        { branchId: t.branchId, resourceId, coverCount },
      ),
    )
  }

  async function order(t: Tenant, bookingId: string, items: { qty: number; seatNo?: number }[]) {
    return withUser(t.userId, (tx) =>
      createOrderCore(
        tx,
        { tenantId: t.tenantId, timezone: TZ, membershipId: t.membershipId },
        { branchId: t.branchId, bookingId, items: items.map((i) => ({ menuItemId: t.itemId, qty: i.qty, seatNo: i.seatNo })) },
      ),
    )
  }

  async function orderItemRows(orderId: string) {
    const { rows } = await ownerPool.query(
      `select seat_no, unit_price, line_total from order_items where order_id=$1 order by id`,
      [orderId],
    )
    return rows as { seat_no: number | null; unit_price: string; line_total: string }[]
  }

  async function attempt<T>(fn: () => Promise<T>) {
    try {
      const value = await fn()
      return { ok: true as const, value }
    } catch (e) {
      return {
        ok: false as const,
        orderError: e instanceof OrderError,
        message: e instanceof Error ? e.message : String(e),
      }
    }
  }

  async function complete(t: Tenant, bookingId: string) {
    await withUser(t.userId, (tx) => tx.update(schema.bookings).set({ status: 'completed' }).where(sql`${schema.bookings.id} = ${bookingId}`))
  }

  const A = await makeTenant('testseattag-a')

  // ── 1. no seatNo given ⇒ seat_no stays null (unassigned/shared) ────────────
  {
    const session = await seat(A, A.tables[0], 4)
    const o = await order(A, session.id, [{ qty: 1 }])
    const rows = await orderItemRows(o.id)
    check('an untagged line stores seat_no = null', rows[0].seat_no === null)
    await complete(A, session.id)
  }

  // ── 2. a given seatNo is stored verbatim ────────────────────────────────────
  {
    const session = await seat(A, A.tables[0], 4)
    const o = await order(A, session.id, [{ qty: 1, seatNo: 2 }])
    const rows = await orderItemRows(o.id)
    check('a tagged line stores the given seat_no', rows[0].seat_no === 2)
    await complete(A, session.id)
  }

  // ── 3. different lines on the same order can carry different seats ─────────
  {
    const session = await seat(A, A.tables[0], 4)
    const o = await order(A, session.id, [{ qty: 1, seatNo: 1 }, { qty: 2, seatNo: 3 }, { qty: 1 }])
    const rows = await orderItemRows(o.id)
    const seats = rows.map((r) => r.seat_no).sort((a, b) => (a ?? -1) - (b ?? -1))
    check('three lines keep their own independent seat numbers', JSON.stringify(seats) === JSON.stringify([null, 1, 3]))
    await complete(A, session.id)
  }

  // ── 4. seat_no never changes pricing ────────────────────────────────────────
  {
    const session = await seat(A, A.tables[0], 4)
    const tagged = await order(A, session.id, [{ qty: 2, seatNo: 1 }])
    const untagged = await order(A, session.id, [{ qty: 2 }])
    const [taggedRow] = await orderItemRows(tagged.id)
    const [untaggedRow] = await orderItemRows(untagged.id)
    check(
      'unit_price/line_total are identical whether or not a seat is tagged',
      taggedRow.unit_price === untaggedRow.unit_price && taggedRow.line_total === untaggedRow.line_total,
    )
    await complete(A, session.id)
  }

  // ── 5. a non-positive/non-integer seatNo is refused ─────────────────────────
  {
    const session = await seat(A, A.tables[0], 4)
    const zero = await attempt(() => order(A, session.id, [{ qty: 1, seatNo: 0 }]))
    check('seatNo = 0 is refused', !zero.ok && zero.orderError && /positive whole number/i.test(zero.message))
    const frac = await attempt(() => order(A, session.id, [{ qty: 1, seatNo: 1.5 }]))
    check('a fractional seatNo is refused', !frac.ok && frac.orderError && /positive whole number/i.test(frac.message))
    await complete(A, session.id)
  }

  // ── 6. seatNo is never checked against cover_count — tagging can't block ───
  {
    const session = await seat(A, A.tables[0], 2) // only 2 covers
    const ok = await attempt(() => order(A, session.id, [{ qty: 1, seatNo: 99 }]))
    check('a seatNo beyond cover_count still succeeds — tagging never blocks ordering', ok.ok)
    await complete(A, session.id)
  }

  // ── cleanup ───────────────────────────────────────────────────────────────
  await ownerPool.query('delete from tenants where id = $1', [A.tenantId])
  await ownerPool.query(`delete from users where email like '%@testseattag-%.test'`)
  await ownerPool.end()
  await appPool.end()

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
