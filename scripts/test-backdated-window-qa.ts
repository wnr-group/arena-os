/**
 * M38 #2 — QA for the 45-day backdated window, the prior-month flag and the
 * regression pins around them. Real database; same primitives as the M28 suite.
 *
 *   1. boundary: 45 days back accepted, 46 refused with a message naming 45 (not 7)
 *   2. sessionCharge override still works at the wider window (40 days back)
 *   3. prior-month flag: previous month / the month before / current month, and
 *      the audit row's priorMonthEntry matches in each case
 *   4. idempotency-key dedup near the 45-day boundary
 *   5. overlap (migration 0121) unaffected at 30-40 days back
 *   6. reports: a newly backdated entry is counted once, on the day the money
 *      was taken, and a retry never double counts
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs --import ./scripts/next-runtime-hook.mjs scripts/test-backdated-window-qa.ts
 */
import { Pool } from 'pg'
import { loadEnv } from './env'
import { entitleTenant } from './entitle-fixture'
import type { ActiveContext } from '../lib/tenant/context'

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
  const { recordBackdatedBookingCore, assertBackdatedWindow, previewBackdatedBooking, BACKDATED_MAX_DAYS } =
    await import('../lib/booking/backdated')
  const { BookingError } = await import('../lib/booking/service')
  const { isPriorMonthDate } = await import('../lib/booking/backdated-window')
  const { todayInZone, addDays } = await import('../lib/booking/time')
  const { withUser } = await import('../db')
  const { getRevenueDashboard } = await import('../lib/reports/revenue')

  const owner = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })
  const slug = 'testbackdatedqa'
  const t = await owner.query<{ id: string }>(
    `insert into tenants (slug,name,status,timezone,industry) values ($1,$2,'active',$3,'gaming_cafe')
     on conflict (slug) do update set name=excluded.name returning id`,
    [slug, `${slug} co`, TZ],
  )
  const tenantId = t.rows[0].id
  await entitleTenant(owner, tenantId)
  const b = await owner.query<{ id: string }>(
    `insert into branches (tenant_id,name,is_primary,timezone) values ($1,'Main',true,$2)
     on conflict (tenant_id,name) do update set is_primary=true returning id`,
    [tenantId, TZ],
  )
  const branchId = b.rows[0].id
  const u = await owner.query<{ id: string }>(
    `insert into users (email,password_hash) values ($1,'x') on conflict (email) do update set email=excluded.email returning id`,
    [`owner@${slug}.test`],
  )
  const m = await owner.query<{ id: string }>(
    `insert into memberships (tenant_id,user_id,role,status) values ($1,$2,'owner','active')
     on conflict (tenant_id,user_id) do update set role='owner', status='active' returning id`,
    [tenantId, u.rows[0].id],
  )
  const wipe = async () => {
    for (const q of [
      'delete from audit_log where tenant_id=$1',
      'delete from payments where tenant_id=$1',
      'delete from invoice_items where tenant_id=$1',
      'delete from invoices where tenant_id=$1',
      'delete from booking_slots where tenant_id=$1',
      'delete from bookings where tenant_id=$1',
      'delete from sequences where tenant_id=$1',
    ])
      await owner.query(q, [tenantId])
  }
  await wipe()
  const rt = await owner.query<{ id: string }>(
    `insert into resource_types (tenant_id,name,hourly_rate) values ($1,'PS5 QA','100.00')
     on conflict (tenant_id,name) do update set hourly_rate=excluded.hourly_rate returning id`,
    [tenantId],
  )
  const res = await owner.query<{ id: string }>(
    `insert into resources (tenant_id,branch_id,resource_type_id,name,status) values ($1,$2,$3,'PS5 QA-1','available')
     on conflict (tenant_id,name) do update set status='available' returning id`,
    [tenantId, branchId, rt.rows[0].id],
  )
  const resourceId = res.rows[0].id

  const ctx = { tenantId, timezone: TZ, membershipId: m.rows[0].id }
  const localAt = (d: string, hhmm: string) => new Date(`${d}T${hhmm}:00+05:30`)
  const now = new Date()
  const today = todayInZone(TZ, now)
  const base = (start: Date, end: Date, over: Record<string, unknown> = {}) => ({
    branchId,
    customerName: 'QA Entry',
    customerPhone: '9876500022',
    slots: [{ resourceId, startsAt: start.toISOString(), endsAt: end.toISOString() }],
    amountCollected: 100,
    paymentMethod: 'cash' as const,
    sessionCharge: undefined as number | undefined,
    ...over,
  })
  const record = (input: ReturnType<typeof base> & { idempotencyKey?: string }) =>
    withUser(u.rows[0].id, (tx) => recordBackdatedBookingCore(tx, ctx, input))
  const audit = async (bookingId: string) =>
    (
      await owner.query(`select after from audit_log where entity_id=$1 and action='booking.backdated_entry'`, [
        bookingId,
      ])
    ).rows[0]?.after
  const errOf = async (p: Promise<unknown>) => {
    try {
      await p
      return ''
    } catch (e) {
      return e instanceof BookingError ? e.message : `non-BookingError: ${String(e)}`
    }
  }

  // ══ 1. boundary ══════════════════════════════════════════════════════════
  console.log('\n── boundary: 45 accepted, 46 refused ──')
  {
    check('the configured window is 45 days', BACKDATED_MAX_DAYS === 45, BACKDATED_MAX_DAYS)
    // A few minutes inside the edge: the suite itself takes a while to get here.
    const edge = new Date(Date.now() - 45 * DAY + 5 * 60_000)
    const r = await record(base(edge, new Date(edge.getTime() + 3600_000)))
    check('exactly 45 days back is accepted and lands completed', r.completed === true, r)

    const refused = await errOf(
      record(base(new Date(now.getTime() - 46 * DAY), new Date(now.getTime() - 46 * DAY + 3600_000))),
    )
    check('46 days back is refused', refused !== '' && !refused.startsWith('non-BookingError'), refused)
    check('…the message names 45', /45 days/.test(refused), refused)
    check('…and no longer says 7', !/\b7 days\b/.test(refused), refused)
    let atEdge = true
    try {
      assertBackdatedWindow(
        [
          {
            startsAt: new Date(now.getTime() - 44.99 * DAY).toISOString(),
            endsAt: new Date(now.getTime() - 44.9 * DAY).toISOString(),
          },
        ],
        now,
      )
    } catch {
      atEdge = false
    }
    check('the pure window rule accepts 44.99 days', atEdge)
    const n = Number((await owner.query(`select count(*) from bookings where tenant_id=$1`, [tenantId])).rows[0].count)
    check('the refusal left no booking behind (only the 45-day entry exists)', n === 1, n)
  }

  // ══ 2. sessionCharge override at the wider window ════════════════════════
  console.log('\n── sessionCharge override at 40 days back ──')
  {
    const d = addDays(today, -40)
    const input = base(localAt(d, '14:00'), localAt(d, '16:00'))
    const pv = await previewBackdatedBooking((fn) => withUser(u.rows[0].id, fn), ctx, input)
    const calc = pv.computedSubtotal
    check('preview reports the computed charge at 40 days', calc > 0 && pv.subtotal === calc, pv)
    const low = { ...input, sessionCharge: Math.round(calc / 2) }
    const lowPv = await previewBackdatedBooking((fn) => withUser(u.rows[0].id, fn), ctx, low)
    const r = await record({ ...low, amountCollected: lowPv.total })
    const inv = (await owner.query(`select subtotal,total from invoices where id=$1`, [r.invoiceId])).rows[0]
    check(
      'a manager billing a different figure succeeds: invoice subtotal = the manager figure',
      Number(inv.subtotal) === low.sessionCharge,
      inv,
    )
    check('…and settles', r.completed === true && Number(inv.total) === lowPv.total, [inv, lowPv])
    const a = await audit(r.bookingId)
    check(
      '…the audit row keeps both the computed and the billed charge',
      a?.computedSessionCharge === calc && a?.sessionCharge === low.sessionCharge,
      a,
    )
  }

  // ══ 3. prior-month confirmation flag ═════════════════════════════════════
  console.log('\n── prior-month flag ──')
  {
    // Pure rule first (independent of what day the suite runs on).
    check('previous month → prior', isPriorMonthDate('2026-09-30', '2026-10-05'))
    check('the month before that → prior', isPriorMonthDate('2026-08-31', '2026-10-05'))
    check('same month → not prior', !isPriorMonthDate('2026-10-01', '2026-10-05'))
    check('across a year boundary → prior', isPriorMonthDate('2025-12-31', '2026-01-02'))
    check('last day of previous month vs the 1st → prior', isPriorMonthDate('2026-09-30', '2026-10-01'))

    const dom = Number(today.slice(8, 10))
    const prevLast = addDays(today, -dom) // last day of the previous month
    const prevLen = Number(prevLast.slice(8, 10))
    const twoLast = addDays(prevLast, -prevLen) // last day of the month before that
    const daysBack = (d: string) => Math.round((new Date(today).getTime() - new Date(d).getTime()) / DAY)

    const prev = await record(base(localAt(prevLast, '10:00'), localAt(prevLast, '11:00')))
    check('a date in the previous calendar month is flagged in the audit row', (await audit(prev.bookingId))?.priorMonthEntry === true)
    const prevRow = (await owner.query(`select status, backdated from bookings where id=$1`, [prev.bookingId])).rows[0]
    check('…and the flagged entry still records the booking correctly', prevRow.status === 'completed' && prevRow.backdated === true, prevRow)

    if (daysBack(twoLast) <= 44) {
      const two = await record(base(localAt(twoLast, '10:00'), localAt(twoLast, '11:00')))
      check('a date two months back (reachable inside 45 days today) is flagged', (await audit(two.bookingId))?.priorMonthEntry === true)
    } else {
      console.log(`  (two months back is ${daysBack(twoLast)} days away today — covered by the pure rule above)`)
    }

    if (dom > 1) {
      const yesterday = addDays(today, -1)
      const cur = await record(base(localAt(yesterday, '10:00'), localAt(yesterday, '11:00')))
      check('a date in the current month is NOT flagged', (await audit(cur.bookingId))?.priorMonthEntry === false)
      const row = (await owner.query(`select status, backdated from bookings where id=$1`, [cur.bookingId])).rows[0]
      check('…and still records the booking correctly', row.status === 'completed' && row.backdated === true, row)
    } else {
      console.log('  (today is the 1st — no current-month past day exists; covered by the pure rule above)')
    }
  }

  // ══ 4. idempotency near the boundary ═════════════════════════════════════
  console.log('\n── idempotency key near 45 days ──')
  {
    const start = new Date(Date.now() - 44.5 * DAY)
    const inp = base(start, new Date(start.getTime() + 3600_000), { idempotencyKey: 'qa-boundary-key-0001' })
    const first = await record(inp)
    const again = await record(inp)
    check('a retry returns the SAME booking and invoice', again.bookingId === first.bookingId && again.invoiceNumber === first.invoiceNumber, { first, again })
    const inv = Number((await owner.query(`select count(*) from invoices where booking_id=$1`, [first.bookingId])).rows[0].count)
    const aud = Number(
      (await owner.query(`select count(*) from audit_log where entity_id=$1 and action='booking.backdated_entry'`, [first.bookingId])).rows[0].count,
    )
    const pay = Number((await owner.query(`select count(*) from payments where invoice_id=$1`, [first.invoiceId])).rows[0].count)
    check('…one invoice, one audit row, one payment', inv === 1 && aud === 1 && pay === 1, { inv, aud, pay })
    const [r1, r2] = await Promise.all([
      record({ ...inp, idempotencyKey: 'qa-boundary-key-0002' }),
      record({ ...inp, idempotencyKey: 'qa-boundary-key-0002' }),
    ])
    check('two concurrent submissions with one key collapse to one booking', r1.bookingId === r2.bookingId, [r1.bookingId, r2.bookingId])
  }

  // ══ 5. overlap unaffected ════════════════════════════════════════════════
  console.log('\n── overlap at 30-40 days back ──')
  {
    for (const back of [30, 35, 40]) {
      const d = addDays(today, -back)
      const first = await record(base(localAt(d, '10:00'), localAt(d, '12:00')))
      const second = await record(base(localAt(d, '11:00'), localAt(d, '13:00')))
      const sl = (
        await owner.query(`select active, backdated from booking_slots where booking_id = any($1)`, [
          [first.bookingId, second.bookingId],
        ])
      ).rows
      check(
        `${back} days back: an overlapping historical slot is accepted; both stay active and flagged backdated`,
        sl.length === 2 && sl.every((s) => s.active === true && s.backdated === true),
        sl,
      )
    }
    // The constraint still guards an ordinary future booking on the same resource.
    const { createBookingCore } = await import('../lib/booking/service')
    const start = new Date(now.getTime() + 5 * DAY)
    const slot = { resourceId, startsAt: start.toISOString(), endsAt: new Date(start.getTime() + 3600_000).toISOString() }
    const mk = () =>
      withUser(u.rows[0].id, (tx) =>
        createBookingCore(tx, ctx, { branchId, source: 'staff', discount: 0, deposit: 0, slots: [slot] }),
      )
    await mk()
    let code = ''
    try {
      await mk()
    } catch (e) {
      code = (e as { code?: string; cause?: { code?: string } }).code ?? (e as { cause?: { code?: string } }).cause?.code ?? ''
    }
    check('two ordinary overlapping bookings are still refused (23P01)', code === '23P01', code)
  }

  // ══ 6. reports ═══════════════════════════════════════════════════════════
  console.log('\n── reports across a newly backdated entry ──')
  {
    await wipe()
    const reportCtx: ActiveContext = {
      user: { id: u.rows[0].id, email: `owner@${slug}.test`, fullName: null, isPlatformAdmin: false },
      tenant: { id: tenantId, slug, name: `${slug} co`, industry: 'gaming', status: 'active', currency: 'INR', timezone: TZ },
      role: 'owner',
      membershipId: m.rows[0].id,
      branchId,
    }
    const wide = { start: addDays(today, -60), end: today }
    const d = addDays(today, -40)
    const inp = base(localAt(d, '10:00'), localAt(d, '12:00'), { idempotencyKey: 'qa-report-key-0001', amountCollected: 200 })
    const before = await getRevenueDashboard(reportCtx, { range: wide })
    check('no revenue before the entry', before.revenueTotals.net === 0, before.revenueTotals.net)

    await record(inp)
    await record(inp) // an idempotent retry must not double count
    const after = await getRevenueDashboard(reportCtx, { range: wide })
    check('the entry appears once in a range spanning it: net = ₹200', after.revenueTotals.net === 200, after.revenueTotals.net)
    check('…as booking revenue', after.revenueTotals.bookingRevenue === 200, after.revenueTotals.bookingRevenue)
    const paidDays = after.days.filter((x) => x.net > 0)
    check('…on the day the money was taken (today), not the session date', paidDays.length === 1 && paidDays[0].day === today, paidDays.map((x) => x.day))
    check('…the day rows sum back to the total', Math.round(after.days.reduce((s, x) => s + x.net, 0) * 100) / 100 === after.revenueTotals.net)
    check(
      '…channel split sums to the total (existing invariant)',
      Math.round((after.channelTotals.walkin.net + after.channelTotals.reserved.net) * 100) / 100 === after.revenueTotals.net,
    )
    const sessionDayOnly = await getRevenueDashboard(reportCtx, { range: { start: d, end: d } })
    check('a range covering only the session date shows no revenue (no accrual to the session day)', sessionDayOnly.revenueTotals.net === 0, sessionDayOnly.revenueTotals.net)
  }

  await wipe()
  console.log(`\n${pass} passed, ${fail} failed`)
  await owner.end()
  if (fail > 0) process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
