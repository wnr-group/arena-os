/**
 * The bookings page's day feed — which slots belong on which day.
 *
 * ── THE BUG THIS PINS ───────────────────────────────────────────────────────
 *
 * listDayBookings() selected slots by `starts_at` falling inside the day, so a
 * booking running 22:00 → 02:00 appeared on the day it began and vanished from
 * the next one — while still occupying its resource there. The timeline showed
 * the table as free; the availability picker, which does test overlap, refused
 * to book it. Two owner-side screens, two different answers.
 *
 * It is the same defect, and the same fix, as lib/actions/availability.ts:
 *
 *     starts_at < dayEnd AND ends_at > dayStart
 *
 * ── THE OTHER HALF ──────────────────────────────────────────────────────────
 *
 * Widening the query is not enough on its own. The timeline used to position a
 * bar by its LOCAL MINUTES-OF-DAY, which for a slot that began at 22:00
 * yesterday is 1320 — the far RIGHT of today's chart, when it should be flush
 * against the left. Positions are now measured from the displayed day's
 * midnight, so a carried-in slot is negative and clamps to the left edge. That
 * arithmetic is asserted here too, since it is what makes the widened query
 * render correctly.
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs scripts/test-day-bookings-overlap.ts
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

const TZ = 'Asia/Kolkata'
const D1 = '2045-03-20'
const D2 = '2045-03-21'
const D3 = '2045-03-22'

const ist = (day: string, hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number)
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCMinutes(d.getUTCMinutes() + h * 60 + m - (5 * 60 + 30))
  return d
}

/**
 * The timeline's positioning arithmetic, mirroring BookingsView so the rule is
 * pinned rather than eyeballed: minutes from the displayed day's midnight,
 * negative for a slot that began earlier. Uses the project's own zone helper,
 * exactly as the component does.
 */
let zonedTimeToUtc: (d: string, t: string, tz: string) => Date
const minutesIntoDay = (iso: string | Date, date: string) =>
  (new Date(iso).getTime() - zonedTimeToUtc(date, '00:00', TZ).getTime()) / 60_000

