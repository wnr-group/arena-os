/**
 * Table reservations + convert-to-seated (M20 / AROS-176) against a real database.
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs scripts/test-reservations.ts
 *
 * Covers: opt-in gate, reservation shape (booking + slot, no table session),
 * double-booking via the exclusion constraint, opening hours / past / party
 * size / public gates, the walk-in guard (+ override, + off by default),
 * convert-to-seated (same booking, slot dropped, occupied table, moved table,
 * late arrival), no-show lapse, billing untouched, and RLS per role + tenant.
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
  const svc = await import('../lib/reservations/service')
  const guard = await import('../lib/reservations/guard')
  const booking = await import('../lib/booking/service')
  const { addDays, todayInZone, zonedTimeToUtc } = await import('../lib/booking/time')

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
    // Open 24h every day so "now + 20 minutes" is always inside opening hours.
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

  const setSettings = (t: T, v: Partial<{ enabled: boolean; publicEnabled: boolean; grace: number; buffer: number; max: number; minutes: number }>) =>
    q(
      `insert into reservation_settings (tenant_id,enabled,public_enabled,no_show_grace_minutes,walkin_buffer_minutes,max_party_size,default_duration_minutes)
       values ($1,$2,$3,$4,$5,$6,$7)
       on conflict (tenant_id) do update set enabled=$2, public_enabled=$3, no_show_grace_minutes=$4, walkin_buffer_minutes=$5, max_party_size=$6, default_duration_minutes=$7`,
      [t.tenantId, v.enabled ?? true, v.publicEnabled ?? false, v.grace ?? 15, v.buffer ?? 45, v.max ?? 12, v.minutes ?? 90],
    )

  const iso = (d: Date) => d.toISOString()
  const inMin = (n: number) => new Date(Date.now() + n * MIN)
  const tomorrow = (hhmm: string) => zonedTimeToUtc(addDays(todayInZone(TZ), 1), hhmm, TZ)

  const reserve = (t: T, table: number, start: Date, extra: Partial<Parameters<typeof svc.createReservationCore>[2]> = {}, role: Role = 'receptionist', audience: 'staff' | 'public' = 'staff') =>
    as(t, role, (tx) =>
      svc.createReservationCore(
        tx,
        ctx(t, role),
        { branchId: t.branchId, resourceId: t.tables[table], startsAt: iso(start), partySize: 4, customerName: 'Priya', customerPhone: '9876543210', ...extra },
        audience,
      ),
    )
  const booking1 = async (id: string) => (await q('select * from bookings where id=$1', [id]))[0]
  const slots = async (id: string) => await q('select * from booking_slots where booking_id=$1', [id])
  const seatWalkin = (t: T, table: number, opts: { override?: boolean } = {}) =>
    as(t, 'receptionist', (tx) =>
      booking.seatTableSessionCore(tx, ctx(t), {
        branchId: t.branchId,
        resourceId: t.tables[table],
        coverCount: 2,
        overrideReservation: opts.override,
      }),
    )

  const A = await makeTenant('testreservea')
  const B = await makeTenant('testreserveb')
  const C = await makeTenant('testreservec')
  const ids = [A.tenantId, B.tenantId, C.tenantId]
  await q('delete from bookings where tenant_id = any($1)', [ids])
  await q('delete from reservation_settings where tenant_id = any($1)', [ids])

  // ── 1. off by default ─────────────────────────────────────────────────────
  const off = await attempt(() => reserve(A, 0, tomorrow('19:00')))
  check('reservations refused while the venue has not opted in', !off.ok && /not enabled/i.test(off.msg))

  // The walk-in path is byte-for-byte unchanged for a venue that never opted in.
  const w0 = await attempt(() => seatWalkin(A, 2))
  check('walk-in seats normally with reservations off (no settings row)', w0.ok)
  await q(`update bookings set status='completed' where tenant_id=$1`, [A.tenantId])

  await setSettings(A, { enabled: true })

  // ── 2. reservation shape ──────────────────────────────────────────────────
  const start = tomorrow('19:00')
  const r1 = await reserve(A, 0, start)
  const row1 = await booking1(r1.id)
  const sl1 = await slots(r1.id)
  check('reservation is a confirmed booking with cover count', row1.status === 'confirmed' && row1.cover_count === 4)
  check('reserved_for / reserved_minutes recorded', new Date(row1.reserved_for).getTime() === start.getTime() && row1.reserved_minutes === 90)
  check('no table session yet (resource_id null)', row1.resource_id === null)
  check('one active slot of the default length on that table', sl1.length === 1 && sl1[0].active === true && sl1[0].resource_id === A.tables[0] && new Date(sl1[0].ends_at).getTime() - new Date(sl1[0].starts_at).getTime() === 90 * MIN)
  check('table session unique index not consumed by a future reservation', (await q(`select count(*)::int c from bookings where resource_id=$1`, [A.tables[0]]))[0].c === 0)
  check('reservation is free of charge', Number(row1.total) === 0)

  // ── 3. no double-booking ──────────────────────────────────────────────────
  const dbl = await attempt(() => reserve(A, 0, new Date(start.getTime() + 60 * MIN)))
  check('overlapping reservation on the same table is rejected by the DB', !dbl.ok && dbl.code === '23P01')
  const adj = await attempt(() => reserve(A, 0, new Date(start.getTime() + 90 * MIN)))
  check('back-to-back reservation on the same table is allowed', adj.ok)
  const other = await attempt(() => reserve(A, 1, start))
  check('same time on another table is allowed', other.ok)

  // ── 4. validation ─────────────────────────────────────────────────────────
  check('past time refused', !(await attempt(() => reserve(A, 2, inMin(-60)))).ok)
  check('party of 0 refused', !(await attempt(() => reserve(A, 2, tomorrow('20:00'), { partySize: 0 }))).ok)
  check('missing guest name refused', !(await attempt(() => reserve(A, 2, tomorrow('20:00'), { customerName: '  ' }))).ok)
  check('non-table resource refused', !(await attempt(async () => {
    const rt = await q(`insert into resource_types (tenant_id,name,hourly_rate) values ($1,'Pool',200) on conflict (tenant_id,name) do update set hourly_rate=200 returning id`, [A.tenantId])
    const r = await q(`insert into resources (tenant_id,branch_id,resource_type_id,name) values ($1,$2,$3,'P1') on conflict (tenant_id,name) do update set name='P1' returning id`, [A.tenantId, A.branchId, rt[0].id])
    return as(A, 'receptionist', (tx) => svc.createReservationCore(tx, ctx(A), { branchId: A.branchId, resourceId: r[0].id, startsAt: iso(tomorrow('20:00')), partySize: 2, customerName: 'X' }, 'staff'))
  })).ok)
  check('beyond the advance window refused (M37)', !(await attempt(() => reserve(A, 2, zonedTimeToUtc(addDays(todayInZone(TZ), 40), '19:00', TZ)))).ok)

  await q(`update working_hours set open_24h=false, open_time='10:00', close_time='22:00' where tenant_id=$1`, [A.tenantId])
  const closedHrs = await attempt(() => reserve(A, 2, tomorrow('03:00')))
  check('outside opening hours refused', !closedHrs.ok && /opening hours/i.test(closedHrs.msg))
  await q(`update working_hours set open_24h=true where tenant_id=$1`, [A.tenantId])

  // ── 5. public gate ────────────────────────────────────────────────────────
  const pubOff = await attempt(() => reserve(A, 2, tomorrow('20:00'), {}, 'receptionist', 'public'))
  check('public booking refused until the venue opens it to guests', !pubOff.ok && /not available/i.test(pubOff.msg))
  await setSettings(A, { enabled: true, publicEnabled: true, max: 6 })
  const pubBig = await attempt(() => reserve(A, 2, tomorrow('20:00'), { partySize: 8 }, 'receptionist', 'public'))
  check('public party over the cap refused', !pubBig.ok && /call us/i.test(pubBig.msg))
  const pubLen = await attempt(() => reserve(A, 2, tomorrow('20:00'), { durationMinutes: 400 }, 'receptionist', 'public'))
  check('public cannot choose its own length', !pubLen.ok)
  const staffBig = await attempt(() => reserve(A, 2, tomorrow('20:00'), { partySize: 8 }))
  check('staff may exceed the public cap', staffBig.ok)
  await setSettings(A, { enabled: true })

  // ── 6. start options + free tables ────────────────────────────────────────
  const opts = await as(A, 'receptionist', (tx) => svc.getReservationStartOptionsCore(tx, { id: A.tenantId, timezone: TZ }, { branchId: A.branchId, date: addDays(todayInZone(TZ), 1) }, 'staff'))
  const at19 = opts.options.find((o) => o.startsAt === iso(start))
  const at18 = opts.options.find((o) => o.startsAt === iso(tomorrow('18:00')))
  check('a fully booked slot (all 3 tables overlap 19:00) is not offered', at19 === undefined)
  check('18:00 offers exactly the one table not overlapping 19:00', !!at18 && at18.freeTables === 1)
  const free = await as(A, 'receptionist', (tx) => svc.freeTablesForWindow(tx, A.tenantId, A.branchId, start, new Date(start.getTime() + 90 * MIN)))
  check('no table is free for the booked 19:00 window', free.length === 0)
  const free18 = await as(A, 'receptionist', (tx) => svc.freeTablesForWindow(tx, A.tenantId, A.branchId, tomorrow('18:00'), new Date(tomorrow('18:00').getTime() + 90 * MIN)))
  check('free tables for a 90 min stay at 18:00 is just the unbooked T3 (T1/T2 start at 19:00)', free18.length === 1 && free18[0].id === A.tables[2])

  // ── 7. walk-in guard ──────────────────────────────────────────────────────
  await q(`delete from bookings where tenant_id=$1`, [A.tenantId])
  await setSettings(A, { enabled: true, buffer: 45, grace: 15 })
  const soon = await reserve(A, 0, inMin(20))
  const blocked = await attempt(() => seatWalkin(A, 0))
  check('walk-in refused when a reservation starts within the buffer', !blocked.ok && blocked.err instanceof guard.ReservationConflictError)
  check('refusal is the dedicated conflict error the floor offers "seat anyway" for', !blocked.ok && /reserved/i.test(blocked.msg))
  const forced = await attempt(() => seatWalkin(A, 0, { override: true }))
  check('"seat anyway" override seats the walk-in', forced.ok)
  await q(`update bookings set status='completed' where id=$1`, [forced.ok ? forced.v.id : null])
  const otherTable = await attempt(() => seatWalkin(A, 1))
  check('walk-in on a table with no reservation is unaffected', otherTable.ok)
  await q(`update bookings set status='completed' where resource_id=$1`, [A.tables[1]])

  await q(`delete from bookings where id=$1`, [soon.id])
  const later = await reserve(A, 0, inMin(180))
  const farOk = await attempt(() => seatWalkin(A, 0))
  check('walk-in allowed when the reservation is beyond the buffer', farOk.ok)
  await q(`update bookings set status='completed' where resource_id=$1`, [A.tables[0]])
  await q(`delete from bookings where id=$1`, [later.id])

  // ── 8. convert to seated ──────────────────────────────────────────────────
  const arriving = await reserve(A, 0, inMin(10), { partySize: 3 })
  const bookingsBefore = (await q(`select count(*)::int c from bookings where tenant_id=$1`, [A.tenantId]))[0].c
  const seated = await as(A, 'floor_staff', (tx) => svc.seatReservationCore(tx, ctx(A, 'floor_staff'), { bookingId: arriving.id }))
  const sRow = await booking1(arriving.id)
  check('seating converts the SAME booking (no second booking created)', (await q(`select count(*)::int c from bookings where tenant_id=$1`, [A.tenantId]))[0].c === bookingsBefore)
  check('it is now a checked-in table session on the reserved table', sRow.status === 'checked_in' && sRow.resource_id === A.tables[0] && sRow.cover_count === 3 && !!sRow.checked_in_at)
  check('reservation slot is dropped (seated table is invisible to the exclusion constraint)', (await slots(arriving.id)).length === 0)
  check('the original reservation window survives on the booking', !!sRow.reserved_for && sRow.reserved_minutes === 90)
  check('seating is audited with the original window', (await q(`select 1 from audit_log where entity_id=$1 and action='reservation.seated' and before ? 'startsAt'`, [arriving.id])).length === 1)
  check('seat result names the table', seated.tableName === 'T1')

  const again = await attempt(() => as(A, 'receptionist', (tx) => svc.seatReservationCore(tx, ctx(A), { bookingId: arriving.id })))
  check('seating twice is refused', !again.ok && /already seated/i.test(again.msg))
  const stat = await attempt(() => as(A, 'receptionist', (tx) => booking.seatTableSessionCore(tx, ctx(A), { branchId: A.branchId, resourceId: A.tables[0], coverCount: 2, overrideReservation: true })))
  check('a seated reservation occupies the table like any session (unique index)', !stat.ok && stat.constraint === 'idx_bookings_open_table_session')

  // reserved table occupied by someone else -> rejected and rolled back
  const occ = await reserve(A, 1, inMin(30))
  await seatWalkin(A, 1, { override: true })
  const occR = await attempt(() => as(A, 'receptionist', (tx) => svc.seatReservationCore(tx, ctx(A), { bookingId: occ.id })))
  check('seating onto an occupied table is rejected by the DB', !occR.ok && occR.constraint === 'idx_bookings_open_table_session')
  check('...and the reservation (slot + status) is untouched by the failed attempt', (await slots(occ.id)).length === 1 && (await booking1(occ.id)).status === 'confirmed')
  const moved = await as(A, 'receptionist', (tx) => svc.seatReservationCore(tx, ctx(A), { bookingId: occ.id, resourceId: A.tables[2], coverCount: 5 }))
  const mRow = await booking1(occ.id)
  check('party can be moved to another free table with a new head count', moved.resourceId === A.tables[2] && mRow.resource_id === A.tables[2] && mRow.cover_count === 5)

  // cancelled cannot be seated
  await setSettings(B, { enabled: true })
  const cxr = await reserve(B, 0, tomorrow('18:00'))
  await q(`update bookings set status='cancelled' where id=$1`, [cxr.id])
  const cxs = await attempt(() => as(B, 'receptionist', (tx) => svc.seatReservationCore(tx, ctx(B), { bookingId: cxr.id })))
  check('a cancelled reservation cannot be seated', !cxs.ok && /cancelled/i.test(cxs.msg))
  check('cancelling frees the table for rebooking', (await attempt(() => reserve(B, 0, tomorrow('18:00')))).ok)

  // a plain table session is not a reservation
  const plain = (await q(`select id from bookings where tenant_id=$1 and reserved_for is null limit 1`, [A.tenantId]))[0]
  const notRes = await attempt(() => as(A, 'receptionist', (tx) => svc.seatReservationCore(tx, ctx(A), { bookingId: plain.id })))
  check('seatReservation refuses a booking that was never a reservation', !notRes.ok && /not found/i.test(notRes.msg))

  // ── 9. no-show lapse + late arrival ───────────────────────────────────────
  await q(`update bookings set status='completed' where tenant_id=$1 and resource_id is not null`, [A.tenantId])
  const mk = async (minutesAgo: number, table: number) => {
    const s = inMin(-minutesAgo)
    const b = await q(
      `insert into bookings (tenant_id,branch_id,booking_number,status,source,cover_count,reserved_for,reserved_minutes,customer_name)
       values ($1,$2,$3,'confirmed','staff',2,$4,90,'Late Lata') returning id`,
      [A.tenantId, A.branchId, `BK-T-${Math.random().toString(36).slice(2, 8)}`, s],
    )
    await q(
      `insert into booking_slots (tenant_id,booking_id,resource_id,starts_at,ends_at,resource_name,resource_type_name)
       values ($1,$2,$3,$4,$5,'T','Table')`,
      [A.tenantId, b[0].id, A.tables[table], s, new Date(s.getTime() + 90 * MIN)],
    )
    return b[0].id as string
  }
  const within = await mk(10, 0) // inside the 15 min grace
  const overdue = await mk(30, 1) // past it
  const lapsed1 = await as(A, 'receptionist', (tx) => svc.lapseNoShowReservationsCore(tx, A.tenantId))
  check('only the overdue reservation lapses', lapsed1.lapsed === 1)
  check('overdue -> no_show, in-grace stays confirmed', (await booking1(overdue)).status === 'no_show' && (await booking1(within)).status === 'confirmed')
  check('lapse releases the slot (trigger) so the table can be rebooked', (await slots(overdue))[0].active === false)
  check('lapse is audited', (await q(`select 1 from audit_log where entity_id=$1 and action='reservation.no_show_lapsed'`, [overdue])).length === 1)
  check('lapse is idempotent', (await as(A, 'receptionist', (tx) => svc.lapseNoShowReservationsCore(tx, A.tenantId))).lapsed === 0)
  check('a lapsed reservation no longer blocks a walk-in', (await attempt(() => seatWalkin(A, 1))).ok)
  await q(`update bookings set status='completed' where resource_id=$1`, [A.tables[1]])

  const late = await attempt(() => as(A, 'receptionist', (tx) => svc.seatReservationCore(tx, ctx(A), { bookingId: overdue })))
  const lateRow = await booking1(overdue)
  check('a late arrival can still be seated after the lapse', late.ok && lateRow.status === 'checked_in' && lateRow.resource_id === A.tables[1])
  check('...and the audit records how late', (await q(`select (after->>'lateByMinutes')::int m from audit_log where entity_id=$1 and action='reservation.seated'`, [overdue]))[0].m >= 29)

  // lapse never touches other tenants' or non-reservation bookings
  await q(`update reservation_settings set no_show_grace_minutes=5 where tenant_id=$1`, [A.tenantId])
  const lapsedB = await as(B, 'owner', (tx) => svc.lapseNoShowReservationsCore(tx, B.tenantId))
  check('lapse is tenant-scoped', lapsedB.lapsed === 0 && (await booking1(within)).status === 'confirmed')
  await q(`update reservation_settings set no_show_grace_minutes=15 where tenant_id=$1`, [A.tenantId])

  // ── 10. RLS: reservation_settings per role + tenant ───────────────────────
  for (const role of ROLES) {
    const read = await as(A, role, (tx) => tx.select().from(schema.reservationSettings))
    check(`${role} can read own settings (and only own tenant's)`, read.length === 1 && read[0].tenantId === A.tenantId)
  }
  for (const role of ROLES) {
    const canManage = role === 'owner' || role === 'manager'
    const upd = await attempt(() =>
      as(A, role, (tx) => tx.update(schema.reservationSettings).set({ maxPartySize: 9 }).where(sql`tenant_id = ${A.tenantId}`).returning({ t: schema.reservationSettings.tenantId })),
    )
    check(`${role} ${canManage ? 'can' : 'cannot'} update settings`, upd.ok && (upd.v.length === 1) === canManage)
  }
  const cross = await as(A, 'owner', (tx) => tx.update(schema.reservationSettings).set({ maxPartySize: 3 }).where(sql`tenant_id = ${B.tenantId}`).returning({ t: schema.reservationSettings.tenantId }))
  check("owner of A cannot touch B's settings", cross.length === 0)
  const xIns = await attempt(() => as(A, 'owner', (tx) => tx.insert(schema.reservationSettings).values({ tenantId: C.tenantId, enabled: true })))
  check('owner of A cannot insert settings for tenant C (WITH CHECK)', !xIns.ok && xIns.code === '42501')
  check('...and nothing was written for C', (await q('select 1 from reservation_settings where tenant_id=$1', [C.tenantId])).length === 0)
  const lockOk = await as(A, 'receptionist', (tx) => tx.select({ id: schema.bookings.id }).from(schema.bookings).where(sql`id = ${within}`).for('update'))
  check('floor roles can lock reservation rows (FOR UPDATE matches an UPDATE policy, AROS-183)', lockOk.length === 1)
  const foreign = await as(B, 'owner', (tx) => tx.select({ id: schema.bookings.id }).from(schema.bookings).where(sql`id = ${within}`))
  check("another tenant cannot see A's reservations", foreign.length === 0)

  // ── 11. entitlement seeded ────────────────────────────────────────────────
  const ent = await q(`select lower(btrim(p.name)) n, pe.value::text v from plan_entitlements pe join plans p on p.id=pe.plan_id where pe.key='module.table_reservations'`)
  const vOf = (n: string) => ent.find((e) => e.n === n)?.v
  check('module.table_reservations: Pro and Enterprise on, Starter off', vOf('pro') === 'true' && vOf('enterprise') === 'true' && vOf('starter') === 'false')

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
