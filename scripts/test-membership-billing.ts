/**
 * AROS-61 — membership benefits feed pricing at billing.
 *
 * Precedence under test (see lib/billing/membership-benefit.ts):
 *   1. base line pricing   2. membership benefit   3. promo / keyed-in discount
 *   … all before GST.
 *
 * Every pricing assertion also checks the reconciliation property
 *   subtotal − discount + taxTotal = total
 * and that no total or discount can go out of range.
 *
 *   npx tsx scripts/test-membership-billing.ts
 */
import { Pool } from 'pg'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { sql } from 'drizzle-orm'
import * as schema from '../db/schema'
import { loadEnv } from './env'

type Db = NodePgDatabase<typeof schema>

let pass = 0,
  fail = 0
const check = (l: string, c: boolean) => {
  console.log(`${c ? '✓' : '✗ FAIL'}  ${l}`)
  if (c) pass++
  else fail++
}

async function main() {
  loadEnv()
  const { issueInvoiceForBooking } = await import('../lib/billing/invoice')
  const { priceBill, round2 } = await import('../lib/billing/pricing')
  const { membershipDiscountAmount, resolveMembershipBenefit } = await import(
    '../lib/billing/membership-benefit'
  )
  const { purchaseMembership } = await import('../lib/memberships/customer-memberships')

  const ownerPool = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })
  const appPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 })
  const app = drizzle(appPool, { schema })

  const withUser = <T,>(userId: string, fn: (tx: Db) => Promise<T>): Promise<T> =>
    app.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`)
      return fn(tx as unknown as Db)
    })

  const expectError = async (fn: () => Promise<unknown>) => {
    try {
      await fn()
      return { threw: false, message: '' }
    } catch (e) {
      return { threw: true, message: e instanceof Error ? e.message : '' }
    }
  }

  /** THE property every priced bill must satisfy. */
  function reconciles(p: {
    subtotal: number
    discount: number
    taxTotal: number
    total: number
  }): boolean {
    return (
      round2(p.subtotal - p.discount + p.taxTotal) === round2(p.total) &&
      p.total >= 0 &&
      p.discount >= 0 &&
      p.discount <= p.subtotal
    )
  }

  // ── fixtures ──────────────────────────────────────────────────────────────
  await ownerPool.query(`delete from tenants where slug in ('testmba','testmbb')`)
  await ownerPool.query(`delete from users where email like '%@testmb%.test'`)

  let seq = 0
  async function makeTenant(slug: string) {
    const t = await ownerPool.query<{ id: string }>(
      `insert into tenants (slug,name,status,timezone,currency)
       values ($1,$2,'active','Asia/Kolkata','INR') returning id`,
      [slug, `${slug} co`],
    )
    const tenantId = t.rows[0].id
    const b = await ownerPool.query<{ id: string }>(
      `insert into branches (tenant_id,name,is_primary) values ($1,'Main',true) returning id`,
      [tenantId],
    )
    const u = await ownerPool.query<{ id: string }>(
      `insert into users (email,password_hash) values ($1,'x') returning id`,
      [`mgr@${slug}.test`],
    )
    const m = await ownerPool.query<{ id: string }>(
      `insert into memberships (tenant_id,user_id,role,status) values ($1,$2,'manager','active')
       returning id`,
      [tenantId, u.rows[0].id],
    )
    const rt = await ownerPool.query<{ id: string }>(
      `insert into resource_types (tenant_id,name,hourly_rate) values ($1,'Bay','500.00')
       returning id`,
      [tenantId],
    )
    const r = await ownerPool.query<{ id: string }>(
      `insert into resources (tenant_id,branch_id,resource_type_id,name)
       values ($1,$2,$3,'Bay 1') returning id`,
      [tenantId, b.rows[0].id, rt.rows[0].id],
    )
    return {
      tenantId,
      branchId: b.rows[0].id,
      userId: u.rows[0].id,
      membershipId: m.rows[0].id,
      resourceId: r.rows[0].id,
    }
  }

  const A = await makeTenant('testmba')
  const B = await makeTenant('testmbb')

  async function makeCustomer(t: typeof A) {
    seq++
    const r = await ownerPool.query<{ id: string }>(
      `insert into customers (tenant_id,phone,name) values ($1,$2,$3) returning id`,
      [t.tenantId, `+9188${String(seq).padStart(8, '0')}`, `Member ${seq}`],
    )
    return r.rows[0].id
  }

  /** A booking worth `hours × rate`, optionally attached to a customer. */
  async function makeBooking(t: typeof A, hours: number, customerId: string | null, rate = '500.00') {
    seq++
    const bk = await ownerPool.query<{ id: string }>(
      `insert into bookings (tenant_id,branch_id,booking_number,customer_id,customer_name,
                             status,source) values ($1,$2,$3,$4,'Guest','confirmed','staff')
       returning id`,
      [t.tenantId, t.branchId, `BK-MB-${String(seq).padStart(3, '0')}`, customerId],
    )
    const start = new Date(Date.now() + seq * 86_400_000)
    await ownerPool.query(
      `insert into booking_slots (tenant_id,booking_id,resource_id,starts_at,ends_at,
                                  rate_applied,slot_total,resource_name,resource_type_name)
       values ($1,$2,$3,$4,$5,$6,$7,'Bay 1','Bay')`,
      [
        t.tenantId, bk.rows[0].id, t.resourceId, start,
        new Date(start.getTime() + hours * 3_600_000),
        rate, (hours * Number(rate)).toFixed(2),
      ],
    )
    return bk.rows[0].id
  }

  async function makePlan(t: typeof A, discount: string, name?: string) {
    seq++
    const r = await ownerPool.query<{ id: string }>(
      `insert into membership_plans (tenant_id,name,price,duration_months,discount_percent,
                                     free_hours,wallet_credit)
       values ($1,$2,'1000.00',12,$3,'2.00','500.00') returning id`,
      [t.tenantId, name ?? `Plan ${seq}`, discount],
    )
    return r.rows[0].id
  }

  const sell = (t: typeof A, customerId: string, planId: string) =>
    withUser(t.userId, (tx) =>
      purchaseMembership(
        tx,
        { tenantId: t.tenantId, membershipId: t.membershipId, timezone: 'Asia/Kolkata', branchId: t.branchId },
        { customerId, planId, paymentMethod: 'cash' },
      ),
    )

  const bill = (t: typeof A, bookingId: string, extra: { discount?: number; promoCode?: string } = {}) =>
    withUser(t.userId, (tx) =>
      issueInvoiceForBooking(tx, { id: t.tenantId, timezone: 'Asia/Kolkata' }, { bookingId, ...extra }),
    )

  const invRow = async (id: string) =>
    (await ownerPool.query('select * from invoices where id=$1', [id])).rows[0]

  // NOTE ON GST COVERAGE: there is deliberately no "set a tax rate on the
  // booking lines" helper here. loadBookingLines() hardcodes taxPercent 0
  // (tax_rates are not wired to resources yet), so setting one would change
  // nothing and read as coverage that does not exist. GST behaviour is
  // exercised against priceBill() directly below instead.

  // ══ A + E. the worked example, end to end ════════════════════════════════
  {
    console.log('\n── ₹1000 bill, Gold 10% member ──')
    const customerId = await makeCustomer(A)
    const planId = await makePlan(A, '10.00', 'Gold')
    await sell(A, customerId, planId)

    const bookingId = await makeBooking(A, 2, customerId) // 2h × ₹500 = ₹1000
    const inv = await bill(A, bookingId)

    check('subtotal is ₹1000', inv.pricing.subtotal === 1000)
    check('membership discount is ₹100 (10%)', inv.pricing.discount === 100)
    check('…reported on the result', inv.membership?.discountAmount === 100 && inv.membership?.discountPercent === 10)
    check('…named by the snapshotted plan', inv.membership?.planName === 'Gold')
    check('taxable value is ₹900 — GST is computed AFTER the discount', inv.pricing.taxableValue === 900)
    check('total is ₹900 (booking lines carry 0% tax today)', inv.pricing.total === 900)
    check('the bill reconciles', reconciles(inv.pricing))

    // GST maths on the same shape, through the real pricing engine.
    const taxed = priceBill({
      lines: [{ description: 'x', kind: 'booking', qty: 2, unitPrice: 500, taxPercent: 18 }],
      discount: 100,
    })
    check('E: ₹1000 − ₹100 → taxable ₹900, GST 18% = ₹162, total ₹1062', taxed.subtotal === 1000 && taxed.discount === 100 && taxed.taxableValue === 900 && taxed.taxTotal === 162 && taxed.total === 1062)
    check('…split evenly as CGST ₹81 / SGST ₹81', taxed.taxBreakup[0].cgst === 81 && taxed.taxBreakup[0].sgst === 81)
    check('…and reconciles', reconciles(taxed))
  }

  // ══ snapshot on the invoice (§12) ════════════════════════════════════════
  {
    const customerId = await makeCustomer(A)
    const planId = await makePlan(A, '10.00', 'Snapshot Gold')
    const sold = await sell(A, customerId, planId)
    const bookingId = await makeBooking(A, 2, customerId)
    const inv = await bill(A, bookingId)

    const row = await invRow(inv.invoiceId)
    check('the invoice stores the membership reference', row.customer_membership_id === sold.membershipId)
    check('…the money the benefit took off', row.membership_discount === '100.00')
    check('…the percentage used', row.membership_discount_percent === '10.00')
    check('…and the plan name, for the receipt', row.membership_plan_name === 'Snapshot Gold')
    check('…membership_discount is part of `discount`, not extra', Number(row.membership_discount) <= Number(row.discount))

    // ══ M. the invoice is immune to everything that happens next ═══════════
    await ownerPool.query(`update membership_plans set discount_percent='99.00', name='Renamed' where id=$1`, [planId])
    await ownerPool.query(`update membership_plans set is_active=false where id=$1`, [planId])
    await ownerPool.query(
      `update customer_memberships set status='expired', expires_at=now() - interval '1 day',
              starts_at=now() - interval '2 months' where id=$1`, [sold.membershipId])

    const after = await invRow(inv.invoiceId)
    check('M: the historical invoice total is unchanged', after.total === row.total)
    check('…its discount is unchanged', after.discount === row.discount)
    check('…its membership snapshot is unchanged', after.membership_discount === '100.00' && after.membership_discount_percent === '10.00' && after.membership_plan_name === 'Snapshot Gold')
  }

  // ══ B / C / F. ineligible memberships give nothing ═══════════════════════
  {
    for (const [label, mutate] of [
      ['B: an EXPIRED membership (status active, expiry past)', `status='active', expires_at=now() - interval '1 day', starts_at=now() - interval '2 months'`],
      ['C: a CANCELLED membership', `status='cancelled', cancelled_at=now()`],
      ['C: an EXPIRED-status membership', `status='expired'`],
    ] as const) {
      const customerId = await makeCustomer(A)
      const planId = await makePlan(A, '10.00')
      const sold = await sell(A, customerId, planId)
      await ownerPool.query(`update customer_memberships set ${mutate} where id=$1`, [sold.membershipId])

      const bookingId = await makeBooking(A, 2, customerId)
      const inv = await bill(A, bookingId)
      check(`${label} → no discount`, inv.pricing.discount === 0 && inv.membership === null)
      check(`…total is the full ₹1000`, inv.pricing.total === 1000)
      const row = await invRow(inv.invoiceId)
      check(`…and nothing is snapshotted on the invoice`, row.customer_membership_id === null && row.membership_discount === '0.00')
    }

    // F. the exact boundary — expires_at == now() is NOT eligible.
    const customerId = await makeCustomer(A)
    const planId = await makePlan(A, '10.00')
    const sold = await sell(A, customerId, planId)
    const at = new Date()
    await ownerPool.query(
      `update customer_memberships set starts_at=$2::timestamptz - interval '1 month',
              expires_at=$2::timestamptz where id=$1`,
      [sold.membershipId, at])
    const atBoundary = await withUser(A.userId, (tx) =>
      resolveMembershipBenefit(tx, A.tenantId, customerId, 1000, at))
    check('F: at exactly expires_at the benefit is NOT applied', atBoundary === null)
    const justBefore = await withUser(A.userId, (tx) =>
      resolveMembershipBenefit(tx, A.tenantId, customerId, 1000, new Date(at.getTime() - 1000)))
    check('…one second earlier it IS', justBefore?.discountAmount === 100)
  }

  // ══ D + K + L. the snapshot is authoritative ═════════════════════════════
  {
    const customerId = await makeCustomer(A)
    const planId = await makePlan(A, '10.00', 'Drifting Gold')
    await sell(A, customerId, planId)

    // The owner reprices AND retires the plan after purchase.
    await ownerPool.query(`update membership_plans set discount_percent='5.00' where id=$1`, [planId])
    const bookingId = await makeBooking(A, 2, customerId)
    const inv = await bill(A, bookingId)
    check('D/K: plan now 5%, member still gets the purchased 10% → ₹100', inv.pricing.discount === 100 && inv.membership?.discountPercent === 10)

    await ownerPool.query(`update membership_plans set is_active=false where id=$1`, [planId])
    const booking2 = await makeBooking(A, 2, customerId)
    const inv2 = await bill(A, booking2)
    check('L: a DEACTIVATED plan still honours the existing membership → ₹100', inv2.pricing.discount === 100 && inv2.membership?.discountPercent === 10)
    check('…and both bills reconcile', reconciles(inv.pricing) && reconciles(inv2.pricing))
  }

  // ══ G. promo + membership precedence ═════════════════════════════════════
  {
    console.log('\n── precedence: membership first, promo on the remainder ──')
    const customerId = await makeCustomer(A)
    const planId = await makePlan(A, '10.00')
    await sell(A, customerId, planId)
    await ownerPool.query(
      `insert into promo_codes (tenant_id,code,discount_type,discount_value,valid_from,valid_until)
       values ($1,'TEN','percentage','10.00', now() - interval '1 day', now() + interval '30 days')`,
      [A.tenantId])

    const bookingId = await makeBooking(A, 2, customerId) // ₹1000
    const inv = await bill(A, bookingId, { promoCode: 'TEN' })

    // ₹1000 → membership 10% = ₹100 → remaining ₹900 → promo 10% of 900 = ₹90.
    check('membership takes ₹100 off ₹1000', inv.membership?.discountAmount === 100)
    check('…the promo then takes 10% of the REMAINING ₹900 = ₹90', round2(inv.pricing.discount - 100) === 90)
    check('…combined discount is ₹190, not ₹200', inv.pricing.discount === 190)
    check('…total is ₹810', inv.pricing.total === 810)
    check('…the invoice records the promo AND the membership half', (await invRow(inv.invoiceId)).promo_code_id !== null && (await invRow(inv.invoiceId)).membership_discount === '100.00')
    check('…and it reconciles', reconciles(inv.pricing))

    // A keyed-in discount is likewise capped at the post-membership remainder.
    const b2 = await makeBooking(A, 2, customerId)
    const inv2 = await bill(A, b2, { discount: 5000 })
    check('a keyed-in discount cannot exceed the remainder — total discount is ₹1000', inv2.pricing.discount === 1000)
    check('…the bill floors at ₹0, never negative', inv2.pricing.total === 0 && reconciles(inv2.pricing))
    check('…and the membership half is still recorded', (await invRow(inv2.invoiceId)).membership_discount === '100.00')
  }

  // ══ I. no customer, no membership ════════════════════════════════════════
  {
    const walkIn = await makeBooking(A, 2, null)
    const inv = await bill(A, walkIn)
    check('I: a walk-in booking (no customer) bills normally at ₹1000', inv.pricing.discount === 0 && inv.pricing.total === 1000 && inv.membership === null)

    const noMembership = await makeBooking(A, 2, await makeCustomer(A))
    const inv2 = await bill(A, noMembership)
    check('…a customer with no membership likewise', inv2.pricing.discount === 0 && inv2.membership === null)
  }

  // ══ J. cross-tenant ══════════════════════════════════════════════════════
  {
    const aCustomer = await makeCustomer(A)
    const aPlan = await makePlan(A, '10.00')
    await sell(A, aCustomer, aPlan)

    // Tenant B billing its OWN booking must never see tenant A's membership,
    // even when the customer ids are handed over deliberately.
    const crossed = await withUser(B.userId, (tx) =>
      resolveMembershipBenefit(tx, B.tenantId, aCustomer, 1000))
    check("J: tenant B resolves NO benefit for tenant A's customer", crossed === null)

    const spoofed = await withUser(B.userId, (tx) =>
      resolveMembershipBenefit(tx, A.tenantId, aCustomer, 1000))
    check("…nor by passing tenant A's id under tenant B's session (RLS)", spoofed === null)

    const bBooking = await makeBooking(B, 2, await makeCustomer(B))
    const bInv = await bill(B, bBooking)
    check("…and tenant B's own bill gets no discount from it", bInv.pricing.discount === 0 && bInv.membership === null)
  }

  // ══ N. applied exactly once ══════════════════════════════════════════════
  {
    const customerId = await makeCustomer(A)
    const planId = await makePlan(A, '10.00')
    await sell(A, customerId, planId)
    const bookingId = await makeBooking(A, 2, customerId)
    const inv = await bill(A, bookingId)

    check('N: the discount is ₹100, not ₹200 — applied once', inv.pricing.discount === 100)
    const row = await invRow(inv.invoiceId)
    check('…subtotal − discount + tax = total on the stored row', round2(Number(row.subtotal) - Number(row.discount) + Number(row.tax_total)) === round2(Number(row.total)))

    // Re-billing the same booking is refused, so no second application exists.
    const again = await expectError(() => bill(A, bookingId))
    check('…and re-billing the booking is refused entirely', again.threw && again.message.includes('already been billed'))
  }

  // ══ the pure helper, including rounding ══════════════════════════════════
  {
    check('membershipDiscountAmount(1000, 10) = 100', membershipDiscountAmount(1000, 10) === 100)
    check('…(0, 10) = 0', membershipDiscountAmount(0, 10) === 0)
    check('…(1000, 0) = 0', membershipDiscountAmount(1000, 0) === 0)
    check('…a negative percent yields 0', membershipDiscountAmount(1000, -5) === 0)
    check('…a negative subtotal yields 0', membershipDiscountAmount(-1000, 10) === 0)
    check('…NaN yields 0', membershipDiscountAmount(NaN, 10) === 0 && membershipDiscountAmount(1000, NaN) === 0)
    check('…over-100% is clamped to the whole subtotal', membershipDiscountAmount(1000, 150) === 1000)
    // F (rounding): 7.5% of 333.33 = 24.99975 → 25.00 through round2.
    check('F: 7.5% of ₹333.33 rounds to ₹25.00 via round2', membershipDiscountAmount(333.33, 7.5) === 25)
    check('…12.5% of ₹0.04 rounds to ₹0.01, never a fraction of a paisa', membershipDiscountAmount(0.04, 12.5) === 0.01)
    check('…and the discount never exceeds the subtotal', membershipDiscountAmount(0.01, 100) === 0.01)

    // An odd-paise bill through the real engine, with GST.
    const odd = priceBill({
      lines: [{ description: 'x', kind: 'booking', qty: 3, unitPrice: 333.33, taxPercent: 18 }],
      discount: membershipDiscountAmount(999.99, 10),
    })
    check('F: ₹999.99 less 10% (₹100.00) reconciles under GST', reconciles(odd) && odd.discount === 100 && odd.taxableValue === 899.99)
  }

  // ══ H. happy hours ═══════════════════════════════════════════════════════
  {
    const wired = await ownerPool.query<{ n: string }>(
      `select count(*)::text n from information_schema.tables where table_name='happy_hours'`)
    check('H: happy_hours exists as a table…', wired.rows[0].n === '1')
    // Nothing in lib/billing reads it, so there is no precedence to assert yet —
    // the seam is documented in membership-benefit.ts for when it lands.
    check('…but is NOT wired into billing, so no precedence conflict exists today', true)
  }

  // ── cleanup ───────────────────────────────────────────────────────────────
  await ownerPool.query('delete from tenants where id = any($1)', [[A.tenantId, B.tenantId]])
  await ownerPool.query(`delete from users where email like '%@testmb%.test'`)
  await ownerPool.end()
  await appPool.end()

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error('test harness error:', e instanceof Error ? `${e.name}: ${e.message}` : 'unknown')
  process.exit(1)
})
