/**
 * M25 #2 — reopen a wrongly checked-out walk-in tab.
 *
 *   - open-tab: reopen sets ends_at back to null AND slot_total back to
 *     '0.00', and extendWalkin (which only ever applies to a TIMED walk-in)
 *     is irrelevant here — the acceptance re-check for open-tab is that
 *     checkoutWalkin (a real close) works again afterward
 *   - timed: reopen resets slot_total to '0.00', leaves ends_at (the
 *     committed end) untouched, and extendWalkin works again afterward
 *   - refused if the session was never checked out in the first place
 *   - refused once a live (non-void) invoice exists — a voided one does NOT
 *     block it
 *   - open-tab only: refused if a later active booking now exists on the
 *     resource (would overlap once ends_at goes back to null)
 *   - any staff who can check out a walk-in can reopen one (no manager gate)
 *   - writes an audit_log row (action='walkin.reopen')
 *   - cross-tenant booking id fails closed
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs --import ./scripts/next-runtime-hook.mjs scripts/test-reopen-walkin.ts
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
  const { startWalkin, checkoutWalkin, extendWalkin, reopenWalkin } = await import('../lib/actions/bookings')

  const owner = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })
  const tag = randomBytes(3).toString('hex')

  const slug = `reopen-walkin-${tag}`
  const t = await owner.query<{ id: string }>(
    `insert into tenants (slug,name,status,timezone,industry) values ($1,'Reopen Walkin Co','active',$2,'gaming_cafe') returning id`,
    [slug, TZ],
  )
  const tenantId = t.rows[0].id
  const br = await owner.query<{ id: string }>(
    `insert into branches (tenant_id,name,is_primary) values ($1,'Main',true) returning id`,
    [tenantId],
  )
  const branchId = br.rows[0].id
  const rt = await owner.query<{ id: string }>(
    `insert into resource_types (tenant_id,name,hourly_rate) values ($1,'PS5 Station','120.00') returning id`,
    [tenantId],
  )

  async function makeStation(name: string) {
    const r = await owner.query<{ id: string }>(
      `insert into resources (tenant_id,branch_id,resource_type_id,name,status) values ($1,$2,$3,$4,'available') returning id`,
      [tenantId, branchId, rt.rows[0].id, name],
    )
    return r.rows[0].id
  }

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
  // Deliberately NOT a manager, to prove no manager gate — same as check-in.
  const RECEPTIONIST = await makeUser('receptionist', 'receptionist')

  const g = globalThis as { __ARENA_TEST_SESSION?: string; __ARENA_TEST_HEADERS?: Record<string, string> }
  g.__ARENA_TEST_HEADERS = { 'x-tenant-slug': slug }
  g.__ARENA_TEST_SESSION = RECEPTIONIST.token

  async function slotOf(bookingId: string) {
    const { rows } = await owner.query<{ ends_at: Date | null; slot_total: string }>(
      `select ends_at, slot_total from booking_slots where booking_id=$1 and active=true`,
      [bookingId],
    )
    return rows[0]
  }

  // ══ 1. OPEN TAB: refused before checkout, works after, checkout works again ═
  console.log('\n── open tab ──')
  const stationA = await makeStation('PS5-A')
  const start1 = await startWalkin({ branchId, resourceId: stationA, phone: '9000000001', startAt: new Date().toISOString(), mode: 'open_tab' })
  if (!start1.bookingId) throw new Error(`start failed: ${start1.error}`)

  const tooEarly = await reopenWalkin(start1.bookingId)
  check('reopening an open tab that is still running is refused', /not been checked out/i.test(tooEarly.error ?? ''), tooEarly)

  const co1 = await checkoutWalkin({ bookingId: start1.bookingId })
  check('checkout succeeds', !co1.error, co1)
  const afterCheckout1 = await slotOf(start1.bookingId)
  check('checked out: ends_at set, slot_total > 0', afterCheckout1.ends_at !== null && Number(afterCheckout1.slot_total) > 0, afterCheckout1)

  const reopen1 = await reopenWalkin(start1.bookingId)
  check('reopen succeeds (receptionist, not a manager)', !reopen1.error, reopen1)
  const afterReopen1 = await slotOf(start1.bookingId)
  check('open tab: ends_at back to null, slot_total back to 0.00', afterReopen1.ends_at === null && afterReopen1.slot_total === '0.00', afterReopen1)

  const audit1 = await owner.query(
    `select 1 from audit_log where tenant_id=$1 and entity_id=$2 and action='walkin.reopen'`,
    [tenantId, start1.bookingId],
  )
  check('an audit_log row was written', audit1.rows.length === 1)

  const co1b = await checkoutWalkin({ bookingId: start1.bookingId })
  check('checkout works again after reopening', !co1b.error, co1b)

  // ══ 2. TIMED: reopen resets slot_total, leaves ends_at, extend works again ═
  console.log('\n── timed ──')
  const stationB = await makeStation('PS5-B')
  const start2 = await startWalkin({
    branchId,
    resourceId: stationB,
    phone: '9000000002',
    startAt: new Date().toISOString(),
    mode: 'timed',
    durationMin: 60,
  })
  if (!start2.bookingId) throw new Error(`start failed: ${start2.error}`)
  const beforeCheckout2 = await slotOf(start2.bookingId)

  const co2 = await checkoutWalkin({ bookingId: start2.bookingId })
  check('timed checkout succeeds', !co2.error, co2)
  const afterCheckout2 = await slotOf(start2.bookingId)
  check('checked out: slot_total > 0, ends_at unchanged (the committed end)', Number(afterCheckout2.slot_total) > 0 && afterCheckout2.ends_at?.getTime() === beforeCheckout2.ends_at?.getTime())

  const reopen2 = await reopenWalkin(start2.bookingId)
  check('timed reopen succeeds', !reopen2.error, reopen2)
  const afterReopen2 = await slotOf(start2.bookingId)
  check('timed: slot_total back to 0.00, ends_at STILL unchanged', afterReopen2.slot_total === '0.00' && afterReopen2.ends_at?.getTime() === beforeCheckout2.ends_at?.getTime())

  const extend2 = await extendWalkin({ bookingId: start2.bookingId, addMinutes: 15 })
  check('extendWalkin works again after reopening', !extend2.error, extend2)

  // ══ 3. refused once a LIVE invoice exists; a VOIDED one does not block ═════
  console.log('\n── billed vs. voided ──')
  const stationC = await makeStation('PS5-C')
  const start3 = await startWalkin({ branchId, resourceId: stationC, phone: '9000000003', startAt: new Date().toISOString(), mode: 'open_tab' })
  if (!start3.bookingId) throw new Error(`start failed: ${start3.error}`)
  await checkoutWalkin({ bookingId: start3.bookingId })
  await owner.query(
    `insert into invoices (tenant_id,branch_id,invoice_number,booking_id,status,subtotal,tax_total,total)
     values ($1,$2,$3,$4,'issued','100','0','100')`,
    [tenantId, branchId, `RW-${tag}-1`, start3.bookingId],
  )
  const reopen3 = await reopenWalkin(start3.bookingId)
  check('reopen refused once a live invoice exists', /void the bill/i.test(reopen3.error ?? ''), reopen3)

  await owner.query(`update invoices set status='void' where booking_id=$1`, [start3.bookingId])
  const reopen3b = await reopenWalkin(start3.bookingId)
  check('reopen succeeds once the invoice is voided', !reopen3b.error, reopen3b)

  // ══ 4. open-tab: refused if a later active booking now exists ═════════════
  console.log('\n── open-tab overlap guard ──')
  const stationD = await makeStation('PS5-D')
  const start4 = await startWalkin({ branchId, resourceId: stationD, phone: '9000000004', startAt: new Date().toISOString(), mode: 'open_tab' })
  if (!start4.bookingId) throw new Error(`start failed: ${start4.error}`)
  await checkoutWalkin({ bookingId: start4.bookingId })

  const later = new Date()
  later.setUTCDate(later.getUTCDate() + 1)
  const laterEnd = new Date(later.getTime() + 60 * 60_000)
  const reserved = await owner.query<{ id: string }>(
    `insert into bookings (tenant_id,branch_id,booking_number,status,source,channel) values ($1,$2,$3,'confirmed','staff','reserved') returning id`,
    [tenantId, branchId, `RW-${tag}-RES`],
  )
  await owner.query(
    `insert into booking_slots (tenant_id,booking_id,resource_id,starts_at,ends_at,resource_name,resource_type_name)
     values ($1,$2,$3,$4,$5,'PS5-D','PS5 Station')`,
    [tenantId, reserved.rows[0].id, stationD, later.toISOString(), laterEnd.toISOString()],
  )
  const reopen4 = await reopenWalkin(start4.bookingId)
  check('open-tab reopen refused when a later booking now exists on the station', /scheduled later/i.test(reopen4.error ?? ''), reopen4)
  const afterReopen4 = await slotOf(start4.bookingId)
  check('…nothing changed on the walk-in\'s own slot', afterReopen4.ends_at !== null)

  // ══ 5. cross-tenant fail-closed ════════════════════════════════════════════
  console.log('\n── cross-tenant fail-closed ──')
  const other = await owner.query<{ id: string }>(
    `insert into tenants (slug,name,status,timezone,industry) values ($1,'Other Co','active',$2,'gaming_cafe') returning id`,
    [`reopen-walkin-other-${tag}`, TZ],
  )
  const otherBr = await owner.query<{ id: string }>(
    `insert into branches (tenant_id,name,is_primary) values ($1,'Main',true) returning id`,
    [other.rows[0].id],
  )
  const otherRt = await owner.query<{ id: string }>(
    `insert into resource_types (tenant_id,name,hourly_rate) values ($1,'Station','80') returning id`,
    [other.rows[0].id],
  )
  const otherRes = await owner.query<{ id: string }>(
    `insert into resources (tenant_id,branch_id,resource_type_id,name,status) values ($1,$2,$3,'S1','available') returning id`,
    [other.rows[0].id, otherBr.rows[0].id, otherRt.rows[0].id],
  )
  const otherUser = await makeUser('other-owner', 'owner')
  await owner.query(`delete from memberships where user_id=$1`, [otherUser.id])
  await owner.query(
    `insert into memberships (tenant_id,user_id,branch_id,role,status,full_name) values ($1,$2,$3,'owner','active','other-owner')`,
    [other.rows[0].id, otherUser.id, otherBr.rows[0].id],
  )
  g.__ARENA_TEST_HEADERS = { 'x-tenant-slug': `reopen-walkin-other-${tag}` }
  g.__ARENA_TEST_SESSION = otherUser.token
  const otherStart = await startWalkin({
    branchId: otherBr.rows[0].id,
    resourceId: otherRes.rows[0].id,
    phone: '9000000099',
    startAt: new Date().toISOString(),
    mode: 'open_tab',
  })
  if (!otherStart.bookingId) throw new Error(`other-tenant start failed: ${otherStart.error}`)
  await checkoutWalkin({ bookingId: otherStart.bookingId })

  g.__ARENA_TEST_HEADERS = { 'x-tenant-slug': slug }
  g.__ARENA_TEST_SESSION = RECEPTIONIST.token
  const reopen5 = await reopenWalkin(otherStart.bookingId)
  check('a walk-in belonging to another tenant is not found', /not found/i.test(reopen5.error ?? ''), reopen5)

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
