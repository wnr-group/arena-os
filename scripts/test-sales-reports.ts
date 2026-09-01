/**
 * Food & Membership sales reports (AROS-66) — integration tests against a real
 * database.
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs scripts/test-sales-reports.ts
 *
 * Food is driven through the REAL billing path — issueInvoiceForBooking(), the
 * same function the POS calls — so what is proven is that the report agrees
 * with what the till actually charged, not with a hand-written invoice row.
 * Memberships likewise go through purchaseMembership(), which raises the
 * invoice and takes the tender in one transaction.
 *
 * Everything is read back through getSalesReport() (withUser + RLS).
 */
import { Pool } from 'pg'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { sql } from 'drizzle-orm'
import * as schema from '../db/schema'
import { loadEnv } from './env'
import { entitleTenant } from './entitle-fixture'
import type { ActiveContext } from '../lib/tenant/context'

type Db = NodePgDatabase<typeof schema>

let pass = 0,
  fail = 0
const check = (label: string, cond: boolean) => {
  console.log(`${cond ? '✓' : '✗ FAIL'}  ${label}`)
  if (cond) pass++
  else fail++
}

const TZ = 'Asia/Kolkata'
const ist = (day: string, hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number)
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCMinutes(d.getUTCMinutes() + h * 60 + m - (5 * 60 + 30))
  return d
}

