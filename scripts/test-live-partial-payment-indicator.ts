/**
 * M26 #5 — data plumbing for the live, pre-bill "Partially paid" indicator.
 *
 * The indicator itself is a client-side badge (components/sessions/
 * SessionsBoard.tsx / components/bookings/BookingsView.tsx) computed from
 * server-supplied numbers — this pins the SERVER half: that
 * listActiveWalkins (lib/booking/walkin.ts) and listDayBookings
 * (lib/booking/data.ts) actually carry bookings.advance_paid (and, for
 * listDayBookings, booking_slots.slot_total) through to the props those
 * components render from, so the client-side comparison has real numbers to
 * work with rather than silently reading undefined as 0 everywhere.
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs scripts/test-live-partial-payment-indicator.ts
 */
import { Pool } from 'pg'
import { loadEnv } from './env'
import type { ActiveContext } from '../lib/tenant/context'

let pass = 0,
  fail = 0
const check = (l: string, c: boolean) => {
  console.log(`${c ? '✓' : '✗ FAIL'}  ${l}`)
  if (c) pass++
  else fail++
}

const TZ = 'Asia/Kolkata'

async function main() {
  loadEnv()
  const { listActiveWalkins } = await import('../lib/booking/walkin')
  const { listDayBookings } = await import('../lib/booking/data')
  const { todayInZone } = await import('../lib/booking/time')

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
    const branchId = b.rows[0].id
    const u = await owner.query<{ id: string }>(
      `insert into users (email,password_hash) values ($1,'x')
       on conflict (email) do update set email=excluded.email returning id`,
      [`owner@${slug}.test`],
    )
    const userId = u.rows[0].id
    const m = await owner.query<{ id: string }>(
      `insert into memberships (tenant_id,user_id,role,status) values ($1,$2,'owner','active')
       on conflict (tenant_id,user_id) do update set role='owner', status='active' returning id`,
      [tenantId, userId],
    )
    const rt = await owner.query<{ id: string }>(
      `insert into resource_types (tenant_id,name,hourly_rate) values ($1,'PS5','200.00')
       on conflict (tenant_id,name) do update set hourly_rate='200.00' returning id`,
      [tenantId],
    )
    const res = await owner.query<{ id: string }>(
      `insert into resources (tenant_id,branch_id,resource_type_id,name,status) values ($1,$2,$3,'S1','available')
       on conflict (tenant_id,name) do update set status='available' returning id`,
      [tenantId, branchId, rt.rows[0].id],
    )
    // Separate units for tests 2 and 3 — test 1 puts an OPEN-TAB walk-in
    // (ends_at = null, occupying indefinitely) on S1, which would conflict
    // with any later slot placed on the same resource.
    const res2 = await owner.query<{ id: string }>(
      `insert into resources (tenant_id,branch_id,resource_type_id,name,status) values ($1,$2,$3,'S2','available')
       on conflict (tenant_id,name) do update set status='available' returning id`,
      [tenantId, branchId, rt.rows[0].id],
    )
    const res3 = await owner.query<{ id: string }>(
      `insert into resources (tenant_id,branch_id,resource_type_id,name,status) values ($1,$2,$3,'S3','available')
       on conflict (tenant_id,name) do update set status='available' returning id`,
      [tenantId, branchId, rt.rows[0].id],
    )
    const ctx: ActiveContext = {
      user: { id: userId, email: `owner@${slug}.test`, fullName: null, isPlatformAdmin: false },
      tenant: { id: tenantId, slug, name: `${slug} co`, industry, status: 'active', currency: 'INR', timezone: TZ },
      role: 'owner',
      membershipId: m.rows[0].id,
      branchId,
    }
    return { tenantId, branchId, resourceId: res.rows[0].id, resourceId2: res2.rows[0].id, resourceId3: res3.rows[0].id, ctx }
  }

  const A = await makeTenant('testliveinda', 'gaming_cafe')
  await owner.query('delete from bookings where tenant_id=$1', [A.tenantId])
  await owner.query('delete from sequences where tenant_id=$1', [A.tenantId])

  /** M30 #4: the board/list loaders sum the advance_payments ledger live; the
   *  superseded bookings.advance_paid column is deliberately left at 0. */
  const ledger = async (bookingId: string, tenders: [string, number][]) => {
    for (const [method, amount] of tenders) {
      await owner.query(
        `insert into advance_payments (tenant_id,branch_id,booking_id,method,amount) values ($1,$2,$3,$4,$5)`,
        [A.tenantId, A.branchId, bookingId, method, amount.toFixed(2)],
      )
    }
  }

  // ══ 1. listActiveWalkins carries advance_paid through ═══════════════════
  console.log('\n── listActiveWalkins ──')
  {
    const bk = await owner.query<{ id: string }>(
      `insert into bookings (tenant_id,branch_id,booking_number,status,channel,billing_mode,subtotal,total,advance_paid,checked_in_at)
       values ($1,$2,'LI-1','checked_in','walkin','open_tab','0','0','0.00',now()) returning id`,
      [A.tenantId, A.branchId],
    )
    await ledger(bk.rows[0].id, [['cash', 200], ['upi', 150]])
    await owner.query(
      `insert into booking_slots (tenant_id,booking_id,resource_id,starts_at,ends_at,rate_applied,slot_total,resource_name,resource_type_name,active)
       values ($1,$2,$3,now(),null,'200.00','0.00','S1','PS5',true)`,
      [A.tenantId, bk.rows[0].id, A.resourceId],
    )
    const rows = await listActiveWalkins(A.ctx, A.branchId)
    const row = rows.find((r) => r.bookingId === bk.rows[0].id)
    check('the active walk-in is returned', row !== undefined)
    check("…carrying the ledger SUM (200 cash + 150 UPI) = '350.00' through to the board's props", row?.advancePaid === '350.00')
  }

  // ══ 2. listDayBookings carries advance_paid AND slot_total through ══════
  console.log('\n── listDayBookings ──')
  {
    const start = new Date()
    const end = new Date(start.getTime() + 3600_000)
    // CodeRabbit review: was new Date().toISOString().slice(0, 10) — the UTC
    // calendar date, which disagrees with TZ (Asia/Kolkata, UTC+5:30) for
    // roughly a third of the day (from 18:30 UTC to 23:59 UTC, IST has
    // already rolled to the next date). listDayBookings computes its day
    // window from `today` + TZ, so a UTC-derived date could put `start`
    // (the slot's real starts_at, "now") outside the window this test then
    // queries — the booking wouldn't be found, and the test would fail,
    // depending only on what time of day it happened to run. Deriving from
    // `start` itself in the same TZ the query uses makes the two agree
    // regardless of wall-clock time.
    const today = todayInZone(TZ, start)
    const bk = await owner.query<{ id: string }>(
      `insert into bookings (tenant_id,branch_id,booking_number,status,channel,subtotal,total,advance_paid)
       values ($1,$2,'LI-2','confirmed','reserved','500','500','0.00') returning id`,
      [A.tenantId, A.branchId],
    )
    await ledger(bk.rows[0].id, [['card', 200]])
    await owner.query(
      `insert into booking_slots (tenant_id,booking_id,resource_id,starts_at,ends_at,rate_applied,slot_total,resource_name,resource_type_name,active)
       values ($1,$2,$3,$4,$5,'200.00','500.00','S2','PS5',true)`,
      [A.tenantId, bk.rows[0].id, A.resourceId2, start, end],
    )
    const rows = await listDayBookings(A.ctx, A.branchId, today, TZ)
    const row = rows.find((r) => r.bookingId === bk.rows[0].id)
    check('the reserved booking is returned on its day', row !== undefined)
    check("…carrying advance_paid = '200.00' through", row?.advancePaid === '200.00')
    check("…carrying slot_total = '500.00' through — the figure the live gap is computed against", row?.slotTotal === '500.00')
  }

  // ══ 3. advance_paid = 0 flows through cleanly (the common case) ═════════
  console.log('\n── advance_paid = 0 (the default) ──')
  {
    const bk = await owner.query<{ id: string }>(
      `insert into bookings (tenant_id,branch_id,booking_number,status,channel,billing_mode,subtotal,total,checked_in_at)
       values ($1,$2,'LI-3','checked_in','walkin','open_tab','0','0',now()) returning id`,
      [A.tenantId, A.branchId],
    )
    await owner.query(
      `insert into booking_slots (tenant_id,booking_id,resource_id,starts_at,ends_at,rate_applied,slot_total,resource_name,resource_type_name,active)
       values ($1,$2,$3,now(),null,'200.00','0.00','S3','PS5',true)`,
      [A.tenantId, bk.rows[0].id, A.resourceId3],
    )
    const rows = await listActiveWalkins(A.ctx, A.branchId)
    const row = rows.find((r) => r.bookingId === bk.rows[0].id)
    check("a walk-in with nothing collected upfront reads advance_paid = '0.00', not null/undefined", row?.advancePaid === '0.00')
  }

  await owner.end()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
