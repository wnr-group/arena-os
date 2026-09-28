/**
 * M25 #1 — undo a wrong check-in (checked_in -> confirmed).
 *
 *   - reverts checked_in -> confirmed AND clears checked_in_at back to null
 *   - any role can do it (no manager gate) — same access as check-in itself;
 *     the guards below are what actually keeps it safe
 *   - refused once status isn't 'checked_in' (nothing changes)
 *   - refused once a live (non-void) invoice exists on the booking
 *   - a VOIDED invoice does NOT block it — findLiveBilling excludes void
 *   - writes an audit_log row (action='booking.uncheckin', before/after)
 *   - cross-tenant booking id fails closed ("Booking not found")
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs --import ./scripts/next-runtime-hook.mjs scripts/test-undo-checkin.ts
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

async function main() {
  const { createBooking, undoCheckIn, setBookingStatus } = await import('../lib/actions/bookings')

  const owner = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })
  const tag = randomBytes(3).toString('hex')

  const slug = `undo-checkin-${tag}`
  const t = await owner.query<{ id: string }>(
    `insert into tenants (slug,name,status,timezone,industry) values ($1,'Undo Checkin Co','active',$2,'gaming_cafe') returning id`,
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

  // A cashier — deliberately NOT a manager, to prove no manager gate.
  async function makeUser(label: string, role: string) {
    const email = `${label}-${tag}@example.test`
    const u = await owner.query<{ id: string }>(
      `insert into users (email, password_hash, full_name) values ($1,'x',$2) returning id`,
      [email, label],
    )
    const token = randomBytes(32).toString('hex')
    await owner.query(`insert into sessions (id, user_id, expires_at) values ($1,$2, now() + interval '1 day')`, [
      createHash('sha256').update(token).digest('hex'),
      u.rows[0].id,
    ])
    await owner.query(
      `insert into memberships (tenant_id,user_id,branch_id,role,status,full_name) values ($1,$2,$3,$4::member_role,'active',$5)`,
      [tenantId, u.rows[0].id, branchId, role, label],
    )
    return { id: u.rows[0].id, token }
  }
  const CASHIER = await makeUser('cashier', 'cashier')

  const g = globalThis as { __ARENA_TEST_SESSION?: string; __ARENA_TEST_HEADERS?: Record<string, string> }
  g.__ARENA_TEST_HEADERS = { 'x-tenant-slug': slug }
  g.__ARENA_TEST_SESSION = CASHIER.token

  const future = new Date()
  future.setUTCDate(future.getUTCDate() + 3)
  future.setUTCHours(6, 0, 0, 0) // ~11:30 IST

  async function makeCheckedInBooking(phone: string) {
    const startsAt = new Date(future)
    const endsAt = new Date(startsAt.getTime() + 60 * 60_000)
    const r = await createBooking({
      branchId,
      customerName: 'Test',
      customerPhone: phone,
      source: 'staff',
      slots: [{ resourceId, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() }],
    })
    if (!r.bookingId) throw new Error(`createBooking failed: ${r.error}`)
    const checkIn = await setBookingStatus(r.bookingId, 'checked_in')
    if (checkIn.error) throw new Error(`check-in failed: ${checkIn.error}`)
    future.setUTCHours(future.getUTCHours() + 2) // keep each booking's window free of the last
    return r.bookingId
  }

  // ══ 1. cashier (no manager role) undoes a check-in ═══════════════════════
  console.log('\n── happy path (no manager gate) ──')
  const b1 = await makeCheckedInBooking('9000000001')
  const before1 = await owner.query<{ status: string; checked_in_at: Date | null }>(
    'select status, checked_in_at from bookings where id=$1',
    [b1],
  )
  check('booking is checked_in with checked_in_at stamped before the undo', before1.rows[0].status === 'checked_in' && before1.rows[0].checked_in_at !== null)

  const r1 = await undoCheckIn(b1)
  check('cashier (not a manager) can undo a check-in', !r1.error, r1)

  const after1 = await owner.query<{ status: string; checked_in_at: Date | null }>(
    'select status, checked_in_at from bookings where id=$1',
    [b1],
  )
  check('status reverted to confirmed', after1.rows[0].status === 'confirmed', after1.rows[0])
  check('checked_in_at cleared back to null', after1.rows[0].checked_in_at === null, after1.rows[0])

  const audit1 = await owner.query<{ action: string; before: unknown; after: unknown }>(
    `select action, before, after from audit_log where tenant_id=$1 and entity_id=$2 and action='booking.uncheckin'`,
    [tenantId, b1],
  )
  check('an audit_log row was written', audit1.rows.length === 1, audit1.rows)
  check(
    'audit row: before.status=checked_in, after.status=confirmed, after.checkedInAt=null',
    (audit1.rows[0]?.before as { status?: string })?.status === 'checked_in' &&
      (audit1.rows[0]?.after as { status?: string; checkedInAt?: unknown })?.status === 'confirmed' &&
      (audit1.rows[0]?.after as { checkedInAt?: unknown })?.checkedInAt === null,
    audit1.rows[0],
  )

  // ══ 2. refused once no longer checked_in ══════════════════════════════════
  console.log('\n── refused once status has moved on ──')
  const r2 = await undoCheckIn(b1)
  check('undoing an already-confirmed booking is refused', /not checked in/i.test(r2.error ?? ''), r2)
  const after2 = await owner.query<{ status: string }>('select status from bookings where id=$1', [b1])
  check('…status unchanged', after2.rows[0].status === 'confirmed')

  // ══ 3. refused once a LIVE invoice exists ═════════════════════════════════
  console.log('\n── refused once billed ──')
  const b2 = await makeCheckedInBooking('9000000002')
  await owner.query(
    `insert into invoices (tenant_id,branch_id,invoice_number,booking_id,status,subtotal,tax_total,total)
     values ($1,$2,$3,$4,'issued','100','0','100')`,
    [tenantId, branchId, `UC-${tag}-1`, b2],
  )
  const r3 = await undoCheckIn(b2)
  check('a checked_in booking with a live invoice is refused', /void the bill first/i.test(r3.error ?? ''), r3)
  const after3 = await owner.query<{ status: string }>('select status from bookings where id=$1', [b2])
  check('…status unchanged (still checked_in)', after3.rows[0].status === 'checked_in')

  // ══ 4. a VOIDED invoice does NOT block it ═════════════════════════════════
  console.log('\n── a voided invoice does not block it ──')
  await owner.query(`update invoices set status='void' where booking_id=$1`, [b2])
  const r4 = await undoCheckIn(b2)
  check('once the invoice is voided, undo check-in succeeds', !r4.error, r4)
  const after4 = await owner.query<{ status: string; checked_in_at: Date | null }>(
    'select status, checked_in_at from bookings where id=$1',
    [b2],
  )
  check('…status reverted, checked_in_at cleared', after4.rows[0].status === 'confirmed' && after4.rows[0].checked_in_at === null, after4.rows[0])

  // ══ 5. cross-tenant fail-closed ════════════════════════════════════════════
  console.log('\n── cross-tenant fail-closed ──')
  const other = await owner.query<{ id: string }>(
    `insert into tenants (slug,name,status,timezone) values ($1,'Other Co','active',$2) returning id`,
    [`undo-checkin-other-${tag}`, TZ],
  )
  const otherBr = await owner.query<{ id: string }>(
    `insert into branches (tenant_id,name,is_primary) values ($1,'Main',true) returning id`,
    [other.rows[0].id],
  )
  const otherRt = await owner.query<{ id: string }>(
    `insert into resource_types (tenant_id,name,hourly_rate) values ($1,'Station','50') returning id`,
    [other.rows[0].id],
  )
  const otherRes = await owner.query<{ id: string }>(
    `insert into resources (tenant_id,branch_id,resource_type_id,name,status) values ($1,$2,$3,'S1','available') returning id`,
    [other.rows[0].id, otherBr.rows[0].id, otherRt.rows[0].id],
  )
  const otherUser = await makeUser('other-owner', 'owner')
  // Re-membership otherUser into "other" (makeUser above put them in the
  // ORIGINAL tenant) — build the fixture booking as a real member of
  // "other", through the real actions, then switch back to CASHIER/the
  // original tenant for the actual cross-tenant undoCheckIn attempt below.
  await owner.query(`delete from memberships where user_id=$1`, [otherUser.id])
  await owner.query(
    `insert into memberships (tenant_id,user_id,branch_id,role,status,full_name) values ($1,$2,$3,'owner','active','other-owner')`,
    [other.rows[0].id, otherUser.id, otherBr.rows[0].id],
  )
  g.__ARENA_TEST_HEADERS = { 'x-tenant-slug': `undo-checkin-other-${tag}` }
  g.__ARENA_TEST_SESSION = otherUser.token
  const otherStart = new Date(future)
  const otherEnd = new Date(otherStart.getTime() + 60 * 60_000)
  const otherCreated = await createBooking({
    branchId: otherBr.rows[0].id,
    customerName: 'Other',
    customerPhone: '9000000099',
    source: 'staff',
    slots: [{ resourceId: otherRes.rows[0].id, startsAt: otherStart.toISOString(), endsAt: otherEnd.toISOString() }],
  })
  if (!otherCreated.bookingId) throw new Error(`other-tenant createBooking failed: ${otherCreated.error}`)
  const otherCheckIn = await setBookingStatus(otherCreated.bookingId, 'checked_in')
  if (otherCheckIn.error) throw new Error(`other-tenant check-in failed: ${otherCheckIn.error}`)

  g.__ARENA_TEST_HEADERS = { 'x-tenant-slug': slug }
  g.__ARENA_TEST_SESSION = CASHIER.token
  const r5 = await undoCheckIn(otherCreated.bookingId)
  check('a booking belonging to another tenant is not found', /not found/i.test(r5.error ?? ''), r5)

  await owner.query('delete from tenants where id = $1', [other.rows[0].id])
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