async function main() {
  loadEnv()
  const { getSalesReport } = await import('../lib/reports/sales')
  const { ReportAccessError } = await import('../lib/reports/daily-revenue')
  const { issueInvoiceForBooking } = await import('../lib/billing/invoice')
  const { purchaseMembership } = await import('../lib/memberships/customer-memberships')
  const { voidInvoiceRecord } = await import('../lib/billing/refunds')
  const { toCsv } = await import('../lib/reports/csv')
  const { FOOD_SALES_CSV_COLUMNS, MEMBERSHIP_SALES_CSV_COLUMNS } = await import('../lib/reports/sales')

  const ownerPool = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })
  const appPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 })
  const app = drizzle(appPool, { schema })

  async function withUser<T>(userId: string, fn: (tx: Db) => Promise<T>): Promise<T> {
    return app.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`)
      return fn(tx as unknown as Db)
    })
  }

  // ── fixtures ──────────────────────────────────────────────────────────────
  async function makeTenant(slug: string, email: string) {
    const t = await ownerPool.query<{ id: string }>(
      `insert into tenants (slug,name,status,timezone) values ($1,$2,'active',$3)
       on conflict (slug) do update set timezone = excluded.timezone returning id`,
      [slug, `${slug} co`, TZ],
    )
    // Entitlement enforcement is fail-closed (M16 #2): a tenant with no
    // plan is granted nothing, so this fixture states that it is a paying
    // customer. See scripts/entitle-fixture.ts.
    await entitleTenant(ownerPool, t.rows[0].id)
    const u = await ownerPool.query<{ id: string }>(
      `insert into users (email,password_hash) values ($1,'x')
       on conflict (email) do update set email = excluded.email returning id`,
      [email],
    )
    const m = await ownerPool.query<{ id: string }>(
      `insert into memberships (tenant_id,user_id,role,status) values ($1,$2,'owner','active')
       on conflict (tenant_id,user_id) do update set role='owner', status='active' returning id`,
      [t.rows[0].id, u.rows[0].id],
    )
    const b = await ownerPool.query<{ id: string }>(
      `insert into branches (tenant_id,name,is_primary) values ($1,$2,true)
       on conflict (tenant_id,name) do update set name = excluded.name returning id`,
      [t.rows[0].id, `${slug}-branch`],
    )
    const rt = await ownerPool.query<{ id: string }>(
      `insert into resource_types (tenant_id,name,hourly_rate) values ($1,'Console','100.00')
       on conflict (tenant_id,name) do update set hourly_rate = excluded.hourly_rate returning id`,
      [t.rows[0].id],
    )
    const r = await ownerPool.query<{ id: string }>(
      `insert into resources (tenant_id,branch_id,resource_type_id,name) values ($1,$2,$3,$4)
       on conflict (tenant_id,name) do update set name = excluded.name returning id`,
      [t.rows[0].id, b.rows[0].id, rt.rows[0].id, `${slug}-PS5`],
    )
    return {
      tenantId: t.rows[0].id,
      userId: u.rows[0].id,
      membershipId: m.rows[0].id,
      branchId: b.rows[0].id,
      resourceId: r.rows[0].id,
    }
  }

  let bookingSeq = 0
  async function makeBooking(t: { tenantId: string; branchId: string; resourceId: string }, at: Date) {
    bookingSeq++
    const bk = await ownerPool.query<{ id: string }>(
      `insert into bookings (tenant_id,branch_id,booking_number,status,source,subtotal,total)
       values ($1,$2,$3,'confirmed','walk_in','100.00','100.00') returning id`,
      [t.tenantId, t.branchId, `FS-${String(bookingSeq).padStart(4, '0')}`],
    )
    await ownerPool.query(
      `insert into booking_slots (tenant_id,booking_id,resource_id,starts_at,ends_at,rate_applied,slot_total,resource_name,resource_type_name)
       values ($1,$2,$3,$4,$5,'100.00','100.00','r','Console')`,
      [t.tenantId, bk.rows[0].id, t.resourceId, at, new Date(at.getTime() + 3600_000)],
    )
    return bk.rows[0].id
  }

  let orderSeq = 0
  /** An OPEN food order against a booking — exactly what the POS bills from. */
  async function makeOrder(
    t: { tenantId: string; branchId: string },
    bookingId: string,
    items: { name: string; qty: number; unitPrice: number; taxRate: number }[],
    status: 'open' | 'cancelled' = 'open',
  ) {
    orderSeq++
    const o = await ownerPool.query<{ id: string }>(
      `insert into orders (tenant_id,branch_id,booking_id,order_number,status)
       values ($1,$2,$3,$4,$5) returning id`,
      [t.tenantId, t.branchId, bookingId, `FO-${String(orderSeq).padStart(4, '0')}`, status],
    )
    for (const it of items) {
      await ownerPool.query(
        `insert into order_items (tenant_id,order_id,item_name,unit_price,tax_rate,qty,line_total)
         values ($1,$2,$3,$4,$5,$6,$7)`,
        [
          t.tenantId, o.rows[0].id, it.name, it.unitPrice.toFixed(2), it.taxRate.toFixed(2), it.qty,
          (it.qty * it.unitPrice).toFixed(2),
        ],
      )
    }
    return o.rows[0].id
  }

  async function makeCustomer(tenantId: string, phone: string, name: string) {
    const c = await ownerPool.query<{ id: string }>(
      `insert into customers (tenant_id,phone,name) values ($1,$2,$3)
       on conflict (tenant_id,phone) do update set name = excluded.name returning id`,
      [tenantId, phone, name],
    )
    return c.rows[0].id
  }

  async function makePlan(tenantId: string, name: string, price: number) {
    const p = await ownerPool.query<{ id: string }>(
      // Plain insert: membership_plans' uniqueness is a PARTIAL index (active
      // names only), which ON CONFLICT cannot infer. The reset below clears them.
      `insert into membership_plans (tenant_id,name,price,duration_months,is_active)
       values ($1,$2,$3,1,true) returning id`,
      [tenantId, name, price.toFixed(2)],
    )
    return p.rows[0].id
  }

  const A = await makeTenant('sales-a', 'owner@sales-a.test')
  const B = await makeTenant('sales-b', 'owner@sales-b.test')

  const cashierUser = await ownerPool.query<{ id: string }>(
    `insert into users (email,password_hash) values ('cashier@sales.test','x')
     on conflict (email) do update set email = excluded.email returning id`,
  )
  const cashierMembership = await ownerPool.query<{ id: string }>(
    `insert into memberships (tenant_id,user_id,role,status) values ($1,$2,'cashier','active')
     on conflict (tenant_id,user_id) do update set role='cashier', status='active' returning id`,
    [A.tenantId, cashierUser.rows[0].id],
  )

  // Clean slate for a repeatable run.
  for (const t of [A, B]) {
    await ownerPool.query('delete from invoices where tenant_id = $1', [t.tenantId])
    await ownerPool.query('delete from orders where tenant_id = $1', [t.tenantId])
    await ownerPool.query('delete from bookings where tenant_id = $1', [t.tenantId])
    await ownerPool.query('delete from customer_memberships where tenant_id = $1', [t.tenantId])
    await ownerPool.query('delete from membership_plans where tenant_id = $1', [t.tenantId])
  }

  const D1 = '2026-09-10'
  const D2 = '2026-09-11'
  const range = { start: D1, end: D2 }

  const ctxFor = (t: { userId: string; membershipId: string }, tenantId: string, role: string): ActiveContext =>
    ({
      user: { id: t.userId, email: 'x@test', fullName: null, isPlatformAdmin: false },
      tenant: { id: tenantId, slug: 'x', name: 'x', industry: 'gaming_cafe', status: 'active', currency: 'INR', timezone: TZ },
      role,
      membershipId: t.membershipId,
      branchId: null,
    }) as ActiveContext

  const ctxA = ctxFor(A, A.tenantId, 'owner')
  const ctxB = ctxFor(B, B.tenantId, 'owner')

  /** Bill a booking through the real POS path, then stamp the invoice's day. */
  async function billBooking(t: typeof A, bookingId: string, day: string, hhmm = '20:00') {
    const r = await withUser(t.userId, (tx) =>
      issueInvoiceForBooking(tx, { id: t.tenantId, timezone: TZ }, { bookingId }),
    )
    await ownerPool.query(`update invoices set issued_at = $2 where id = $1`, [r.invoiceId, ist(day, hhmm)])
    return r
  }

  // ── FOOD fixtures ─────────────────────────────────────────────────────────
  // D1: two orders on two bookings. "Chicken, Large" is sold on both, so the
  // report must ADD them up, and its comma exercises CSV escaping for real.
  const bk1 = await makeBooking(A, ist(D1, '18:00'))
  await makeOrder(A, bk1, [
    { name: 'Chicken, Large', qty: 2, unitPrice: 100, taxRate: 5 },
    { name: 'Coke', qty: 3, unitPrice: 40, taxRate: 12 },
  ])
  await billBooking(A, bk1, D1)

  const bk2 = await makeBooking(A, ist(D1, '19:00'))
  await makeOrder(A, bk2, [{ name: 'Chicken, Large', qty: 1, unitPrice: 100, taxRate: 5 }])
  await billBooking(A, bk2, D1)

  // A CANCELLED order — never billed, must not appear anywhere.
  const bk3 = await makeBooking(A, ist(D1, '20:00'))
  await makeOrder(A, bk3, [{ name: 'Ghost Fries', qty: 9, unitPrice: 99, taxRate: 5 }], 'cancelled')
  await billBooking(A, bk3, D1)

  // An order left OPEN and never billed (booking not billed at all).
  const bk4 = await makeBooking(A, ist(D1, '21:00'))
  await makeOrder(A, bk4, [{ name: 'Unbilled Wings', qty: 4, unitPrice: 60, taxRate: 5 }])

  // D2: a bill that is later VOIDED — its food must drop out of the report.
  const bk5 = await makeBooking(A, ist(D2, '18:00'))
  await makeOrder(A, bk5, [{ name: 'Voided Pizza', qty: 5, unitPrice: 200, taxRate: 5 }])
  const inv5 = await billBooking(A, bk5, D2)
  await withUser(A.userId, (tx) =>
    voidInvoiceRecord(tx, { tenantId: A.tenantId, membershipId: A.membershipId }, { invoiceId: inv5.invoiceId, reason: 'test void' }),
  )

  // D2: a normal second-day sale.
  const bk6 = await makeBooking(A, ist(D2, '19:00'))
  await makeOrder(A, bk6, [{ name: 'Coke', qty: 2, unitPrice: 40, taxRate: 12 }])
  await billBooking(A, bk6, D2)

  // Outside the range entirely.
  const bk7 = await makeBooking(A, ist('2026-09-20', '18:00'))
  await makeOrder(A, bk7, [{ name: 'Out Of Range Momo', qty: 7, unitPrice: 50, taxRate: 5 }])
  await billBooking(A, bk7, '2026-09-20')

  // Tenant B — same item names, must never leak.
  const bkB = await makeBooking(B, ist(D1, '18:00'))
  await makeOrder(B, bkB, [{ name: 'Chicken, Large', qty: 50, unitPrice: 100, taxRate: 5 }])
  await billBooking(B, bkB, D1)

  // ── MEMBERSHIP fixtures ───────────────────────────────────────────────────
  const custA1 = await makeCustomer(A.tenantId, '+919000000001', 'Asha')
  const custA2 = await makeCustomer(A.tenantId, '+919000000002', 'Bimal')
  const custA3 = await makeCustomer(A.tenantId, '+919000000003', 'Chetan')
  const custB1 = await makeCustomer(B.tenantId, '+919000000009', 'B Cust')
  const goldA = await makePlan(A.tenantId, 'Gold', 1000)
  const silverA = await makePlan(A.tenantId, 'Silver', 500)
  const planB = await makePlan(B.tenantId, 'Gold', 1000)

  async function sell(t: typeof A, customerId: string, planId: string, day: string) {
    const r = await withUser(t.userId, (tx) =>
      purchaseMembership(
        tx,
        { tenantId: t.tenantId, membershipId: t.membershipId, timezone: TZ, branchId: t.branchId },
        { customerId, planId, paymentMethod: 'cash' },
      ),
    )
    // Stamp the purchase day (created_at is the sale date the report uses).
    await ownerPool.query(`update customer_memberships set created_at = $2 where id = $1`, [r.membershipId, ist(day, '12:00')])
    if (r.invoiceId) {
      await ownerPool.query(`update invoices set issued_at = $2 where id = $1`, [r.invoiceId, ist(day, '12:00')])
    }
    return r
  }

  const soldGold1 = await sell(A, custA1, goldA, D1)
  const soldGold2 = await sell(A, custA2, goldA, D1)
  const soldSilver = await sell(A, custA3, silverA, D2)
  await sell(B, custB1, planB, D1)

  // THE historical-pricing test: reprice Gold AFTER the sales. The report must
  // still show 1000 apiece, because it reads the purchase snapshot.
  await ownerPool.query(`update membership_plans set price = '9999.00' where id = $1`, [goldA])

  const report = await getSalesReport(ctxA, { range })
  const food = (name: string) => report.food.find((f) => f.itemName === name)
  const plan = (name: string) => report.memberships.find((m) => m.planName === name)

  // ── food ──────────────────────────────────────────────────────────────────
  console.log('\n── food sales ──')
  check('"Chicken, Large" sold across two invoices is ONE row', report.food.filter((f) => f.itemName === 'Chicken, Large').length === 1)
  check('…with qty 3 (2 + 1)', food('Chicken, Large')?.quantity === 3)
  check('…and gross 300.00 (3 × 100)', food('Chicken, Large')?.grossRevenue === 300)
  check('…spanning 2 invoices', food('Chicken, Large')?.invoices === 2)
  check('Coke totals qty 5 across both days (3 + 2)', food('Coke')?.quantity === 5)
  check('…and gross 200.00 (5 × 40)', food('Coke')?.grossRevenue === 200)
  check('a CANCELLED order is never billed, so never reported', !food('Ghost Fries'))
  check('an OPEN, unbilled order is not a sale', !food('Unbilled Wings'))
  check('a VOIDED invoice removes its food from the report', !food('Voided Pizza'))
  check('an item billed outside the range is excluded', !food('Out Of Range Momo'))
  check('food totals: qty 8', report.totals.foodQuantity === 8)
  check('food totals: gross 500.00', report.totals.foodGrossRevenue === 500)

  // Double-count guard: the SAME sale exists as order_items AND invoice_items.
  const rawOrderQty = await ownerPool.query<{ q: string }>(
    `select coalesce(sum(oi.qty),0)::text q
       from order_items oi join orders o on o.id = oi.order_id
      where oi.tenant_id = $1 and oi.item_name = 'Chicken, Large'`,
    [A.tenantId],
  )
  check('order_items also holds these rows (3) — the double-count trap is real', Number(rawOrderQty.rows[0].q) === 3)
  check('…and the report counts the sale exactly once, not twice', food('Chicken, Large')?.quantity === 3)

  // Reconciliation straight off the invoice lines.
  const srcFood = await ownerPool.query<{ q: string; rev: string }>(
    `select coalesce(sum(ii.qty),0)::text q, coalesce(sum(ii.line_total),0)::text rev
       from invoice_items ii join invoices i on i.id = ii.invoice_id
      where ii.tenant_id = $1 and ii.kind = 'food' and i.status in ('issued','paid')
        and (i.issued_at at time zone $2)::date between $3::date and $4::date`,
    [A.tenantId, TZ, D1, D2],
  )
  check('food qty reconciles with the source invoice lines', report.totals.foodQuantity === Number(srcFood.rows[0].q))
  check('food gross reconciles with SUM(invoice_items.line_total)', report.totals.foodGrossRevenue === Number(srcFood.rows[0].rev))

  // ── memberships ───────────────────────────────────────────────────────────
  console.log('\n── membership sales ──')
  check('Gold shows 2 sold', plan('Gold')?.sold === 2)
  check('…revenue 2000.00 — the price PAID, not the repriced 9999', plan('Gold')?.revenue === 2000)
  check('Silver shows 1 sold at 500.00', plan('Silver')?.sold === 1 && plan('Silver')?.revenue === 500)
  check('totals: 3 plans sold, 2500.00', report.totals.membershipsSold === 3 && report.totals.membershipRevenue === 2500)
  const currentPlanPrice = await ownerPool.query<{ p: string }>(`select price::text p from membership_plans where id = $1`, [goldA])
  check('…while the CURRENT plan price is 9999.00, proving the report ignores it', Number(currentPlanPrice.rows[0].p) === 9999)

  // Revenue must equal what was actually invoiced and tendered.
  const srcMembership = await ownerPool.query<{ inv: string; paid: string }>(
    `select coalesce(sum(i.total),0)::text inv,
            coalesce((select sum(p.amount) from payments p
                       where p.invoice_id = any(array_agg(i.id)) and p.status = 'captured'),0)::text paid
       from customer_memberships cm join invoices i on i.id = cm.invoice_id
      where cm.tenant_id = $1 and i.status in ('issued','paid')`,
    [A.tenantId],
  )
  check('membership revenue equals the linked invoices’ total', report.totals.membershipRevenue === Number(srcMembership.rows[0].inv))
  check('…and equals the captured payments against them', report.totals.membershipRevenue === Number(srcMembership.rows[0].paid))

  // Expired and cancelled memberships remain historical sales.
  await ownerPool.query(`update customer_memberships set status = 'expired' where id = $1`, [soldGold1.membershipId])
  await ownerPool.query(
    `update customer_memberships set status = 'cancelled', cancelled_at = now() where id = $1`,
    [soldGold2.membershipId],
  )
  const afterLifecycle = await getSalesReport(ctxA, { range })
  check('an EXPIRED membership is still a historical sale', afterLifecycle.memberships.find((m) => m.planName === 'Gold')?.sold === 2)
  check('a CANCELLED membership is still a sale — cancelling does not refund', afterLifecycle.totals.membershipRevenue === 2500)
  check('…and it is reported as cancelled-since', afterLifecycle.memberships.find((m) => m.planName === 'Gold')?.cancelled === 1)

  // A voided membership invoice un-sells it, exactly as for revenue.
  await withUser(A.userId, async (tx) => {
    const before = await ownerPool.query<{ id: string }>(`select invoice_id id from customer_memberships where id = $1`, [soldSilver.membershipId])
    // Refund the tender first — a bill with money on it cannot be voided.
    await ownerPool.query(`update payments set status = 'refunded' where invoice_id = $1`, [before.rows[0].id])
    await voidInvoiceRecord(tx, { tenantId: A.tenantId, membershipId: A.membershipId }, { invoiceId: before.rows[0].id, reason: 'mis-sale' })
  })
  const afterVoid = await getSalesReport(ctxA, { range })
  check('a membership whose invoice was VOIDED drops out of sales', !afterVoid.memberships.find((m) => m.planName === 'Silver'))
  check('…and its revenue with it (2500 → 2000)', afterVoid.totals.membershipRevenue === 2000)

  // ── date filtering ────────────────────────────────────────────────────────
  console.log('\n── date filtering ──')
  const d1Only = await getSalesReport(ctxA, { range: { start: D1, end: D1 } })
  check('a one-day range keeps only that day’s food (Coke 3, not 5)', d1Only.food.find((f) => f.itemName === 'Coke')?.quantity === 3)
  check('…and only that day’s memberships (Gold 2)', d1Only.memberships.find((m) => m.planName === 'Gold')?.sold === 2)
  check('…start = end is a whole day, not an empty range', d1Only.totals.foodQuantity > 0)
  const d2Only = await getSalesReport(ctxA, { range: { start: D2, end: D2 } })
  check('the other day sees only its own food (Coke 2)', d2Only.food.find((f) => f.itemName === 'Coke')?.quantity === 2)
  check('…and no Gold sale', !d2Only.memberships.find((m) => m.planName === 'Gold'))
  const emptyRange = await getSalesReport(ctxA, { range: { start: '2026-10-01', end: '2026-10-07' } })
  check('a range with no sales returns empty lists, not an error', emptyRange.food.length === 0 && emptyRange.memberships.length === 0)
  check('…with zeroed totals', emptyRange.totals.foodGrossRevenue === 0 && emptyRange.totals.membershipRevenue === 0)

  // Timezone boundary: 23:50 IST on D2 is 18:20Z — still D2 locally.
  const lateBk = await makeBooking(A, ist(D2, '23:00'))
  await makeOrder(A, lateBk, [{ name: 'Late Night Roll', qty: 1, unitPrice: 80, taxRate: 5 }])
  await billBooking(A, lateBk, D2, '23:50')
  const lateReport = await getSalesReport(ctxA, { range: { start: D2, end: D2 } })
  check('a 23:50 IST sale belongs to that local day, not the next (UTC would roll it)', !!lateReport.food.find((f) => f.itemName === 'Late Night Roll'))
  const nextDay = await getSalesReport(ctxA, { range: { start: '2026-09-12', end: '2026-09-12' } })
  check('…and does not appear on the following day', !nextDay.food.find((f) => f.itemName === 'Late Night Roll'))

  // ── tenant isolation ──────────────────────────────────────────────────────
  console.log('\n── tenant isolation ──')
  const bReport = await getSalesReport(ctxB, { range })
  check('tenant B sees its own 50 chickens', bReport.food.find((f) => f.itemName === 'Chicken, Large')?.quantity === 50)
  check('tenant A never sees B’s 50', food('Chicken, Large')?.quantity === 3)
  check('tenant B sees only its own membership sale', bReport.totals.membershipsSold === 1)
  check('tenant B’s food total is its own', bReport.totals.foodGrossRevenue === 5000)
  check('tenant A’s food total excludes B entirely', report.totals.foodGrossRevenue === 500)

  // ── authorization ─────────────────────────────────────────────────────────
  console.log('\n── authorization ──')
  check('an owner may read the report', report.food.length > 0)
  // Compared against a FRESH owner read rather than a literal: fixtures are
  // still being added above this point, and a hard-coded total would silently
  // rot the moment another one appears.
  const ownerNow = await getSalesReport(ctxA, { range })
  const mgr = await getSalesReport(ctxFor(A, A.tenantId, 'manager'), { range })
  check('a manager may read the report', mgr.totals.foodGrossRevenue > 0)
  check('…and sees exactly what the owner sees', JSON.stringify(mgr) === JSON.stringify(ownerNow))
  let refused = false
  try {
    await getSalesReport(
      ctxFor({ userId: cashierUser.rows[0].id, membershipId: cashierMembership.rows[0].id }, A.tenantId, 'cashier'),
      { range },
    )
  } catch (e) {
    refused = e instanceof ReportAccessError
  }
  check('a CASHIER is rejected by the data layer', refused)

  // ── CSV ───────────────────────────────────────────────────────────────────
  console.log('\n── CSV ──')
  const foodCsv = toCsv(report.food, FOOD_SALES_CSV_COLUMNS)
  const foodLines = foodCsv.trimEnd().split('\r\n')
  check('food CSV headers are Item,Qty sold,Invoices,Gross revenue', foodLines[0] === 'Item,Qty sold,Invoices,Gross revenue')
  check('…an item name containing a comma is quoted', foodCsv.includes('"Chicken, Large",3,2,300.00'))
  check('…one line per item plus the header', foodLines.length === report.food.length + 1)
  check('…and no other tenant’s quantity appears', !foodCsv.includes(',50,'))
  const memberCsv = toCsv(report.memberships, MEMBERSHIP_SALES_CSV_COLUMNS)
  const memberLines = memberCsv.trimEnd().split('\r\n')
  check('membership CSV headers are Plan,Plans sold,Cancelled since,Revenue', memberLines[0] === 'Plan,Plans sold,Cancelled since,Revenue')
  check('…Gold exports 2 sold at 2000.00', memberCsv.includes('Gold,2,0,2000.00'))
  const d1Csv = toCsv(d1Only.food, FOOD_SALES_CSV_COLUMNS)
  check('the export honours the selected range (D1 Coke is 3)', d1Csv.includes('Coke,3,'))

  // ── cleanup ───────────────────────────────────────────────────────────────
  await ownerPool.query('delete from tenants where id = any($1)', [[A.tenantId, B.tenantId]])
  await ownerPool.query(`delete from users where email like '%@sales%.test' or email = 'cashier@sales.test'`)
  await ownerPool.end()
  await appPool.end()

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
