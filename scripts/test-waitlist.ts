/**
 * Walk-in waitlist + notify-when-ready (M20 / AROS-177) against a real database.
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs scripts/test-waitlist.ts
 *
 * Covers: opt-in gate, add/validate/normalise, notify (two-phase, graceful
 * skip with no SMS provider, click-to-chat link), seat-from-waitlist (opens the
 * real table session atomically, honours the open-session index and the
 * reservation guard), leave, wait estimate, RLS per role + tenant.
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
  const wl = await import('../lib/waitlist/service')
  const resv = await import('../lib/reservations/service')
  const guard = await import('../lib/reservations/guard')

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
        `insert into memberships (tenant_id,user_id,role,status) values ($1,$2,$3,'active')
         on conflict (tenant_id,user_id) do update set role=$3, status='active' returning id`,
        [tenantId, u[0].id, role],
      )
      members[role] = { userId: u[0].id, membershipId: m[0].id }
    }
    const rt = await q(
      `insert into resource_types (tenant_id,name,hourly_rate) values ($1,'Table','0')
       on conflict (tenant_id,name) do update set hourly_rate='0' returning id`,
      [tenantId],
    )
    const tables: string[] = []
    for (const name of ['T1', 'T2', 'T3']) {
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
      const cause = (e as { cause?: { code?: string; constraint?: string } }).cause
      return { ok: false as const, msg: e instanceof Error ? e.message : String(e), code: cause?.code, constraint: cause?.constraint, err: e }
    }
  }
  const ctx = (t: T, role: Role = 'receptionist') => ({ tenantId: t.tenantId, timezone: TZ, membershipId: t.members[role].membershipId })
  const as = <R>(t: T, role: Role, fn: (tx: Db) => Promise<R>) => withUser(t.members[role].userId, fn)
  const setSettings = (t: T, v: { waitlist?: boolean; reservations?: boolean } = {}) =>
    q(
      `insert into reservation_settings (tenant_id,enabled,waitlist_enabled) values ($1,$2,$3)
       on conflict (tenant_id) do update set enabled=$2, waitlist_enabled=$3`,
      [t.tenantId, v.reservations ?? false, v.waitlist ?? true],
    )
  const add = (t: T, extra: Partial<Parameters<typeof wl.addWaitlistEntryCore>[2]> = {}, role: Role = 'receptionist') =>
    as(t, role, (tx) => wl.addWaitlistEntryCore(tx, ctx(t, role), { branchId: t.branchId, name: 'Priya Sharma', phone: '9876543210', partySize: 4, quotedWaitMinutes: 20, ...extra }))
  const entry = async (id: string) => (await q('select * from waitlist_entries where id=$1', [id]))[0]
  const seat = (t: T, entryId: string, table: number, extra: Partial<Parameters<typeof wl.seatWaitlistEntryCore>[2]> = {}) =>
    as(t, 'receptionist', (tx) => wl.seatWaitlistEntryCore(tx, ctx(t), { entryId, resourceId: t.tables[table], ...extra }))

  const A = await makeTenant('testwaitlista')
  const B = await makeTenant('testwaitlistb')
  const C = await makeTenant('testwaitlistc')
  const ids = [A.tenantId, B.tenantId, C.tenantId]
  await q('delete from waitlist_entries where tenant_id = any($1)', [ids])
  await q('delete from bookings where tenant_id = any($1)', [ids])
  await q('delete from notifications where tenant_id = any($1)', [ids])
  await q('delete from reservation_settings where tenant_id = any($1)', [ids])

  // ── 1. off by default ─────────────────────────────────────────────────────
  const off = await attempt(() => add(A))
  check('waitlist refused until the venue switches it on', !off.ok && /not enabled/i.test(off.msg))
  await setSettings(A)
  await setSettings(B)

  // ── 2. add ────────────────────────────────────────────────────────────────
  const e1 = await add(A)
  const row1 = await entry(e1.id)
  check('entry starts waiting with the quote and party size', row1.status === 'waiting' && row1.party_size === 4 && row1.quoted_wait_minutes === 20)
  check('phone stored normalised (E.164)', row1.phone === '+919876543210')
  check('blank name refused', !(await attempt(() => add(A, { name: '  ' }))).ok)
  check('party of 0 refused', !(await attempt(() => add(A, { partySize: 0 }))).ok)
  check('invalid phone refused', !(await attempt(() => add(A, { phone: '12345' }))).ok)
  const noPhone = await add(A, { name: 'Walk-in Wally', phone: undefined, quotedWaitMinutes: null })
  check('phone and quote are optional', (await entry(noPhone.id)).phone === null && (await entry(noPhone.id)).quoted_wait_minutes === null)

  // ── 3. notify ─────────────────────────────────────────────────────────────
  const marked = await as(A, 'receptionist', (tx) => wl.markWaitlistNotifiedCore(tx, ctx(A), e1.id, 'Spice Route'))
  check('notify flags the party notified with a timestamp', (await entry(e1.id)).status === 'notified' && !!(await entry(e1.id)).notified_at)
  check('message names the guest and venue', marked.message.includes('Priya') && marked.message.includes('Spice Route'))
  check('click-to-chat link is built for a party with a phone', !!marked.whatsappUrl && marked.whatsappUrl.includes('919876543210'))
  const out = await as(A, 'receptionist', (tx) => wl.sendWaitlistReady(tx, { tenantId: A.tenantId }, { phone: marked.phone, message: marked.message }))
  check('no SMS provider -> gracefully skipped (not an error)', out.status === 'skipped' && out.skipReason === 'not_configured')
  const n1 = await q(`select * from notifications where tenant_id=$1 and kind='waitlist_ready'`, [A.tenantId])
  check('exactly one notifications row is recorded', n1.length === 1 && n1[0].status === 'skipped' && n1[0].recipient_phone === '+919876543210' && n1[0].order_id === null)

  const mNo = await as(A, 'receptionist', (tx) => wl.markWaitlistNotifiedCore(tx, ctx(A), noPhone.id, 'Spice Route'))
  const oNo = await as(A, 'receptionist', (tx) => wl.sendWaitlistReady(tx, { tenantId: A.tenantId }, { phone: mNo.phone, message: mNo.message }))
  check('no phone -> skipped/no_phone and no chat link', oNo.skipReason === 'no_phone' && mNo.whatsappUrl === null)
  check('a notified party can be notified again', (await attempt(() => as(A, 'receptionist', (tx) => wl.markWaitlistNotifiedCore(tx, ctx(A), e1.id, 'Spice Route')))).ok)

  // ── 4. leave ──────────────────────────────────────────────────────────────
  await as(A, 'receptionist', (tx) => wl.leaveWaitlistCore(tx, ctx(A), noPhone.id))
  check('leaving marks the party left', (await entry(noPhone.id)).status === 'left' && !!(await entry(noPhone.id)).left_at)
  const again = await attempt(() => as(A, 'receptionist', (tx) => wl.leaveWaitlistCore(tx, ctx(A), noPhone.id)))
  check('a party that already left cannot be removed/notified again', !again.ok && /already left/i.test(again.msg))
  check('notifying a party that left is refused', !(await attempt(() => as(A, 'receptionist', (tx) => wl.markWaitlistNotifiedCore(tx, ctx(A), noPhone.id, 'X')))).ok)

  // ── 5. seat from waitlist ─────────────────────────────────────────────────
  const seated = await seat(A, e1.id, 0)
  const bk = (await q('select * from bookings where id=$1', [seated.bookingId]))[0]
  const eSeated = await entry(e1.id)
  check('seating opens a real checked-in table session', bk.status === 'checked_in' && bk.resource_id === A.tables[0] && bk.cover_count === 4)
  check('the session carries the guest name and phone', bk.customer_name === 'Priya Sharma' && !!bk.customer_phone)
  check('entry is cleared: seated, linked to the booking', eSeated.status === 'seated' && eSeated.booking_id === seated.bookingId && !!eSeated.seated_at)
  check('a seated party cannot be seated twice', !(await attempt(() => seat(A, e1.id, 1))).ok)

  const e2 = await add(A, { name: 'Occupied Omar', partySize: 2 })
  const occ = await attempt(() => seat(A, e2.id, 0))
  check('seating at an occupied table is rejected by the DB', !occ.ok && occ.constraint === 'idx_bookings_open_table_session')
  check('...and the party stays waiting (atomic)', (await entry(e2.id)).status === 'waiting' && (await entry(e2.id)).booking_id === null)
  const custom = await seat(A, e2.id, 1, { coverCount: 3 })
  check('head count can be adjusted when seating', (await q('select cover_count c from bookings where id=$1', [custom.bookingId]))[0].c === 3)

  // reservation guard applies to waitlist seating (it goes through seatTableSessionCore)
  await q(`update reservation_settings set enabled=true where tenant_id=$1`, [A.tenantId])
  await as(A, 'receptionist', (tx) =>
    resv.createReservationCore(tx, ctx(A), { branchId: A.branchId, resourceId: A.tables[2], startsAt: new Date(Date.now() + 20 * MIN).toISOString(), partySize: 2, customerName: 'Reserved Ria' }, 'staff'),
  )
  const e3 = await add(A, { name: 'Guarded Gita', partySize: 2 })
  const g = await attempt(() => seat(A, e3.id, 2))
  check('a table about to be reserved is refused with the "seat anyway" error', !g.ok && g.err instanceof guard.ReservationConflictError)
  check('...and the party stays in the queue', (await entry(e3.id)).status === 'waiting')
  const gf = await attempt(() => seat(A, e3.id, 2, { overrideReservation: true }))
  check('"seat anyway" override seats them', gf.ok && (await entry(e3.id)).status === 'seated')

  // ── 6. wait estimate ──────────────────────────────────────────────────────
  const est0 = await as(B, 'receptionist', (tx) => wl.estimateNewPartyWait(tx, B.tenantId, B.branchId))
  check('empty restaurant: tables free, nobody ahead -> no wait', est0.minutes === 0 && est0.freeTables === 3 && est0.queueAhead === 0)
  check('default turnover until there is history', est0.avgTurnMinutes === 60)
  for (let i = 0; i < 3; i++) await add(B, { name: `W${i}`, phone: undefined })
  await q(
    `insert into bookings (tenant_id,branch_id,booking_number,status,source,cover_count,resource_id,checked_in_at)
     select $1,$2,'BK-W-'||g,'checked_in','walk_in',2,(array[$3,$4,$5]::uuid[])[g],now() - (g*10||' minutes')::interval from generate_series(1,3) g`,
    [B.tenantId, B.branchId, ...B.tables],
  )
  const est1 = await as(B, 'receptionist', (tx) => wl.estimateNewPartyWait(tx, B.tenantId, B.branchId))
  check('full house with 3 ahead: 0 free, queue counted', est1.freeTables === 0 && est1.queueAhead === 3)
  check('...and a positive, 5-minute-rounded quote', est1.minutes > 0 && est1.minutes % 5 === 0)
  // five finished 30 minute sessions -> turnover learned from real data
  for (let i = 0; i < 5; i++) {
    await q(
      `insert into bookings (tenant_id,branch_id,booking_number,status,source,cover_count,resource_id,checked_in_at,completed_at)
       values ($1,$2,$3,'completed','walk_in',2,$4,now() - interval '3 hours', now() - interval '2 hours 30 minutes')`,
      [B.tenantId, B.branchId, `BK-H-${i}`, B.tables[0]],
    )
  }
  const est2 = await as(B, 'receptionist', (tx) => wl.estimateNewPartyWait(tx, B.tenantId, B.branchId))
  check('average turnover is learned from finished sessions', est2.avgTurnMinutes === 30)

  // ── 7. RLS ────────────────────────────────────────────────────────────────
  const ins = (role: Role) =>
    attempt(() =>
      as(A, role, (tx) =>
        tx.insert(schema.waitlistEntries).values({ tenantId: A.tenantId, branchId: A.branchId, name: `rls-${role}`, partySize: 2 }).returning({ id: schema.waitlistEntries.id }),
      ),
    )
  for (const role of ROLES) {
    const should = role !== 'kitchen_staff'
    const r = await ins(role)
    check(`${role} ${should ? 'can' : 'cannot'} add to the waitlist`, should ? r.ok : !r.ok && r.code === '42501')
  }
  for (const role of ROLES) {
    const sel = await as(A, role, (tx) => tx.select({ id: schema.waitlistEntries.id }).from(schema.waitlistEntries))
    check(`${role} reads only its own tenant's waitlist`, sel.length > 0 && !(await q('select 1 from waitlist_entries where id = any($1) and tenant_id <> $2', [sel.map((s) => s.id), A.tenantId])).length)
  }
  const fresh = await add(A, { name: 'Upd', phone: undefined })
  for (const role of ROLES) {
    const should = role !== 'kitchen_staff'
    const u = await as(A, role, (tx) => tx.update(schema.waitlistEntries).set({ notes: `by ${role}` }).where(sql`id = ${fresh.id}`).returning({ id: schema.waitlistEntries.id }))
    check(`${role} ${should ? 'can' : 'cannot'} update an entry`, (u.length === 1) === should)
  }
  const lock = await as(A, 'floor_staff', (tx) => tx.select({ id: schema.waitlistEntries.id }).from(schema.waitlistEntries).where(sql`id = ${fresh.id}`).for('update'))
  check('floor_staff can lock an entry (FOR UPDATE matches an UPDATE policy, AROS-183)', lock.length === 1)
  for (const role of ROLES) {
    const should = role === 'owner' || role === 'manager'
    const victim = await add(A, { name: `del-${role}`, phone: undefined })
    const d = await as(A, role, (tx) => tx.delete(schema.waitlistEntries).where(sql`id = ${victim.id}`).returning({ id: schema.waitlistEntries.id }))
    check(`${role} ${should ? 'can' : 'cannot'} delete an entry`, (d.length === 1) === should)
  }
  const xr = await as(A, 'owner', (tx) => tx.select({ id: schema.waitlistEntries.id }).from(schema.waitlistEntries).where(sql`tenant_id = ${B.tenantId}`))
  check("owner of A cannot see B's waitlist", xr.length === 0)
  const xu = await as(A, 'owner', (tx) => tx.update(schema.waitlistEntries).set({ notes: 'hax' }).where(sql`tenant_id = ${B.tenantId}`).returning({ id: schema.waitlistEntries.id }))
  check("owner of A cannot update B's waitlist", xu.length === 0)
  const xi = await attempt(() => as(A, 'owner', (tx) => tx.insert(schema.waitlistEntries).values({ tenantId: C.tenantId, branchId: C.branchId, name: 'x', partySize: 1 })))
  check('owner of A cannot add an entry to tenant C (WITH CHECK)', !xi.ok && xi.code === '42501')

  // ── 8. entitlement ────────────────────────────────────────────────────────
  const ent = await q(`select lower(btrim(p.name)) n, pe.value::text v from plan_entitlements pe join plans p on p.id=pe.plan_id where pe.key='module.waitlist'`)
  const vOf = (n: string) => ent.find((e) => e.n === n)?.v
  check('module.waitlist: Pro and Enterprise on, Starter off', vOf('pro') === 'true' && vOf('enterprise') === 'true' && vOf('starter') === 'false')

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
