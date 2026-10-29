/**
 * Tenant-composite FKs + order stock-movement guard (migrations 0175, 0176) against a
 * real database, driven as the app role (arena_app) so RLS and the FKs both apply.
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs scripts/verify-tenant-fk-hardening.ts
 *
 * A member of tenant A points their OWN rows (tenant_id = A, so the RLS check
 * passes) at tenant B's printer / kot / order line / station / branch. A plain
 * single-column FK is checked without RLS and would accept that; every one of
 * these must now be refused with 23503.
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
const TZ = 'Asia/Kolkata'

async function main() {
  loadEnv()
  const ownerPool = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })
  const appPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 })
  const app = drizzle(appPool, { schema })
  const q = async (text: string, params: unknown[] = []) => (await ownerPool.query(text, params)).rows
  const asUser = <T>(userId: string, fn: (tx: Db) => Promise<T>): Promise<T> =>
    app.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`)
      return fn(tx as unknown as Db)
    })
  const code = async (fn: () => Promise<unknown>) => {
    try {
      await fn()
      return 'ok'
    } catch (e) {
      const c = (e as { cause?: { code?: string } }).cause?.code ?? (e as { code?: string }).code
      return c ?? 'error'
    }
  }

  async function tenant(slug: string) {
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
    const u = await q(`insert into users (email,password_hash) values ($1,'x') on conflict (email) do update set email=excluded.email returning id`, [`owner@${slug}.test`])
    const m = await q(
      `insert into memberships (tenant_id,user_id,role,status,full_name) values ($1,$2,'owner','active','Owner')
       on conflict (tenant_id,user_id) do update set role='owner', status='active' returning id`,
      [tenantId, u[0].id],
    )
    const printer = await q(`insert into printers (tenant_id,branch_id,name,kind,secret_hash) values ($1,$2,'P1','kitchen','x') returning id`, [tenantId, b[0].id])
    const station = await q(`insert into kitchen_stations (tenant_id,name) values ($1,'Grill') returning id`, [tenantId])
    const order = await q(`insert into orders (tenant_id,branch_id,order_number,status) values ($1,$2,'O-1','open') returning id`, [tenantId, b[0].id])
    const item = await q(
      `insert into order_items (tenant_id,order_id,item_name,unit_price,qty,line_total) values ($1,$2,'X',10,1,10) returning id`,
      [tenantId, order[0].id],
    )
    const kot = await q(`insert into kots (tenant_id,branch_id,order_id,kot_number) values ($1,$2,$3,'K-1') returning id`, [tenantId, b[0].id, order[0].id])
    const inv = await q(`insert into invoices (tenant_id,branch_id,invoice_number,total) values ($1,$2,'INV-X','1.00') returning id`, [tenantId, b[0].id])
    const cat = await q(`insert into menu_categories (tenant_id,name) values ($1,'C') on conflict (tenant_id,name) do update set name=excluded.name returning id`, [tenantId])
    const menu = await q(`insert into menu_items (tenant_id,category_id,name,price) values ($1,$2,'M','5') returning id`, [tenantId, cat[0].id])
    const stock = await q(`insert into stock_items (tenant_id,branch_id,name,unit) values ($1,$2,'Flour','kg') returning id`, [tenantId, b[0].id])
    return {
      tenantId,
      userId: u[0].id as string,
      branchId: b[0].id as string,
      printerId: printer[0].id as string,
      stationId: station[0].id as string,
      orderId: order[0].id as string,
      itemId: item[0].id as string,
      kotId: kot[0].id as string,
      invoiceId: inv[0].id as string,
      categoryId: cat[0].id as string,
      menuId: menu[0].id as string,
      stockId: stock[0].id as string,
      membershipId: m[0].id as string,
    }
  }

  const slugs = ['verifyfka', 'verifyfkb']
  const old = await q(`select id from tenants where slug = any($1)`, [slugs])
  for (const o of old) {
    for (const t of ['stock_movements', 'print_jobs', 'kot_items', 'kots', 'invoices', 'order_items', 'orders', 'menu_items', 'menu_categories', 'stock_items']) {
      await q(`delete from ${t} where tenant_id = $1`, [o.id])
    }
    await q(`delete from tenants where id = $1`, [o.id])
  }
  const A = await tenant(slugs[0])
  const B = await tenant(slugs[1])

  const bytes = Buffer.from('x')
  const asA = <T>(fn: (tx: Db) => Promise<T>) => asUser(A.userId, fn)

  // ── print_jobs ────────────────────────────────────────────────────────────
  const pj = (o: { printer?: string; kot?: string | null; inv?: string | null; branch?: string }) =>
    code(() =>
      asA((tx) =>
        tx.execute(sql`insert into print_jobs (tenant_id,branch_id,printer_id,kind,title,kot_id,invoice_id,payload)
                       values (${A.tenantId}, ${o.branch ?? A.branchId}, ${o.printer ?? A.printerId}, 'test', 't', ${o.kot ?? null}, ${o.inv ?? null}, ${bytes})`),
      ),
    )
  check('print_jobs: own printer/kot/invoice is accepted', (await pj({ kot: A.kotId, inv: A.invoiceId })) === 'ok')
  check("print_jobs: another tenant's PRINTER is refused", (await pj({ printer: B.printerId })) === '23503')
  check("print_jobs: another tenant's KOT is refused", (await pj({ kot: B.kotId })) === '23503')
  check("print_jobs: another tenant's INVOICE is refused", (await pj({ inv: B.invoiceId })) === '23503')
  check("print_jobs: another tenant's BRANCH is refused", (await pj({ branch: B.branchId })) === '23503')

  // ── kot_items ─────────────────────────────────────────────────────────────
  const ki = (kot: string, item: string) => code(() => asA((tx) => tx.execute(sql`insert into kot_items (tenant_id,kot_id,order_item_id) values (${A.tenantId}, ${kot}, ${item})`)))
  check("kot_items: another tenant's ORDER LINE is refused", (await ki(A.kotId, B.itemId)) === '23503')
  check("kot_items: another tenant's KOT is refused", (await ki(B.kotId, A.itemId)) === '23503')
  check('kot_items: own kot + line is accepted', (await ki(A.kotId, A.itemId)) === 'ok')
  check("...and B's line was not bumped by any of that", (await q(`select 1 from kot_items where order_item_id=$1`, [B.itemId])).length === 0)

  // ── station references ────────────────────────────────────────────────────
  const setStation = (table: string, id: string, station: string) => code(() => asA((tx) => tx.execute(sql.raw(`update ${table} set station_id = '${station}' where id = '${id}' and tenant_id = '${A.tenantId}'`))))
  check("menu_items.station_id: another tenant's station is refused", (await setStation('menu_items', A.menuId, B.stationId)) === '23503')
  check("menu_categories.station_id: another tenant's station is refused", (await setStation('menu_categories', A.categoryId, B.stationId)) === '23503')
  check("order_items.station_id: another tenant's station is refused", (await setStation('order_items', A.itemId, B.stationId)) === '23503')
  check('...own station is accepted on all three', (await setStation('menu_items', A.menuId, A.stationId)) === 'ok' && (await setStation('menu_categories', A.categoryId, A.stationId)) === 'ok' && (await setStation('order_items', A.itemId, A.stationId)) === 'ok')
  await q(`delete from kitchen_stations where id=$1`, [A.stationId])
  check('deleting a station nulls the references (and keeps the tenant)', (await q(`select station_id from menu_items where id=$1`, [A.menuId]))[0].station_id === null)

  // ── branch references ─────────────────────────────────────────────────────
  const wl = (branch: string) => code(() => asA((tx) => tx.execute(sql`insert into waitlist_entries (tenant_id,branch_id,name,party_size) values (${A.tenantId}, ${branch}, 'W', 2)`)))
  const fs = (branch: string) => code(() => asA((tx) => tx.execute(sql`insert into floor_sections (tenant_id,branch_id,name) values (${A.tenantId}, ${branch}, ${'S' + Math.random()})`)))
  const si = (branch: string) => code(() => asA((tx) => tx.execute(sql`insert into stock_items (tenant_id,branch_id,name,unit) values (${A.tenantId}, ${branch}, ${'I' + Math.random()}, 'kg')`)))
  check("waitlist_entries: another tenant's branch is refused", (await wl(B.branchId)) === '23503' && (await wl(A.branchId)) === 'ok')
  check("floor_sections: another tenant's branch is refused", (await fs(B.branchId)) === '23503' && (await fs(A.branchId)) === 'ok')
  check("stock_items: another tenant's branch is refused (no existence oracle)", (await si(B.branchId)) === '23503' && (await si(A.branchId)) === 'ok')

  // ── stock_movements ───────────────────────────────────────────────────────
  const sm = (o: { delta: string; source?: string | null; type?: string }) =>
    code(() =>
      asA((tx) =>
        tx.execute(sql`insert into stock_movements (tenant_id,stock_item_id,delta,source_type,source_id)
                       values (${A.tenantId}, ${A.stockId}, ${o.delta}, ${o.type ?? 'order'}, ${o.source ?? null})`),
      ),
    )
  check('stock: a positive order movement with a random source_id is refused', (await sm({ delta: '1000', source: '11111111-1111-4111-8111-111111111111' })) === '23514')
  check("stock: an order movement pointing at ANOTHER tenant's order is refused", (await sm({ delta: '-1', source: B.orderId })) === '23514')
  check('stock: an order movement with no source is refused', (await sm({ delta: '-1', source: null })) === '23514')
  check('stock: a positive order movement on a real order that took nothing is refused', (await sm({ delta: '5', source: A.orderId })) === '23514')
  check('stock: a deduction against a real order is accepted', (await sm({ delta: '-2', source: A.orderId })) === 'ok')
  check('stock: a restore up to what the order took is accepted', (await sm({ delta: '2', source: A.orderId })) === 'ok')
  check('stock: ...a restore beyond it is refused', (await sm({ delta: '0.001', source: A.orderId })) === '23514')
  check('stock: on-hand never went positive from those attempts', Number((await q(`select quantity from stock_items where id=$1`, [A.stockId]))[0].quantity) === 0)

  // ── order_item_stock_usage (0176) ─────────────────────────────────────────
  const usage = (item: string) =>
    code(() =>
      asA((tx) =>
        tx.execute(sql`insert into order_item_stock_usage (tenant_id,order_item_id,stock_item_id,per_portion)
                       values (${A.tenantId}, ${item}, ${A.stockId}, 1)`),
      ),
    )
  check("order_item_stock_usage: another tenant's ORDER LINE is refused", (await usage(B.itemId)) === '23503')
  check('order_item_stock_usage: own order line is accepted', (await usage(A.itemId)) === 'ok')

  // ── guard is race-safe (0176) ─────────────────────────────────────────────
  const race = await q(`insert into stock_items (tenant_id,branch_id,name,unit) values ($1,$2,'Race','kg') returning id`, [A.tenantId, A.branchId])
  const raceId = race[0].id as string
  const raceMove = (delta: string) =>
    code(() =>
      asA((tx) =>
        tx.execute(sql`insert into stock_movements (tenant_id,stock_item_id,delta,source_type,source_id)
                       values (${A.tenantId}, ${raceId}, ${delta}, 'order', ${A.orderId})`),
      ),
    )
  check('race: deduct 1', (await raceMove('-1')) === 'ok')
  const results = await Promise.all([raceMove('1'), raceMove('1')])
  check('race: two concurrent restores of one unit — exactly one succeeds', results.filter((r) => r === 'ok').length === 1 && results.filter((r) => r === '23514').length === 1)
  check(
    'race: net for the (item, order) never exceeds zero',
    Number((await q(`select coalesce(sum(delta),0) as n from stock_movements where stock_item_id=$1 and source_id=$2`, [raceId, A.orderId]))[0].n) === 0,
  )

  for (const t of [A, B]) {
    for (const tbl of ['stock_movements', 'print_jobs', 'kot_items', 'kots', 'invoices', 'order_items', 'orders', 'menu_items', 'menu_categories', 'stock_items']) {
      await q(`delete from ${tbl} where tenant_id = $1`, [t.tenantId]).catch(() => null)
    }
    await q(`delete from tenants where id = $1`, [t.tenantId])
  }
  console.log(`\n${pass} passed, ${fail} failed`)
  await ownerPool.end()
  await appPool.end()
  process.exit(fail ? 1 : 0)
}
main().catch((e) => {
  console.error(e)
  process.exit(1)
})
