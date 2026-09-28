/**
 * The DATA behind the walk-in "check availability" calendar (M23) —
 * listWalkinResources' `nextBooking` field (lib/booking/walkin.ts), the one
 * this ticket added. Same shape of test as scripts/test-day-bookings-overlap.ts:
 * a synthetic tenant/branch/resources, real rows inserted as the owner role,
 * then the reader called directly (no server action / Next runtime needed —
 * listWalkinResources is a plain function over an ActiveContext).
 *
 * The pure minutes/formatting math (30 min / 1h 17m / 3h / open-ended) is
 * pinned separately in scripts/test-walkin-availability-window.ts, which
 * needs no database at all — this script's job is only to prove the QUERY
 * feeds that math the right `nextBooking.startsAt`, independently per
 * resource, and that cancelled/completed bookings never block it.
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs scripts/test-walkin-availability-query.ts
 */
import { Pool } from 'pg'
import { loadEnv } from './env'
import type { ActiveContext } from '../lib/tenant/context'

let pass = 0,
  fail = 0
const check = (l: string, c: boolean) => {
  console.log(`${c ? '✓' : '✗ FAIL'}  ${l}`)
  if (c) pass++
  else fail++
}
const section = (s: string) => console.log(`\n── ${s} ──`)

const TZ = 'Asia/Kolkata'
const NOW = new Date('2045-03-20T09:00:00Z') // fixed instant, so "later today" is deterministic

