/**
 * Takeaway & delivery orders (M20 / AROS-182) against a real database.
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs scripts/test-typed-orders.ts
 *
 * Covers: opt-in gates; creation with no table/booking and a kitchen ticket;
 * the delivery fee billed as its own GST line (and kept out of food sales);
 * pay-on-collection through the real invoice + payment path, once; the
 * handover states; the DB's own shape checks; dine-in left untouched; the KDS
 * and the live-orders read; stock deduction on collection.
 */
import { Pool } from 'pg'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { sql } from 'drizzle-orm'
import * as schema from '../db/schema'
import { loadEnv } from './env'
import { entitleTenant } from './entitle-fixture'

type Db = NodePgDatabase<typeof schema>
let pass = 0,
  fail = 0
const check = (l: string, c: boolean) => {
  console.log(`${c ? '✓' : '✗ FAIL'}  ${l}`)
  if (c) pass++
  else fail++
}
const near = (a: number | null | undefined, b: number, eps = 0.011) => a !== null && a !== undefined && Math.abs(a - b) <= eps
const TZ = 'Asia/Kolkata'
const ROLES = ['owner', 'manager', 'cashier', 'kitchen_staff'] as const
type Role = (typeof ROLES)[number]

async function main() {
  loadEnv()
  const typed = await import('../lib/orders/typed')
  const { createOrderCore, cancelOrderCore, OrderError } = await import('../lib/orders/service')
  const booking = await import('../lib/booking/service')
  const inv = await import('../lib/inventory/service')
  const { getKdsBoard } = await import('../lib/kots/kds-data')
  const { getSalesReport } = await import('../lib/reports/sales')
  const { todayInZone } = await import('../lib/booking/time')

  const ownerPool = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })
  const appPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 })
  const app = drizzle(appPool, { schema })
  const withUser = <T>(userId: string, fn: (tx: Db) => Promise<T>): Promise<T> =>
    app.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`)
      return fn(tx as unknown as Db)
    })
  const q = async (text: string, params: unknown[] = []) => (await ownerPool.query(text, params)).rows

  async function makeTenant(slug: string) {
    const t = await q(
      `insert into tenants (slug,name,status,timezone,industry) values ($1,$2,'active',$3,'restaurant')
       on conflict (slug) do update set name=excluded.name returning id`,
      [slug, `${slug} co`, TZ],
    )
    const tenantId = t[0].id as string
    const b = await q(`insert into branches (tenant_id,name,is_primary) values ($1,'Main',true) on conflict (tenant_id,name) do update set is_primary=true returning id`, [tenantId])
    const members = {} as Record<Role, { userId: string; membershipId: string }>
    for (const role of ROLES) {
      const u = await q(`insert into users (email,password_hash) values ($1,'x') on conflict (email) do update set email=excluded.email returning id`, [`${role}@${slug}.test`])
      const m = await q(
        `insert into memberships (tenant_id,user_id,role,status,full_name) values ($1,$2,$3,'active',$4)
         on conflict (tenant_id,user_id) do update set role=$3, status='active', full_name=$4 returning id`,
        [tenantId, u[0].id, role, `${role} person`],
      )
      members[role] = { userId: u[0].id, membershipId: m[0].id }
    }
    const cat = await q(`insert into menu_categories (tenant_id,name) values ($1,'Mains') on conflict (tenant_id,name) do update set name=excluded.name returning id`, [tenantId])
    const tax5 = await q(`insert into tax_rates (tenant_id,name,percent) values ($1,'GST 5','5.00') on conflict (tenant_id,name) do update set percent='5.00' returning id`, [tenantId])
    const burger = await q(`insert into menu_items (tenant_id,category_id,name,price,tax_rate_id) values ($1,$2,'Burger','200.00',$3) returning id`, [tenantId, cat[0].id, tax5[0].id])
    const rt = await q(`insert into resource_types (tenant_id,name,hourly_rate) values ($1,'Table','0') on conflict (tenant_id,name) do update set hourly_rate='0' returning id`, [tenantId])
    const table = await q(`insert into resources (tenant_id,branch_id,resource_type_id,name) values ($1,$2,$3,'T1') on conflict (tenant_id,name) do update set status='available' returning id`, [tenantId, b[0].id, rt[0].id])
    await entitleTenant(ownerPool, tenantId)
    return { tenantId, branchId: b[0].id as string, members, burger: burger[0].id as string, table: table[0].id as string }
  }
  type T = Awaited<ReturnType<typeof makeTenant>>

  async function attempt<R>(fn: () => Promise<R>) {
    try {
      return { ok: true as const, v: await fn() }
    } catch (e) {
      const cause = (e as { cause?: { code?: string } }).cause
      const raw = e as { code?: string }
      return { ok: false as const, err: e, msg: e instanceof Error ? e.message : String(e), code: cause?.code ?? raw.code }
    }
  }
  const as = <R>(t: T, role: Role, fn: (tx: Db) => Promise<R>) => withUser(t.members[role].userId, fn)
  const ctx = (t: T, role: Role = 'cashier') => ({ tenantId: t.tenantId, timezone: TZ, membershipId: t.members[role].membershipId })
  const cx = (t: T, role: Role = 'manager') =>
    ({ user: { id: t.members[role].userId }, tenant: { id: t.tenantId, industry: 'restaurant', timezone: TZ, currency: 'INR', name: 'T' }, role, membershipId: t.members[role].membershipId }) as never
  const order = async (id: string) => (await q('select * from orders where id=$1', [id]))[0]
  let key = 0
  const place = (t: T, o: Partial<Parameters<typeof typed.createTypedOrderCore>[2]> & { orderType: 'takeaway' | 'delivery' }, qtyN = 2) =>
    as(t, 'cashier', (tx) =>
      typed.createTypedOrderCore(tx, ctx(t), {
        branchId: t.branchId,
        contactName: 'Priya',
        contactPhone: '9876543210',
        items: [{ menuItemId: t.burger, qty: qtyN }],
        idempotencyKey: `typed-test-${++key}-${Date.now()}`,
        ...(o.orderType === 'delivery' ? { deliveryAddress: '12 MG Road, Pune' } : {}),
        ...o,
      }),
    )
  const setKot = (orderId: string, status: string) => q(`update kots set status=$2 where order_id=$1`, [orderId, status])
  const saveSettings = (t: T, s: Partial<Parameters<typeof typed.saveTypedOrderSettingsCore>[2]>) =>
    as(t, 'manager', (tx) =>
      typed.saveTypedOrderSettingsCore(tx, { tenantId: t.tenantId, membershipId: t.members.manager.membershipId }, { takeawayEnabled: false, deliveryEnabled: false, defaultDeliveryFee: 0, deliveryFeeTaxRate: 0, ...s }),
    )
  const collect = (t: T, orderId: string, method: 'cash' | 'card' | 'upi' = 'cash') =>
    as(t, 'cashier', (tx) => typed.collectTypedOrderPaymentCore(tx, { tenantId: t.tenantId, timezone: TZ, membershipId: t.members.cashier.membershipId }, { orderId, method }))
  const handover = (t: T, orderId: string, to: 'out_for_delivery' | 'collected' | 'delivered', driverName?: string) =>
    as(t, 'cashier', (tx) => typed.handoverTypedOrderCore(tx, { tenantId: t.tenantId, membershipId: t.members.cashier.membershipId }, { orderId, to, driverName }))

  const A = await makeTenant('testtypeda')
  const B = await makeTenant('testtypedb')
  const ids = [A.tenantId, B.tenantId]
  for (const tbl of ['menu_item_ingredients', 'stock_movements', 'stock_items', 'payments', 'invoice_items', 'invoices', 'audit_log']) await q(`delete from ${tbl} where tenant_id = any($1)`, [ids])
  await q('delete from order_settings where tenant_id = any($1)', [ids])

  // ── 1. off by default ─────────────────────────────────────────────────────
  const off = await attempt(() => place(A, { orderType: 'takeaway' }))
  check('takeaway refused until the venue turns it on', !off.ok && /not turned on/i.test(off.msg))
  await saveSettings(A, { takeawayEnabled: true })
  const delOff = await attempt(() => place(A, { orderType: 'delivery' }))
  check('...and delivery has its own switch', !delOff.ok && /Delivery orders are not turned on/i.test(delOff.msg))
  check('settings validate the fee and GST', !(await attempt(() => saveSettings(A, { takeawayEnabled: true, defaultDeliveryFee: -5 }))).ok && !(await attempt(() => saveSettings(A, { takeawayEnabled: true, deliveryFeeTaxRate: 150 }))).ok)
  check('only owner/manager can change them (RLS)', !(await attempt(() => as(A, 'cashier', (tx) => typed.saveTypedOrderSettingsCore(tx, { tenantId: A.tenantId, membershipId: A.members.cashier.membershipId }, { takeawayEnabled: true, deliveryEnabled: true, defaultDeliveryFee: 0, deliveryFeeTaxRate: 0 })))).ok || (await q('select delivery_enabled d from order_settings where tenant_id=$1', [A.tenantId]))[0].d === false)

  // ── 2. a takeaway ─────────────────────────────────────────────────────────
  const tk = await place(A, { orderType: 'takeaway', notes: 'No onions', pickupAt: new Date(Date.now() + 30 * 60_000) })
  const o1 = await order(tk.id)
  check('takeaway: typed, accepted, no booking, no table', o1.order_type === 'takeaway' && o1.acceptance_status === 'accepted' && o1.booking_id === null && o1.resource_id === null && o1.channel === 'staff')
  check('...carries the name, phone, pickup time and notes', o1.contact_name === 'Priya' && o1.contact_phone === '9876543210' && !!o1.pickup_at && o1.notes === 'No onions')
  check('...no delivery fee, address or driver', o1.delivery_address === null && Number(o1.delivery_fee) === 0 && o1.driver_name === null)
  const kot = (await q('select * from kots where order_id=$1', [tk.id]))[0]
  check('it reaches the kitchen: a pending ticket exists in the same transaction', kot?.status === 'pending')
  check('no table session was opened', (await q('select count(*)::int c from bookings where tenant_id=$1', [A.tenantId]))[0].c === 0)
  check('the order has its line snapshotted at the menu price + GST', (await q('select unit_price, tax_rate, qty from order_items where order_id=$1', [tk.id]))[0].tax_rate === '5.00')

  const same = await as(A, 'cashier', (tx) => typed.createTypedOrderCore(tx, ctx(A), { branchId: A.branchId, orderType: 'takeaway', contactName: 'Priya', items: [{ menuItemId: A.burger, qty: 2 }], idempotencyKey: 'idem-fixed-key-1' }))
  const again = await as(A, 'cashier', (tx) => typed.createTypedOrderCore(tx, ctx(A), { branchId: A.branchId, orderType: 'takeaway', contactName: 'Priya', items: [{ menuItemId: A.burger, qty: 2 }], idempotencyKey: 'idem-fixed-key-1' }))
  check('a retried submission (same key) returns the same order — no second ticket', same.id === again.id && (await q('select count(*)::int c from kots where order_id=$1', [same.id]))[0].c === 1)

  check('a takeaway needs a name', !(await attempt(() => place(A, { orderType: 'takeaway', contactName: '  ' }))).ok)
  check('a takeaway refuses an address', !(await attempt(() => place(A, { orderType: 'takeaway', deliveryAddress: '12 MG Road' }))).ok)
  check('an empty order is refused', !(await attempt(() => as(A, 'cashier', (tx) => typed.createTypedOrderCore(tx, ctx(A), { branchId: A.branchId, orderType: 'takeaway', contactName: 'P', items: [], idempotencyKey: 'idem-empty-key-1' })))).ok)
  check('a pickup time in the past is refused', !(await attempt(() => place(A, { orderType: 'takeaway', pickupAt: new Date(Date.now() - 3_600_000) }))).ok)
  check('an 86d item cannot be ordered (same rules as any order)', !(await attempt(async () => {
    await q(`update menu_items set status='out_of_stock' where id=$1`, [A.burger])
    try {
      return await place(A, { orderType: 'takeaway' })
    } finally {
      await q(`update menu_items set status='available' where id=$1`, [A.burger])
    }
  })).ok)

  // ── 3. status = the kitchen ticket + handover ─────────────────────────────
  const live = async (t: T = A) => as(t, 'manager', (tx) => typed.listActiveTypedOrdersCore(tx, t.tenantId, t.branchId))
  const stageOf = async (id: string) => (await live()).find((o) => o.orderId === id)?.stage
  check('new ticket -> "received"', (await stageOf(tk.id)) === 'received')
  await setKot(tk.id, 'preparing')
  check('cook started -> "preparing"', (await stageOf(tk.id)) === 'preparing')
  const early = await attempt(() => handover(A, tk.id, 'collected'))
  check('cannot hand over before the kitchen is done', !early.ok && /kitchen/i.test(early.msg))
  await setKot(tk.id, 'ready')
  check('ticket ready -> "ready"', (await stageOf(tk.id)) === 'ready')
  check('a takeaway cannot go out for delivery', !(await attempt(() => handover(A, tk.id, 'out_for_delivery', 'Ravi'))).ok)

  // ── 4. pay on collection ──────────────────────────────────────────────────
  const pay = await collect(A, tk.id, 'upi')
  check('payment: invoice raised and paid in full — 2 × 200 + 5% GST = 420', !pay.alreadyPaid && near(pay.total, 420) && pay.payment?.settled === true && pay.payment?.invoiceStatus === 'paid')
  const o1b = await order(tk.id)
  check('the order is billed and linked to its invoice', o1b.status === 'billed' && o1b.invoice_id === pay.invoiceId)
  const invRow = (await q('select * from invoices where id=$1', [pay.invoiceId]))[0]
  check('standalone invoice: no booking, status paid, total 420', invRow.booking_id === null && invRow.status === 'paid' && near(Number(invRow.total), 420))
  check('exactly one captured payment of 420 by UPI', (await q(`select method, amount, status from payments where invoice_id=$1`, [pay.invoiceId])).length === 1 && near(Number((await q('select sum(amount) s from payments where invoice_id=$1', [pay.invoiceId]))[0].s), 420))
  const again2 = await collect(A, tk.id, 'cash')
  check('collecting twice takes nothing more (alreadyPaid)', again2.alreadyPaid && again2.invoiceId === pay.invoiceId && (await q('select count(*)::int c from payments where invoice_id=$1', [pay.invoiceId]))[0].c === 1)
  check('a paid order can no longer be cancelled', !(await attempt(() => as(A, 'cashier', (tx) => cancelOrderCore(tx, { tenantId: A.tenantId }, tk.id)))).ok)
  check('listed as paid', (await live()).find((o) => o.orderId === tk.id)?.paid === true)

  const done = await handover(A, tk.id, 'collected')
  const o1c = await order(tk.id)
  check('collected: stored and timestamped', done.stage === 'collected' && o1c.handover_status === 'collected' && !!o1c.handed_over_at)
  check('...and it is off the kitchen display (even though a cashier cannot close the ticket itself)', !(await getKdsBoard(cx(A, 'kitchen_staff'), A.branchId)).tickets.some((x) => x.orderId === tk.id))
  check('...and it leaves the live list', !(await live()).some((o) => o.orderId === tk.id))
  check('a collected order cannot be collected again', !(await attempt(() => handover(A, tk.id, 'collected'))).ok)

  // ── 5. delivery + the fee ─────────────────────────────────────────────────
  await saveSettings(A, { takeawayEnabled: true, deliveryEnabled: true, defaultDeliveryFee: 50, deliveryFeeTaxRate: 18 })
  check('delivery needs an address and a phone', !(await attempt(() => place(A, { orderType: 'delivery', deliveryAddress: '  ' }))).ok && !(await attempt(() => place(A, { orderType: 'delivery', contactPhone: '' }))).ok)
  const dv = await place(A, { orderType: 'delivery' })
  const o2 = await order(dv.id)
  check('delivery: typed, address saved, fee defaulted from settings (50 @ 18%)', o2.order_type === 'delivery' && o2.delivery_address === '12 MG Road, Pune' && near(Number(o2.delivery_fee), 50) && near(Number(o2.delivery_fee_tax_rate), 18))
  const free = await place(A, { orderType: 'delivery', deliveryFee: 0 })
  check('staff can waive the fee per order', near(Number((await order(free.id)).delivery_fee), 0))
  await saveSettings(A, { takeawayEnabled: true, deliveryEnabled: true, defaultDeliveryFee: 80, deliveryFeeTaxRate: 5 })
  check('changing the default later never reprices an existing order (snapshot)', near(Number((await order(dv.id)).delivery_fee), 50) && near(Number((await order(dv.id)).delivery_fee_tax_rate), 18))

  const dpay = await collect(A, dv.id, 'cash')
  check('delivery bill: food 420 + fee 50 + 18% GST (9) = 479', near(dpay.total, 479))
  const lines = await q(`select kind, qty, unit_price, tax_rate, line_total from invoice_items where invoice_id=$1 order by kind`, [dpay.invoiceId])
  const dl = lines.find((l) => l.kind === 'delivery')
  check('the fee is its own "delivery" invoice line at its own GST rate', !!dl && near(Number(dl.line_total), 50) && Number(dl.tax_rate) === 18)
  check('the food line is untouched (5%)', lines.some((l) => l.kind === 'food' && Number(l.tax_rate) === 5))
  const bill = (await q('select subtotal, tax_total, total from invoices where id=$1', [dpay.invoiceId]))[0]
  check('invoice subtotal 450, GST 29 (20 + 9), total 479', near(Number(bill.subtotal), 450) && near(Number(bill.tax_total), 29) && near(Number(bill.total), 479))
  const today = todayInZone(TZ)
  const sales = await getSalesReport(cx(A), { range: { start: today, end: today } })
  check('the delivery fee is NOT food sales: food revenue counts 420 + 420, not the fee', near(sales.totals.foodGrossRevenue, 840))

  check('cannot go out for delivery before ready', !(await attempt(() => handover(A, dv.id, 'out_for_delivery', 'Ravi'))).ok)
  await setKot(dv.id, 'ready')
  const noDriver = await attempt(() => handover(A, dv.id, 'out_for_delivery'))
  check('...and not without a named driver', !noDriver.ok && /delivering/i.test(noDriver.msg))
  await handover(A, dv.id, 'out_for_delivery', 'Ravi')
  const o2b = await order(dv.id)
  check('out for delivery: driver saved, still live, ticket stays ready', o2b.handover_status === 'out_for_delivery' && o2b.driver_name === 'Ravi' && (await stageOf(dv.id)) === 'out_for_delivery')
  check('a delivery cannot be "collected"', !(await attempt(() => handover(A, dv.id, 'collected'))).ok)
  await handover(A, dv.id, 'delivered')
  check('delivered: stored, timestamped, gone from the live list', (await order(dv.id)).handover_status === 'delivered' && !!(await order(dv.id)).handed_over_at && !(await live()).some((o) => o.orderId === dv.id))

  // ── 6. cancel ─────────────────────────────────────────────────────────────
  const cx1 = await place(A, { orderType: 'takeaway' })
  await as(A, 'cashier', (tx) => cancelOrderCore(tx, { tenantId: A.tenantId }, cx1.id))
  check('an unbilled order can be cancelled and leaves the live list', (await order(cx1.id)).status === 'cancelled' && !(await live()).some((o) => o.orderId === cx1.id))
  check('...and the kitchen display (a cashier cannot update tickets, so the screen filters it)', !(await getKdsBoard(cx(A, 'kitchen_staff'), A.branchId)).tickets.some((x) => x.orderId === cx1.id))
  check('a cancelled order cannot be paid', !(await attempt(() => collect(A, cx1.id))).ok)

  // ── 7. dine-in is untouched ───────────────────────────────────────────────
  const sess = await as(A, 'cashier', (tx) => booking.seatTableSessionCore(tx, ctx(A), { branchId: A.branchId, resourceId: A.table, coverCount: 2 }))
  const din = await as(A, 'cashier', (tx) => createOrderCore(tx, ctx(A), { branchId: A.branchId, bookingId: sess.id, items: [{ menuItemId: A.burger, qty: 1 }] }))
  const od = await order(din.id)
  check('a table order is still dine_in with none of the new fields', od.order_type === 'dine_in' && od.contact_name === null && od.handover_status === null && od.delivery_address === null && Number(od.delivery_fee) === 0 && od.invoice_id === null)
  const hd = await attempt(() => handover(A, din.id, 'collected'))
  check('the typed-order handover refuses a table order', !hd.ok && hd.err instanceof OrderError)
  check('...and so does taking typed payment', !(await attempt(() => collect(A, din.id))).ok)
  check('table orders never appear in the takeaway list', !(await live()).some((o) => o.orderId === din.id))

  // ── 8. the DB's own shape checks (whoever writes) ─────────────────────────
  const raw = (sqlText: string, p: unknown[] = []) => attempt(() => q(sqlText, p))
  const mk = (cols: string, vals: string) => `insert into orders (tenant_id,branch_id,order_number,${cols}) values ('${A.tenantId}','${A.branchId}','OR-RAW-${Math.random().toString(36).slice(2, 8)}',${vals})`
  check('DB: a delivery with no address is refused', (await raw(mk('order_type', `'delivery'`))).code === '23514')
  check('DB: a dine-in order cannot carry a contact name', (await raw(mk('order_type,contact_name', `'dine_in','X'`))).code === '23514')
  check('DB: a takeaway cannot carry a delivery fee', (await raw(mk('order_type,delivery_fee', `'takeaway',10`))).code === '23514')
  check('DB: a takeaway cannot be "delivered"', (await raw(mk('order_type,handover_status', `'takeaway','delivered'`))).code === '23514')
  check('DB: an unknown order type is refused', (await raw(mk('order_type', `'drone'`))).code === '23514')
  check('DB: a negative fee is refused', (await raw(mk('order_type,delivery_address,delivery_fee', `'delivery','x',-1`))).code === '23514')
  check('DB: the new invoice-line kind is admitted, an unknown one is not', (await raw(`insert into invoice_items (tenant_id,invoice_id,kind,description) values ('${A.tenantId}','${dpay.invoiceId}','bogus','x')`)).code === '23514')

  // ── 9. the kitchen display ────────────────────────────────────────────────
  const tk2 = await place(A, { orderType: 'takeaway', contactName: 'Asha' })
  const board = await getKdsBoard(cx(A, 'kitchen_staff'), A.branchId)
  const t2 = board.tickets.find((t) => t.orderId === tk2.id)
  check('KDS ticket is tagged takeaway with the name', t2?.orderType === 'takeaway' && t2?.contactName === 'Asha' && t2?.tableName === null)
  const tDin = board.tickets.find((t) => t.orderId === din.id)
  check('...and the table order ticket is still dine_in and still shown', tDin?.orderType === 'dine_in')
  check('a delivery that already left the kitchen is not on the display', !board.tickets.some((x) => x.orderId === dv.id))

  // ── 10. cross-tenant ──────────────────────────────────────────────────────
  check("tenant B sees none of A's live orders", (await live(B)).length === 0)
  check("B cannot hand over / pay A's order", !(await attempt(() => as(B, 'cashier', (tx) => typed.handoverTypedOrderCore(tx, { tenantId: B.tenantId, membershipId: B.members.cashier.membershipId }, { orderId: tk2.id, to: 'collected' })))).ok && !(await attempt(() => as(B, 'cashier', (tx) => typed.collectTypedOrderPaymentCore(tx, { tenantId: B.tenantId, timezone: TZ, membershipId: B.members.cashier.membershipId }, { orderId: tk2.id, method: 'cash' })))).ok)

  // ── 11. stock comes off on collection, once ───────────────────────────────
  const dough = await as(A, 'manager', (tx) => inv.createStockItemCore(tx, { tenantId: A.tenantId, membershipId: A.members.manager.membershipId }, { branchId: A.branchId, name: 'Bun', unit: 'pcs', reorderLevel: 0, openingQuantity: 50 }))
  await as(A, 'manager', (tx) => inv.setRecipeCore(tx, { tenantId: A.tenantId, membershipId: A.members.manager.membershipId }, A.burger, [{ stockItemId: dough.id, quantity: 1 }]))
  const tk3 = await place(A, { orderType: 'takeaway' }, 3)
  const qty = async () => Number((await q('select quantity from stock_items where id=$1', [dough.id]))[0].quantity)
  check('stock is not touched while the order is unpaid', near(await qty(), 50))
  await collect(A, tk3.id)
  check('collecting payment deducts the recipe: 3 buns', near(await qty(), 47))
  await collect(A, tk3.id)
  check('...exactly once even if collected again', near(await qty(), 47))

  // ── 12. entitlement ───────────────────────────────────────────────────────
  const ent = await q(`select lower(btrim(p.name)) n, pe.value::text v from plan_entitlements pe join plans p on p.id=pe.plan_id where pe.key='module.takeaway_delivery'`)
  const vOf = (n: string) => ent.find((e) => e.n === n)?.v
  check('module.takeaway_delivery: Pro and Enterprise on, Starter off', vOf('pro') === 'true' && vOf('enterprise') === 'true' && vOf('starter') === 'false')

  for (const tbl of ['menu_item_ingredients', 'stock_movements', 'stock_items', 'payments', 'invoice_items', 'invoices', 'audit_log']) await q(`delete from ${tbl} where tenant_id = any($1)`, [ids])
  await q('delete from bookings where tenant_id = any($1)', [ids])
  await q('delete from tenants where id = any($1)', [ids])
  console.log(`\n${pass} passed, ${fail} failed`)
  await ownerPool.end()
  await appPool.end()
  process.exit(fail ? 1 : 0)
}
main().catch((e) => {
  console.error(e)
  process.exit(1)
})
