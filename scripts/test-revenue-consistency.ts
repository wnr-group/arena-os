/**
 * Paid revenue — money taken, consistently, across every report that shows it.
 *
 * ── THE RULE ────────────────────────────────────────────────────────────────
 *
 * Revenue is money in NET of money back: a CAPTURED PAYMENT counts on the day
 * it was taken, a REFUND subtracts on the day it happened, and each is
 * apportioned to booking / food / membership / service charge by what each line
 * of the bill was owed. An invoice on its own is not revenue: ₹500 billed with
 * ₹0 collected contributes ₹0, with ₹200 collected contributes ₹200, paid in
 * full then ₹200 refunded contributes ₹300 — and the refund lands on the day it
 * was made, never reaching back to restate the day of the sale.
 *
 * The one definition lives in lib/reports/revenue-basis.ts and is used by
 * Revenue & Bookings, Profit & Loss, and the Food and Membership reports.
 *
 * ── WHAT CAME BEFORE ────────────────────────────────────────────────────────
 *
 * Two bugs, fixed in order, and this suite guards against both coming back:
 *
 *   1. STALENESS. Revenue & Bookings and P&L read mv_daily_revenue, a
 *      materialized snapshot nothing schedules a refresh of, while Food and
 *      Membership queried live. Anything billed since the last manual refresh
 *      was missing from revenue and profit and present in the sales reports.
 *   2. ACCRUAL. Raising an invoice was enough to count as revenue, so bills
 *      nobody had paid inflated the figure.
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs scripts/test-revenue-consistency.ts
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
/** The reporting window. Far future, so no real data can drift into it. */
const DAY = '2040-05-15'
const RANGE = { start: '2040-05-01', end: '2040-05-31' }

/** IST is UTC+5:30 — 12:00 local is 06:30Z. */
const ist = (day: string, hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number)
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCMinutes(d.getUTCMinutes() + h * 60 + m - (5 * 60 + 30))
  return d.toISOString()
}
const round2 = (n: number) => Math.round(n * 100) / 100
const near = (a: number, b: number) => Math.abs(a - b) < 0.011

