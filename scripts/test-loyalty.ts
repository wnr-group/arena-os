/**
 * Loyalty points — earn at settlement, redeem at billing.
 *
 * THE invariant, asserted after every operation:
 *
 *     loyaltyPoints(customer) === sum(loyalty_transactions.points)
 *     and it is never negative
 *
 * No points column exists; every assertion re-derives from the ledger.
 *
 *   npx tsx scripts/test-loyalty.ts
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
  const {
    pointsForSpend,
    discountForPoints,
    eligibleSpendFor,
    loadLoyaltyRule,
    awardPointsForSettledInvoice,
    LOYALTY_SOURCE,
    DEFAULT_LOYALTY_RULE,
  } = await import('../lib/billing/loyalty')
  const { loyaltyPoints } = await import('../lib/customers/ledger')
  const { issueInvoiceForBooking } = await import('../lib/billing/invoice')
  const { recordPaymentForInvoice, getInvoiceSettlement } = await import(
    '../lib/billing/payments'
  )
  const { recordRefund, voidInvoiceRecord } = await import('../lib/billing/refunds')
  const { round2 } = await import('../lib/billing/pricing')

  const ownerPool = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })
  const appPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 })
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

  // ── fixtures ──────────────────────────────────────────────────────────────
  await ownerPool.query(`delete from tenants where slug in ('testlya','testlyb')`)
  await ownerPool.query(`delete from users where email like '%@testly%.test'`)

  let seq = 0
  async function makeTenant(slug: string) {
    const t = await ownerPool.query<{ id: string }>(
      `insert into tenants (slug,name,status,timezone,currency)
       values ($1,$2,'active','Asia/Kolkata','INR') returning id`, [slug, `${slug} co`])
    const tenantId = t.rows[0].id
    const b = await ownerPool.query<{ id: string }>(
      `insert into branches (tenant_id,name,is_primary) values ($1,'Main',true) returning id`, [tenantId])
    const u = await ownerPool.query<{ id: string }>(
      `insert into users (email,password_hash) values ($1,'x') returning id`, [`m@${slug}.test`])
    const m = await ownerPool.query<{ id: string }>(
      `insert into memberships (tenant_id,user_id,role,status) values ($1,$2,'manager','active')
       returning id`, [tenantId, u.rows[0].id])
    const rt = await ownerPool.query<{ id: string }>(
      `insert into resource_types (tenant_id,name,hourly_rate) values ($1,'Bay','500.00') returning id`, [tenantId])
    const r = await ownerPool.query<{ id: string }>(
      `insert into resources (tenant_id,branch_id,resource_type_id,name)
       values ($1,$2,$3,'Bay 1') returning id`, [tenantId, b.rows[0].id, rt.rows[0].id])
    return { tenantId, branchId: b.rows[0].id, userId: u.rows[0].id,
             membershipId: m.rows[0].id, resourceId: r.rows[0].id }
  }

  const A = await makeTenant('testlya')
  const B = await makeTenant('testlyb')

  async function makeCustomer(t: typeof A) {
    const n = ++seq
    const r = await ownerPool.query<{ id: string }>(
      `insert into customers (tenant_id,phone,name) values ($1,$2,$3) returning id`,
      [t.tenantId, `+9166${String(n).padStart(8, '0')}`, `Loyal ${n}`])
    return r.rows[0].id
  }

  /** A booking worth `hours × rate`. */
  async function makeBooking(t: typeof A, hours: number, customerId: string | null, rate = '500.00') {
    const n = ++seq
    const bk = await ownerPool.query<{ id: string }>(
      `insert into bookings (tenant_id,branch_id,booking_number,customer_id,customer_name,
                             status,source) values ($1,$2,$3,$4,'Guest','confirmed','staff') returning id`,
      [t.tenantId, t.branchId, `BK-LY-${String(n).padStart(3, '0')}`, customerId])
    const start = new Date(Date.now() + n * 86_400_000)
    await ownerPool.query(
      `insert into booking_slots (tenant_id,booking_id,resource_id,starts_at,ends_at,
                                  rate_applied,slot_total,resource_name,resource_type_name)
       values ($1,$2,$3,$4,$5,$6,$7,'Bay 1','Bay')`,
      [t.tenantId, bk.rows[0].id, t.resourceId, start,
       new Date(start.getTime() + hours * 3_600_000), rate, (hours * Number(rate)).toFixed(2)])
    return bk.rows[0].id
  }

  const bill = (t: typeof A, bookingId: string, extra: { discount?: number; promoCode?: string; redeemPoints?: number } = {}) =>
    withUser(t.userId, (tx) =>
      issueInvoiceForBooking(tx, { id: t.tenantId, timezone: 'Asia/Kolkata' }, { bookingId, ...extra }))

  const settle = (t: typeof A, invoiceId: string, amount: number) =>
    withUser(t.userId, (tx) =>
      recordPaymentForInvoice(tx, { tenantId: t.tenantId, membershipId: t.membershipId },
        { invoiceId, method: 'cash', amount }))

  const pointsOf = (t: typeof A, customerId: string) =>
    withUser(t.userId, (tx) => loyaltyPoints(t.tenantId ? tx : tx, t.tenantId, customerId))

  const rawPoints = async (customerId: string) =>
    Number((await ownerPool.query(
      `select coalesce(sum(points),0)::text n from loyalty_transactions where customer_id=$1`,
      [customerId])).rows[0].n)

  /** THE ledger invariant. */
  async function ledgerHolds(t: typeof A, customerId: string, expected: number) {
    const derived = await pointsOf(t, customerId)
    const raw = await rawPoints(customerId)
    return derived === expected && raw === expected && derived >= 0
  }

  const invRow = async (id: string) =>
    (await ownerPool.query('select * from invoices where id=$1', [id])).rows[0]

  // ══ 1. no mutable points column; the rule ════════════════════════════════
  {
    const cols = await ownerPool.query(
      `select column_name from information_schema.columns
        where table_schema='public'
          and column_name in ('loyalty_points','points_balance','current_points')`)
    check('no loyalty_points / points_balance / current_points column exists', cols.rows.length === 0)

    const rule = await withUser(A.userId, (tx) => loadLoyaltyRule(tx, A.tenantId))
    check('an unconfigured tenant gets the documented defaults (1 pt / ₹100, ₹1 each)',
      rule.pointsPerUnit === 1 && rule.unitAmount === 100 && rule.pointValue === 1 && rule.isActive)
    check('…matching DEFAULT_LOYALTY_RULE', JSON.stringify(rule) === JSON.stringify(DEFAULT_LOYALTY_RULE))
  }

  // ══ 2. the earn rule, as a pure function ═════════════════════════════════
  {
    const r = DEFAULT_LOYALTY_RULE
    check('₹1000 → 10 points', pointsForSpend(1000, r) === 10)
    check('₹999 → 9 points (floored, never rounded up)', pointsForSpend(999, r) === 9)
    check('₹99.99 → 0 points', pointsForSpend(99.99, r) === 0)
    check('₹100 → 1 point exactly at the boundary', pointsForSpend(100, r) === 1)
    check('₹0 → 0', pointsForSpend(0, r) === 0)
    check('a negative spend → 0', pointsForSpend(-500, r) === 0)
    check('NaN → 0', pointsForSpend(NaN, r) === 0)
    check('points are always integers', Number.isInteger(pointsForSpend(1234.56, r)))
    check('an inactive programme earns nothing', pointsForSpend(1000, { ...r, isActive: false }) === 0)

    const custom = { ...r, pointsPerUnit: 5, unitAmount: 250 }
    check('a custom rule (5 pts / ₹250): ₹1000 → 20', pointsForSpend(1000, custom) === 20)
    check('…₹749 → 10', pointsForSpend(749, custom) === 10)

    check('100 points are worth ₹100 at the default rate', discountForPoints(100, r) === 100)
    check('…₹2.50 each → ₹250', discountForPoints(100, { ...r, pointValue: 2.5 }) === 250)
    check('eligibleSpendFor = subtotal − discount (the taxable value)',
      eligibleSpendFor({ subtotal: '1000.00', discount: '100.00' }) === 900)
  }

  // ══ 3. earning at settlement ═════════════════════════════════════════════
  {
    console.log('\n── earn: ₹1000 bill, settled → +10 points ──')
    const customerId = await makeCustomer(A)
    check('a new customer starts at 0', await ledgerHolds(A, customerId, 0))

    const bookingId = await makeBooking(A, 2, customerId) // 2h × ₹500 = ₹1000
    const inv = await bill(A, bookingId)
    check('raising the bill earns NOTHING yet — it is not paid', await ledgerHolds(A, customerId, 0))
    check('…the invoice is issued, not paid', (await invRow(inv.invoiceId)).status === 'issued')

    await settle(A, inv.invoiceId, 1000)
    check('settling it earns 10 points', await ledgerHolds(A, customerId, 10))
    check('…the invoice is paid', (await invRow(inv.invoiceId)).status === 'paid')
    check('…and the earn is snapshotted on the invoice', (await invRow(inv.invoiceId)).loyalty_points_earned === 10)

    const led = (await ownerPool.query(
      `select * from loyalty_transactions where customer_id=$1`, [customerId])).rows
    check('…as ONE credit referencing the invoice', led.length === 1 && led[0].points === 10 &&
      led[0].source_type === LOYALTY_SOURCE.earn && led[0].source_id === inv.invoiceId)
  }

  // ══ 4. no double-earn ════════════════════════════════════════════════════
  {
    const customerId = await makeCustomer(A)
    const bookingId = await makeBooking(A, 2, customerId)
    const inv = await bill(A, bookingId)
    await settle(A, inv.invoiceId, 1000)
    check('first settlement → 10 points', await ledgerHolds(A, customerId, 10))

    // Re-running the award directly is the strongest form of the test.
    const again = await withUser(A.userId, (tx) =>
      awardPointsForSettledInvoice(tx, A.tenantId, inv.invoiceId))
    check('re-awarding the same invoice grants 0', again === 0)
    check('…the balance is unchanged at 10', await ledgerHolds(A, customerId, 10))

    // Concurrently, too.
    const results = await Promise.allSettled([1, 2, 3, 4].map(() =>
      withUser(A.userId, (tx) => awardPointsForSettledInvoice(tx, A.tenantId, inv.invoiceId))))
    check('four concurrent re-awards grant nothing', results.every((r) => r.status === 'fulfilled' && r.value === 0))
    check('…still exactly 10', await ledgerHolds(A, customerId, 10))

    // The DB index is the real guarantee.
    let blocked = false
    try {
      await ownerPool.query(
        `insert into loyalty_transactions (tenant_id,customer_id,points,source_type,source_id)
         values ($1,$2,10,$3,$4)`, [A.tenantId, customerId, LOYALTY_SOURCE.earn, inv.invoiceId])
    } catch { blocked = true }
    check('a duplicate (tenant, purpose, source) row is refused by the unique index', blocked)
  }

  // ══ 5. no points for unpaid / void ═══════════════════════════════════════
  {
    const customerId = await makeCustomer(A)
    const bookingId = await makeBooking(A, 2, customerId)
    const inv = await bill(A, bookingId)
    await settle(A, inv.invoiceId, 400) // partial
    check('a PARTLY paid invoice earns nothing', await ledgerHolds(A, customerId, 0))
    check('…it is still issued', (await invRow(inv.invoiceId)).status === 'issued')
    await settle(A, inv.invoiceId, 600)
    check('…completing it earns 10', await ledgerHolds(A, customerId, 10))

    // Void: refund first (the void path requires it), then strike off.
    const pays = (await ownerPool.query('select id, amount from payments where invoice_id=$1', [inv.invoiceId])).rows
    for (const p of pays) {
      await withUser(A.userId, (tx) => recordRefund(tx, { tenantId: A.tenantId, membershipId: A.membershipId },
        { paymentId: p.id, amount: Number(p.amount), reason: 'Test void' }))
    }
    await withUser(A.userId, (tx) => voidInvoiceRecord(tx, { tenantId: A.tenantId, membershipId: A.membershipId },
      { invoiceId: inv.invoiceId, reason: 'Test void' }))
    check('voiding the invoice REVERSES the 10 points', await ledgerHolds(A, customerId, 0))
    // The reversal is keyed to the REFUND that caused it, not the invoice —
    // reconcileInvoiceAfterRefund() owns the earn side now, so that many
    // partial refunds can each write one entry. Assert the total reversed for
    // this invoice rather than the id it happens to hang off.
    const reversedTotal = Number((await ownerPool.query(
      `select coalesce(sum(-lt.points),0)::text n
         from loyalty_transactions lt
        where lt.tenant_id=$1 and lt.customer_id=$2 and lt.source_type=$3`,
      [A.tenantId, customerId, LOYALTY_SOURCE.earnReversal])).rows[0].n)
    check('…as explicit reversal entries totalling 10, not a deletion', reversedTotal === 10)
    check('…and the invoice counter agrees', (await invRow(inv.invoiceId)).loyalty_points_reversed === 10)
    check('…and the earn credit is still on record', Number((await ownerPool.query(
      `select count(*)::int n from loyalty_transactions where source_type=$1 and source_id=$2`,
      [LOYALTY_SOURCE.earn, inv.invoiceId])).rows[0].n) === 1)

    const walkIn = await makeBooking(A, 2, null)
    const wInv = await bill(A, walkIn)
    await settle(A, wInv.invoiceId, 1000)
    check('a walk-in bill (no customer) earns nothing and does not error', (await invRow(wInv.invoiceId)).loyalty_points_earned === 0)
  }

  // ══ 5b. a WALLET TOP-UP must not earn — it would double-count ════════════
  {
    console.log('\n── top-up earns nothing; spending the credit does ──')
    const { topUpWallet, recordWalletPaymentForInvoice } = await import(
      '../lib/billing/wallet-payments'
    )
    const customerId = await makeCustomer(A)

    await withUser(A.userId, (tx) =>
      topUpWallet(tx, { tenantId: A.tenantId, membershipId: A.membershipId,
        timezone: 'Asia/Kolkata', branchId: A.branchId },
        { customerId, amount: 1000, method: 'cash' }))
    check('a ₹1000 wallet top-up earns ZERO points', await ledgerHolds(A, customerId, 0))

    const topUpInv = (await ownerPool.query(
      `select i.loyalty_points_earned e from invoices i
        join invoice_items li on li.invoice_id = i.id
       where i.tenant_id=$1 and li.kind='wallet_topup'`, [A.tenantId])).rows[0]
    check('…and the top-up invoice records 0 earned', topUpInv.e === 0)

    // Spending that same ₹1000 on a real bill DOES earn — once.
    const bookingId = await makeBooking(A, 2, customerId) // ₹1000
    const inv = await bill(A, bookingId)
    await withUser(A.userId, (tx) =>
      recordWalletPaymentForInvoice(tx, { tenantId: A.tenantId, membershipId: A.membershipId },
        { invoiceId: inv.invoiceId, amount: 1000 }))
    check('spending the credit on a ₹1000 bill earns 10 — once, not twice', await ledgerHolds(A, customerId, 10))

    // A MEMBERSHIP purchase is a genuine sale and DOES earn.
    const planId = (await ownerPool.query<{ id: string }>(
      `insert into membership_plans (tenant_id,name,price,duration_months,discount_percent,
                                     free_hours,wallet_credit)
       values ($1,'Earn Plan','2000.00',1,'0','0','0') returning id`, [A.tenantId])).rows[0].id
    const { purchaseMembership } = await import('../lib/memberships/customer-memberships')
    const buyer = await makeCustomer(A)
    await withUser(A.userId, (tx) => purchaseMembership(tx,
      { tenantId: A.tenantId, membershipId: A.membershipId, timezone: 'Asia/Kolkata', branchId: A.branchId },
      { customerId: buyer, planId, paymentMethod: 'cash' }))
    check('a ₹2000 membership purchase DOES earn 20 (a real sale)', await ledgerHolds(A, buyer, 20))
  }

  // ══ 6. redeeming ═════════════════════════════════════════════════════════
  {
    console.log('\n── redeem: 100 points → ₹100 off ──')
    const customerId = await makeCustomer(A)
    await ownerPool.query(
      `insert into loyalty_transactions (tenant_id,customer_id,points,reason,source_type)
       values ($1,$2,200,'seed','manual_adjustment')`, [A.tenantId, customerId])
    check('seeded with 200 points', await ledgerHolds(A, customerId, 200))

    const bookingId = await makeBooking(A, 2, customerId) // ₹1000
    const inv = await bill(A, bookingId, { redeemPoints: 100 })

    check('the bill is discounted by ₹100', inv.pricing.discount === 100)
    check('…subtotal ₹1000, taxable ₹900', inv.pricing.subtotal === 1000 && inv.pricing.taxableValue === 900)
    check('…total ₹900', inv.pricing.total === 900)
    check('…100 points were spent', inv.loyalty?.points === 100 && inv.loyalty?.discount === 100)
    check('…and DEBITED immediately (pricing is frozen at issue)', await ledgerHolds(A, customerId, 100))

    const row = await invRow(inv.invoiceId)
    check('the invoice snapshots the points redeemed', row.loyalty_points_redeemed === 100)
    check('…the discount', row.loyalty_discount === '100.00')
    check('…and the RATE honoured', row.loyalty_point_value === '1.00')
    check('…loyalty_discount is within the total discount', Number(row.loyalty_discount) <= Number(row.discount))

    // Earning is on the POST-discount taxable value, so redeeming does not re-earn.
    await settle(A, inv.invoiceId, 900)
    check('settling earns on ₹900 (post-discount) → 9, not 10', (await invRow(inv.invoiceId)).loyalty_points_earned === 9)
    check('…balance 100 − 0 + 9 = 109', await ledgerHolds(A, customerId, 109))

    const led = (await ownerPool.query(
      `select points, source_type from loyalty_transactions where customer_id=$1 order by created_at`,
      [customerId])).rows
    check('…ledger reads: +200 seed, −100 redeem, +9 earn', JSON.stringify(led.map((l) => l.points)) === '[200,-100,9]')
  }

  // ══ 7. redemption limits ═════════════════════════════════════════════════
  {
    const customerId = await makeCustomer(A)
    await ownerPool.query(
      `insert into loyalty_transactions (tenant_id,customer_id,points,source_type)
       values ($1,$2,100,'manual_adjustment')`, [A.tenantId, customerId])

    const b1 = await makeBooking(A, 2, customerId)
    const over = await expectError(() => bill(A, b1, { redeemPoints: 150 }))
    check('redeeming 150 of 100 points is REFUSED', over.threw && over.message.includes('Not enough points'))
    check('…the balance is untouched', await ledgerHolds(A, customerId, 100))
    check('…and NO invoice was created', Number((await ownerPool.query(
      'select count(*)::int n from invoices where booking_id=$1', [b1])).rows[0].n) === 0)

    // Exact balance.
    const b2 = await makeBooking(A, 2, customerId)
    const exact = await bill(A, b2, { redeemPoints: 100 })
    check('the EXACT balance can be redeemed', exact.loyalty?.points === 100)
    check('…leaving 0, never negative', await ledgerHolds(A, customerId, 0))

    const b3 = await makeBooking(A, 2, customerId)
    const empty = await expectError(() => bill(A, b3, { redeemPoints: 1 }))
    check('a further point is refused on an empty balance', empty.threw)
    check('…still 0', await ledgerHolds(A, customerId, 0))

    for (const bad of [0, -5]) {
      const b = await makeBooking(A, 2, customerId)
      const r = await expectError(() => bill(A, b, { redeemPoints: bad }))
      // 0 is treated as "no redemption" and simply bills normally.
      if (bad === 0) check('redeeming 0 points just bills normally', !r.threw)
      else check(`redeeming ${bad} points is refused`, r.threw)
    }
  }

  // ══ 8. capped at what is still owed ══════════════════════════════════════
  {
    const customerId = await makeCustomer(A)
    await ownerPool.query(
      `insert into loyalty_transactions (tenant_id,customer_id,points,source_type)
       values ($1,$2,5000,'manual_adjustment')`, [A.tenantId, customerId])

    const bookingId = await makeBooking(A, 1, customerId) // ₹500
    const inv = await bill(A, bookingId, { redeemPoints: 5000 })
    check('redeeming 5000 points against a ₹500 bill caps the discount at ₹500', inv.loyalty?.discount === 500)
    check('…and only 500 points are spent, not 5000', inv.loyalty?.points === 500)
    check('…balance 5000 − 500 = 4500', await ledgerHolds(A, customerId, 4500))
    check('…total is ₹0, never negative', inv.pricing.total === 0)
    check('…and the bill reconciles', round2(inv.pricing.subtotal - inv.pricing.discount + inv.pricing.taxTotal) === inv.pricing.total)
  }

  // ══ 9. PRECEDENCE: membership → promo → loyalty ══════════════════════════
  {
    console.log('\n── precedence: membership 10%, promo 10%, then points ──')
    const customerId = await makeCustomer(A)
    await ownerPool.query(
      `insert into loyalty_transactions (tenant_id,customer_id,points,source_type)
       values ($1,$2,1000,'manual_adjustment')`, [A.tenantId, customerId])

    const planId = (await ownerPool.query<{ id: string }>(
      `insert into membership_plans (tenant_id,name,price,duration_months,discount_percent,
                                     free_hours,wallet_credit)
       values ($1,'Gold LY','0.00',12,'10.00','0.00','0.00') returning id`, [A.tenantId])).rows[0].id
    const { purchaseMembership } = await import('../lib/memberships/customer-memberships')
    await withUser(A.userId, (tx) => purchaseMembership(tx,
      { tenantId: A.tenantId, membershipId: A.membershipId, timezone: 'Asia/Kolkata', branchId: A.branchId },
      { customerId, planId }))

    await ownerPool.query(
      `insert into promo_codes (tenant_id,code,discount_type,discount_value,valid_from,valid_until)
       values ($1,'LY10','percentage','10.00', now() - interval '1 day', now() + interval '30 days')`,
      [A.tenantId])

    const bookingId = await makeBooking(A, 2, customerId) // ₹1000
    const inv = await bill(A, bookingId, { promoCode: 'LY10', redeemPoints: 100 })

    // ₹1000 → membership 10% = ₹100 → ₹900 → promo 10% of 900 = ₹90 → ₹810
    //       → loyalty 100 pts = ₹100 → total discount ₹290, total ₹710
    check('membership takes ₹100', inv.membership?.discountAmount === 100)
    check('…promo takes ₹90 (10% of the remaining ₹900)', round2(inv.pricing.discount - 100 - 100) === 90)
    check('…loyalty takes ₹100 (of the remaining ₹810)', inv.loyalty?.discount === 100)
    check('…combined discount ₹290', inv.pricing.discount === 290)
    check('…total ₹710', inv.pricing.total === 710)
    check('…and it reconciles', round2(inv.pricing.subtotal - inv.pricing.discount + inv.pricing.taxTotal) === inv.pricing.total)

    const row = await invRow(inv.invoiceId)
    check('both halves are snapshotted separately', row.membership_discount === '100.00' && row.loyalty_discount === '100.00')
    check('…and each is within the total discount', Number(row.membership_discount) + Number(row.loyalty_discount) <= Number(row.discount))
    check('points were debited once', await ledgerHolds(A, customerId, 900))
  }

  // ══ 10. GST — the discount is before tax ═════════════════════════════════
  {
    const { priceBill } = await import('../lib/billing/pricing')
    const taxed = priceBill({
      lines: [{ description: 'x', kind: 'booking', qty: 2, unitPrice: 500, taxPercent: 18 }],
      discount: discountForPoints(100, DEFAULT_LOYALTY_RULE),
    })
    check('₹1000 − ₹100 points → taxable ₹900, GST ₹162, total ₹1062',
      taxed.taxableValue === 900 && taxed.taxTotal === 162 && taxed.total === 1062)
    check('…CGST ₹81 / SGST ₹81', taxed.taxBreakup[0].cgst === 81 && taxed.taxBreakup[0].sgst === 81)
    check('…GST is NOT computed on the undiscounted ₹1000', taxed.taxTotal !== 180)
  }

  // ══ 11. CONCURRENT redemption cannot overdraw ════════════════════════════
  {
    console.log('\n── concurrency: 100 points, simultaneous 80 and 50 ──')
    const customerId = await makeCustomer(A)
    await ownerPool.query(
      `insert into loyalty_transactions (tenant_id,customer_id,points,source_type)
       values ($1,$2,100,'manual_adjustment')`, [A.tenantId, customerId])

    const bA = await makeBooking(A, 2, customerId)
    const bB = await makeBooking(A, 2, customerId)
    const [ra, rb] = await Promise.allSettled([
      bill(A, bA, { redeemPoints: 80 }),
      bill(A, bB, { redeemPoints: 50 }),
    ])
    const wins = [ra, rb].filter((r) => r.status === 'fulfilled').length
    check('exactly ONE of the two simultaneous redemptions succeeds', wins === 1)
    const finalBalance = await pointsOf(A, customerId)
    check('…the balance is never negative', finalBalance >= 0)
    check('…and equals 100 minus whichever won', finalBalance === 100 - (ra.status === 'fulfilled' ? 80 : 50))
    check('…exactly one debit row exists', Number((await ownerPool.query(
      `select count(*)::int n from loyalty_transactions where customer_id=$1 and points < 0`,
      [customerId])).rows[0].n) === 1)

    // Harder: five at once against a balance covering two.
    const c2 = await makeCustomer(A)
    await ownerPool.query(
      `insert into loyalty_transactions (tenant_id,customer_id,points,source_type)
       values ($1,$2,200,'manual_adjustment')`, [A.tenantId, c2])
    const books = []
    for (let i = 0; i < 5; i++) books.push(await makeBooking(A, 2, c2))
    const many = await Promise.allSettled(books.map((b) => bill(A, b, { redeemPoints: 100 })))
    check('five concurrent 100-point redemptions against 200 → exactly TWO succeed',
      many.filter((r) => r.status === 'fulfilled').length === 2)
    check('…balance lands at exactly 0', await ledgerHolds(A, c2, 0))
  }

  // ══ 12. atomicity ════════════════════════════════════════════════════════
  {
    const customerId = await makeCustomer(A)
    await ownerPool.query(
      `insert into loyalty_transactions (tenant_id,customer_id,points,source_type)
       values ($1,$2,500,'manual_adjustment')`, [A.tenantId, customerId])
    const bookingId = await makeBooking(A, 2, customerId)

    const rolled = await expectError(() =>
      withUser(A.userId, async (tx) => {
        await issueInvoiceForBooking(tx, { id: A.tenantId, timezone: 'Asia/Kolkata' },
          { bookingId, redeemPoints: 100 })
        throw new Error('simulated downstream failure')
      }))
    check('a failure after the bill aborts the whole unit', rolled.threw)
    check('…NO invoice survives', Number((await ownerPool.query(
      'select count(*)::int n from invoices where booking_id=$1', [bookingId])).rows[0].n) === 0)
    check('…NO points were debited', await ledgerHolds(A, customerId, 500))

    const retry = await bill(A, bookingId, { redeemPoints: 100 })
    check('…a subsequent bill succeeds', retry.loyalty?.points === 100)
    check('…and debits once', await ledgerHolds(A, customerId, 400))
  }

  // ══ 13. tenant isolation ═════════════════════════════════════════════════
  {
    const aCustomer = await makeCustomer(A)
    await ownerPool.query(
      `insert into loyalty_transactions (tenant_id,customer_id,points,source_type)
       values ($1,$2,500,'manual_adjustment')`, [A.tenantId, aCustomer])

    const bSees = await withUser(B.userId, (tx) => tx.select().from(schema.loyaltyTransactions))
    check("tenant B sees none of tenant A's loyalty rows", bSees.every((r) => r.tenantId === B.tenantId))

    const crossRead = await withUser(B.userId, (tx) => loyaltyPoints(tx, B.tenantId, aCustomer))
    check("…and reads 0 points for tenant A's customer", crossRead === 0)

    const spoof = await withUser(B.userId, (tx) => loyaltyPoints(tx, A.tenantId, aCustomer))
    check("…even passing tenant A's id under B's session (RLS)", spoof === 0)

    // Tenant B billing its own booking cannot spend A's points.
    const bCustomer = await makeCustomer(B)
    const bBooking = await makeBooking(B, 2, bCustomer)
    const crossRedeem = await expectError(() =>
      withUser(B.userId, (tx) => issueInvoiceForBooking(tx, { id: B.tenantId, timezone: 'Asia/Kolkata' },
        { bookingId: bBooking, redeemPoints: 100 })))
    check("tenant B cannot redeem points it does not have", crossRedeem.threw)
    check("…tenant A's balance is untouched", await ledgerHolds(A, aCustomer, 500))

    let blocked = false
    try {
      await withUser(B.userId, (tx) => tx.insert(schema.loyaltyTransactions).values({
        tenantId: A.tenantId, customerId: aCustomer, points: 9999, sourceType: 'manual_adjustment' }))
    } catch { blocked = true }
    check('tenant B cannot insert a credit into tenant A', blocked)
  }

  // ══ 14. the §23 ledger sequence ══════════════════════════════════════════
  {
    console.log('\n── ledger: 0 → +10 → −5 → +5 → reject 11 ──')
    const customerId = await makeCustomer(A)
    check('0', await ledgerHolds(A, customerId, 0))

    const b1 = await makeBooking(A, 2, customerId) // ₹1000
    const i1 = await bill(A, b1)
    await settle(A, i1.invoiceId, 1000)
    check('₹1000 invoice settled → 10', await ledgerHolds(A, customerId, 10))

    const b2 = await makeBooking(A, 1, customerId) // ₹500
    const i2 = await bill(A, b2, { redeemPoints: 5 })
    check('redeem 5 → 5', await ledgerHolds(A, customerId, 5))
    await settle(A, i2.invoiceId, 495)
    check('…and ₹495 taxable earns 4 more → 9', await ledgerHolds(A, customerId, 9))

    const b3 = await makeBooking(A, 2, customerId)
    const tooMany = await expectError(() => bill(A, b3, { redeemPoints: 11 }))
    check('redeeming 11 of 9 is REJECTED', tooMany.threw)
    check('…balance still 9', await ledgerHolds(A, customerId, 9))
  }

  // ══ 15. existing behaviour intact ════════════════════════════════════════
  {
    const customerId = await makeCustomer(A)
    const bookingId = await makeBooking(A, 2, customerId)
    const inv = await bill(A, bookingId) // no loyalty at all
    check('a bill with no redemption has no loyalty discount', inv.loyalty === null && inv.pricing.discount === 0)
    const row = await invRow(inv.invoiceId)
    check('…and zeroed snapshot columns', row.loyalty_points_redeemed === 0 && row.loyalty_discount === '0.00')

    const paid = await settle(A, inv.invoiceId, 1000)
    check('…cash still settles it', paid.settled === true && paid.balance === 0)
    const s = await withUser(A.userId, (tx) => getInvoiceSettlement(tx, A.tenantId, inv.invoiceId))
    check('…and M1 settlement is unchanged', s!.total === 1000 && s!.paid === 1000 && s!.balance === 0)
  }

  // ══ 16. tenant-wide audit ════════════════════════════════════════════════
  {
    const negatives = await ownerPool.query<{ n: string }>(
      `select count(*)::text n from (
         select customer_id from loyalty_transactions
          where tenant_id = any($1) group by customer_id having sum(points) < 0) d`,
      [[A.tenantId, B.tenantId]])
    check('NO customer anywhere has a negative points balance', negatives.rows[0].n === '0')

    const dupes = await ownerPool.query<{ n: string }>(
      `select count(*)::text n from (
         select tenant_id, source_type, source_id from loyalty_transactions
          where tenant_id = any($1) and source_id is not null
          group by 1,2,3 having count(*) > 1) d`, [[A.tenantId, B.tenantId]])
    check('no (tenant, purpose, source) is recorded twice', dupes.rows[0].n === '0')

    const fractional = await ownerPool.query<{ n: string }>(
      `select count(*)::text n from loyalty_transactions
        where tenant_id = any($1) and points <> trunc(points)`, [[A.tenantId, B.tenantId]])
    check('every points entry is a whole number', fractional.rows[0].n === '0')
  }

  // ── cleanup ───────────────────────────────────────────────────────────────
  await ownerPool.query('delete from tenants where id = any($1)', [[A.tenantId, B.tenantId]])
  await ownerPool.query(`delete from users where email like '%@testly%.test'`)
  await ownerPool.end()
  await appPool.end()

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error('test harness error:', e instanceof Error ? `${e.name}: ${e.message}` : 'unknown')
  process.exit(1)
})
