/**
 * One bill, four views — do they all agree?
 *
 * A bill is shown three times over its life, from three different places:
 *
 *   BEFORE   the POS screen's client-side preview (priceBill over live lines)
 *   WRITTEN  what issueInvoiceForBooking actually priced and stored
 *   AFTER    the same POS screen once the invoice exists (loadIssuedPricing)
 *   RECEIPT  the GST receipt at /invoices/[id] (loadInvoiceReceipt)
 *
 * Every rupee and every GST figure must be identical across all four. This
 * suite exists because they were not: the screen used to RE-PRICE the invoice's
 * own line items after the bill was raised, which got two things wrong at once —
 *
 *   * invoice_items.qty is numeric(10,2), so an 80-minute slot came back as
 *     1.33 and re-multiplied to ₹532 instead of the ₹533.33 charged;
 *   * the re-price knew nothing of the discount that had been applied, so the
 *     taxable value, every CGST/SGST figure and the grand total came out high
 *     (₹833.82 against the ₹731.06 the customer actually owed).
 *
 * The fractional-hour case below is the exact shape that exposed it, so it is
 * pinned to the paisa rather than asserted loosely.
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs scripts/test-bill-consistency.ts
 *
 * (The server-only hook is required: lib/billing/data.ts is `server-only`.)
 */
import { Pool } from 'pg'
import type { PricingResult } from '../lib/billing/pricing'
import { loadEnv } from './env'

let pass = 0,
  fail = 0
const check = (l: string, c: boolean) => {
  console.log(`${c ? '✓' : '✗ FAIL'}  ${l}`)
  if (c) pass++
  else fail++
}

const TZ = 'Asia/Kolkata'

