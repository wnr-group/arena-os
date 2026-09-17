/**
 * Public availability — the whole day, not just the free part.
 *
 * The bug this pins: getPublicAvailableStartsForType() returned only the
 * BOOKABLE start times, and the resource-type picker rendered exactly those.
 * So a single afternoon booking did not grey out a few buttons — it deleted
 * them. With a 2-hour duration and a 10-minute buffer, one 2:00–3:30 PM
 * booking silently removed every start from 12:00 to 3:30, and the page looked
 * broken rather than busy.
 *
 * The single-resource reader had always returned `allStarts` alongside
 * `starts` for precisely this reason; the type-level one did not. Now both do,
 * and the pickers render `allStarts`, disabling whatever is missing from
 * `starts`.
 *
 * The arithmetic itself was never wrong — those times genuinely could not be
 * booked — so this asserts BOTH halves: the grid is complete, and exactly the
 * right entries within it are marked taken.
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs scripts/test-public-availability-grid.ts
 */
import { Pool } from 'pg'
import { loadEnv } from './env'

let pass = 0,
  fail = 0
const check = (l: string, c: boolean) => {
  console.log(`${c ? '✓' : '✗ FAIL'}  ${l}`)
  if (c) pass++
  else fail++
}

const TZ = 'Asia/Kolkata'
const DATE = '2037-03-11' // far future: no real data, no "already past" filtering

