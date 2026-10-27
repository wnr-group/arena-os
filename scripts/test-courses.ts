/**
 * Course firing (M19 / AROS-173) tests against a real database.
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs scripts/test-courses.ts
 *
 * Covers: opt-in gate, course snapshot, held lines hidden from the cook,
 * fire_order_course role matrix + tenant isolation, reopening ready/served
 * tickets, voids of held lines, and that kots RLS was NOT loosened.
 */
import { Pool } from 'pg'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { sql } from 'drizzle-orm'
import * as schema from '../db/schema'
import { createOrderCore } from '../lib/orders/service'
import { updateKotStatusCore } from '../lib/kots/service'
import {
  bumpKotItemCore,
  fireCourseCore,
  reconcileKotAfterLineChange,
  saveKdsSettingsCore,
} from '../lib/kots/kds'
import { assertNoHeldCourses } from '../lib/billing/invoice'
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
const NAMES = ['Starters', 'Mains', 'Desserts']
const ROLES = ['owner', 'manager', 'kitchen_staff', 'floor_staff', 'cashier', 'receptionist'] as const
type Role = (typeof ROLES)[number]

async function main() {
  loadEnv()
  // @/db opens its pool at import time, so it must load after loadEnv().
  const { getKdsBoard } = await import('../lib/kots/kds-data')
  const { listActiveKots, getKotForPrint } = await import('../lib/kots/data')
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

  /** Items: [Burger, Fries, Cola] each with optional course/hold. Lines come back ordered by name: Burger, Cola, Fries. */
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
    return { orderId: o.id, kotId, lines }
  }
  const fireAs = (t: T, role: Role, orderId: string, course: number) =>
    withUser(t.members[role].userId, (tx) => fireCourseCore(tx, orderId, course))
  const lineState = async (id: string) => (await q('select fire_status, course_no, course_name, fired_at from order_items where id=$1', [id]))[0]
  const board = (t: T) => getKdsBoard(ctxOf(t, 'kitchen_staff'), t.branchId)

  const A = await makeTenant('testcoursesa')
  const B = await makeTenant('testcoursesb')
  const ids = [A.tenantId, B.tenantId]
  await q('delete from orders where tenant_id = any($1)', [ids])
  await q('delete from order_settings where tenant_id = any($1)', [ids])
  const setSettings = (t: T, v: { enabled: boolean; courses: boolean; names?: string[] }, role: Role = 'manager') =>
    withUser(t.members[role].userId, (tx) =>
      saveKdsSettingsCore(tx, t.tenantId, {
        enabled: v.enabled,
        warnMinutes: 8,
        lateMinutes: 15,
        coursesEnabled: v.courses,
        courseNames: v.names ?? NAMES,
      }),
    )

  // ── 1. courses off: nothing changes ───────────────────────────────────────
  const plain = await place(A, [{}, {}, {}])
  const ps = await lineState(plain.lines[0])
  check('courses off: plain order lines are fired, course 1, no snapshot', ps.fire_status === 'fired' && ps.course_no === 1 && ps.course_name === null)
  const offHold = await attempt(() => place(A, [{ hold: true }, {}, {}]))
  check('courses off: holding a line is refused', !offHold.ok && /not turned on/i.test(offHold.msg))
  check('courses off: the refused order left nothing behind', Number((await q('select count(*) c from orders where tenant_id=$1', [A.tenantId]))[0].c) === 1)

  await q(`update kots set status='cancelled' where id=$1`, [plain.kotId]) // keep it out of the all-day counts

  // ── 2. settings ───────────────────────────────────────────────────────────
  await setSettings(A, { enabled: false, courses: true })
  const noKds = await attempt(() => place(A, [{ course: 1 }, {}, {}]))
  check('courses without the KDS are not usable', !noKds.ok && /not turned on/i.test(noKds.msg))
  check('settings: one course name rejected', !(await attempt(() => setSettings(A, { enabled: true, courses: true, names: ['Only'] }))).ok)
  check('settings: duplicate names rejected', !(await attempt(() => setSettings(A, { enabled: true, courses: true, names: ['Mains', 'mains'] }))).ok)
  check('settings: floor_staff cannot change them (RLS)', !(await attempt(() => setSettings(A, { enabled: true, courses: true }, 'floor_staff'))).ok)
  check('settings: manager can', (await attempt(() => setSettings(A, { enabled: true, courses: true }))).ok)

  // ── 3. ordering with courses ──────────────────────────────────────────────
  const badCourse = await attempt(() => place(A, [{ course: 4 }, {}, {}]))
  check('course outside the configured list is refused', !badCourse.ok)
  const o = await place(A, [{ course: 2, hold: true }, { course: 1 }, { course: 3, hold: true }], 'floor_staff')
  const burger = await lineState(o.lines[0])
  const cola = await lineState(o.lines[1])
  const fries = await lineState(o.lines[2])
  check('course name snapshotted on each line', burger.course_name === 'Mains' && fries.course_name === 'Starters' && cola.course_name === 'Desserts')
  check('held / fired set per line', burger.fire_status === 'held' && fries.fire_status === 'fired' && cola.fire_status === 'held' && burger.fired_at === null)

  // ── 4. held lines never reach the cook ────────────────────────────────────
  let b = await board(A)
  let tk = b.tickets.find((x) => x.kotId === o.kotId)!
  check('board: only the fired line is on the ticket', !!tk && tk.items.length === 1 && tk.items[0].name === 'Fries')
  check('board: held lines grouped by course', tk.held.map((g) => g.name).join() === 'Mains,Desserts' && tk.held[0].items[0].name === 'Burger')
  check('board: held lines are not in the all-day counts', !b.allDay.some((c) => c.name === 'Burger' || c.name === 'Cola'))
  const bumpHeld = await attempt(() => withUser(A.members.kitchen_staff.userId, (tx) => bumpKotItemCore(tx, actor(A, 'kitchen_staff'), o.kotId, o.lines[0])))
  check('a held line cannot be bumped', !bumpHeld.ok && /on hold/i.test(bumpHeld.msg))
  const r1 = await withUser(A.members.kitchen_staff.userId, (tx) => bumpKotItemCore(tx, actor(A, 'kitchen_staff'), o.kotId, o.lines[2]))
  check('bumping the only fired line makes the ticket ready (held lines do not block)', r1.status === 'ready' && (await status(o.kotId)) === 'ready')

  // ── 5. firing: roles ──────────────────────────────────────────────────────
  for (const role of ROLES) {
    const t = await place(A, [{ course: 2, hold: true }, { course: 1 }, {}])
    const res = await attempt(() => fireAs(A, role, t.orderId, 2))
    const allowed = role !== 'receptionist'
    const st = (await lineState(t.lines[0])).fire_status
    check(`role ${role}: fire ${allowed ? 'allowed' : 'blocked'}`, allowed ? res.ok && st === 'fired' : !res.ok && st === 'held')
  }
  const foreign = await place(A, [{ course: 2, hold: true }, { course: 1 }, {}])
  const xr = await attempt(() => fireAs(B, 'owner', foreign.orderId, 2))
  check("tenant B's owner cannot fire tenant A's course", !xr.ok && (await lineState(foreign.lines[0])).fire_status === 'held')

  // ── 6. firing semantics ───────────────────────────────────────────────────
  const n = await fireAs(A, 'floor_staff', o.orderId, 2)
  const burgerAfter = await lineState(o.lines[0])
  check('fire returns the number of lines fired and stamps fired_at', n.length === 1 && burgerAfter.fire_status === 'fired' && burgerAfter.fired_at !== null)
  check('firing reopens a ready ticket → preparing', (await status(o.kotId)) === 'preparing')
  check('other course stays held', (await lineState(o.lines[1])).fire_status === 'held')
  b = await board(A)
  tk = b.tickets.find((x) => x.kotId === o.kotId)!
  check('board: fired course is now on the ticket, dessert still held', tk.items.some((i) => i.name === 'Burger' && !i.bumped) && tk.held.length === 1 && tk.held[0].name === 'Desserts')
  check(
    'board: fired course counts toward all-day, timer restarts at fire time',
    b.allDay.some((c) => c.name === 'Burger') && new Date(tk.startedAt).getTime() >= new Date(burgerAfter.fired_at).getTime() - 1000,
  )
  const again = await attempt(() => fireAs(A, 'floor_staff', o.orderId, 2))
  check('firing a course with nothing held is refused', !again.ok && /nothing is being held/i.test(again.msg))

  // served course → fire the next one puts the ticket back on the board
  await withUser(A.members.kitchen_staff.userId, (tx) => bumpKotItemCore(tx, actor(A, 'kitchen_staff'), o.kotId, o.lines[0]))
  check('course 2 bumped → ticket ready again', (await status(o.kotId)) === 'ready')
  await withUser(A.members.kitchen_staff.userId, (tx) => updateKotStatusCore(tx, { tenantId: A.tenantId }, o.kotId, 'served'))
  await fireAs(A, 'cashier', o.orderId, 3)
  check('firing after the ticket was served reopens it', (await status(o.kotId)) === 'preparing')

  // ── 7. held-only order ────────────────────────────────────────────────────
  const ho = await place(A, [{ course: 2, hold: true }, { course: 2, hold: true }, { course: 3, hold: true }])
  b = await board(A)
  check('held-only order: in heldOnly, not on the active board', b.heldOnly.some((x) => x.kotId === ho.kotId) && !b.tickets.some((x) => x.kotId === ho.kotId))
  await withUser(A.members.manager.userId, (tx) => reconcileKotAfterLineChange(tx, A.tenantId, ho.orderId))
  check('held-only order is not auto-readied by reconcile', (await status(ho.kotId)) === 'pending')
  await fireAs(A, 'floor_staff', ho.orderId, 2)
  b = await board(A)
  check('firing it moves the table onto the active board', b.tickets.some((x) => x.kotId === ho.kotId && x.items.length === 2) && !b.heldOnly.some((x) => x.kotId === ho.kotId))

  // ── 8. void of a held line ────────────────────────────────────────────────
  const vh = await place(A, [{ course: 2, hold: true }, { course: 1 }, {}])
  await q(`update order_items set void_status='voided' where id=$1`, [vh.lines[0]])
  b = await board(A)
  check('voided held line leaves the board', (b.tickets.find((x) => x.kotId === vh.kotId)?.held.length ?? 0) === 0)
  const vf = await attempt(() => fireAs(A, 'owner', vh.orderId, 2))
  check('a voided held line is not fired', !vf.ok && (await lineState(vh.lines[0])).fire_status === 'held')

  // ── 9. policy was not loosened + flag off ─────────────────────────────────
  const direct = await withUser(A.members.floor_staff.userId, (tx) =>
    tx.update(schema.kots).set({ status: 'ready' }).where(sql`id = ${ho.kotId}`).returning({ id: schema.kots.id }),
  )
  check('floor_staff still cannot UPDATE kots directly', direct.length === 0)
  // ── 10. flag off with held lines (stranded courses) ───────────────────────
  // Billing refuses to charge food that is still on hold…
  const stranded = await place(A, [{ course: 2, hold: true }, { course: 1 }, { course: 3, hold: true }])
  const guard = await attempt(() => withUser(A.members.owner.userId, (tx) => assertNoHeldCourses(tx as never, A.tenantId, [stranded.orderId])))
  check('bill-time guard: a held course blocks billing', !guard.ok && /still on hold/i.test(guard.msg))
  await q(`update order_items set void_status='voided' where id = any($1)`, [[stranded.lines[0], stranded.lines[1]]])
  const guardVoided = await attempt(() => withUser(A.members.owner.userId, (tx) => assertNoHeldCourses(tx as never, A.tenantId, [stranded.orderId])))
  check('bill-time guard: voided held lines do not block', guardVoided.ok)
  await q(`update order_items set void_status='active' where id = any($1)`, [[stranded.lines[0], stranded.lines[1]]])

  // …and switching courses (or the KDS) off releases them instead of stranding them.
  await q(`update kots set status='ready' where id=$1`, [stranded.kotId])
  await setSettings(A, { enabled: true, courses: false })
  const afterOff = await Promise.all(stranded.lines.map(lineState))
  check('courses turned off: every held line is released (fired)', afterOff.every((l) => l.fire_status === 'fired') && afterOff[0].fired_at !== null && afterOff[1].fired_at !== null)
  check('courses turned off: a finished ticket is reopened for the released food', (await status(stranded.kotId)) === 'preparing')
  check('courses turned off: no live held line remains', Number((await q(`select count(*) c from order_items where tenant_id=$1 and fire_status='held' and void_status<>'voided' and order_id in (select id from orders where status='open')`, [A.tenantId]))[0].c) === 0)
  const legacy = (await listActiveKots(ctxOf(A, 'owner'), A.branchId)).filter((r) => r.kotId === stranded.kotId)
  check('legacy queue shows the released lines', legacy.length === 3)
  const printed = await getKotForPrint(ctxOf(A, 'owner'), stranded.kotId)
  check('legacy print shows the released lines', printed?.items.length === 3)

  // KDS switched off while courses stay flagged on: same release.
  await setSettings(A, { enabled: true, courses: true })
  const s2 = await place(A, [{ course: 2, hold: true }, { course: 1 }, {}])
  await setSettings(A, { enabled: false, courses: true })
  check('KDS turned off: held lines released too', (await lineState(s2.lines[0])).fire_status === 'fired')

  await setSettings(A, { enabled: true, courses: false })
  const hf = await attempt(() => place(A, [{ course: 2, hold: true }, {}, {}]))
  const ff = await attempt(() => fireAs(A, 'owner', ho.orderId, 3))
  check('courses turned off again: holding refused, firing refused', !hf.ok && !ff.ok)

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