async function main() {
  // Every app module is imported AFTER this line: db/index.ts builds its pools
  // at module load, so a static import would connect before DATABASE_URL exists.
  loadEnv()
  const { loadBillLines, issueInvoiceForBooking } = await import('../lib/billing/invoice')
  const { loadInvoiceReceipt, loadIssuedPricing } = await import('../lib/billing/receipt')
  const { getInvoiceSettlement } = await import('../lib/billing/payments')
  const { priceBill } = await import('../lib/billing/pricing')
  const { withUser } = await import('../db')

  const owner = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })

  const t = await owner.query<{ id: string }>(
    `insert into tenants (slug,name,status,timezone) values ('testbillcons','testbillcons co','active',$1)
     on conflict (slug) do update set name=excluded.name returning id`, [TZ])
  const tenantId = t.rows[0].id
  const b = await owner.query<{ id: string }>(
    `insert into branches (tenant_id,name,is_primary) values ($1,'Main',true)
     on conflict (tenant_id,name) do update set is_primary=true returning id`, [tenantId])
  const branchId = b.rows[0].id
  const u = await owner.query<{ id: string }>(
    `insert into users (email,password_hash) values ('owner@testbillcons.test','x')
     on conflict (email) do update set email=excluded.email returning id`)
  const userId = u.rows[0].id
  await owner.query(
    `insert into memberships (tenant_id,user_id,role,status) values ($1,$2,'owner','active')
     on conflict (tenant_id,user_id) do update set role='owner', status='active'`, [tenantId, userId])
  const rt = await owner.query<{ id: string }>(
    `insert into resource_types (tenant_id,name,hourly_rate) values ($1,'PS5','400.00')
     on conflict (tenant_id,name) do update set hourly_rate='400.00' returning id`, [tenantId])
  const resourceId = (await owner.query<{ id: string }>(
    `insert into resources (tenant_id,branch_id,resource_type_id,name) values ($1,$2,$3,'S1')
     on conflict (tenant_id,name) do update set name='S1' returning id`,
    [tenantId, branchId, rt.rows[0].id])).rows[0].id

  await owner.query('delete from invoices where tenant_id=$1', [tenantId])
  await owner.query('delete from orders where tenant_id=$1', [tenantId])
  await owner.query('delete from bookings where tenant_id=$1', [tenantId])
  await owner.query('delete from promo_codes where tenant_id=$1', [tenantId])
  await owner.query('delete from sequences where tenant_id=$1', [tenantId])

  let seq = 0
  /** A confirmed booking of `minutes` at ₹400/h, plus optional food lines. */
  async function makeBooking(
    minutes: number,
    food: { name: string; qty: number; price: string; tax: string }[] = [],
  ) {
    const n = ++seq
    const bk = await owner.query<{ id: string }>(
      `insert into bookings (tenant_id,branch_id,booking_number,status,subtotal,total)
       values ($1,$2,$3,'confirmed','0','0') returning id`, [tenantId, branchId, `BC-${n}`])
    const bookingId = bk.rows[0].id
    const start = new Date(Date.UTC(2037, 0, 1 + n, 4, 0, 0))
    await owner.query(
      `insert into booking_slots (tenant_id,booking_id,resource_id,starts_at,ends_at,
         rate_applied,slot_total,resource_name,resource_type_name,active)
       values ($1,$2,$3,$4,$5,'400.00',$6,'S1','PS5',true)`,
      [tenantId, bookingId, resourceId, start, new Date(start.getTime() + minutes * 60_000),
       ((minutes / 60) * 400).toFixed(2)])

    if (food.length > 0) {
      const ord = await owner.query<{ id: string }>(
        `insert into orders (tenant_id,branch_id,booking_id,order_number,status,acceptance_status)
         values ($1,$2,$3,$4,'open','accepted') returning id`,
        [tenantId, branchId, bookingId, `ORD-BC-${n}`])
      for (const f of food) {
        await owner.query(
          `insert into order_items (tenant_id,order_id,item_name,qty,unit_price,tax_rate,line_total,void_status)
           values ($1,$2,$3,$4,$5,$6,$7,'active')`,
          [tenantId, ord.rows[0].id, f.name, f.qty, f.price, f.tax,
           (f.qty * Number(f.price)).toFixed(2)])
      }
    }
    return bookingId
  }

  /** The four views of one bill, for whatever discount the till applied. */
  async function fourViews(bookingId: string, extra: { discount?: number; promoCode?: string } = {}) {
    const lines = await withUser(userId, (tx) => loadBillLines(tx, tenantId, bookingId, TZ))
    return {
      lines,
      issue: async (previewDiscount: number) => {
        const before = priceBill({ lines, discount: previewDiscount })
        const issued = await withUser(userId, (tx) =>
          issueInvoiceForBooking(tx, { id: tenantId, timezone: TZ }, { bookingId, ...extra }))
        const after = await withUser(userId, (tx) =>
          loadIssuedPricing(tx, tenantId, issued.invoiceId))
        const receipt = await withUser(userId, (tx) =>
          loadInvoiceReceipt(tx, tenantId, issued.invoiceId))
        const settlement = await withUser(userId, (tx) =>
          getInvoiceSettlement(tx, tenantId, issued.invoiceId))
        return { before, written: issued.pricing, after: after!, receipt: receipt!, settlement: settlement! }
      },
    }
  }

  /** Every figure of two PricingResults, compared to the paisa. */
  function samePricing(a: PricingResult, b: PricingResult): boolean {
    return (
      a.subtotal === b.subtotal &&
      a.discount === b.discount &&
      a.taxableValue === b.taxableValue &&
      a.taxTotal === b.taxTotal &&
      a.total === b.total &&
      a.taxBreakup.length === b.taxBreakup.length &&
      a.taxBreakup.every((g, i) =>
        g.percent === b.taxBreakup[i].percent &&
        g.cgst === b.taxBreakup[i].cgst &&
        g.sgst === b.taxBreakup[i].sgst) &&
      a.items.length === b.items.length &&
      a.items.every((it, i) =>
        it.taxPercent === b.items[i].taxPercent && it.lineTotal === b.items[i].lineTotal)
    )
  }

  /** The stored receipt read back as the same numbers, for comparison. */
  const receiptAsPricing = (r: Awaited<ReturnType<typeof loadInvoiceReceipt>>): PricingResult => ({
    subtotal: Number(r!.invoice.subtotal),
    discount: Number(r!.invoice.discount),
    taxableValue: Number(r!.invoice.subtotal) - Number(r!.invoice.discount),
    taxBreakup: r!.invoice.taxBreakup.map((g) => ({
      percent: g.rate, cgst: Number(g.cgst), sgst: Number(g.sgst),
    })),
    taxTotal: Number(r!.invoice.taxTotal),
    total: Number(r!.invoice.total),
    items: r!.items.map((i) => ({
      description: i.description,
      kind: i.kind as PricingResult['items'][number]['kind'],
      qty: Number(i.qty),
      unitPrice: Number(i.unitPrice),
      taxPercent: Number(i.taxRate),
      lineTotal: Number(i.lineTotal),
    })),
  })

  // ══ 1. the fractional-hour, mixed-rate, discounted bill ═══════════════════
  // 80 minutes at ₹400/h = ₹533.33, food at 5% and 18%, ₹100 off.
  console.log('\n── 80 minutes, GST 0% + 5% + 18%, ₹100 discount ──')
  {
    const bookingId = await makeBooking(80, [
      { name: 'Masala Chai', qty: 3, price: '40.00', tax: '5.00' },
      { name: 'Cold Coffee', qty: 1, price: '149.00', tax: '18.00' },
    ])
    const v = await fourViews(bookingId, { discount: 100 })
    const { before, written, after, receipt, settlement } = await v.issue(100)

    check('the preview matches what is charged', samePricing(before, written))
    check('the issued view matches what is charged', samePricing(after, written))
    check('the receipt matches what is charged', samePricing(receiptAsPricing(receipt), written))
    check('the payment panel collects the same total', settlement.total === written.total)

    // The exact figures the old re-price got wrong.
    const slot = after.items.find((i) => i.kind === 'booking')!
    check('the 80-minute slot still reads ₹533.33, not the ₹532 a re-price gives',
      slot.lineTotal === 533.33)
    check('…and its stored qty is the 2dp 1.33', slot.qty === 1.33)
    check('subtotal ₹802.33', after.subtotal === 802.33)
    check('the ₹100 discount survives the round trip', after.discount === 100)
    check('taxable value ₹702.33', after.taxableValue === 702.33)
    // ₹5.25 of GST on this group. The halves are NOT 2.63 + 2.63: priceBill
    // rounds the half ONCE and gives the remainder to SGST, so they sum to the
    // tax exactly rather than a paisa over it.
    check('GST is charged on the DISCOUNTED value: 5% group 2.63 + 2.62',
      after.taxBreakup[1].percent === 5 && after.taxBreakup[1].cgst === 2.63 && after.taxBreakup[1].sgst === 2.62)
    check('…and the halves sum to the group tax exactly',
      Math.round((after.taxBreakup[1].cgst + after.taxBreakup[1].sgst) * 100) === 525)
    check('…18% group 11.74 + 11.74',
      after.taxBreakup[2].percent === 18 && after.taxBreakup[2].cgst === 11.74 && after.taxBreakup[2].sgst === 11.74)
    check('GST total ₹28.73, not the ₹32.82 of an undiscounted re-price', after.taxTotal === 28.73)
    check('grand total ₹731.06, not ₹833.82', after.total === 731.06)
  }

  // ══ 2. the same bill with no discount ════════════════════════════════════
  console.log('\n── no discount ──')
  {
    const bookingId = await makeBooking(120, [
      { name: 'Fries', qty: 2, price: '99.00', tax: '5.00' },
    ])
    const v = await fourViews(bookingId)
    const { before, written, after, receipt, settlement } = await v.issue(0)

    check('preview === charged', samePricing(before, written))
    check('issued view === charged', samePricing(after, written))
    check('receipt === charged', samePricing(receiptAsPricing(receipt), written))
    check('panel total === charged', settlement.total === written.total)
    check('subtotal ₹998.00 with nothing off', after.subtotal === 998 && after.discount === 0)
    check('taxable value equals the subtotal', after.taxableValue === after.subtotal)
  }

  // ══ 3. a promo code ══════════════════════════════════════════════════════
  // The preview prices the code through previewPromoForBooking (what the Apply
  // button calls), so "what the till showed" is what is compared here.
  console.log('\n── a 10% promo code ──')
  {
    const { previewPromoForBooking } = await import('../lib/billing/data')
    await owner.query(
      `insert into promo_codes (tenant_id,code,discount_type,discount_value,valid_from,valid_until,is_active)
       values ($1,'CONSIST10','percentage','10.00',now() - interval '1 day',now() + interval '1 day',true)`,
      [tenantId])

    const bookingId = await makeBooking(90, [
      { name: 'Nachos', qty: 1, price: '210.00', tax: '18.00' },
    ])
    const ctx = {
      user: { id: userId, email: 'owner@testbillcons.test', fullName: null, isPlatformAdmin: false },
      tenant: { id: tenantId, slug: 'testbillcons', name: 'testbillcons co', industry: 'gaming',
        status: 'active', currency: 'INR', timezone: TZ },
      role: 'owner' as const,
      membershipId: '',
      branchId,
    }
    const quoted = await previewPromoForBooking(ctx, bookingId, 'CONSIST10')
    check('the till quotes ₹81.00 off (10% of ₹810)', quoted.ok && quoted.discount === 81)

    const v = await fourViews(bookingId, { promoCode: 'CONSIST10' })
    const { before, written, after, receipt, settlement } = await v.issue(
      quoted.ok ? quoted.discount : 0,
    )
    check('the quoted preview matches what is charged', samePricing(before, written))
    check('issued view === charged', samePricing(after, written))
    check('receipt === charged', samePricing(receiptAsPricing(receipt), written))
    check('panel total === charged', settlement.total === written.total)
    check('the receipt names the code and its ₹81.00',
      receipt.invoice.promoCode === 'CONSIST10' && receipt.invoice.promoDiscount === '81.00')
  }

  await owner.end()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
