/**
 * M25 #3 — edit food order line quantity / remove on an unbilled order.
 *
 * Drives editOrderItemQuantityCore/removeOrderItemCore directly (same
 * discipline test-kot-creation.ts already uses for createOrderCore) against
 * a real database:
 *
 *   - qty edit (up and down) recomputes line_total = unit_price x newQty,
 *     leaving unit_price (and any baked-in happy-hour discount) untouched
 *   - newQty 0 delegates to the exact same removal removeOrderItem does
 *   - remove deletes the row outright (not a void flag)
 *   - removing the LAST active line cancels the order and its KOT; removing
 *     one of several leaves the order open and the KOT alone
 *   - both refuse once the order is billed or cancelled (lockActiveOrderItem's
 *     existing rule, reused verbatim — same message void/comp already gives)
 *   - both write an audit_log row (order_item.edit / order_item.remove)
 *   - available on a gaming_cafe tenant (no restaurant gate)
 *   - cross-tenant order item id fails closed
 *
 *   npx tsx scripts/test-order-line-correction.ts
 */
import { Pool } from 'pg'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { sql } from 'drizzle-orm'
import * as schema from '../db/schema'
import { OrderError, createOrderCore, editOrderItemQuantityCore, removeOrderItemCore } from '../lib/orders/service'
import { loadEnv } from './env'

type Db = NodePgDatabase<typeof schema>

