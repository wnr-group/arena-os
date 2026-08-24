/**
 * POS billing flow — integration tests against a real database.
 *
 * Drives the same code the server action drives (issueInvoiceForBooking), on an
 * RLS-scoped transaction through `arena_app`, so what is proven here is what
 * the cashier gets:
 *   - a confirmed/checked-in booking bills; anything else is refused
 *   - lines come from booking_slots and totals come from priceBill, verbatim
 *   - the invoice + items snapshot the price and survive a later rate change
 *   - billing twice is impossible, including two cashiers at the same instant
 *   - invoice numbers are sequential per tenant and never collide
 *   - another tenant's bookingId is invisible, and bills nothing
 *
 *   npx tsx scripts/test-billing-flow.ts
 */
import { Pool } from 'pg'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { and, eq, inArray, sql } from 'drizzle-orm'
import * as schema from '../db/schema'
import {
  BillingError,
  DEFAULT_INVOICE_PREFIX,
  GST_INVOICE_NUMBER_MAX_LENGTH,
  formatInvoiceNumber,
  financialYearPeriod,
  isBillableBookingStatus,
  issueInvoiceForBooking,
  loadBillLines,
  loadFoodLines,
  loadInvoiceLines,
  lockOpenFoodOrders,
  nextInvoiceNumber,
} from '../lib/billing/invoice'
import { voidInvoiceRecord } from '../lib/billing/refunds'
import { canBill } from '../lib/auth/roles'
import { todayInZone } from '../lib/booking/time'
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

/** The number the Nth invoice of the CURRENT financial year should carry. */
const expectedNumber = (n: number) =>
  formatInvoiceNumber(DEFAULT_INVOICE_PREFIX, financialYearPeriod(todayInZone(TZ)), n)

