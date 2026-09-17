/**
 * Service charge + tip (M18 #3). Integration tests against a real database,
 * same shape as scripts/test-split-bill.ts. Drives issueInvoiceForBooking /
 * issueSplitBillForBooking / recordPaymentForInvoice directly:
 *
 *   - service charge off (percent 0, the default) leaves a bill byte-
 *     identical to before this story — regression guard
 *   - a taxable service charge: correct amount, correct tax, folded into
 *     taxTotal/taxBreakup/total, its own invoice_items row
 *   - a non-taxable service charge (no tax rate configured): amount
 *     present, tax exactly zero
 *   - split + service charge (even and by-item): apportioned proportional
 *     to each check's own subtotal, reconciling EXACTLY to the paisa
 *   - tip: recorded on a payment, never affects alreadyPaid/balance/
 *     payable; invoices.tip_amount increments correctly; a retried
 *     (idempotent) tender does not double-count its tip; a cross-tenant
 *     recipient is refused
 *
 *   npx tsx scripts/test-service-charge.ts
 */
import { Pool } from 'pg'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { sql } from 'drizzle-orm'
import * as schema from '../db/schema'
import { seatTableSessionCore } from '../lib/booking/service'
import { createOrderCore } from '../lib/orders/service'
import { issueInvoiceForBooking } from '../lib/billing/invoice'
import { issueSplitBillForBooking, type SplitInput } from '../lib/billing/split'
import { recordPaymentForInvoice, getInvoiceSettlement, PaymentError } from '../lib/billing/payments'
import { loadEnv } from './env'

type Db = NodePgDatabase<typeof schema>

let pass = 0,
  fail = 0
const check = (l: string, c: boolean) => {
  console.log(`${c ? '✓' : '✗ FAIL'}  ${l}`)
  if (c) pass++
  else fail++
}
const paise = (n: number | string) => Math.round(Number(n) * 100)

const TZ = 'Asia/Kolkata'