let pass = 0
let fail = 0
const check = (label: string, cond: boolean, got?: unknown) => {
  console.log(`${cond ? '✓' : '✗ FAIL'}  ${label}${cond ? '' : `  (got: ${JSON.stringify(got)})`}`)
  if (cond) pass++
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

  const slug = 'test-order-line-correction'
  const t = await ownerPool.query<{ id: string }>(
    `insert into tenants (slug,name,status,timezone,industry) values ($1,$2,'active',$3,'gaming_cafe')
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
  const cat = await ownerPool.query<{ id: string }>(
    `insert into menu_categories (tenant_id,name) values ($1,'Snacks')
     on conflict (tenant_id,name) do update set name=excluded.name returning id`,
    [tenantId],
  )
  const burger = await ownerPool.query<{ id: string }>(
    `insert into menu_items (tenant_id,category_id,name,price) values ($1,$2,'Burger','150.00') returning id`,
    [tenantId, cat.rows[0].id],
  )
  const coke = await ownerPool.query<{ id: string }>(
    `insert into menu_items (tenant_id,category_id,name,price) values ($1,$2,'Coke','50.00') returning id`,
    [tenantId, cat.rows[0].id],
  )

  const actor = { tenantId, membershipId }

  let bookingSeq = 0
  async function makeBooking() {
    const n = ++bookingSeq
    const bk = await ownerPool.query<{ id: string }>(
      `insert into bookings (tenant_id,branch_id,booking_number,status,subtotal,total)
       values ($1,$2,$3,'confirmed','0','0') returning id`,
      [tenantId, branchId, `TB-OLC-${n}`],
    )
    return bk.rows[0].id
  }

  async function place(bookingId: string, items: { menuItemId: string; qty: number }[]) {
    return withUser(userId, (tx) =>
      createOrderCore(tx, { tenantId, timezone: TZ, membershipId }, { branchId, bookingId, items }),
    )
  }

  async function itemsOf(orderId: string) {
    const { rows } = await ownerPool.query<{ id: string; qty: number; line_total: string; unit_price: string }>(
      `select id, qty, line_total, unit_price from order_items where order_id=$1 order by item_name`,
      [orderId],
    )
    return rows
  }

  async function orderStatus(orderId: string) {
    const { rows } = await ownerPool.query<{ status: string }>(`select status from orders where id=$1`, [orderId])
    return rows[0]?.status
  }

  async function kotStatus(orderId: string) {
    const { rows } = await ownerPool.query<{ status: string }>(`select status from kots where order_id=$1`, [orderId])
    return rows[0]?.status
  }

  async function expectRejected(label: string, fn: () => Promise<unknown>, messageIncludes?: string) {
    try {
      await fn()
      check(label, false)
    } catch (e) {
      const ok = e instanceof OrderError && (!messageIncludes || e.message.toLowerCase().includes(messageIncludes.toLowerCase()))
      check(label, ok, e instanceof Error ? e.message : e)
    }
  }

  // ══ 1. edit quantity up and down ═══════════════════════════════════════════
  console.log('\n── edit quantity ──')
  const bk1 = await makeBooking()
  const order1 = await place(bk1, [{ menuItemId: burger.rows[0].id, qty: 3 }])
  const line1 = (await itemsOf(order1.id))[0]
  check('placed at qty=3, line_total=450.00', line1.qty === 3 && line1.line_total === '450.00', line1)

  await withUser(userId, (tx) => editOrderItemQuantityCore(tx, actor, { orderItemId: line1.id, newQty: 2 }))
  const afterDown = (await itemsOf(order1.id))[0]
  check('edited 3 -> 2: qty=2, line_total=300.00 (unit_price untouched)', afterDown.qty === 2 && afterDown.line_total === '300.00' && afterDown.unit_price === '150.00', afterDown)

  await withUser(userId, (tx) => editOrderItemQuantityCore(tx, actor, { orderItemId: line1.id, newQty: 5 }))
  const afterUp = (await itemsOf(order1.id))[0]
  check('edited 2 -> 5: qty=5, line_total=750.00', afterUp.qty === 5 && afterUp.line_total === '750.00', afterUp)

  const audit1 = await ownerPool.query(
    `select action, before, after from audit_log where tenant_id=$1 and entity_id=$2 and action='order_item.edit' order by created_at`,
    [tenantId, line1.id],
  )
  check('two order_item.edit audit rows were written', audit1.rows.length === 2, audit1.rows.length)

  // ══ 2. newQty=0 delegates to removal ═══════════════════════════════════════
  console.log('\n── edit to 0 removes the line ──')
  const bk2 = await makeBooking()
  const order2 = await place(bk2, [
    { menuItemId: burger.rows[0].id, qty: 1 },
    { menuItemId: coke.rows[0].id, qty: 1 },
  ])
  const [burgerLine2, cokeLine2] = await itemsOf(order2.id)
  await withUser(userId, (tx) => editOrderItemQuantityCore(tx, actor, { orderItemId: burgerLine2.id, newQty: 0 }))
  const remaining2 = await itemsOf(order2.id)
  check('editing to qty=0 deletes the row outright', remaining2.length === 1 && remaining2[0].id === cokeLine2.id, remaining2)
  check('order stays open (one other active line remains)', (await orderStatus(order2.id)) === 'open')

  const auditRemove2 = await ownerPool.query(
    `select 1 from audit_log where tenant_id=$1 and entity_id=$2 and action='order_item.remove'`,
    [tenantId, burgerLine2.id],
  )
  check('qty=0 path writes order_item.remove (not order_item.edit)', auditRemove2.rows.length === 1)

  // ══ 3. removing the LAST active line cancels the order + KOT ═══════════════
  console.log('\n── removing the last line cancels the order ──')
  await withUser(userId, (tx) => removeOrderItemCore(tx, actor, { orderItemId: cokeLine2.id }))
  check('order cancelled once its last active line is removed', (await orderStatus(order2.id)) === 'cancelled')
  check('…and its KOT cancelled too', (await kotStatus(order2.id)) === 'cancelled')

  // ══ 4. removing ONE of several leaves the order open ═══════════════════════
  console.log('\n── removing one of several lines leaves the order open ──')
  const bk3 = await makeBooking()
  const order3 = await place(bk3, [
    { menuItemId: burger.rows[0].id, qty: 1 },
    { menuItemId: coke.rows[0].id, qty: 2 },
  ])
  const [burgerLine3] = await itemsOf(order3.id)
  await withUser(userId, (tx) => removeOrderItemCore(tx, actor, { orderItemId: burgerLine3.id }))
  check('order still open (one line remains)', (await orderStatus(order3.id)) === 'open')
  check('…its KOT is not cancelled', (await kotStatus(order3.id)) !== 'cancelled')

  // ══ 5. refused once billed ═════════════════════════════════════════════════
  console.log('\n── refused once billed ──')
  const bk4 = await makeBooking()
  const order4 = await place(bk4, [{ menuItemId: burger.rows[0].id, qty: 1 }])
  const [line4] = await itemsOf(order4.id)
  await ownerPool.query(`update orders set status='billed' where id=$1`, [order4.id])
  await expectRejected(
    'edit refused once billed',
    () => withUser(userId, (tx) => editOrderItemQuantityCore(tx, actor, { orderItemId: line4.id, newQty: 2 })),
    'void or refund the invoice',
  )
  await expectRejected(
    'remove refused once billed',
    () => withUser(userId, (tx) => removeOrderItemCore(tx, actor, { orderItemId: line4.id })),
    'void or refund the invoice',
  )
  const stillThere4 = await itemsOf(order4.id)
  check('…the line is untouched', stillThere4.length === 1 && stillThere4[0].qty === 1)

  // ══ 6. refused once cancelled ══════════════════════════════════════════════
  console.log('\n── refused once cancelled ──')
  const bk5 = await makeBooking()
  const order5 = await place(bk5, [{ menuItemId: burger.rows[0].id, qty: 1 }])
  const [line5] = await itemsOf(order5.id)
  await ownerPool.query(`update orders set status='cancelled' where id=$1`, [order5.id])
  await expectRejected(
    'edit refused on an already-cancelled order',
    () => withUser(userId, (tx) => editOrderItemQuantityCore(tx, actor, { orderItemId: line5.id, newQty: 2 })),
    'already cancelled',
  )

  // ══ 7. cross-tenant fail-closed ════════════════════════════════════════════
  console.log('\n── cross-tenant fail-closed ──')
  const other = await ownerPool.query<{ id: string }>(
    `insert into tenants (slug,name,status,timezone) values ($1,'Other Co','active',$2) returning id`,
    [`${slug}-other`, TZ],
  )
  const otherBr = await ownerPool.query<{ id: string }>(
    `insert into branches (tenant_id,name,is_primary) values ($1,'Main',true) returning id`,
    [other.rows[0].id],
  )
  const otherCat = await ownerPool.query<{ id: string }>(
    `insert into menu_categories (tenant_id,name) values ($1,'Snacks') returning id`,
    [other.rows[0].id],
  )
  const otherItem = await ownerPool.query<{ id: string }>(
    `insert into menu_items (tenant_id,category_id,name,price) values ($1,$2,'Fries','80.00') returning id`,
    [other.rows[0].id, otherCat.rows[0].id],
  )
  const otherUser = await ownerPool.query<{ id: string }>(
    `insert into users (email,password_hash) values ($1,'x') returning id`,
    [`owner-other@${slug}.test`],
  )
  await ownerPool.query(
    `insert into memberships (tenant_id,user_id,role,status) values ($1,$2,'owner','active')`,
    [other.rows[0].id, otherUser.rows[0].id],
  )
  const otherBooking = await ownerPool.query<{ id: string }>(
    `insert into bookings (tenant_id,branch_id,booking_number,status,subtotal,total) values ($1,$2,$3,'confirmed','0','0') returning id`,
    [other.rows[0].id, otherBr.rows[0].id, `TB-OLC-OTHER`],
  )
  const otherOrder = await withUser(otherUser.rows[0].id, (tx) =>
    createOrderCore(
      tx,
      { tenantId: other.rows[0].id, timezone: TZ, membershipId: null },
      { branchId: otherBr.rows[0].id, bookingId: otherBooking.rows[0].id, items: [{ menuItemId: otherItem.rows[0].id, qty: 1 }] },
    ),
  )
  const [otherLine] = await itemsOf(otherOrder.id)
  await expectRejected(
    'an order item belonging to another tenant is not found',
    () => withUser(userId, (tx) => editOrderItemQuantityCore(tx, actor, { orderItemId: otherLine.id, newQty: 2 })),
    'not found',
  )

  await ownerPool.query('delete from tenants where id = $1', [other.rows[0].id])
  await ownerPool.query('delete from tenants where id = $1', [tenantId])
  await ownerPool.query(`delete from users where email = $1`, [`owner@${slug}.test`])
  await ownerPool.query(`delete from users where email = $1`, [`owner-other@${slug}.test`])
  await ownerPool.end()
  await appPool.end()

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
