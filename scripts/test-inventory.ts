/**
 * Inventory (M10 / AROS-97 data model, AROS-98 recipes + auto-deduct) against a
 * real database.
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs scripts/test-inventory.ts
 *
 * Covers: ledger invariants enforced by the DB (append-only, quantity == sum of
 * movements, quantity not writable by the app, tenant-safe FKs), recipes, the
 * deduction through the REAL billing paths (whole + split), exactly-once,
 * unlinked / voided / comped / archived / other-branch rules, never blocking a
 * sale, and RLS per role + tenant.
 */
import { Pool } from 'pg'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { sql } from 'drizzle-orm'
import * as schema from '../db/schema'
import { loadEnv } from './env'

type Db = NodePgDatabase<typeof schema>
let pass = 0,
  fail = 0
const check = (l: string, c: boolean) => {
  console.log(`${c ? '✓' : '✗ FAIL'}  ${l}`)
  if (c) pass++
  else fail++
}
const near = (a: number, b: number) => Math.abs(a - b) < 0.0005
const TZ = 'Asia/Kolkata'
const ROLES = ['owner', 'manager', 'cashier', 'floor_staff', 'kitchen_staff'] as const
type Role = (typeof ROLES)[number]

async function main() {
  loadEnv()
  // @/db opens its pool at import time, so these must load after loadEnv().
  const inv = await import('../lib/inventory/service')
  const { deductStockForOrders } = await import('../lib/inventory/deduct')
  const booking = await import('../lib/booking/service')
  const { createOrderCore } = await import('../lib/orders/service')
  const { issueInvoiceForBooking } = await import('../lib/billing/invoice')
  const { issueSplitBillForBooking } = await import('../lib/billing/split')

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
    const b = await q(
      `insert into branches (tenant_id,name,is_primary) values ($1,'Main',true)
       on conflict (tenant_id,name) do update set is_primary=true returning id`,
      [tenantId],
    )
    const b2 = await q(
      `insert into branches (tenant_id,name,is_primary) values ($1,'Annex',false)
       on conflict (tenant_id,name) do update set name='Annex' returning id`,
      [tenantId],
    )
    const members = {} as Record<Role, { userId: string; membershipId: string }>
    for (const role of ROLES) {
      const u = await q(
        `insert into users (email,password_hash) values ($1,'x') on conflict (email) do update set email=excluded.email returning id`,
        [`${role}@${slug}.test`],
      )
      const m = await q(
        `insert into memberships (tenant_id,user_id,role,status,full_name) values ($1,$2,$3,'active',$4)
         on conflict (tenant_id,user_id) do update set role=$3, status='active', full_name=$4 returning id`,
        [tenantId, u[0].id, role, `${role} person`],
      )
      members[role] = { userId: u[0].id, membershipId: m[0].id }
    }
    const cat = await q(
      `insert into menu_categories (tenant_id,name) values ($1,'Mains') on conflict (tenant_id,name) do update set name=excluded.name returning id`,
      [tenantId],
    )
    const menu: Record<string, string> = {}
    for (const [name, price] of [['Pizza', '300'], ['Salad', '150'], ['Cola', '50']]) {
      const r = await q(`insert into menu_items (tenant_id,category_id,name,price) values ($1,$2,$3,$4) returning id`, [tenantId, cat[0].id, name, price])
      menu[name] = r[0].id
    }
    const rt = await q(
      `insert into resource_types (tenant_id,name,hourly_rate) values ($1,'Table','0')
       on conflict (tenant_id,name) do update set hourly_rate='0' returning id`,
      [tenantId],
    )
    const tables: string[] = []
    for (const name of ['T1', 'T2', 'T3', 'T4', 'T5']) {
      const r = await q(
        `insert into resources (tenant_id,branch_id,resource_type_id,name,sort_order) values ($1,$2,$3,$4,$5)
         on conflict (tenant_id,name) do update set status='available' returning id`,
        [tenantId, b[0].id, rt[0].id, name, Number(name.slice(1))],
      )
      tables.push(r[0].id)
    }
    return { tenantId, branchId: b[0].id as string, annexId: b2[0].id as string, members, menu, tables }
  }
  type T = Awaited<ReturnType<typeof makeTenant>>

  async function attempt<R>(fn: () => Promise<R>) {
    try {
      return { ok: true as const, v: await fn() }
    } catch (e) {
      // Drizzle wraps driver errors (code on .cause); a raw pg call has it on the error itself.
      const cause = (e as { cause?: { code?: string; message?: string } }).cause
      const raw = e as { code?: string; message?: string }
      return { ok: false as const, msg: e instanceof Error ? e.message : String(e), code: cause?.code ?? raw.code, causeMsg: cause?.message ?? raw.message ?? '' }
    }
  }
  const as = <R>(t: T, role: Role, fn: (tx: Db) => Promise<R>) => withUser(t.members[role].userId, fn)
  const act = (t: T, role: Role = 'manager') => ({ tenantId: t.tenantId, membershipId: t.members[role].membershipId })
  const ctx = (t: T, role: Role = 'cashier') => ({ tenantId: t.tenantId, timezone: TZ, membershipId: t.members[role].membershipId })
  const qty = async (id: string) => Number((await q('select quantity from stock_items where id=$1', [id]))[0].quantity)
  const ledger = async (id: string) => Number((await q('select coalesce(sum(delta),0) s from stock_movements where stock_item_id=$1', [id]))[0].s)
  const orderMoves = async (id: string) => q(`select * from stock_movements where stock_item_id=$1 and source_type='order' order by created_at`, [id])

  async function sell(t: T, table: number, lines: { name: string; qty: number }[]) {
    // A billed table stays open until cleaned; free it for the next test party.
    await q(`update bookings set status='completed' where resource_id=$1 and status in ('confirmed','checked_in')`, [t.tables[table]])
    const s = await as(t, 'cashier', (tx) => booking.seatTableSessionCore(tx, ctx(t), { branchId: t.branchId, resourceId: t.tables[table], coverCount: 2 }))
    const o = await as(t, 'cashier', (tx) =>
      createOrderCore(tx, ctx(t), { branchId: t.branchId, bookingId: s.id, items: lines.map((l) => ({ menuItemId: t.menu[l.name], qty: l.qty })) }),
    )
    return { bookingId: s.id, orderId: o.id }
  }
  const bill = (t: T, bookingId: string) => as(t, 'cashier', (tx) => issueInvoiceForBooking(tx, { id: t.tenantId, timezone: TZ }, { bookingId }))

  const A = await makeTenant('testinventorya')
  const B = await makeTenant('testinventoryb')
  const ids = [A.tenantId, B.tenantId]
  await q('delete from menu_item_ingredients where tenant_id = any($1)', [ids])
  await q('delete from stock_movements where tenant_id = any($1)', [ids])
  await q('delete from stock_items where tenant_id = any($1)', [ids])
  await q('delete from invoice_items where tenant_id = any($1)', [ids])
  await q('delete from invoices where tenant_id = any($1)', [ids])

  // ── 1. stock items + the ledger ───────────────────────────────────────────
  const cheese = await as(A, 'manager', (tx) => inv.createStockItemCore(tx, act(A), { branchId: A.branchId, name: 'Cheese', unit: 'kg', reorderLevel: 2, openingQuantity: 10 }))
  const dough = await as(A, 'manager', (tx) => inv.createStockItemCore(tx, act(A), { branchId: A.branchId, name: 'Dough', unit: 'kg', reorderLevel: 0, openingQuantity: 20 }))
  const tomato = await as(A, 'manager', (tx) => inv.createStockItemCore(tx, act(A), { branchId: A.branchId, name: 'Tomato', unit: 'kg', reorderLevel: 1, openingQuantity: 5 }))
  const annexCheese = await as(A, 'manager', (tx) => inv.createStockItemCore(tx, { ...act(A) }, { branchId: A.annexId, name: 'Cheese', unit: 'kg', reorderLevel: 0, openingQuantity: 50 }))
  check('opening stock arrives as a ledger entry, and on-hand equals it', near(await qty(cheese.id), 10) && near(await ledger(cheese.id), 10))
  check('the same name is allowed at another branch, not twice at one', annexCheese.id !== cheese.id && !(await attempt(() => as(A, 'manager', (tx) => inv.createStockItemCore(tx, act(A), { branchId: A.branchId, name: 'Cheese', unit: 'kg', reorderLevel: 0 })))).ok)

  await as(A, 'manager', (tx) => inv.recordMovementCore(tx, act(A), { stockItemId: tomato.id, type: 'purchase', amount: 2.5, reason: 'Delivery' }))
  await as(A, 'manager', (tx) => inv.recordMovementCore(tx, act(A), { stockItemId: tomato.id, type: 'wastage', amount: 0.5 }))
  await as(A, 'manager', (tx) => inv.recordMovementCore(tx, act(A), { stockItemId: tomato.id, type: 'adjustment', amount: -1 }))
  check('purchase +2.5, wastage -0.5, count -1 -> 5 + 1 = 6', near(await qty(tomato.id), 6))
  check('on-hand == sum of movements, always', near(await qty(tomato.id), await ledger(tomato.id)))
  await as(A, 'manager', (tx) => inv.recordMovementCore(tx, act(A), { stockItemId: tomato.id, type: 'adjustment', amount: -1 }))
  await as(A, 'manager', (tx) => inv.recordMovementCore(tx, act(A), { stockItemId: tomato.id, type: 'purchase', amount: 1 }))
  check('a zero movement is refused', !(await attempt(() => as(A, 'manager', (tx) => inv.recordMovementCore(tx, act(A), { stockItemId: tomato.id, type: 'adjustment', amount: 0 })))).ok)
  check('a movement for a missing item is refused', !(await attempt(() => as(A, 'manager', (tx) => inv.recordMovementCore(tx, act(A), { stockItemId: '00000000-0000-0000-0000-000000000000', type: 'purchase', amount: 1 })))).ok)

  // ── 2. what the database refuses, whoever asks ────────────────────────────
  const mv = (await q('select id from stock_movements where stock_item_id=$1 limit 1', [tomato.id]))[0].id
  const upd = await attempt(() => q('update stock_movements set delta = 999 where id=$1', [mv]))
  check('a movement can never be edited — even by the owner role (append-only trigger)', !upd.ok && /append-only/i.test(upd.causeMsg + upd.msg))
  const updApp = await attempt(() => as(A, 'manager', (tx) => tx.execute(sql`update stock_movements set delta = 999 where id = ${mv}`)))
  check('...nor by the app role (no UPDATE grant)', !updApp.ok && updApp.code === '42501')
  const delApp = await attempt(() => as(A, 'manager', (tx) => tx.execute(sql`delete from stock_movements where id = ${mv}`)))
  check('...nor deleted by the app role', !delApp.ok && delApp.code === '42501')
  const setQty = await attempt(() => as(A, 'manager', (tx) => tx.execute(sql`update stock_items set quantity = 9999 where id = ${cheese.id}`)))
  check('on-hand cannot be written directly by the app (column grant)', !setQty.ok && setQty.code === '42501' && near(await qty(cheese.id), 10))
  const richItem = await attempt(() => as(A, 'manager', (tx) => tx.insert(schema.stockItems).values({ tenantId: A.tenantId, branchId: A.branchId, name: 'Rich', quantity: '500' })))
  check('an item cannot be created with stock already in it (must start at 0)', !richItem.ok && richItem.code === '42501')
  const delItem = await attempt(() => as(A, 'manager', (tx) => tx.execute(sql`delete from stock_items where id = ${cheese.id}`)))
  check('stock items cannot be deleted by the app (archive instead)', !delItem.ok && delItem.code === '42501')
  const xTenant = await attempt(() => as(B, 'owner', (tx) => tx.insert(schema.stockMovements).values({ tenantId: B.tenantId, stockItemId: cheese.id, delta: '5', sourceType: 'purchase' })))
  check("a movement cannot point at another tenant's item (composite FK / RLS)", !xTenant.ok)
  const xOwner = await attempt(() => q(`insert into stock_movements (tenant_id,stock_item_id,delta,source_type) values ($1,$2,5,'purchase')`, [B.tenantId, cheese.id]))
  check('...even when inserted as the table owner (composite FK)', !xOwner.ok && xOwner.code === '23503')
  const badType = await attempt(() => q(`insert into stock_movements (tenant_id,stock_item_id,delta,source_type) values ($1,$2,1,'hack')`, [A.tenantId, cheese.id]))
  check('unknown movement source types are refused', !badType.ok && badType.code === '23514')

  // ── 3. recipes ────────────────────────────────────────────────────────────
  await as(A, 'manager', (tx) => inv.setRecipeCore(tx, act(A), A.menu.Pizza, [{ stockItemId: cheese.id, quantity: 0.2 }, { stockItemId: dough.id, quantity: 0.3 }]))
  await as(A, 'manager', (tx) => inv.setRecipeCore(tx, act(A), A.menu.Salad, [{ stockItemId: tomato.id, quantity: 0.1 }, { stockItemId: cheese.id, quantity: 0.05 }]))
  check('recipes are saved', (await q('select count(*)::int c from menu_item_ingredients where tenant_id=$1', [A.tenantId]))[0].c === 4)
  check('listing an ingredient twice is refused', !(await attempt(() => as(A, 'manager', (tx) => inv.setRecipeCore(tx, act(A), A.menu.Cola, [{ stockItemId: cheese.id, quantity: 1 }, { stockItemId: cheese.id, quantity: 2 }])))).ok)
  check('a zero / negative ingredient quantity is refused', !(await attempt(() => as(A, 'manager', (tx) => inv.setRecipeCore(tx, act(A), A.menu.Cola, [{ stockItemId: cheese.id, quantity: 0 }])))).ok)
  const bStock = await as(B, 'manager', (tx) => inv.createStockItemCore(tx, act(B), { branchId: B.branchId, name: 'B-only', unit: 'kg', reorderLevel: 0 }))
  check("an ingredient from another tenant is refused", !(await attempt(() => as(A, 'manager', (tx) => inv.setRecipeCore(tx, act(A), A.menu.Cola, [{ stockItemId: bStock.id, quantity: 1 }])))).ok)
  check('Cola is still unlinked after those refusals', (await q('select count(*)::int c from menu_item_ingredients where menu_item_id=$1', [A.menu.Cola]))[0].c === 0)
  await as(A, 'manager', (tx) => inv.setRecipeCore(tx, act(A), A.menu.Pizza, [{ stockItemId: cheese.id, quantity: 0.2 }, { stockItemId: dough.id, quantity: 0.3 }]))
  check('saving a recipe replaces it (no duplicates)', (await q('select count(*)::int c from menu_item_ingredients where menu_item_id=$1', [A.menu.Pizza]))[0].c === 2)

  // ── 4. a sale deducts, through the real billing path ──────────────────────
  const cheese0 = await qty(cheese.id)
  const sale = await sell(A, 0, [{ name: 'Pizza', qty: 3 }, { name: 'Cola', qty: 2 }, { name: 'Salad', qty: 1 }])
  await bill(A, sale.bookingId)
  check('cheese: 3 pizzas × 0.2 + 1 salad × 0.05 = 0.65 off', near(await qty(cheese.id), cheese0 - 0.65))
  check('dough: 3 × 0.3 = 0.9 off', near(await qty(dough.id), 20 - 0.9))
  check('tomato: 1 × 0.1 off', near(await qty(tomato.id), 6 - 0.1))
  const cm = await orderMoves(cheese.id)
  check('one movement per (item, order), source = the order', cm.length === 1 && cm[0].source_id === sale.orderId && cm[0].source_type === 'order' && near(Number(cm[0].delta), -0.65))
  check('the movement is explained', cm[0].reason === 'Sold')
  check('the unlinked item (Cola) caused no movement of its own', (await q(`select count(*)::int c from stock_movements where tenant_id=$1 and source_type='order'`, [A.tenantId]))[0].c === 3)
  check('on-hand still equals the ledger after the sale', near(await qty(cheese.id), await ledger(cheese.id)) && near(await qty(dough.id), await ledger(dough.id)))

  // exactly once
  const again = await as(A, 'cashier', (tx) => deductStockForOrders(tx, A.tenantId, [sale.orderId]))
  check('re-running the deduction writes nothing (exactly once)', again.movements === 0 && near(await qty(cheese.id), cheese0 - 0.65))
  const both = await as(A, 'cashier', (tx) => deductStockForOrders(tx, A.tenantId, [sale.orderId, sale.orderId]))
  check('...even when the same order is listed twice', both.movements === 0)

  // lines added and billed after the first deduction are topped up, once
  const topC0 = await qty(cheese.id)
  await q(`update order_items set qty = qty + 1 where order_id=$1 and item_name='Pizza'`, [sale.orderId])
  const top = await as(A, 'cashier', (tx) => deductStockForOrders(tx, A.tenantId, [sale.orderId]))
  check('a line added after billing is deducted as a top-up (1 pizza = 0.2 cheese)', top.movements >= 1 && near(await qty(cheese.id), topC0 - 0.2))
  const top2 = await as(A, 'cashier', (tx) => deductStockForOrders(tx, A.tenantId, [sale.orderId]))
  check('...and the top-up is itself exactly once', top2.movements === 0 && near(await qty(cheese.id), topC0 - 0.2))

  // voided / comped lines
  const s2 = await sell(A, 1, [{ name: 'Pizza', qty: 1 }, { name: 'Salad', qty: 1 }])
  await q(`update order_items set void_status='voided' where order_id=$1 and item_name='Salad'`, [s2.orderId])
  const t0 = await qty(tomato.id)
  const c1 = await qty(cheese.id)
  await bill(A, s2.bookingId)
  check('a VOIDED line is not deducted (the salad never left the kitchen)', near(await qty(tomato.id), t0) && near(await qty(cheese.id), c1 - 0.2))
  const s3 = await sell(A, 2, [{ name: 'Pizza', qty: 1 }, { name: 'Cola', qty: 1 }])
  await q(`update order_items set void_status='comped' where order_id=$1 and item_name='Pizza'`, [s3.orderId])
  const d1 = await qty(dough.id)
  await bill(A, s3.bookingId)
  check('a COMPED line is deducted (it was cooked and eaten)', near(await qty(dough.id), d1 - 0.3))

  // never blocks a sale: stock goes negative
  const s4 = await sell(A, 3, [{ name: 'Salad', qty: 80 }])
  const inv4 = await attempt(() => bill(A, s4.bookingId))
  check('a sale is never blocked by low stock — the bill is issued', inv4.ok)
  check('...stock simply goes negative (8 kg of tomato from ~5.8)', (await qty(tomato.id)) < 0 && near(await qty(tomato.id), await ledger(tomato.id)))

  // branch + archived scoping
  await as(A, 'manager', (tx) => inv.setRecipeCore(tx, act(A), A.menu.Pizza, [{ stockItemId: cheese.id, quantity: 0.2 }, { stockItemId: annexCheese.id, quantity: 9 }, { stockItemId: dough.id, quantity: 0.3 }]))
  await as(A, 'manager', (tx) => inv.updateStockItemCore(tx, act(A), dough.id, { name: 'Dough', unit: 'kg', reorderLevel: 0, active: false }))
  const s5 = await sell(A, 4, [{ name: 'Pizza', qty: 1 }])
  const ac0 = await qty(annexCheese.id)
  const dd0 = await qty(dough.id)
  const ch0 = await qty(cheese.id)
  await bill(A, s5.bookingId)
  check("stock at ANOTHER branch is never touched by this branch's sale", near(await qty(annexCheese.id), ac0))
  check('an ARCHIVED stock item is skipped', near(await qty(dough.id), dd0))
  check('...while the live linked item still deducts', near(await qty(cheese.id), ch0 - 0.2))
  check('an archived item refuses new movements', !(await attempt(() => as(A, 'manager', (tx) => inv.recordMovementCore(tx, act(A), { stockItemId: dough.id, type: 'purchase', amount: 1 })))).ok)
  check('...and cannot be added to a recipe', !(await attempt(() => as(A, 'manager', (tx) => inv.setRecipeCore(tx, act(A), A.menu.Cola, [{ stockItemId: dough.id, quantity: 1 }])))).ok)

  // split bill goes through the same hook, once
  await as(A, 'manager', (tx) => inv.updateStockItemCore(tx, act(A), dough.id, { name: 'Dough', unit: 'kg', reorderLevel: 0, active: true }))
  await as(A, 'manager', (tx) => inv.setRecipeCore(tx, act(A), A.menu.Pizza, [{ stockItemId: cheese.id, quantity: 0.2 }, { stockItemId: dough.id, quantity: 0.3 }]))
  const s6 = await sell(A, 0, [{ name: 'Pizza', qty: 2 }])
  const ch6 = await qty(cheese.id)
  await as(A, 'cashier', (tx) => issueSplitBillForBooking(tx, { id: A.tenantId, timezone: TZ }, { bookingId: s6.bookingId, mode: 'even', checkCount: 2 }))
  check('a SPLIT bill deducts the order once (2 pizzas × 0.2), not once per check', near(await qty(cheese.id), ch6 - 0.4) && (await orderMoves(cheese.id)).filter((m) => m.source_id === s6.orderId).length === 1)

  // a tenant that never uses inventory
  const bs = await sell(B, 0, [{ name: 'Pizza', qty: 2 }])
  const invB = await attempt(() => bill(B, bs.bookingId))
  check('a tenant with no recipes bills as before and writes no movements', invB.ok && (await q(`select count(*)::int c from stock_movements where tenant_id=$1 and source_type='order'`, [B.tenantId]))[0].c === 0)

  // ── 5. RLS ────────────────────────────────────────────────────────────────
  for (const role of ROLES) {
    const items = await as(A, role, (tx) => tx.select().from(schema.stockItems))
    const moves = await as(A, role, (tx) => tx.select().from(schema.stockMovements))
    check(`${role} reads stock + movements, own tenant only`, items.length > 0 && moves.length > 0 && items.every((i) => i.tenantId === A.tenantId) && moves.every((m) => m.tenantId === A.tenantId))
  }
  for (const role of ROLES) {
    const should = role === 'owner' || role === 'manager'
    const r = await attempt(() => as(A, role, (tx) => tx.insert(schema.stockItems).values({ tenantId: A.tenantId, branchId: A.branchId, name: `rls-${role}` }).returning({ id: schema.stockItems.id })))
    check(`${role} ${should ? 'can' : 'cannot'} create a stock item`, should ? r.ok : !r.ok && r.code === '42501')
  }
  for (const role of ROLES) {
    const should = role === 'owner' || role === 'manager'
    const r = await attempt(() => as(A, role, (tx) => tx.insert(schema.stockMovements).values({ tenantId: A.tenantId, stockItemId: cheese.id, delta: '1', sourceType: 'purchase' })))
    check(`${role} ${should ? 'can' : 'cannot'} record a manual stock movement`, should ? r.ok : !r.ok && r.code === '42501')
  }
  const orderMv = (orderId: string | null, delta: string, ten = A.tenantId) => attempt(() => as(A, 'cashier', (tx) => tx.insert(schema.stockMovements).values({ tenantId: ten, stockItemId: cheese.id, delta, sourceType: 'order', sourceId: orderId })))
  const rOrder = await orderMv(sale.orderId, '-1')
  check("a cashier's sale CAN deduct against a real order of the tenant (billing runs as them)", rOrder.ok)
  const rOrphan = await orderMv('11111111-1111-1111-1111-111111111111', '-1')
  check('an order movement with no such order is refused', !rOrphan.ok && rOrphan.code === '23514')
  const rNoSrc = await orderMv(null, '-1')
  check('an order movement with no source is refused', !rNoSrc.ok && rNoSrc.code === '23514')
  const rPlus = await orderMv(sale.orderId, '1000')
  check('a cashier cannot insert a positive order movement beyond what the order took (+1000)', !rPlus.ok && rPlus.code === '23514')
  const tookRow = await q(`select -sum(delta) took from stock_movements where stock_item_id=$1 and source_id=$2 and source_type='order'`, [cheese.id, sale.orderId])
  const giveBack = await orderMv(sale.orderId, String(Number(tookRow[0].took)))
  check('...but may give back exactly what the order took (a restore)', giveBack.ok)
  const giveMore = await orderMv(sale.orderId, '0.001')
  check('...and not a thousandth more', !giveMore.ok && giveMore.code === '23514')
  for (const role of ROLES) {
    const should = role === 'owner' || role === 'manager'
    const r = await attempt(() => as(A, role, (tx) => tx.insert(schema.menuItemIngredients).values({ tenantId: A.tenantId, menuItemId: A.menu.Cola, stockItemId: tomato.id, quantity: '1' }).returning({ id: schema.menuItemIngredients.id })))
    check(`${role} ${should ? 'can' : 'cannot'} write a recipe`, should ? r.ok : !r.ok && r.code === '42501')
    if (r.ok) await q('delete from menu_item_ingredients where menu_item_id=$1', [A.menu.Cola])
  }
  const recipeRead = await as(A, 'kitchen_staff', (tx) => tx.select().from(schema.menuItemIngredients))
  check('kitchen staff can read recipes', recipeRead.length > 0)
  const xRead = await as(B, 'owner', (tx) => tx.select().from(schema.menuItemIngredients))
  check("another tenant cannot read A's recipes", xRead.every((r) => r.tenantId === B.tenantId))
  const xUpd = await as(A, 'owner', (tx) => tx.update(schema.stockItems).set({ name: 'hax' }).where(sql`tenant_id = ${B.tenantId}`).returning({ id: schema.stockItems.id }))
  check("owner of A cannot rename B's stock", xUpd.length === 0)
  const lock = await as(A, 'manager', (tx) => tx.select({ id: schema.stockItems.id }).from(schema.stockItems).where(sql`id = ${cheese.id}`).for('update'))
  check('a manager can lock a stock row (FOR UPDATE matches an UPDATE policy, AROS-183)', lock.length === 1)

  // ── 6. entitlement ────────────────────────────────────────────────────────
  const ent = await q(`select lower(btrim(p.name)) n, pe.value::text v from plan_entitlements pe join plans p on p.id=pe.plan_id where pe.key='module.inventory'`)
  const vOf = (n: string) => ent.find((e) => e.n === n)?.v
  check('module.inventory: Pro and Enterprise on, Starter off', vOf('pro') === 'true' && vOf('enterprise') === 'true' && vOf('starter') === 'false')

  // every item still reconciles
  const all = await q(`select s.id, s.quantity, coalesce(sum(m.delta),0) l from stock_items s left join stock_movements m on m.stock_item_id=s.id where s.tenant_id = any($1) group by s.id`, [ids])
  check('FINAL: every stock item equals the sum of its ledger', all.every((r) => near(Number(r.quantity), Number(r.l))))

  for (const tbl of ['menu_item_ingredients', 'stock_movements', 'stock_items', 'payments', 'invoice_items', 'invoices']) {
    await q(`delete from ${tbl} where tenant_id = any($1)`, [ids])
  }
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
