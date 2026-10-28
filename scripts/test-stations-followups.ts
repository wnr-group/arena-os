/**
 * Station routing follow-ups (PR #43 review) against a real database.
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs scripts/test-stations-followups.ts
 *
 *  - An anonymous online order (public-tenant role) is routed exactly like a staff
 *    order, and the routing lookup can't see another tenant's stations.
 *  - A line whose station was deactivated / deleted (or never had one) is visible
 *    on every station screen and on expo, flagged unrouted, and a bump from any
 *    screen clears it everywhere.
 *  - Stations off: unchanged.
 */
import { Pool } from 'pg'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { sql } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import * as schema from '../db/schema'
import { createOrderCore } from '../lib/orders/service'
import { bumpKotCore, getStationRoutingCore, saveKdsSettingsCore } from '../lib/kots/kds'
import { loadEnv } from './env'
import { entitleTenant } from './entitle-fixture'

type Db = NodePgDatabase<typeof schema>
let pass = 0,
  fail = 0
const check = (l: string, c: boolean, detail?: unknown) => {
  console.log(`${c ? '✓' : '✗ FAIL'}  ${l}`)
  if (c) pass++
  else {
    fail++
    if (detail !== undefined) console.log('        got:', detail)
  }
}
const TZ = 'Asia/Kolkata'

