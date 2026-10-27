/**
 * Food cost (M20 / AROS-180) against a real database: ingredient unit cost,
 * modifier-option ingredients (deducted AND costed with the dish), per-dish
 * cost / food-cost %, and the restaurant report's food-cost section.
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs scripts/test-food-cost.ts
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
const near = (a: number | null, b: number, eps = 0.011) => a !== null && Math.abs(a - b) <= eps
const TZ = 'Asia/Kolkata'
const ROLES = ['owner', 'manager', 'cashier', 'kitchen_staff'] as const
type Role = (typeof ROLES)[number]

async function main() {
  loadEnv()
  const inv = await import('../lib/inventory/service')
  const { deductStockForOrders } = await import('../lib/inventory/deduct')
  const data = await import('../lib/inventory/data')
  const { buildFoodCostRows } = await import('../lib/inventory/rules')
  const booking = await import('../lib/booking/service')
  const { createOrderCore } = await import('../lib/orders/service')
  const { issueInvoiceForBooking } = await import('../lib/billing/invoice')
  const rep = await import('../lib/reports/restaurant')
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
    const b = await q(
      `insert into branches (tenant_id,name,is_primary) values ($1,'Main',true)
       on conflict (tenant_id,name) do update set is_primary=true returning id`,
      [tenantId],
    )
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
    const menu: Record<string, string> = {}
    for (const [name, price] of [['Pizza', '300'], ['Cola', '50'], ['Salad', '150']]) {
      const r = await q(`insert into menu_items (tenant_id,category_id,name,price) values ($1,$2,$3,$4) returning id`, [tenantId, cat[0].id, name, price])
      menu[name] = r[0].id
    }
    const grp = await q(`insert into modifier_groups (tenant_id,name,min_select,max_select) values ($1,'Toppings',0,3) returning id`, [tenantId])
    const opts: Record<string, string> = {}
    for (const [name, delta] of [['Extra cheese', '20'], ['Lemon', '0']]) {
      const r = await q(`insert into modifier_options (tenant_id,group_id,name,price_delta) values ($1,$2,$3,$4) returning id`, [tenantId, grp[0].id, name, delta])
      opts[name] = r[0].id
    }
    await q(`insert into menu_item_modifier_groups (tenant_id,menu_item_id,group_id,sort_order) values ($1,$2,$3,0),($1,$4,$3,0)`, [tenantId, menu.Pizza, grp[0].id, menu.Cola])
    const rt = await q(`insert into resource_types (tenant_id,name,hourly_rate) values ($1,'Table','0') on conflict (tenant_id,name) do update set hourly_rate='0' returning id`, [tenantId])
    const tables: string[] = []
    for (const name of ['T1', 'T2', 'T3', 'T4']) {
      const r = await q(`insert into resources (tenant_id,branch_id,resource_type_id,name,sort_order) values ($1,$2,$3,$4,$5) on conflict (tenant_id,name) do update set status='available' returning id`, [tenantId, b[0].id, rt[0].id, name, Number(name.slice(1))])
      tables.push(r[0].id)
    }
    await entitleTenant(ownerPool, tenantId)
    return { tenantId, branchId: b[0].id as string, members, menu, opts, tables }
  }
  type T = Awaited<ReturnType<typeof makeTenant>>

  async function attempt<R>(fn: () => Promise<R>) {
    try {
      return { ok: true as const, v: await fn() }
    } catch (e) {
      const cause = (e as { cause?: { code?: string } }).cause
      const raw = e as { code?: string }
      return { ok: false as const, msg: e instanceof Error ? e.message : String(e), code: cause?.code ?? raw.code }
    }
  }
  const as = <R>(t: T, role: Role, fn: (tx: Db) => Promise<R>) => withUser(t.members[role].userId, fn)
  const act = (t: T, role: Role = 'manager') => ({ tenantId: t.tenantId, membershipId: t.members[role].membershipId })
  const ctx = (t: T, role: Role = 'cashier') => ({ tenantId: t.tenantId, timezone: TZ, membershipId: t.members[role].membershipId })
  const cx = (t: T, role: Role = 'manager') =>
    ({ user: { id: t.members[role].userId }, tenant: { id: t.tenantId, industry: 'restaurant', timezone: TZ, currency: 'INR', name: 'T' }, role, membershipId: t.members[role].membershipId }) as never
  const qty = async (id: string) => Number((await q('select quantity from stock_items where id=$1', [id]))[0].quantity)
  const cost = async (id: string) => (await q('select unit_cost from stock_items where id=$1', [id]))[0].unit_cost as string | null
  const orderMoves = (id: string) => q(`select * from stock_movements where stock_item_id=$1 and source_type='order'`, [id])

  async function sell(t: T, table: number, lines: { name: string; qty: number; options?: string[] }[]) {
    await q(`update bookings set status='completed' where resource_id=$1 and status in ('confirmed','checked_in')`, [t.tables[table]])
    const s = await as(t, 'cashier', (tx) => booking.seatTableSessionCore(tx, ctx(t), { branchId: t.branchId, resourceId: t.tables[table], coverCount: 2 }))
    const o = await as(t, 'cashier', (tx) =>
      createOrderCore(tx, ctx(t), {
        branchId: t.branchId,
        bookingId: s.id,
        items: lines.map((l) => ({ menuItemId: t.menu[l.name], qty: l.qty, modifierOptionIds: (l.options ?? []).map((n) => t.opts[n]) })),
      }),
    )
    return { bookingId: s.id, orderId: o.id }
  }
  async function billAndPay(t: T, bookingId: string) {
    const inv = await as(t, 'cashier', (tx) => issueInvoiceForBooking(tx, { id: t.tenantId, timezone: TZ }, { bookingId }))
    const row = (await q('select id, total, branch_id from invoices where booking_id=$1 and status <> $2 limit 1', [bookingId, 'void']))[0]
    await q(`insert into payments (tenant_id,branch_id,invoice_id,method,amount,status) values ($1,$2,$3,'cash',$4,'captured')`, [t.tenantId, row.branch_id, row.id, row.total])
    return inv
  }

  const A = await makeTenant('testfoodcosta')
  const B = await makeTenant('testfoodcostb')
  const ids = [A.tenantId, B.tenantId]
  for (const tbl of ['modifier_option_ingredients', 'menu_item_ingredients', 'stock_movements', 'stock_items', 'payments', 'invoice_items', 'invoices', 'audit_log']) {
    await q(`delete from ${tbl} where tenant_id = any($1)`, [ids])
  }

  // ── 1. ingredient unit cost ───────────────────────────────────────────────
  const cheese = await as(A, 'manager', (tx) => inv.createStockItemCore(tx, act(A), { branchId: A.branchId, name: 'Cheese', unit: 'kg', reorderLevel: 0, openingQuantity: 10, unitCost: 400 }))
  const dough = await as(A, 'manager', (tx) => inv.createStockItemCore(tx, act(A), { branchId: A.branchId, name: 'Dough', unit: 'kg', reorderLevel: 0, openingQuantity: 20 }))
  const lemon = await as(A, 'manager', (tx) => inv.createStockItemCore(tx, act(A), { branchId: A.branchId, name: 'Lemon', unit: 'pcs', reorderLevel: 0, openingQuantity: 100, unitCost: 5 }))
  check('an item can be created with a cost, or without (not costed)', Number(await cost(cheese.id)) === 400 && (await cost(dough.id)) === null)
  const item = (id: string, unitCost?: number | null) => ({ name: id === cheese.id ? 'Cheese' : id === dough.id ? 'Dough' : 'Lemon', unit: id === lemon.id ? 'pcs' : 'kg', reorderLevel: 0, active: true, unitCost })
  await as(A, 'manager', (tx) => inv.updateStockItemCore(tx, act(A), dough.id, item(dough.id, 60)))
  check('cost can be set later', Number(await cost(dough.id)) === 60)
  await as(A, 'manager', (tx) => inv.updateStockItemCore(tx, act(A), dough.id, { ...item(dough.id), name: 'Dough', unit: 'kg' }))
  check('an update that omits the cost leaves it alone (archive/rename must not wipe prices)', Number(await cost(dough.id)) === 60)
  check('negative cost refused', !(await attempt(() => as(A, 'manager', (tx) => inv.updateStockItemCore(tx, act(A), dough.id, item(dough.id, -1))))).ok)
  check('NaN cost refused', !(await attempt(() => as(A, 'manager', (tx) => inv.updateStockItemCore(tx, act(A), dough.id, item(dough.id, NaN))))).ok)
  check('cost changes are audited (old -> new)', (await q(`select 1 from audit_log where entity_id=$1 and action='stock_item.cost_changed' and after->>'unit_cost' = '60'`, [dough.id])).length === 1)
  await as(A, 'manager', (tx) => inv.updateStockItemCore(tx, act(A), dough.id, item(dough.id, 60)))
  check('re-saving the same cost writes no audit noise', (await q(`select 1 from audit_log where entity_id=$1 and action='stock_item.cost_changed'`, [dough.id])).length === 1)
  await as(A, 'manager', (tx) => inv.updateStockItemCore(tx, act(A), dough.id, item(dough.id, null)))
  check('null clears the cost back to "not costed"', (await cost(dough.id)) === null)
  await as(A, 'manager', (tx) => inv.updateStockItemCore(tx, act(A), dough.id, item(dough.id, 60)))

  const direct = await attempt(() => as(A, 'manager', (tx) => tx.execute(sql`update stock_items set unit_cost = 70 where id = ${dough.id}`)))
  check('the app role may set unit_cost (column grant)...', direct.ok && Number(await cost(dough.id)) === 70)
  await as(A, 'manager', (tx) => inv.updateStockItemCore(tx, act(A), dough.id, item(dough.id, 60)))
  const kitchen = await as(A, 'kitchen_staff', (tx) => tx.update(schema.stockItems).set({ unitCost: '1' }).where(sql`id = ${dough.id}`).returning({ id: schema.stockItems.id }))
  check('...but kitchen staff cannot (RLS)', kitchen.length === 0 && Number(await cost(dough.id)) === 60)
  const qtyWrite = await attempt(() => as(A, 'manager', (tx) => tx.execute(sql`update stock_items set quantity = 1 where id = ${dough.id}`)))
  check('and on-hand is still unwritable', !qtyWrite.ok && qtyWrite.code === '42501')

  // ── 2. modifier-option recipes ────────────────────────────────────────────
  await as(A, 'manager', (tx) => inv.setRecipeCore(tx, act(A), A.menu.Pizza, [{ stockItemId: cheese.id, quantity: 0.2 }, { stockItemId: dough.id, quantity: 0.3 }]))
  await as(A, 'manager', (tx) => inv.setModifierRecipeCore(tx, act(A), A.opts['Extra cheese'], [{ stockItemId: cheese.id, quantity: 0.03 }]))
  await as(A, 'manager', (tx) => inv.setModifierRecipeCore(tx, act(A), A.opts.Lemon, [{ stockItemId: lemon.id, quantity: 1 }]))
  check('modifier option recipes are saved', (await q('select count(*)::int c from modifier_option_ingredients where tenant_id=$1', [A.tenantId]))[0].c === 2)
  check('duplicate ingredient refused', !(await attempt(() => as(A, 'manager', (tx) => inv.setModifierRecipeCore(tx, act(A), A.opts.Lemon, [{ stockItemId: lemon.id, quantity: 1 }, { stockItemId: lemon.id, quantity: 2 }])))).ok)
  check('zero quantity refused', !(await attempt(() => as(A, 'manager', (tx) => inv.setModifierRecipeCore(tx, act(A), A.opts.Lemon, [{ stockItemId: lemon.id, quantity: 0 }])))).ok)
  check('unknown option refused', !(await attempt(() => as(A, 'manager', (tx) => inv.setModifierRecipeCore(tx, act(A), '00000000-0000-0000-0000-000000000000', [])))).ok)
  const bStock = await as(B, 'manager', (tx) => inv.createStockItemCore(tx, act(B), { branchId: B.branchId, name: 'B-only', unit: 'kg', reorderLevel: 0 }))
  check("another tenant's stock cannot be used", !(await attempt(() => as(A, 'manager', (tx) => inv.setModifierRecipeCore(tx, act(A), A.opts.Lemon, [{ stockItemId: bStock.id, quantity: 1 }])))).ok)
  check('a failed save leaves the old recipe intact', (await q('select count(*)::int c from modifier_option_ingredients where option_id=$1', [A.opts.Lemon]))[0].c === 1)
  const xTenantOpt = await attempt(() => q(`insert into modifier_option_ingredients (tenant_id,option_id,stock_item_id,quantity) values ($1,$2,$3,1)`, [B.tenantId, A.opts.Lemon, bStock.id]))
  check("DB: an option from another tenant can't be linked (composite FK)", !xTenantOpt.ok && xTenantOpt.code === '23503')
  for (const role of ROLES) {
    const should = role === 'owner' || role === 'manager'
    const r = await attempt(() => as(A, role, (tx) => tx.insert(schema.modifierOptionIngredients).values({ tenantId: A.tenantId, optionId: A.opts['Extra cheese'], stockItemId: dough.id, quantity: '1' }).returning({ id: schema.modifierOptionIngredients.id })))
    check(`${role} ${should ? 'can' : 'cannot'} write a modifier recipe`, should ? r.ok : !r.ok && r.code === '42501')
    if (r.ok) await q('delete from modifier_option_ingredients where option_id=$1 and stock_item_id=$2', [A.opts['Extra cheese'], dough.id])
  }
  check('everyone in the tenant can read them; other tenants cannot', (await as(A, 'kitchen_staff', (tx) => tx.select().from(schema.modifierOptionIngredients))).length === 2 && (await as(B, 'owner', (tx) => tx.select().from(schema.modifierOptionIngredients))).length === 0)

  // ── 3. modifiers are deducted with the dish ───────────────────────────────
  const c0 = await qty(cheese.id)
  const l0 = await qty(lemon.id)
  const sale = await sell(A, 0, [{ name: 'Pizza', qty: 2, options: ['Extra cheese'] }, { name: 'Cola', qty: 3, options: ['Lemon'] }])
  await billAndPay(A, sale.bookingId)
  check('cheese: 2 pizzas × (0.2 + 0.03 extra) = 0.46 off, as ONE movement', near(c0 - (await qty(cheese.id)), 0.46, 0.0005) && (await orderMoves(cheese.id)).length === 1)
  check('lemon: an option on an UNLINKED dish (Cola has no recipe) still deducts: 3 × 1', near(l0 - (await qty(lemon.id)), 3, 0.0005))
  check('dough: only the dish recipe (2 × 0.3)', near(20 - (await qty(dough.id)), 0.6, 0.0005))
  const again = await as(A, 'cashier', (tx) => deductStockForOrders(tx, A.tenantId, [sale.orderId]))
  check('re-running the deduction is a no-op (exactly once, modifiers included)', again.movements === 0 && near(c0 - (await qty(cheese.id)), 0.46, 0.0005))

  const sale2 = await sell(A, 1, [{ name: 'Pizza', qty: 1 }])
  const c1 = await qty(cheese.id)
  await billAndPay(A, sale2.bookingId)
  check('a pizza with no option deducts only the recipe (0.2)', near(c1 - (await qty(cheese.id)), 0.2, 0.0005))

  const sale3 = await sell(A, 2, [{ name: 'Pizza', qty: 1, options: ['Extra cheese'] }])
  await q(`update order_items set void_status='voided' where order_id=$1`, [sale3.orderId])
  const c2 = await qty(cheese.id)
  await as(A, 'cashier', (tx) => deductStockForOrders(tx, A.tenantId, [sale3.orderId]))
  check('a VOIDED line deducts neither the dish nor its modifiers', near(c2 - (await qty(cheese.id)), 0, 0.0005))

  // ── 4. dish cost + food cost % from real rows ─────────────────────────────
  const c = cx(A)
  const [stockCosts, recipes, prices, mods] = await Promise.all([data.listStockCosts(c), data.listRecipeRows(c), data.listMenuPrices(c), data.getModifierCostInputs(c)])
  const rows = buildFoodCostRows({ menu: prices, stock: stockCosts, recipes, options: mods.options, optionRecipes: mods.optionRecipes, menuGroups: mods.menuGroups })
  const pizza = rows.find((r) => r.name === 'Pizza')!
  check('pizza costs 0.2×400 + 0.3×60 = 98 to make', near(pizza.cost, 98) && pizza.complete)
  check('food cost % = 98 / 300 = 32.67', near(pizza.pct, 32.67))
  check('"Extra cheese" shows +12 beside it (0.03 × 400)', pizza.options.some((o) => o.optionName === 'Extra cheese' && near(o.extraCost, 12)))
  check('Cola has no recipe: no cost, no %', rows.find((r) => r.name === 'Cola')!.pct === null && !rows.find((r) => r.name === 'Cola')!.hasRecipe)
  check("Cola's own option (Lemon) still lists its cost (5)", rows.find((r) => r.name === 'Cola')!.options.some((o) => o.optionName === 'Lemon' && near(o.extraCost, 5)))
  await as(A, 'manager', (tx) => inv.updateStockItemCore(tx, act(A), cheese.id, { name: 'Cheese', unit: 'kg', reorderLevel: 0, active: true, unitCost: 500 }))
  const after = buildFoodCostRows({ menu: prices, stock: await data.listStockCosts(c), recipes, options: mods.options, optionRecipes: mods.optionRecipes, menuGroups: mods.menuGroups }).find((r) => r.name === 'Pizza')!
  check('changing an ingredient cost re-prices the dish (0.2×500 + 18 = 118)', near(after.cost, 118))
  await as(A, 'manager', (tx) => inv.updateStockItemCore(tx, act(A), cheese.id, { name: 'Cheese', unit: 'kg', reorderLevel: 0, active: true, unitCost: 400 }))

  // ── 5. the restaurant report's food-cost section ──────────────────────────
  const today = todayInZone(TZ)
  const r = await rep.getRestaurantReport(cx(A), { range: { start: today, end: today } })
  const ing = (n: string) => r.foodCost.ingredients.find((i) => i.name === n)
  check('report: cheese used = 0.46 + 0.2 = 0.66 kg', near(ing('Cheese')?.used ?? null, 0.66, 0.0005))
  check('report: cheese cost = 0.66 × 400 = 264', near(ing('Cheese')?.cost ?? null, 264))
  check('report: dough 0.9 kg × 60 = 54, lemon 3 × 5 = 15', near(ing('Dough')?.cost ?? null, 54) && near(ing('Lemon')?.cost ?? null, 15))
  check('report: cost of ingredients used = 264 + 54 + 15 = 333', near(r.foodCost.cogs, 333))
  check('report: every ingredient is costed', r.foodCost.uncosted === 0)
  check('report: paid food revenue is the Food & Memberships figure', r.foodCost.foodRevenue > 0)
  check('report: food cost % = cost ÷ paid food revenue', near(r.foodCost.pct, (333 / r.foodCost.foodRevenue) * 100, 0.02))
  check('report: dishes with recipes are listed with their %', r.foodCost.dishes.length === 1 && r.foodCost.dishes[0].name === 'Pizza' && near(r.foodCost.dishes[0].pct, 32.67))
  await as(A, 'manager', (tx) => inv.updateStockItemCore(tx, act(A), dough.id, item(dough.id, null)))
  const r2 = await rep.getRestaurantReport(cx(A), { range: { start: today, end: today } })
  check('an ingredient with no cost is flagged, and the total is a floor', r2.foodCost.uncosted === 1 && near(r2.foodCost.cogs, 279) && r2.foodCost.dishes[0].complete === false)
  const y = await rep.getRestaurantReport(cx(A), { range: { start: '2026-01-01', end: '2026-01-02' } })
  check('a range with no sales shows no ingredients and no %', y.foodCost.ingredients.length === 0 && y.foodCost.pct === null && y.foodCost.cogs === 0)
  const rb = await rep.getRestaurantReport(cx(B), { range: { start: today, end: today } })
  check("another tenant's report doesn't include A's ingredients", rb.foodCost.ingredients.length === 0)

  for (const tbl of ['modifier_option_ingredients', 'menu_item_ingredients', 'stock_movements', 'stock_items', 'payments', 'invoice_items', 'invoices', 'audit_log']) {
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
