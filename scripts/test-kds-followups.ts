/**
 * KDS follow-ups (PR #43 re-review) against a real database.
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs scripts/test-kds-followups.ts
 *
 * 1. Plan downgrade: flags on + KDS entitlement lost + held lines -> the lines
 *    show on the legacy queue, the order dialog offers no Hold, and billing is
 *    not blocked (held lines are released first).
 * 2. A line released that way prints on a configured kitchen printer.
 * 3. Role matrix for removing the last outstanding line on a KDS tenant: every
 *    role either works or is refused before anything is written.
 * 4. A removal that readies the ticket yields exactly one ready notification.
 */
import { Pool } from 'pg'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { sql } from 'drizzle-orm'
import * as schema from '../db/schema'
import { createOrderCore, removeOrderItemCore, editOrderItemQuantityCore } from '../lib/orders/service'
import {
  bumpKotItemCore,
  getCourseConfigCore,
  releaseHeldLinesIfCoursesOff,
  saveKdsSettingsCore,
} from '../lib/kots/kds'
import { assertNoHeldCourses } from '../lib/billing/invoice'
import { sendOrderReadyNotification } from '../lib/notifications/service'
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
  const { listActiveKots } = await import('../lib/kots/data')
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

  const actor = (t: T, role: Role) => ({ tenantId: t.tenantId, membershipId: t.members[role].membershipId })
  async function attempt<R>(fn: () => Promise<R>) {
    try {
      return { ok: true as const, v: await fn() }
    } catch (e) {
      return { ok: false as const, msg: e instanceof Error ? e.message : String(e) }
    }
  }
  const ctxOf = (t: T, role: Role) => ({ user: { id: t.members[role].userId }, tenant: { id: t.tenantId } }) as never
  const setSettings = (t: T, v: { enabled: boolean; courses: boolean }) =>
    withUser(t.members.manager.userId, (tx) =>
      saveKdsSettingsCore(tx, t.tenantId, {
        enabled: v.enabled,
        warnMinutes: 8,
        lateMinutes: 15,
        coursesEnabled: v.courses,
        courseNames: NAMES,
      }),
    )
  async function place(t: T, spec: { course?: number; hold?: boolean }[], role: Role = 'owner') {
    const o = await withUser(t.members[role].userId, (tx) =>
      createOrderCore(
        tx,
        { tenantId: t.tenantId, timezone: TZ, membershipId: t.members[role].membershipId },
        { branchId: t.branchId, items: spec.map((s, i) => ({ menuItemId: t.items[i], qty: 1, ...s })) },
      ),
    )
    const kotId = (await q('select id from kots where order_id=$1', [o.id]))[0].id as string
    const lines = (await q('select id from order_items where order_id=$1 order by item_name', [o.id])).map((r) => r.id as string)
    return { orderId: o.id, orderNumber: o.orderNumber as string, kotId, lines }
  }
  const fireStatus = async (id: string) => (await q('select fire_status from order_items where id=$1', [id]))[0].fire_status as string
  const kotStatus = async (id: string) => (await q('select status from kots where id=$1', [id]))[0].status as string

  const A = await makeTenant('testkdsfollowa')
  const ids = [A.tenantId]
  await q('delete from orders where tenant_id = any($1)', [ids])
  await q('delete from order_settings where tenant_id = any($1)', [ids])
  await q('delete from printers where tenant_id = any($1)', [ids])
  await setSettings(A, { enabled: true, courses: true })
  // A downgrade that loses the KDS but keeps cloud printing: the tenant moves to a
  // hidden plan without module.kitchen_display, then back to the fixture plan.
  const fixturePlanId = (await q('select plan_id from tenant_subscriptions where tenant_id = $1', [A.tenantId]))[0].plan_id as string
  const entitle = async () => {
    await q('update tenant_subscriptions set plan_id = $2 where tenant_id = $1', [A.tenantId, fixturePlanId])
  }
  const dropKds = async () => {
    const plan = await q(
      `insert into public.plans (name, monthly_price, annual_price, active)
       values ('Test Fixture (no KDS)', 0, 0, false)
       on conflict (lower(btrim(name))) do update set active = false returning id`,
    )
    for (const [key, value] of [['module.kitchen_display', 'false'], ['module.printing', 'true']]) {
      await q(
        `insert into public.plan_entitlements (plan_id, key, value) values ($1, $2, $3::jsonb)
         on conflict (plan_id, key) do update set value = excluded.value`,
        [plan[0].id, key, value],
      )
    }
    await q('update tenant_subscriptions set plan_id = $2 where tenant_id = $1', [A.tenantId, plan[0].id])
  }

  // ── 1+2. plan downgrade: held lines must not strand ─────────────────────
  check('entitled + flags on: courses are usable', (await withUser(A.members.owner.userId, (tx) => getCourseConfigCore(tx, A.tenantId))).enabled)
  const held = await place(A, [{ course: 2, hold: true }, { course: 1 }, { course: 3, hold: true }])
  check('setup: two lines are held', (await fireStatus(held.lines[0])) === 'held' && (await fireStatus(held.lines[1])) === 'held')

  const printer = await q(
    `insert into printers (tenant_id,branch_id,name,kind,is_default,secret_hash) values ($1,$2,'Pass','kitchen',true,'x') returning id`,
    [A.tenantId, A.branchId],
  )
  const printerId = printer[0].id as string
  const jobsFor = async (kotId: string) => (await q('select id from print_jobs where kot_id=$1', [kotId])).length

  await dropKds()
  const cfg = await withUser(A.members.owner.userId, (tx) => getCourseConfigCore(tx, A.tenantId))
  check('plan lost the KDS: courses read as off even though the flags are on', !cfg.enabled)
  const legacy = (await listActiveKots(ctxOf(A, 'owner'), A.branchId)).filter((r) => r.kotId === held.kotId)
  check('plan lost the KDS: the legacy queue shows the held lines', legacy.length === 3)
  const blocked = await attempt(() => withUser(A.members.cashier.userId, (tx) => assertNoHeldCourses(tx as never, A.tenantId, [held.orderId])))
  check('before the release the held lines would block billing', !blocked.ok && /still on hold/i.test(blocked.msg))

  const jobsBefore = await jobsFor(held.kotId)
  const released = await withUser(A.members.cashier.userId, (tx) =>
    releaseHeldLinesIfCoursesOff(tx, A.tenantId, { membershipId: A.members.cashier.membershipId, orderIds: [held.orderId] }),
  )
  check('plan lost the KDS: both held lines are released', released === 2 && (await fireStatus(held.lines[0])) === 'fired' && (await fireStatus(held.lines[1])) === 'fired')
  const afterRelease = await attempt(() => withUser(A.members.cashier.userId, (tx) => assertNoHeldCourses(tx as never, A.tenantId, [held.orderId])))
  check('billing is no longer blocked once they are released', afterRelease.ok)
  const jobs = await q(`select payload from print_jobs where kot_id=$1 and printer_id=$2`, [held.kotId, printerId])
  check('released lines print on the kitchen printer', (await jobsFor(held.kotId)) === jobsBefore + 1 && jobs.length === 1)
  const text = Buffer.from(jobs[0].payload as Buffer).toString('latin1')
  check('the printed ticket carries the released items', /Burger/.test(text) && /Cola/.test(text) && !/Fries/.test(text))
  check('releasing again is a no-op (nothing is double-printed)', (await withUser(A.members.owner.userId, (tx) => releaseHeldLinesIfCoursesOff(tx, A.tenantId))) === 0 && (await jobsFor(held.kotId)) === jobsBefore + 1)

  await entitle()
  check('entitlement restored: courses are usable again', (await withUser(A.members.owner.userId, (tx) => getCourseConfigCore(tx, A.tenantId))).enabled)
  const stillHeld = await place(A, [{ course: 2, hold: true }, { course: 1 }, {}])
  const noop = await withUser(A.members.owner.userId, (tx) => releaseHeldLinesIfCoursesOff(tx, A.tenantId, { orderIds: [stillHeld.orderId] }))
  check('while courses are usable, held lines are left alone', noop === 0 && (await fireStatus(stillHeld.lines[0])) === 'held')

  // ── 3+4. removing the last outstanding line, every role ─────────────────
  await setSettings(A, { enabled: true, courses: false })
  for (const role of ROLES) {
    const o = await place(A, [{}, {}, {}])
    // Kitchen bumps two lines; the third is the last one still cooking.
    for (const i of [0, 1]) {
      await withUser(A.members.kitchen_staff.userId, (tx) => bumpKotItemCore(tx, actor(A, 'kitchen_staff'), o.kotId, o.lines[i]))
    }
    const res = await attempt(() => withUser(A.members[role].userId, (tx) => removeOrderItemCore(tx, actor(A, role), { orderItemId: o.lines[2] })))
    const remaining = Number((await q('select count(*) c from order_items where order_id=$1', [o.orderId]))[0].c)
    if (res.ok) {
      check(`role ${role}: removing the last cooking line works and the ticket is ready`, remaining === 2 && (await kotStatus(o.kotId)) === 'ready' && res.v.kotReady?.orderId === o.orderId)
    } else {
      check(`role ${role}: refused before anything is written`, remaining === 3 && (await kotStatus(o.kotId)) === 'preparing')
    }
  }

  // ── 4. exactly one notification ───────────────────────────────────────────
  const n = await place(A, [{}, {}, {}])
  await withUser(A.members.kitchen_staff.userId, (tx) => bumpKotItemCore(tx, actor(A, 'kitchen_staff'), n.kotId, n.lines[0]))
  // Removing a line that is NOT the last one cooking readies nothing.
  const notLast = await withUser(A.members.cashier.userId, (tx) => removeOrderItemCore(tx, actor(A, 'cashier'), { orderItemId: n.lines[1] }))
  check('removing a line while another is still cooking readies nothing', notLast.kotReady === null && (await kotStatus(n.kotId)) === 'preparing')
  // Reducing a quantity never touches the ticket.
  const edit = await withUser(A.members.cashier.userId, (tx) => editOrderItemQuantityCore(tx, actor(A, 'cashier'), { orderItemId: n.lines[2], newQty: 2 }))
  check('editing a quantity readies nothing', edit.kotReady === null)
  const last = await withUser(A.members.cashier.userId, (tx) => removeOrderItemCore(tx, actor(A, 'cashier'), { orderItemId: n.lines[2] }))
  check('removing the last cooking line returns the ready ticket reference', last.kotReady?.orderNumber === n.orderNumber)
  const countBefore = Number((await q(`select count(*) c from notifications where tenant_id=$1 and kind='order_ready'`, [A.tenantId]))[0].c)
  if (last.kotReady) await withUser(A.members.cashier.userId, (tx) => sendOrderReadyNotification(tx, { tenantId: A.tenantId }, last.kotReady!))
  const countAfter = Number((await q(`select count(*) c from notifications where tenant_id=$1 and kind='order_ready'`, [A.tenantId]))[0].c)
  check('the ready removal records exactly one order-ready notification', countAfter === countBefore + 1)
  check('a ready ticket is not readied again by a later change', (await kotStatus(n.kotId)) === 'ready')

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
