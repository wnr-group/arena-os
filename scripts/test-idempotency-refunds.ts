/**
 * Two defects, and the guarantees that close them.
 *
 *  1. IDEMPOTENCY — a double-clicked or retried tender must take the money
 *     once, and the retry must report the FIRST result rather than an error.
 *
 *  2. REFUND RECONCILIATION — money going back must take its side effects with
 *     it: loyalty points earned on the bill, wallet credit a refunded top-up
 *     sold, and a membership whose purchase is fully refunded. Proportional for
 *     partial refunds, cumulative across several, and never over-reversing.
 *
 *   npx tsx scripts/test-idempotency-refunds.ts
 */
import { randomUUID } from 'node:crypto'
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
  const { recordPaymentForInvoice, getInvoiceSettlement } = await import('../lib/billing/payments')
  const { issueInvoiceForBooking } = await import('../lib/billing/invoice')
  const { recordRefund, voidInvoiceRecord } = await import('../lib/billing/refunds')
  const { topUpWallet, recordWalletPaymentForInvoice } = await import(
    '../lib/billing/wallet-payments'
  )
  const { walletBalance, loyaltyPoints } = await import('../lib/customers/ledger')
  const { purchaseMembership, getActiveMembership } = await import(
    '../lib/memberships/customer-memberships'
  )
  const { round2 } = await import('../lib/billing/pricing')

  const o = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })
  const app = drizzle(new Pool({ connectionString: process.env.DATABASE_URL, max: 10 }), { schema })
  const wu = <T,>(u: string, fn: (tx: Db) => Promise<T>) =>
    app.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.user_id', ${u}, true)`)
      return fn(tx as unknown as Db)
    })

  const expectError = async (fn: () => Promise<unknown>) => {
    try { await fn(); return { threw: false, message: '' } }
    catch (e) { return { threw: true, message: e instanceof Error ? e.message : '' } }
  }

  await o.query(`delete from tenants where slug='testidem'`)
  await o.query(`delete from users where email='c@testidem.test'`)
  const t = (await o.query<{ id: string }>(
    `insert into tenants (slug,name,status,timezone,currency)
     values ('testidem','idem','active','Asia/Kolkata','INR') returning id`)).rows[0].id
  const b = (await o.query<{ id: string }>(
    `insert into branches (tenant_id,name,is_primary) values ($1,'M',true) returning id`, [t])).rows[0].id
  const u = (await o.query<{ id: string }>(
    `insert into users (email,password_hash) values ('c@testidem.test','x') returning id`)).rows[0].id
  const m = (await o.query<{ id: string }>(
    `insert into memberships (tenant_id,user_id,role,status) values ($1,$2,'manager','active') returning id`, [t, u])).rows[0].id
  const rt = (await o.query<{ id: string }>(
    `insert into resource_types (tenant_id,name,hourly_rate) values ($1,'Bay','500.00') returning id`, [t])).rows[0].id
  const res = (await o.query<{ id: string }>(
    `insert into resources (tenant_id,branch_id,resource_type_id,name) values ($1,$2,$3,'Bay 1') returning id`, [t, b, rt])).rows[0].id

  let seq = 0
  async function customer() {
    const n = ++seq
    return (await o.query<{ id: string }>(
      `insert into customers (tenant_id,phone,name) values ($1,$2,$3) returning id`,
      [t, `+9155${String(n).padStart(8, '0')}`, `C${n}`])).rows[0].id
  }
  async function invoiceFor(customerId: string | null, hours = 2) {
    const n = ++seq
    const bk = (await o.query<{ id: string }>(
      `insert into bookings (tenant_id,branch_id,booking_number,customer_id,customer_name,status,source)
       values ($1,$2,$3,$4,'G','confirmed','staff') returning id`,
      [t, b, `BK-ID-${String(n).padStart(3, '0')}`, customerId])).rows[0].id
    const st = new Date(Date.now() + n * 86_400_000)
    await o.query(
      `insert into booking_slots (tenant_id,booking_id,resource_id,starts_at,ends_at,rate_applied,slot_total,resource_name,resource_type_name)
       values ($1,$2,$3,$4,$5,'500.00',$6,'Bay 1','Bay')`,
      [t, bk, res, st, new Date(st.getTime() + hours * 3_600_000), (hours * 500).toFixed(2)])
    const inv = await wu(u, (tx) => issueInvoiceForBooking(tx, { id: t, timezone: 'Asia/Kolkata' }, { bookingId: bk }))
    return inv.invoiceId
  }
  const pay = (invoiceId: string, amount: number, idempotencyKey?: string) =>
    wu(u, (tx) => recordPaymentForInvoice(tx, { tenantId: t, membershipId: m },
      { invoiceId, method: 'cash', amount, idempotencyKey }))
  const refund = (paymentId: string, amount: number) =>
    wu(u, (tx) => recordRefund(tx, { tenantId: t, membershipId: m }, { paymentId, amount, reason: 'test' }))
  const points = (c: string) => wu(u, (tx) => loyaltyPoints(tx, t, c))
  const wallet = (c: string) => wu(u, (tx) => walletBalance(tx, t, c))
  const payCount = async (invoiceId: string) =>
    Number((await o.query('select count(*)::int n from payments where invoice_id=$1', [invoiceId])).rows[0].n)

  // ══ 1. IDEMPOTENCY — the double click ════════════════════════════════════
  {
    console.log('\n── a double-clicked ₹400 tender on a ₹1000 bill ──')
    const invoiceId = await invoiceFor(await customer())
    const key = randomUUID()

    const first = await pay(invoiceId, 400, key)
    const second = await pay(invoiceId, 400, key)

    check('the first tender is taken', first.paid === 400 && first.deduplicated !== true)
    check('the second is RECOGNISED as a retry, not an error', second.deduplicated === true)
    check('…and reports the same payment id', second.paymentId === first.paymentId)
    check('…exactly ONE payment row exists', (await payCount(invoiceId)) === 1)
    check('…only ₹400 was taken', (await wu(u, (tx) => getInvoiceSettlement(tx, t, invoiceId)))!.paid === 400)

    // A DELIBERATE second tender, with a fresh key, must still work.
    const deliberate = await pay(invoiceId, 400, randomUUID())
    check('a deliberate second ₹400 with a NEW key IS taken', deliberate.paid === 800 && deliberate.deduplicated !== true)
    check('…two payment rows now', (await payCount(invoiceId)) === 2)

    // Without a key, the old behaviour stands — documented, not silently changed.
    const unkeyed1 = await pay(invoiceId, 100)
    const unkeyed2 = await pay(invoiceId, 100)
    check('an UNKEYED double submission still creates two rows (unchanged)', unkeyed1.paymentId !== unkeyed2.paymentId)
  }

  // ══ 2. IDEMPOTENCY under concurrency ═════════════════════════════════════
  {
    const invoiceId = await invoiceFor(await customer())
    const key = randomUUID()
    const results = await Promise.allSettled([1, 2, 3, 4, 5].map(() => pay(invoiceId, 200, key)))
    const ok = results.filter((r) => r.status === 'fulfilled')
    check('five concurrent submissions of ONE key all resolve', ok.length === 5)
    check('…exactly one payment row exists', (await payCount(invoiceId)) === 1)
    check('…and only ₹200 was captured', (await wu(u, (tx) => getInvoiceSettlement(tx, t, invoiceId)))!.paid === 200)
    check('…every response names the same payment', new Set(ok.map((r) => (r as PromiseFulfilledResult<{paymentId:string}>).value.paymentId)).size === 1)

    // The DB index is the real guarantee.
    let blocked = false
    try {
      await o.query(
        `insert into payments (tenant_id,branch_id,invoice_id,method,amount,status,idempotency_key)
         values ($1,$2,$3,'cash','1.00','captured',$4)`, [t, b, invoiceId, key])
    } catch { blocked = true }
    check('a duplicate idempotency key is refused by the unique index', blocked)

    // Reusing a key against a DIFFERENT invoice is a client bug — refuse it.
    const other = await invoiceFor(await customer())
    const misuse = await expectError(() => pay(other, 100, key))
    check('reusing a key on a DIFFERENT invoice is refused', misuse.threw && misuse.message.includes('already been used'))
  }

  // ══ 3. REFUND → loyalty, proportional ════════════════════════════════════
  {
    console.log('\n── ₹1000 bill earns 10 points; refunds claw them back pro rata ──')
    const c = await customer()
    const invoiceId = await invoiceFor(c)
    const p = await pay(invoiceId, 1000, randomUUID())
    check('settled → 10 points', (await points(c)) === 10)

    await refund(p.paymentId, 500)
    check('a 50% refund leaves 5 points', (await points(c)) === 5)

    await refund(p.paymentId, 250)
    check('a further 25% (75% total) leaves 2', (await points(c)) === 2)

    await refund(p.paymentId, 250)
    check('fully refunded leaves 0 — not negative', (await points(c)) === 0)

    const row = (await o.query('select loyalty_points_earned e, loyalty_points_reversed r from invoices where id=$1', [invoiceId])).rows[0]
    check('…the invoice counters agree: earned 10, reversed 10', row.e === 10 && row.r === 10)
    check('…and the earn credit is still on record (append-only)', Number((await o.query(
      `select count(*)::int n from loyalty_transactions where source_type='invoice_earn' and source_id=$1`, [invoiceId])).rows[0].n) === 1)
  }

  // ══ 4. flooring is cumulative, not per refund ════════════════════════════
  {
    // Three refunds of a third each must reverse 10, not floor(10/3)×3 = 9.
    const c = await customer()
    const invoiceId = await invoiceFor(c)
    const p = await pay(invoiceId, 1000, randomUUID())
    for (const amt of [333.34, 333.33, 333.33]) await refund(p.paymentId, amt)
    check('three ~1/3 refunds reverse ALL 10 points (cumulative flooring)', (await points(c)) === 0)
  }

  // ══ 5. REFUND → wallet top-up ════════════════════════════════════════════
  {
    console.log('\n── refunding a top-up must take the credit back ──')
    const c = await customer()
    const tu = await wu(u, (tx) => topUpWallet(tx,
      { tenantId: t, membershipId: m, timezone: 'Asia/Kolkata', branchId: b },
      { customerId: c, amount: 1000, method: 'cash' }))
    check('₹1000 top-up → ₹1000 credit', (await wallet(c)) === 1000)

    await refund(tu.paymentId, 400)
    check('a ₹400 refund removes ₹400 of credit', (await wallet(c)) === 600)

    await refund(tu.paymentId, 600)
    check('refunding the rest removes the rest — ₹0, not duplicated money', (await wallet(c)) === 0)
    check('…and the balance never went negative', (await wallet(c)) >= 0)

    const reversals = (await o.query(
      `select amount from wallet_transactions where customer_id=$1 and source_type='topup_reversal' order by created_at`, [c])).rows
    check('…recorded as explicit debits, one per refund', reversals.length === 2 &&
      reversals[0].amount === '-400.00' && reversals[1].amount === '-600.00')

    // A top-up earns no points, so nothing to reverse there either.
    check('…and no points were involved', (await points(c)) === 0)
  }

  // ══ 6. spending credit then refunding the top-up ═════════════════════════
  {
    // The customer tops up ₹1000, spends ₹1000, then the top-up is refunded.
    // The credit reversal drives the balance negative — which the ledger MUST
    // reflect honestly rather than hide, because the venue is genuinely owed.
    const c = await customer()
    const tu = await wu(u, (tx) => topUpWallet(tx,
      { tenantId: t, membershipId: m, timezone: 'Asia/Kolkata', branchId: b },
      { customerId: c, amount: 1000, method: 'cash' }))
    const invoiceId = await invoiceFor(c)
    await wu(u, (tx) => recordWalletPaymentForInvoice(tx, { tenantId: t, membershipId: m },
      { invoiceId, amount: 1000 }))
    check('credit spent → ₹0', (await wallet(c)) === 0)

    await refund(tu.paymentId, 1000)
    const after = await wallet(c)
    check('refunding the already-spent top-up drives the balance to −₹1000', after === -1000)
    check('…which is recorded, not hidden — the venue is owed this', after < 0)
  }

  // ══ 7. REFUND → membership ═══════════════════════════════════════════════
  {
    console.log('\n── refunding a membership purchase ──')
    const planId = (await o.query<{ id: string }>(
      `insert into membership_plans (tenant_id,name,price,duration_months,discount_percent,free_hours,wallet_credit)
       values ($1,'Refundable','2000.00',1,'10.00','0','0') returning id`, [t])).rows[0].id

    // Partial refund leaves it standing.
    const c1 = await customer()
    const ms1 = await wu(u, (tx) => purchaseMembership(tx,
      { tenantId: t, membershipId: m, timezone: 'Asia/Kolkata', branchId: b },
      { customerId: c1, planId, paymentMethod: 'cash' }))
    await refund(ms1.paymentId!, 500)
    check('a PARTIAL refund leaves the membership active (a human decides)',
      (await wu(u, (tx) => getActiveMembership(tx, t, c1))) !== null)

    // Full refund cancels it.
    const c2 = await customer()
    const ms2 = await wu(u, (tx) => purchaseMembership(tx,
      { tenantId: t, membershipId: m, timezone: 'Asia/Kolkata', branchId: b },
      { customerId: c2, planId, paymentMethod: 'cash' }))
    check('membership is active after purchase', (await wu(u, (tx) => getActiveMembership(tx, t, c2))) !== null)
    await refund(ms2.paymentId!, 2000)
    check('a FULL refund CANCELS the membership', (await wu(u, (tx) => getActiveMembership(tx, t, c2))) === null)
    const row = (await o.query('select status, cancelled_at from customer_memberships where id=$1', [ms2.membershipId])).rows[0]
    check('…status cancelled, timestamped, row preserved', row.status === 'cancelled' && row.cancelled_at !== null)
    check('…and benefits stop', (await wu(u, (tx) => getActiveMembership(tx, t, c2))) === null)
  }

  // ══ 8. partial refund THEN void must not double-reverse ══════════════════
  {
    console.log('\n── partial refund then void: no double reversal ──')
    const c = await customer()
    const invoiceId = await invoiceFor(c)
    const p = await pay(invoiceId, 1000, randomUUID())
    check('10 points earned', (await points(c)) === 10)

    await refund(p.paymentId, 500)
    check('50% refund → 5 points', (await points(c)) === 5)

    await refund(p.paymentId, 500) // now fully refunded, so a void is allowed
    check('fully refunded → 0 points', (await points(c)) === 0)

    await wu(u, (tx) => voidInvoiceRecord(tx, { tenantId: t, membershipId: m },
      { invoiceId, reason: 'test' }))
    const afterVoid = await points(c)
    check('voiding afterwards does NOT reverse again — still 0, not −10', afterVoid === 0)
    check('…and the balance is not negative', afterVoid >= 0)
  }

  // ══ 9. redeemed points come back on a void ═══════════════════════════════
  {
    const c = await customer()
    await o.query(
      `insert into loyalty_transactions (tenant_id,customer_id,points,source_type) values ($1,$2,100,'manual_adjustment')`, [t, c])
    const n = ++seq
    const bk = (await o.query<{ id: string }>(
      `insert into bookings (tenant_id,branch_id,booking_number,customer_id,customer_name,status,source)
       values ($1,$2,$3,$4,'G','confirmed','staff') returning id`, [t, b, `BK-ID-${String(n).padStart(3,'0')}`, c])).rows[0].id
    const st = new Date(Date.now() + n * 86_400_000)
    await o.query(
      `insert into booking_slots (tenant_id,booking_id,resource_id,starts_at,ends_at,rate_applied,slot_total,resource_name,resource_type_name)
       values ($1,$2,$3,$4,$5,'500.00','1000.00','Bay 1','Bay')`,
      [t, bk, res, st, new Date(st.getTime() + 2 * 3_600_000)])
    const inv = await wu(u, (tx) => issueInvoiceForBooking(tx, { id: t, timezone: 'Asia/Kolkata' },
      { bookingId: bk, redeemPoints: 100 }))
    check('100 points redeemed → 0 left', (await points(c)) === 0)

    const p = await pay(inv.invoiceId, 900, randomUUID())
    await refund(p.paymentId, 900)
    await wu(u, (tx) => voidInvoiceRecord(tx, { tenantId: t, membershipId: m },
      { invoiceId: inv.invoiceId, reason: 'test' }))
    const after = await points(c)
    check('voiding returns the 100 redeemed points', after === 100)
    check('…and does not over-return', after === 100)
  }

  // ══ 10. tenant-wide audit ════════════════════════════════════════════════
  {
    const overReversed = await o.query<{ n: string }>(
      `select count(*)::text n from invoices
        where tenant_id=$1 and loyalty_points_reversed > loyalty_points_earned`, [t])
    check('no invoice reversed more points than it earned', overReversed.rows[0].n === '0')

    const negPoints = await o.query<{ n: string }>(
      `select count(*)::text n from (select customer_id from loyalty_transactions
        where tenant_id=$1 group by customer_id having sum(points) < 0) d`, [t])
    check('no customer has negative points', negPoints.rows[0].n === '0')

    const dupKeys = await o.query<{ n: string }>(
      `select count(*)::text n from (select idempotency_key from payments
        where tenant_id=$1 and idempotency_key is not null
        group by idempotency_key having count(*) > 1) d`, [t])
    check('no idempotency key was used twice', dupKeys.rows[0].n === '0')

    const overpaid = await o.query<{ n: string }>(
      `select count(*)::text n from (select i.id from invoices i
         join payments p on p.invoice_id=i.id and p.status='captured'
        where i.tenant_id=$1 group by i.id, i.total having sum(p.amount) > i.total) d`, [t])
    check('no invoice is overpaid', overpaid.rows[0].n === '0')
  }

  await o.query('delete from tenants where id=$1', [t])
  await o.query(`delete from users where email='c@testidem.test'`)
  await o.end()

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error('test harness error:', e instanceof Error ? `${e.name}: ${e.message}` : 'unknown')
  process.exit(1)
})
