/**
 * Walk-in vs reserved revenue channel split (M21 #7).
 *
 * lib/reports/revenue-basis.ts's cashMovements() now carries each invoice's
 * booking's `channel` ('walkin' or 'reserved', bookings.channel's own two
 * values — 'reserved' for a booking-less counter sale too), and
 * getRevenueDashboard/getSalesReport can filter or break totals down by it.
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs scripts/test-revenue-channel-split.ts
 *
 * Proves:
 *   - a walk-in-channel booking's revenue counts as walk-in
 *   - a reserved-channel booking's revenue counts as reserved
 *   - a booking-less counter sale (no booking_id at all) counts as reserved
 *   - channelTotals.walkin + channelTotals.reserved === revenueTotals,
 *     unfiltered, across every field — not just net
 *   - the `channel` filter narrows getRevenueDashboard to just that side, and
 *     its revenueTotals then matches the unfiltered channelTotals for that side
 *   - getSalesReport's `channel` filter narrows food sales the same way
 */
import { Pool } from 'pg'
import { loadEnv } from './env'
import { entitleTenant } from './entitle-fixture'
import type { ActiveContext } from '../lib/tenant/context'

let pass = 0,
  fail = 0
const check = (l: string, c: boolean) => {
  console.log(`${c ? '✓' : '✗ FAIL'}  ${l}`)
  if (c) pass++
  else fail++
}

const TZ = 'Asia/Kolkata'
const DAY = '2041-07-10'
const RANGE = { start: '2041-07-01', end: '2041-07-31' }
const ist = (day: string, hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number)
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCMinutes(d.getUTCMinutes() + h * 60 + m - (5 * 60 + 30))
  return d.toISOString()
}
const round2 = (n: number) => Math.round(n * 100) / 100

