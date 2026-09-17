/**
 * Walk-in booking from the owner side — the phone-first flow behind
 * components/bookings/NewBookingDialog.tsx.
 *
 * ── THE BUG THIS PINS ───────────────────────────────────────────────────────
 *
 * `customers.name` is nullable, so lookupCustomerByPhone() can legitimately
 * return `{ found: true, name: null }` — a returning walk-in whose name was
 * never captured. The dialog treated "found" as "named":
 *
 *     setExistingCustomerName(r.name || 'Existing customer')  // truthy
 *     setCustomerName(r.name || '')                           // empty
 *
 * so the name field (rendered only for a NEW customer) stayed hidden, the name
 * stayed empty, and submit()'s own `if (!customerName.trim()) return` fired —
 * silently, with no message and no field to fix it in. The Book button did
 * nothing at all, for ever. Two customers in the demo data trigger it.
 *
 * The state machine lives in the component, so this suite drives the two
 * SERVER actions it depends on and asserts the rule the component now applies:
 * a name is needed whenever one is not known, whether or not a customer row
 * exists. The component's own branch is a one-liner over that same predicate.
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs --import ./scripts/next-runtime-hook.mjs scripts/test-walkin-booking.ts
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

/**
 * The component's rule, as one predicate: does staff still have to type a name?
 * Mirrors `needsName` in NewBookingDialog — keyed on a KNOWN NAME, never on
 * whether a customer row was found.
 */
function needsName(lookup: { found: boolean; name: string | null }): boolean {
  return !((lookup.found ? (lookup.name ?? '').trim() : '').length > 0)
}