async function main() {
  loadEnv()

  const ownerPool = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })
  const appPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 })
  const app = drizzle(appPool, { schema })

  async function withUser<T>(userId: string, fn: (tx: Db) => Promise<T>): Promise<T> {
    return app.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`)
      return fn(tx as unknown as Db)
    })
  }

  type Tenant = {
    tenantId: string
    branchId: string
    userId: string
    membershipId: string
    itemId5: string // 5% GST item, 100.00
    tax5Id: string
    tax18Id: string
    tables: string[]
  }

  async function makeTenant(slug: string): Promise<Tenant> {
    const t = await ownerPool.query<{ id: string }>(
      `insert into tenants (slug,name,status,timezone,industry) values ($1,$2,'active',$3,'restaurant')
       on conflict (slug) do update set name=excluded.name returning id`,
      [slug, `${slug} co`, TZ],
    )
    const tenantId = t.rows[0].id
    const b = await ownerPool.query<{ id: string }>(
      `insert into branches (tenant_id,name,is_primary) values ($1,'Main',true)
       on conflict (tenant_id,name) do update set is_primary=true returning id`,
      [tenantId],
    )
    const branchId = b.rows[0].id
    const u = await ownerPool.query<{ id: string }>(
      `insert into users (email,password_hash) values ($1,'x')
       on conflict (email) do update set email=excluded.email returning id`,
      [`waiter@${slug}.test`],
    )
    const m = await ownerPool.query<{ id: string }>(
      `insert into memberships (tenant_id,user_id,role,status,full_name) values ($1,$2,'owner','active','Owner Pat')
       on conflict (tenant_id,user_id) do update set role='owner', status='active' returning id`,
      [tenantId, u.rows[0].id],
    )
    const cat = await ownerPool.query<{ id: string }>(
      `insert into menu_categories (tenant_id,name) values ($1,'Mains')
       on conflict (tenant_id,name) do update set name=excluded.name returning id`,
      [tenantId],
    )
    const tax5 = await ownerPool.query<{ id: string }>(
      `insert into tax_rates (tenant_id,name,percent) values ($1,'GST 5','5.00') returning id`,
      [tenantId],
    )
    const tax18 = await ownerPool.query<{ id: string }>(
      `insert into tax_rates (tenant_id,name,percent) values ($1,'GST 18','18.00') returning id`,
      [tenantId],
    )
    const item5 = await ownerPool.query<{ id: string }>(
      `insert into menu_items (tenant_id,category_id,name,price,tax_rate_id) values ($1,$2,'Pasta','100.00',$3) returning id`,
      [tenantId, cat.rows[0].id, tax5.rows[0].id],
    )
    const rt = await ownerPool.query<{ id: string }>(
      `insert into resource_types (tenant_id,name,hourly_rate) values ($1,'Table','0')
       on conflict (tenant_id,name) do update set name=excluded.name returning id`,
      [tenantId],
    )
    const r = await ownerPool.query<{ id: string }>(
      `insert into resources (tenant_id,branch_id,resource_type_id,name) values ($1,$2,$3,'T1') returning id`,
      [tenantId, branchId, rt.rows[0].id],
    )
    return {
      tenantId,
      branchId,
      userId: u.rows[0].id,
      membershipId: m.rows[0].id,
      itemId5: item5.rows[0].id,
      tax5Id: tax5.rows[0].id,
      tax18Id: tax18.rows[0].id,
      tables: [r.rows[0].id],
    }
  }

  async function setServiceCharge(t: Tenant, percent: number, taxRateId: string | null) {
    await ownerPool.query(
      `insert into business_profiles (tenant_id, service_charge_percent, service_charge_tax_rate_id)
       values ($1, $2, $3)
       on conflict (tenant_id) do update set service_charge_percent=excluded.service_charge_percent, service_charge_tax_rate_id=excluded.service_charge_tax_rate_id`,
      [t.tenantId, percent.toFixed(2), taxRateId],
    )
  }

  async function seat(t: Tenant, coverCount = 4) {
    return withUser(t.userId, (tx) =>
      seatTableSessionCore(tx, { tenantId: t.tenantId, timezone: TZ, membershipId: t.membershipId }, { branchId: t.branchId, resourceId: t.tables[0], coverCount }),
    )
  }

  async function order(t: Tenant, bookingId: string, qty: number) {
    return withUser(t.userId, (tx) =>
      createOrderCore(tx, { tenantId: t.tenantId, timezone: TZ, membershipId: t.membershipId }, { branchId: t.branchId, bookingId, items: [{ menuItemId: t.itemId5, qty }] }),
    )
  }

  async function whole(t: Tenant, bookingId: string) {
    return withUser(t.userId, (tx) => issueInvoiceForBooking(tx, { id: t.tenantId, timezone: TZ }, { bookingId }))
  }

  async function split(t: Tenant, bookingId: string, input: SplitInput) {
    return withUser(t.userId, (tx) => issueSplitBillForBooking(tx, { id: t.tenantId, timezone: TZ }, { bookingId, ...input }))
  }

  async function cancel(t: Tenant, bookingId: string) {
    await withUser(t.userId, (tx) => tx.update(schema.bookings).set({ status: 'cancelled' }).where(sql`${schema.bookings.id} = ${bookingId}`))
  }

  async function invoiceRow(invoiceId: string) {
    const { rows } = await ownerPool.query(
      `select subtotal, tax_total, total, service_charge_percent, service_charge_amount, service_charge_tax_percent, tip_amount, tax_breakup
       from invoices where id=$1`,
      [invoiceId],
    )
    return rows[0] as {
      subtotal: string
      tax_total: string
      total: string
      service_charge_percent: string
      service_charge_amount: string
      service_charge_tax_percent: string
      tip_amount: string
      tax_breakup: { rate: number; cgst: string; sgst: string }[]
    }
  }

  async function invoiceItemRows(invoiceId: string) {
    const { rows } = await ownerPool.query(
      `select kind, source_id, description, unit_price, tax_rate, line_total from invoice_items where invoice_id=$1 order by created_at`,
      [invoiceId],
    )
    return rows as { kind: string; source_id: string | null; description: string; unit_price: string; tax_rate: string; line_total: string }[]
  }

  async function attempt<T>(fn: () => Promise<T>) {
    try {
      const value = await fn()
      return { ok: true as const, value }
    } catch (e) {
      return { ok: false as const, payment: e instanceof PaymentError, message: e instanceof Error ? e.message : String(e) }
    }
  }

  const A = await makeTenant('testservicecharge-a')
  const B = await makeTenant('testservicecharge-b')

  // ── 1. service charge off (default) — a bill is byte-identical to before ───
  {
    await setServiceCharge(A, 0, null)
    const session = await seat(A)
    await order(A, session.id, 2) // 200.00 subtotal, 5% tax
    const inv = await whole(A, session.id)
    const row = await invoiceRow(inv.invoiceId)
    check('service charge off: subtotal unaffected (200.00)', row.subtotal === '200.00')
    check('service charge off: tax unaffected (10.00)', row.tax_total === '10.00')
    check('service charge off: total unaffected (210.00)', row.total === '210.00')
    check('service charge off: service_charge_amount is 0.00', row.service_charge_amount === '0.00')
    const items = await invoiceItemRows(inv.invoiceId)
    check('service charge off: no service_charge line item', !items.some((i) => i.kind === 'service_charge'))
    await cancel(A, session.id)
  }

  // ── 2. taxable service charge (10%, GST 18%) ────────────────────────────────
  {
    await setServiceCharge(A, 10, A.tax18Id)
    const session = await seat(A)
    await order(A, session.id, 2) // subtotal 200.00 @ 5% food tax
    const inv = await whole(A, session.id)
    const row = await invoiceRow(inv.invoiceId)
    // service charge = 200 * 10% = 20.00; its tax = 20 * 18% = 3.60
    check('taxable SC: service_charge_amount = 20.00', row.service_charge_amount === '20.00')
    check('taxable SC: service_charge_tax_percent = 18.00', row.service_charge_tax_percent === '18.00')
    // food tax 200*5%=10.00, SC tax 20*18%=3.60 -> tax_total = 13.60
    check('taxable SC: tax_total folds in the SC tax (10.00 + 3.60 = 13.60)', row.tax_total === '13.60')
    // total = taxableValue(200) + SC amount(20) + tax_total(13.60) = 233.60
    check('taxable SC: total = 233.60', row.total === '233.60')
    check(
      'taxable SC: tax_breakup carries both the 5% and 18% groups',
      row.tax_breakup.some((g) => g.rate === 5) && row.tax_breakup.some((g) => g.rate === 18),
    )
    const items = await invoiceItemRows(inv.invoiceId)
    const scLine = items.find((i) => i.kind === 'service_charge')
    check('taxable SC: its own invoice_items row exists, sourceId null', Boolean(scLine) && scLine!.source_id === null)
    check('taxable SC: line unit_price/line_total = 20.00', scLine!.unit_price === '20.00' && scLine!.line_total === '20.00')
    await cancel(A, session.id)
  }

  // ── 3. non-taxable service charge (no tax rate configured) ─────────────────
  {
    await setServiceCharge(A, 10, null)
    const session = await seat(A)
    await order(A, session.id, 1) // subtotal 100.00
    const inv = await whole(A, session.id)
    const row = await invoiceRow(inv.invoiceId)
    check('non-taxable SC: amount present (10.00)', row.service_charge_amount === '10.00')
    check('non-taxable SC: tax percent is 0', row.service_charge_tax_percent === '0.00')
    // food tax 100*5%=5.00, no SC tax -> tax_total unchanged at 5.00
    check('non-taxable SC: tax_total unaffected by SC (5.00)', row.tax_total === '5.00')
    // total = 100 (taxable) + 10 (SC) + 5 (tax) = 115.00
    check('non-taxable SC: total = 115.00', row.total === '115.00')
    await cancel(A, session.id)
  }

  // ── 4. split + service charge reconciles exactly ────────────────────────────
  {
    await setServiceCharge(A, 10, A.tax18Id)
    const session = await seat(A)
    await order(A, session.id, 7) // 700.00 subtotal, prime-ish split target
    const result = await split(A, session.id, { mode: 'even', checkCount: 3 })
    const sumSc = result.checks.reduce((s, c) => s + paise(c.pricing.serviceChargeAmount), 0)
    const sumTotal = result.checks.reduce((s, c) => s + paise(c.pricing.total), 0)
    // whole: subtotal 700, SC = 70.00, SC tax = 70*18%=12.60, food tax=700*5%=35.00
    // total = 700 + 70 + 35 + 12.60 = 817.60
    check('split+SC: sum of check service charge amounts = 70.00', sumSc === paise(70))
    check('split+SC: sum of check totals = 817.60', sumTotal === paise(817.6))
    check('split+SC: every check carries its own service_charge line', result.checks.every((c) => c.pricing.items.some((i) => i.kind === 'service_charge')))
    await cancel(A, session.id)
  }

  // ── 5. by-item split + service charge (proportional, not even) ─────────────
  {
    await setServiceCharge(A, 10, A.tax18Id)
    const session = await seat(A)
    await order(A, session.id, 3) // one line, qty 3 = 300.00
    const { rows: itemRows } = await ownerPool.query(`select oi.id from order_items oi join orders o on o.id=oi.order_id where o.booking_id=$1`, [session.id])
    const lineId = itemRows[0].id as string
    await order(A, session.id, 5) // second line, qty 5 = 500.00, different check
    const { rows: allItems } = await ownerPool.query(`select oi.id from order_items oi join orders o on o.id=oi.order_id where o.booking_id=$1 order by oi.id`, [session.id])
    const ids = allItems.map((r) => r.id as string)
    const assignments: Record<string, number> = {}
    assignments[lineId] = 0
    for (const id of ids) if (id !== lineId) assignments[id] = 1

    const result = await split(A, session.id, { mode: 'item', checkCount: 2, assignments })
    const [checkA, checkB] = result.checks
    // checkA has 300.00 worth (3/8 of 800), checkB has 500.00 (5/8) — SC should
    // apportion 10% of EACH check's own subtotal, i.e. proportional not equal.
    check('by-item+SC: check A gets 10% of its own 300.00 = 30.00', checkA.pricing.serviceChargeAmount === 30)
    check('by-item+SC: check B gets 10% of its own 500.00 = 50.00', checkB.pricing.serviceChargeAmount === 50)
    const sumSc = paise(checkA.pricing.serviceChargeAmount) + paise(checkB.pricing.serviceChargeAmount)
    check('by-item+SC: sums to the whole (80.00)', sumSc === paise(80))
    await cancel(A, session.id)
  }

  // ── 6. tip: captured on a payment, never affects balance/payable ───────────
  {
    await setServiceCharge(A, 0, null)
    const session = await seat(A)
    await order(A, session.id, 2) // 200.00 + 5% tax = 210.00
    const inv = await whole(A, session.id)

    const before = await withUser(A.userId, (tx) => getInvoiceSettlement(tx, A.tenantId, inv.invoiceId))
    const pay = await withUser(A.userId, (tx) =>
      recordPaymentForInvoice(tx, { tenantId: A.tenantId, membershipId: A.membershipId }, { invoiceId: inv.invoiceId, method: 'cash', amount: 210, tipAmount: 25, tipRecipientMembershipId: A.membershipId, idempotencyKey: 'tip-key-1' }),
    )
    check('tip: the ₹210 tender still fully settles the ₹210 bill', pay.settled && pay.balance === 0)

    const after = await withUser(A.userId, (tx) => getInvoiceSettlement(tx, A.tenantId, inv.invoiceId))
    check('tip: paid/balance/payable are unaffected by the tip', after!.paid === before!.paid + 210 && after!.balance === 0 && !after!.payable)
    check('tip: tipTotal reflects the ₹25', after!.tipTotal === 25)

    const row = await invoiceRow(inv.invoiceId)
    check('tip: invoices.tip_amount aggregate incremented to 25.00', row.tip_amount === '25.00')

    // Retry with the SAME idempotency key must not double-count the tip.
    const retry = await withUser(A.userId, (tx) =>
      recordPaymentForInvoice(tx, { tenantId: A.tenantId, membershipId: A.membershipId }, { invoiceId: inv.invoiceId, method: 'cash', amount: 210, tipAmount: 25, idempotencyKey: 'tip-key-1' }),
    )
    check('tip: a retried (deduplicated) tender is recognised', Boolean(retry.deduplicated))
    const rowAfterRetry = await invoiceRow(inv.invoiceId)
    check('tip: …and the tip is NOT double-counted (still 25.00)', rowAfterRetry.tip_amount === '25.00')

    await cancel(A, session.id)
  }

  // ── 7. tip recipient must belong to the tenant ──────────────────────────────
  {
    await setServiceCharge(A, 0, null)
    const session = await seat(A)
    await order(A, session.id, 1) // 100.00 + 5% = 105.00
    const inv = await whole(A, session.id)
    const cross = await attempt(() =>
      withUser(A.userId, (tx) =>
        recordPaymentForInvoice(tx, { tenantId: A.tenantId, membershipId: A.membershipId }, { invoiceId: inv.invoiceId, method: 'cash', amount: 105, tipAmount: 10, tipRecipientMembershipId: B.membershipId }),
      ),
    )
    check("tip: another tenant's staff member as recipient is refused", !cross.ok && cross.payment && /staff member was not found/i.test(cross.message))
    await cancel(A, session.id)
  }

  // ── 8. service charge is restaurant-ONLY — the actual enforcement point ────
  // M18 (split/service charge/tips) is a restaurant-only epic. The UI hides
  // the settings section and the Split-bill button for other industries, but
  // the money-correctness guarantee has to live in loadServiceChargeConfig
  // itself: even a non-restaurant tenant that somehow has a nonzero
  // service_charge_percent row (e.g. switched industries after configuring
  // it) must NEVER actually be charged one.
  let C: Tenant
  {
    const t = await ownerPool.query<{ id: string }>(
      `insert into tenants (slug,name,status,timezone,industry) values ($1,$2,'active',$3,'gaming_cafe')
       on conflict (slug) do update set name=excluded.name returning id`,
      ['testservicecharge-c', 'testservicecharge-c co', TZ],
    )
    const tenantId = t.rows[0].id
    const b = await ownerPool.query<{ id: string }>(
      `insert into branches (tenant_id,name,is_primary) values ($1,'Main',true)
       on conflict (tenant_id,name) do update set is_primary=true returning id`,
      [tenantId],
    )
    const branchId = b.rows[0].id
    const u = await ownerPool.query<{ id: string }>(
      `insert into users (email,password_hash) values ($1,'x')
       on conflict (email) do update set email=excluded.email returning id`,
      ['waiter@testservicecharge-c.test'],
    )
    const m = await ownerPool.query<{ id: string }>(
      `insert into memberships (tenant_id,user_id,role,status) values ($1,$2,'owner','active')
       on conflict (tenant_id,user_id) do update set role='owner', status='active' returning id`,
      [tenantId, u.rows[0].id],
    )
    const cat = await ownerPool.query<{ id: string }>(`insert into menu_categories (tenant_id,name) values ($1,'Mains') returning id`, [tenantId])
    const tax5 = await ownerPool.query<{ id: string }>(`insert into tax_rates (tenant_id,name,percent) values ($1,'GST 5','5.00') returning id`, [tenantId])
    const item5 = await ownerPool.query<{ id: string }>(
      `insert into menu_items (tenant_id,category_id,name,price,tax_rate_id) values ($1,$2,'Pasta','100.00',$3) returning id`,
      [tenantId, cat.rows[0].id, tax5.rows[0].id],
    )
    const rt = await ownerPool.query<{ id: string }>(`insert into resource_types (tenant_id,name,hourly_rate) values ($1,'Table','0') returning id`, [tenantId])
    const r = await ownerPool.query<{ id: string }>(`insert into resources (tenant_id,branch_id,resource_type_id,name) values ($1,$2,$3,'T1') returning id`, [tenantId, branchId, rt.rows[0].id])
    C = { tenantId, branchId, userId: u.rows[0].id, membershipId: m.rows[0].id, itemId5: item5.rows[0].id, tax5Id: tax5.rows[0].id, tax18Id: tax5.rows[0].id, tables: [r.rows[0].id] }

    // Configure a service charge exactly as a restaurant would — the point
    // is that it must be IGNORED purely because this tenant isn't one.
    await setServiceCharge(C, 15, C.tax5Id)
    const session = await seat(C)
    await order(C, session.id, 2) // 200.00 + 5% = 210.00
    const inv = await whole(C, session.id)
    const row = await invoiceRow(inv.invoiceId)
    check('non-restaurant tenant: service_charge_amount is 0.00 despite being configured', row.service_charge_amount === '0.00')
    check('non-restaurant tenant: total is the plain food total (210.00)', row.total === '210.00')
    const items = await invoiceItemRows(inv.invoiceId)
    check('non-restaurant tenant: no service_charge line item', !items.some((i) => i.kind === 'service_charge'))
    // Note: split-bill's restaurant-only gate lives in the `previewSplitBill`/
    // `issueSplitBill` SERVER ACTIONS (lib/actions/billing.ts), which need a
    // request context this script doesn't have — not exercisable here. The
    // service-charge gate above is the one that has to hold with NO UI/action
    // in front of it, since prepareBookingBill (shared by both the normal and
    // split billing paths) calls loadServiceChargeConfig unconditionally.

    await cancel(C, session.id)
  }

  // ── cleanup ───────────────────────────────────────────────────────────────
  await ownerPool.query('delete from tenants where id = any($1)', [[A.tenantId, B.tenantId, C.tenantId]])
  await ownerPool.query(`delete from users where email like '%@testservicecharge-%.test'`)
  await ownerPool.end()
  await appPool.end()

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
