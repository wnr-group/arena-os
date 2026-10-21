/**
 * Kitchen Display System (M19 / AROS-172) tests against a real database.
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs scripts/test-kds.ts
 *
 * Covers: opt-in flag, item bump/recall + derived ticket status, ticket
 * bump/recall, void/remove after firing, the all-day counts reader, a role
 * matrix over the kot_items RLS policies, cross-tenant isolation, and that a
 * tenant without the flag keeps the existing behaviour exactly.
 */
import { Pool } from 'pg'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { sql } from 'drizzle-orm'
import * as schema from '../db/schema'
import { createOrderCore, removeOrderItemCore } from '../lib/orders/service'
import { updateKotStatusCore } from '../lib/kots/service'
import {
  bumpKotCore,
  bumpKotItemCore,
  recallKotCore,
  recallKotItemCore,
  reconcileKotAfterLineChange,
  saveKdsSettingsCore,
} from '../lib/kots/kds'
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

  /** Lines come back ordered by name: Burger, Cola, Fries. */
  async function fire(t: T, qtys: number[] = [2, 1, 1]) {
    const o = await withUser(t.members.owner.userId, (tx) =>
      createOrderCore(
        tx,
        { tenantId: t.tenantId, timezone: TZ, membershipId: t.members.owner.membershipId },
        { branchId: t.branchId, items: qtys.map((qty, i) => ({ menuItemId: t.items[i], qty })) },
      ),
    )
    const kot = (await q('select id from kots where order_id=$1', [o.id]))[0].id as string
    const lines = (await q('select id from order_items where order_id=$1 order by item_name', [o.id])).map((r) => r.id as string)
    return { orderId: o.id, kotId: kot, lines }
  }
  const status = async (kotId: string) => (await q('select status from kots where id=$1', [kotId]))[0].status as string
  const bumped = async (kotId: string) => Number((await q('select count(*) c from kot_items where kot_id=$1', [kotId]))[0].c)
  const actor = (t: T, role: Role) => ({ tenantId: t.tenantId, membershipId: t.members[role].membershipId })
  async function attempt<R>(fn: () => Promise<R>) {
    try {
      return { ok: true as const, v: await fn() }
    } catch (e) {
      return { ok: false as const, msg: e instanceof Error ? e.message : String(e) }
    }
  }
  const ctxOf = (t: T, role: Role) => ({ user: { id: t.members[role].userId }, tenant: { id: t.tenantId } }) as never

  const A = await makeTenant('testkdsa')
  const B = await makeTenant('testkdsb')
  const ids = [A.tenantId, B.tenantId]
  await q('delete from orders where tenant_id = any($1)', [ids]) // cascades kots, order_items, kot_items
  await q('delete from order_settings where tenant_id = any($1)', [ids])

  // ── 1. flag off = existing behaviour ──────────────────────────────────────
  const cook = A.members.kitchen_staff
  const off = await fire(A)
  const offBump = await attempt(() =>
    withUser(cook.userId, (tx) => bumpKotItemCore(tx, actor(A, 'kitchen_staff'), off.kotId, off.lines[0])),
  )
  check('KDS off: bump refused', !offBump.ok && /not turned on/i.test(offBump.msg))
  check('KDS off: nothing written to kot_items', (await bumped(off.kotId)) === 0)
  const legacy = await attempt(() =>
    withUser(cook.userId, (tx) => updateKotStatusCore(tx, { tenantId: A.tenantId }, off.kotId, 'preparing')),
  )
  check('KDS off: legacy pending → preparing still works', legacy.ok && (await status(off.kotId)) === 'preparing')
  check('KDS off: creating an order wrote no kot_items', (await q('select count(*) c from kot_items where tenant_id=$1', [A.tenantId]))[0].c === '0')

  // ── 2. settings ───────────────────────────────────────────────────────────
  const badSet = await attempt(() =>
    withUser(A.members.owner.userId, (tx) => saveKdsSettingsCore(tx, A.tenantId, { enabled: true, warnMinutes: 15, lateMinutes: 8 })),
  )
  check('settings: warn >= late rejected', !badSet.ok)
  const mgrSet = await attempt(() =>
    withUser(A.members.manager.userId, (tx) => saveKdsSettingsCore(tx, A.tenantId, { enabled: true, warnMinutes: 5, lateMinutes: 10 })),
  )
  check('settings: manager can enable + set thresholds', mgrSet.ok)
  const cookSet = await attempt(() =>
    withUser(cook.userId, (tx) => saveKdsSettingsCore(tx, A.tenantId, { enabled: false, warnMinutes: 5, lateMinutes: 10 })),
  )
  check('settings: kitchen_staff blocked by RLS', !cookSet.ok)
  const row = (await q('select kds_enabled, kds_warn_minutes, kds_late_minutes from order_settings where tenant_id=$1', [A.tenantId]))[0]
  check('settings: stored as saved', row.kds_enabled === true && row.kds_warn_minutes === 5 && row.kds_late_minutes === 10)
  check('settings: tenant B unaffected (default off)', (await q('select 1 from order_settings where tenant_id=$1 and kds_enabled', [B.tenantId])).length === 0)

  // ── 3. item bump / recall ─────────────────────────────────────────────────
  const k = await fire(A)
  const bump = (kotId: string, line: string, role: Role = 'kitchen_staff') =>
    withUser(A.members[role].userId, (tx) => bumpKotItemCore(tx, actor(A, role), kotId, line))
  const recall = (kotId: string, line: string) =>
    withUser(cook.userId, (tx) => recallKotItemCore(tx, actor(A, 'kitchen_staff'), kotId, line))

  let r = await bump(k.kotId, k.lines[0])
  check('first bump: pending → preparing', r.status === 'preparing' && (await status(k.kotId)) === 'preparing' && !r.becameReady)
  await bump(k.kotId, k.lines[0])
  check('bump is idempotent', (await bumped(k.kotId)) === 1)

  await q(`update kots set status='cancelled' where id=$1`, [off.kotId]) // keep section 1's ticket out of the counts
  const board = await getKdsBoard(ctxOf(A, 'kitchen_staff'), A.branchId)
  const tk = board.tickets.find((t) => t.kotId === k.kotId)!
  check('board: ticket present with bump state per line', !!tk && tk.items.length === 3 && tk.items.filter((i) => i.bumped).length === 1)
  const allDay = Object.fromEntries(board.allDay.map((c) => [c.name, c.qty]))
  check('all-day counts exclude bumped lines', allDay['Fries'] === 1 && allDay['Cola'] === 1)
  check('all-day: fully bumped dish is absent', allDay['Burger'] === undefined)
  check('board: thresholds from settings', board.settings.warnMinutes === 5 && board.settings.lateMinutes === 10)

  await bump(k.kotId, k.lines[1])
  r = await bump(k.kotId, k.lines[2])
  check('last bump: ticket → ready, becameReady', r.status === 'ready' && r.becameReady && (await status(k.kotId)) === 'ready')
  const onReady = await attempt(() => bump(k.kotId, k.lines[0]))
  check('bump on a ready ticket refused', !onReady.ok && /recall/i.test(onReady.msg))

  r = await recall(k.kotId, k.lines[1])
  check('recall one line: ready → preparing', r.status === 'preparing' && (await status(k.kotId)) === 'preparing' && (await bumped(k.kotId)) === 2)

  // ── 4. ticket bump / recall ───────────────────────────────────────────────
  r = await withUser(cook.userId, (tx) => bumpKotCore(tx, actor(A, 'kitchen_staff'), k.kotId))
  check('bump ticket: all lines bumped, status ready', r.becameReady && (await bumped(k.kotId)) === 3 && (await status(k.kotId)) === 'ready')
  r = await withUser(cook.userId, (tx) => recallKotCore(tx, actor(A, 'kitchen_staff'), k.kotId))
  check('recall ticket: lines outstanding again, status preparing', (await bumped(k.kotId)) === 0 && (await status(k.kotId)) === 'preparing')
  const recallPrep = await attempt(() => withUser(cook.userId, (tx) => recallKotCore(tx, actor(A, 'kitchen_staff'), k.kotId)))
  check('recall ticket only valid from ready', !recallPrep.ok)

  await withUser(cook.userId, (tx) => bumpKotCore(tx, actor(A, 'kitchen_staff'), k.kotId))
  await withUser(cook.userId, (tx) => updateKotStatusCore(tx, { tenantId: A.tenantId }, k.kotId, 'served'))
  const afterServed = await attempt(() => recall(k.kotId, k.lines[0]))
  check('served ticket cannot be recalled or changed', !afterServed.ok && (await status(k.kotId)) === 'served')

  // ── 5. void / remove after firing ─────────────────────────────────────────
  const v = await fire(A)
  await bump(v.kotId, v.lines[0])
  await q(`update order_items set void_status='voided' where id=$1`, [v.lines[1]])
  const b2 = await getKdsBoard(ctxOf(A, 'kitchen_staff'), A.branchId)
  check('voided line drops off the board', b2.tickets.find((t) => t.kotId === v.kotId)!.items.length === 2)
  const voidedBump = await attempt(() => bump(v.kotId, v.lines[1]))
  check('a voided line cannot be bumped', !voidedBump.ok)
  await withUser(A.members.manager.userId, (tx) => reconcileKotAfterLineChange(tx, A.tenantId, v.orderId))
  check('void with Fries still outstanding → ticket stays preparing', (await status(v.kotId)) === 'preparing')
  await bump(v.kotId, v.lines[2])
  check('bumping the remaining line completes the ticket', (await status(v.kotId)) === 'ready')

  const rm = await fire(A)
  await bump(rm.kotId, rm.lines[0])
  await bump(rm.kotId, rm.lines[1])
  await withUser(A.members.manager.userId, (tx) => removeOrderItemCore(tx, actor(A, 'manager'), { orderItemId: rm.lines[2] }))
  check('removing the last outstanding line → ticket ready', (await status(rm.kotId)) === 'ready')

  const rm2 = await fire(A, [1, 1, 1])
  await bump(rm2.kotId, rm2.lines[0])
  for (const l of rm2.lines) {
    await withUser(A.members.manager.userId, (tx) => removeOrderItemCore(tx, actor(A, 'manager'), { orderItemId: l })).catch(() => null)
  }
  check('removing every line still cancels the ticket (existing behaviour)', (await status(rm2.kotId)) === 'cancelled')

  // ── 6. role matrix (kot_items RLS) ────────────────────────────────────────
  for (const role of ROLES) {
    const t = await fire(A, [1, 1, 1])
    const res = await attempt(() => bump(t.kotId, t.lines[0], role))
    const allowed = role === 'owner' || role === 'manager' || role === 'kitchen_staff'
    const n = await bumped(t.kotId)
    check(`role ${role}: bump ${allowed ? 'allowed' : 'blocked'}`, allowed ? res.ok && n === 1 : !res.ok && n === 0)
    if (!allowed) {
      const raw = await attempt(() =>
        withUser(A.members[role].userId, (tx) =>
          tx.insert(schema.kotItems).values({ tenantId: A.tenantId, kotId: t.kotId, orderItemId: t.lines[1] }),
        ),
      )
      check(`role ${role}: direct kot_items insert rejected by RLS`, !raw.ok && (await bumped(t.kotId)) === 0)
    }
    const seen = await withUser(A.members[role].userId, (tx) => tx.select().from(schema.kotItems))
    check(`role ${role}: can read bump state`, seen.length > 0)
  }

  // ── 7. tenant isolation ───────────────────────────────────────────────────
  const iso = await fire(A)
  const cross = await attempt(() => withUser(B.members.owner.userId, (tx) => bumpKotItemCore(tx, actor(B, 'owner'), iso.kotId, iso.lines[0])))
  check('tenant B cannot bump tenant A ticket', !cross.ok && (await bumped(iso.kotId)) === 0)
  const bSees = await withUser(B.members.owner.userId, (tx) => tx.select().from(schema.kotItems))
  check("tenant B cannot read tenant A's kot_items", bSees.every((x) => x.tenantId === B.tenantId))

  // ── 8. flag off again: reconcile is a no-op ───────────────────────────────
  await withUser(A.members.owner.userId, (tx) => saveKdsSettingsCore(tx, A.tenantId, { enabled: false, warnMinutes: 5, lateMinutes: 10 }))
  const o2 = await fire(A, [1, 1, 1])
  await q(`update order_items set void_status='voided' where id=any($1)`, [[o2.lines[0], o2.lines[1]]])
  await withUser(A.members.owner.userId, (tx) => reconcileKotAfterLineChange(tx, A.tenantId, o2.orderId))
  check('flag off: reconcile leaves the ticket alone', (await status(o2.kotId)) === 'pending')

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