async function main() {
  loadEnv()
  const { lookupCustomerByPhone, createBooking } = await import('../lib/actions/bookings')

  const owner = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })

  const slug = 'testwalkin'
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
  const rt = await owner.query<{ id: string }>(
    `insert into resource_types (tenant_id,name,hourly_rate) values ($1,'Snooker Table','250.00')
     on conflict (tenant_id,name) do update set hourly_rate='250.00' returning id`, [tenantId])
  const resourceId = (await owner.query<{ id: string }>(
    `insert into resources (tenant_id,branch_id,resource_type_id,name,status)
     values ($1,$2,$3,'Table 1','available')
     on conflict (tenant_id,name) do update set status='available' returning id`,
    [tenantId, branchId, rt.rows[0].id])).rows[0].id
  for (let d = 0; d < 7; d++) {
    await owner.query(
      `insert into working_hours (tenant_id,branch_id,day_of_week,open_time,close_time,is_closed)
       values ($1,$2,$3,'10:00','23:00',false)
       on conflict (branch_id,day_of_week) do update set is_closed=false`,
      [tenantId, branchId, d])
  }

  // A real session: requireContext() looks it up with the real session code.
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
    await owner.query('delete from customers where tenant_id=$1', [tenantId])
    await owner.query('delete from sequences where tenant_id=$1', [tenantId])
  }
  await wipe()

  const NAMED = '9876500001'
  const NAMELESS = '9876500002'
  const BLANK = '9876500003'
  const UNKNOWN = '9876500009'

  await owner.query(
    `insert into customers (tenant_id,phone,name) values
       ($1,$2,'Meera Nair'), ($1,$3,null), ($1,$4,'   ')`,
    [tenantId, `+91${NAMED}`, `+91${NAMELESS}`, `+91${BLANK}`])

  let seq = 0
  /** The booking the dialog would submit for a chosen slot. */
  const bookAt = (hhmm: string, customerName: string, customerPhone: string) => {
    seq++
    const day = new Date(Date.UTC(2041, 5, 1 + seq, 0, 0, 0))
    const [h, m] = hhmm.split(':').map(Number)
    const startsAt = new Date(day.getTime() + (h * 60 + m - (5 * 60 + 30)) * 60_000)
    return createBooking({
      branchId,
      source: 'walk_in',
      customerName,
      customerPhone,
      slots: [{
        resourceId,
        startsAt: startsAt.toISOString(),
        endsAt: new Date(startsAt.getTime() + 60 * 60_000).toISOString(),
      }],
    })
  }

  // ══ 1. the lookup tells the truth about a missing name ═══════════════════
  console.log('\n── what the phone lookup returns ──')
  {
    const named = await lookupCustomerByPhone(NAMED)
    check('a named customer is found, with the name', named.found && named.name === 'Meera Nair')

    const nameless = await lookupCustomerByPhone(NAMELESS)
    check('a NULL-name customer is found, with a null name', nameless.found && nameless.name === null)

    const blank = await lookupCustomerByPhone(BLANK)
    check('a whitespace-name customer is found, with a blank name',
      blank.found && (blank.name ?? '').trim() === '')

    const unknown = await lookupCustomerByPhone(UNKNOWN)
    check('an unknown number is not found', !unknown.found && unknown.name === null)
  }

  // ══ 2. the rule the dialog applies ═══════════════════════════════════════
  console.log('\n── when must staff type a name? ──')
  {
    check('not for a named customer — the form stays phone-only',
      needsName(await lookupCustomerByPhone(NAMED)) === false)
    check('YES for a found customer with a NULL name (the bug)',
      needsName(await lookupCustomerByPhone(NAMELESS)) === true)
    check('YES for a found customer with a blank name',
      needsName(await lookupCustomerByPhone(BLANK)) === true)
    check('YES for a brand new number',
      needsName(await lookupCustomerByPhone(UNKNOWN)) === true)
    // The old rule was `found ? hasRow : ...` — it said "no name needed" for a
    // nameless customer, which is precisely what wedged the button.
    check('the OLD rule would have wrongly said "no name needed"',
      (await lookupCustomerByPhone(NAMELESS)).found === true)
  }

  // ══ 3. the booking itself goes through ═══════════════════════════════════
  console.log('\n── booking a walk-in ──')
  {
    const r = await bookAt('12:00', 'Meera Nair', NAMED)
    check('an existing NAMED customer books', !r.error && Boolean(r.bookingNumber))
  }
  {
    // The case that used to be impossible: the name now comes from the field
    // the dialog shows, and the booking completes.
    const r = await bookAt('13:00', 'Walk-in Guest', NAMELESS)
    check('a found-but-NAMELESS customer books once a name is typed',
      !r.error && Boolean(r.bookingNumber))
    const stored = await owner.query<{ customer_name: string; customer_id: string }>(
      `select customer_name, customer_id::text from bookings
        where tenant_id=$1 and customer_phone like '%' || $2 order by created_at desc limit 1`,
      [tenantId, NAMELESS])
    check('…the typed name is on the booking', stored.rows[0]?.customer_name === 'Walk-in Guest')
    check('…and it attached to the EXISTING customer, not a duplicate',
      Boolean(stored.rows[0]?.customer_id))
    const count = await owner.query<{ c: number }>(
      `select count(*)::int c from customers where tenant_id=$1 and phone like '%' || $2`,
      [tenantId, NAMELESS])
    check('…so there is still exactly one customer on that number', count.rows[0].c === 1)
  }
  {
    const r = await bookAt('14:00', 'Brand New', UNKNOWN)
    check('a brand new number books', !r.error && Boolean(r.bookingNumber))
  }

  // ══ 4. what the server still refuses ═════════════════════════════════════
  // The dialog's own checks are a courtesy; these are the real ones.
  console.log('\n── still refused by the server ──')
  {
    const noName = await bookAt('15:00', '   ', UNKNOWN)
    check('a blank name is refused', Boolean(noName.error))
    const noPhone = await bookAt('16:00', 'Someone', '123')
    check('a junk phone is refused', Boolean(noPhone.error))
  }

  // ══ 5. double-booking is still impossible ════════════════════════════════
  console.log('\n── the slot guard still holds ──')
  {
    const day = new Date(Date.UTC(2041, 6, 10, 0, 0, 0))
    const startsAt = new Date(day.getTime() + (12 * 60 - (5 * 60 + 30)) * 60_000)
    const slot = {
      resourceId,
      startsAt: startsAt.toISOString(),
      endsAt: new Date(startsAt.getTime() + 60 * 60_000).toISOString(),
    }
    const first = await createBooking({
      branchId, source: 'walk_in', customerName: 'First', customerPhone: NAMED, slots: [slot],
    })
    const second = await createBooking({
      branchId, source: 'walk_in', customerName: 'Second', customerPhone: UNKNOWN, slots: [slot],
    })
    check('the first booking takes the slot', !first.error)
    check('…and the second is refused', Boolean(second.error))
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