async function main() {
  loadEnv()

  const ownerPool = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })
  const appPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 })
  const app = drizzle(appPool, { schema })

  /** Same contract as db/index.ts:withUser — an RLS-scoped transaction. */
  async function withUser<T>(userId: string, fn: (tx: Db) => Promise<T>): Promise<T> {
    return app.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`)
      return fn(tx as unknown as Db)
    })
  }

  /** Run the billing core as `userId`; returns the result or the error message. */
  async function bill(
    userId: string,
    tenantId: string,
    input: { bookingId: string; discount?: number; promoCode?: string },
  ) {
    try {
      const r = await withUser(userId, (tx) =>
        issueInvoiceForBooking(tx, { id: tenantId, timezone: TZ }, input),
      )
      return { ok: true as const, ...r }
    } catch (e) {
      return {
        ok: false as const,
        billing: e instanceof BillingError,
        message: e instanceof Error ? e.message : String(e),
      }
    }
  }

  // ── fixtures (owner connection, bypasses RLS) ─────────────────────────────
  async function makeTenant(slug: string) {
    const t = await ownerPool.query<{ id: string }>(
      `insert into tenants (slug,name,status,timezone) values ($1,$2,'active',$3)
       on conflict (slug) do update set name=excluded.name returning id`,
      [slug, `${slug} co`, TZ],
    )
    const tenantId = t.rows[0].id
    const b = await ownerPool.query<{ id: string }>(
      `insert into branches (tenant_id,name,is_primary) values ($1,'Main',true)
       on conflict (tenant_id,name) do update set is_primary=true returning id`,
      [tenantId],
    )
    const u = await ownerPool.query<{ id: string }>(
      `insert into users (email,password_hash) values ($1,'x')
       on conflict (email) do update set email=excluded.email returning id`,
      [`owner@${slug}.test`],
    )
    const m = await ownerPool.query<{ id: string }>(
      `insert into memberships (tenant_id,user_id,role,status) values ($1,$2,'owner','active')
       on conflict (tenant_id,user_id) do update set role='owner', status='active' returning id`,
      [tenantId, u.rows[0].id],
    )
    const rt = await ownerPool.query<{ id: string }>(
      `insert into resource_types (tenant_id,name,hourly_rate) values ($1,'PS5','450.00')
       on conflict (tenant_id,name) do update set hourly_rate='450.00' returning id`,
      [tenantId],
    )
    const res = await ownerPool.query<{ id: string }>(
      `insert into resources (tenant_id,branch_id,resource_type_id,name) values ($1,$2,$3,'Station 1')
       on conflict (tenant_id,name) do update set branch_id=excluded.branch_id returning id`,
      [tenantId, b.rows[0].id, rt.rows[0].id],
    )
    return {
      tenantId,
      branchId: b.rows[0].id,
      userId: u.rows[0].id,
      membershipId: m.rows[0].id,
      resourceTypeId: rt.rows[0].id,
      resourceId: res.rows[0].id,
    }
  }

  let bookingSeq = 0
  /** A confirmed booking with one 2-hour slot at ₹450/h → ₹900 of charges. */
  async function makeBooking(
    t: { tenantId: string; branchId: string; resourceId: string },
    opts: { status?: string; hours?: number; rate?: string; withCustomer?: boolean; slots?: boolean } = {},
  ) {
    const { status = 'confirmed', hours = 2, rate = '450.00', withCustomer = true, slots = true } = opts
    // Take the sequence by VALUE up front: makeBooking is called concurrently
    // below, and reading the shared counter after an await would hand every
    // racer the same booking number.
    const n = ++bookingSeq
    let customerId: string | null = null
    if (withCustomer) {
      const c = await ownerPool.query<{ id: string }>(
        `insert into customers (tenant_id,phone,name) values ($1,$2,'Bill Payer')
         on conflict (tenant_id,phone) do update set name=excluded.name returning id`,
        [t.tenantId, `+9198765${String(10000 + n).slice(-5)}`],
      )
      customerId = c.rows[0].id
    }
    const bk = await ownerPool.query<{ id: string }>(
      `insert into bookings (tenant_id,branch_id,booking_number,customer_id,status,subtotal,total)
       values ($1,$2,$3,$4,$5,'0','0') returning id`,
      [t.tenantId, t.branchId, `TB-${n}`, customerId, status],
    )
    const bookingId = bk.rows[0].id
    if (slots) {
      // Each booking gets its own day so the exclusion constraint never fires.
      const start = new Date(Date.UTC(2030, 0, 1 + n, 4, 0, 0))
      const end = new Date(start.getTime() + hours * 3600_000)
      await ownerPool.query(
        `insert into booking_slots
           (tenant_id,booking_id,resource_id,starts_at,ends_at,rate_applied,slot_total,
            resource_name,resource_type_name,active)
         values ($1,$2,$3,$4,$5,$6,$7,'Station 1','PS5',true)`,
        [t.tenantId, bookingId, t.resourceId, start, end, rate, (Number(rate) * hours).toFixed(2)],
      )
    }
    return { bookingId, customerId }
  }

  let orderSeq = 0
  /** A food order attached to a booking, with the given items (mirrors what createOrder snapshots onto order_items). */
  async function makeFoodOrder(
    t: { tenantId: string; branchId: string },
    bookingId: string,
    items: { name: string; unitPrice: string; qty: number; taxRate?: string }[],
    opts: { status?: string } = {},
  ) {
    const { status = 'open' } = opts
    const n = ++orderSeq
    const ord = await ownerPool.query<{ id: string }>(
      `insert into orders (tenant_id,branch_id,booking_id,order_number,status)
       values ($1,$2,$3,$4,$5) returning id`,
      [t.tenantId, t.branchId, bookingId, `FO-${n}`, status],
    )
    const orderId = ord.rows[0].id
    for (const it of items) {
      const taxRate = it.taxRate ?? '0.00'
      const lineTotal = (Number(it.unitPrice) * it.qty).toFixed(2)
      await ownerPool.query(
        `insert into order_items (tenant_id,order_id,item_name,unit_price,tax_rate,qty,line_total)
         values ($1,$2,$3,$4,$5,$6,$7)`,
        [t.tenantId, orderId, it.name, it.unitPrice, taxRate, it.qty, lineTotal],
      )
    }
    return { orderId }
  }

  const A = await makeTenant('testbilla')
  const B = await makeTenant('testbillb')

  // A clean slate, so the run is repeatable even if a previous one was killed
  // before its cleanup: invoice numbering must start from 1 and booking numbers
  // must be free. Invoices and order_items/orders first — bookings only NULL
  // their booking_id and order_id foreign keys.
  const bothTenants = [[A.tenantId, B.tenantId]]
  await ownerPool.query('delete from invoices where tenant_id = any($1)', bothTenants)
  await ownerPool.query('delete from order_items where tenant_id = any($1)', bothTenants)
  await ownerPool.query('delete from orders where tenant_id = any($1)', bothTenants)
  await ownerPool.query('delete from bookings where tenant_id = any($1)', bothTenants)
  await ownerPool.query('delete from sequences where tenant_id = any($1)', bothTenants)

  // ── 0. pure helpers ───────────────────────────────────────────────────────
  check('billable statuses are confirmed + checked_in only', isBillableBookingStatus('confirmed') && isBillableBookingStatus('checked_in') && !isBillableBookingStatus('completed') && !isBillableBookingStatus('cancelled') && !isBillableBookingStatus('no_show'))
  check('canBill: cashier and up, not floor/kitchen/reception', canBill('owner') && canBill('manager') && canBill('cashier') && !canBill('floor_staff') && !canBill('kitchen_staff') && !canBill('receptionist'))
  check("financial year period: 10 Aug 2026 → '2026-27'", financialYearPeriod('2026-08-10') === '2026-27')
  check("financial year period: 10 Feb 2026 → '2025-26' (before 1 April)", financialYearPeriod('2026-02-10') === '2025-26')
  check("financial year period: 1 Apr 2026 → '2026-27' (boundary)", financialYearPeriod('2026-04-01') === '2026-27')

  // ── 1. successful billing ─────────────────────────────────────────────────
  const b1 = await makeBooking(A)
  const r1 = await bill(A.userId, A.tenantId, { bookingId: b1.bookingId, discount: 100 })
  check('a confirmed booking bills successfully', r1.ok)

  if (r1.ok) {
    const inv = (
      await ownerPool.query(
        `select invoice_number, status, booking_id, customer_id, branch_id, tenant_id,
                subtotal, discount, tax_total, total, tax_breakup, issued_at
           from invoices where id=$1`,
        [r1.invoiceId],
      )
    ).rows[0]

    check(`invoice_number is prefix/FY/6 digits (${expectedNumber(1)})`, inv.invoice_number === expectedNumber(1))
    check('invoice_number fits the 16-character GST limit', inv.invoice_number.length <= GST_INVOICE_NUMBER_MAX_LENGTH)
    check("invoice status = 'issued'", inv.status === 'issued')
    check('issued_at is set', inv.issued_at !== null)
    check('invoice booking_id matches', inv.booking_id === b1.bookingId)
    check('invoice customer_id matches the booking customer', inv.customer_id === b1.customerId)
    check('invoice branch_id matches the booking branch', inv.branch_id === A.branchId)
    check('invoice tenant_id is the billing tenant', inv.tenant_id === A.tenantId)

    // 2h × ₹450 = ₹900, less ₹100
    check('subtotal = 900.00 (2h × ₹450 from the slot snapshot)', inv.subtotal === '900.00')
    check('discount = 100.00', inv.discount === '100.00')
    check('total = 800.00', inv.total === '800.00')

    // The stored money must be exactly what priceBill returned — no recompute.
    check('stored subtotal === priceBill subtotal', inv.subtotal === r1.pricing.subtotal.toFixed(2))
    check('stored discount === priceBill discount', inv.discount === r1.pricing.discount.toFixed(2))
    check('stored tax_total === priceBill taxTotal', inv.tax_total === r1.pricing.taxTotal.toFixed(2))
    check('stored total === priceBill total', inv.total === r1.pricing.total.toFixed(2))
    // Compared field-by-field, not by JSON.stringify: jsonb does not preserve
    // key insertion order, so a string compare would fail on ordering alone.
    const storedBreakup = inv.tax_breakup as { rate: number; cgst: string; sgst: string }[]
    check(
      'stored tax_breakup === priceBill breakup (percent→rate, 2dp strings)',
      Array.isArray(storedBreakup) &&
        storedBreakup.length === r1.pricing.taxBreakup.length &&
        storedBreakup.every((g, i) => {
          const want = r1.pricing.taxBreakup[i]
          return g.rate === want.percent && g.cgst === want.cgst.toFixed(2) && g.sgst === want.sgst.toFixed(2)
        }),
    )
    check('the bill reconciles: subtotal − discount + tax = total', (Number(inv.subtotal) - Number(inv.discount) + Number(inv.tax_total)).toFixed(2) === inv.total)

    const items = (
      await ownerPool.query(
        `select kind, source_id, description, qty, unit_price, tax_rate, line_total, tenant_id
           from invoice_items where invoice_id=$1 order by description`,
        [r1.invoiceId],
      )
    ).rows
    check('one invoice_item per priced line', items.length === r1.pricing.items.length && items.length === 1)
    check("item kind = 'booking'", items[0].kind === 'booking')
    check('item source_id points at the booking slot', items[0].source_id !== null)
    check('item description carries resource + time', /Station 1 · \d{2}:\d{2}–\d{2}:\d{2}/.test(items[0].description))
    check('item qty = 2.00 hours', items[0].qty === '2.00')
    check('item unit_price = 450.00 (the rate applied at booking time)', items[0].unit_price === '450.00')
    check('item line_total = 900.00', items[0].line_total === '900.00')
    check('item tax_rate is stored as a percentage', items[0].tax_rate === '0.00')
    check('invoice_items carry the billing tenant', items[0].tenant_id === A.tenantId)
  }

  // ── 2. snapshot survives a later price change ─────────────────────────────
  await ownerPool.query(`update resource_types set hourly_rate='999.00' where id=$1`, [A.resourceTypeId])
  if (r1.ok) {
    const still = (await ownerPool.query('select unit_price, line_total from invoice_items where invoice_id=$1', [r1.invoiceId])).rows[0]
    check('raising the resource rate does NOT move the issued invoice', still.unit_price === '450.00' && still.line_total === '900.00')
  }
  await ownerPool.query(`update resource_types set hourly_rate='450.00' where id=$1`, [A.resourceTypeId])

  // ── 3. re-billing is refused ──────────────────────────────────────────────
  const again = await bill(A.userId, A.tenantId, { bookingId: b1.bookingId })
  check('billing the same booking twice is REFUSED', !again.ok)
  check('…with a clear message naming the existing invoice', !again.ok && again.billing && /already been billed/i.test(again.message))
  const countAfter = (await ownerPool.query('select count(*)::int n from invoices where booking_id=$1', [b1.bookingId])).rows[0].n
  check('…and no second invoice exists', countAfter === 1)

  // A VOIDED invoice releases the booking for re-billing.
  await ownerPool.query(`update invoices set status='void' where booking_id=$1`, [b1.bookingId])
  const afterVoid = await bill(A.userId, A.tenantId, { bookingId: b1.bookingId })
  check('after voiding, the booking CAN be billed again', afterVoid.ok)
  check('…and the re-bill takes the next number (…/000002)', afterVoid.ok && afterVoid.invoiceNumber === expectedNumber(2))

  // ── 4. non-billable statuses ──────────────────────────────────────────────
  for (const status of ['completed', 'cancelled', 'no_show']) {
    const b = await makeBooking(A, { status })
    const r = await bill(A.userId, A.tenantId, { bookingId: b.bookingId })
    check(`a '${status}' booking is REFUSED with the status message`, !r.ok && r.billing && /cannot be billed in its current status/i.test(r.message))
    const n = (await ownerPool.query('select count(*)::int n from invoices where booking_id=$1', [b.bookingId])).rows[0].n
    check(`…and no invoice was created for the '${status}' booking`, n === 0)
  }
  const checkedIn = await makeBooking(A, { status: 'checked_in' })
  const rCheckedIn = await bill(A.userId, A.tenantId, { bookingId: checkedIn.bookingId })
  check("a 'checked_in' booking bills successfully", rCheckedIn.ok)

  // ── 5. nothing to bill ────────────────────────────────────────────────────
  const empty = await makeBooking(A, { slots: false })
  const rEmpty = await bill(A.userId, A.tenantId, { bookingId: empty.bookingId })
  check('a booking with no active slots is REFUSED', !rEmpty.ok && rEmpty.billing && /nothing to bill/i.test(rEmpty.message))
  check('…and no empty invoice was created', (await ownerPool.query('select count(*)::int n from invoices where booking_id=$1', [empty.bookingId])).rows[0].n === 0)

  // A cancelled slot is not billable either — the 0003 trigger clears `active`.
  const inactive = await makeBooking(A)
  await ownerPool.query('update booking_slots set active=false where booking_id=$1', [inactive.bookingId])
  const rInactive = await bill(A.userId, A.tenantId, { bookingId: inactive.bookingId })
  check('a booking whose slots are all inactive is REFUSED', !rInactive.ok && /nothing to bill/i.test(rInactive.message))

  // ── 6. promo ──────────────────────────────────────────────────────────────
  // Promo rules live in scripts/test-promo.ts; what matters here is that an
  // unusable code stops the bill outright rather than quietly billing full
  // price to a customer who was promised a discount.
  const promoBooking = await makeBooking(A)
  const rPromo = await bill(A.userId, A.tenantId, { bookingId: promoBooking.bookingId, promoCode: 'NOSUCHCODE' })
  check('an unknown promo code REFUSES the bill', !rPromo.ok && rPromo.billing && /promo code not found/i.test(rPromo.message))
  check('…and no invoice was raised, so nobody is billed without their promo', (await ownerPool.query('select count(*)::int n from invoices where booking_id=$1', [promoBooking.bookingId])).rows[0].n === 0)
  const rBlankPromo = await bill(A.userId, A.tenantId, { bookingId: promoBooking.bookingId, promoCode: '   ' })
  check('a blank promo code is ignored, not refused', rBlankPromo.ok)

  // ── 7. discount rules ─────────────────────────────────────────────────────
  const dBooking = await makeBooking(A)
  const rOver = await bill(A.userId, A.tenantId, { bookingId: dBooking.bookingId, discount: 5000 })
  check('a discount larger than the subtotal still bills', rOver.ok)
  if (rOver.ok) {
    const inv = (await ownerPool.query('select discount, total, subtotal from invoices where id=$1', [rOver.invoiceId])).rows[0]
    check('…capped at the subtotal by priceBill (900.00)', inv.discount === '900.00')
    check('…and the total is 0.00, never negative', inv.total === '0.00')
  }

  // ── 8. tenant isolation ───────────────────────────────────────────────────
  const aBooking = await makeBooking(A)
  const cross = await bill(B.userId, B.tenantId, { bookingId: aBooking.bookingId })
  check("tenant B cannot bill tenant A's booking (RLS ⇒ not found)", !cross.ok && cross.billing && /booking not found/i.test(cross.message))
  check('…and no invoice was created anywhere', (await ownerPool.query('select count(*)::int n from invoices where booking_id=$1', [aBooking.bookingId])).rows[0].n === 0)

  // Even naming tenant A as the tenant does not help — RLS scopes to the USER.
  const crossSpoof = await bill(B.userId, A.tenantId, { bookingId: aBooking.bookingId })
  check("tenant B cannot bill it by claiming tenant A's id either", !crossSpoof.ok)
  check('…still no invoice', (await ownerPool.query('select count(*)::int n from invoices where booking_id=$1', [aBooking.bookingId])).rows[0].n === 0)

  const bOwn = await makeBooking(B)
  const rB = await bill(B.userId, B.tenantId, { bookingId: bOwn.bookingId })
  check('tenant B CAN bill its own booking', rB.ok)
  check('…and tenant B numbering starts at its own …/000001', rB.ok && rB.invoiceNumber === expectedNumber(1))

  // ── 9. concurrency: same booking, two cashiers ────────────────────────────
  const raceBooking = await makeBooking(A)
  const race = await Promise.all([
    bill(A.userId, A.tenantId, { bookingId: raceBooking.bookingId }),
    bill(A.userId, A.tenantId, { bookingId: raceBooking.bookingId }),
  ])
  const won = race.filter((r) => r.ok).length
  check('two simultaneous bills on one booking → exactly ONE succeeds', won === 1)
  check('…the loser gets the already-billed message', race.some((r) => !r.ok && /already been billed/i.test(r.message)))
  check('…and the database holds exactly one invoice for that booking', (await ownerPool.query('select count(*)::int n from invoices where booking_id=$1', [raceBooking.bookingId])).rows[0].n === 1)

  // ── 10. concurrency: distinct bookings must get distinct numbers ──────────
  const many = await Promise.all([makeBooking(A), makeBooking(A), makeBooking(A), makeBooking(A), makeBooking(A)])
  const issued = await Promise.all(many.map((b) => bill(A.userId, A.tenantId, { bookingId: b.bookingId })))
  check('5 concurrent bills on 5 bookings all succeed', issued.every((r) => r.ok))
  const numbers = issued.filter((r) => r.ok).map((r) => (r as { invoiceNumber: string }).invoiceNumber)
  check('…every invoice number is unique', new Set(numbers).size === numbers.length)
  check(`…and all carry the ${DEFAULT_INVOICE_PREFIX}/FY/NNNNNN format`, numbers.every((n) => new RegExp(`^${DEFAULT_INVOICE_PREFIX}/\\d{4}/\\d{6}$`).test(n)))

  const all = (await ownerPool.query<{ invoice_number: string }>(
    'select invoice_number from invoices where tenant_id=$1 order by invoice_number',
    [A.tenantId],
  )).rows.map((r) => r.invoice_number)
  const suffixes = all.map((n) => Number(n.split('/').pop()))
  check('tenant A numbering is gap-free and sequential from 1', JSON.stringify(suffixes) === JSON.stringify(Array.from({ length: suffixes.length }, (_, i) => i + 1)))
  check('…and unique across the tenant', new Set(all).size === all.length)

  const period = financialYearPeriod('2026-08-10')
  const seq = (await ownerPool.query<{ value: number; kind: string; period: string }>(
    `select value, kind, period from sequences where tenant_id=$1 and kind='invoice'`,
    [A.tenantId],
  )).rows
  check('the counter lives under (tenant, invoice, financial-year)', seq.length === 1 && seq[0].kind === 'invoice' && /^\d{4}-\d{2}$/.test(seq[0].period))
  check('the counter equals the number of invoices raised', seq[0] && Number(seq[0].value) === all.length)
  check(`period format matches financialYearPeriod ('${period}')`, /^\d{4}-\d{2}$/.test(period))

  // ── 11. failure rolls everything back ─────────────────────────────────────
  const before = (await ownerPool.query('select count(*)::int n from invoices where tenant_id=$1', [A.tenantId])).rows[0].n
  const seqBefore = (await ownerPool.query(`select value from sequences where tenant_id=$1 and kind='invoice'`, [A.tenantId])).rows[0].value
  const rollbackBooking = await makeBooking(A, { status: 'cancelled' })
  await bill(A.userId, A.tenantId, { bookingId: rollbackBooking.bookingId })
  const after = (await ownerPool.query('select count(*)::int n from invoices where tenant_id=$1', [A.tenantId])).rows[0].n
  const seqAfter = (await ownerPool.query(`select value from sequences where tenant_id=$1 and kind='invoice'`, [A.tenantId])).rows[0].value
  check('a refused bill leaves the invoice count unchanged', after === before)
  check('…and does not burn a sequence number', Number(seqAfter) === Number(seqBefore))

  // ── 12. REGRESSION: numbering must survive the financial-year rollover ────
  // The counter restarts at 1 every 1 April. If the year were not part of the
  // number, the first bill of the new year would format the same string as the
  // first bill of the old one and be rejected by unique(tenant_id,
  // invoice_number) — and because the bump shares the insert's transaction, the
  // rollback would undo the bump too, so every retry would repeat it and
  // billing would be permanently broken from 1 April.
  {
    check(
      "formatInvoiceNumber puts the financial year in the number ('2026-27' → INV/2627/000001)",
      formatInvoiceNumber('INV', '2026-27', 1) === 'INV/2627/000001',
    )
    check(
      'the SAME running number in a different year is a DIFFERENT string',
      formatInvoiceNumber('INV', '2026-27', 1) !== formatInvoiceNumber('INV', '2027-28', 1),
    )
    check(
      'both stay inside the 16-character GST limit',
      formatInvoiceNumber('INV', '2026-27', 999999).length <= GST_INVOICE_NUMBER_MAX_LENGTH,
    )

    // End to end: take the first number of two consecutive years and prove the
    // database accepts both for the same tenant.
    const thisYear = await withUser(A.userId, (tx) =>
      nextInvoiceNumber(tx, A.tenantId, '2040-41', DEFAULT_INVOICE_PREFIX),
    )
    const nextYear = await withUser(A.userId, (tx) =>
      nextInvoiceNumber(tx, A.tenantId, '2041-42', DEFAULT_INVOICE_PREFIX),
    )
    check('a fresh year starts its own run at 000001', thisYear.endsWith('/000001') && nextYear.endsWith('/000001'))
    check('…yet the two numbers differ', thisYear !== nextYear)

    let bothAccepted = true
    for (const number of [thisYear, nextYear]) {
      try {
        await ownerPool.query(
          `insert into invoices (tenant_id,branch_id,invoice_number,total) values ($1,$2,$3,'1.00')`,
          [A.tenantId, A.branchId, number],
        )
      } catch {
        bothAccepted = false
      }
    }
    check('the database accepts BOTH years’ first invoice for one tenant', bothAccepted)
  }

  // ── 13. REGRESSION: a zero-total bill is born settled ─────────────────────
  // Otherwise the row sits at 'issued' forever while the receipt prints PAID.
  {
    const freeBooking = await makeBooking(A, { rate: '0.00' })
    const free = await bill(A.userId, A.tenantId, { bookingId: freeBooking.bookingId })
    check('a bill whose lines are all free is still raised', free.ok)
    if (free.ok) {
      const inv = (await ownerPool.query('select total, status from invoices where id=$1', [free.invoiceId])).rows[0]
      check('…with a 0.00 total', inv.total === '0.00')
      check("…and status 'paid', matching what the receipt shows", inv.status === 'paid')
    }

    // A discount that clears the whole bill settles it the same way.
    const clearedBooking = await makeBooking(A)
    const cleared = await bill(A.userId, A.tenantId, { bookingId: clearedBooking.bookingId, discount: 5000 })
    check('a discount that clears the bill also settles it', cleared.ok)
    if (cleared.ok) {
      const inv = (await ownerPool.query('select total, status from invoices where id=$1', [cleared.invoiceId])).rows[0]
      check('…total 0.00, status paid', inv.total === '0.00' && inv.status === 'paid')
    }

    // And a normal bill is still born unpaid.
    const normalBooking = await makeBooking(A)
    const normal = await bill(A.userId, A.tenantId, { bookingId: normalBooking.bookingId })
    check("a bill with money owing still starts as 'issued'", normal.ok && (await ownerPool.query('select status from invoices where id=$1', [normal.invoiceId])).rows[0].status === 'issued')
  }

  // ── 14. food & beverage folds into ONE bill ───────────────────────────────
  // A PS5 booking plus 2 cokes + fries: one Food & Beverage section, correct
  // tax, folded into the same grand total as the console time — no separate
  // food bill, no separate math.
  {
    const fb = await makeBooking(A) // 2h × ₹450 = ₹900, taxPercent 0
    await makeFoodOrder(A, fb.bookingId, [
      { name: 'Coke', unitPrice: '50.00', qty: 2, taxRate: '5.00' }, // 100.00
      { name: 'Fries', unitPrice: '120.00', qty: 1, taxRate: '5.00' }, // 120.00
    ])
    const rFood = await bill(A.userId, A.tenantId, { bookingId: fb.bookingId })
    check('a booking with food orders bills successfully', rFood.ok)

    if (rFood.ok) {
      const inv = (
        await ownerPool.query('select subtotal, tax_total, total from invoices where id=$1', [rFood.invoiceId])
      ).rows[0]
      check('subtotal = 1120.00 (900 booking + 100 + 120 food)', inv.subtotal === '1120.00')
      check('tax_total = 11.00 (5% GST on the 220.00 taxable food lines)', inv.tax_total === '11.00')
      check('total = 1131.00, booking + food in ONE grand total', inv.total === '1131.00')

      const items = (
        await ownerPool.query(
          `select kind, description, qty, unit_price, tax_rate, line_total
             from invoice_items where invoice_id=$1 order by kind, description`,
          [rFood.invoiceId],
        )
      ).rows
      check('3 invoice lines: 1 booking + 2 food', items.length === 3)
      const food = items.filter((i) => i.kind === 'food')
      check('2 lines are tagged kind=food', food.length === 2)
      const coke = food.find((i) => i.description === 'Coke')
      const fries = food.find((i) => i.description === 'Fries')
      check(
        'Coke: qty 2.00 @ 50.00, 5% tax, line 100.00',
        !!coke && coke.qty === '2.00' && coke.unit_price === '50.00' && coke.tax_rate === '5.00' && coke.line_total === '100.00',
      )
      check(
        'Fries: qty 1.00 @ 120.00, 5% tax, line 120.00',
        !!fries && fries.qty === '1.00' && fries.unit_price === '120.00' && fries.tax_rate === '5.00' && fries.line_total === '120.00',
      )

      // ── no double-bill ───────────────────────────────────────────────────
      const orderStatus = (
        await ownerPool.query('select status from orders where booking_id=$1', [fb.bookingId])
      ).rows[0].status
      check("the food order is marked 'billed' the moment the invoice is raised", orderStatus === 'billed')

      const reload = await withUser(A.userId, (tx) => loadFoodLines(tx, A.tenantId, fb.bookingId))
      check('…and structurally disappears from loadFoodLines — it can never be billed again', reload.length === 0)

      // ── REGRESSION: the bill screen must still SHOW the food it billed ────
      // loadFoodLines correctly hides a billed order from future bills, but
      // that must not make an ALREADY-ISSUED invoice look like it forgot the
      // food — the screen has to read the frozen invoice_items back, not
      // recompute from live (now-billed) orders.
      const invoiceLines = await withUser(A.userId, (tx) => loadInvoiceLines(tx, A.tenantId, rFood.invoiceId))
      check('loadInvoiceLines still returns all 3 lines for the issued invoice', invoiceLines.length === 3)
      check(
        '…including both food lines, unit price and tax intact',
        invoiceLines.filter((l) => l.kind === 'food').length === 2 &&
          invoiceLines.some((l) => l.description === 'Coke' && l.unitPrice === 50 && l.taxPercent === 5) &&
          invoiceLines.some((l) => l.description === 'Fries' && l.unitPrice === 120 && l.taxPercent === 5),
      )

      // ── void releases the order, so a corrected re-bill isn't left short ──
      const membershipId = A.membershipId
      await withUser(A.userId, (tx) =>
        voidInvoiceRecord(tx, { tenantId: A.tenantId, membershipId }, { invoiceId: rFood.invoiceId, reason: 'Testing' }),
      )
      const releasedStatus = (
        await ownerPool.query('select status from orders where booking_id=$1', [fb.bookingId])
      ).rows[0].status
      check("voiding releases the food order back to 'open'", releasedStatus === 'open')

      const reloadAfterVoid = await withUser(A.userId, (tx) => loadFoodLines(tx, A.tenantId, fb.bookingId))
      check('…so it reappears in loadFoodLines, ready to be billed again', reloadAfterVoid.length === 2)

      const rRebill = await bill(A.userId, A.tenantId, { bookingId: fb.bookingId })
      check('re-billing after the void succeeds', rRebill.ok)
      if (rRebill.ok) {
        const inv2 = (
          await ownerPool.query('select subtotal, total from invoices where id=$1', [rRebill.invoiceId])
        ).rows[0]
        check('…the new invoice carries the SAME food total, not double-counted', inv2.subtotal === '1120.00' && inv2.total === '1131.00')
        const foodCount = (
          await ownerPool.query(`select count(*)::int n from invoice_items where invoice_id=$1 and kind='food'`, [rRebill.invoiceId])
        ).rows[0].n
        check('…exactly 2 food lines on the re-bill, not 4', foodCount === 2)
      }

      // The voided invoice keeps its own frozen snapshot — re-billing never
      // rewrites history.
      const oldInv = (await ownerPool.query('select subtotal from invoices where id=$1', [rFood.invoiceId])).rows[0]
      check('the voided invoice keeps its own frozen subtotal (1120.00)', oldInv.subtotal === '1120.00')
    }

    // A cancelled order was never served and must never reach a bill.
    const cancelledBooking = await makeBooking(A)
    await makeFoodOrder(A, cancelledBooking.bookingId, [{ name: 'Mocktail', unitPrice: '90.00', qty: 1 }], {
      status: 'cancelled',
    })
    const rCancelled = await bill(A.userId, A.tenantId, { bookingId: cancelledBooking.bookingId })
    check('a cancelled food order never reaches the bill', rCancelled.ok)
    if (rCancelled.ok) {
      const foodCount = (
        await ownerPool.query(`select count(*)::int n from invoice_items where invoice_id=$1 and kind='food'`, [rCancelled.invoiceId])
      ).rows[0].n
      check('…0 food lines — only the booking charge was billed', foodCount === 0)
    }

    // A walk-in order (no booking_id) must never bleed onto an unrelated bill.
    const walkinBooking = await makeBooking(A)
    const unrelatedBooking = await makeBooking(A)
    await makeFoodOrder(A, walkinBooking.bookingId, [{ name: 'Walk-in Snack', unitPrice: '40.00', qty: 1 }])
    const rUnrelated = await bill(A.userId, A.tenantId, { bookingId: unrelatedBooking.bookingId })
    check('billing a different booking is unaffected by another booking’s food order', rUnrelated.ok)
    if (rUnrelated.ok) {
      const foodCount = (
        await ownerPool.query(`select count(*)::int n from invoice_items where invoice_id=$1 and kind='food'`, [rUnrelated.invoiceId])
      ).rows[0].n
      check("…0 food lines — another booking's order does not cross over", foodCount === 0)
    }
  }

  // ══ REGRESSION: an order placed mid-billing must not be swallowed ═════════
  //
  // The bug this guards: issueInvoiceForBooking used to read the open food
  // orders, then flip `status='open' → 'billed'` with an UNSCOPED predicate. An
  // order created between those two statements was invisible to the read but
  // caught by the flip — marked billed, never charged, and gone from every
  // future bill. The mirror image of double-billing, and quieter, because
  // nobody complains about not being charged.
  //
  // The sequence below is exactly what issueInvoiceForBooking now does
  // internally (lockOpenFoodOrders → loadBillLines(ids) → scoped flip), with a
  // concurrent INSERT committed from a SEPARATE connection in the middle —
  // which is the only way to reproduce the race, since a row lock cannot
  // prevent an insert.
  {
    console.log('\n── mid-billing order (race regression) ──')

    const rb = await makeBooking(A, { hours: 1 })
    const first = await makeFoodOrder(A, rb.bookingId, [
      { name: 'Early Coke', unitPrice: '50.00', qty: 1, taxRate: '5.00' },
    ])

    // A second connection, so its INSERT genuinely commits while the billing
    // transaction below is open.
    const intruder = new Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 1 })

    const captured = await withUser(A.userId, async (tx) => {
      // 1. what issueInvoiceForBooking captures and holds
      const ids = await lockOpenFoodOrders(tx, A.tenantId, rb.bookingId)

      // 2. …and now a customer/waiter places another order, committed.
      await intruder.query(
        `insert into orders (tenant_id,branch_id,booking_id,order_number,status)
         values ($1,$2,$3,'FO-RACE','open')`,
        [A.tenantId, A.branchId, rb.bookingId],
      )
      const lateOrder = await intruder.query<{ id: string }>(
        `select id from orders where tenant_id=$1 and order_number='FO-RACE'`,
        [A.tenantId],
      )
      await intruder.query(
        `insert into order_items (tenant_id,order_id,item_name,unit_price,tax_rate,qty,line_total)
         values ($1,$2,'Late Fries','120.00','5.00',1,'120.00')`,
        [A.tenantId, lateOrder.rows[0].id],
      )

      // 3. the lines the invoice would charge for, using the captured set
      const lines = await loadBillLines(tx, A.tenantId, rb.bookingId, 'Asia/Kolkata', ids)

      // 4. the flip, scoped to the captured set — byte-for-byte the predicate
      //    issueInvoiceForBooking step 7 now uses. Running it here, INSIDE the
      //    same transaction as the capture, is the only way to reproduce the
      //    window the bug lived in: calling issueInvoiceForBooking() from
      //    outside would open a fresh transaction, by which time the late order
      //    legitimately exists and SHOULD be billed.
      await tx
        .update(schema.orders)
        .set({ status: 'billed' })
        .where(
          and(
            eq(schema.orders.tenantId, A.tenantId),
            eq(schema.orders.bookingId, rb.bookingId),
            eq(schema.orders.status, 'open'),
            inArray(schema.orders.id, ids),
          ),
        )

      return { ids, lateOrderId: lateOrder.rows[0].id, lines }
    })

    check('the capture took exactly the one order that existed', captured.ids.length === 1)
    check('…and it is the early one', captured.ids[0] === first.orderId)
    check(
      'the late order is NOT charged for — its item is absent from the lines',
      !captured.lines.some((l) => l.description === 'Late Fries'),
    )
    check(
      '…while the early one still is',
      captured.lines.some((l) => l.description === 'Early Coke'),
    )

    const raceStatuses = (
      await ownerPool.query<{ order_number: string; status: string }>(
        'select order_number, status from orders where booking_id=$1 order by order_number',
        [rb.bookingId],
      )
    ).rows
    const early = raceStatuses.find((s) => s.order_number !== 'FO-RACE')
    const late = raceStatuses.find((s) => s.order_number === 'FO-RACE')

    check('the captured order is marked billed', early?.status === 'billed')
    check(
      'THE FIX: the late order is still OPEN — charged for later, not silently billed',
      late?.status === 'open',
    )

    // The money is not lost: the late order is still billable on the next bill.
    const stillBillable = await withUser(A.userId, (tx) =>
      loadFoodLines(tx, A.tenantId, rb.bookingId),
    )
    check(
      'the late order remains billable — the charge was deferred, not destroyed',
      stillBillable.length === 1 && stillBillable[0].description === 'Late Fries',
    )

    // ── and the contrast: the OLD unscoped flip would have eaten it ─────────
    // Rolled back, so it only demonstrates the difference and changes nothing.
    const wouldHaveSwallowed = await withUser(A.userId, async (tx) => {
      const r = await tx
        .update(schema.orders)
        .set({ status: 'billed' })
        .where(
          and(
            eq(schema.orders.tenantId, A.tenantId),
            eq(schema.orders.bookingId, rb.bookingId),
            eq(schema.orders.status, 'open'),
          ),
        )
        .returning({ id: schema.orders.id })
      // Undo — this branch exists to prove a point, not to change data.
      await tx
        .update(schema.orders)
        .set({ status: 'open' })
        .where(
          and(
            eq(schema.orders.tenantId, A.tenantId),
            eq(schema.orders.orderNumber, 'FO-RACE'),
          ),
        )
      return r.length
    })
    check(
      '…whereas the old UNSCOPED flip would have swallowed the late order',
      wouldHaveSwallowed === 1,
    )

    const unchanged = (
      await ownerPool.query<{ status: string }>(
        `select status from orders where tenant_id=$1 and order_number='FO-RACE'`,
        [A.tenantId],
      )
    ).rows[0]
    check('…and the demonstration left it open', unchanged.status === 'open')

    await intruder.end()
  }

  // ── cleanup ───────────────────────────────────────────────────────────────
  await ownerPool.query('delete from tenants where id = any($1)', [[A.tenantId, B.tenantId]])
  await ownerPool.query(`delete from users where email like '%@testbill%.test'`)
  await ownerPool.end()
  await appPool.end()

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