async function main() {
  loadEnv()
  const { getRevenueDashboard } = await import('../lib/reports/revenue')
  const { getSalesReport } = await import('../lib/reports/sales')

  const owner = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })

  const slug = 'testchannelsplit'
  const t = await owner.query<{ id: string }>(
    `insert into tenants (slug,name,status,timezone) values ($1,$2,'active',$3)
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
    `insert into users (email,password_hash) values ($1,'x')
     on conflict (email) do update set email=excluded.email returning id`,
    [`owner@${slug}.test`],
  )
  const m = await owner.query<{ id: string }>(
    `insert into memberships (tenant_id,user_id,role,status) values ($1,$2,'owner','active')
     on conflict (tenant_id,user_id) do update set role='owner', status='active' returning id`,
    [tenantId, u.rows[0].id],
  )

  const ctx: ActiveContext = {
    user: { id: u.rows[0].id, email: `owner@${slug}.test`, fullName: null, isPlatformAdmin: false },
    tenant: { id: tenantId, slug, name: `${slug} co`, industry: 'gaming_cafe', status: 'active', currency: 'INR', timezone: TZ },
    role: 'owner',
    membershipId: m.rows[0].id,
    branchId,
  }

  const wipe = async () => {
    await owner.query('delete from payments where tenant_id=$1', [tenantId])
    await owner.query('delete from invoice_items where tenant_id=$1', [tenantId])
    await owner.query('delete from invoices where tenant_id=$1', [tenantId])
    await owner.query('delete from bookings where tenant_id=$1', [tenantId])
  }
  await wipe()

  let bookingSeq = 0
  /** A minimal bookings row — just enough for invoices.booking_id to join to
   *  a real channel. No booking_slots: revenue-basis.ts never reads them. */
  async function makeBooking(channel: 'walkin' | 'reserved'): Promise<string> {
    bookingSeq++
    const row = await owner.query<{ id: string }>(
      `insert into bookings (tenant_id,branch_id,booking_number,channel)
       values ($1,$2,$3,$4) returning id`,
      [tenantId, branchId, `CS-${bookingSeq}`, channel],
    )
    return row.rows[0].id
  }

  let invSeq = 0
  /** One paid invoice, optionally linked to a booking — same shape
   *  test-revenue-consistency.ts's own `bill()` uses, minus the parts
   *  (discount/service-charge/void/partial-pay) this test doesn't need. */
  async function bill(o: {
    bookingId?: string | null
    kind: 'booking' | 'food'
    amount: number
    taxPercent?: number
  }) {
    invSeq++
    const tax = round2((o.amount * (o.taxPercent ?? 0)) / 100)
    const total = round2(o.amount + tax)
    const issuedAt = ist(DAY, '12:00')
    const inv = await owner.query<{ id: string }>(
      `insert into invoices (tenant_id,branch_id,booking_id,invoice_number,status,subtotal,discount,tax_total,total,issued_at)
       values ($1,$2,$3,$4,'paid',$5,0,$6,$7,$8) returning id`,
      [tenantId, branchId, o.bookingId ?? null, `CS-INV-${invSeq}`, o.amount.toFixed(2), tax.toFixed(2), total.toFixed(2), issuedAt],
    )
    await owner.query(
      `insert into invoice_items (tenant_id,invoice_id,kind,description,qty,unit_price,tax_rate,line_total)
       values ($1,$2,$3,$4,1,$5,$6,$5)`,
      [tenantId, inv.rows[0].id, o.kind, `${o.kind} line`, o.amount.toFixed(2), (o.taxPercent ?? 0).toFixed(2)],
    )
    await owner.query(
      `insert into payments (tenant_id,branch_id,invoice_id,method,amount,status,created_at)
       values ($1,$2,$3,'cash',$4,'captured',$5)`,
      [tenantId, branchId, inv.rows[0].id, total.toFixed(2), issuedAt],
    )
    return total
  }

  // ══ 1. one walk-in booking, one reserved booking, one booking-less sale ══
  console.log('\n── walk-in, reserved, and a booking-less counter sale ──')
  {
    await wipe()
    const walkinBookingId = await makeBooking('walkin')
    const reservedBookingId = await makeBooking('reserved')

    await bill({ bookingId: walkinBookingId, kind: 'booking', amount: 300 })
    await bill({ bookingId: reservedBookingId, kind: 'booking', amount: 500 })
    await bill({ bookingId: null, kind: 'food', amount: 120 }) // counter sale, no booking

    const all = await getRevenueDashboard(ctx, { range: RANGE })
    check('unfiltered net is all three invoices — ₹920', all.revenueTotals.net === 920)
    check('walk-in channel total is ₹300 (only the walk-in booking)', all.channelTotals.walkin.net === 300)
    check(
      'reserved channel total is ₹620 — the reserved booking PLUS the booking-less counter sale',
      all.channelTotals.reserved.net === 620,
    )
    check(
      'walk-in + reserved reconciles to the unfiltered total, on net',
      round2(all.channelTotals.walkin.net + all.channelTotals.reserved.net) === all.revenueTotals.net,
    )
    check(
      '…and on gross too, not just net',
      round2(all.channelTotals.walkin.gross + all.channelTotals.reserved.gross) === all.revenueTotals.gross,
    )
    check(
      '…and on invoice count',
      all.channelTotals.walkin.invoiceCount + all.channelTotals.reserved.invoiceCount === all.revenueTotals.invoiceCount,
    )

    const walkinOnly = await getRevenueDashboard(ctx, { range: RANGE, channel: 'walkin' })
    check('the walk-in filter narrows revenueTotals to exactly the walk-in figure', walkinOnly.revenueTotals.net === 300)
    check('…matching the unfiltered channelTotals.walkin exactly', walkinOnly.revenueTotals.net === all.channelTotals.walkin.net)
    check(
      '…and the OTHER side is zero by construction under the filter',
      walkinOnly.channelTotals.reserved.net === 0 && walkinOnly.channelTotals.walkin.net === 300,
    )

    const reservedOnly = await getRevenueDashboard(ctx, { range: RANGE, channel: 'reserved' })
    check('the reserved filter narrows revenueTotals to exactly the reserved figure (₹620)', reservedOnly.revenueTotals.net === 620)
    check('…matching the unfiltered channelTotals.reserved exactly', reservedOnly.revenueTotals.net === all.channelTotals.reserved.net)
  }

  // ══ 2. getSalesReport's channel filter ═══════════════════════════════════
  console.log('\n── sales report channel filter (food tied to a walk-in booking) ──')
  {
    await wipe()
    const walkinBookingId = await makeBooking('walkin')
    const reservedBookingId = await makeBooking('reserved')
    await bill({ bookingId: walkinBookingId, kind: 'food', amount: 80, taxPercent: 5 })
    await bill({ bookingId: reservedBookingId, kind: 'food', amount: 40, taxPercent: 5 })

    const unfiltered = await getSalesReport(ctx, { range: RANGE })
    check('unfiltered food revenue is both lines — ₹126 (84 + 42)', unfiltered.totals.foodGrossRevenue === 126)

    const walkinOnly = await getSalesReport(ctx, { range: RANGE, channel: 'walkin' })
    check('channel:walkin keeps only the walk-in-linked food line — ₹84', walkinOnly.totals.foodGrossRevenue === 84)

    const reservedOnly = await getSalesReport(ctx, { range: RANGE, channel: 'reserved' })
    check('channel:reserved keeps only the reserved-linked food line — ₹42', reservedOnly.totals.foodGrossRevenue === 42)
    check(
      'the two channel-filtered sales reports reconcile to the unfiltered total',
      round2(walkinOnly.totals.foodGrossRevenue + reservedOnly.totals.foodGrossRevenue) === unfiltered.totals.foodGrossRevenue,
    )
  }

  await wipe()
  await owner.query('delete from sessions where user_id=$1', [u.rows[0].id])
  await owner.end()

  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