async function main() {
  loadEnv()
  const { listWalkinResources } = await import('../lib/booking/walkin')

  const owner = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })

  const slug = 'testwalkinavail'
  const t = await owner.query<{ id: string }>(
    `insert into tenants (slug,name,status,timezone,industry) values ($1,$2,'active',$3,'gaming_cafe')
     on conflict (slug) do update set name=excluded.name returning id`,
    [slug, `${slug} co`, TZ],
  )
  const tenantId = t.rows[0].id
  const b = await owner.query<{ id: string }>(
    `insert into branches (tenant_id,name,is_primary) values ($1,'Main',true)
     on conflict (tenant_id,name) do update set is_primary=true returning id`,
    [tenantId],
  )
  const branchId = b.rows[0].id
  const u = await owner.query<{ id: string }>(
    `insert into users (email,password_hash) values ($1,'x')
     on conflict (email) do update set email=excluded.email returning id`,
    [`owner@${slug}.test`],
  )
  const userId = u.rows[0].id
  const m = await owner.query<{ id: string }>(
    `insert into memberships (tenant_id,user_id,role,status) values ($1,$2,'owner','active')
     on conflict (tenant_id,user_id) do update set role='owner', status='active' returning id`,
    [tenantId, userId],
  )
  const rt = await owner.query<{ id: string }>(
    `insert into resource_types (tenant_id,name,hourly_rate) values ($1,'Snooker','250.00')
     on conflict (tenant_id,name) do update set hourly_rate='250.00' returning id`,
    [tenantId],
  )
  const resourceTypeId = rt.rows[0].id

  async function makeResource(name: string) {
    const r = await owner.query<{ id: string }>(
      `insert into resources (tenant_id,branch_id,resource_type_id,name,status)
       values ($1,$2,$3,$4,'available')
       on conflict (tenant_id,name) do update set status='available' returning id`,
      [tenantId, branchId, resourceTypeId, name],
    )
    return r.rows[0].id
  }
  const snooker1 = await makeResource('Snooker #1')
  const snooker2 = await makeResource('Snooker #2')
  const snooker3 = await makeResource('Snooker #3')

  const ctx: ActiveContext = {
    user: { id: userId, email: `owner@${slug}.test`, fullName: null, isPlatformAdmin: false },
    tenant: { id: tenantId, slug, name: `${slug} co`, industry: 'gaming_cafe', status: 'active', currency: 'INR', timezone: TZ },
    role: 'owner',
    membershipId: m.rows[0].id,
    branchId,
  }

  let seq = 0
  async function booking(status: string, customerName: string) {
    seq++
    const bk = await owner.query<{ id: string }>(
      `insert into bookings (tenant_id,branch_id,booking_number,status,customer_name,subtotal,total)
       values ($1,$2,$3,$4,$5,'0','0') returning id`,
      [tenantId, branchId, `WA-${seq}`, status, customerName],
    )
    return bk.rows[0].id
  }
  async function slot(bookingId: string, resourceId: string, from: Date, to: Date, active = true) {
    await owner.query(
      `insert into booking_slots (tenant_id,booking_id,resource_id,starts_at,ends_at,
         rate_applied,slot_total,resource_name,resource_type_name,active)
       values ($1,$2,$3,$4,$5,'250.00','250.00','X','Snooker',$6)`,
      [tenantId, bookingId, resourceId, from, to, active],
    )
  }
  const at = (hhmm: string) => {
    const [h, mi] = hhmm.split(':').map(Number)
    const d = new Date(NOW)
    d.setUTCHours(h, mi, 0, 0)
    return d
  }
  const wipe = async () => {
    await owner.query('delete from booking_slots where tenant_id=$1', [tenantId])
    await owner.query('delete from bookings where tenant_id=$1', [tenantId])
  }

  // ══ 1. resource-specific availability — the headline requirement ═════════
  section('Snooker #1 booked at 11:00, #2 free, #3 booked at 12:30')
  {
    await wipe()
    const bk1 = await booking('confirmed', 'Rahul')
    await slot(bk1, snooker1, at('11:00'), at('12:00'))
    const bk3 = await booking('confirmed', 'Priya')
    await slot(bk3, snooker3, at('12:30'), at('13:30'))

    const list = await listWalkinResources(ctx, branchId, NOW)
    const s1 = list.find((r) => r.id === snooker1)!
    const s2 = list.find((r) => r.id === snooker2)!
    const s3 = list.find((r) => r.id === snooker3)!

    check('Snooker #1 has a next booking at 11:00', s1.nextBooking?.startsAt === at('11:00').toISOString())
    check('…carrying the real customer name', s1.nextBooking?.customerName === 'Rahul')
    check('Snooker #2 has NO next booking — unaffected by #1 or #3', s2.nextBooking === null)
    check('…and hasUpcomingBooking is false for it', s2.hasUpcomingBooking === false)
    check('Snooker #3 has its OWN next booking at 12:30, not #1\'s', s3.nextBooking?.startsAt === at('12:30').toISOString())
    check('…carrying ITS OWN customer name', s3.nextBooking?.customerName === 'Priya')
  }

  // ══ 2. the earliest of several upcoming bookings wins ════════════════════
  section('two upcoming bookings on the same resource — earliest wins')
  {
    await wipe()
    const bkLater = await booking('confirmed', 'Later Customer')
    await slot(bkLater, snooker1, at('15:00'), at('16:00'))
    const bkSooner = await booking('confirmed', 'Sooner Customer')
    await slot(bkSooner, snooker1, at('11:30'), at('12:30'))

    const list = await listWalkinResources(ctx, branchId, NOW)
    const s1 = list.find((r) => r.id === snooker1)!
    check('the EARLIER booking is reported, not just the first row', s1.nextBooking?.startsAt === at('11:30').toISOString())
    check('…named correctly', s1.nextBooking?.customerName === 'Sooner Customer')
  }

  // ══ 3. cancelled / completed / no-show never block availability ═════════
  section('cancelled, completed and no-show bookings do not count')
  {
    await wipe()
    const bkCancelled = await booking('cancelled', 'Ghost')
    await slot(bkCancelled, snooker1, at('11:00'), at('12:00'), false) // trigger would also flip this
    const bkCompleted = await booking('completed', 'Done Already')
    await slot(bkCompleted, snooker1, at('07:00'), at('08:00'))
    const bkNoShow = await booking('no_show', 'Never Came')
    await slot(bkNoShow, snooker1, at('13:00'), at('14:00'), false)

    const list = await listWalkinResources(ctx, branchId, NOW)
    const s1 = list.find((r) => r.id === snooker1)!
    check('none of cancelled/completed/no-show produce a next booking', s1.nextBooking === null)
    check('…so the station reads as open-ended', s1.hasUpcomingBooking === false)
  }

  // ══ 4. a confirmed booking later today still counts ══════════════════════
  section('a real confirmed booking later today is reported')
  {
    await wipe()
    const bk = await booking('confirmed', 'Real Booking')
    await slot(bk, snooker2, at('17:30'), at('18:30'))

    const list = await listWalkinResources(ctx, branchId, NOW)
    const s2 = list.find((r) => r.id === snooker2)!
    check('Snooker #2 now reports its 17:30 booking', s2.nextBooking?.startsAt === at('17:30').toISOString())
    check('…and its end time too', s2.nextBooking?.endsAt === at('18:30').toISOString())
  }

  await wipe()
  await owner.end()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
