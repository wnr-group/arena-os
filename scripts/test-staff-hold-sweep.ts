/**
 * Expired payment holds are released from STAFF paths, and by the cron route.
 *
 * sweepTenantHolds used to run only from the public booking actions, so an
 * expired-but-unswept pending_payment hold kept its active booking_slot: a staff
 * booking on that slot was refused by the exclusion constraint, staff
 * availability showed it taken, and the calendar showed a live "Awaiting
 * payment" booking, until some customer happened to hit the public pages. Staff
 * createBooking / startWalkin / availability and the bookings pages now sweep
 * first; /api/cron/release-holds releases for all tenants behind CRON_SECRET.
 *
 *   staff     expired hold: staff createBooking succeeds, availability lists the
 *             start; a live hold still blocks; a confirmed booking is never released
 *   cron      unset secret -> 503; missing/wrong -> 401 (nothing released);
 *             correct -> 200 { released }, expired hold gone, live hold untouched
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs --import ./scripts/next-runtime-hook.mjs scripts/test-staff-hold-sweep.ts
 */
import { createHash, randomBytes, randomInt } from 'node:crypto'
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

async function main() {
  const { NextRequest } = await import('next/server')
  const cron = await import('../app/api/cron/release-holds/route')
  const { createBooking } = await import('../lib/actions/bookings')
  const { getAvailableStarts } = await import('../lib/actions/availability')

  const owner = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })
  const q = <T extends object>(text: string, params: unknown[] = []) => owner.query<T>(text, params)
  const tag = randomBytes(3).toString('hex')
  const digits = Number(String(randomInt(0, 1_000_000_000)).padStart(9, '0'))
  let phoneSeq = 0
  const nextPhone = () => `9${String(digits + ++phoneSeq).padStart(9, '0')}`
  const g = globalThis as { __ARENA_TEST_HEADERS?: Record<string, string>; __ARENA_TEST_SESSION?: string }

  async function makeTenant(name: string) {
    const slug = `hold-sweep-${name}-${tag}`
    const tenantId = (await q<{ id: string }>(`insert into tenants (slug,name,status,timezone,industry) values ($1,$2,'active','Asia/Kolkata','recording_studio') returning id`, [slug, `${slug} co`])).rows[0].id
    const branchId = (await q<{ id: string }>(`insert into branches (tenant_id,name,is_primary,status) values ($1,'Main',true,'active') returning id`, [tenantId])).rows[0].id
    const typeId = (await q<{ id: string }>(`insert into resource_types (tenant_id,name,hourly_rate) values ($1,'Studio','500.00') returning id`, [tenantId])).rows[0].id
    for (let dow = 0; dow <= 6; dow++) {
      await q(`insert into working_hours (tenant_id,branch_id,day_of_week,open_time,close_time,is_closed) values ($1,$2,$3,'09:00','22:00',false)`, [tenantId, branchId, dow])
    }
    const resourceId = (await q<{ id: string }>(`insert into resources (tenant_id,branch_id,resource_type_id,name,status) values ($1,$2,$3,'Set 1','available') returning id`, [tenantId, branchId, typeId])).rows[0].id
    const uid = (await q<{ id: string }>(`insert into users (email,password_hash,full_name) values ($1,'x','Owner') returning id`, [`owner-${name}-${tag}@example.test`])).rows[0].id
    await q(`insert into memberships (tenant_id,user_id,branch_id,role,status,full_name) values ($1,$2,$3,'owner','active','Owner')`, [tenantId, uid, branchId])
    const token = randomBytes(32).toString('hex')
    await q(`insert into sessions (id,user_id,expires_at) values ($1,$2,now()+interval '1 day')`, [createHash('sha256').update(token).digest('hex'), uid])
    return { tenantId, slug, branchId, resourceId, token }
  }
  const S = await makeTenant('staff')
  const C = await makeTenant('cron')

  let dayOff = 3
  const nextWindow = () => {
    const s = new Date()
    s.setUTCDate(s.getUTCDate() + ++dayOff)
    s.setUTCHours(6, 30, 0, 0) // 12:00 Asia/Kolkata, on the hour grid
    return { startsAt: s.toISOString(), endsAt: new Date(s.getTime() + 3_600_000).toISOString() }
  }
  const istDate = (iso: string) => new Date(new Date(iso).getTime() + 5.5 * 3_600_000).toISOString().slice(0, 10)
  const asStaff = () => {
    g.__ARENA_TEST_HEADERS = { 'x-tenant-slug': S.slug }
    g.__ARENA_TEST_SESSION = S.token
  }
  // A booking via the real staff action, then turned into the state the public flow leaves behind.
  async function mkHold(t: typeof S, w: { startsAt: string; endsAt: string }, expired: boolean) {
    g.__ARENA_TEST_HEADERS = { 'x-tenant-slug': t.slug }
    g.__ARENA_TEST_SESSION = t.token
    const r = await createBooking({
      branchId: t.branchId,
      customerName: 'Hold',
      customerPhone: nextPhone(),
      source: 'staff',
      slots: [{ resourceId: t.resourceId, ...w }],
    })
    if (!r.bookingId) throw new Error(`seed failed: ${r.error}`)
    await q(`update bookings set status='pending_payment', payment_hold_expires_at = now() ${expired ? '- interval \'5 minutes\'' : '+ interval \'20 minutes\''} where id=$1`, [r.bookingId])
    return r.bookingId
  }
  const state = async (id: string) =>
    (await q<{ status: string; reason: string | null }>(`select status, cancellation_reason reason from bookings where id=$1`, [id])).rows[0]
  const tryBook = (w: { startsAt: string; endsAt: string }) => {
    asStaff()
    return createBooking({ branchId: S.branchId, customerName: 'Staff', customerPhone: nextPhone(), source: 'staff', slots: [{ resourceId: S.resourceId, ...w }] })
  }
  const starts = async (w: { startsAt: string }) => {
    asStaff()
    const r = await getAvailableStarts({ branchId: S.branchId, resourceId: S.resourceId, date: istDate(w.startsAt), durationMinutes: 60 })
    return (r.starts ?? []).map((s) => new Date(s).getTime())
  }

  // ══ staff paths ═══════════════════════════════════════════════════════════
  console.log('\n── staff: expired hold ──')
  {
    const w = nextWindow()
    const hold = await mkHold(S, w, true)
    const r = await tryBook(w)
    check('staff createBooking on an expired hold succeeds', Boolean(r.bookingId) && !r.error, r.error)
    check('the expired hold was released ("Payment not completed")', (await state(hold)).status === 'cancelled' && (await state(hold)).reason === 'Payment not completed', await state(hold))
  }
  {
    const w = nextWindow()
    await mkHold(S, w, true)
    check('staff availability lists the lapsed hold’s start as available', (await starts(w)).includes(new Date(w.startsAt).getTime()))
  }
  console.log('\n── staff: live hold and confirmed booking ──')
  {
    const w = nextWindow()
    const hold = await mkHold(S, w, false)
    const r = await tryBook(w)
    check('a NON-expired hold still blocks staff createBooking', Boolean(r.error) && !r.bookingId, r)
    check('…and is not available in staff availability', !(await starts(w)).includes(new Date(w.startsAt).getTime()))
    check('…and stays pending_payment', (await state(hold)).status === 'pending_payment')
  }
  {
    const w = nextWindow()
    const id = await mkHold(S, w, true)
    await q(`update bookings set status='confirmed' where id=$1`, [id]) // paid meanwhile; stale expiry stamp remains
    const other = nextWindow()
    await mkHold(S, other, true)
    await tryBook(other) // triggers a sweep
    check('a confirmed booking is never released', (await state(id)).status === 'confirmed', await state(id))
  }

  // ══ cron route ════════════════════════════════════════════════════════════
  console.log('\n── cron route ──')
  const call = (method: 'GET' | 'POST', auth?: string) =>
    cron[method](new NextRequest('https://app.example.test/api/cron/release-holds', { method, headers: auth ? { authorization: auth } : {} }))
  // Seed the live hold first: creating a booking sweeps the tenant, which would release an earlier expired one.
  const liveHold = await mkHold(C, nextWindow(), false)
  const expiredHold = await mkHold(C, nextWindow(), true)
  const prevSecret = process.env.CRON_SECRET
  try {
    delete process.env.CRON_SECRET
    let res = await call('GET', 'Bearer ')
    check('secret unset -> 503', res.status === 503, res.status)
    process.env.CRON_SECRET = ''
    res = await call('POST', 'Bearer ')
    check('secret empty -> 503, even with an "empty" bearer', res.status === 503, res.status)
    check('…and nothing was released', (await state(expiredHold)).status === 'pending_payment')

    const SECRET = `cron_${randomBytes(12).toString('hex')}`
    process.env.CRON_SECRET = SECRET
    res = await call('GET')
    check('missing header -> 401', res.status === 401, res.status)
    res = await call('GET', 'Bearer wrong')
    check('wrong secret (different length) -> 401', res.status === 401, res.status)
    res = await call('POST', `Bearer ${SECRET.slice(0, -1)}x`)
    check('wrong secret (same length) -> 401', res.status === 401, res.status)
    res = await call('GET', SECRET)
    check('secret without the Bearer scheme -> 401', res.status === 401, res.status)
    check('…and nothing was released', (await state(expiredHold)).status === 'pending_payment')

    res = await call('GET', `Bearer ${SECRET}`)
    const body = (await res.json()) as { released?: number }
    check('correct secret -> 200 with a released count', res.status === 200 && typeof body.released === 'number' && body.released >= 1, { s: res.status, body })
    check('expired hold released', (await state(expiredHold)).status === 'cancelled')
    check('live hold untouched', (await state(liveHold)).status === 'pending_payment')
    check('response carries only the count', Object.keys(body).join() === 'released', body)

    const again = await call('POST', `Bearer ${SECRET}`)
    check('POST with the secret also works (idempotent)', again.status === 200, again.status)
  } finally {
    if (prevSecret === undefined) delete process.env.CRON_SECRET
    else process.env.CRON_SECRET = prevSecret
  }

  console.log(`\n${pass} passed, ${fail} failed`)
  await owner.end()
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