async function main() {
  loadEnv()
  const { listDayBookings } = await import('../lib/booking/data')
  ;({ zonedTimeToUtc } = await import('../lib/booking/time'))

  const owner = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })

  const slug = 'testdayoverlap'
  const t = await owner.query<{ id: string }>(
    `insert into tenants (slug,name,status,timezone) values ($1,$2,'active',$3)
     on conflict (slug) do update set name=excluded.name returning id`, [slug, `${slug} co`, TZ])
  const tenantId = t.rows[0].id
  const b = await owner.query<{ id: string }>(
    `insert into branches (tenant_id,name,is_primary) values ($1,'Main',true)
     on conflict (tenant_id,name) do update set is_primary=true returning id`, [tenantId])
  const branchId = b.rows[0].id
  const u = await owner.query<{ id: string }>(
    `insert into users (email,password_hash) values ($1,'x')
     on conflict (email) do update set email=excluded.email returning id`, [`owner@${slug}.test`])
  const userId = u.rows[0].id
  const m = await owner.query<{ id: string }>(
    `insert into memberships (tenant_id,user_id,role,status) values ($1,$2,'owner','active')
     on conflict (tenant_id,user_id) do update set role='owner', status='active' returning id`,
    [tenantId, userId])
  const rt = await owner.query<{ id: string }>(
    `insert into resource_types (tenant_id,name,hourly_rate) values ($1,'Table','250.00')
     on conflict (tenant_id,name) do update set hourly_rate='250.00' returning id`, [tenantId])
  const resourceId = (await owner.query<{ id: string }>(
    `insert into resources (tenant_id,branch_id,resource_type_id,name,status)
     values ($1,$2,$3,'T1','available')
     on conflict (tenant_id,name) do update set status='available' returning id`,
    [tenantId, branchId, rt.rows[0].id])).rows[0].id

  const ctx: ActiveContext = {
    user: { id: userId, email: `owner@${slug}.test`, fullName: null, isPlatformAdmin: false },
    tenant: { id: tenantId, slug, name: `${slug} co`, industry: 'gaming', status: 'active',
      currency: 'INR', timezone: TZ },
    role: 'owner',
    membershipId: m.rows[0].id,
    branchId,
  }

  const wipe = async () => {
    await owner.query('delete from booking_slots where tenant_id=$1', [tenantId])
    await owner.query('delete from bookings where tenant_id=$1', [tenantId])
  }
  await wipe()

  let seq = 0
  async function slot(number: string, from: Date, to: Date) {
    seq++
    const bk = await owner.query<{ id: string }>(
      `insert into bookings (tenant_id,branch_id,booking_number,status,customer_name,subtotal,total)
       values ($1,$2,$3,'confirmed',$4,'0','0') returning id`,
      [tenantId, branchId, `${number}-${seq}`, number])
    await owner.query(
      `insert into booking_slots (tenant_id,booking_id,resource_id,starts_at,ends_at,
         rate_applied,slot_total,resource_name,resource_type_name,active)
       values ($1,$2,$3,$4,$5,'250.00','250.00','T1','Table',true)`,
      [tenantId, bk.rows[0].id, resourceId, from, to])
    return bk.rows[0].id
  }

  const namesOn = async (date: string) =>
    (await listDayBookings(ctx, branchId, date, TZ)).map((s) => s.customerName).sort()

  // ══ 1. an overnight booking belongs to both days ═════════════════════════
  console.log('\n── 22:00 → 02:00, across midnight ──')
  {
    await wipe()
    await slot('OVERNIGHT', ist(D1, '22:00'), ist(D2, '02:00'))

    check('it appears on the day it starts', (await namesOn(D1)).includes('OVERNIGHT'))
    check('…and on the day it is still running', (await namesOn(D2)).includes('OVERNIGHT'))
    check('…but not on the day after that', (await namesOn(D3)).length === 0)
  }

  // ══ 2. it is positioned by its portion of each day ═══════════════════════
  console.log('\n── where the bar sits ──')
  {
    const startsAt = ist(D1, '22:00')
    const endsAt = ist(D2, '02:00')

    check('on D1 it starts at minute 1320 (22:00)', minutesIntoDay(startsAt, D1) === 1320)
    check('…and ends past midnight, at 1560', minutesIntoDay(endsAt, D1) === 1560)
    check('on D2 it starts BEFORE the day — minute −120',
      minutesIntoDay(startsAt, D2) === -120)
    check('…and ends at minute 120 (02:00)', minutesIntoDay(endsAt, D2) === 120)
    // The bug in one line: minutes-of-day would have put it at 1320 on D2 too,
    // i.e. hard right, instead of hard left.
    check('the old minutes-of-day rule would have misplaced it by a full day',
      minutesIntoDay(startsAt, D2) !== 1320)
  }

  // ══ 3. an ordinary booking is untouched ══════════════════════════════════
  console.log('\n── an ordinary same-day booking ──')
  {
    await wipe()
    await slot('NORMAL', ist(D2, '14:00'), ist(D2, '15:30'))
    check('it appears on its own day', (await namesOn(D2)).includes('NORMAL'))
    check('…and on no other', (await namesOn(D1)).length === 0 && (await namesOn(D3)).length === 0)
    check('positioned at 14:00 → 15:30', minutesIntoDay(ist(D2, '14:00'), D2) === 840 &&
      minutesIntoDay(ist(D2, '15:30'), D2) === 930)
  }

  // ══ 4. the day's edges ═══════════════════════════════════════════════════
  console.log('\n── touching the boundary ──')
  {
    await wipe()
    // Ends exactly at midnight: belongs to D1 only — the day is half-open.
    await slot('ENDS-AT-MIDNIGHT', ist(D1, '23:00'), ist(D2, '00:00'))
    // Starts exactly at midnight: belongs to D2 only.
    await slot('STARTS-AT-MIDNIGHT', ist(D2, '00:00'), ist(D2, '01:00'))

    const d1 = await namesOn(D1)
    const d2 = await namesOn(D2)
    check('a slot ending at midnight is on D1', d1.includes('ENDS-AT-MIDNIGHT'))
    check('…and NOT on D2 — the boundary is not an overlap',
      !d2.includes('ENDS-AT-MIDNIGHT'))
    check('a slot starting at midnight is on D2', d2.includes('STARTS-AT-MIDNIGHT'))
    check('…and NOT on D1', !d1.includes('STARTS-AT-MIDNIGHT'))
  }

  // ══ 5. a multi-day hold shows on every day it covers ═════════════════════
  console.log('\n── a hold spanning three days ──')
  {
    await wipe()
    await slot('LONG-HOLD', ist(D1, '18:00'), ist(D3, '09:00'))
    for (const d of [D1, D2, D3]) {
      check(`present on ${d}`, (await namesOn(d)).includes('LONG-HOLD'))
    }
    check('on the middle day it spans the whole of it',
      minutesIntoDay(ist(D1, '18:00'), D2) < 0 && minutesIntoDay(ist(D3, '09:00'), D2) > 1440)
  }

  // ══ 6. an inactive (cancelled/no-show) slot still appears ═══════════════
  // Reversed by this ticket: listDayBookings used to filter to `active = true`,
  // which meant the instant a booking was cancelled it vanished from this
  // query entirely — including from the Bookings page's own "Cancelled"
  // status filter, whose whole job is to show it. It is `active`, not absence
  // from this list, that BookingsView now uses to keep a freed slot off the
  // Timeline while still listing it in the Bookings table.
  console.log('\n── an inactive slot ──')
  {
    await wipe()
    await slot('CANCELLED', ist(D1, '22:00'), ist(D2, '02:00'))
    await owner.query('update booking_slots set active=false where tenant_id=$1', [tenantId])
    check('it still appears on the day it starts', (await namesOn(D1)).includes('CANCELLED'))
    check('…and on the day it was still running', (await namesOn(D2)).includes('CANCELLED'))
    const rows = await listDayBookings(ctx, branchId, D1, TZ)
    check('…flagged inactive, so the Timeline can filter it out', rows.every((r) => r.active === false))
  }

  // ══ 7. tenant isolation ══════════════════════════════════════════════════
  console.log('\n── isolation ──')
  {
    await wipe()
    await slot('MINE', ist(D2, '12:00'), ist(D2, '13:00'))
    const other = await owner.query<{ id: string }>(
      `insert into tenants (slug,name,status,timezone) values ('testdayother','other','active',$1)
       on conflict (slug) do update set name=excluded.name returning id`, [TZ])
    const ob = await owner.query<{ id: string }>(
      `insert into branches (tenant_id,name,is_primary) values ($1,'Main',true)
       on conflict (tenant_id,name) do update set is_primary=true returning id`, [other.rows[0].id])
    const ort = await owner.query<{ id: string }>(
      `insert into resource_types (tenant_id,name,hourly_rate) values ($1,'Table','250.00')
       on conflict (tenant_id,name) do update set hourly_rate='250.00' returning id`, [other.rows[0].id])
    const ores = await owner.query<{ id: string }>(
      `insert into resources (tenant_id,branch_id,resource_type_id,name,status)
       values ($1,$2,$3,'OtherT1','available')
       on conflict (tenant_id,name) do update set status='available' returning id`,
      [other.rows[0].id, ob.rows[0].id, ort.rows[0].id])
    const obk = await owner.query<{ id: string }>(
      `insert into bookings (tenant_id,branch_id,booking_number,status,customer_name,subtotal,total)
       values ($1,$2,'OTHER-1','confirmed','THEIRS','0','0') returning id`,
      [other.rows[0].id, ob.rows[0].id])
    await owner.query(
      `insert into booking_slots (tenant_id,booking_id,resource_id,starts_at,ends_at,
         rate_applied,slot_total,resource_name,resource_type_name,active)
       values ($1,$2,$3,$4,$5,'250.00','250.00','OtherT1','Table',true)`,
      [other.rows[0].id, obk.rows[0].id, ores.rows[0].id, ist(D2, '12:00'), ist(D2, '13:00')])

    const mine = await namesOn(D2)
    check('only this tenant\'s booking is returned', mine.length === 1 && mine[0] === 'MINE')

    await owner.query('delete from booking_slots where tenant_id=$1', [other.rows[0].id])
    await owner.query('delete from bookings where tenant_id=$1', [other.rows[0].id])
    await owner.query('delete from resources where tenant_id=$1', [other.rows[0].id])
    await owner.query('delete from resource_types where tenant_id=$1', [other.rows[0].id])
    await owner.query('delete from branches where tenant_id=$1', [other.rows[0].id])
    await owner.query('delete from tenants where id=$1', [other.rows[0].id])
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
