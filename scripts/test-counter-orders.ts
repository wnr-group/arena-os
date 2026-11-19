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
  const ids = [A.tenantId, R.tenantId]
  for (const tbl of ['menu_item_ingredients', 'stock_movements', 'stock_items', 'payments', 'invoice_items', 'invoices', 'audit_log', 'kots', 'order_items', 'orders', 'customers', 'sequences']) await q(`delete from ${tbl} where tenant_id = any($1)`, [ids])

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
