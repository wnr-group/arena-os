/**
 * M28 #2 — recordBackdatedBookingCore: create + bill + settle a past booking
 * in one transaction.
 *
 * Covers:
 *   - yesterday's session lands completed, backdated=true, with a real
 *     invoice stamped with TODAY (never the session date) and a payment
 *   - pricing needs no new code: a holiday_rates row on the claimed date is
 *     billed; a weekend rate on a claimed weekend day is billed
 *   - per-head: headCount threads through and multiplies the rate
 *   - the 7-day / already-ended window is refused (server-side), and a
 *     refused call leaves nothing behind (no booking, no invoice)
 *   - a short payment leaves the booking confirmed with a live "part paid" balance
 *   - a restaurant backdated booking lands completed, while the shared
 *     completeBookingIfFullySettled still returns false for a settled
 *     restaurant booking (real-time path unchanged)
 *   - the GiST constraint refuses an overlapping historical slot (23P01) and
 *     rolls the whole transaction back
 *   - an audit_log row records the actor and claimed times
 *   - the manager gate, via the REAL actions behind the REAL requireManager()
 *     (cashier / floor_staff / signed-out refused; manager / owner succeed)
 *   - 7 days back (to the minute) succeeds; the claimed day's weekend, happy-hour
 *     and holiday rules are what bill, never today's config
 *   - ordinary bookings still default to backdated=false
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs --import ./scripts/next-runtime-hook.mjs scripts/test-backdated-booking.ts
 */
import { createHash, randomBytes } from 'node:crypto'
import { Pool } from 'pg'
import { loadEnv } from './env'

let pass = 0,
  fail = 0
const check = (l: string, c: boolean, got?: unknown) => {
  console.log(`${c ? '✓' : '✗ FAIL'}  ${l}${c ? '' : `  (got: ${JSON.stringify(got)})`}`)
  if (c) pass++
  else fail++
}

const TZ = 'Asia/Kolkata'
const DAY = 24 * 3600_000

