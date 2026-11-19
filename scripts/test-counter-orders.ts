/**
 * Counter food orders (M41 ticket 1) against a real database, as arena_app (RLS on).
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs scripts/test-counter-orders.ts
 *
 * Covers: one-step sale (order billed, invoice paid, ONE payment, ONE KOT, stock
 * deducted, customer linked); restaurant / role / plan refusals; bad phone;
 * cash tendered + change; idempotent retry and concurrent double-submit;
 * all-or-nothing rollback with no sequence gaps; and that a counter sale stays
 * off the takeaway board.
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
  const counter = await import('../lib/orders/counter')
  const typed = await import('../lib/orders/typed')
  const inv = await import('../lib/inventory/service')
  const { purchaseMembership } = await import('../lib/memberships/customer-memberships')
  const { issueInvoiceForOrder } = await import('../lib/billing/invoice')
  const { createOrderCore } = await import('../lib/orders/service')

  const ownerPool = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })
  const appPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 })
  const app = drizzle(appPool, { schema })
  const withUser = <T>(userId: string, fn: (tx: Db) => Promise<T>): Promise<T> =>
    app.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`)
      return fn(tx as unknown as Db)
    })
  const q = async (text: string, params: unknown[] = []) => (await ownerPool.query(text, params)).rows

  async function makeTenant(slug: string, industry: string) {
    const t = await q(
      `insert into tenants (slug,name,status,timezone,industry) values ($1,$2,'active',$3,$4)
       on conflict (slug) do update set name=excluded.name, industry=excluded.industry returning id`,
      [slug, `${slug} co`, TZ, industry],
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
    const cat = await q(`insert into menu_categories (tenant_id,name) values ($1,'Snacks') on conflict (tenant_id,name) do update set name=excluded.name returning id`, [tenantId])
    const tax5 = await q(`insert into tax_rates (tenant_id,name,percent) values ($1,'GST 5','5.00') on conflict (tenant_id,name) do update set percent='5.00' returning id`, [tenantId])
    await q(`delete from menu_items where tenant_id=$1 and name='Fries'`, [tenantId])
    const fries = await q(`insert into menu_items (tenant_id,category_id,name,price,tax_rate_id) values ($1,$2,'Fries','100.00',$3) returning id`, [tenantId, cat[0].id, tax5[0].id])
    await entitleTenant(ownerPool, tenantId)
    return { tenantId, branchId: b[0].id as string, members, fries: fries[0].id as string }
  }
  type T = Awaited<ReturnType<typeof makeTenant>>

  async function attempt<R>(fn: () => Promise<R>) {
    try {
      return { ok: true as const, v: await fn() }
    } catch (e) {
      return { ok: false as const, msg: e instanceof Error ? e.message : String(e) }
    }
  }
  const as = <R>(t: T, role: Role, fn: (tx: Db) => Promise<R>) => withUser(t.members[role].userId, fn)
  let key = 0
  const sell = (t: T, role: Role = 'cashier', o: Partial<Parameters<typeof counter.createCounterOrderCore>[2]> = {}) =>
    as(t, role, (tx) =>
      counter.createCounterOrderCore(
        tx,
        { tenantId: t.tenantId, timezone: TZ, membershipId: t.members[role].membershipId, role },
        {
          branchId: t.branchId,
          items: [{ menuItemId: t.fries, qty: 2 }],
          customerPhone: '9876543210',
          method: 'upi',
          idempotencyKey: `counter-test-${++key}-${Date.now()}`,
          ...o,
        },
      ),
    )
  const count = async (table: string, t: T) => Number((await q(`select count(*)::int c from ${table} where tenant_id=$1`, [t.tenantId]))[0].c)

  const A = await makeTenant('testcountera', 'gaming_cafe')
  const R = await makeTenant('testcounterr', 'restaurant')
  const B = await makeTenant('testcounterb', 'gaming_cafe')
  const ids = [A.tenantId, R.tenantId, B.tenantId]
  for (const tbl of ['menu_item_ingredients', 'stock_movements', 'stock_items', 'refunds', 'payments', 'invoice_items', 'invoices', 'audit_log', 'kots', 'order_items', 'orders', 'loyalty_transactions', 'wallet_transactions', 'customer_memberships', 'membership_plans', 'promo_codes', 'customers', 'sequences']) await q(`delete from ${tbl} where tenant_id = any($1)`, [ids])

  // ── 1. the happy path ────────────────────────────────────────────────────
  const stock = await as(A, 'manager', (tx) => inv.createStockItemCore(tx, { tenantId: A.tenantId, membershipId: A.members.manager.membershipId }, { branchId: A.branchId, name: 'Potato', unit: 'pcs', reorderLevel: 0, openingQuantity: 50 }))
  await as(A, 'manager', (tx) => inv.setRecipeCore(tx, { tenantId: A.tenantId, membershipId: A.members.manager.membershipId }, A.fries, [{ stockItemId: stock.id, quantity: 1 }]))

  const s1 = await sell(A, 'cashier', { method: 'cash', cashTendered: 500 })
  const o1 = (await q('select * from orders where id=$1', [s1.orderId]))[0]
  const i1 = (await q('select * from invoices where id=$1', [s1.invoiceId]))[0]
  const pays = await q('select * from payments where invoice_id=$1', [s1.invoiceId])
  const kots = await q('select * from kots where order_id=$1', [s1.orderId])
  check('order is a billed counter order with no booking / table', o1.order_type === 'counter' && o1.status === 'billed' && o1.booking_id === null && o1.resource_id === null && o1.invoice_id === s1.invoiceId)
  check('invoice is paid, no booking, 2 x 100 + 5% GST = 210', i1.status === 'paid' && i1.booking_id === null && near(Number(i1.total), 210) && near(s1.total, 210))
  check('exactly one captured payment for the full total', pays.length === 1 && pays[0].status === 'captured' && near(Number(pays[0].amount), 210) && pays[0].method === 'cash')
  check('exactly one kitchen ticket, pending', kots.length === 1 && kots[0].status === 'pending' && kots[0].kot_number === s1.kotNumber)
  check('stock deducted (2 of 50)', near(Number((await q('select quantity from stock_items where id=$1', [stock.id]))[0].quantity), 48))
  check('customer found-or-created and linked on order and invoice', o1.customer_id === s1.customerId && i1.customer_id === s1.customerId)
  check('cash: tendered 500, change due 290', s1.cashTendered === 500 && near(s1.changeDue, 290))
  check('audit row written', (await q(`select 1 from audit_log where tenant_id=$1 and action='counter_order.created' and entity_id=$2`, [A.tenantId, s1.orderId])).length === 1)

  const s2 = await sell(A, 'cashier', { customerPhone: '+91 98765 43210', method: 'card' })
  check('same phone in another format reuses the one customer', s2.customerId === s1.customerId && (await count('customers', A)) === 1)

  // ── 2. numbering continues with no gaps ──────────────────────────────────
  const num = (s: string) => Number(/(\d+)$/.exec(s)![1])
  check('order, KOT and invoice numbers are consecutive', num(s2.orderNumber) === num(s1.orderNumber) + 1 && num(s2.kotNumber) === num(s1.kotNumber) + 1 && num(s2.invoiceNumber) === num(s1.invoiceNumber) + 1)

  // ── 3. refusals ──────────────────────────────────────────────────────────
  const rest = await attempt(() => sell(R))
  check('restaurant tenant is refused with a clear message', !rest.ok && /restaurant/i.test(rest.msg) && (await count('orders', R)) === 0)
  const kitchen = await attempt(() => sell(A, 'kitchen_staff'))
  check('role without walk-in permission is refused', !kitchen.ok && /permission/i.test(kitchen.msg))
  await q(`delete from tenant_subscriptions where tenant_id=$1`, [A.tenantId])
  const noPlan = await attempt(() => sell(A))
  check('tenant without the module is refused server-side', !noPlan.ok && /plan/i.test(noPlan.msg))
  await entitleTenant(ownerPool, A.tenantId)
  check('bad phone refused', !(await attempt(() => sell(A, 'cashier', { customerPhone: '123' }))).ok)
  check('empty cart refused', !(await attempt(() => sell(A, 'cashier', { items: [] }))).ok)
  check('cash below the total refused', !(await attempt(() => sell(A, 'cashier', { method: 'cash', cashTendered: 100 }))).ok)
  check('cash without a tendered amount refused', !(await attempt(() => sell(A, 'cashier', { method: 'cash' }))).ok)
  check('wallet is not a counter tender', !(await attempt(() => sell(A, 'cashier', { method: 'wallet' as never }))).ok)

  // ── 4. all or nothing: every refusal above left nothing behind ───────────
  check('failed sales left no orders / invoices / payments / KOTs beyond the two good sales', (await count('orders', A)) === 2 && (await count('invoices', A)) === 2 && (await count('payments', A)) === 2 && (await count('kots', A)) === 2)
  const s3 = await sell(A)
  check('...and rolled-back sales burned no numbers', num(s3.orderNumber) === num(s2.orderNumber) + 1 && num(s3.invoiceNumber) === num(s2.invoiceNumber) + 1 && num(s3.kotNumber) === num(s2.kotNumber) + 1)

  // ── 5. idempotency ───────────────────────────────────────────────────────
  const before = { o: await count('orders', A), i: await count('invoices', A), p: await count('payments', A), k: await count('kots', A) }
  const k = `counter-idem-${Date.now()}`
  const first = await sell(A, 'cashier', { idempotencyKey: k, method: 'cash', cashTendered: 300 })
  const retry = await sell(A, 'cashier', { idempotencyKey: k, method: 'cash', cashTendered: 300 })
  check('retry returns the original sale', retry.deduplicated && retry.orderId === first.orderId && retry.invoiceId === first.invoiceId && retry.paymentId === first.paymentId && retry.invoiceNumber === first.invoiceNumber && retry.kotNumber === first.kotNumber && near(retry.changeDue, 90))
  const k2 = `counter-race-${Date.now()}`
  const race = await Promise.all([sell(A, 'cashier', { idempotencyKey: k2 }), sell(A, 'cashier', { idempotencyKey: k2 }), sell(A, 'manager', { idempotencyKey: k2 })])
  check('concurrent double-submit returns one sale', new Set(race.map((r) => r.orderId)).size === 1 && race.filter((r) => !r.deduplicated).length === 1)
  const after = { o: await count('orders', A), i: await count('invoices', A), p: await count('payments', A), k: await count('kots', A) }
  check('two keys → exactly two new of each (no duplicates)', after.o === before.o + 2 && after.i === before.i + 2 && after.p === before.p + 2 && after.k === before.k + 2)

  // ── 6. stays off the takeaway board; counter orders are not takeaway-handled
  const board = await as(A, 'cashier', (tx) => typed.listActiveTypedOrdersCore(tx, A.tenantId, A.branchId))
  check('counter sales never appear on the takeaway board', board.length === 0)
  check('takeaway handover refuses a counter order', !(await attempt(() => as(A, 'cashier', (tx) => typed.handoverTypedOrderCore(tx, { tenantId: A.tenantId, membershipId: A.members.cashier.membershipId }, { orderId: s1.orderId, to: 'collected' })))).ok)

  // ── 6b. membership + promo discounts (ticket 2) ──────────────────────────
  const plan = (await q(`insert into membership_plans (tenant_id,name,price,duration_months,discount_percent,free_hours,wallet_credit) values ($1,'Gold','1000.00',12,'10.00','0','0') returning id`, [A.tenantId]))[0].id
  const promo = async (code: string, type: string, value: string, maxUses: number | null = null) =>
    q(
      `insert into promo_codes (tenant_id,code,discount_type,discount_value,valid_from,valid_until,max_uses) values ($1,$2,$3,$4, now() - interval '1 day', now() + interval '30 days', $5) returning id`,
      [A.tenantId, code, type, value, maxUses],
    )
  const uses = async (code: string) => Number((await q('select uses from promo_codes where tenant_id=$1 and code=$2', [A.tenantId, code]))[0].uses)
  await promo('TEN', 'percentage', '10.00')
  await q(`insert into loyalty_settings (tenant_id, is_active, points_per_unit, unit_amount) values ($1, true, 1, '10.00') on conflict (tenant_id) do update set is_active=true, points_per_unit=1, unit_amount='10.00'`, [A.tenantId])

  // a member, found by phone — the client never names a customer
  const memberPhone = '9123456780'
  const memberId = (await q(`insert into customers (tenant_id, phone, name) values ($1,$2,'Member') returning id`, [A.tenantId, '+91' + memberPhone]))[0].id as string
  await as(A, 'manager', (tx) => purchaseMembership(tx, { tenantId: A.tenantId, membershipId: A.members.manager.membershipId, timezone: TZ, branchId: A.branchId }, { customerId: memberId, planId: plan, paymentMethod: 'cash' }))
  const cnt = async () => ({ o: await count('orders', A), i: await count('invoices', A), k: await count('kots', A), c: await count('customers', A) })
  const ctxOf = (t: T) => ({ tenantId: t.tenantId, timezone: TZ, membershipId: t.members.cashier.membershipId, role: 'cashier' as const })

  const sm = await sell(A, 'cashier', { customerPhone: memberPhone })
  check('member gets the plan discount: 200 - 10% = 180, +5% GST = 189', sm.customerId === memberId && near(sm.subtotal, 200) && near(sm.membershipDiscount, 20) && sm.membershipPlanName === 'Gold' && near(sm.total, 189))
  const smi = (await q('select * from invoices where id=$1', [sm.invoiceId]))[0]
  const paid = (await q('select coalesce(sum(amount),0)::float s from payments where invoice_id=$1', [sm.invoiceId]))[0].s
  check('invoice freezes the membership snapshot and total = sum of payments', near(Number(smi.membership_discount), 20) && Number(smi.membership_discount_percent) === 10 && smi.membership_plan_name === 'Gold' && near(Number(smi.discount), 20) && near(paid, 189))
  check('loyalty points earned on the discounted spend (counter sales earn like any paid invoice)', Number(smi.loyalty_points_earned) === 18)

  const stack = await sell(A, 'cashier', { customerPhone: memberPhone, promoCode: ' ten ' })
  const sti = (await q('select * from invoices where id=$1', [stack.invoiceId]))[0]
  const br = (sti.tax_breakup as { cgst: string; sgst: string }[]).reduce((n, g) => n + Number(g.cgst) + Number(g.sgst), 0)
  check('promo stacks on what remains: 200 - 20 - 18 = 162, GST 8.10, total 170.10', near(stack.promoDiscount, 18) && near(Number(sti.discount), 38) && near(Number(sti.tax_total), 8.1) && near(br, 8.1) && near(stack.total, 170.1) && sti.promo_code_id !== null)
  check('promo use recorded once', (await uses('TEN')) === 1)

  const pk = `counter-promo-${Date.now()}`
  const p1 = await sell(A, 'cashier', { customerPhone: memberPhone, promoCode: 'TEN', idempotencyKey: pk })
  const p2 = await sell(A, 'cashier', { customerPhone: memberPhone, promoCode: 'TEN', idempotencyKey: pk })
  check('retry replays the sale incl. discounts and burns no second promo use', p2.deduplicated && p2.invoiceId === p1.invoiceId && near(p2.total, p1.total) && near(p2.promoDiscount, 18) && (await uses('TEN')) === 2)
  const pk2 = `counter-promo-race-${Date.now()}`
  await Promise.all([1, 2, 3].map(() => sell(A, 'cashier', { customerPhone: memberPhone, promoCode: 'TEN', idempotencyKey: pk2 })))
  check('concurrent double-submit consumes the promo exactly once', (await uses('TEN')) === 3)

  const plain = await sell(A, 'cashier', { customerPhone: '9000000001', promoCode: 'TEN' })
  check('non-member (other phone) gets only the promo: 200 - 20 = 180 + GST = 189', near(plain.membershipDiscount, 0) && plain.membershipPlanName === null && near(plain.promoDiscount, 20) && near(plain.total, 189))

  await promo('GONE', 'percentage', '10.00', 1)
  await q(`update promo_codes set uses=1 where tenant_id=$1 and code='GONE'`, [A.tenantId])
  await q(`insert into promo_codes (tenant_id,code,discount_type,discount_value,valid_from,valid_until) values ($1,'OLD','percentage','10.00', now() - interval '10 days', now() - interval '1 day')`, [A.tenantId])
  await promo('OFF', 'percentage', '10.00')
  await q(`update promo_codes set is_active=false where tenant_id=$1 and code='OFF'`, [A.tenantId])
  const c0 = await cnt()
  const bad: [string, RegExp][] = [['NOPE', /not found/i], ['GONE', /limit/i], ['OLD', /expired/i], ['OFF', /inactive/i]]
  for (const [code, re] of bad) {
    const r = await attempt(() => sell(A, 'cashier', { customerPhone: '9000000002', promoCode: code }))
    check(`${code}: refused with a clear message`, !r.ok && re.test(r.msg))
  }
  const c1 = await cnt()
  check('...and no order, KOT, invoice or customer was created', c1.o === c0.o && c1.i === c0.i && c1.k === c0.k && c1.c === c0.c && (await uses('GONE')) === 1)

  // preview: server-computed, identical to what is then charged, writes nothing
  await promo('PV', 'percentage', '10.00')
  // The signal must be caught OUTSIDE the transaction (as the server action does) so it rolls back.
  const previewOf = async (t: T, phone: string, qty: number, promoCode?: string) => {
    try {
      await as(t, 'cashier', (tx) => counter.previewCounterOrderCore(tx, ctxOf(t), { branchId: t.branchId, items: [{ menuItemId: t.fries, qty }], customerPhone: phone, promoCode }))
    } catch (e) {
      if (e instanceof counter.CounterPreviewResult) return e.preview
      throw e
    }
    throw new Error('preview did not signal')
  }
  const before2 = await cnt()
  const prev = await previewOf(A, memberPhone, 2, 'PV')
  const after2 = await cnt()
  check('preview rolls everything back (no order/KOT/invoice, promo use untouched)', after2.o === before2.o && after2.i === before2.i && after2.k === before2.k && (await uses('PV')) === 0)
  const real = await sell(A, 'cashier', { customerPhone: memberPhone, promoCode: 'PV' })
  check('preview total equals the total then charged', near(prev.total, real.total) && near(prev.membershipDiscount, 20) && near(prev.promoDiscount, 18))
  const pvNew = await previewOf(A, '9000000077', 1)
  check('preview for a new phone prices without creating the customer', near(pvNew.total, 105) && (await count('customers', A)) === after2.c)
  check('preview is refused for a restaurant', !(await attempt(() => previewOf(R, '9000000077', 1))).ok)

  // a promo that clears the whole bill: settled on issue, no payment row, still one sale
  await promo('FREE', 'percentage', '100.00')
  const fk = `counter-free-${Date.now()}`
  const free = await sell(A, 'cashier', { customerPhone: '9000000003', promoCode: 'FREE', idempotencyKey: fk })
  const fi = (await q('select * from invoices where id=$1', [free.invoiceId]))[0]
  const free2 = await sell(A, 'cashier', { customerPhone: '9000000003', promoCode: 'FREE', idempotencyKey: fk })
  const freePays = (await q('select count(*)::int c from payments where invoice_id=$1', [free.invoiceId]))[0].c
  check('100% promo: total 0, invoice paid on issue, no payment row, retry replays', near(free.total, 0) && fi.status === 'paid' && free.paymentId === null && freePays === 0 && free2.deduplicated && free2.invoiceId === free.invoiceId && (await uses('FREE')) === 1)

  // regression: callers that pass no options (takeaway, online pay-now) are untouched
  const reg = await as(A, 'cashier', async (tx) => {
    const o = await createOrderCore(tx, { tenantId: A.tenantId, timezone: TZ, membershipId: A.members.cashier.membershipId }, { branchId: A.branchId, customerId: memberId, items: [{ menuItemId: A.fries, qty: 2 }] })
    return issueInvoiceForOrder(tx, { id: A.tenantId, timezone: TZ }, { id: o.id, branchId: A.branchId, customerId: memberId, orderNumber: o.orderNumber })
  })
  const ri = (await q('select * from invoices where id=$1', [reg.invoiceId]))[0]
  check('no options: a member is NOT discounted (200 + GST = 210), snapshot columns stay default, left issued', reg.discounts === null && near(reg.pricing.total, 210) && Number(ri.discount) === 0 && Number(ri.membership_discount) === 0 && ri.customer_membership_id === null && ri.promo_code_id === null && ri.status === 'issued')

  // ── 6c. Bookings page data: visibility gate + Counter sales list (ticket 3) ─
  const data = await import('../lib/orders/counter-data')
  const fakeCtx = (t: T, role: Role, industry: string) =>
    ({ user: { id: t.members[role].userId }, tenant: { id: t.tenantId, industry, timezone: TZ, currency: 'INR', name: 'T' }, role, membershipId: t.members[role].membershipId }) as never
  check('button offered: non-restaurant + walk-in role + plan', (await data.counterOrdersAvailable(fakeCtx(A, 'cashier', 'gaming_cafe'))) === true)
  check('button hidden: restaurant tenant', (await data.counterOrdersAvailable(fakeCtx(R, 'manager', 'restaurant'))) === false)
  check('button hidden: role without walk-in permission', (await data.counterOrdersAvailable(fakeCtx(A, 'kitchen_staff', 'gaming_cafe'))) === false)
  await q(`delete from tenant_subscriptions where tenant_id=$1`, [A.tenantId])
  check('button hidden: plan without the module', (await data.counterOrdersAvailable(fakeCtx(A, 'cashier', 'gaming_cafe'))) === false)
  await entitleTenant(ownerPool, A.tenantId)

  // a booking-attached order (dine_in) and another tenant's counter sale must never appear
  const bookingOrder = await as(A, 'cashier', (tx) => createOrderCore(tx, { tenantId: A.tenantId, timezone: TZ, membershipId: A.members.cashier.membershipId }, { branchId: A.branchId, items: [{ menuItemId: A.fries, qty: 1 }] }))
  const otherSale = await sell(B, 'cashier')
  const list = await data.listCounterSales(fakeCtx(A, 'cashier', 'gaming_cafe'), A.branchId, 7)
  const listedOrders = new Set(list.map((r) => r.orderId))
  const counterOrdersInDb = (await q(`select id from orders where tenant_id=$1 and order_type='counter'`, [A.tenantId])).map((r) => r.id as string)
  check('list = exactly this tenant\'s counter sales (none booking/dine-in, none from another tenant)', list.length === counterOrdersInDb.length && counterOrdersInDb.every((id) => listedOrders.has(id)) && !listedOrders.has(bookingOrder.id) && !listedOrders.has(otherSale.orderId))
  const row = list.find((r) => r.orderId === sm.orderId)!
  check('row carries number, customer, total, method and status', row.invoiceNumber === sm.invoiceNumber && row.customerPhone !== null && near(Number(row.total), 189) && row.method === 'upi' && row.status === 'paid')
  check('list is newest first', list.every((r, i) => i === 0 || list[i - 1].createdAt >= r.createdAt))
  check('a window of 1 day still includes today\'s sales', (await data.listCounterSales(fakeCtx(A, 'cashier', 'gaming_cafe'), A.branchId, 1)).length === list.length)
  const menu = await data.loadCounterMenu(fakeCtx(A, 'cashier', 'gaming_cafe'), A.branchId)
  check('counter menu offers this tenant\'s available items', menu.menuItems.some((m) => m.id === A.fries) && menu.categories.length > 0)

  // ── 6d. corrections: refund → void → edit → re-bill (ticket 4) ────────────
  const refunds = await import('../lib/billing/refunds')
  const actor = (t: T, role: Role) => ({ tenantId: t.tenantId, membershipId: t.members[role].membershipId, role })
  const cctx = (t: T, role: Role) => ({ tenantId: t.tenantId, timezone: TZ, membershipId: t.members[role].membershipId, role })
  const stockQty = async () => Number((await q('select quantity from stock_items where id=$1', [stock.id]))[0].quantity)
  const points = async (customerId: string) => Number((await q('select coalesce(sum(points),0)::int p from loyalty_transactions where customer_id=$1', [customerId]))[0].p)
  const auditCount = async (action: string, entityId: string) => Number((await q('select count(*)::int c from audit_log where tenant_id=$1 and action=$2 and entity_id=$3', [A.tenantId, action, entityId]))[0].c)
  await promo('FIX', 'percentage', '10.00')

  const fixPhone = '9111111111'
  const orig = await sell(A, 'cashier', { customerPhone: fixPhone, promoCode: 'FIX', method: 'cash', cashTendered: 500 })
  check('setup: 200 - 10% promo + GST = 189, promo used once, 18 points earned', near(orig.total, 189) && (await uses('FIX')) === 1 && (await points(orig.customerId)) === 18)
  const stockAfterSale = await stockQty()
  const kotBefore = (await q('select status from kots where order_id=$1', [orig.orderId]))[0].status

  const asCashier = await attempt(() => as(A, 'cashier', (tx) => counter.voidCounterSaleCore(tx, actor(A, 'cashier'), { orderId: orig.orderId, reason: 'wrong bill' })))
  check('a cashier cannot void a sale', !asCashier.ok && /manager/i.test(asCashier.msg))
  const rawRefund = await attempt(() => as(A, 'cashier', (tx) => refunds.recordRefund(tx, { tenantId: A.tenantId, membershipId: A.members.cashier.membershipId }, { paymentId: orig.paymentId!, amount: 10, reason: 'x' })))
  check('...and RLS refuses a cashier refund even calling the core directly', !rawRefund.ok)
  const noReason = await attempt(() => as(A, 'manager', (tx) => counter.voidCounterSaleCore(tx, actor(A, 'manager'), { orderId: orig.orderId, reason: '  ' })))
  check('a reason is required', !noReason.ok && /reason/i.test(noReason.msg))
  const heldGuard = await attempt(() => as(A, 'manager', (tx) => refunds.voidInvoiceRecord(tx, { tenantId: A.tenantId, membershipId: A.members.manager.membershipId }, { invoiceId: orig.invoiceId, reason: 'x' })))
  check('money guard: the invoice cannot be voided while its payment is still held', !heldGuard.ok && /still held/i.test(heldGuard.msg))
  const editBilled = await attempt(async () => {
    const line = (await q('select id from order_items where order_id=$1', [orig.orderId]))[0].id
    return as(A, 'cashier', (tx) => counter.editCounterOrderLineCore(tx, actor(A, 'cashier'), { orderItemId: line, newQty: 1 }))
  })
  check('a billed sale cannot be edited (refund → void → edit → re-bill only)', !editBilled.ok && /billed/i.test(editBilled.msg))
  check('...and the refused attempts changed nothing', (await uses('FIX')) === 1 && (await q('select status from invoices where id=$1', [orig.invoiceId]))[0].status === 'paid')

  const v = await as(A, 'manager', (tx) => counter.voidCounterSaleCore(tx, actor(A, 'manager'), { orderId: orig.orderId, reason: 'rung up wrong' }))
  const oAfter = (await q('select status, invoice_id from orders where id=$1', [orig.orderId]))[0]
  const pAfter = (await q('select status from payments where invoice_id=$1', [orig.invoiceId]))[0]
  check('manager void: refunded in full, invoice void, order open and detached', near(v.refunded, 189) && v.invoiceNumber === orig.invoiceNumber && (await q('select status from invoices where id=$1', [orig.invoiceId]))[0].status === 'void' && pAfter.status === 'refunded' && oAfter.status === 'open' && oAfter.invoice_id === null)
  check('promo use given back once; loyalty earned points reversed', (await uses('FIX')) === 0 && (await points(orig.customerId)) === 0)
  check('stock not released a second time; kitchen ticket untouched', near(await stockQty(), stockAfterSale) && (await q('select status from kots where order_id=$1', [orig.orderId]))[0].status === kotBefore)
  check('every correction is audited (refund, void, detach, counter void)', (await q(`select 1 from audit_log where tenant_id=$1 and entity_id=$2 and action like '%refund%'`, [A.tenantId, orig.paymentId])).length >= 1 && (await auditCount('void_invoice', orig.invoiceId)) === 1 && (await auditCount('counter_order.invoice_cleared', orig.orderId)) === 1 && (await auditCount('counter_order.voided', orig.orderId)) === 1)
  check('voiding twice is refused', !(await attempt(() => as(A, 'manager', (tx) => counter.voidCounterSaleCore(tx, actor(A, 'manager'), { orderId: orig.orderId, reason: 'again' })))).ok)

  // edit the unbilled order: 2 → 1 portion; stock restores the difference, line audited
  const lineId = (await q('select id from order_items where order_id=$1', [orig.orderId]))[0].id as string
  await as(A, 'cashier', (tx) => counter.editCounterOrderLineCore(tx, actor(A, 'cashier'), { orderItemId: lineId, newQty: 1 }))
  check('edit qty on the unbilled order restores stock and is audited', near(await stockQty(), stockAfterSale + 1) && (await auditCount('order_item.edit', lineId)) === 1)
  check('a kitchen-staff role cannot edit', !(await attempt(() => as(A, 'kitchen_staff', (tx) => counter.editCounterOrderLineCore(tx, actor(A, 'kitchen_staff'), { orderItemId: lineId, newQty: 3 })))).ok)

  // re-bill: preview == charge, fresh invoice number, new payment, promo re-applied once
  const rbPreview = await (async () => {
    try {
      await as(A, 'cashier', (tx) => counter.previewRebillCounterOrderCore(tx, cctx(A, 'cashier'), { orderId: orig.orderId, promoCode: 'FIX' }))
    } catch (e) {
      if (e instanceof counter.CounterPreviewResult) return e.preview
      throw e
    }
    throw new Error('no preview')
  })()
  check('re-bill preview: 100 - 10 promo + 5% GST = 94.50, and it burns nothing', near(rbPreview.total, 94.5) && (await uses('FIX')) === 0)
  const rbKey = `counter-rebill-${Date.now()}`
  const rb = await as(A, 'cashier', (tx) => counter.rebillCounterOrderCore(tx, cctx(A, 'cashier'), { orderId: orig.orderId, method: 'cash', cashTendered: 100, promoCode: 'FIX', idempotencyKey: rbKey }))
  check('re-bill: new invoice number, same order, change 5.50', rb.invoiceNumber !== orig.invoiceNumber && rb.invoiceId !== orig.invoiceId && rb.orderId === orig.orderId && near(rb.total, 94.5) && near(rb.changeDue, 5.5))
  const live = await q(`select i.id, i.status from invoices i join invoice_items ii on ii.invoice_id=i.id join order_items oi on oi.id=ii.source_id where oi.order_id=$1 and ii.kind='food' group by i.id, i.status`, [orig.orderId])
  check('old invoice void, exactly one live invoice', live.length === 2 && live.filter((r) => r.status !== 'void').length === 1 && live.find((r) => r.id === rb.invoiceId)?.status === 'paid')
  const net = (await q(`select coalesce(sum(p.amount) filter (where p.status='captured'),0)::float c from payments p join invoices i on i.id=p.invoice_id join invoice_items ii on ii.invoice_id=i.id join order_items oi on oi.id=ii.source_id where oi.order_id=$1`, [orig.orderId]))[0].c
  check('payments held now net to the new total only', near(net, 94.5))
  check('promo re-applied once; points re-earned once (9)', (await uses('FIX')) === 1 && (await points(orig.customerId)) === 9)
  check('stock unchanged by the re-bill (no second deduction)', near(await stockQty(), stockAfterSale + 1))
  check('order is billed and linked to the new invoice', (await q('select status, invoice_id from orders where id=$1', [orig.orderId]))[0].invoice_id === rb.invoiceId)
  const rbAgain = await as(A, 'cashier', (tx) => counter.rebillCounterOrderCore(tx, cctx(A, 'cashier'), { orderId: orig.orderId, method: 'cash', cashTendered: 100, promoCode: 'FIX', idempotencyKey: rbKey }))
  check('retrying the re-bill replays it: no second invoice, payment or promo use', rbAgain.deduplicated && rbAgain.invoiceId === rb.invoiceId && (await uses('FIX')) === 1)
  check('a second re-bill (new key) is refused while billed', !(await attempt(() => as(A, 'cashier', (tx) => counter.rebillCounterOrderCore(tx, cctx(A, 'cashier'), { orderId: orig.orderId, method: 'upi', idempotencyKey: `other-key-${Date.now()}` })))).ok)
  check('re-billed order is again a listed counter sale at the new total', (await data.listCounterSales(fakeCtx(A, 'cashier', 'gaming_cafe'), A.branchId, 7)).some((r) => r.orderId === orig.orderId && r.invoiceNumber === rb.invoiceNumber && near(Number(r.total), 94.5)))

  // a re-bill that fails (cash short) leaves the order unbilled and burns nothing
  const sFail = await sell(A, 'cashier', { customerPhone: '9222222222' })
  await as(A, 'manager', (tx) => counter.voidCounterSaleCore(tx, actor(A, 'manager'), { orderId: sFail.orderId, reason: 'test' }))
  const usesBefore = await uses('FIX')
  const failed = await attempt(() => as(A, 'cashier', (tx) => counter.rebillCounterOrderCore(tx, cctx(A, 'cashier'), { orderId: sFail.orderId, method: 'cash', cashTendered: 1, promoCode: 'FIX', idempotencyKey: `fail-key-${Date.now()}` })))
  check('failed re-bill (cash short): still unbilled, promo not burned', !failed.ok && (await q('select status, invoice_id from orders where id=$1', [sFail.orderId]))[0].invoice_id === null && (await uses('FIX')) === usesBefore)
  const listed = await data.listCounterSales(fakeCtx(A, 'cashier', 'gaming_cafe'), A.branchId, 7)
  check('a voided, not-yet-re-billed sale stays in the list as "rebill"', listed.find((r) => r.orderId === sFail.orderId)?.status === 'rebill')

  // removing the last line cancels the order (nothing left to re-bill)
  const sGone = await sell(A, 'cashier', { customerPhone: '9333333333' })
  await as(A, 'manager', (tx) => counter.voidCounterSaleCore(tx, actor(A, 'manager'), { orderId: sGone.orderId, reason: 'test' }))
  const goneLine = (await q('select id from order_items where order_id=$1', [sGone.orderId]))[0].id as string
  await as(A, 'cashier', (tx) => counter.editCounterOrderLineCore(tx, actor(A, 'cashier'), { orderItemId: goneLine, newQty: 0 }))
  check('removing the last line cancels the order', (await q('select status from orders where id=$1', [sGone.orderId]))[0].status === 'cancelled')
  check('...and its kitchen ticket', (await q('select status from kots where order_id=$1', [sGone.orderId]))[0].status === 'cancelled')
  const goneRebill = await attempt(() => as(A, 'cashier', (tx) => counter.rebillCounterOrderCore(tx, cctx(A, 'cashier'), { orderId: sGone.orderId, method: 'upi', idempotencyKey: `gone-key-${Date.now()}` })))
  check('...and a re-bill is refused', !goneRebill.ok)

  // REGRESSION: a takeaway order's void behaves exactly as before (stays linked), promo untouched
  await q(`insert into order_settings (tenant_id, takeaway_enabled) values ($1, true) on conflict (tenant_id) do update set takeaway_enabled=true`, [R.tenantId])
  const tk = await as(R, 'cashier', (tx) => typed.createTypedOrderCore(tx, { tenantId: R.tenantId, timezone: TZ, membershipId: R.members.cashier.membershipId }, { branchId: R.branchId, orderType: 'takeaway', contactName: 'T', contactPhone: '9876543210', items: [{ menuItemId: R.fries, qty: 1 }], idempotencyKey: `tk-reg-${Date.now()}` }))
  const tkPaid = await as(R, 'cashier', (tx) => typed.collectTypedOrderPaymentCore(tx, { tenantId: R.tenantId, timezone: TZ, membershipId: R.members.cashier.membershipId }, { orderId: tk.id, method: 'cash' }))
  const tkPay = (await q('select id from payments where invoice_id=$1', [tkPaid.invoiceId]))[0].id as string
  await as(R, 'manager', (tx) => refunds.recordRefund(tx, { tenantId: R.tenantId, membershipId: R.members.manager.membershipId }, { paymentId: tkPay, amount: tkPaid.total, reason: 'reg' }))
  await as(R, 'manager', (tx) => refunds.voidInvoiceRecord(tx, { tenantId: R.tenantId, membershipId: R.members.manager.membershipId }, { invoiceId: tkPaid.invoiceId, reason: 'reg' }))
  const tkAfter = (await q('select status, invoice_id from orders where id=$1', [tk.id]))[0]
  check('regression: takeaway void unchanged (order released to open, invoice link kept, no counter audit)', tkAfter.status === 'open' && tkAfter.invoice_id === tkPaid.invoiceId && (await auditCount('counter_order.invoice_cleared', tk.id)) === 0)
  check('regression: counter code refuses to touch a takeaway order', !(await attempt(() => as(R, 'manager', (tx) => counter.voidCounterSaleCore(tx, actor(R, 'manager'), { orderId: tk.id, reason: 'x' })))).ok)

  // ── 6e. reports reconcile to invoices and payments (ticket 5) ─────────────
  // A fresh tenant so every figure is exact: three live sales (plain, promo, and one
  // that was refunded + voided + re-billed) plus one refunded + voided and never
  // re-billed. Money in must equal what each report shows; voided invoices add nothing.
  const C = await makeTenant('testcounterc', 'gaming_cafe')
  for (const tbl of ['refunds', 'payments', 'invoice_items', 'invoices', 'audit_log', 'kots', 'order_items', 'orders', 'loyalty_transactions', 'customers', 'promo_codes', 'sequences']) await q(`delete from ${tbl} where tenant_id = $1`, [C.tenantId])
  await q(`insert into promo_codes (tenant_id,code,discount_type,discount_value,valid_from,valid_until) values ($1,'TEN','percentage','10.00', now() - interval '1 day', now() + interval '30 days')`, [C.tenantId])
  const payOf = async (invoiceId: string) => (await q('select id from payments where invoice_id=$1 order by created_at limit 1', [invoiceId]))[0].id as string
  const refundAndVoid = async (invoiceId: string, total: number) => {
    const paymentId = await payOf(invoiceId)
    await as(C, 'manager', (tx) => refunds.recordRefund(tx, actor(C, 'manager'), { paymentId, amount: total, reason: 'rpt' }))
    await as(C, 'manager', (tx) => refunds.voidInvoiceRecord(tx, actor(C, 'manager'), { invoiceId, reason: 'rpt' }))
  }
  const cPlain = await sell(C, 'cashier', { customerPhone: '9000000001', method: 'cash', cashTendered: 500 })
  const cPromo = await sell(C, 'cashier', { customerPhone: '9000000002', method: 'upi', promoCode: 'TEN' })
  const cFix = await sell(C, 'cashier', { customerPhone: '9000000003', method: 'card' })
  const cGone = await sell(C, 'cashier', { customerPhone: '9000000004', method: 'upi' })
  await refundAndVoid(cFix.invoiceId, cFix.total)
  const cFixed = await as(C, 'cashier', (tx) => counter.rebillCounterOrderCore(tx, cctx(C, 'cashier'), { orderId: cFix.orderId, method: 'cash', cashTendered: 500, idempotencyKey: `rpt-rebill-${Date.now()}` }))
  await refundAndVoid(cGone.invoiceId, cGone.total)
  check('setup: plain 210 and promo 189 sales', near(cPlain.total, 210) && near(cPromo.total, 189))

  // Independent truth straight from the tables (as the owner), local day in the tenant timezone.
  const day = async (offset: number) => (await q(`select ((now() at time zone $1)::date + $2::int)::text d`, [TZ, offset]))[0].d as string
  const today = await day(0)
  const rptRange = { start: await day(-1), end: await day(1) } as never
  const liveInv = await q(`select total, discount, tax_total, booking_id from invoices where tenant_id=$1 and status <> 'void'`, [C.tenantId])
  const liveTotal = liveInv.reduce((n, r) => n + Number(r.total), 0)
  const liveTax = liveInv.reduce((n, r) => n + Number(r.tax_total), 0)
  const liveDisc = liveInv.reduce((n, r) => n + Number(r.discount), 0)
  const inMoney = Number((await q(`select coalesce(sum(p.amount),0) s from payments p join invoices i on i.id=p.invoice_id where p.tenant_id=$1 and i.status<>'void' and p.status in ('captured','refunded')`, [C.tenantId]))[0].s)
  const outMoney = Number((await q(`select coalesce(sum(r.amount),0) s from refunds r join payments p on p.id=r.payment_id join invoices i on i.id=p.invoice_id where r.tenant_id=$1 and i.status<>'void'`, [C.tenantId]))[0].s)
  const voidedWithMoney = Number((await q(`select count(*)::int c from invoices i where i.tenant_id=$1 and i.status='void' and exists (select 1 from payments p where p.invoice_id=i.id)`, [C.tenantId]))[0].c)
  check('setup: 3 live booking-less invoices totalling 609; 2 voided invoices that had money', liveInv.length === 3 && near(liveTotal, 609) && voidedWithMoney === 2 && liveInv.every((r) => r.booking_id === null))
  check('sum of live invoices = sum of money held (payments net of refunds)', near(liveTotal, inMoney - outMoney))

  const rctx = fakeCtx(C, 'manager', 'gaming_cafe')
  const { getDailyRevenue } = await import('../lib/reports/daily-revenue')
  const daily = await getDailyRevenue(rctx, { range: rptRange })
  const sumD = (k: 'net' | 'tax' | 'discount' | 'gross' | 'serviceCharge' | 'foodRevenue' | 'bookingRevenue' | 'membershipRevenue' | 'invoiceCount') => daily.reduce((n, r) => n + r[k], 0)
  check('Revenue & Bookings: net = invoices = payments (609)', near(sumD('net'), liveTotal) && near(sumD('net'), inMoney - outMoney))
  check('...booking-less counter sales are all food revenue, none booking-side', near(sumD('foodRevenue'), liveTotal) && sumD('bookingRevenue') === 0 && sumD('membershipRevenue') === 0)
  check('...tax and discount match the live invoices; voided ones drop out', near(sumD('tax'), liveTax) && near(sumD('discount'), liveDisc) && near(sumD('gross') - sumD('discount') + sumD('tax') + sumD('serviceCharge'), liveTotal))
  check('...3 invoices counted; booking-less sales sit in the reserved channel, no third bucket', sumD('invoiceCount') === 3 && daily.every((r) => r.channel === 'reserved'))
  check('...reported on the sale date in the tenant timezone', daily.length === 1 && daily[0].day === today)
  check('...walk-in channel filter excludes them', (await getDailyRevenue(rctx, { range: rptRange, channel: 'walkin' })).length === 0)
  check('...a range with no sales reports nothing', (await getDailyRevenue(rctx, { range: { start: '2000-01-01', end: '2000-01-31' } as never })).length === 0)

  const { getPnlReport } = await import('../lib/reports/pnl')
  const pnl = await getPnlReport(rctx, rptRange)
  check('Profit & Loss: revenue is the counter food (609), same as the daily report', near(pnl.revenue.net, 609) && near(pnl.revenue.foodRevenue, 609) && near(pnl.revenue.tax, liveTax) && pnl.revenue.invoiceCount === 3)

  const { getSalesReport } = await import('../lib/reports/sales')
  const salesRpt = await getSalesReport(rctx, { range: rptRange })
  const foodGross = salesRpt.food.reduce((n, r) => n + r.grossRevenue, 0)
  const foodQty = salesRpt.food.reduce((n, r) => n + r.quantity, 0)
  check('Food report: Fries gross 609 over 6 plates (voided plates not counted), equal to the revenue report', near(foodGross, 609) && foodQty === 6 && near(foodGross, sumD('foodRevenue')))

  // Cash / UPI / card: what the till holds per tender, net of refunds, sums to the live total.
  const byMethod = await q(`select p.method::text m, sum(p.amount - coalesce((select sum(r.amount) from refunds r where r.payment_id=p.id),0)) s from payments p join invoices i on i.id=p.invoice_id where p.tenant_id=$1 and i.status<>'void' and p.status in ('captured','refunded') group by 1`, [C.tenantId])
  const m = Object.fromEntries(byMethod.map((r) => [r.m as string, Number(r.s)]))
  check('cash / UPI / card split sums to the total: cash 420 (plain + re-bill), upi 189, no card', near(byMethod.reduce((n, r) => n + Number(r.s), 0), 609) && near(m.cash, 420) && near(m.upi, 189) && !m.card)
  check('re-billed sale: new invoice, old one void', cFixed.invoiceId !== cFix.invoiceId && (await q('select status from invoices where id=$1', [cFix.invoiceId]))[0].status === 'void')

  // ── 7. RLS: another tenant's user cannot see these sales ─────────────────
  const seen = await as(R, 'owner', (tx) => tx.execute(sql`select id from orders where id=${s1.orderId}`))
  check('arena_app + RLS: other tenant sees nothing', seen.rows.length === 0)

  console.log(`\n${pass} passed, ${fail} failed`)
  await ownerPool.end()
  await appPool.end()
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
