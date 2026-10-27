/**
 * Reschedule a reserved booking (Phase 2 of the time-step work).
 *
 *   - confirmed: date / start / length can change; re-priced at the new window
 *   - a booking never conflicts with its OWN old slot (extend across it works)
 *   - another booking's slot still blocks it (23P01 -> "just taken"), nothing changes
 *   - grid: refused off the venue's time step, accepted once the step allows it
 *   - refused outside working hours, in the past, beyond the advance window
 *   - stale expectedStartsAt refused (someone else changed it)
 *   - checked_in: end only; cancelled / completed refused
 *   - quote is read-only; save writes an audit row; any staff role may reschedule
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs --import ./scripts/next-runtime-hook.mjs scripts/test-booking-reschedule.ts
 */
import { createHash, randomBytes } from 'node:crypto'
import { Pool } from 'pg'
import { loadEnv } from './env'

loadEnv()

let pass = 0
let fail = 0
const check = (label: string, cond: boolean, got?: unknown) => {
  console.log(`${cond ? '✓' : '✗ FAIL'}  ${label}${cond ? '' : `  (got: ${JSON.stringify(got)})`}`)
  if (cond) pass++
  else fail++
}

const TZ = 'Asia/Kolkata'
const ymdInIst = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d)
const at = (daysAhead: number, hhmm: string) => {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() + daysAhead)
  return new Date(`${ymdInIst(d)}T${hhmm}:00+05:30`)
}
const iso = (d: Date) => d.toISOString()