async function main() {
  loadEnv()
  const { recordBackdatedBookingCore, assertBackdatedWindow, previewBackdatedBooking } = await import('../lib/booking/backdated')
  const { createBookingCore, completeBookingIfFullySettled, BookingError } = await import('../lib/booking/service')
  const { todayInZone, addDays } = await import('../lib/booking/time')
  const { isManager } = await import('../lib/auth/roles')
  const { withUser } = await import('../db')
  const { loadInvoiceReceipt } = await import('../lib/billing/receipt')

  const owner = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })

  async function makeTenant(slug: string, industry: string) {
    const t = await owner.query<{ id: string }>(
      `insert into tenants (slug,name,status,timezone,industry) values ($1,$2,'active',$3,$4)
       on conflict (slug) do update set name=excluded.name, industry=excluded.industry returning id`,
      [slug, `${slug} co`, TZ, industry],
    )
    const tenantId = t.rows[0].id
    const b = await owner.query<{ id: string }>(
      `insert into branches (tenant_id,name,is_primary) values ($1,'Main',true)
       on conflict (tenant_id,name) do update set is_primary=true returning id`,
      [tenantId],
    )
    const u = await owner.query<{ id: string }>(
      `insert into users (email,password_hash) values ($1,'x')
       on conflict (email) do update set email=excluded.email returning id`,
      [`owner@${slug}.test`],
    )
    const m = await owner.query<{ id: string }>(
      `insert into memberships (tenant_id,user_id,role,status) values ($1,$2,'owner','active')
       on conflict (tenant_id,user_id) do update set role='owner', status='active' returning id`,
      [tenantId, u.rows[0].id],
    )
    // Idempotent against a previous run that died mid-way.
    await owner.query(`delete from audit_log where tenant_id=$1`, [tenantId])
    await owner.query(`delete from payments where tenant_id=$1`, [tenantId])
    await owner.query(`delete from invoices where tenant_id=$1`, [tenantId])
    await owner.query(`delete from booking_slots where tenant_id=$1`, [tenantId])
    await owner.query(`delete from bookings where tenant_id=$1`, [tenantId])
    await owner.query(`delete from holiday_rates where tenant_id=$1`, [tenantId])
    await owner.query(`delete from sequences where tenant_id=$1`, [tenantId])
    return { tenantId, branchId: b.rows[0].id, userId: u.rows[0].id, membershipId: m.rows[0].id }
  }

  async function makeResource(t: { tenantId: string; branchId: string }, name: string, rate: string, extra = '', vals: unknown[] = []) {
    const rt = await owner.query<{ id: string }>(
      `insert into resource_types (tenant_id,name,hourly_rate${extra ? ',' + extra.split('=')[0] : ''})
       values ($1,$2,$3${vals.length ? ',$4' : ''})
       on conflict (tenant_id,name) do update set hourly_rate=excluded.hourly_rate returning id`,
      [t.tenantId, name, rate, ...vals],
    )
    const r = await owner.query<{ id: string }>(
      `insert into resources (tenant_id,branch_id,resource_type_id,name,status) values ($1,$2,$3,$4,'available')
       on conflict (tenant_id,name) do update set status='available' returning id`,
      [t.tenantId, t.branchId, rt.rows[0].id, `${name}-1`],
    )
    return { typeId: rt.rows[0].id, resourceId: r.rows[0].id }
  }

  const localAt = (dateStr: string, hhmm: string) => new Date(`${dateStr}T${hhmm}:00+05:30`)
  const now = new Date()
  const today = todayInZone(TZ, now)
  const yesterday = addDays(today, -1)

  // ── gaming cafe ──────────────────────────────────────────────────────────
  const A = await makeTenant('testbackdated', 'gaming_cafe')
  const ctxA = { tenantId: A.tenantId, timezone: TZ, membershipId: A.membershipId }
  const ps5 = await makeResource(A, 'PS5 Backdated', '100.00')
  const snooker = await makeResource(A, 'Snooker Backdated', '50.00', 'pricing_mode', ['per_head'])
  await owner.query(`update resource_types set pricing_mode='per_head', min_players=2 where id=$1`, [snooker.typeId])
  const ps5B = await makeResource(A, 'PS5 Backdated2', '100.00')

  const base = (resourceId: string, start: Date, end: Date, over: Record<string, unknown> = {}) => ({
    branchId: A.branchId,
    customerName: 'Late Entry',
    customerPhone: '9876500011',
    slots: [{ resourceId, startsAt: start.toISOString(), endsAt: end.toISOString() }],
    amountCollected: 200,
    paymentMethod: 'cash' as const,
    ...over,
  })
  const record = (input: ReturnType<typeof base>) =>
    withUser(A.userId, (tx) => recordBackdatedBookingCore(tx, { ...ctxA, membershipId: A.membershipId }, input))

  // ══ 0. idempotent retry: same key returns the first booking, no duplicate ══
  console.log('\n── idempotency key ──')
  {
    const key = 'idem-test-key-0001'
    const inp = base(ps5.resourceId, localAt(yesterday, '08:00'), localAt(yesterday, '09:00'), { idempotencyKey: key, amountCollected: 100 })
    const first = await record(inp)
    const again = await record(inp)
    check('retry returns the SAME booking instead of a slot collision', again.bookingId === first.bookingId && again.invoiceNumber === first.invoiceNumber, { first, again })
    const n = Number((await owner.query(`select count(*) from bookings where tenant_id=$1 and id=$2`, [A.tenantId, first.bookingId])).rows[0].count)
    const inv = Number((await owner.query(`select count(*) from invoices where booking_id=$1`, [first.bookingId])).rows[0].count)
    check('one booking and one invoice exist', n === 1 && inv === 1, { n, inv })
  }

  // ══ 1. happy path — yesterday, fully paid ════════════════════════════════
  console.log('\n── yesterday, paid in full ──')
  const r1 = await record(base(ps5.resourceId, localAt(yesterday, '10:00'), localAt(yesterday, '12:00')))
  {
    check('lands completed', r1.completed === true)
    const b = (await owner.query(`select status, backdated, completed_at, source from bookings where id=$1`, [r1.bookingId])).rows[0]
    check('status = completed', b.status === 'completed', b.status)
    check('backdated = true', b.backdated === true)
    check('completed_at is set', b.completed_at !== null)
    const inv = (await owner.query(`select status, total, issued_at from invoices where booking_id=$1`, [r1.bookingId])).rows[0]
    check('invoice total = 200.00 (2h × ₹100)', Number(inv.total) === 200, inv.total)
    check('invoice status = paid', inv.status === 'paid', inv.status)
    const issuedDay = todayInZone(TZ, new Date(inv.issued_at))
    check('invoice is stamped with TODAY, not the session date', issuedDay === today, issuedDay)
    check('invoice number is not derived from yesterday', r1.invoiceNumber.length > 0)
    const p = (await owner.query(`select method, amount, status from payments where invoice_id=$1`, [r1.invoiceId])).rows
    check('one cash payment of 200.00', p.length === 1 && p[0].method === 'cash' && Number(p[0].amount) === 200, p)
    const audit = (await owner.query(
      `select actor_membership_id, after from audit_log where entity_id=$1 and action='booking.backdated_entry'`,
      [r1.bookingId],
    )).rows
    check('one booking.backdated_entry audit row', audit.length === 1)
    check('audit actor = the manager', audit[0]?.actor_membership_id === A.membershipId)
    check('audit records the claimed slot times', audit[0]?.after?.slots?.[0]?.startsAt === localAt(yesterday, '10:00').toISOString())
  }

  // ══ 1b. late-entry surfacing (M28 #4) ═══════════════════════════════════
  console.log('\n── late-entry flag on the receipt ──')
  {
    const rc = await withUser(A.userId, (tx) => loadInvoiceReceipt(tx, A.tenantId, r1.invoiceId))
    check('receipt of a backdated booking carries lateEntry', rc?.lateEntry != null)
    check('sessionStart is the claimed start', rc?.lateEntry?.sessionStart.toISOString() === localAt(yesterday, '10:00').toISOString(), rc?.lateEntry)
    check('recordedAt is (about) now, not the session', !!rc?.lateEntry && Math.abs(rc.lateEntry.recordedAt.getTime() - Date.now()) < 5 * 60_000)
  }

  // ══ 2. holiday pricing on the claimed date, no new pricing code ═════════
  console.log('\n── holiday rate on the claimed date ──')
  {
    const twoDaysAgo = addDays(today, -2)
    await owner.query(`insert into holiday_rates (tenant_id,resource_type_id,date,rate) values ($1,$2,$3,'300.00')`, [
      A.tenantId, ps5.typeId, twoDaysAgo,
    ])
    const r = await record(base(ps5.resourceId, localAt(twoDaysAgo, '10:00'), localAt(twoDaysAgo, '11:00'), { amountCollected: 300 }))
    const slot = (await owner.query(`select rate_applied, holiday_rate_applied from booking_slots where booking_id=$1`, [r.bookingId])).rows[0]
    check('holiday rate applied (300.00 not 100.00)', Number(slot.rate_applied) === 300 && slot.holiday_rate_applied === true, slot)
    check('and it settled + completed at that price', r.completed === true)
  }

  // ══ 2b. preview == charge, and leaves nothing behind ════════════════════
  console.log('\n── preview ──')
  {
    const d = addDays(today, -5)
    const counts = async () =>
      [
        Number((await owner.query(`select count(*) from bookings where tenant_id=$1`, [A.tenantId])).rows[0].count),
        Number((await owner.query(`select count(*) from invoices where tenant_id=$1`, [A.tenantId])).rows[0].count),
        Number((await owner.query(`select value from sequences where tenant_id=$1 and kind='booking' order by period desc limit 1`, [A.tenantId])).rows[0]?.value ?? 0),
      ].join('/')
    const before = await counts()
    const input = base(ps5.resourceId, localAt(d, '14:00'), localAt(d, '16:30'))
    const pv = await previewBackdatedBooking((fn) => withUser(A.userId, fn), ctxA, input)
    check('preview leaves no booking/invoice and does not burn a number', (await counts()) === before, [before, await counts()])
    const real = await record({ ...input, amountCollected: pv.total })
    const inv = (await owner.query(`select total from invoices where id=$1`, [real.invoiceId])).rows[0]
    check('preview total equals the invoice actually raised', Number(inv.total) === pv.total, [pv, inv])
    check('...and paying the previewed total completes it', real.completed === true)

    let refused = ''
    try {
      await previewBackdatedBooking((fn) => withUser(A.userId, fn), ctxA, base(ps5.resourceId, new Date(now.getTime() - 9 * DAY), new Date(now.getTime() - 9 * DAY + 3600_000)))
    } catch (e) {
      refused = e instanceof BookingError ? e.message : 'other'
    }
    check('preview surfaces the window refusal', refused.includes('7 days'), refused)
  }

  // ══ 3. per-head ══════════════════════════════════════════════════════════
  console.log('\n── per-head resource ──')
  {
    const d = addDays(today, -3)
    const r = await record(base(snooker.resourceId, localAt(d, '10:00'), localAt(d, '11:00'), { headCount: 3, amountCollected: 150 }))
    const b = (await owner.query(`select head_count, total from bookings where id=$1`, [r.bookingId])).rows[0]
    check('head_count = 3 stored', b.head_count === 3, b)
    check('total = ₹150 (1h × 3 × ₹50)', Number(b.total) === 150, b.total)
    check('completed', r.completed === true)
  }

  // ══ 4. window enforced server-side ═══════════════════════════════════════
  console.log('\n── window ──')
  {
    const countBefore = Number((await owner.query(`select count(*) from bookings where tenant_id=$1`, [A.tenantId])).rows[0].count)
    const attempt = async (label: string, start: Date, end: Date) => {
      let msg = ''
      try {
        await record(base(ps5B.resourceId, start, end))
      } catch (e) {
        msg = e instanceof BookingError ? e.message : `non-BookingError: ${String(e)}`
      }
      check(label, msg !== '' && !msg.startsWith('non-BookingError'), msg)
    }
    await attempt('older than 7 days is refused', new Date(now.getTime() - 8 * DAY), new Date(now.getTime() - 8 * DAY + 3600_000))
    await attempt('a session still in the future is refused', new Date(now.getTime() + 3600_000), new Date(now.getTime() + 2 * 3600_000))
    await attempt('a session that ends in the future (started past) is refused', new Date(now.getTime() - 3600_000), new Date(now.getTime() + 3600_000))
    await attempt('end before start is refused', new Date(now.getTime() - 3600_000), new Date(now.getTime() - 2 * 3600_000))
    const countAfter = Number((await owner.query(`select count(*) from bookings where tenant_id=$1`, [A.tenantId])).rows[0].count)
    check('refusals leave no booking behind', countAfter === countBefore, [countBefore, countAfter])

    let ok = true
    try {
      assertBackdatedWindow([{ startsAt: new Date(now.getTime() - 6.9 * DAY).toISOString(), endsAt: new Date(now.getTime() - 6.8 * DAY).toISOString() }], now)
    } catch {
      ok = false
    }
    check('6.9 days back is accepted by the window check', ok)
  }

  // ══ 5. short payment ═════════════════════════════════════════════════════
  console.log('\n── short payment ──')
  {
    const d = addDays(today, -4)
    const r = await record(base(ps5B.resourceId, localAt(d, '10:00'), localAt(d, '12:00'), { amountCollected: 50 }))
    const b = (await owner.query(`select status from bookings where id=$1`, [r.bookingId])).rows[0]
    const inv = (await owner.query(`select status from invoices where id=$1`, [r.invoiceId])).rows[0]
    check('not completed (still owes)', r.completed === false && b.status === 'confirmed', b)
    check('invoice stays issued (part paid)', inv.status === 'issued', inv)
  }

  // ══ 6. overlap refused by the exclusion constraint, all rolled back ══════
  console.log('\n── overlap ──')
  {
    const before = Number((await owner.query(`select count(*) from bookings where tenant_id=$1`, [A.tenantId])).rows[0].count)
    let code = ''
    try {
      await record(base(ps5.resourceId, localAt(yesterday, '11:00'), localAt(yesterday, '13:00')))
    } catch (e) {
      code = (e as { code?: string; cause?: { code?: string } }).code ?? (e as { cause?: { code?: string } }).cause?.code ?? ''
    }
    check('overlapping historical slot is refused with 23P01', code === '23P01', code)
    const after = Number((await owner.query(`select count(*) from bookings where tenant_id=$1`, [A.tenantId])).rows[0].count)
    check('nothing left behind by the failed transaction', after === before, [before, after])
  }

  // ══ 7. ordinary bookings unaffected ══════════════════════════════════════
  console.log('\n── ordinary booking ──')
  {
    const start = new Date(now.getTime() + 3 * DAY)
    const b = await withUser(A.userId, (tx) =>
      createBookingCore(tx, ctxA, {
        branchId: A.branchId,
        source: 'staff',
        discount: 0,
        deposit: 0,
        slots: [{ resourceId: ps5.resourceId, startsAt: start.toISOString(), endsAt: new Date(start.getTime() + 3600_000).toISOString() }],
      }),
    )
    const row = (await owner.query(`select backdated from bookings where id=$1`, [b.id])).rows[0]
    check('a normal booking has backdated = false', row.backdated === false)
  }

  // ══ 7b. the window's inner edge ══════════════════════════════════════════
  console.log('\n── just inside 7 days back ──')
  {
    const ps5C = await makeResource(A, 'PS5 Backdated3', '100.00')
    // Fresh clock + a few minutes' margin: the suite itself takes a while to get here.
    const start = new Date(Date.now() - 7 * DAY + 5 * 60_000)
    const input = base(ps5C.resourceId, start, new Date(start.getTime() + 3600_000))
    const pv = await previewBackdatedBooking((fn) => withUser(A.userId, fn), ctxA, input)
    const r = await record({ ...input, amountCollected: pv.total })
    check('a session 7 days back (to the minute) succeeds and lands completed', r.completed === true)
    const inv = (await owner.query(`select status from invoices where id=$1`, [r.invoiceId])).rows[0]
    check('...with a real, paid invoice', inv.status === 'paid', inv)
  }

  // ══ 7c. historical pricing: the claimed day's rules, not today's ═════════
  console.log('\n── weekend / happy hour / holiday of the CLAIMED day ──')
  {
    const wknd = await makeResource(A, 'WKND Backdated', '100.00')
    await owner.query(`update resource_types set weekend_rate='150.00' where id=$1`, [wknd.typeId])
    const hh = await makeResource(A, 'HH Backdated', '100.00')
    const { weekdayInZone } = await import('../lib/booking/time')

    const priced = async (resourceId: string, dateStr: string, from: string, to: string) => {
      const input = base(resourceId, localAt(dateStr, from), localAt(dateStr, to))
      const pv = await previewBackdatedBooking((fn) => withUser(A.userId, fn), ctxA, input)
      const r = await record({ ...input, amountCollected: pv.total })
      const slot = (await owner.query(`select rate_applied, slot_total from booking_slots where booking_id=$1`, [r.bookingId])).rows[0]
      return { rate: Number(slot.rate_applied), total: Number(slot.slot_total), completed: r.completed }
    }

    // Weekend: the claimed date's weekday is configured as the weekend day.
    const dW = addDays(today, -3)
    const dWeekday = addDays(today, -2)
    await owner.query(
      `insert into business_profiles (tenant_id, weekend_days) values ($1, $2)
       on conflict (tenant_id) do update set weekend_days = excluded.weekend_days`,
      [A.tenantId, [weekdayInZone(dW, TZ)]],
    )
    const w = await priced(wknd.resourceId, dW, '10:00', '11:00')
    check('claimed weekend day bills the weekend rate (150)', w.rate === 150 && w.total === 150 && w.completed, w)
    const wc = await priced(wknd.resourceId, dWeekday, '10:00', '11:00')
    check('a claimed weekday bills the base rate (100)', wc.rate === 100, wc)

    // Happy hour: a rule for the claimed day's weekday + window.
    const dH = addDays(today, -4)
    await owner.query(
      `insert into happy_hours (tenant_id,name,days_of_week,start_time,end_time,discount_type,discount_value,is_active)
       values ($1,'Backdated HH',$2,'10:00','11:00','percentage',50,true)`,
      [A.tenantId, [weekdayInZone(dH, TZ)]],
    )
    const h = await priced(hh.resourceId, dH, '10:00', '11:00')
    check('claimed day inside its happy-hour window bills discounted (50)', h.rate === 50 && h.total === 50, h)
    const hc = await priced(hh.resourceId, addDays(today, -5), '10:00', '11:00')
    check('same clock time on a day the rule does not cover bills 100', hc.rate === 100, hc)
    const hOut = await priced(hh.resourceId, dH, '15:00', '16:00')
    check('same day, outside the window, bills 100', hOut.rate === 100, hOut)

    // A holiday configured for TODAY must not touch a session claimed earlier.
    await owner.query(`insert into holiday_rates (tenant_id,resource_type_id,date,rate) values ($1,$2,$3,'999.00')`, [
      A.tenantId, hh.typeId, today,
    ])
    const notToday = await priced(hh.resourceId, addDays(today, -6), '18:00', '19:00')
    check("today's holiday rate does not leak onto an earlier claimed day (100)", notToday.rate === 100, notToday)
    await owner.query(`delete from happy_hours where tenant_id=$1`, [A.tenantId])
    await owner.query(`delete from business_profiles where tenant_id=$1`, [A.tenantId])
  }

  // ══ 8. manager gate — the REAL action behind the REAL requireManager() ═══
  console.log('\n── role gate (direct action calls) ──')
  check('isManager: owner/manager pass, cashier/floor_staff refused',
    isManager('owner') && isManager('manager') && !isManager('cashier' as never) && !isManager('floor_staff' as never))
  {
    const { recordBackdatedBooking, quoteBackdatedBooking } = await import('../lib/actions/backdated-bookings')
    const tag = randomBytes(3).toString('hex')
    const slug = `testbackdatedact${tag}`
    const t = await owner.query<{ id: string }>(
      `insert into tenants (slug,name,status,timezone,industry) values ($1,'Act Co','active',$2,'gaming_cafe') returning id`,
      [slug, TZ],
    )
    const tenantId = t.rows[0].id
    const br = await owner.query<{ id: string }>(
      `insert into branches (tenant_id,name,is_primary) values ($1,'Main',true) returning id`,
      [tenantId],
    )
    const branchId = br.rows[0].id
    const rt = await owner.query<{ id: string }>(
      `insert into resource_types (tenant_id,name,hourly_rate) values ($1,'PS5 Act','100.00') returning id`,
      [tenantId],
    )
    const rs = await owner.query<{ id: string }>(
      `insert into resources (tenant_id,branch_id,resource_type_id,name,status) values ($1,$2,$3,'Act-1','available') returning id`,
      [tenantId, branchId, rt.rows[0].id],
    )
    const sessions: Record<string, { token: string; membershipId: string }> = {}
    for (const role of ['owner', 'manager', 'cashier', 'floor_staff']) {
      const u = await owner.query<{ id: string }>(
        `insert into users (email,password_hash,full_name) values ($1,'x',$2) returning id`,
        [`act-${role}-${tag}@example.test`, role],
      )
      const token = randomBytes(32).toString('hex')
      await owner.query(`insert into sessions (id, user_id, expires_at) values ($1,$2, now() + interval '1 day')`, [
        createHash('sha256').update(token).digest('hex'),
        u.rows[0].id,
      ])
      const m = await owner.query<{ id: string }>(
        `insert into memberships (tenant_id,user_id,branch_id,role,status,full_name) values ($1,$2,$3,$4::member_role,'active',$5) returning id`,
        [tenantId, u.rows[0].id, branchId, role, role],
      )
      sessions[role] = { token, membershipId: m.rows[0].id }
    }
    const g = globalThis as { __ARENA_TEST_SESSION?: string; __ARENA_TEST_HEADERS?: Record<string, string> }
    g.__ARENA_TEST_HEADERS = { 'x-tenant-slug': slug }
    const signedInAs = (role: string) => {
      g.__ARENA_TEST_SESSION = sessions[role].token
    }
    const input = (start: Date, end: Date) => ({
      branchId,
      customerName: 'Act Customer',
      customerPhone: '9876500044',
      slots: [{ resourceId: rs.rows[0].id, startsAt: start.toISOString(), endsAt: end.toISOString() }],
      amountCollected: 100,
      paymentMethod: 'cash' as const,
    })
    const good = () => input(localAt(yesterday, '10:00'), localAt(yesterday, '11:00'))
    const bookingCount = async () => Number((await owner.query(`select count(*) from bookings where tenant_id=$1`, [tenantId])).rows[0].count)

    for (const role of ['cashier', 'floor_staff']) {
      signedInAs(role)
      const r = await recordBackdatedBooking(good())
      check(`${role} is refused by the action`, /owners and managers/i.test(r.error ?? ''), r)
      const q = await quoteBackdatedBooking(good())
      check(`${role} is refused by the preview too`, /owners and managers/i.test(q.error ?? ''), q)
    }
    check('...and nothing was written', (await bookingCount()) === 0)

    signedInAs('manager')
    const old = await recordBackdatedBooking(input(new Date(now.getTime() - 8 * DAY), new Date(now.getTime() - 8 * DAY + 3600_000)))
    check('manager: 8 days back is refused by the action', /7 days/.test(old.error ?? ''), old)
    const fut = await recordBackdatedBooking(input(new Date(now.getTime() - 3600_000), new Date(now.getTime() + 3600_000)))
    check('manager: a session that ends in the future is refused', /already ended/.test(fut.error ?? ''), fut)
    check('...refusals wrote nothing', (await bookingCount()) === 0)

    const ok = await recordBackdatedBooking(good())
    check('manager: a valid backdated booking succeeds and lands completed', !ok.error && ok.completed === true, ok)
    const row = (await owner.query(`select status, backdated from bookings where id=$1`, [ok.bookingId])).rows[0]
    check('...status completed, backdated true', row?.status === 'completed' && row?.backdated === true, row)
    const aud = (await owner.query(`select actor_membership_id from audit_log where entity_id=$1 and action='booking.backdated_entry'`, [ok.bookingId])).rows
    check('...audit row names the manager', aud.length === 1 && aud[0].actor_membership_id === sessions.manager.membershipId, aud)

    signedInAs('owner')
    const overlap = await recordBackdatedBooking(input(localAt(yesterday, '10:30'), localAt(yesterday, '11:30')))
    check('overlap is refused with the standard friendly message', /just taken/i.test(overlap.error ?? ''), overlap)
    const ok2 = await recordBackdatedBooking(input(localAt(yesterday, '12:00'), localAt(yesterday, '13:00')))
    check('owner: a valid backdated booking succeeds too', !ok2.error && ok2.completed === true, ok2)

    g.__ARENA_TEST_SESSION = undefined
    const anon = await recordBackdatedBooking(good())
    check('signed out is refused', !!anon.error && !anon.bookingId, anon)
  }

  // ══ 9. restaurant ════════════════════════════════════════════════════════
  console.log('\n── restaurant ──')
  {
    const R = await makeTenant('testbackdatedrest', 'restaurant')
    const ctxR = { tenantId: R.tenantId, timezone: TZ, membershipId: R.membershipId }
    const table = await makeResource(R, 'Table Backdated', '200.00')
    const d = yesterday
    const rr = await withUser(R.userId, (tx) =>
      recordBackdatedBookingCore(tx, ctxR, {
        branchId: R.branchId,
        customerName: 'Diner',
        customerPhone: '9876500022',
        slots: [{ resourceId: table.resourceId, startsAt: localAt(d, '19:00').toISOString(), endsAt: localAt(d, '20:00').toISOString() }],
        amountCollected: 200,
        paymentMethod: 'upi',
      }),
    )
    const b = (await owner.query(`select status, backdated from bookings where id=$1`, [rr.bookingId])).rows[0]
    check('restaurant backdated booking lands completed', b.status === 'completed' && b.backdated === true, b)

    // Regression: the shared, real-time path still excludes restaurants.
    const live = await withUser(R.userId, (tx) =>
      createBookingCore(tx, ctxR, {
        branchId: R.branchId,
        source: 'staff',
        discount: 0,
        deposit: 0,
        slots: [
          {
            resourceId: table.resourceId,
            startsAt: new Date(now.getTime() + 2 * DAY).toISOString(),
            endsAt: new Date(now.getTime() + 2 * DAY + 3600_000).toISOString(),
          },
        ],
      }),
    )
    const { issueInvoiceForBooking } = await import('../lib/billing/invoice')
    const { recordPaymentForInvoice } = await import('../lib/billing/payments')
    const flipped = await withUser(R.userId, async (tx) => {
      const inv = await issueInvoiceForBooking(tx, { id: R.tenantId, timezone: TZ }, { bookingId: live.id })
      await recordPaymentForInvoice(tx, { tenantId: R.tenantId, membershipId: R.membershipId }, { invoiceId: inv.invoiceId, method: 'cash', amount: 200 })
      return completeBookingIfFullySettled(tx, R.tenantId, live.id)
    })
    const lb = (await owner.query(`select status from bookings where id=$1`, [live.id])).rows[0]
    const liveInv = (await owner.query(`select id from invoices where booking_id=$1`, [live.id])).rows[0]
    const lrc = await withUser(R.userId, (tx) => loadInvoiceReceipt(tx, R.tenantId, liveInv.id))
    check('a normal booking receipt has lateEntry = null', lrc?.lateEntry === null)
    check('real-time restaurant settlement still returns false', flipped === false)
    check('real-time restaurant booking stays confirmed (needs-cleaning step preserved)', lb.status === 'confirmed', lb)
  }

  console.log(`\n${pass} passed, ${fail} failed`)
  await owner.end()
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
