/**
 * Station routing + expo (M19 / AROS-174) tests against a real database.
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs scripts/test-stations.ts
 *
 * Covers: opt-in gate, station resolution (item over category), order-time
 * snapshot, per-station boards, station-scoped bump, kitchen_stations RLS.
 */
import { Pool } from 'pg'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { sql } from 'drizzle-orm'
import * as schema from '../db/schema'
import { createOrderCore } from '../lib/orders/service'
import {
  bumpKotCore,
  saveKdsSettingsCore,
} from '../lib/kots/kds'
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
const TZ = 'Asia/Kolkata'
const NAMES = ['Starters', 'Mains', 'Desserts']
const ROLES = ['owner', 'manager', 'kitchen_staff', 'floor_staff', 'cashier', 'receptionist'] as const
type Role = (typeof ROLES)[number]

async function main() {
  loadEnv()
  // @/db opens its pool at import time, so it must load after loadEnv().
  const { getKdsBoard } = await import('../lib/kots/kds-data')
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
    // Course firing / the KDS are plan-gated: the fixture is a paying tenant.
    await entitleTenant(ownerPool, tenantId)
    const b = await q(
      `insert into branches (tenant_id,name,is_primary) values ($1,'Main',true)
       on conflict (tenant_id,name) do update set is_primary=true returning id`,
      [tenantId],
    )
    const members = {} as Record<Role, { userId: string; membershipId: string }>
    for (const role of ROLES) {
      const u = await q(
        `insert into users (email,password_hash) values ($1,'x') on conflict (email) do update set email=excluded.email returning id`,
        [`${role}@${slug}.test`],
      )
      const m = await q(
        `insert into memberships (tenant_id,user_id,role,status) values ($1,$2,$3,'active')
         on conflict (tenant_id,user_id) do update set role=$3, status='active' returning id`,
        [tenantId, u[0].id, role],
      )
      members[role] = { userId: u[0].id, membershipId: m[0].id }
    }
    const cat = await q(
      `insert into menu_categories (tenant_id,name) values ($1,'Mains') on conflict (tenant_id,name) do update set name=excluded.name returning id`,
      [tenantId],
    )
    const items: string[] = []
    for (const [name, price] of [['Burger', '200'], ['Fries', '80'], ['Cola', '50']]) {
      const r = await q(`insert into menu_items (tenant_id,category_id,name,price) values ($1,$2,$3,$4) returning id`, [
        tenantId, cat[0].id, name, price,
      ])
      items.push(r[0].id)
    }
    return { tenantId, branchId: b[0].id as string, members, items }
  }
  type T = Awaited<ReturnType<typeof makeTenant>>

  const status = async (kotId: string) => (await q('select status from kots where id=$1', [kotId]))[0].status as string
  const actor = (t: T, role: Role) => ({ tenantId: t.tenantId, membershipId: t.members[role].membershipId })
  async function attempt<R>(fn: () => Promise<R>) {
    try {
      return { ok: true as const, v: await fn() }
    } catch (e) {
      return { ok: false as const, msg: e instanceof Error ? e.message : String(e) }
    }
  }
  const ctxOf = (t: T, role: Role) => ({ user: { id: t.members[role].userId }, tenant: { id: t.tenantId } }) as never

  async function place(t: T, role: Role = 'owner') {
    const o = await withUser(t.members[role].userId, (tx) =>
      createOrderCore(
        tx,
        { tenantId: t.tenantId, timezone: TZ, membershipId: t.members[role].membershipId },
        { branchId: t.branchId, items: t.items.map((menuItemId) => ({ menuItemId, qty: 1 })) },
      ),
    )
    const kotId = (await q('select id from kots where order_id=$1', [o.id]))[0].id as string
    // Burger, Cola, Fries (alphabetical)
    const lines = (await q('select id from order_items where order_id=$1 order by item_name', [o.id])).map((r) => r.id as string)
    return { orderId: o.id, kotId, lines }
  }
  const lineStation = async (id: string) => (await q('select station_id, station_name from order_items where id=$1', [id]))[0]
  const board = (t: T, scope?: { id: string | null }) => getKdsBoard(ctxOf(t, 'kitchen_staff'), t.branchId, scope)
  const setSettings = (t: T, stationsEnabled: boolean, enabled = true) =>
    withUser(t.members.manager.userId, (tx) =>
      saveKdsSettingsCore(tx, t.tenantId, {
        enabled,
        warnMinutes: 8,
        lateMinutes: 15,
        coursesEnabled: false,
        courseNames: NAMES,
        stationsEnabled,
      }),
    )
  const stationBump = (t: T, kotId: string, stationId: string | null) =>
    withUser(t.members.kitchen_staff.userId, (tx) => bumpKotCore(tx, actor(t, 'kitchen_staff'), kotId, { id: stationId }))

  const A = await makeTenant('teststationsa')
  const B = await makeTenant('teststationsb')
  const ids = [A.tenantId, B.tenantId]
  await q('delete from orders where tenant_id = any($1)', [ids])
  await q('delete from order_settings where tenant_id = any($1)', [ids])
  await q('delete from kitchen_stations where tenant_id = any($1)', [ids])
  await q('update menu_items set station_id = null where tenant_id = any($1)', [ids])
  await q('update menu_categories set station_id = null where tenant_id = any($1)', [ids])

  // ── 1. stations table RLS (role matrix) ───────────────────────────────────
  const mk = (t: T, role: Role, name: string) =>
    attempt(() =>
      withUser(t.members[role].userId, (tx) =>
        tx.insert(schema.kitchenStations).values({ tenantId: t.tenantId, name }).returning({ id: schema.kitchenStations.id }),
      ),
    )
  for (const role of ROLES) {
    const r = await mk(A, role, `probe-${role}`)
    const allowed = role === 'owner' || role === 'manager'
    check(`role ${role}: create station ${allowed ? 'allowed' : 'blocked'}`, r.ok === allowed)
  }
  await q(`delete from kitchen_stations where tenant_id=$1`, [A.tenantId])
  const dup1 = await mk(A, 'manager', 'Grill')
  const dup2 = await mk(A, 'manager', ' grill ')
  check('station names are unique per tenant, case/space-insensitive', dup1.ok && !dup2.ok)
  const grill = (dup1 as { ok: true; v: { id: string }[] }).v[0].id
  const bar = ((await mk(A, 'owner', 'Bar')) as { ok: true; v: { id: string }[] }).v[0].id
  const fryer = ((await mk(A, 'owner', 'Fryer')) as { ok: true; v: { id: string }[] }).v[0].id
  const seesB = await withUser(B.members.owner.userId, (tx) => tx.select().from(schema.kitchenStations))
  check("tenant B cannot see tenant A's stations", seesB.every((s) => s.tenantId === B.tenantId))

  // Mains → Grill (category); Fries → Fryer and Cola → Bar (item-level).
  await q('update menu_categories set station_id=$1 where tenant_id=$2', [grill, A.tenantId])
  await q('update menu_items set station_id=$1 where id=$2', [fryer, A.items[1]])
  await q('update menu_items set station_id=$1 where id=$2', [bar, A.items[2]])

  // ── 2. routing off: nothing snapshotted ───────────────────────────────────
  const off = await place(A)
  const offL = await lineStation(off.lines[0])
  check('stations off: no station snapshot even though the menu is mapped', offL.station_id === null && offL.station_name === null)
  const offBoard = await board(A, { id: grill })
  check('stations off: board ignores a station scope and lists stations as empty', offBoard.stations.length === 0 && offBoard.tickets.some((x) => x.kotId === off.kotId))
  await q(`update kots set status='cancelled' where id=$1`, [off.kotId])

  // ── 3. snapshot ───────────────────────────────────────────────────────────
  await setSettings(A, true)
  const o = await place(A, 'floor_staff')
  const [burger, cola, fries] = [await lineStation(o.lines[0]), await lineStation(o.lines[1]), await lineStation(o.lines[2])]
  check('dish with no station of its own uses its category (Burger → Grill)', burger.station_id === grill && burger.station_name === 'Grill')
  check('dish-level station wins over the category (Fries → Fryer, Cola → Bar)', fries.station_name === 'Fryer' && cola.station_name === 'Bar')

  await q('update menu_items set station_id=$1 where id=$2', [bar, A.items[0]])
  check('re-mapping the menu later does not re-route an existing line', (await lineStation(o.lines[0])).station_id === grill)
  await q('update menu_items set station_id=null where id=$1', [A.items[0]])

  await q('update kitchen_stations set is_active=false where id=$1', [bar])
  const o2 = await place(A)
  check('an inactive station routes to nothing', (await lineStation(o2.lines[1])).station_id === null)
  await q('update kitchen_stations set is_active=true where id=$1', [bar])
  await q(`update kots set status='cancelled' where id=$1`, [o2.kotId])

  // ── 4. station screens ────────────────────────────────────────────────────
  const names = (b: Awaited<ReturnType<typeof board>>, kotId: string) =>
    b.tickets.find((x) => x.kotId === kotId)?.items.map((i) => i.name).sort().join(',')
  const bGrill = await board(A, { id: grill })
  check('Grill screen sees only the grill line', names(bGrill, o.kotId) === 'Burger')
  check('Bar screen sees only the bar line', names(await board(A, { id: bar }), o.kotId) === 'Cola')
  check('Fryer screen sees only the fryer line', names(await board(A, { id: fryer }), o.kotId) === 'Fries')
  check('all-day counts are per station', bGrill.allDay.length === 1 && bGrill.allDay[0].name === 'Burger')
  check('All-stations screen sees every line', names(await board(A), o.kotId) === 'Burger,Cola,Fries')
  check('Unassigned screen does not show routed lines', names(await board(A, { id: null }), o.kotId) === undefined)
  check('tabs list the active stations', (await board(A)).stations.map((s) => s.name).sort().join() === 'Bar,Fryer,Grill')

  // ── 5. station-scoped bump → ticket ready only when every station is done ──
  const r1 = await stationBump(A, o.kotId, grill)
  check('Grill bump: only grill lines bumped, ticket still preparing', !r1.becameReady && (await status(o.kotId)) === 'preparing' && Number((await q('select count(*) c from kot_items where kot_id=$1', [o.kotId]))[0].c) === 1)
  check('Grill screen drops the ticket once its lines are done', names(await board(A, { id: grill }), o.kotId) === undefined)
  check('…but the other stations still see theirs', names(await board(A, { id: bar }), o.kotId) === 'Cola')
  const ex = (await board(A)).tickets.find((x) => x.kotId === o.kotId)!
  check('expo data: per-line station + bumped state', ex.items.find((i) => i.name === 'Burger')!.bumped && !ex.items.find((i) => i.name === 'Cola')!.bumped && ex.items.every((i) => i.stationName))
  await stationBump(A, o.kotId, bar)
  check('Bar bump: still not ready (fryer outstanding)', (await status(o.kotId)) === 'preparing')
  const r3 = await stationBump(A, o.kotId, fryer)
  check('last station bump: ticket ready + becameReady', r3.becameReady && (await status(o.kotId)) === 'ready')

  // ── 6. unrouted lines get an Unassigned screen ────────────────────────────
  await q('update menu_items set station_id=null where id=$1', [A.items[1]])
  await q('update menu_categories set station_id=null where tenant_id=$1', [A.tenantId])
  const u = await place(A)
  check('unrouted lines carry no station', (await lineStation(u.lines[0])).station_id === null)
  const bu = await board(A, { id: null })
  check('Unassigned screen shows them (Burger, Fries)', names(bu, u.kotId) === 'Burger,Fries')
  const ru = await stationBump(A, u.kotId, null)
  check('bumping Unassigned leaves the Cola (bar) outstanding', !ru.becameReady && (await status(u.kotId)) === 'preparing')

  // ── 7. deleting a station un-routes the menu, keeps the order snapshot name ─
  await q('delete from kitchen_stations where id=$1', [grill])
  const after = await lineStation(o.lines[0])
  check('deleted station: order line keeps its station name, id cleared', after.station_id === null && after.station_name === 'Grill')

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
