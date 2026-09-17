/**
 * Allocating among several units of ONE resource type — "two snooker tables".
 *
 * ── THE BUG THIS PINS ───────────────────────────────────────────────────────
 *
 * Every availability reader fetched the existing slots with
 *
 *     starts_at >= dayStart AND starts_at < dayEnd
 *
 * — slots that START on the day being checked. A slot that begins EARLIER and
 * runs into that day was therefore invisible: an overnight booking, or a
 * multi-day hold on a resource. Availability offered the unit; the
 * booking_slots_no_overlap exclusion constraint then refused the insert, and
 * the booking died with "That time was just taken for one of the selected
 * resources."
 *
 * The visible symptom was that a SECOND unit of a type could never be
 * allocated while such a slot sat on it: the picker kept offering the occupied
 * table (it could not see the slot) and every attempt to book it failed, so
 * the free table was never reached.
 *
 * The window is now a real interval overlap:
 *
 *     starts_at < dayEnd AND ends_at > dayStart
 *
 * ── WHAT ELSE IS ASSERTED ───────────────────────────────────────────────────
 *
 * First-free-unit-wins across the whole type, that a busy unit never makes the
 * TYPE unavailable, that buffers apply per unit rather than across them, and
 * that availability and createBooking agree — the property whose absence was
 * the bug.
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs --import ./scripts/next-runtime-hook.mjs scripts/test-resource-allocation.ts
 */
import { createHash, randomBytes } from 'node:crypto'
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
const DATE = '2043-02-18'
const PREV = '2043-02-17'

/** IST is UTC+5:30. */
const ist = (day: string, hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number)
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCMinutes(d.getUTCMinutes() + h * 60 + m - (5 * 60 + 30))
  return d
}

