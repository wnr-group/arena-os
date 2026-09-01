/**
 * Modifier groups/options — structured per-item choices (size, add-ons, "no
 * onions") with priced deltas, enforced min/max, and a snapshot onto each
 * order line so a later price/menu edit never changes what was already
 * ordered (M17 #8). Integration tests against a real database, same shape as
 * scripts/test-void-comp.ts. Drives createOrderCore (lib/orders/service.ts)
 * directly:
 *
 *   - a required group (minSelect=maxSelect=1) must have exactly one option
 *     chosen, or the order is refused with an "exactly 1" message
 *   - an optional group with maxSelect=2 accepts 0, 1, or 2 options, and
 *     refuses a 3rd with an "at most 2" message
 *   - each chosen option's price delta is added to the line's unit price
 *     (base + sum of deltas), and the line total is unitPrice × qty
 *   - the base price is discounted by an active happy-hour rule; the
 *     modifier deltas are added AFTER, at full price, never discounted
 *   - the chosen group/option names + price deltas are snapshotted onto
 *     order_item_modifiers, and stay frozen even if the option's price or
 *     name changes afterwards
 *   - an option that belongs to a group not attached to the ordered item is
 *     refused (smuggling an option from a different item/tenant)
 *   - tenant isolation (RLS): another tenant's modifier option id is
 *     "not found", not usable
 *
 *   npx tsx scripts/test-modifiers.ts
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
    // Size (required, exactly 1): Small (+0), Large (+50)
    sizeGroupId: string
    small: string
    large: string
    // Add-ons (optional, up to 2): Extra cheese (+20), Bacon (+30), No onions (+0)
    addonGroupId: string
    extraCheese: string
    bacon: string
    noOnions: string
    tables: string[]
  }

  async function makeTenant(slug: string, tableCount = 2): Promise<Tenant> {
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
      `insert into menu_items (tenant_id,category_id,name,price) values ($1,$2,'Burger','100.00') returning id`,
      [tenantId, cat.rows[0].id],
    )
    const itemId = item.rows[0].id

    const sizeGroup = await ownerPool.query<{ id: string }>(
      `insert into modifier_groups (tenant_id,name,min_select,max_select,required) values ($1,'Size',1,1,true) returning id`,
      [tenantId],
    )
    const sizeGroupId = sizeGroup.rows[0].id
    const small = await ownerPool.query<{ id: string }>(
      `insert into modifier_options (tenant_id,group_id,name,price_delta) values ($1,$2,'Small','0') returning id`,
      [tenantId, sizeGroupId],
    )
    const large = await ownerPool.query<{ id: string }>(
      `insert into modifier_options (tenant_id,group_id,name,price_delta) values ($1,$2,'Large','50.00') returning id`,
      [tenantId, sizeGroupId],
    )

    const addonGroup = await ownerPool.query<{ id: string }>(
      `insert into modifier_groups (tenant_id,name,min_select,max_select,required) values ($1,'Add-ons',0,2,false) returning id`,
      [tenantId],
    )
    const addonGroupId = addonGroup.rows[0].id
    const extraCheese = await ownerPool.query<{ id: string }>(
      `insert into modifier_options (tenant_id,group_id,name,price_delta) values ($1,$2,'Extra cheese','20.00') returning id`,
      [tenantId, addonGroupId],
    )
    const bacon = await ownerPool.query<{ id: string }>(
      `insert into modifier_options (tenant_id,group_id,name,price_delta) values ($1,$2,'Bacon','30.00') returning id`,
      [tenantId, addonGroupId],
    )
    const noOnions = await ownerPool.query<{ id: string }>(
      `insert into modifier_options (tenant_id,group_id,name,price_delta) values ($1,$2,'No onions','0') returning id`,
      [tenantId, addonGroupId],
    )

    await ownerPool.query(
      `insert into menu_item_modifier_groups (tenant_id,menu_item_id,group_id,sort_order) values ($1,$2,$3,0),($1,$2,$4,1)`,
      [tenantId, itemId, sizeGroupId, addonGroupId],
    )

    const rt = await ownerPool.query<{ id: string }>(
      `insert into resource_types (tenant_id,name,hourly_rate) values ($1,'Table','0')
       on conflict (tenant_id,name) do update set name=excluded.name returning id`,
      [tenantId],
    )
    const tableIds: string[] = []
    for (let i = 0; i < tableCount; i++) {
      const r = await ownerPool.query<{ id: string }>(
        `insert into resources (tenant_id,branch_id,resource_type_id,name) values ($1,$2,$3,$4) returning id`,
        [tenantId, branchId, rt.rows[0].id, `T${i + 1}`],
      )
      tableIds.push(r.rows[0].id)
    }
    return {
      tenantId,
      branchId,
      userId: u.rows[0].id,
      membershipId: m.rows[0].id,
      itemId,
      sizeGroupId,
      small: small.rows[0].id,
      large: large.rows[0].id,
      addonGroupId,
      extraCheese: extraCheese.rows[0].id,
      bacon: bacon.rows[0].id,
      noOnions: noOnions.rows[0].id,
      tables: tableIds,
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

  async function order(t: Tenant, bookingId: string, modifierOptionIds: string[], qty = 1) {
    return withUser(t.userId, (tx) =>
      createOrderCore(
        tx,
        { tenantId: t.tenantId, timezone: TZ, membershipId: t.membershipId },
        { branchId: t.branchId, bookingId, items: [{ menuItemId: t.itemId, qty, modifierOptionIds }] },
      ),
    )
  }

  async function orderItemRow(orderId: string) {
    const { rows } = await ownerPool.query(
      `select id, unit_price, line_total, original_unit_price from order_items where order_id=$1 order by id limit 1`,
      [orderId],
    )
    return rows[0] as { id: string; unit_price: string; line_total: string; original_unit_price: string | null } | undefined
  }

  async function snapshotRows(orderItemId: string) {
    const { rows } = await ownerPool.query(
      `select group_name, option_name, price_delta from order_item_modifiers where order_item_id=$1 order by option_name`,
      [orderItemId],
    )
    return rows as { group_name: string; option_name: string; price_delta: string }[]
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

  const A = await makeTenant('testmodifiers-a')
  const B = await makeTenant('testmodifiers-b')

  // ── 1. required group must have exactly one option ─────────────────────────
  {
    const session = await seat(A, A.tables[0], 2)

    const missing = await attempt(() => order(A, session.id, []))
    check(
      'omitting a required (exactly 1) group is refused',
      !missing.ok && missing.orderError && /exactly 1 option.*Size/i.test(missing.message),
    )

    const ok = await attempt(() => order(A, session.id, [A.small]))
    check('choosing exactly 1 option for the required group succeeds', ok.ok)

    await withUser(A.userId, (tx) => tx.update(schema.bookings).set({ status: 'completed' }).where(sql`${schema.bookings.id} = ${session.id}`))
  }

  // ── 2. price delta folds into unit price / line total; snapshot recorded ───
  {
    const session = await seat(A, A.tables[0], 2)
    const o = await order(A, session.id, [A.large, A.extraCheese, A.bacon], 2)
    const item = await orderItemRow(o.id)
    check('unit price = base(100) + Large(50) + cheese(20) + bacon(30) = 200.00', item?.unit_price === '200.00')
    check('line total = unit price × qty = 400.00', item?.line_total === '400.00')

    const snap = await snapshotRows(item!.id)
    check('3 modifier rows snapshotted', snap.length === 3)
    check(
      'snapshot carries group/option names and price deltas',
      snap.some((r) => r.group_name === 'Size' && r.option_name === 'Large' && r.price_delta === '50.00') &&
        snap.some((r) => r.group_name === 'Add-ons' && r.option_name === 'Extra cheese' && r.price_delta === '20.00') &&
        snap.some((r) => r.group_name === 'Add-ons' && r.option_name === 'Bacon' && r.price_delta === '30.00'),
    )

    // Mutate the live option's price/name after the order — the snapshot must
    // stay exactly as it was charged.
    await ownerPool.query(`update modifier_options set name='Extra Extra Cheese', price_delta='999.00' where id=$1`, [A.extraCheese])
    const snapAfter = await snapshotRows(item!.id)
    check(
      'snapshot is immune to a later edit of the live option',
      snapAfter.some((r) => r.option_name === 'Extra cheese' && r.price_delta === '20.00'),
    )
    // restore for later sections
    await ownerPool.query(`update modifier_options set name='Extra cheese', price_delta='20.00' where id=$1`, [A.extraCheese])

    await withUser(A.userId, (tx) => tx.update(schema.bookings).set({ status: 'completed' }).where(sql`${schema.bookings.id} = ${session.id}`))
  }

  // ── 3. optional group accepts 0/1/2, refuses a 3rd (max_select=2) ──────────
  {
    const session = await seat(A, A.tables[1], 2)

    const zero = await attempt(() => order(A, session.id, [A.small]))
    check('0 add-ons is fine (min_select=0)', zero.ok)

    const two = await attempt(() => order(A, session.id, [A.small, A.extraCheese, A.bacon]))
    check('exactly max_select (2) add-ons is fine', two.ok)

    const three = await attempt(() => order(A, session.id, [A.small, A.extraCheese, A.bacon, A.noOnions]))
    check(
      'exceeding max_select (3rd add-on) is refused',
      !three.ok && three.orderError && /at most 2 options.*Add-ons/i.test(three.message),
    )

    await withUser(A.userId, (tx) => tx.update(schema.bookings).set({ status: 'completed' }).where(sql`${schema.bookings.id} = ${session.id}`))
  }

  // ── 4. an option from a group not attached to this item is refused ─────────
  {
    // A second item with no modifier groups attached at all.
    const otherItem = await ownerPool.query<{ id: string }>(
      `select category_id from menu_items where id=$1`,
      [A.itemId],
    )
    const catId = otherItem.rows[0].category_id as unknown as string
    const plain = await ownerPool.query<{ id: string }>(
      `insert into menu_items (tenant_id,category_id,name,price) values ($1,$2,'Fries','60.00') returning id`,
      [A.tenantId, catId],
    )
    const plainItemId = plain.rows[0].id

    const session = await seat(A, A.tables[0], 2)
    const smuggled = await attempt(() =>
      withUser(A.userId, (tx) =>
        createOrderCore(
          tx,
          { tenantId: A.tenantId, timezone: TZ, membershipId: A.membershipId },
          { branchId: A.branchId, bookingId: session.id, items: [{ menuItemId: plainItemId, qty: 1, modifierOptionIds: [A.small] }] },
        ),
      ),
    )
    check(
      'an option not offered by the ordered item is refused',
      !smuggled.ok && smuggled.orderError && /not a valid option/i.test(smuggled.message),
    )

    await withUser(A.userId, (tx) => tx.update(schema.bookings).set({ status: 'completed' }).where(sql`${schema.bookings.id} = ${session.id}`))
  }

  // ── 5. happy hour discounts the base only, never the modifier delta ────────
  {
    await ownerPool.query(
      `insert into happy_hours (tenant_id,name,days_of_week,start_time,end_time,discount_type,discount_value,is_active)
       values ($1,'All day 50% off','{0,1,2,3,4,5,6}','00:00','23:59','percentage','50',true)`,
      [A.tenantId],
    )
    const session = await seat(A, A.tables[1], 2)
    const o = await order(A, session.id, [A.large])
    const item = await orderItemRow(o.id)
    // base 100 -> 50% off -> 50, + Large delta 50 (full price, undiscounted) = 100
    check('happy hour discounts the base only; modifier delta stays full price', item?.unit_price === '100.00')
    check('original_unit_price snapshots the pre-discount BASE price only (100.00, not +delta)', item?.original_unit_price === '100.00')

    await ownerPool.query(`delete from happy_hours where tenant_id=$1`, [A.tenantId])
    await withUser(A.userId, (tx) => tx.update(schema.bookings).set({ status: 'completed' }).where(sql`${schema.bookings.id} = ${session.id}`))
  }

  // ── 6. tenant isolation (RLS): another tenant's option id is unusable ──────
  {
    const session = await seat(A, A.tables[0], 2)
    const cross = await attempt(() => order(A, session.id, [B.small]))
    check(
      "tenant A cannot use tenant B's modifier option (RLS ⇒ not found)",
      !cross.ok && cross.orderError && /modifier options were not found/i.test(cross.message),
    )
    await withUser(A.userId, (tx) => tx.update(schema.bookings).set({ status: 'completed' }).where(sql`${schema.bookings.id} = ${session.id}`))
  }

  // ── cleanup ───────────────────────────────────────────────────────────────
  await ownerPool.query('delete from tenants where id = any($1)', [[A.tenantId, B.tenantId]])
  await ownerPool.query(`delete from users where email like '%@testmodifiers-%.test'`)
  await ownerPool.end()
  await appPool.end()

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
