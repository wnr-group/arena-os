/**
 * GST receipt data — integration tests against a real database.
 *
 * Drives loadInvoiceReceipt (what getInvoice wraps) on an RLS-scoped
 * transaction through `arena_app`, and proves the thing that actually matters
 * about a receipt: it reports the STORED snapshot, never a recomputation.
 *
 *   - every figure equals the invoices/invoice_items/payments row verbatim
 *   - GST comes from the stored tax_breakup, including multi-rate invoices
 *   - changing a resource's live price does not move an issued receipt
 *   - only captured payments count toward paid; balance never goes negative
 *   - a walk-in (null customer) loads cleanly
 *   - another tenant's invoice id is invisible
 *
 *   npx tsx scripts/test-invoice-receipt.ts
 */
import { Pool } from 'pg'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { sql } from 'drizzle-orm'
import * as schema from '../db/schema'
import { issueInvoiceForBooking } from '../lib/billing/invoice'
import { recordPaymentForInvoice } from '../lib/billing/payments'
import { loadInvoiceReceipt } from '../lib/billing/receipt'
import { loadEnv } from './env'

type Db = NodePgDatabase<typeof schema>

let pass = 0,
  fail = 0
const check = (l: string, c: boolean) => {
  console.log(`${c ? '✓' : '✗ FAIL'}  ${l}`)
  if (c) pass++
  else fail++
}

const TZ = 'Asia/Kolkata'
const UUID = '00000000-0000-4000-8000-000000000000'