async function main() {
  loadEnv()
  const { getPublicAvailableStartsForType, getPublicAvailableStarts } = await import(
    '../lib/booking/public-availability'
  )
  const { zonedTimeToUtc } = await import('../lib/booking/time')

  const owner = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })

  const slug = 'testavailgrid'
  const t = await owner.query<{ id: string }>(
    `insert into tenants (slug,name,status,timezone) values ($1,$2,'active',$3)
     on conflict (slug) do update set name=excluded.name returning id`, [slug, `${slug} co`, TZ])
  const tenantId = t.rows[0].id
  const b = await owner.query<{ id: string }>(
    `insert into branches (tenant_id,name,is_primary) values ($1,'Main',true)
     on conflict (tenant_id,name) do update set is_primary=true returning id`, [tenantId])
  const branchId = b.rows[0].id

  // Open 10:00–23:00 every day, so the grid is predictable.
  for (let d = 0; d < 7; d++) {
    await owner.query(
      `insert into working_hours (tenant_id,branch_id,day_of_week,open_time,close_time,is_closed)
       values ($1,$2,$3,'10:00','23:00',false)
       on conflict (branch_id,day_of_week) do update
         set open_time='10:00', close_time='23:00', is_closed=false`,
      [tenantId, branchId, d])
  }

  // A type with TWO units and a 10-minute buffer — the shape that produced the
  // report ("both snooker tables").
  const rt = await owner.query<{ id: string }>(
    `insert into resource_types (tenant_id,name,hourly_rate,buffer_minutes)
     values ($1,'Snooker Table','250.00',10)
     on conflict (tenant_id,name) do update set hourly_rate='250.00', buffer_minutes=10 returning id`,
    [tenantId])
  const units: string[] = []
  for (const name of ['Table 1', 'Table 2']) {
    const r = await owner.query<{ id: string }>(
      `insert into resources (tenant_id,branch_id,resource_type_id,name,status,sort_order)
       values ($1,$2,$3,$4,'available',0)
       on conflict (tenant_id,name) do update set status='available' returning id`,
      [tenantId, branchId, rt.rows[0].id, name])
    units.push(r.rows[0].id)
  }

  await owner.query(
    `delete from booking_slots where tenant_id=$1 and starts_at >= $2`,
    [tenantId, zonedTimeToUtc(DATE, '00:00', TZ)])
  await owner.query(`delete from bookings where tenant_id=$1 and booking_number like 'AV-%'`, [tenantId])

  /** Book BOTH units for the given local window. */
  async function bookBoth(from: string, to: string) {
    const bk = await owner.query<{ id: string }>(
      `insert into bookings (tenant_id,branch_id,booking_number,status,subtotal,total)
       values ($1,$2,$3,'confirmed','0','0') returning id`,
      [tenantId, branchId, `AV-${from.replace(':', '')}`])
    for (const [i, resourceId] of units.entries()) {
      await owner.query(
        `insert into booking_slots (tenant_id,booking_id,resource_id,starts_at,ends_at,
           rate_applied,slot_total,resource_name,resource_type_name,active)
         values ($1,$2,$3,$4,$5,'250.00','375.00',$6,'Snooker Table',true)`,
        [tenantId, bk.rows[0].id, resourceId,
         zonedTimeToUtc(DATE, from, TZ), zonedTimeToUtc(DATE, to, TZ), `Table ${i + 1}`])
    }
  }

  const hhmm = (iso: string | Date) =>
    new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false })
      .format(new Date(iso))

  const load = async (durationMinutes: number) => {
    const r = await getPublicAvailableStartsForType({
      tenantId, branchId, resourceTypeId: rt.rows[0].id, timeZone: TZ, date: DATE, durationMinutes,
    })
    if ('error' in r) throw new Error(r.error)
    const free = new Set(r.starts.map((s) => hhmm(s.start)))
    const grid = r.allStarts.map(hhmm)
    return { grid, free, taken: grid.filter((g) => !free.has(g)) }
  }

  // ══ 1. an empty day ══════════════════════════════════════════════════════
  console.log('\n── nothing booked ──')
  {
    const { grid, taken } = await load(120)
    check('the grid runs 10:00 to 21:00 for a 2-hour booking',
      grid[0] === '10:00' && grid[grid.length - 1] === '21:00')
    check('…every half hour, 23 of them', grid.length === 23)
    check('…and none of it is taken', taken.length === 0)
  }

  // ══ 2. the reported scenario ═════════════════════════════════════════════
  // Both units booked 14:00–15:30, 2-hour duration, 10-minute buffer.
  console.log('\n── both units booked 2:00–3:30 PM, 2-hour duration ──')
  {
    await bookBoth('14:00', '15:30')
    const { grid, free, taken } = await load(120)

    check('the morning is still offered', free.has('10:00') && free.has('11:30'))
    check('12:00 is STILL IN THE GRID (it used to vanish)', grid.includes('12:00'))
    check('…and 12:30, 13:00, 13:30 too',
      ['12:30', '13:00', '13:30'].every((s) => grid.includes(s)))
    check('…as is the booked window itself',
      ['14:00', '14:30', '15:00', '15:30'].every((s) => grid.includes(s)))

    // Every one of those is genuinely unbookable — that part was always right.
    check('12:00 through 15:30 are marked taken, and exactly those',
      taken.join(',') === '12:00,12:30,13:00,13:30,14:00,14:30,15:00,15:30')
    check('16:00 is bookable again', free.has('16:00'))
    check('the grid is unchanged in length by the booking', grid.length === 23)
  }

  // ══ 3. shorter durations shrink the blocked span ═════════════════════════
  // Same booking, different duration — the span moves, the grid never shrinks.
  console.log('\n── the same booking at other durations ──')
  {
    for (const [duration, expected] of [
      [30, '13:30,14:00,14:30,15:00,15:30'],
      [60, '13:00,13:30,14:00,14:30,15:00,15:30'],
      [90, '12:30,13:00,13:30,14:00,14:30,15:00,15:30'],
    ] as const) {
      const { grid, taken } = await load(duration)
      check(`${duration}min → taken ${expected}`, taken.join(',') === expected)
      check(`…and the whole day is still listed (${grid.length} slots)`,
        grid[0] === '10:00' && grid.length > taken.length)
    }
  }

  // ══ 4. one unit free means the time is offered ═══════════════════════════
  console.log('\n── only one of the two units busy ──')
  {
    await owner.query(
      `delete from booking_slots where tenant_id=$1 and resource_id=$2 and starts_at >= $3`,
      [tenantId, units[1], zonedTimeToUtc(DATE, '00:00', TZ)])
    const { free, taken } = await load(120)
    check('with Table 2 free, nothing is taken', taken.length === 0)
    check('…and 14:00 is bookable on the free table', free.has('14:00'))
  }

  // ══ 5. a fully blocked day still lists the day ═══════════════════════════
  // The case that used to render an empty page with only a message.
  console.log('\n── every unit blocked all day ──')
  {
    await owner.query(
      `delete from booking_slots where tenant_id=$1 and starts_at >= $2`,
      [tenantId, zonedTimeToUtc(DATE, '00:00', TZ)])
    await bookBoth('10:00', '23:00')
    const { grid, free, taken } = await load(120)
    check('nothing is bookable', free.size === 0)
    check('…but the day is still described, every slot marked taken',
      grid.length === 23 && taken.length === 23)
  }

  // ══ 6. the single-resource reader still agrees ═══════════════════════════
  console.log('\n── the single-resource reader, unchanged ──')
  {
    const r = await getPublicAvailableStarts({
      tenantId, branchId, resourceId: units[0], timeZone: TZ, date: DATE, durationMinutes: 120,
    })
    if ('error' in r) throw new Error(r.error)
    check('it reports the same 23-slot grid', r.allStarts.length === 23)
    check('…with nothing free on a fully booked table', r.starts.length === 0)
  }

  // cleanup
  await owner.query(
    `delete from booking_slots where tenant_id=$1 and starts_at >= $2`,
    [tenantId, zonedTimeToUtc(DATE, '00:00', TZ)])
  await owner.query(`delete from bookings where tenant_id=$1 and booking_number like 'AV-%'`, [tenantId])

  await owner.end()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