async function main() {
  loadEnv()
  const { getAvailableStartsForType } = await import('../lib/actions/availability')
  const { createBooking } = await import('../lib/actions/bookings')

  const owner = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })

  const slug = 'testalloc'
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
  await owner.query(
    `insert into memberships (tenant_id,user_id,role,status) values ($1,$2,'owner','active')
     on conflict (tenant_id,user_id) do update set role='owner', status='active'`, [tenantId, userId])
  for (let d = 0; d < 7; d++) {
    await owner.query(
      `insert into working_hours (tenant_id,branch_id,day_of_week,open_time,close_time,is_closed)
       values ($1,$2,$3,'10:00','23:00',false)
       on conflict (branch_id,day_of_week) do update
         set open_time='10:00', close_time='23:00', is_closed=false`,
      [tenantId, branchId, d])
  }

  /** A type with `count` units, each carrying the type's buffer. */
  async function makeType(name: string, buffer: number, unitNames: string[]) {
    const rt = await owner.query<{ id: string }>(
      `insert into resource_types (tenant_id,name,hourly_rate,buffer_minutes)
       values ($1,$2,'250.00',$3)
       on conflict (tenant_id,name) do update set buffer_minutes=excluded.buffer_minutes returning id`,
      [tenantId, name, buffer])
    const units: { id: string; name: string }[] = []
    for (const [i, unit] of unitNames.entries()) {
      const r = await owner.query<{ id: string }>(
        `insert into resources (tenant_id,branch_id,resource_type_id,name,status,sort_order)
         values ($1,$2,$3,$4,'available',$5)
         on conflict (tenant_id,name) do update set status='available', sort_order=excluded.sort_order
         returning id`,
        [tenantId, branchId, rt.rows[0].id, unit, i])
      units.push({ id: r.rows[0].id, name: unit })
    }
    return { typeId: rt.rows[0].id, units }
  }

  const snooker = await makeType('Snooker Table', 10, ['Snooker #1', 'Snooker #2'])
  const ps5 = await makeType('PS5 Station', 0, ['PS5 #1', 'PS5 #2', 'PS5 #3'])

  // A real session, so the actions run their real guards.
  const token = randomBytes(32).toString('hex')
  await owner.query(
    `insert into sessions (id, user_id, expires_at) values ($1,$2, now() + interval '1 day')
     on conflict (id) do nothing`,
    [createHash('sha256').update(token).digest('hex'), userId])
  const g = globalThis as { __ARENA_TEST_SESSION?: string; __ARENA_TEST_HEADERS?: Record<string, string> }
  g.__ARENA_TEST_SESSION = token
  g.__ARENA_TEST_HEADERS = { 'x-tenant-slug': slug }

  const wipe = async () => {
    await owner.query('delete from booking_slots where tenant_id=$1', [tenantId])
    await owner.query('delete from bookings where tenant_id=$1', [tenantId])
    await owner.query('delete from sequences where tenant_id=$1', [tenantId])
  }
  await wipe()

  const nameOf = (all: { id: string; name: string }[], id: string) =>
    all.find((x) => x.id === id)?.name ?? '(unknown)'

  /** What the admin picker offers for a type, at a duration. */
  async function offered(typeId: string, durationMinutes = 90, date = DATE) {
    const r = await getAvailableStartsForType({ branchId, resourceTypeId: typeId, date, durationMinutes })
    if (r.error) throw new Error(r.error)
    return r.starts ?? []
  }
  const atTime = (starts: { startsAt: string; resourceId: string }[], hhmm: string, date = DATE) =>
    starts.find((s) => s.startsAt === ist(date, hhmm).toISOString())

  let seq = 0
  /** Book exactly what the picker offered, the way the dialog does. */
  const book = (resourceId: string, from: string, to: string, date = DATE) => {
    seq++
    return createBooking({
      branchId,
      source: 'walk_in',
      customerName: `Guest ${seq}`,
      customerPhone: `98765${String(10000 + seq).slice(-5)}`,
      slots: [{
        resourceId,
        startsAt: ist(date, from).toISOString(),
        endsAt: ist(date, to).toISOString(),
      }],
    })
  }

  /** Put a slot straight onto a resource, bypassing the picker. */
  async function holdSlot(resourceId: string, resourceName: string, from: Date, to: Date) {
    seq++
    const bk = await owner.query<{ id: string }>(
      `insert into bookings (tenant_id,branch_id,booking_number,status,subtotal,total)
       values ($1,$2,$3,'confirmed','0','0') returning id`,
      [tenantId, branchId, `HOLD-${seq}`])
    await owner.query(
      `insert into booking_slots (tenant_id,booking_id,resource_id,starts_at,ends_at,
         rate_applied,slot_total,resource_name,resource_type_name,active)
       values ($1,$2,$3,$4,$5,'250.00','250.00',$6,'Snooker Table',true)`,
      [tenantId, bk.rows[0].id, resourceId, from, to, resourceName])
  }

  // ══ 1. both units free ═══════════════════════════════════════════════════
  console.log('\n── both snooker tables free ──')
  {
    await wipe()
    const starts = await offered(snooker.typeId)
    check('the whole working day is offered (10:00 → 21:30)', starts.length === 24)
    check('14:00 is offered', Boolean(atTime(starts, '14:00')))
    check('…on the first unit by sort order', nameOf(snooker.units, atTime(starts, '14:00')!.resourceId) === 'Snooker #1')
  }

  // ══ 2. one busy → the OTHER is allocated ═════════════════════════════════
  console.log('\n── Snooker #1 booked, Snooker #2 free ──')
  {
    const first = await book(snooker.units[0].id, '14:00', '15:30')
    check('the first booking takes Snooker #1', !first.error)

    const starts = await offered(snooker.typeId)
    const slot = atTime(starts, '14:00')
    check('14:00 is STILL offered — one busy unit does not close the type', Boolean(slot))
    check('…and it is now Snooker #2', nameOf(snooker.units, slot!.resourceId) === 'Snooker #2')

    const second = await book(slot!.resourceId, '14:00', '15:30')
    check('the second booking succeeds on Snooker #2', !second.error)
    const which = await owner.query<{ resource_name: string }>(
      `select resource_name from booking_slots bs join bookings bk on bk.id=bs.booking_id
        where bk.tenant_id=$1 and bs.starts_at=$2 order by bs.created_at desc limit 1`,
      [tenantId, ist(DATE, '14:00')])
    check('…and the slot really is on Snooker #2', which.rows[0].resource_name === 'Snooker #2')
  }

  // ══ 3. both busy → the time is refused, the day is not ═══════════════════
  console.log('\n── both tables booked at 14:00 ──')
  {
    const starts = await offered(snooker.typeId)
    check('14:00 is no longer offered', !atTime(starts, '14:00'))
    check('…but the rest of the day still is', starts.length > 0)
    check('12:00 is still offered — a conflict at 14:00 does not remove the morning',
      Boolean(atTime(starts, '12:00')) || starts.some((s) => s.startsAt < ist(DATE, '12:30').toISOString()))
    check('16:00 is offered again after the booking ends', Boolean(atTime(starts, '16:00')))

    const third = await book(snooker.units[0].id, '14:00', '15:30')
    check('and booking it anyway is refused', Boolean(third.error))
  }

  // ══ 4. THE ROOT CAUSE: a slot running in from the previous day ═══════════
  //
  // Both units must be occupied for this to discriminate. With a free unit
  // sorting first, first-free-wins would hand back that one whether or not the
  // hold on the other was visible, and the bug would hide.
  console.log('\n── a hold that STARTS the day before ──')
  {
    await wipe()
    // Snooker #1: an ordinary same-day booking, always visible.
    await holdSlot(snooker.units[0].id, 'Snooker #1', ist(DATE, '13:00'), ist(DATE, '17:00'))
    // Snooker #2: held from the previous evening into this afternoon — the
    // shape an overnight booking or a multi-day hold takes. It STARTS on PREV,
    // so the old "starts_at within this day" window could not see it at all.
    await holdSlot(snooker.units[1].id, 'Snooker #2', ist(PREV, '20:00'), ist(DATE, '18:00'))

    const starts = await offered(snooker.typeId)
    check('14:00 is NOT offered — both units are occupied', !atTime(starts, '14:00'))
    check('…nor 15:00, still inside both holds', !atTime(starts, '15:00'))

    // THE property the bug broke: what the picker offers, the booking accepts.
    // Under the old window Snooker #2 looked free all afternoon, so this
    // offered a slot that the exclusion constraint then refused.
    let offeredButRefused: string | null = null
    for (const s of starts) {
      const startLocal = new Date(s.startsAt)
      const end = new Date(startLocal.getTime() + 90 * 60_000)
      const r = await createBooking({
        branchId, source: 'walk_in', customerName: 'Sweep', customerPhone: '9800000001',
        slots: [{ resourceId: s.resourceId, startsAt: s.startsAt, endsAt: end.toISOString() }],
      })
      if (r.error) {
        offeredButRefused = `${s.startsAt} on ${nameOf(snooker.units, s.resourceId)}: ${r.error}`
        break
      }
      // Free it again so the next candidate is judged on its own.
      await owner.query(
        `delete from booking_slots where tenant_id=$1 and booking_id in
           (select id from bookings where tenant_id=$1 and customer_phone like '%9800000001')`,
        [tenantId])
      await owner.query(
        `delete from bookings where tenant_id=$1 and customer_phone like '%9800000001'`,
        [tenantId])
    }
    check('EVERY offered start is actually bookable', offeredButRefused === null)
    if (offeredButRefused) console.log('      first refusal →', offeredButRefused)

    // Once the hold lifts at 18:00, #2 comes back — with its 10-minute buffer.
    check('18:30 is offered once both holds have lifted', Boolean(atTime(starts, '18:30')))
  }

  // ══ 5. partial occupancy keeps the day intact ════════════════════════════
  console.log('\n── partially occupied day ──')
  {
    await wipe()
    await holdSlot(snooker.units[0].id, 'Snooker #1', ist(DATE, '14:00'), ist(DATE, '15:30'))
    const starts = await offered(snooker.typeId)
    check('the day is still fully offered — the free table covers it', starts.length === 24)
    check('…and 14:00 comes from Snooker #2',
      nameOf(snooker.units, atTime(starts, '14:00')!.resourceId) === 'Snooker #2')
  }

  // ══ 6. the buffer is per unit, not across the type ═══════════════════════
  console.log('\n── the 10-minute buffer ──')
  {
    await wipe()
    await holdSlot(snooker.units[0].id, 'Snooker #1', ist(DATE, '14:00'), ist(DATE, '15:30'))
    await holdSlot(snooker.units[1].id, 'Snooker #2', ist(DATE, '14:00'), ist(DATE, '15:30'))
    const starts = await offered(snooker.typeId, 90)
    // 15:30 + the 10-minute buffer = 15:40, so a 15:30 start cannot fit.
    check('15:30 is refused — the buffer runs to 15:40', !atTime(starts, '15:30'))
    check('16:00 is fine', Boolean(atTime(starts, '16:00')))
    check('12:00 is fine — well clear of the buffer', Boolean(atTime(starts, '12:00')))
  }

  // ══ 7. a type with three units ═══════════════════════════════════════════
  console.log('\n── PS5 Station: three units, no buffer ──')
  {
    await wipe()
    const first = await offered(ps5.typeId, 60)
    check('starts on PS5 #1', nameOf(ps5.units, atTime(first, '14:00')!.resourceId) === 'PS5 #1')
    await book(atTime(first, '14:00')!.resourceId, '14:00', '15:00')

    const second = await offered(ps5.typeId, 60)
    check('then PS5 #2', nameOf(ps5.units, atTime(second, '14:00')!.resourceId) === 'PS5 #2')
    await book(atTime(second, '14:00')!.resourceId, '14:00', '15:00')

    const third = await offered(ps5.typeId, 60)
    check('then PS5 #3', nameOf(ps5.units, atTime(third, '14:00')!.resourceId) === 'PS5 #3')
    await book(atTime(third, '14:00')!.resourceId, '14:00', '15:00')

    const fourth = await offered(ps5.typeId, 60)
    check('and only then is 14:00 closed', !atTime(fourth, '14:00'))
    check('…with the rest of the day untouched', Boolean(atTime(fourth, '16:00')))
    // No buffer on this type, so the moment the hour ends it is bookable.
    check('15:00 is available immediately — this type has no buffer',
      Boolean(atTime(fourth, '15:00')))
  }

  // ══ 8. an inactive slot frees the unit again ═════════════════════════════
  console.log('\n── a cancelled booking releases its unit ──')
  {
    await wipe()
    await holdSlot(snooker.units[0].id, 'Snooker #1', ist(DATE, '14:00'), ist(DATE, '15:30'))
    await holdSlot(snooker.units[1].id, 'Snooker #2', ist(DATE, '14:00'), ist(DATE, '15:30'))
    check('both busy, so 14:00 is closed', !atTime(await offered(snooker.typeId), '14:00'))

    // The 0003 trigger clears `active` when a booking is cancelled.
    await owner.query(
      `update booking_slots set active=false where tenant_id=$1 and resource_id=$2`,
      [tenantId, snooker.units[1].id])
    const after = await offered(snooker.typeId)
    check('releasing Snooker #2 reopens 14:00', Boolean(atTime(after, '14:00')))
    check('…on Snooker #2', nameOf(snooker.units, atTime(after, '14:00')!.resourceId) === 'Snooker #2')
  }

  await wipe()
  await owner.query('delete from sessions where user_id=$1', [userId])
  g.__ARENA_TEST_SESSION = undefined
  g.__ARENA_TEST_HEADERS = undefined
  await owner.end()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
