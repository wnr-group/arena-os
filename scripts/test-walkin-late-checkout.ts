/**
 * M32 #1/#3 — late checkout for a forgotten open-tab walk-in: checkoutWalkin's
 * `endAt` may now sit up to 7 days in the past (it used to be capped at ±30
 * minutes of now), is audited when it falls outside the normal window, and
 * everything else about checkout is unchanged. Driven through the real server
 * actions (lib/actions/bookings.ts).
 *
 * Proves:
 *   - an open tab started 3 days ago checks out at an entered end (start+2h):
 *     preview == checkout == 2h × ₹200/hr, the slot's ends_at is stamped to
 *     the entered time, and a walkin.late_checkout audit row records entered
 *     end vs actual checkout time
 *   - the station is free again after a late checkout (a new walk-in starts)
 *   - a routine checkout (no endAt, or within ±30min of now) writes NO audit
 *   - the boundaries: 31min back is late (audited); just over 7 days back is
 *     refused, as is an end after (or at) the session start's wrong side, and
 *     an end more than the normal window in the FUTURE
 *   - a timed walk-in is untouched: still prices its committed end, never audits
 *   - same gate as a normal checkout: EVERY walk-in role (owner, manager, cashier,
 *     receptionist, floor_staff) may late-check-out (not manager-only); kitchen
 *     staff, restaurant tenants and other tenants may not
 *   - pricing composes over the entered HISTORICAL window: a happy-hour rule
 *     keyed to the weekday the session really ran on applies (and one for another
 *     weekday does not); a holiday-rate walk-in stays flat at its start-time
 *     snapshot, happy hour ignored
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs --import ./scripts/next-runtime-hook.mjs scripts/test-walkin-late-checkout.ts
 */
import { createHash, randomBytes } from 'node:crypto'
import { Pool } from 'pg'
import { loadEnv } from './env'
import { addDays, todayInZone, weekdayInZone, zonedTimeToUtc } from '../lib/booking/time'

let pass = 0,
  fail = 0
const check = (l: string, c: boolean) => {
  console.log(`${c ? '✓' : '✗ FAIL'}  ${l}`)
  if (c) pass++
  else fail++
}

