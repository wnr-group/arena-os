/**
 * M31 #1 — correctWalkinEndTime: set a timed walk-in's committed end to a
 * staff-supplied ABSOLUTE time (earlier or later), the way back from an
 * accidental extend. Driven through the real server action
 * (lib/actions/bookings.ts), with extendWalkin / previewWalkinCheckout /
 * checkoutWalkin used to prove the interplay.
 *
 * Proves:
 *   - industry + role gates, same shape as extend
 *   - an EARLIER time shrinks the session, keeps bookings.committed_end_at and
 *     booking_slots.ends_at in lockstep, re-prices immediately (preview), and
 *     checkout bills exactly what the preview showed
 *   - a LATER time gives the identical result extendWalkin would for the
 *     equivalent delta (same committed end, same preview)
 *   - refused, with nothing written: a time before/at the start, a time already
 *     past, more than WALKIN_EXTEND_MAX_MINUTES ahead, garbage input, an
 *     open-tab walk-in, an already-checked-out session
 *   - a LATER time that would collide with another booking on the device is
 *     refused by the exclusion constraint, a shrink never is
 *   - an audit_log row (before/after) is written on every success, none on a
 *     refusal
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs --import ./scripts/next-runtime-hook.mjs scripts/test-correct-walkin-end-time.ts
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

async function main() {
  loadEnv()
  const { startWalkin, extendWalkin, correctWalkinEndTime, checkoutWalkin, previewWalkinCheckout } = await import('../lib/actions/bookings')

  const owner = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })

  const slug = 'testcorrectwalkin'
  const t = await owner.query<{ id: string }>(
    `insert into tenants (slug,name,status,timezone,industry) values ($1,$2,'active','Asia/Kolkata','gaming_cafe')
     on conflict (slug) do update set name=excluded.name, industry='gaming_cafe' returning id`,
    [slug, `${slug} co`],
  )
  const tenantId = t.rows[0].id
  const b = await owner.query<{ id: string }>(
    `insert into branches (tenant_id,name,is_primary) values ($1,'Main',true)
     on conflict (tenant_id,name) do update set is_primary=true returning id`,
    [tenantId],
  )
  const branchId = b.rows[0].id

  const restaurantSlug = 'testcorrectwalkin-resto'
  const rt = await owner.query<{ id: string }>(
    `insert into tenants (slug,name,status,timezone,industry) values ($1,$2,'active','Asia/Kolkata','restaurant')
     on conflict (slug) do update set name=excluded.name, industry='restaurant' returning id`,
    [restaurantSlug, `${restaurantSlug} co`],
  )
  const restaurantTenantId = rt.rows[0].id

  async function makeUserAndMembership(tenant: string, role: string, email: string) {
    const u = await owner.query<{ id: string }>(
      `insert into users (email,password_hash) values ($1,'x')
       on conflict (email) do update set email=excluded.email returning id`,
      [email],
    )
    const userId = u.rows[0].id
    await owner.query(
      `insert into memberships (tenant_id,user_id,role,status) values ($1,$2,$3,'active')
       on conflict (tenant_id,user_id) do update set role=excluded.role, status='active'`,
      [tenant, userId, role],
    )
    return userId
  }
  const ownerUserId = await makeUserAndMembership(tenantId, 'owner', `owner@${slug}.test`)
  const cashierUserId = await makeUserAndMembership(tenantId, 'cashier', `cashier@${slug}.test`)
  const kitchenUserId = await makeUserAndMembership(tenantId, 'kitchen_staff', `kitchen@${slug}.test`)
  const restaurantOwnerId = await makeUserAndMembership(restaurantTenantId, 'owner', `owner@${restaurantSlug}.test`)

  const hourlyType = await owner.query<{ id: string }>(
    `insert into resource_types (tenant_id,name,hourly_rate) values ($1,'PS5',$2)
     on conflict (tenant_id,name) do update set hourly_rate=excluded.hourly_rate returning id`,
    [tenantId, '200.00'],
  )
  async function station(name: string) {
    return (
      await owner.query<{ id: string }>(
        `insert into resources (tenant_id,branch_id,resource_type_id,name,status)
         values ($1,$2,$3,$4,'available')
         on conflict (tenant_id,name) do update set status='available' returning id`,
        [tenantId, branchId, hourlyType.rows[0].id, name],
      )
    ).rows[0].id
  }

  const g = globalThis as { __ARENA_TEST_SESSION?: string; __ARENA_TEST_HEADERS?: Record<string, string> }
  async function signInAs(userId: string, tenantSlug: string) {
    const token = randomBytes(32).toString('hex')
    await owner.query(
      `insert into sessions (id, user_id, expires_at) values ($1,$2, now() + interval '1 day') on conflict (id) do nothing`,
      [createHash('sha256').update(token).digest('hex'), userId],
    )
    g.__ARENA_TEST_SESSION = token
    g.__ARENA_TEST_HEADERS = { 'x-tenant-slug': tenantSlug }
  }

  const wipe = async () => {
    await owner.query(`delete from audit_log where tenant_id in ($1,$2) and action='walkin.end_time_corrected'`, [tenantId, restaurantTenantId])
    await owner.query('delete from booking_slots where tenant_id in ($1,$2)', [tenantId, restaurantTenantId])
    await owner.query('delete from bookings where tenant_id in ($1,$2)', [tenantId, restaurantTenantId])
    await owner.query('delete from customers where tenant_id in ($1,$2)', [tenantId, restaurantTenantId])
    await owner.query('delete from sequences where tenant_id in ($1,$2)', [tenantId, restaurantTenantId])
  }
  await wipe()

  let phoneSeq = 0
  const nextPhone = () => `98765${String(70000 + phoneSeq++).padStart(5, '0')}`
  const MIN = 60_000
  const iso = (ms: number) => new Date(ms).toISOString()

  async function startTimed(resourceId: string, durationMin = 30) {
    const r = await startWalkin({ branchId, resourceId, phone: nextPhone(), startAt: new Date().toISOString(), mode: 'timed', durationMin })
    if (!r.bookingId) throw new Error(`startWalkin failed: ${r.error}`)
    return r.bookingId
  }
  const row = async (bookingId: string) => {
    const r = await owner.query<{ committed: string; ends: string; starts: string }>(
      `select b.committed_end_at committed, s.ends_at ends, s.starts_at starts
         from bookings b join booking_slots s on s.booking_id=b.id where b.id=$1`,
      [bookingId],
    )
    return { committed: new Date(r.rows[0].committed).getTime(), ends: new Date(r.rows[0].ends).getTime(), starts: new Date(r.rows[0].starts).getTime() }
  }
  const auditCount = async (bookingId: string) =>
    (await owner.query(`select 1 from audit_log where entity_id=$1 and action='walkin.end_time_corrected'`, [bookingId])).rowCount ?? 0

  // ══ 1. gates ═══════════════════════════════════════════════════════════════
  console.log('\n── industry + role gates ──')
  const s1 = await station('Station 1')
  let accidental = ''
  {
    await signInAs(restaurantOwnerId, restaurantSlug)
    const r = await correctWalkinEndTime({ bookingId: '00000000-0000-0000-0000-000000000000', newEndAt: iso(Date.now() + 30 * MIN) })
    check('a restaurant tenant is rejected before anything else', (r.error ?? '').toLowerCase().includes('walk-in'))

    await signInAs(ownerUserId, slug)
    accidental = await startTimed(s1, 30)
    const before = await row(accidental)

    await signInAs(kitchenUserId, slug)
    const denied = await correctWalkinEndTime({ bookingId: accidental, newEndAt: iso(before.starts + 20 * MIN) })
    check('kitchen_staff (outside the walk-in roles) is refused', Boolean(denied.error))
    check('…and nothing changed', (await row(accidental)).committed === before.committed && (await auditCount(accidental)) === 0)

    await signInAs(cashierUserId, slug)
    const noop = await correctWalkinEndTime({ bookingId: accidental, newEndAt: iso(before.committed) })
    check('a cashier IS allowed — same gate as every walk-in action, not manager-only', !noop.error)
    await signInAs(ownerUserId, slug)
  }

  // ══ 2. undo an accidental extend (earlier) ═════════════════════════════════
  console.log('\n── earlier end: undo an accidental +60 ──')
  {
    const base = await row(accidental) // committed = start + 30
    const ext = await extendWalkin({ bookingId: accidental, addMinutes: 60 })
    check('the accidental +60 is applied', !ext.error)
    const wrong = await previewWalkinCheckout({ bookingId: accidental })
    check('…and the session now prices at 90min: ₹300.00', wrong.total === 300)

    const auditBefore = await auditCount(accidental)
    const fixed = await correctWalkinEndTime({ bookingId: accidental, newEndAt: iso(base.starts + 45 * MIN) })
    check('correcting to start+45min succeeds', !fixed.error && Boolean(fixed.committedEndAt))
    const after = await row(accidental)
    check('committed_end_at is exactly start+45min', after.committed === base.starts + 45 * MIN)
    check("the slot's ends_at (the GiST bound) moved in lockstep", after.ends === after.committed)
    check('the returned committedEndAt matches what was stored', new Date(fixed.committedEndAt!).getTime() === after.committed)

    const preview = await previewWalkinCheckout({ bookingId: accidental })
    check('the price re-computed immediately: 45min × ₹200/hr = ₹150.00', preview.total === 150)

    const audit = await owner.query(
      `select before, after, actor_membership_id from audit_log where entity_id=$1 and action='walkin.end_time_corrected' order by created_at desc limit 1`,
      [accidental],
    )
    check('an audit row records before and after', (await auditCount(accidental)) === auditBefore + 1 && new Date(audit.rows[0].before.committedEndAt).getTime() === base.starts + 90 * MIN && new Date(audit.rows[0].after.committedEndAt).getTime() === base.starts + 45 * MIN)
    check('…attributed to the acting member', audit.rows[0].actor_membership_id !== null)

    const out = await checkoutWalkin({ bookingId: accidental })
    check('checkout bills exactly what the preview showed: ₹150.00', !out.error && out.total === 150)

    const again = await correctWalkinEndTime({ bookingId: accidental, newEndAt: iso(Date.now() + 30 * MIN) })
    check('correcting an already-checked-out session is refused', (again.error ?? '').toLowerCase().includes('checked out'))
  }

  // ══ 3. later end: identical to extend ══════════════════════════════════════
  console.log('\n── later end: identical to extendWalkin for the same delta ──')
  {
    const viaExtend = await startTimed(await station('Station 2'), 30)
    const viaCorrect = await startTimed(await station('Station 3'), 30)
    const e0 = await row(viaExtend)
    const c0 = await row(viaCorrect)
    const ext = await extendWalkin({ bookingId: viaExtend, addMinutes: 25 })
    const cor = await correctWalkinEndTime({ bookingId: viaCorrect, newEndAt: iso(c0.committed + 25 * MIN) })
    check('both succeed', !ext.error && !cor.error)
    const e1 = await row(viaExtend)
    const c1 = await row(viaCorrect)
    check('the committed end moved by the same 25 minutes either way', e1.committed - e0.committed === 25 * MIN && c1.committed - c0.committed === 25 * MIN)
    check('the slot bound moved the same way in both', e1.ends === e1.committed && c1.ends === c1.committed)
    const pe = await previewWalkinCheckout({ bookingId: viaExtend })
    const pc = await previewWalkinCheckout({ bookingId: viaCorrect })
    check('the preview price is identical: 55min → 60min billable = ₹200.00', pe.total === 200 && pc.total === 200)
  }

  // ══ 4. refusals ════════════════════════════════════════════════════════════
  console.log('\n── refusals (each leaves the session untouched) ──')
  {
    const id = await startTimed(await station('Station 4'), 30)
    const base = await row(id)
    const unchanged = async () => (await row(id)).committed === base.committed && (await row(id)).ends === base.ends
    const auditBefore = await auditCount(id)

    const atStart = await correctWalkinEndTime({ bookingId: id, newEndAt: iso(base.starts) })
    check('a time AT the start is refused', (atStart.error ?? '').toLowerCase().includes('after the session started'))
    const beforeStart = await correctWalkinEndTime({ bookingId: id, newEndAt: iso(base.starts - 10 * MIN) })
    check('a time BEFORE the start is refused', (beforeStart.error ?? '').toLowerCase().includes('after the session started'))

    const tooFar = await correctWalkinEndTime({ bookingId: id, newEndAt: iso(Date.now() + 25 * 60 * MIN) })
    check('a time more than 24h ahead is refused', (tooFar.error ?? '').toLowerCase().includes('within the next 24 hours'))

    const garbage = await correctWalkinEndTime({ bookingId: id, newEndAt: 'not-a-time' })
    check('a garbage time is refused', Boolean(garbage.error))
    const unknown = await correctWalkinEndTime({ bookingId: '00000000-0000-0000-0000-000000000000', newEndAt: iso(Date.now() + 30 * MIN) })
    check('an unknown booking is refused', Boolean(unknown.error))

    // Past-but-after-start: shift the whole session back 40 minutes so a time 5
    // minutes ago is genuinely after the start.
    await owner.query(`update bookings set committed_end_at = committed_end_at - interval '40 minutes' where id=$1`, [id])
    await owner.query(`update booking_slots set starts_at = starts_at - interval '40 minutes', ends_at = ends_at - interval '40 minutes' where booking_id=$1`, [id])
    const shifted = await row(id)
    const past = await correctWalkinEndTime({ bookingId: id, newEndAt: iso(Date.now() - 5 * MIN) })
    check('a time already in the past is refused (that is what checkout is for)', (past.error ?? '').toLowerCase().includes('in the future'))
    const stillShifted = await row(id)
    check('…none of the refusals changed anything', stillShifted.committed === shifted.committed && stillShifted.ends === shifted.ends && (await auditCount(id)) === auditBefore)
    void unchanged

    const openTab = await startWalkin({ branchId, resourceId: await station('Station 5'), phone: nextPhone(), startAt: new Date().toISOString(), mode: 'open_tab' })
    const tab = await correctWalkinEndTime({ bookingId: openTab.bookingId!, newEndAt: iso(Date.now() + 30 * MIN) })
    check('an open-tab walk-in is refused (it has no end time to correct)', (tab.error ?? '').toLowerCase().includes('timed'))
    check('…and no audit row was written for it', (await auditCount(openTab.bookingId!)) === 0)
  }

  // ══ 5. overlap: later can collide, earlier never can ═══════════════════════
  console.log('\n── another booking on the same device ──')
  {
    const s6 = await station('Station 6')
    const reservationStart = Date.now() + 3 * 60 * MIN
    const reservation = await owner.query<{ id: string }>(
      `insert into bookings (tenant_id, branch_id, booking_number, status) values ($1,$2,'BK-TESTCORRECT-001','confirmed') returning id`,
      [tenantId, branchId],
    )
    await owner.query(
      `insert into booking_slots (tenant_id, booking_id, resource_id, starts_at, ends_at, resource_name, resource_type_name)
       values ($1,$2,$3,$4,$5,'Station 6','PS5')`,
      [tenantId, reservation.rows[0].id, s6, iso(reservationStart), iso(reservationStart + 60 * MIN)],
    )
    const id = await startTimed(s6, 30)
    const base = await row(id)

    const tooLate = await correctWalkinEndTime({ bookingId: id, newEndAt: iso(reservationStart + 30 * MIN) })
    check('moving the end INTO the reservation is refused by the exclusion constraint', (tooLate.error ?? '').toLowerCase().includes('starting soon'))
    check('…and the session is unchanged', (await row(id)).committed === base.committed && (await auditCount(id)) === 0)

    const shrink = await correctWalkinEndTime({ bookingId: id, newEndAt: iso(base.starts + 15 * MIN) })
    check('shrinking is never blocked by the reservation', !shrink.error && (await row(id)).committed === base.starts + 15 * MIN)
    const clear = await correctWalkinEndTime({ bookingId: id, newEndAt: iso(base.starts + 90 * MIN) })
    check('a later time that stays clear of the reservation works', !clear.error)
    check('every success was audited (shrink + clear = 2 rows)', (await auditCount(id)) === 2)
  }

  await wipe()
  await owner.query('delete from sessions where user_id in ($1,$2,$3,$4)', [ownerUserId, cashierUserId, kitchenUserId, restaurantOwnerId])
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
