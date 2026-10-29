/**
 * Reservation guard follow-ups (PR #43 review) against a real database.
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs --import ./scripts/next-runtime-hook.mjs scripts/test-reservations-followups.ts
 *
 *  1. A table with an open session (walk-in or seated reservation) is not
 *     accepted — or offered — for an overlapping reservation, staff or public.
 *  2. "Seat anyway" is manager-only and audited.
 *  3. Transfer and split apply the guard; a late no-show seated at its own table
 *     does too; event blocks count.
 *  4. Token check-in of a reservation seats it (same path as the staff action).
 *  5. Cancel / no-show are audited. Waitlist notify/seat need the waitlist on.
 *  6. Races: double-seat, and reservation-vs-seat, always leave exactly one winner.
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
const check = (l: string, c: boolean, detail?: unknown) => {
  console.log(`${c ? '✓' : '✗ FAIL'}  ${l}`)
  if (c) pass++
  else {
    fail++
    if (detail !== undefined) console.log('        got:', detail)
  }
}
const TZ = 'Asia/Kolkata'
const ROLES = ['owner', 'manager', 'cashier', 'receptionist', 'floor_staff', 'kitchen_staff'] as const
type Role = (typeof ROLES)[number]
const MIN = 60_000

async function main() {
  loadEnv()
  // @/db opens its pool at import time, so these must load after loadEnv().
  const svc = await import('../lib/reservations/service')
  const guard = await import('../lib/reservations/guard')
  const booking = await import('../lib/booking/service')
  const wl = await import('../lib/waitlist/service')
  const { withPublicTenant } = await import('../db')

  const ownerPool = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })
  const appPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 12 })
  const app = drizzle(appPool, { schema })
  const withUser = <T>(userId: string, fn: (tx: Db) => Promise<T>): Promise<T> =>
    app.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`)
      return fn(tx as unknown as Db)
    })
  const q = async (text: string, params: unknown[] = []) => (await ownerPool.query(text, params)).rows

  async function makeTenant(slug: string, tableCount = 40) {
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
    for (let i = 1; i <= tableCount; i++) {
      const r = await q(
        `insert into resources (tenant_id,branch_id,resource_type_id,name,sort_order) values ($1,$2,$3,$4,$5)
         on conflict (tenant_id,name) do update set status='available' returning id`,
        [tenantId, branchId, rt[0].id, `T${i}`, i],
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
      return { ok: false as const, msg: e instanceof Error ? e.message : String(e), code: cause?.code, err: e }
    }
  }
  const ctx = (t: T, role: Role = 'receptionist') => ({ tenantId: t.tenantId, timezone: TZ, membershipId: t.members[role].membershipId })
  const as = <R>(t: T, role: Role, fn: (tx: Db) => Promise<R>) => withUser(t.members[role].userId, fn)
  const inMin = (n: number) => new Date(Date.now() + n * MIN)
  const iso = (d: Date) => d.toISOString()

  const A = await makeTenant('testresfollowa')
  const ids = [A.tenantId]
  await q('delete from audit_log where tenant_id = any($1)', [ids])
  await q('delete from waitlist_entries where tenant_id = any($1)', [ids])
  await q('delete from bookings where tenant_id = any($1)', [ids])
  await q('delete from booking_slots where tenant_id = any($1)', [ids]) // event holds from an interrupted run
  await q('delete from events where tenant_id = any($1)', [ids])
  await q('delete from reservation_settings where tenant_id = any($1)', [ids])
  await q(
    `insert into reservation_settings (tenant_id,enabled,public_enabled,no_show_grace_minutes,walkin_buffer_minutes,max_party_size,default_duration_minutes,waitlist_enabled)
     values ($1,true,true,15,45,12,90,true)`,
    [A.tenantId],
  )
  // Every check uses its own table so nothing leaks between sections.
  let next = 0
  const table = () => A.tables[next++]
  const audits = async (action: string, entityId?: string) =>
    (await q(`select * from audit_log where tenant_id=$1 and action=$2 ${entityId ? 'and entity_id=$3' : ''}`, entityId ? [A.tenantId, action, entityId] : [A.tenantId, action])) as Record<string, unknown>[]

  const reserve = (tbl: string, start: Date, role: Role = 'receptionist', audience: 'staff' | 'public' = 'staff', extra: Record<string, unknown> = {}) => {
    const input = { branchId: A.branchId, resourceId: tbl, startsAt: iso(start), partySize: 4, customerName: 'Priya', customerPhone: '9876543210', ...extra }
    if (audience === 'public') {
      return withPublicTenant(A.tenantId, (tx) =>
        svc.createReservationCore(tx as never, { tenantId: A.tenantId, timezone: TZ, membershipId: null }, input, 'public'),
      )
    }
    return as(A, role, (tx) => svc.createReservationCore(tx, ctx(A, role), input, 'staff'))
  }
  const seatWalkin = (tbl: string, opts: { override?: boolean; role?: Role } = {}) =>
    as(A, opts.role ?? 'receptionist', (tx) =>
      booking.seatTableSessionCore(tx, ctx(A, opts.role ?? 'receptionist'), {
        branchId: A.branchId,
        resourceId: tbl,
        coverCount: 2,
        overrideReservation: opts.override,
      }),
    )
  const isConflict = (r: { ok: boolean; err?: unknown }) => !r.ok && r.err instanceof guard.ReservationConflictError

  // ── 1. an occupied table is neither offered nor accepted ─────────────────
  const t1 = table()
  await seatWalkin(t1) // a walk-in seated right now, no end time
  const during = await attempt(() => reserve(t1, inMin(45)))
  check('walk-in seated now: an overlapping reservation (now+45) is refused', !during.ok && /seated until/i.test(during.msg), during)
  check('…the same reservation after the party is expected to be gone is accepted', (await attempt(() => reserve(t1, inMin(120)))).ok)
  const free = await as(A, 'receptionist', (tx) => svc.freeTablesForWindow(tx, A.tenantId, A.branchId, inMin(45), inMin(100)))
  check('the occupied table is not offered for that window', !free.some((f) => f.id === t1) && free.length === A.tables.length - 1)
  const publicRes = await attempt(() => reserve(t1, inMin(50), 'receptionist', 'public'))
  check('the public storefront is refused too (it cannot read bookings itself)', !publicRes.ok && /not available/i.test(publicRes.msg), publicRes)
  const publicFree = await withPublicTenant(A.tenantId, (tx) => svc.freeTablesForWindow(tx as never, A.tenantId, A.branchId, inMin(45), inMin(100)))
  check('…and does not offer it', !publicFree.some((f) => f.id === t1))

  // seated RESERVATION: its slot is deleted when it is seated, so only the open session shows
  const t2 = table()
  const r2 = await reserve(t2, inMin(6))
  await as(A, 'receptionist', (tx) => svc.seatReservationCore(tx, ctx(A), { bookingId: r2.id }))
  check('a seated reservation has no slot left (the bug’s precondition)', (await q('select 1 from booking_slots where booking_id=$1', [r2.id])).length === 0)
  const overlap2 = await attempt(() => reserve(t2, inMin(60)))
  check('a later reservation inside the seated party’s window is refused', !overlap2.ok && /seated until/i.test(overlap2.msg), overlap2)
  check('one that starts after their 90 minutes is accepted', (await attempt(() => reserve(t2, inMin(100)))).ok)

  // ── 2. seat anyway: manager only, audited ─────────────────────────────────
  const t3 = table()
  const r3 = await reserve(t3, inMin(20))
  const blocked = await attempt(() => seatWalkin(t3))
  check('a walk-in is refused at a table reserved in 20 minutes', isConflict(blocked), blocked)
  for (const role of ROLES) {
    const allowed = role === 'owner' || role === 'manager'
    const g = await attempt(async () => guard.assertCanOverride(role, true))
    check(`seat anyway: ${role} ${allowed ? 'may' : 'may not'} override`, g.ok === allowed)
  }
  check('no override requested: any role passes the gate', (await attempt(async () => guard.assertCanOverride('floor_staff', undefined))).ok)
  const before = (await audits('table.seat_override')).length
  const forced = await attempt(() => seatWalkin(t3, { override: true, role: 'manager' }))
  check('with the override a manager seats over the reservation', forced.ok, forced)
  const ov = (await audits('table.seat_override')).slice(before)
  check('…and an audit row records who, what table and what it overrode', ov.length === 1 && ov[0].entity_id === t3 && ov[0].actor_membership_id === A.members.manager.membershipId && (ov[0].before as { blockingBookingId?: string }).blockingBookingId === r3.id, ov)
  const t3b = table()
  await seatWalkin(t3b) // an unblocked seating writes no override audit
  check('an ordinary seating writes no override audit', (await audits('table.seat_override')).length === before + 1)

  // ── 3. transfer / split / late no-show / events ──────────────────────────
  const src = table()
  const dst = table()
  const sess = await seatWalkin(src)
  await reserve(dst, inMin(20))
  const xfer = await attempt(() => as(A, 'floor_staff', (tx) => booking.transferTableCore(tx, ctx(A, 'floor_staff'), { bookingId: sess.id, targetResourceId: dst })))
  check('transfer onto a table reserved in 20 minutes is refused', isConflict(xfer), xfer)
  check('…and the party stays where it was', (await q('select resource_id from bookings where id=$1', [sess.id]))[0].resource_id === src)
  const xferOk = await attempt(() => as(A, 'manager', (tx) => booking.transferTableCore(tx, ctx(A, 'manager'), { bookingId: sess.id, targetResourceId: dst, overrideReservation: true })))
  check('a manager override lets the transfer through', xferOk.ok, xferOk)
  check('…and it is audited', (await audits('table.seat_override')).some((a) => a.entity_id === dst))

  const bigSrc = table()
  const splitDst = table()
  const big = await as(A, 'receptionist', (tx) => booking.seatTableSessionCore(tx, ctx(A), { branchId: A.branchId, resourceId: bigSrc, coverCount: 4 }))
  await reserve(splitDst, inMin(20))
  const split = await attempt(() =>
    as(A, 'floor_staff', (tx) => booking.splitTableCore(tx, ctx(A, 'floor_staff'), { sourceBookingId: big.id, targetResourceId: splitDst, orderIds: [], coverCount: 1 })),
  )
  check('split onto a table reserved in 20 minutes is refused', isConflict(split), split)

  // a late no-show seated at its OWN table, which has since been taken
  const t6 = table()
  const r6 = await reserve(t6, inMin(6))
  await q(`update bookings set status='no_show' where id=$1`, [r6.id]) // trigger releases its slot
  await reserve(t6, inMin(8)) // someone else now holds the table
  const late = await attempt(() => as(A, 'receptionist', (tx) => svc.seatReservationCore(tx, ctx(A), { bookingId: r6.id })))
  check('a late no-show is not seated over the party now holding its table', isConflict(late), late)
  check('…and is still unseated', (await q('select resource_id, status from bookings where id=$1', [r6.id]))[0].resource_id === null)
  const t6b = table()
  const rOwn = await reserve(t6b, inMin(6))
  const own = await attempt(() => as(A, 'receptionist', (tx) => svc.seatReservationCore(tx, ctx(A), { bookingId: rOwn.id })))
  check('a reservation never blocks its own seating', own.ok, own)

  // an event block is a hold on the table too
  const t7 = table()
  const evId = (
    await q(
      `insert into events (tenant_id,branch_id,title,type,starts_at,ends_at,status,resource_scope)
       values ($1,$2,'Quiz night','meetup',$3,$4,'draft'::event_status,'none'::event_resource_scope) returning id`,
      [A.tenantId, A.branchId, iso(inMin(10)), iso(inMin(120))],
    )
  )[0].id as string
  await q(`insert into booking_slots (tenant_id, event_id, resource_id, resource_name, resource_type_name, starts_at, ends_at, active) values ($1,$2,$3,'T7','Table',$4,$5,true)`, [A.tenantId, evId, t7, iso(inMin(10)), iso(inMin(120))])
  const ev = await attempt(() => seatWalkin(t7))
  check('a table blocked for an event is not seatable for a walk-in', isConflict(ev) && /event/i.test(ev.ok ? '' : ev.msg), ev)
  const evOk = await attempt(() => seatWalkin(t7, { override: true, role: 'owner' }))
  check('…unless a manager overrides (audited)', evOk.ok && (await audits('table.seat_override')).some((a) => a.entity_id === t7), evOk)

  // ── 4+5. the real server actions, signed in as real members ──────────────
  const { randomBytes, createHash } = await import('node:crypto')
  const g = globalThis as { __ARENA_TEST_SESSION?: string; __ARENA_TEST_HEADERS?: Record<string, string> }
  g.__ARENA_TEST_HEADERS = { 'x-tenant-slug': 'testresfollowa' }
  const signIn = async (role: Role) => {
    const token = randomBytes(32).toString('hex')
    await q(`insert into sessions (id, user_id, expires_at) values ($1,$2, now() + interval '1 day')`, [
      createHash('sha256').update(token).digest('hex'),
      A.members[role].userId,
    ])
    g.__ARENA_TEST_SESSION = token
  }
  const res = await import('../lib/actions/reservations')
  const bk = await import('../lib/actions/bookings')

  // token check-in of a reservation seats it, exactly like the staff action
  await signIn('receptionist')
  const t8 = table()
  const r8 = await reserve(t8, inMin(7))
  const tok8 = (await q('select confirmation_token from bookings where id=$1', [r8.id]))[0].confirmation_token as string
  const scan = await bk.checkInBookingByToken(tok8)
  const row8 = (await q('select status, resource_id from bookings where id=$1', [r8.id]))[0]
  check('token check-in of a reservation succeeds', !scan.error && scan.booking?.alreadyCheckedIn === false, scan)
  check('…and seats it: a table session, no live slot (not a bare status flip)', row8.status === 'checked_in' && row8.resource_id === t8 && (await q('select 1 from booking_slots where booking_id=$1 and active', [r8.id])).length === 0, row8)
  check('…recorded as the staff seating (audit reservation.seated)', (await audits('reservation.seated', r8.id)).length === 1)
  const scanAgain = await bk.checkInBookingByToken(tok8)
  check('scanning it again is a harmless "already checked in"', scanAgain.booking?.alreadyCheckedIn === true, scanAgain)

  // a late arrival (lapsed no-show) scanning the code is seated the same way
  const t8b = table()
  const r8b = await reserve(t8b, inMin(6))
  await q(`update bookings set status='no_show' where id=$1`, [r8b.id])
  const tok8b = (await q('select confirmation_token from bookings where id=$1', [r8b.id]))[0].confirmation_token as string
  const lateScan = await bk.checkInBookingByToken(tok8b)
  check('a late no-show scanning its code is seated', !lateScan.error && (await q('select resource_id from bookings where id=$1', [r8b.id]))[0].resource_id === t8b, lateScan)

  // cancel and no-show are audited
  const t9 = table()
  const r9 = await reserve(t9, inMin(200))
  const r9b = await reserve(table(), inMin(210))
  const canc = await res.cancelReservation({ bookingId: r9.id, reason: 'Guest called' })
  const ca = await audits('reservation.cancelled', r9.id)
  check('cancelling a reservation is audited with who and why', !canc.error && ca.length === 1 && ca[0].actor_membership_id === A.members.receptionist.membershipId && (ca[0].after as { reason?: string }).reason === 'Guest called', canc)
  const ns = await res.markReservationNoShow(r9b.id)
  const na = await audits('reservation.no_show', r9b.id)
  check('marking a no-show by hand is audited', !ns.error && na.length === 1 && na[0].actor_membership_id === A.members.receptionist.membershipId, ns)

  // seat anyway through the actions: floor staff refused before anything is written
  const t10 = table()
  await reserve(t10, inMin(20))
  await signIn('floor_staff')
  const fsOverride = await bk.seatTable({ branchId: A.branchId, resourceId: t10, coverCount: 2, overrideReservation: true })
  check('floor_staff cannot "seat anyway" (action refuses)', !!fsOverride.error && /manager/i.test(fsOverride.error) && (await q('select 1 from bookings where resource_id=$1', [t10])).length === 0, fsOverride)
  const fsPlain = await bk.seatTable({ branchId: A.branchId, resourceId: t10, coverCount: 2 })
  check('…and without the override they get the conflict prompt', fsPlain.reservationConflict === true, fsPlain)
  await signIn('manager')
  const mgr = await bk.seatTable({ branchId: A.branchId, resourceId: t10, coverCount: 2, overrideReservation: true })
  check('a manager can, through the action', !!mgr.bookingId && (await audits('table.seat_override')).some((x) => x.entity_id === t10), mgr)

  const wlOff = await (async () => {
    await q(`update reservation_settings set waitlist_enabled=true where tenant_id=$1`, [A.tenantId])
    const e = await as(A, 'receptionist', (tx) => wl.addWaitlistEntryCore(tx, ctx(A), { branchId: A.branchId, name: 'Walker', partySize: 2, phone: '9876500000' }))
    await q(`update reservation_settings set waitlist_enabled=false where tenant_id=$1`, [A.tenantId])
    const notify = await attempt(() => as(A, 'receptionist', (tx) => wl.markWaitlistNotifiedCore(tx, ctx(A), e.id, 'Venue')))
    const seat = await attempt(() => as(A, 'receptionist', (tx) => wl.seatWaitlistEntryCore(tx, ctx(A), { entryId: e.id, resourceId: table() })))
    await q(`update reservation_settings set waitlist_enabled=true where tenant_id=$1`, [A.tenantId])
    return { notify, seat }
  })()
  check('waitlist off: notify is refused', !wlOff.notify.ok && /not enabled/i.test(wlOff.notify.msg), wlOff.notify)
  check('waitlist off: seating from it is refused', !wlOff.seat.ok && /not enabled/i.test(wlOff.seat.msg), wlOff.seat)

  // ── 6. races ──────────────────────────────────────────────────────────────
  const race1 = table()
  const [s1, s2] = await Promise.all([attempt(() => seatWalkin(race1)), attempt(() => seatWalkin(race1))])
  check('double-seat race: exactly one party gets the table', [s1, s2].filter((x) => x.ok).length === 1, [s1.ok, s2.ok])
  check('…the open-session index refuses the loser', [s1, s2].some((x) => !x.ok && (x.code === '23505' || x.code === '23P01')), [s1, s2].map((x) => (x.ok ? 'ok' : x.code)))

  let exactlyOne = 0
  const rounds = 4
  for (let i = 0; i < rounds; i++) {
    const tb = table()
    const [seated, reserved] = await Promise.all([attempt(() => seatWalkin(tb)), attempt(() => reserve(tb, inMin(30)))])
    if ([seated, reserved].filter((x) => x.ok).length === 1) exactlyOne++
  }
  check(`reservation-vs-seat race (${rounds} rounds): never both, never neither`, exactlyOne === rounds, exactlyOne)

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