async function main() {
  loadEnv()
  const { getRevenueDashboard } = await import('../lib/reports/revenue')
  const { getSalesReport } = await import('../lib/reports/sales')
  const { getPnlReport } = await import('../lib/reports/pnl')

  const owner = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })

  const slug = 'testrevconsist'
  const t = await owner.query<{ id: string }>(
    `insert into tenants (slug,name,status,timezone) values ($1,$2,'active',$3)
     on conflict (slug) do update set name=excluded.name returning id`, [slug, `${slug} co`, TZ])
  const tenantId = t.rows[0].id
  await entitleTenant(owner, tenantId)

  const b = await owner.query<{ id: string }>(
    `insert into branches (tenant_id,name,is_primary,timezone) values ($1,'Main',true,$2)
     on conflict (tenant_id,name) do update set is_primary=true returning id`, [tenantId, TZ])
  const branchId = b.rows[0].id
  const u = await owner.query<{ id: string }>(
    `insert into users (email,password_hash) values ($1,'x')
     on conflict (email) do update set email=excluded.email returning id`, [`owner@${slug}.test`])
  const userId = u.rows[0].id
  const m = await owner.query<{ id: string }>(
    `insert into memberships (tenant_id,user_id,role,status) values ($1,$2,'owner','active')
     on conflict (tenant_id,user_id) do update set role='owner', status='active' returning id`,
    [tenantId, u.rows[0].id])

  const ctx: ActiveContext = {
    user: { id: userId, email: `owner@${slug}.test`, fullName: null, isPlatformAdmin: false },
    tenant: { id: tenantId, slug, name: `${slug} co`, industry: 'gaming', status: 'active',
      currency: 'INR', timezone: TZ },
    role: 'owner',
    membershipId: m.rows[0].id,
    branchId,
  }

  const wipe = async () => {
    await owner.query(
      `delete from refunds where payment_id in (select id from payments where tenant_id=$1)`, [tenantId])
    await owner.query('delete from payments where tenant_id=$1', [tenantId])
    await owner.query('delete from invoice_items where tenant_id=$1', [tenantId])
    await owner.query('delete from invoices where tenant_id=$1', [tenantId])
  }
  await wipe()

  let seq = 0
  /**
   * One invoice, its lines, and whatever has been collected against it.
   *
   * `lines` carry their own tax rate, exactly as billing writes them, so the
   * per-source apportionment is exercised rather than assumed.
   */
  async function bill(o: {
    status?: 'issued' | 'paid' | 'draft' | 'void'
    /** When the bill was raised. Only ever used to prove it is NOT the date used. */
    issuedOn?: string
    lines: { kind: 'booking' | 'food' | 'membership' | 'wallet_topup'; description: string; amount: number; taxPercent?: number }[]
    discount?: number
    /** Service charge (M18): added after discount, taxed at its own rate,
     *  folded into tax_total/total but never into subtotal. */
    serviceCharge?: { amount: number; taxPercent?: number }
    /** Captured tender. Omit for none. */
    paid?: number
    /** When the money was taken. Defaults to the issue instant. */
    paidOn?: string
  }) {
    seq++
    const subtotal = round2(o.lines.reduce((s, l) => s + l.amount, 0))
    const discount = o.discount ?? 0
    // Mirrors priceBill: discount pro rata by line value, then GST per line.
    const foodTax = round2(
      o.lines.reduce(
        (s, l) => s + (l.amount - (discount * l.amount) / (subtotal || 1)) * ((l.taxPercent ?? 0) / 100),
        0,
      ),
    )
    // Service charge (M18): after the discount, taxed at its own rate, folded
    // into tax_total/total but NEVER into subtotal — exactly as
    // lib/billing/invoice.ts writes it.
    const scAmount = o.serviceCharge ? round2(o.serviceCharge.amount) : 0
    const scTaxPercent = o.serviceCharge?.taxPercent ?? 0
    const scTax = round2((scAmount * scTaxPercent) / 100)
    const scPercent = subtotal > 0 ? round2((scAmount / subtotal) * 100) : 0
    const tax = round2(foodTax + scTax)
    const total = round2(subtotal - discount + tax + scAmount)
    const issuedAt = o.issuedOn ?? ist(DAY, '12:00')
    const inv = await owner.query<{ id: string }>(
      `insert into invoices (tenant_id,branch_id,invoice_number,status,subtotal,discount,
                             tax_total,total,service_charge_amount,service_charge_percent,
                             service_charge_tax_percent,issued_at)
       values ($1,$2,$3,$4::invoice_status,$5,$6,$7,$8,$9,$10,$11,$12) returning id`,
      [tenantId, branchId, `RC-${seq}`, o.status ?? 'paid', subtotal.toFixed(2),
       discount.toFixed(2), tax.toFixed(2), total.toFixed(2), scAmount.toFixed(2),
       scPercent.toFixed(2), scTaxPercent.toFixed(2), issuedAt])
    for (const l of o.lines) {
      await owner.query(
        `insert into invoice_items (tenant_id,invoice_id,kind,description,qty,unit_price,
                                    tax_rate,line_total)
         values ($1,$2,$3,$4,1,$5,$6,$5)`,
        [tenantId, inv.rows[0].id, l.kind, l.description, l.amount.toFixed(2),
         (l.taxPercent ?? 0).toFixed(2)])
    }
    if (scAmount > 0) {
      await owner.query(
        `insert into invoice_items (tenant_id,invoice_id,kind,description,qty,unit_price,
                                    tax_rate,line_total)
         values ($1,$2,'service_charge','Service charge',1,$3,$4,$3)`,
        [tenantId, inv.rows[0].id, scAmount.toFixed(2), scTaxPercent.toFixed(2)])
    }
    let paymentId: string | null = null
    if (o.paid !== undefined && o.paid > 0) {
      const p = await owner.query<{ id: string }>(
        `insert into payments (tenant_id,branch_id,invoice_id,method,amount,status,created_at)
         values ($1,$2,$3,'cash',$4,'captured',$5) returning id`,
        [tenantId, branchId, inv.rows[0].id, o.paid.toFixed(2), o.paidOn ?? issuedAt])
      paymentId = p.rows[0].id
    }
    return { invoiceId: inv.rows[0].id, paymentId, total }
  }

  const dashboard = () => getRevenueDashboard(ctx, { range: RANGE })

  // ══ 1. DEVICE BOOKINGS ═══════════════════════════════════════════════════
  console.log('\n── device bookings: past, present and future, all paid ──')
  {
    await wipe()
    // The booking's own date is nowhere in the query. What varies here is the
    // day the MONEY was taken, which is the only date that matters.
    await bill({ lines: [{ kind: 'booking', description: 'played last week', amount: 100 }], paid: 100, paidOn: ist('2040-05-02', '10:00') })
    await bill({ lines: [{ kind: 'booking', description: 'playing now', amount: 200 }], paid: 200, paidOn: ist('2040-05-15', '10:00') })
    await bill({ lines: [{ kind: 'booking', description: 'plays in September', amount: 300 }], paid: 300, paidOn: ist('2040-05-28', '10:00') })

    const d = await dashboard()
    check('all three are revenue — ₹600', d.revenueTotals.net === 600)
    check('…each on the day its money was taken', d.days.filter((x) => x.net > 0).length === 3)
    check('…and all of it is booking revenue', d.revenueTotals.bookingRevenue === 600)
  }

  console.log('\n── a FUTURE booking paid today ──')
  {
    await wipe()
    // Billed and paid on the 15th; played in 2041. The service date must not
    // push the money out of the period it was received in.
    await bill({
      lines: [{ kind: 'booking', description: 'Snooker, 2041-01-04 17:00', amount: 500 }],
      paid: 500, paidOn: ist(DAY, '17:30'),
    })
    const d = await dashboard()
    check('the ₹500 is in revenue on the day it was paid', d.days.find((x) => x.day === DAY)?.net === 500)
    check('…and in the period total', d.revenueTotals.net === 500)
  }

  console.log('\n── billed and NOT collected ──')
  {
    await wipe()
    await bill({ status: 'issued', lines: [{ kind: 'booking', description: 'on account', amount: 500 }] })
    const d = await dashboard()
    check('an unpaid ₹500 bill contributes ₹0', d.revenueTotals.net === 0)
    check('…and no invoice is counted', d.revenueTotals.invoiceCount === 0)
    check('…and no booking revenue', d.revenueTotals.bookingRevenue === 0)
  }

  console.log('\n── a FUTURE booking billed but unpaid ──')
  {
    await wipe()
    await bill({
      status: 'issued',
      lines: [{ kind: 'booking', description: 'Sep 25, unpaid', amount: 500 }],
    })
    const d = await dashboard()
    check('still ₹0 — a future date does not make an unpaid bill revenue', d.revenueTotals.net === 0)
  }

  console.log('\n── part paid ──')
  {
    await wipe()
    await bill({ status: 'issued', lines: [{ kind: 'booking', description: '₹500 bill', amount: 500 }], paid: 200 })
    const d = await dashboard()
    check('₹200 of a ₹500 bill is ₹200, not ₹500', d.revenueTotals.net === 200)
    check('…apportioned to booking', d.revenueTotals.bookingRevenue === 200)
    check('…and the invoice is counted once', d.revenueTotals.invoiceCount === 1)
  }

  console.log('\n── a discount ──')
  {
    await wipe()
    // ₹1000 of play, ₹150 off, nothing taxable → ₹850 owed and ₹850 taken.
    await bill({ discount: 150, lines: [{ kind: 'booking', description: 'discounted', amount: 1000 }], paid: 850 })
    const d = await dashboard()
    check('revenue is the ₹850 collected, not the ₹1000 billed', d.revenueTotals.net === 850)
    check('…gross still shows the ₹1000 it started from', d.revenueTotals.gross === 1000)
    check('…and the ₹150 discount is reported', d.revenueTotals.discount === 150)
  }

  console.log('\n── a voided invoice ──')
  {
    await wipe()
    // Void with money attached — it must contribute nothing regardless.
    await bill({ status: 'void', lines: [{ kind: 'booking', description: 'struck off', amount: 700 }], paid: 700 })
    const d = await dashboard()
    check('a voided bill contributes ₹0 even though ₹700 was captured', d.revenueTotals.net === 0)
  }

  console.log('\n── refunds net out, dated by when they happen ──')
  {
    await wipe()
    const one = await bill({ lines: [{ kind: 'booking', description: 'refunded in full', amount: 400 }], paid: 400 })
    const two = await bill({ lines: [{ kind: 'booking', description: 'part refunded', amount: 600 }], paid: 600 })
    check('both are revenue to begin with — ₹1000', (await dashboard()).revenueTotals.net === 1000)

    // A refund is money OUT. It nets against revenue on the day it happens.
    // Refund WITHIN the window, so it counts here.
    const refundDay = ist(DAY, '18:00')

    // A FULL refund flips the payment to 'refunded' — the money still came in
    // on the sale's own day (so the sale is not erased from it), and the refund
    // subtracts on the refund day. Both are in range, so net falls to ₹600.
    await owner.query(
      `insert into refunds (tenant_id,payment_id,amount,reason,created_at) values ($1,$2,'400.00','test',$3)`,
      [tenantId, one.paymentId, refundDay])
    await owner.query(`update payments set status='refunded' where id=$1`, [one.paymentId])
    check('a full refund in the window nets the sale out — ₹600', (await dashboard()).revenueTotals.net === 600)

    // A PARTIAL refund leaves the payment captured at its full amount, but the
    // money returned still leaves the till — so revenue falls by exactly it.
    await owner.query(
      `insert into refunds (tenant_id,payment_id,amount,reason,created_at) values ($1,$2,'100.00','test',$3)`,
      [tenantId, two.paymentId, refundDay])
    const d = await dashboard()
    check('a partial refund reduces revenue by the refund — ₹500', d.revenueTotals.net === 500)
    check('…and the ₹500 returned is reported as refunds', d.revenueTotals.refunds === 500)
  }

  console.log('\n── a refund lands on the refund day, never the sale day ──')
  {
    await wipe()
    // Sold and paid inside the window; refunded AFTER it. The refund must not
    // reach back and restate a period that is already closed — the sale still
    // stands in the window it was made in, and the refund belongs to July.
    const sale = await bill({ lines: [{ kind: 'booking', description: 'sold in window', amount: 400 }], paid: 400 })
    await owner.query(
      `insert into refunds (tenant_id,payment_id,amount,reason,created_at) values ($1,$2,'400.00','later','2040-07-10T06:30:00Z')`,
      [tenantId, sale.paymentId])
    await owner.query(`update payments set status='refunded' where id=$1`, [sale.paymentId])
    check('the in-window sale still counts — ₹400', (await dashboard()).revenueTotals.net === 400)
  }

  console.log('\n── a service-charge bill reconciles ──')
  {
    await wipe()
    // ₹1000 food @5% GST + a ₹100 service charge taxed @18%.
    // GST = 50 (food) + 18 (service) = 68; total = 1000 + 68 + 100 = 1168.
    await bill({
      lines: [{ kind: 'food', description: 'SC platter', amount: 1000, taxPercent: 5 }],
      serviceCharge: { amount: 100, taxPercent: 18 },
      paid: 1168,
    })
    const t = (await dashboard()).revenueTotals
    check('net is the full ₹1168 collected', t.net === 1168)
    check('gross is the food subtotal only — ₹1000', t.gross === 1000)
    check('tax includes the service-charge GST — ₹68', t.tax === 68)
    check('the service charge is reported — ₹100', t.serviceCharge === 100)
    check(
      'net === gross − discount + tax + service charge',
      round2(t.gross - t.discount + t.tax + t.serviceCharge) === t.net,
    )
    check(
      'the four sources add back to net exactly',
      round2(t.bookingRevenue + t.foodRevenue + t.membershipRevenue + t.serviceChargeRevenue) === t.net,
    )
    check('food keeps its own share (1000 + its ₹50 GST)', t.foodRevenue === 1050)
    check('the service charge is its own ₹118 (100 + ₹18 GST)', t.serviceChargeRevenue === 118)

    const p = await getPnlReport(ctx, RANGE)
    check('P&L agrees on net — ₹1168', p.revenue.net === 1168)
    check('…and reports the service charge — ₹100', p.revenue.serviceCharge === 100)
  }

  // ══ 2. FOOD ══════════════════════════════════════════════════════════════
  console.log('\n── food ──')
  {
    await wipe()
    await bill({ lines: [{ kind: 'food', description: 'Paid Platter', amount: 200, taxPercent: 5 }], paid: 210 })
    await bill({ status: 'issued', lines: [{ kind: 'food', description: 'Unpaid Platter', amount: 500, taxPercent: 5 }] })

    const d = await dashboard()
    const sales = await getSalesReport(ctx, { range: RANGE })
    check('a paid food order is revenue — ₹210 including its GST', d.revenueTotals.foodRevenue === 210)
    check('…an unpaid one is not', d.revenueTotals.net === 210)
    check('the Food report agrees', sales.totals.foodGrossRevenue === 210)
    check('…and lists only the paid item', sales.food.length === 1 && sales.food[0].itemName === 'Paid Platter')
  }

  // ══ 3. MEMBERSHIP ════════════════════════════════════════════════════════
  console.log('\n── membership ──')
  {
    await wipe()
    await bill({ lines: [{ kind: 'membership', description: 'Gold', amount: 2000 }], paid: 2000 })
    await bill({ status: 'issued', lines: [{ kind: 'membership', description: 'Silver on credit', amount: 900 }] })
    const d = await dashboard()
    check('a paid membership is revenue — ₹2000', d.revenueTotals.membershipRevenue === 2000)
    check('…one sold on credit is not', d.revenueTotals.net === 2000)
  }

  // ══ 4. A COMBINED INVOICE ════════════════════════════════════════════════
  console.log('\n── one bill holding a booking AND food ──')
  {
    await wipe()
    // ₹75 of play at 0%, ₹120 of food at 5% → tax ₹6, total ₹201.
    const combined = await bill({
      lines: [
        { kind: 'booking', description: 'PS5 1h', amount: 75 },
        { kind: 'food', description: 'Nachos', amount: 120, taxPercent: 5 },
      ],
      paid: 201,
    })
    check('the bill totals ₹201', combined.total === 201)

    const d = await dashboard()
    check('collected ₹201', d.revenueTotals.net === 201)
    check('…₹75 of it is booking', near(d.revenueTotals.bookingRevenue, 75))
    check('…₹126 of it is food, its own GST included', near(d.revenueTotals.foodRevenue, 126))
    check('…and the two add back to the money, counted once',
      near(d.revenueTotals.bookingRevenue + d.revenueTotals.foodRevenue, 201))
    check('the invoice itself is counted once', d.revenueTotals.invoiceCount === 1)
  }

  console.log('\n── part paying a combined bill splits proportionally ──')
  {
    await wipe()
    await bill({
      status: 'issued',
      lines: [
        { kind: 'booking', description: 'PS5 1h', amount: 75 },
        { kind: 'food', description: 'Nachos', amount: 120, taxPercent: 5 },
      ],
      paid: 100.5, // exactly half of ₹201
    })
    const d = await dashboard()
    check('half the bill collected is half the revenue', d.revenueTotals.net === 100.5)
    check('…half the booking', near(d.revenueTotals.bookingRevenue, 37.5))
    check('…half the food', near(d.revenueTotals.foodRevenue, 63))
    check('…still adding to the money taken',
      near(d.revenueTotals.bookingRevenue + d.revenueTotals.foodRevenue, 100.5))
  }

  // ══ 5. THE THREE SOURCES ADD UP ══════════════════════════════════════════
  console.log('\n── booking + food + membership = total paid revenue ──')
  {
    await wipe()
    await bill({
      lines: [
        { kind: 'booking', description: 'Snooker 2h', amount: 500 },
        { kind: 'food', description: 'Coffee', amount: 40, taxPercent: 5 },
      ],
      paid: 542,
    })
    await bill({ lines: [{ kind: 'food', description: 'Chicken Tikka', amount: 200, taxPercent: 5 }], paid: 210 })
    await bill({ lines: [{ kind: 'membership', description: 'Gold', amount: 1000 }], paid: 1000 })
    // Billed, never paid — must not appear anywhere in the identity.
    await bill({ status: 'issued', lines: [{ kind: 'booking', description: 'unpaid', amount: 9999 }] })

    const d = await dashboard()
    const total = d.revenueTotals
    check('total paid revenue is ₹1752', total.net === 1752)
    check('booking ₹500', near(total.bookingRevenue, 500))
    check('food ₹252 (42 + 210)', near(total.foodRevenue, 252))
    check('membership ₹1000', near(total.membershipRevenue, 1000))
    check('booking + food + membership === total',
      near(total.bookingRevenue + total.foodRevenue + total.membershipRevenue, total.net))
    check('the ₹9999 receivable is nowhere in it', total.net !== 11751)

    const sales = await getSalesReport(ctx, { range: RANGE })
    check('the Food report reports the same ₹252', near(sales.totals.foodGrossRevenue, 252))
  }

  // ══ 6. PROFIT & LOSS USES THE SAME BASIS ═════════════════════════════════
  console.log('\n── Profit & Loss agrees ──')
  {
    const d = await dashboard()
    const pnl = await getPnlReport(ctx, RANGE)
    check('P&L revenue.net === dashboard net', pnl.revenue.net === d.revenueTotals.net)
    check('…gross', pnl.revenue.gross === d.revenueTotals.gross)
    check('…discount', pnl.revenue.discount === d.revenueTotals.discount)
    check('…tax', pnl.revenue.tax === d.revenueTotals.tax)
    check('…invoice count', pnl.revenue.invoiceCount === d.revenueTotals.invoiceCount)
    check('…and the same per-source split',
      near(pnl.revenue.bookingRevenue, d.revenueTotals.bookingRevenue) &&
      near(pnl.revenue.foodRevenue, d.revenueTotals.foodRevenue) &&
      near(pnl.revenue.membershipRevenue, d.revenueTotals.membershipRevenue))
    check('with nothing spent, profit IS the money taken', pnl.netProfit === d.revenueTotals.net)
  }

  // ══ 7. NO REFRESH REQUIRED ═══════════════════════════════════════════════
  console.log('\n── a payment taken right now needs no refresh ──')
  {
    const before = await getPnlReport(ctx, RANGE)
    await bill({ lines: [{ kind: 'booking', description: 'just now', amount: 260 }], paid: 260 })
    const afterDash = await dashboard()
    const afterPnl = await getPnlReport(ctx, RANGE)
    check('the dashboard sees it immediately', afterDash.revenueTotals.net === round2(before.revenue.net + 260))
    check('…and so does P&L', afterPnl.revenue.net === afterDash.revenueTotals.net)
    check('…and profit moves by exactly ₹260', round2(afterPnl.netProfit - before.netProfit) === 260)

    await owner.query('select public.refresh_daily_revenue()')
    const afterRefresh = await dashboard()
    check('refreshing the old snapshot changes nothing — it is no longer read',
      afterRefresh.revenueTotals.net === afterDash.revenueTotals.net)
  }

  // ══ 8. STORED VALUE IS NOT A SALE ════════════════════════════════════════
  console.log('\n── a wallet top-up is a deposit, not revenue ──')
  {
    await wipe()
    await bill({ lines: [{ kind: 'wallet_topup', description: 'Wallet credit', amount: 1000 }], paid: 1000 })
    const d = await dashboard()
    check('selling ₹1000 of wallet credit is not revenue', d.revenueTotals.net === 0)

    // Spending it is — that is when the deposit becomes a sale, and the cash
    // is counted once rather than at both ends.
    await bill({ lines: [{ kind: 'booking', description: 'paid from wallet', amount: 300 }], paid: 300 })
    const after = await dashboard()
    check('spending ₹300 of it IS revenue', after.revenueTotals.net === 300)
  }

  // ══ 9. ISOLATION ═════════════════════════════════════════════════════════
  console.log("\n── another tenant's money stays out ──")
  {
    const other = await owner.query<{ id: string }>(
      `insert into tenants (slug,name,status,timezone) values ('testrevother','other','active',$1)
       on conflict (slug) do update set name=excluded.name returning id`, [TZ])
    const ob = await owner.query<{ id: string }>(
      `insert into branches (tenant_id,name,is_primary) values ($1,'Main',true)
       on conflict (tenant_id,name) do update set is_primary=true returning id`, [other.rows[0].id])
    const oi = await owner.query<{ id: string }>(
      `insert into invoices (tenant_id,branch_id,invoice_number,status,subtotal,discount,
                             tax_total,total,issued_at)
       values ($1,$2,'OTHER-1','paid','99999.00',0,0,'99999.00',$3) returning id`,
      [other.rows[0].id, ob.rows[0].id, ist(DAY, '12:00')])
    await owner.query(
      `insert into payments (tenant_id,branch_id,invoice_id,method,amount,status,created_at)
       values ($1,$2,$3,'cash','99999.00','captured',$4)`,
      [other.rows[0].id, ob.rows[0].id, oi.rows[0].id, ist(DAY, '12:00')])

    const d = await dashboard()
    check("tenant B's ₹99999 is nowhere in tenant A's revenue", d.revenueTotals.net < 99999)
    await owner.query('delete from payments where tenant_id=$1', [other.rows[0].id])
    await owner.query('delete from invoices where tenant_id=$1', [other.rows[0].id])
    await owner.query('delete from branches where tenant_id=$1', [other.rows[0].id])
    await owner.query('delete from tenants where id=$1', [other.rows[0].id])
  }

  await wipe()
  await owner.end()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