async function main() {
  loadEnv()
  // @/db opens its pool at import time, so these must load after loadEnv().
  const { getKdsBoard } = await import('../lib/kots/kds-data')
  const { withPublicTenant } = await import('../db')
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
    await entitleTenant(ownerPool, tenantId)
    const b = await q(
      `insert into branches (tenant_id,name,is_primary) values ($1,'Main',true)
       on conflict (tenant_id,name) do update set is_primary=true returning id`,
      [tenantId],
    )
    const manager = await q(
      `insert into users (email,password_hash) values ($1,'x') on conflict (email) do update set email=excluded.email returning id`,
      [`manager@${slug}.test`],
    )
    const mm = await q(
      `insert into memberships (tenant_id,user_id,role,status) values ($1,$2,'manager','active')
       on conflict (tenant_id,user_id) do update set role='manager', status='active' returning id`,
      [tenantId, manager[0].id],
    )
    const cat = await q(
      `insert into menu_categories (tenant_id,name) values ($1,'Mains') on conflict (tenant_id,name) do update set name=excluded.name returning id`,
      [tenantId],
    )
    const items: string[] = []
    for (const [name, price] of [['Burger', '200'], ['Fries', '80'], ['Cola', '50']]) {
      const r = await q(`insert into menu_items (tenant_id,category_id,name,price) values ($1,$2,$3,$4) returning id`, [tenantId, cat[0].id, name, price])
      items.push(r[0].id)
    }
    return { tenantId, branchId: b[0].id as string, userId: manager[0].id as string, membershipId: mm[0].id as string, items }
  }
  type T = Awaited<ReturnType<typeof makeTenant>>

  const ctxOf = (t: T) => ({ user: { id: t.userId }, tenant: { id: t.tenantId } }) as never
  const board = (t: T, scope?: { id: string | null }) => getKdsBoard(ctxOf(t), t.branchId, scope)
  const names = (b: Awaited<ReturnType<typeof board>>, kotId: string) =>
    b.tickets.find((x) => x.kotId === kotId)?.items.map((i) => i.name).sort().join(',')
  const setSettings = (t: T, stationsEnabled: boolean) =>
    withUser(t.userId, (tx) =>
      saveKdsSettingsCore(tx, t.tenantId, {
        enabled: true,
        warnMinutes: 8,
        lateMinutes: 15,
        coursesEnabled: false,
        courseNames: ['Starters', 'Mains', 'Desserts'],
        stationsEnabled,
      }),
    )
  const mkStation = async (t: T, name: string) =>
    (await q(`insert into kitchen_stations (tenant_id,name) values ($1,$2) returning id`, [t.tenantId, name]))[0].id as string
  const lineRow = async (id: string) => (await q('select station_id, station_name from order_items where id=$1', [id]))[0]

  // staff-placed and anonymous-placed orders of the same items
  async function placeStaff(t: T) {
    const o = await withUser(t.userId, (tx) =>
      createOrderCore(tx, { tenantId: t.tenantId, timezone: TZ, membershipId: t.membershipId }, { branchId: t.branchId, items: t.items.map((menuItemId) => ({ menuItemId, qty: 1 })) }),
    )
    return finish(o.id)
  }
  async function placeOnline(t: T) {
    const o = await withPublicTenant(t.tenantId, (tx) =>
      createOrderCore(
        tx as never,
        { tenantId: t.tenantId, timezone: TZ, membershipId: null },
        { branchId: t.branchId, channel: 'online', acceptanceStatus: 'accepted', idempotencyKey: randomUUID(), items: t.items.map((menuItemId) => ({ menuItemId, qty: 1 })) },
      ),
    )
    return finish(o.id)
  }
  async function finish(orderId: string) {
    const kotId = (await q('select id from kots where order_id=$1', [orderId]))[0].id as string
    // alphabetical: Burger, Cola, Fries
    const lines = (await q('select id from order_items where order_id=$1 order by item_name', [orderId])).map((r) => r.id as string)
    return { orderId, kotId, lines }
  }
  const bump = (t: T, kotId: string, stationId: string | null) =>
    withUser(t.userId, (tx) => bumpKotCore(tx, { tenantId: t.tenantId, membershipId: t.membershipId }, kotId, { id: stationId }))

  const A = await makeTenant('teststationfollowa')
  const B = await makeTenant('teststationfollowb')
  const ids = [A.tenantId, B.tenantId]
  await q('delete from orders where tenant_id = any($1)', [ids])
  await q('delete from order_settings where tenant_id = any($1)', [ids])
  await q('update menu_items set station_id = null where tenant_id = any($1)', [ids])
  await q('update menu_categories set station_id = null where tenant_id = any($1)', [ids])
  await q('delete from kitchen_stations where tenant_id = any($1)', [ids])

  const grill = await mkStation(A, 'Grill')
  const fryer = await mkStation(A, 'Fryer')
  const bar = await mkStation(A, 'Bar')
  await mkStation(B, 'Secret')
  await q('update menu_categories set station_id=$1 where tenant_id=$2', [grill, A.tenantId])
  await q('update menu_items set station_id=$1 where id=$2', [fryer, A.items[1]])
  await q('update menu_items set station_id=$1 where id=$2', [bar, A.items[2]])
  await setSettings(A, true)
  await setSettings(B, true)

  // ── 1. anonymous online order is routed like a staff order ───────────────
  const direct = await withPublicTenant(A.tenantId, (tx) => tx.select().from(schema.kitchenStations))
  check('(the bug) the table itself is invisible to the public role', direct.length === 0, direct.length)
  const map = await withPublicTenant(A.tenantId, (tx) => getStationRoutingCore(tx as never, A.tenantId))
  check('public role: routing lookup sees the three active stations', map?.size === 3 && [...(map?.values() ?? [])].sort().join() === 'Bar,Fryer,Grill', map && [...map.values()])
  const foreign = await withPublicTenant(A.tenantId, async (tx) => (await tx.execute(sql`select id from public.station_routing(${B.tenantId}::uuid)`)).rows.length)
  check("public role: another tenant's stations are not returned", foreign === 0, foreign)
  const nobody = await appPool.query(`select id from public.station_routing($1::uuid)`, [A.tenantId])
  check('no tenant context at all: nothing is returned', nobody.rows.length === 0)

  const staff = await placeStaff(A)
  const online = await placeOnline(A)
  const route = async (o: { lines: string[] }) => Promise.all(o.lines.map(async (l) => (await lineRow(l)).station_name))
  check('staff order routed Burger→Grill, Cola→Bar, Fries→Fryer', (await route(staff)).join() === 'Grill,Bar,Fryer', await route(staff))
  check('anonymous online order is routed identically', (await route(online)).join() === 'Grill,Bar,Fryer', await route(online))
  check('…with real station ids, not NULL', (await Promise.all(online.lines.map(async (l) => (await lineRow(l)).station_id))).every((s) => s !== null))
  check('the Grill screen shows the online order’s burger', names(await board(A, { id: grill }), online.kotId) === 'Burger')

  // ── 2. unrouted lines are visible on every station screen ────────────────
  // Deactivate Fryer after the order exists: Fries keep station_id=fryer, but no
  // active tab owns them any more.
  await q('update kitchen_stations set is_active=false where id=$1', [fryer])
  const bGrill = await board(A, { id: grill })
  const bBar = await board(A, { id: bar })
  check('deactivated station: its line shows on the Grill screen', names(bGrill, staff.kotId) === 'Burger,Fries', names(bGrill, staff.kotId))
  check('…and on the Bar screen', names(bBar, staff.kotId) === 'Cola,Fries', names(bBar, staff.kotId))
  check('…and on the Unassigned screen', names(await board(A, { id: null }), staff.kotId) === 'Fries')
  check('…and on the all-stations / expo view (everything)', names(await board(A), staff.kotId) === 'Burger,Cola,Fries')
  const fries = (await board(A)).tickets.find((t) => t.kotId === staff.kotId)!.items.find((i) => i.name === 'Fries')!
  const burger = (await board(A)).tickets.find((t) => t.kotId === staff.kotId)!.items.find((i) => i.name === 'Burger')!
  check('the line is flagged unrouted; a routed line is not', fries.unrouted === true && burger.unrouted === false)
  check('the deactivated station is not offered as a tab', (await board(A)).stations.every((s) => s.id !== fryer))

  // deleted station: station_id is cleared (ON DELETE SET NULL)
  await q('delete from kitchen_stations where id=$1', [grill])
  const afterDelete = await board(A, { id: bar })
  check('deleted station: its line (station_id NULL) shows on the Bar screen', names(afterDelete, staff.kotId) === 'Burger,Cola,Fries', names(afterDelete, staff.kotId))

  // ── 3. any screen can clear an unrouted line, for everyone ────────────────
  await bump(A, staff.kotId, bar)
  check('bumping from Bar also clears the unrouted lines', names(await board(A, { id: bar }), staff.kotId) === undefined)
  const kotStatus = (await q('select status from kots where id=$1', [staff.kotId]))[0].status
  check('and the ticket is ready (nothing left for anyone)', kotStatus === 'ready', kotStatus)

  // ── 4. stations off: unchanged ───────────────────────────────────────────
  await setSettings(A, false)
  const off = await withPublicTenant(A.tenantId, (tx) => getStationRoutingCore(tx as never, A.tenantId))
  check('stations off: no routing at all', off === null)
  const offOrder = await placeOnline(A)
  check('stations off: online lines carry no station', (await Promise.all(offOrder.lines.map(async (l) => (await lineRow(l)).station_id))).every((s) => s === null))
  const offBoard = await board(A, { id: bar })
  check('stations off: a station scope is ignored and tabs are empty', offBoard.stations.length === 0 && names(offBoard, offOrder.kotId) === 'Burger,Cola,Fries')

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
