/**
 * Floor sections + server assignment (M20 / AROS-178) against a real database.
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs scripts/test-sections.ts
 *
 * Covers: sections CRUD, table -> section, server resolution (table beats
 * section), the server stamped on a seated session (walk-in, reservation,
 * waitlist, split), snapshot semantics, mid-shift hand-off, clear, per-session
 * reassignment, server validation, unchanged behaviour with no sections, RLS.
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
const ROLES = ['owner', 'manager', 'cashier', 'receptionist', 'floor_staff', 'kitchen_staff'] as const
type Role = (typeof ROLES)[number]
const MIN = 60_000

async function main() {
  loadEnv()
  // @/db opens its pool at import time, so these must load after loadEnv().
  const sec = await import('../lib/sections/service')
  const booking = await import('../lib/booking/service')
  const resv = await import('../lib/reservations/service')
  const wl = await import('../lib/waitlist/service')

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
    const branchId = b[0].id as string
    for (let d = 0; d < 7; d++) {
      await q(
        `insert into working_hours (tenant_id,branch_id,day_of_week,open_time,close_time,is_closed,open_24h)
         values ($1,$2,$3,'00:00','23:59',false,true)
         on conflict (branch_id,day_of_week) do update set open_24h=true, is_closed=false`,
        [tenantId, branchId, d],
      )
    }
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
    const rt = await q(
      `insert into resource_types (tenant_id,name,hourly_rate) values ($1,'Table','0')
       on conflict (tenant_id,name) do update set hourly_rate='0' returning id`,
      [tenantId],
    )
    const tables: string[] = []
    for (const name of ['T1', 'T2', 'T3', 'T4']) {
      const r = await q(
        `insert into resources (tenant_id,branch_id,resource_type_id,name,sort_order) values ($1,$2,$3,$4,$5)
         on conflict (tenant_id,name) do update set status='available' returning id`,
        [tenantId, branchId, rt[0].id, name, Number(name.slice(1))],
      )
      tables.push(r[0].id)
    }
    return { tenantId, branchId, members, tables }
  }
  type T = Awaited<ReturnType<typeof makeTenant>>

  async function attempt<R>(fn: () => Promise<R>) {
    try {
      return { ok: true as const, v: await fn() }
    } catch (e) {
      const cause = (e as { cause?: { code?: string } }).cause
      return { ok: false as const, msg: e instanceof Error ? e.message : String(e), code: cause?.code }
    }
  }
  const as = <R>(t: T, role: Role, fn: (tx: Db) => Promise<R>) => withUser(t.members[role].userId, fn)
  const actor = (t: T, role: Role = 'manager') => ({ tenantId: t.tenantId, membershipId: t.members[role].membershipId })
  const ctx = (t: T, role: Role = 'receptionist') => ({ tenantId: t.tenantId, timezone: TZ, membershipId: t.members[role].membershipId })
  const mgr = <R>(t: T, fn: (tx: Db, a: ReturnType<typeof actor>) => Promise<R>) => as(t, 'manager', (tx) => fn(tx, actor(t)))
  const seatWalkin = (t: T, table: number) =>
    as(t, 'receptionist', (tx) => booking.seatTableSessionCore(tx, ctx(t), { branchId: t.branchId, resourceId: t.tables[table], coverCount: 2 }))
  const serverOf = async (bookingId: string) => (await q('select server_id from bookings where id=$1', [bookingId]))[0].server_id as string | null

  const A = await makeTenant('testsectionsa')
  const B = await makeTenant('testsectionsb')
  const ids = [A.tenantId, B.tenantId]
  await q('delete from waitlist_entries where tenant_id = any($1)', [ids])
  await q('delete from bookings where tenant_id = any($1)', [ids])
  await q('delete from reservation_settings where tenant_id = any($1)', [ids])
  await q('update resources set section_id=null, assigned_server_id=null where tenant_id = any($1)', [ids])
  await q('delete from floor_sections where tenant_id = any($1)', [ids])
  const fs = A.members.floor_staff.membershipId
  const rec = A.members.receptionist.membershipId
  const cash = A.members.cashier.membershipId

  // ── 1. nothing configured: seating is unchanged ───────────────────────────
  const plain = await seatWalkin(A, 3)
  check('no sections / assignments: the session carries no server (behaviour unchanged)', (await serverOf(plain.id)) === null)
  await q(`update bookings set status='completed' where id=$1`, [plain.id])

  // ── 2. sections ───────────────────────────────────────────────────────────
  const main = await mgr(A, (tx, a) => sec.createSectionCore(tx, a, { branchId: A.branchId, name: 'Main dining' }))
  const patio = await mgr(A, (tx, a) => sec.createSectionCore(tx, a, { branchId: A.branchId, name: 'Patio' }))
  check('sections are ordered as created', (await q('select name from floor_sections where tenant_id=$1 order by sort_order', [A.tenantId])).map((r) => r.name).join() === 'Main dining,Patio')
  check('duplicate section name refused', !(await attempt(() => mgr(A, (tx, a) => sec.createSectionCore(tx, a, { branchId: A.branchId, name: 'Patio' })))).ok)
  check('blank section name refused', !(await attempt(() => mgr(A, (tx, a) => sec.createSectionCore(tx, a, { branchId: A.branchId, name: ' ' })))).ok)
  await mgr(A, (tx, a) => sec.renameSectionCore(tx, a, patio.id, 'Terrace'))
  check('section can be renamed', (await q('select name from floor_sections where id=$1', [patio.id]))[0].name === 'Terrace')

  await mgr(A, (tx, a) => sec.setTableSectionCore(tx, a, A.tables[0], main.id))
  await mgr(A, (tx, a) => sec.setTableSectionCore(tx, a, A.tables[1], main.id))
  await mgr(A, (tx, a) => sec.setTableSectionCore(tx, a, A.tables[2], patio.id))
  check('tables join sections', (await q('select count(*)::int c from resources where section_id=$1', [main.id]))[0].c === 2)
  const mainB = await mgr(B, (tx, a) => sec.createSectionCore(tx, a, { branchId: B.branchId, name: 'Other tenant' }))
  check("a table cannot be put in another tenant's section", !(await attempt(() => mgr(A, (tx, a) => sec.setTableSectionCore(tx, a, A.tables[0], mainB.id)))).ok)
  check('non-table resource refused', !(await attempt(async () => {
    const rt = await q(`insert into resource_types (tenant_id,name,hourly_rate) values ($1,'Pool',200) on conflict (tenant_id,name) do update set hourly_rate=200 returning id`, [A.tenantId])
    const r = await q(`insert into resources (tenant_id,branch_id,resource_type_id,name) values ($1,$2,$3,'P9') on conflict (tenant_id,name) do update set name='P9' returning id`, [A.tenantId, A.branchId, rt[0].id])
    return mgr(A, (tx, a) => sec.setTableSectionCore(tx, a, r[0].id, main.id))
  })).ok)

  // ── 3. server assignment + stamping ───────────────────────────────────────
  await mgr(A, (tx, a) => sec.setSectionServerCore(tx, a, main.id, fs))
  const s1 = await seatWalkin(A, 0)
  check("a walk-in at a sectioned table is stamped with the section's server", (await serverOf(s1.id)) === fs)
  await mgr(A, (tx, a) => sec.setTableServerCore(tx, a, A.tables[1], rec))
  const s2 = await seatWalkin(A, 1)
  check('a table-level server beats the section server', (await serverOf(s2.id)) === rec)
  const s3 = await seatWalkin(A, 2)
  check('a section with no server leaves the session unassigned', (await serverOf(s3.id)) === null)

  check('kitchen staff cannot be assigned as a server', !(await attempt(() => mgr(A, (tx, a) => sec.setSectionServerCore(tx, a, patio.id, A.members.kitchen_staff.membershipId)))).ok)
  check("another tenant's member cannot be assigned", !(await attempt(() => mgr(A, (tx, a) => sec.setSectionServerCore(tx, a, patio.id, B.members.floor_staff.membershipId)))).ok)
  await q(`update memberships set status='disabled' where id=$1`, [cash])
  check('an inactive member cannot be assigned', !(await attempt(() => mgr(A, (tx, a) => sec.setSectionServerCore(tx, a, patio.id, cash)))).ok)
  await q(`update memberships set status='active' where id=$1`, [cash])

  // ── 4. snapshot semantics ─────────────────────────────────────────────────
  await mgr(A, (tx, a) => sec.setSectionServerCore(tx, a, main.id, cash))
  check('re-assigning a section does NOT rewrite a running session (snapshot)', (await serverOf(s1.id)) === fs)
  const moved = await mgr(A, (tx, a) => sec.setSectionServerCore(tx, a, main.id, fs, { handOffOpenSessions: true }))
  check('...unless the manager asks to move the running tables too', (await serverOf(s1.id)) === fs && moved.movedSessions === 1)
  check('...and a table with its own server is left alone by a section change', (await serverOf(s2.id)) === rec)

  // ── 5. mid-shift hand-off ─────────────────────────────────────────────────
  await q(`update bookings set bill_requested_at=now() where id=$1`, [s2.id])
  const sBilled = s2.id
  const ho = await mgr(A, (tx, a) => sec.handOffServerCore(tx, a, rec, cash))
  check('hand-off moves sections/tables the server covered', ho.tables === 1)
  check('...and the table-level assignment now points at the new server', (await q('select assigned_server_id s from resources where id=$1', [A.tables[1]]))[0].s === cash)
  check('...but a table whose bill was already requested keeps its server', (await serverOf(sBilled)) === rec && ho.sessions === 0)
  const ho2 = await mgr(A, (tx, a) => sec.handOffServerCore(tx, a, fs, cash))
  check('hand-off moves the running sessions the server carried', (await serverOf(s1.id)) === cash && ho2.sessions === 1 && ho2.sections === 1)
  check('...and the section follows', (await q('select assigned_server_id s from floor_sections where id=$1', [main.id]))[0].s === cash)
  check('hand-off to the same person is refused', !(await attempt(() => mgr(A, (tx, a) => sec.handOffServerCore(tx, a, cash, cash)))).ok)
  const sAfter = await seatWalkin(A, 0).catch(() => null)
  check('after hand-off, new seatings go to the new server (table already occupied -> rejected)', sAfter === null)
  await q(`update bookings set status='completed' where tenant_id=$1`, [A.tenantId])
  const s4 = await seatWalkin(A, 0)
  check('...and once free, the next party is stamped with the new server', (await serverOf(s4.id)) === cash)

  // ── 6. per-session reassignment ───────────────────────────────────────────
  await as(A, 'receptionist', (tx) => sec.setSessionServerCore(tx, actor(A, 'receptionist'), s4.id, fs))
  check('a running session can be reassigned by hand', (await serverOf(s4.id)) === fs)
  await as(A, 'receptionist', (tx) => sec.setSessionServerCore(tx, actor(A, 'receptionist'), s4.id, null))
  check('...or cleared', (await serverOf(s4.id)) === null)
  await q(`update bookings set status='completed' where id=$1`, [s4.id])
  const closed = await attempt(() => as(A, 'receptionist', (tx) => sec.setSessionServerCore(tx, actor(A, 'receptionist'), s4.id, fs)))
  check('a closed session cannot be reassigned', !closed.ok && /closed/i.test(closed.msg))
  const notTable = await attempt(() => as(A, 'receptionist', (tx) => sec.setSessionServerCore(tx, actor(A, 'receptionist'), '00000000-0000-0000-0000-000000000000', fs)))
  check('an unknown session is refused', !notTable.ok)

  // ── 7. other seating paths stamp the server too ───────────────────────────
  await q(`update bookings set status='completed' where tenant_id=$1`, [A.tenantId])
  await mgr(A, (tx, a) => sec.setSectionServerCore(tx, a, main.id, fs))
  await q(`update resources set assigned_server_id=null where tenant_id=$1`, [A.tenantId])
  await q(`insert into reservation_settings (tenant_id,enabled,waitlist_enabled) values ($1,true,true) on conflict (tenant_id) do update set enabled=true, waitlist_enabled=true`, [A.tenantId])
  const rsv = await as(A, 'receptionist', (tx) =>
    resv.createReservationCore(tx, ctx(A), { branchId: A.branchId, resourceId: A.tables[0], startsAt: new Date(Date.now() + 10 * MIN).toISOString(), partySize: 2, customerName: 'Rita' }, 'staff'),
  )
  check('a reservation carries no server until seated', (await serverOf(rsv.id)) === null)
  await as(A, 'receptionist', (tx) => resv.seatReservationCore(tx, ctx(A), { bookingId: rsv.id }))
  check('seating a reservation stamps the table\'s server', (await serverOf(rsv.id)) === fs)
  const w = await as(A, 'receptionist', (tx) => wl.addWaitlistEntryCore(tx, ctx(A), { branchId: A.branchId, name: 'Wally', partySize: 2 }))
  const ws = await as(A, 'receptionist', (tx) => wl.seatWaitlistEntryCore(tx, ctx(A), { entryId: w.id, resourceId: A.tables[1] }))
  check('seating from the waitlist stamps the server', (await serverOf(ws.bookingId)) === fs)
  const big = await as(A, 'receptionist', (tx) => booking.seatTableSessionCore(tx, ctx(A), { branchId: A.branchId, resourceId: A.tables[3], coverCount: 4 }))
  await q(`update bookings set server_id=$2 where id=$1`, [big.id, cash])
  const split = await as(A, 'receptionist', (tx) =>
    booking.splitTableCore(tx, ctx(A), { sourceBookingId: big.id, targetResourceId: A.tables[2], orderIds: [], coverCount: 2 }),
  )
  check('a split-off party keeps the same server', (await serverOf(split.id)) === cash)

  // ── 8. clear + delete ─────────────────────────────────────────────────────
  const cl = await mgr(A, (tx, a) => sec.clearAssignmentsCore(tx, a))
  check('end-of-shift clear removes every assignment', cl.sections >= 1 && (await q('select count(*)::int c from floor_sections where tenant_id=$1 and assigned_server_id is not null', [A.tenantId]))[0].c === 0)
  check('...but running sessions keep their stamped server', (await serverOf(rsv.id)) === fs)
  await mgr(A, (tx, a) => sec.deleteSectionCore(tx, a, main.id))
  check('deleting a section un-sections its tables and leaves sessions alone', (await q('select count(*)::int c from resources where tenant_id=$1 and section_id=$2', [A.tenantId, main.id]))[0].c === 0 && (await serverOf(rsv.id)) === fs)

  // ── 9. RLS ────────────────────────────────────────────────────────────────
  for (const role of ROLES) {
    const read = await as(A, role, (tx) => tx.select().from(schema.floorSections))
    check(`${role} reads only its own tenant's sections`, read.every((r) => r.tenantId === A.tenantId) && read.length >= 1)
  }
  for (const role of ROLES) {
    const should = role === 'owner' || role === 'manager'
    const r = await attempt(() => as(A, role, (tx) => tx.insert(schema.floorSections).values({ tenantId: A.tenantId, branchId: A.branchId, name: `rls-${role}` }).returning({ id: schema.floorSections.id })))
    check(`${role} ${should ? 'can' : 'cannot'} create a section`, should ? r.ok : !r.ok && r.code === '42501')
  }
  for (const role of ROLES) {
    const should = role === 'owner' || role === 'manager'
    const u = await as(A, role, (tx) => tx.update(schema.floorSections).set({ sortOrder: 9 }).where(sql`id = ${patio.id}`).returning({ id: schema.floorSections.id }))
    check(`${role} ${should ? 'can' : 'cannot'} update a section`, (u.length === 1) === should)
  }
  const x1 = await as(A, 'owner', (tx) => tx.update(schema.floorSections).set({ name: 'hax' }).where(sql`id = ${mainB.id}`).returning({ id: schema.floorSections.id }))
  check("owner of A cannot update B's section", x1.length === 0)
  const x2 = await attempt(() => as(A, 'owner', (tx) => tx.insert(schema.floorSections).values({ tenantId: B.tenantId, branchId: B.branchId, name: 'x' })))
  check('owner of A cannot create a section in B (WITH CHECK)', !x2.ok && x2.code === '42501')

  // ── 10. entitlement ───────────────────────────────────────────────────────
  const ent = await q(`select lower(btrim(p.name)) n, pe.value::text v from plan_entitlements pe join plans p on p.id=pe.plan_id where pe.key='module.floor_sections'`)
  const vOf = (n: string) => ent.find((e) => e.n === n)?.v
  check('module.floor_sections: Pro and Enterprise on, Starter off', vOf('pro') === 'true' && vOf('enterprise') === 'true' && vOf('starter') === 'false')

  await q('delete from waitlist_entries where tenant_id = any($1)', [ids])
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