async function main() {
  loadEnv()
  const { startWalkin, checkoutWalkin, previewWalkinCheckout } = await import('../lib/actions/bookings')

  const owner = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })
  const MIN = 60_000
  const DAY = 24 * 60 * MIN
  const iso = (ms: number) => new Date(ms).toISOString()

  async function makeTenant(slug: string, industry: string) {
    const t = await owner.query<{ id: string }>(
      `insert into tenants (slug,name,status,timezone,industry) values ($1,$2,'active','Asia/Kolkata',$3)
       on conflict (slug) do update set name=excluded.name, industry=excluded.industry returning id`,
      [slug, `${slug} co`, industry],
    )
    const tenantId = t.rows[0].id
    const b = await owner.query<{ id: string }>(
      `insert into branches (tenant_id,name,is_primary) values ($1,'Main',true)
       on conflict (tenant_id,name) do update set is_primary=true returning id`,
      [tenantId],
    )
    return { tenantId, branchId: b.rows[0].id }
  }
  async function makeUser(tenantId: string, role: string, email: string) {
    const u = await owner.query<{ id: string }>(
      `insert into users (email,password_hash) values ($1,'x')
       on conflict (email) do update set email=excluded.email returning id`,
      [email],
    )
    await owner.query(
      `insert into memberships (tenant_id,user_id,role,status) values ($1,$2,$3,'active')
       on conflict (tenant_id,user_id) do update set role=excluded.role, status='active'`,
      [tenantId, u.rows[0].id, role],
    )
    return u.rows[0].id
  }

  const slug = 'testlatecheckout'
  const A = await makeTenant(slug, 'gaming_cafe')
  const R = await makeTenant(`${slug}-resto`, 'restaurant')
  const ownerId = await makeUser(A.tenantId, 'owner', `owner@${slug}.test`)
  const cashierId = await makeUser(A.tenantId, 'cashier', `cashier@${slug}.test`)
  const kitchenId = await makeUser(A.tenantId, 'kitchen_staff', `kitchen@${slug}.test`)
  const restoOwnerId = await makeUser(R.tenantId, 'owner', `owner@${slug}-resto.test`)
  const otherT = await makeTenant(`${slug}-other`, 'gaming_cafe')
  const otherOwnerId = await makeUser(otherT.tenantId, 'owner', `owner@${slug}-other.test`)

  const type = await owner.query<{ id: string }>(
    `insert into resource_types (tenant_id,name,hourly_rate) values ($1,'PS5','200.00')
     on conflict (tenant_id,name) do update set hourly_rate=excluded.hourly_rate returning id`,
    [A.tenantId],
  )
  async function station(name: string) {
    return (
      await owner.query<{ id: string }>(
        `insert into resources (tenant_id,branch_id,resource_type_id,name,status) values ($1,$2,$3,$4,'available')
         on conflict (tenant_id,name) do update set status='available' returning id`,
        [A.tenantId, A.branchId, type.rows[0].id, name],
      )
    ).rows[0].id
  }

  const g = globalThis as { __ARENA_TEST_SESSION?: string; __ARENA_TEST_HEADERS?: Record<string, string> }
  async function signInAs(userId: string, tenantSlug: string) {
    const token = randomBytes(32).toString('hex')
    await owner.query(`insert into sessions (id, user_id, expires_at) values ($1,$2, now() + interval '1 day') on conflict (id) do nothing`, [
      createHash('sha256').update(token).digest('hex'),
      userId,
    ])
    g.__ARENA_TEST_SESSION = token
    g.__ARENA_TEST_HEADERS = { 'x-tenant-slug': tenantSlug }
  }

  const tenantIds = [A.tenantId, R.tenantId, otherT.tenantId]
  const wipe = async () => {
    await owner.query(`delete from audit_log where tenant_id = any($1) and action='walkin.late_checkout'`, [tenantIds])
    await owner.query('delete from invoice_items where tenant_id = any($1)', [tenantIds])
    await owner.query('delete from invoices where tenant_id = any($1)', [tenantIds])
    await owner.query('delete from booking_slots where tenant_id = any($1)', [tenantIds])
    await owner.query('delete from bookings where tenant_id = any($1)', [tenantIds])
    await owner.query('delete from customers where tenant_id = any($1)', [tenantIds])
    await owner.query('delete from sequences where tenant_id = any($1)', [tenantIds])
    await owner.query('delete from happy_hours where tenant_id = any($1)', [tenantIds])
  }
  await wipe()

  const roleUsers: string[] = []
  let phoneSeq = 0
  const nextPhone = () => `98765${String(80000 + phoneSeq++).padStart(5, '0')}`

  async function startTab(resourceId: string, mode: 'open_tab' | 'timed' = 'open_tab') {
    const r = await startWalkin({
      branchId: A.branchId,
      resourceId,
      phone: nextPhone(),
      startAt: new Date().toISOString(),
      mode,
      durationMin: mode === 'timed' ? 30 : undefined,
    })
    if (!r.bookingId) throw new Error(`startWalkin failed: ${r.error}`)
    return r.bookingId
  }
  /** Pretend the tab was started `ms` ago (forgotten). */
  async function backdate(bookingId: string, ms: number) {
    await owner.query(`update booking_slots set starts_at = now() - ($2 || ' milliseconds')::interval where booking_id=$1`, [bookingId, String(ms)])
  }
  const slot = async (bookingId: string) => {
    const r = await owner.query<{ starts_at: string; ends_at: string | null; slot_total: string }>(
      `select starts_at, ends_at, slot_total from booking_slots where booking_id=$1`,
      [bookingId],
    )
    return { starts: new Date(r.rows[0].starts_at).getTime(), ends: r.rows[0].ends_at ? new Date(r.rows[0].ends_at).getTime() : null, total: r.rows[0].slot_total }
  }
  const audits = async (bookingId: string) =>
    (await owner.query(`select after, actor_membership_id from audit_log where entity_id=$1 and action='walkin.late_checkout'`, [bookingId])).rows

  // ══ 1. forgotten for 3 days, closed out at the real end ═══════════════════
  console.log('\n── a tab forgotten for 3 days ──')
  const s1 = await station('Station 1')
  {
    await signInAs(ownerId, slug)
    const id = await startTab(s1)
    await backdate(id, 3 * DAY)
    const base = await slot(id)
    check('the open tab is unbounded while forgotten (ends_at is null)', base.ends === null)

    const enteredEnd = base.starts + 2 * 60 * MIN // it really ran 2 hours
    const preview = await previewWalkinCheckout({ bookingId: id, endAt: iso(enteredEnd) })
    check('preview prices the entered end: 2h × ₹200/hr = ₹400.00', !preview.error && preview.total === 400)

    const out = await checkoutWalkin({ bookingId: id, endAt: iso(enteredEnd) })
    check('late checkout succeeds (it was refused beyond ±30min before)', !out.error && out.total === 400)
    const after = await slot(id)
    check('ends_at is stamped to the ENTERED end, not to "now"', after.ends === enteredEnd)
    check('slot_total is frozen at ₹400.00', after.total === '400.00')
    const bk = await owner.query<{ total: string }>(`select total from bookings where id=$1`, [id])
    check("the booking's own total is stamped too", bk.rows[0].total === '400.00')

    const a = await audits(id)
    check('a walkin.late_checkout audit row was written', a.length === 1)
    check('…recording the entered end and the real checkout time', a[0] && new Date(a[0].after.enteredEndAt).getTime() === enteredEnd && Math.abs(new Date(a[0].after.checkedOutAt).getTime() - Date.now()) < 5 * 60 * MIN && a[0].after.total === '400.00')
    check('…attributed to the acting member', a[0]?.actor_membership_id !== null)

    const again = await checkoutWalkin({ bookingId: id, endAt: iso(enteredEnd) })
    check('a second checkout is refused', Boolean(again.error))

    // the forgotten tab no longer blocks the resource
    const reuse = await startWalkin({ branchId: A.branchId, resourceId: s1, phone: nextPhone(), startAt: new Date().toISOString(), mode: 'open_tab' })
    check('the station is free again — a new walk-in starts on it', !reuse.error && Boolean(reuse.bookingId))
  }

  // ══ 2. routine checkouts stay unaudited ═══════════════════════════════════
  console.log('\n── routine checkout inside the normal window: no audit ──')
  {
    const noEnd = await startTab(await station('Station 2'))
    await backdate(noEnd, 60 * MIN)
    const o1 = await checkoutWalkin({ bookingId: noEnd })
    check('checkout with no endAt (= now) succeeds', !o1.error)
    check('…and writes no audit row', (await audits(noEnd)).length === 0)

    const inWindow = await startTab(await station('Station 3'))
    await backdate(inWindow, 90 * MIN)
    const o2 = await checkoutWalkin({ bookingId: inWindow, endAt: iso(Date.now() - 20 * MIN) })
    check('checkout 20min back (inside ±30) succeeds', !o2.error)
    check('…and writes no audit row', (await audits(inWindow)).length === 0)

    const slightFuture = await startTab(await station('Station 4'))
    await backdate(slightFuture, 60 * MIN)
    const o3 = await checkoutWalkin({ bookingId: slightFuture, endAt: iso(Date.now() + 10 * MIN) })
    check('an end 10min ahead (inside the unchanged future window) still succeeds', !o3.error)
    check('…unaudited', (await audits(slightFuture)).length === 0)
  }

  // ══ 3. boundaries ═════════════════════════════════════════════════════════
  console.log('\n── boundaries ──')
  {
    const id = await startTab(await station('Station 5'))
    await backdate(id, 10 * DAY)
    const base = await slot(id)
    const untouched = async () => (await slot(id)).ends === null && (await audits(id)).length === 0

    const tooOld = await checkoutWalkin({ bookingId: id, endAt: iso(Date.now() - 7 * DAY - 2 * MIN) })
    check('an end more than 7 days back is refused, with a clear message', (tooOld.error ?? '').includes('last 7 days'))
    const tooLate = await checkoutWalkin({ bookingId: id, endAt: iso(Date.now() + 2 * 60 * MIN) })
    check('an end 2h in the FUTURE is refused', (tooLate.error ?? '').toLowerCase().includes('future'))
    const justPast = await checkoutWalkin({ bookingId: id, endAt: iso(Date.now() + 31 * MIN) })
    check('an end beyond the normal future window is refused', (justPast.error ?? '').toLowerCase().includes('future'))
    const beforeStart = await checkoutWalkin({ bookingId: id, endAt: iso(base.starts - 5 * MIN) })
    check('an end before the session started is refused', Boolean(beforeStart.error))
    const preview = await previewWalkinCheckout({ bookingId: id, endAt: iso(Date.now() - 8 * DAY) })
    check('the preview refuses the same out-of-range end', Boolean(preview.error))
    check('…and nothing was written by any refusal', await untouched())

    const edge = await checkoutWalkin({ bookingId: id, endAt: iso(Date.now() - 6 * DAY - 23 * 60 * MIN) })
    check('an end just inside 7 days back succeeds', !edge.error)
    check('…and is audited as a late checkout', (await audits(id)).length === 1)
  }

  const justOver = await startTab(await station('Station 6'))
  await backdate(justOver, 2 * 60 * MIN)
  {
    const o = await checkoutWalkin({ bookingId: justOver, endAt: iso(Date.now() - 31 * MIN) })
    check('an end 31min back (just outside the normal window) succeeds', !o.error)
    check('…and IS audited — it is outside the normal window', (await audits(justOver)).length === 1)
  }

  // ══ 4. timed walk-ins are untouched ═══════════════════════════════════════
  console.log('\n── timed walk-in: unchanged ──')
  {
    const id = await startTab(await station('Station 7'), 'timed')
    const out = await checkoutWalkin({ bookingId: id, endAt: iso(Date.now() - 3 * DAY) })
    check('a timed checkout still prices its committed end, ignoring endAt (30min × ₹200/hr = ₹100.00)', !out.error && out.total === 100)
    check('…and never writes a late-checkout audit row', (await audits(id)).length === 0)
  }

  // ══ 5. gates ══════════════════════════════════════════════════════════════
  console.log('\n── role / industry / tenant gates ──')
  {
    const id = await startTab(await station('Station 8'))
    await backdate(id, 2 * DAY)
    const base = await slot(id)
    const end = iso(base.starts + 60 * MIN)

    await signInAs(kitchenId, slug)
    const k = await checkoutWalkin({ bookingId: id, endAt: end })
    check('kitchen_staff cannot check out', Boolean(k.error) && (await slot(id)).ends === null)

    await signInAs(otherOwnerId, `${slug}-other`)
    const x = await checkoutWalkin({ bookingId: id, endAt: end })
    check("another tenant's owner cannot check it out (fails closed)", Boolean(x.error) && (await slot(id)).ends === null && (await audits(id)).length === 0)

    await signInAs(restoOwnerId, `${slug}-resto`)
    const r = await checkoutWalkin({ bookingId: id, endAt: end })
    check('a restaurant tenant is refused', (r.error ?? '').toLowerCase().includes('walk-in'))

    await signInAs(cashierId, slug)
    const c = await checkoutWalkin({ bookingId: id, endAt: end })
    check('a cashier CAN do a late checkout — same gate as a normal checkout, not manager-only', !c.error && c.total === 200)
    check('…and it is audited against them', (await audits(id)).length === 1)
  }

  // ══ 6. every walk-in role may do a late checkout ══════════════════════════
  console.log('\n── every canManageWalkins role ──')
  for (const role of ['owner', 'manager', 'cashier', 'receptionist', 'floor_staff']) {
    const uid = await makeUser(A.tenantId, role, `${role}@${slug}.test`)
    roleUsers.push(uid)
    await signInAs(ownerId, slug)
    const id = await startTab(await station(`Role ${role}`))
    await backdate(id, 2 * DAY)
    const base = await slot(id)
    await signInAs(uid, slug)
    const out = await checkoutWalkin({ bookingId: id, endAt: iso(base.starts + 60 * MIN) })
    check(`${role} can do a late checkout`, !out.error && out.total === 200)
    check(`…and it is audited`, (await audits(id)).length === 1)
  }

  // ══ 7. pricing composes over the entered historical window ════════════════
  console.log('\n── historical-day pricing ──')
  {
    const TZ = 'Asia/Kolkata'
    // Fix the session on a known past local day, 10:00–12:00, so it never
    // straddles midnight and the weekday is unambiguous.
    const day = addDays(todayInZone(TZ), -3)
    const sessionStart = zonedTimeToUtc(day, '10:00', TZ).getTime()
    const sessionEnd = sessionStart + 120 * MIN
    const weekday = weekdayInZone(day, TZ)
    const otherWeekday = (weekday + 3) % 7
    const setStart = async (bookingId: string) =>
      owner.query(`update booking_slots set starts_at = $2 where booking_id=$1`, [bookingId, iso(sessionStart)])
    await signInAs(ownerId, slug)

    // a happy-hour rule for the weekday the session REALLY ran on → applies
    await owner.query(`delete from happy_hours where tenant_id=$1`, [A.tenantId])
    await owner.query(
      `insert into happy_hours (tenant_id,name,days_of_week,start_time,end_time,discount_type,discount_value,is_active)
       values ($1,'Ran-on weekday HH',$2,'00:00','23:59','percentage',50,true)`,
      [A.tenantId, `{${weekday}}`],
    )
    const hhId = await startTab(await station('Station HH Day'))
    await setStart(hhId)
    const hhPreview = await previewWalkinCheckout({ bookingId: hhId, endAt: iso(sessionEnd) })
    check("a happy-hour rule for the weekday the session really ran on applies over the entered window: 2h × ₹200/hr × 50% = ₹200.00", hhPreview.total === 200)
    const hhOut = await checkoutWalkin({ bookingId: hhId, endAt: iso(sessionEnd) })
    check('…and checkout bills exactly the preview', !hhOut.error && hhOut.total === 200)

    // the same rule keyed to a DIFFERENT weekday does not apply
    await owner.query(`update happy_hours set days_of_week=$2 where tenant_id=$1`, [A.tenantId, `{${otherWeekday}}`])
    const ctlId = await startTab(await station('Station HH Control'))
    await setStart(ctlId)
    const ctl = await previewWalkinCheckout({ bookingId: ctlId, endAt: iso(sessionEnd) })
    check("…while a rule for another weekday leaves the full price: ₹400.00", ctl.total === 400)
    await checkoutWalkin({ bookingId: ctlId, endAt: iso(sessionEnd) })

    // a holiday-rate walk-in stays flat at its start-time snapshot; happy hour ignored
    await owner.query(`update happy_hours set days_of_week='{0,1,2,3,4,5,6}' where tenant_id=$1`, [A.tenantId])
    const holType = await owner.query<{ id: string }>(
      `insert into resource_types (tenant_id,name,hourly_rate) values ($1,'Late Holiday PS5','200.00')
       on conflict (tenant_id,name) do update set hourly_rate=excluded.hourly_rate returning id`,
      [A.tenantId],
    )
    await owner.query(`delete from holiday_rates where resource_type_id=$1`, [holType.rows[0].id])
    await owner.query(`insert into holiday_rates (tenant_id,resource_type_id,date,rate) values ($1,$2,$3,'300.00')`, [
      A.tenantId,
      holType.rows[0].id,
      todayInZone(TZ),
    ])
    const holStation = (
      await owner.query<{ id: string }>(
        `insert into resources (tenant_id,branch_id,resource_type_id,name,status) values ($1,$2,$3,'Station Late Holiday','available')
         on conflict (tenant_id,name) do update set status='available' returning id`,
        [A.tenantId, A.branchId, holType.rows[0].id],
      )
    ).rows[0].id
    const holId = await startTab(holStation)
    await setStart(holId)
    const hol = await previewWalkinCheckout({ bookingId: holId, endAt: iso(sessionEnd) })
    check('a holiday-rate walk-in stays flat at its start-time snapshot over the entered window: 2h × ₹300 = ₹600.00 (happy hour ignored)', hol.total === 600)
    const holOut = await checkoutWalkin({ bookingId: holId, endAt: iso(sessionEnd) })
    check('…and checkout bills exactly the preview', !holOut.error && holOut.total === 600)
    await owner.query(`delete from happy_hours where tenant_id=$1`, [A.tenantId])
  }

  await wipe()
  await owner.query('delete from sessions where user_id = any($1)', [[ownerId, cashierId, kitchenId, restoOwnerId, otherOwnerId, ...roleUsers]])
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