async function main() {
  loadEnv()

  const ownerPool = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })
  const appPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 })
  const app = drizzle(appPool, { schema })

  async function withUser<T>(userId: string, fn: (tx: Db) => Promise<T>): Promise<T> {
    return app.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`)
      return fn(tx as unknown as Db)
    })
  }

  type Actor = { userId: string; tenantId: string; membershipId: string; branchId: string; resourceId: string }

  const receiptOf = (actor: Actor, invoiceId: string) =>
    withUser(actor.userId, (tx) => loadInvoiceReceipt(tx, actor.tenantId, invoiceId))

  async function makeTenant(slug: string, address: string | null): Promise<Actor> {
    const t = await ownerPool.query<{ id: string }>(
      `insert into tenants (slug,name,status,timezone) values ($1,$2,'active',$3)
       on conflict (slug) do update set name=excluded.name returning id`,
      [slug, `${slug} Entertainment Pvt Ltd`, TZ],
    )
    const tenantId = t.rows[0].id
    const b = await ownerPool.query<{ id: string }>(
      `insert into branches (tenant_id,name,is_primary,address,phone)
       values ($1,'Main',true,$2,'+914412345678')
       on conflict (tenant_id,name) do update set address=excluded.address, phone=excluded.phone returning id`,
      [tenantId, address],
    )
    const u = await ownerPool.query<{ id: string }>(
      `insert into users (email,password_hash) values ($1,'x')
       on conflict (email) do update set email=excluded.email returning id`,
      [`owner@${slug}.test`],
    )
    await ownerPool.query(
      `insert into memberships (tenant_id,user_id,role,status,full_name)
       values ($1,$2,'owner','active','Till Operator')
       on conflict (tenant_id,user_id) do update set role='owner', status='active'`,
      [tenantId, u.rows[0].id],
    )
    const m = await ownerPool.query<{ id: string }>(
      'select id from memberships where tenant_id=$1 and user_id=$2', [tenantId, u.rows[0].id])
    const rt = await ownerPool.query<{ id: string }>(
      `insert into resource_types (tenant_id,name,hourly_rate) values ($1,'PS5','400.00')
       on conflict (tenant_id,name) do update set hourly_rate='400.00' returning id`, [tenantId])
    const res = await ownerPool.query<{ id: string }>(
      `insert into resources (tenant_id,branch_id,resource_type_id,name) values ($1,$2,$3,'Station 1')
       on conflict (tenant_id,name) do update set branch_id=excluded.branch_id returning id`,
      [tenantId, b.rows[0].id, rt.rows[0].id])
    return {
      userId: u.rows[0].id, tenantId, membershipId: m.rows[0].id,
      branchId: b.rows[0].id, resourceId: res.rows[0].id,
    }
  }

  let seq = 0
  /** An issued invoice for `total` rupees; `withCustomer=false` gives a walk-in. */
  async function makeInvoice(t: Actor, total: number, withCustomer = true) {
    const n = ++seq
    let customerId: string | null = null
    if (withCustomer) {
      const c = await ownerPool.query<{ id: string }>(
        `insert into customers (tenant_id,phone,name) values ($1,$2,'Asha Raman')
         on conflict (tenant_id,phone) do update set name=excluded.name returning id`,
        [t.tenantId, `+9198700${String(10000 + n).slice(-5)}`])
      customerId = c.rows[0].id
    }
    const bk = await ownerPool.query<{ id: string }>(
      `insert into bookings (tenant_id,branch_id,booking_number,customer_id,status,subtotal,total)
       values ($1,$2,$3,$4,'confirmed','0','0') returning id`,
      [t.tenantId, t.branchId, `RC-${n}`, customerId])
    const start = new Date(Date.UTC(2032, 0, 1 + n, 4, 0, 0))
    await ownerPool.query(
      `insert into booking_slots (tenant_id,booking_id,resource_id,starts_at,ends_at,
         rate_applied,slot_total,resource_name,resource_type_name,active)
       values ($1,$2,$3,$4,$5,$6,$7,'Station 1','PS5',true)`,
      [t.tenantId, bk.rows[0].id, t.resourceId, start, new Date(start.getTime() + 2 * 3600_000),
       (total / 2).toFixed(2), total.toFixed(2)])
    const issued = await withUser(t.userId, (tx) =>
      issueInvoiceForBooking(tx, { id: t.tenantId, timezone: TZ }, { bookingId: bk.rows[0].id }))
    return { invoiceId: issued.invoiceId, invoiceNumber: issued.invoiceNumber, customerId, bookingId: bk.rows[0].id }
  }

  const pay = (t: Actor, invoiceId: string, method: 'cash' | 'card' | 'upi', amount: number) =>
    withUser(t.userId, (tx) =>
      recordPaymentForInvoice(tx, { tenantId: t.tenantId, membershipId: t.membershipId },
        { invoiceId, method, amount }))

  const A = await makeTenant('testrcpta', '12 Anna Salai\nChennai 600002')
  const B = await makeTenant('testrcptb', null)
  for (const t of [A, B]) {
    await ownerPool.query('delete from invoices where tenant_id=$1', [t.tenantId])
    await ownerPool.query('delete from bookings where tenant_id=$1', [t.tenantId])
    await ownerPool.query('delete from sequences where tenant_id=$1', [t.tenantId])
  }

  // ── Case 1 — unpaid / partially paid invoice ──────────────────────────────
  {
    const inv = await makeInvoice(A, 800)
    await pay(A, inv.invoiceId, 'cash', 500)
    const r = await receiptOf(A, inv.invoiceId)
    check('C1 receipt loads for the issuing tenant', r !== null)
    check('C1 total is the STORED invoice total (800.00)', r?.invoice.total === '800.00')
    check('C1 paid = 500.00', r?.paidTotal === '500.00')
    check('C1 balance due = 300.00', r?.balanceDue === '300.00')
    check('C1 not marked fully paid', r?.fullyPaid === false)
    check('C1 invoice status still issued', r?.invoice.status === 'issued')
    check('C1 invoice_number is the stored one, unchanged', r?.invoice.invoiceNumber === inv.invoiceNumber)
    check('C1 issued_at is present (receipt uses it over created_at)', r?.invoice.issuedAt instanceof Date)
  }

  // ── Case 2 — fully paid, split across two tenders ─────────────────────────
  {
    const inv = await makeInvoice(A, 800)
    await pay(A, inv.invoiceId, 'cash', 500)
    await pay(A, inv.invoiceId, 'upi', 300)
    const r = await receiptOf(A, inv.invoiceId)
    check('C2 paid = 800.00 across two tenders', r?.paidTotal === '800.00')
    check('C2 balance = 0.00', r?.balanceDue === '0.00')
    check('C2 fullyPaid is true (drives the PAID badge)', r?.fullyPaid === true)
    check('C2 invoice status = paid', r?.invoice.status === 'paid')
    check('C2 both payment rows are listed', r?.payments.length === 2)
    check('C2 methods are cash + upi', r?.payments.map((p) => p.method).sort().join(',') === 'cash,upi')
    check('C2 amounts come from the payment rows', r?.payments.map((p) => p.amount).sort().join(',') === '300.00,500.00')
  }

  // ── Case 3 — multiple GST rates, read from stored tax_breakup ─────────────
  {
    const inv = await makeInvoice(A, 1000)
    // Overwrite the stored breakup with a realistic MULTI-RATE snapshot. The
    // receipt must print exactly this and never re-derive it from tax_rate.
    await ownerPool.query(
      `update invoices set tax_breakup = $2::jsonb, tax_total='23.00' where id=$1`,
      [inv.invoiceId, JSON.stringify([
        { rate: 5, cgst: '2.50', sgst: '2.50' },
        { rate: 18, cgst: '9.00', sgst: '9.00' },
      ])])
    const r = await receiptOf(A, inv.invoiceId)
    check('C3 both GST groups are returned', r?.invoice.taxBreakup.length === 2)
    check('C3 the 5% group keeps its stored cgst/sgst', r?.invoice.taxBreakup[0].rate === 5 && r?.invoice.taxBreakup[0].cgst === '2.50' && r?.invoice.taxBreakup[0].sgst === '2.50')
    check('C3 the 18% group keeps its stored cgst/sgst', r?.invoice.taxBreakup[1].rate === 18 && r?.invoice.taxBreakup[1].cgst === '9.00' && r?.invoice.taxBreakup[1].sgst === '9.00')
    check('C3 aggregated CGST = 11.50 (sum of stored groups)', r?.cgstTotal === '11.50')
    check('C3 aggregated SGST = 11.50', r?.sgstTotal === '11.50')
    check('C3 tax_total is the STORED 23.00, not a recomputation', r?.invoice.taxTotal === '23.00')
    check('C3 grand total is the stored invoice total', r?.invoice.total === '1000.00')

    // A single-rate invoice must not be mangled by the multi-rate handling.
    const single = await makeInvoice(A, 500)
    await ownerPool.query(`update invoices set tax_breakup=$2::jsonb where id=$1`,
      [single.invoiceId, JSON.stringify([{ rate: 18, cgst: '38.14', sgst: '38.14' }])])
    const rs = await receiptOf(A, single.invoiceId)
    check('C3 a single-rate invoice returns one group', rs?.invoice.taxBreakup.length === 1)
    check('C3 …with its stored amounts intact', rs?.cgstTotal === '38.14' && rs?.sgstTotal === '38.14')

    // An empty breakup (what AROS-26 writes today, no tax_rates source) is fine.
    const zero = await makeInvoice(A, 300)
    await ownerPool.query(`update invoices set tax_breakup='[]'::jsonb where id=$1`, [zero.invoiceId])
    const rz = await receiptOf(A, zero.invoiceId)
    check('C3 an empty tax_breakup yields no groups and 0.00 totals', rz?.invoice.taxBreakup.length === 0 && rz?.cgstTotal === '0.00' && rz?.sgstTotal === '0.00')
  }

  // ── Case 4 — walk-in customer (null) ──────────────────────────────────────
  {
    const inv = await makeInvoice(A, 400, false)
    const r = await receiptOf(A, inv.invoiceId)
    check('C4 a walk-in invoice loads without error', r !== null)
    check('C4 customer is null (page renders "Walk-in Customer")', r?.customer === null)
    check('C4 customer_id on the invoice is null', r?.invoice.customerId === null)
    check('C4 …and the rest of the receipt is intact', r?.invoice.total === '400.00' && (r?.items.length ?? 0) === 1)
  }

  // ── Case 5 — letterhead + line items are the stored snapshot ──────────────
  {
    const inv = await makeInvoice(A, 900)
    const r = await receiptOf(A, inv.invoiceId)
    check('C5 legal name comes from the tenant', r?.business.legalName === 'testrcpta Entertainment Pvt Ltd')
    check('C5 address comes from the issuing branch', r?.business.address === '12 Anna Salai\nChennai 600002')
    check('C5 branch phone is carried', r?.business.phone === '+914412345678')
    check('C5 GSTIN is null — business_profiles (AROS-31) is not implemented', r?.business.gstin === null)
    check('C5 logo is null — no logo storage exists', r?.business.logoUrl === null)

    const item = r?.items[0]
    check('C5 one line item', r?.items.length === 1)
    check('C5 item description is the stored snapshot', /Station 1/.test(item?.description ?? ''))
    check('C5 item qty is stored at 2dp (2.00 h)', item?.qty === '2.00')
    check('C5 item unit_price is the rate applied at booking time', item?.unitPrice === '450.00')
    check('C5 item line_total is stored', item?.lineTotal === '900.00')

    // THE snapshot test: move the live price, the receipt must not budge.
    await ownerPool.query(`update resource_types set hourly_rate='9999.00' where tenant_id=$1`, [A.tenantId])
    const after = await receiptOf(A, inv.invoiceId)
    check('C5 changing the LIVE resource price does not move the receipt', after?.items[0].unitPrice === '450.00' && after?.items[0].lineTotal === '900.00' && after?.invoice.total === '900.00')
    await ownerPool.query(`update resource_types set hourly_rate='400.00' where tenant_id=$1`, [A.tenantId])
  }

  // ── Case 6 — only captured payments count ─────────────────────────────────
  {
    const inv = await makeInvoice(A, 800)
    await pay(A, inv.invoiceId, 'cash', 300)
    for (const st of ['pending', 'failed', 'refunded']) {
      await ownerPool.query(
        `insert into payments (tenant_id,branch_id,invoice_id,method,amount,status)
         values ($1,$2,$3,'card','200.00',$4)`, [A.tenantId, A.branchId, inv.invoiceId, st])
    }
    const r = await receiptOf(A, inv.invoiceId)
    check('C6 paid counts ONLY captured (300.00, not 900.00)', r?.paidTotal === '300.00')
    check('C6 balance due = 500.00', r?.balanceDue === '500.00')
    check('C6 all four rows are returned for display', r?.payments.length === 4)
    check('C6 …but only one is captured', r?.payments.filter((p) => p.status === 'captured').length === 1)

    // Balance must never render negative, even if the data says otherwise.
    await ownerPool.query(
      `insert into payments (tenant_id,branch_id,invoice_id,method,amount,status)
       values ($1,$2,$3,'cash','5000.00','captured')`, [A.tenantId, A.branchId, inv.invoiceId])
    const over = await receiptOf(A, inv.invoiceId)
    check('C6 an over-captured invoice shows 0.00 due, never negative', over?.balanceDue === '0.00' && over?.fullyPaid === true)
  }

  // ── Case 7 — tenant isolation ─────────────────────────────────────────────
  {
    const invA = await makeInvoice(A, 800)
    const cross = await receiptOf(B, invA.invoiceId)
    check("C7 tenant B cannot load tenant A's invoice → null (page 404s)", cross === null)

    // Naming tenant A's id does not help: RLS scopes on the USER.
    const spoof = await withUser(B.userId, (tx) => loadInvoiceReceipt(tx, A.tenantId, invA.invoiceId))
    check("C7 …nor by passing tenant A's tenant id", spoof === null)

    const missing = await receiptOf(A, UUID)
    check('C7 an unknown invoice id → null', missing === null)

    const invB = await makeInvoice(B, 250)
    const own = await receiptOf(B, invB.invoiceId)
    check('C7 tenant B CAN load its own invoice (refusals were not incidental)', own !== null)
    check('C7 …with its own letterhead', own?.business.legalName === 'testrcptb Entertainment Pvt Ltd')
    check('C7 …and a null address handled gracefully', own?.business.address === 'Main')
  }

  // ── cleanup ───────────────────────────────────────────────────────────────
  await ownerPool.query('delete from tenants where id = any($1)', [[A.tenantId, B.tenantId]])
  await ownerPool.query(`delete from users where email like '%@testrcpt%.test'`)
  await ownerPool.end()
  await appPool.end()

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