async function main() {
  const { createBooking, setBookingStatus, rescheduleBooking, quoteReschedule } = await import('../lib/actions/bookings')

  const owner = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })
  const tag = randomBytes(3).toString('hex')
  const slug = `reschedule-${tag}`

  const t = await owner.query<{ id: string }>(
    `insert into tenants (slug,name,status,timezone,industry) values ($1,'Reschedule Co','active',$2,'gaming_cafe') returning id`,
    [slug, TZ],
  )
  const tenantId = t.rows[0].id
  const br = await owner.query<{ id: string }>(
    `insert into branches (tenant_id,name,is_primary) values ($1,'Main',true) returning id`,
    [tenantId],
  )
  const branchId = br.rows[0].id
  const rt = await owner.query<{ id: string }>(
    `insert into resource_types (tenant_id,name,hourly_rate) values ($1,'PS5 Station','100.00') returning id`,
    [tenantId],
  )
  const res = await owner.query<{ id: string }>(
    `insert into resources (tenant_id,branch_id,resource_type_id,name,status) values ($1,$2,$3,'PS5-1','available') returning id`,
    [tenantId, branchId, rt.rows[0].id],
  )
  const resourceId = res.rows[0].id

  // A cashier - deliberately NOT a manager: any staff role may reschedule.
  const email = `cashier-${tag}@example.test`
  const u = await owner.query<{ id: string }>(
    `insert into users (email, password_hash, full_name) values ($1,'x','cashier') returning id`,
    [email],
  )
  const token = randomBytes(32).toString('hex')
  await owner.query(`insert into sessions (id, user_id, expires_at) values ($1,$2, now() + interval '1 day')`, [
    createHash('sha256').update(token).digest('hex'),
    u.rows[0].id,
  ])
  await owner.query(
    `insert into memberships (tenant_id,user_id,branch_id,role,status,full_name) values ($1,$2,$3,'cashier','active','cashier')`,
    [tenantId, u.rows[0].id, branchId],
  )
  const g = globalThis as { __ARENA_TEST_SESSION?: string; __ARENA_TEST_HEADERS?: Record<string, string> }
  g.__ARENA_TEST_HEADERS = { 'x-tenant-slug': slug }
  g.__ARENA_TEST_SESSION = token

  async function book(start: Date, end: Date, phone: string) {
    const r = await createBooking({
      branchId,
      customerName: 'Test',
      customerPhone: phone,
      source: 'staff',
      slots: [{ resourceId, startsAt: iso(start), endsAt: iso(end) }],
    })
    if (!r.bookingId) throw new Error(`createBooking failed: ${r.error}`)
    return r.bookingId
  }
  const slotOf = async (bookingId: string) =>
    (
      await owner.query<{ starts_at: Date; ends_at: Date; slot_total: string }>(
        `select starts_at, ends_at, slot_total from booking_slots where booking_id=$1 and active`,
        [bookingId],
      )
    ).rows[0]
  const totalOf = async (bookingId: string) =>
    (await owner.query<{ total: string }>(`select total from bookings where id=$1`, [bookingId])).rows[0].total

  // Default hours (no rows) are 10:00-22:00; default step is 30 minutes.
  const DAY = 3
  const b1 = await book(at(DAY, '12:00'), at(DAY, '13:00'), '9000000001')

  // ══ 1. move to a later time (same length) ═══════════════════════════════
  console.log('\n── move + re-price ──')
  const q1 = await quoteReschedule({ bookingId: b1, startsAt: iso(at(DAY, '14:00')), endsAt: iso(at(DAY, '15:30')), expectedStartsAt: iso(at(DAY, '12:00')) })
  check('quote: 1h -> 1.5h at 100/h costs 150', !q1.error && q1.newTotal === '150.00' && q1.oldTotal === '100.00', q1)
  check('quote is read-only (slot unchanged)', (await slotOf(b1)).starts_at.getTime() === at(DAY, '12:00').getTime())

  const r1 = await rescheduleBooking({ bookingId: b1, startsAt: iso(at(DAY, '14:00')), endsAt: iso(at(DAY, '15:30')), expectedStartsAt: iso(at(DAY, '12:00')), reason: 'Customer asked' })
  check('cashier (no manager role) can reschedule', !r1.error, r1)
  const s1 = await slotOf(b1)
  check('slot moved to 14:00-15:30', s1.starts_at.getTime() === at(DAY, '14:00').getTime() && s1.ends_at.getTime() === at(DAY, '15:30').getTime(), s1)
  check('slot_total re-priced to 150.00', Number(s1.slot_total) === 150, s1)
  check('bookings.total follows (150.00)', Number(await totalOf(b1)) === 150)
  const audit = await owner.query<{ before: { startsAt: string }; after: { startsAt: string; reason: string | null } }>(
    `select before, after from audit_log where tenant_id=$1 and entity_id=$2 and action='booking.rescheduled'`,
    [tenantId, b1],
  )
  check('audit row written with old/new time and reason', audit.rows.length === 1 && audit.rows[0].after.reason === 'Customer asked', audit.rows)

  // ══ 2. a booking does not conflict with its own old slot ═════════════════
  console.log('\n── own slot is not a conflict ──')
  const r2 = await rescheduleBooking({ bookingId: b1, startsAt: iso(at(DAY, '14:00')), endsAt: iso(at(DAY, '16:00')), expectedStartsAt: iso(at(DAY, '14:00')) })
  check('extending across its own old window works', !r2.error, r2)

  // ══ 3. another booking still blocks ══════════════════════════════════════
  console.log('\n── other bookings still block ──')
  const b2 = await book(at(DAY, '17:00'), at(DAY, '18:00'), '9000000002')
  const r3 = await rescheduleBooking({ bookingId: b2, startsAt: iso(at(DAY, '15:30')), endsAt: iso(at(DAY, '16:30')), expectedStartsAt: iso(at(DAY, '17:00')) })
  check('overlapping another booking is refused as "just taken"', /just taken/i.test(r3.error ?? ''), r3)
  check('...and the booking is unchanged', (await slotOf(b2)).starts_at.getTime() === at(DAY, '17:00').getTime())
  const r3b = await rescheduleBooking({ bookingId: b2, startsAt: iso(at(DAY, '16:00')), endsAt: iso(at(DAY, '17:00')), expectedStartsAt: iso(at(DAY, '17:00')) })
  check('back-to-back with the previous booking is allowed', !r3b.error, r3b)

  // ══ 4. time step + working hours + past + window ═════════════════════════
  console.log('\n── validation ──')
  const cur = at(DAY, '16:00')
  const off = await rescheduleBooking({ bookingId: b2, startsAt: iso(at(DAY, '19:20')), endsAt: iso(at(DAY, '20:20')), expectedStartsAt: iso(cur) })
  check('8:20-style start is refused on the default 30-minute step', /step/i.test(off.error ?? ''), off)
  await owner.query(`insert into booking_settings (tenant_id, slot_step_minutes) values ($1, 20)`, [tenantId])
  const on = await rescheduleBooking({ bookingId: b2, startsAt: iso(at(DAY, '20:20')), endsAt: iso(at(DAY, '21:20')), expectedStartsAt: iso(cur) })
  check('...and accepted once the venue step is 20 minutes', !on.error, on)
  const cur2 = at(DAY, '20:20')
  const late = await rescheduleBooking({ bookingId: b2, startsAt: iso(at(DAY, '21:40')), endsAt: iso(at(DAY, '22:40')), expectedStartsAt: iso(cur2) })
  check('past closing time is refused', /working hours/i.test(late.error ?? ''), late)
  const early = await rescheduleBooking({ bookingId: b2, startsAt: iso(at(DAY, '09:00')), endsAt: iso(at(DAY, '10:00')), expectedStartsAt: iso(cur2) })
  check('before opening is refused', /working hours/i.test(early.error ?? ''), early)
  const past = await rescheduleBooking({ bookingId: b2, startsAt: iso(at(-1, '12:00')), endsAt: iso(at(-1, '13:00')), expectedStartsAt: iso(cur2) })
  check('a start in the past is refused', /passed/i.test(past.error ?? ''), past)
  const far = await rescheduleBooking({ bookingId: b2, startsAt: iso(at(20, '12:00')), endsAt: iso(at(20, '13:00')), expectedStartsAt: iso(cur2) })
  check('beyond the advance-booking window is refused', /up to|ahead|earlier date/i.test(far.error ?? ''), far)
  const same = await rescheduleBooking({ bookingId: b2, startsAt: iso(cur2), endsAt: iso(at(DAY, '21:20')), expectedStartsAt: iso(cur2) })
  check('moving to the same time is refused', /already/i.test(same.error ?? ''), same)
  const stale = await rescheduleBooking({ bookingId: b2, startsAt: iso(at(DAY, '12:00')), endsAt: iso(at(DAY, '13:00')), expectedStartsAt: iso(at(DAY, '10:00')) })
  check('a stale expectedStartsAt is refused', /changed by someone else/i.test(stale.error ?? ''), stale)

  // ══ 5. status rules ══════════════════════════════════════════════════════
  console.log('\n── status rules ──')
  const b3 = await book(at(DAY + 1, '12:00'), at(DAY + 1, '13:00'), '9000000003')
  const cin = await setBookingStatus(b3, 'checked_in')
  if (cin.error) throw new Error(cin.error)
  const startMove = await rescheduleBooking({ bookingId: b3, startsAt: iso(at(DAY + 1, '14:00')), endsAt: iso(at(DAY + 1, '15:00')), expectedStartsAt: iso(at(DAY + 1, '12:00')) })
  check('checked-in: changing the start is refused', /already started|only its end/i.test(startMove.error ?? ''), startMove)
  const endMove = await rescheduleBooking({ bookingId: b3, startsAt: iso(at(DAY + 1, '12:00')), endsAt: iso(at(DAY + 1, '14:00')), expectedStartsAt: iso(at(DAY + 1, '12:00')) })
  check('checked-in: extending the end is allowed', !endMove.error, endMove)
  check('...and re-priced (2h = 200)', Number(await totalOf(b3)) === 200)

  const b4 = await book(at(DAY + 2, '12:00'), at(DAY + 2, '13:00'), '9000000004')
  const cancel = await setBookingStatus(b4, 'cancelled', 'test')
  if (cancel.error) throw new Error(cancel.error)
  const onCancelled = await rescheduleBooking({ bookingId: b4, startsAt: iso(at(DAY + 2, '14:00')), endsAt: iso(at(DAY + 2, '15:00')), expectedStartsAt: iso(at(DAY + 2, '12:00')) })
  check('a cancelled booking cannot be rescheduled', /upcoming or in-progress/i.test(onCancelled.error ?? ''), onCancelled)

  await owner.query('delete from tenants where id = $1', [tenantId])
  await owner.query(`delete from users where email like $1`, [`%-${tag}@example.test`])
  await owner.end()

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
