/**
 * Wallet top-up and debit at the POS.
 *
 * THE invariant under test, after every single operation:
 *
 *     walletBalance(customer) === sum(wallet_transactions.amount)
 *     and it is never negative
 *
 * No mutable balance column exists; every assertion below re-derives the
 * balance from the ledger.
 *
 *   npx tsx scripts/test-wallet.ts
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
    topUpWallet,
    recordWalletPaymentForInvoice,
    walletLedgerReconciles,
    WALLET_METHOD,
    POS_TENDER_OPTIONS,
    WALLET_SOURCE,
  } = await import('../lib/billing/wallet-payments')
  const { walletBalance } = await import('../lib/customers/ledger')
  const { issueInvoiceForBooking } = await import('../lib/billing/invoice')
  const {
    recordPaymentForInvoice,
    getInvoiceSettlement,
    POS_PAYMENT_METHODS,
    paise,
  } = await import('../lib/billing/payments')
  const { recordRefund } = await import('../lib/billing/refunds')

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
  await ownerPool.query(`delete from tenants where slug in ('testwla','testwlb')`)
  await ownerPool.query(`delete from users where email like '%@testwl%.test'`)

  let seq = 0
  async function makeTenant(slug: string) {
    const t = await ownerPool.query<{ id: string }>(
      `insert into tenants (slug,name,status,timezone,currency)
       values ($1,$2,'active','Asia/Kolkata','INR') returning id`, [slug, `${slug} co`])
    const tenantId = t.rows[0].id
    const b = await ownerPool.query<{ id: string }>(
      `insert into branches (tenant_id,name,is_primary) values ($1,'Main',true) returning id`,
      [tenantId])
    const u = await ownerPool.query<{ id: string }>(
      `insert into users (email,password_hash) values ($1,'x') returning id`, [`c@${slug}.test`])
    const m = await ownerPool.query<{ id: string }>(
      `insert into memberships (tenant_id,user_id,role,status) values ($1,$2,'manager','active')
       returning id`, [tenantId, u.rows[0].id])
    const rt = await ownerPool.query<{ id: string }>(
      `insert into resource_types (tenant_id,name,hourly_rate) values ($1,'Bay','400.00')
       returning id`, [tenantId])
    const r = await ownerPool.query<{ id: string }>(
      `insert into resources (tenant_id,branch_id,resource_type_id,name)
       values ($1,$2,$3,'Bay 1') returning id`, [tenantId, b.rows[0].id, rt.rows[0].id])
    return {
      tenantId, branchId: b.rows[0].id, userId: u.rows[0].id,
      membershipId: m.rows[0].id, resourceId: r.rows[0].id,
    }
  }

  const A = await makeTenant('testwla')
  const B = await makeTenant('testwlb')

  async function makeCustomer(t: typeof A) {
    // Captured BEFORE any await: concurrent callers must not share a value.
    const n = ++seq
    const r = await ownerPool.query<{ id: string }>(
      `insert into customers (tenant_id,phone,name) values ($1,$2,$3) returning id`,
      [t.tenantId, `+9177${String(n).padStart(8, '0')}`, `Wallet ${n}`])
    return r.rows[0].id
  }

  /** A booking worth `hours × ₹400`, billed to an invoice. */
  async function makeInvoice(t: typeof A, hours: number, customerId: string | null) {
    // Captured synchronously — read after the await, five concurrent calls
    // would all see the final value and book the same slot, tripping the
    // booking_slots_no_overlap exclusion constraint.
    const n = ++seq
    const bk = await ownerPool.query<{ id: string }>(
      `insert into bookings (tenant_id,branch_id,booking_number,customer_id,customer_name,
                             status,source) values ($1,$2,$3,$4,'Guest','confirmed','staff')
       returning id`, [t.tenantId, t.branchId, `BK-WL-${String(n).padStart(3, '0')}`, customerId])
    const start = new Date(Date.now() + n * 86_400_000)
    await ownerPool.query(
      `insert into booking_slots (tenant_id,booking_id,resource_id,starts_at,ends_at,
                                  rate_applied,slot_total,resource_name,resource_type_name)
       values ($1,$2,$3,$4,$5,'400.00',$6,'Bay 1','Bay')`,
      [t.tenantId, bk.rows[0].id, t.resourceId, start,
       new Date(start.getTime() + hours * 3_600_000), (hours * 400).toFixed(2)])
    const inv = await withUser(t.userId, (tx) =>
      issueInvoiceForBooking(tx, { id: t.tenantId, timezone: 'Asia/Kolkata' }, { bookingId: bk.rows[0].id }))
    return inv.invoiceId
  }

  const topUp = (t: typeof A, customerId: string, amount: number, method: 'cash' | 'card' | 'upi' = 'cash') =>
    withUser(t.userId, (tx) =>
      topUpWallet(tx, {
        tenantId: t.tenantId, membershipId: t.membershipId,
        timezone: 'Asia/Kolkata', branchId: t.branchId,
      }, { customerId, amount, method }))

  const payFromWallet = (t: typeof A, invoiceId: string, amount: number) =>
    withUser(t.userId, (tx) =>
      recordWalletPaymentForInvoice(
        tx, { tenantId: t.tenantId, membershipId: t.membershipId }, { invoiceId, amount }))

  const balanceOf = (t: typeof A, customerId: string) =>
    withUser(t.userId, (tx) => walletBalance(tx, t.tenantId, customerId))

  /** Balance re-derived straight from SQL, bypassing every helper. */
  const rawBalance = async (customerId: string) =>
    Number((await ownerPool.query(
      `select coalesce(sum(amount),0)::text n from wallet_transactions where customer_id=$1`,
      [customerId])).rows[0].n)

  /** THE ledger invariant. Asserted after every mutation below. */
  async function ledgerHolds(t: typeof A, customerId: string, expected: number) {
    const derived = await balanceOf(t, customerId)
    const raw = await rawBalance(customerId)
    const reconciles = await withUser(t.userId, (tx) =>
      walletLedgerReconciles(tx, t.tenantId, customerId))
    return paise(derived) === paise(expected) && paise(raw) === paise(expected) && reconciles && derived >= 0
  }

  // ══ 1. no mutable balance column exists anywhere ═════════════════════════
  {
    const cols = await ownerPool.query<{ table_name: string; column_name: string }>(
      `select table_name, column_name from information_schema.columns
        where table_schema='public'
          and column_name in ('wallet_balance','balance','current_balance')`)
    check('no wallet_balance / balance / current_balance column exists', cols.rows.length === 0)
    check('POS_PAYMENT_METHODS is still exactly cash/card/upi', JSON.stringify([...POS_PAYMENT_METHODS]) === '["cash","card","upi"]')
    check('…and wallet is NOT in it (it needs a ledger debit, which that path cannot do)', !(POS_PAYMENT_METHODS as readonly string[]).includes('wallet'))
    check('POS_TENDER_OPTIONS offers wallet to the till', (POS_TENDER_OPTIONS as readonly string[]).includes(WALLET_METHOD))
  }

  // ══ 2. top-up ════════════════════════════════════════════════════════════
  {
    console.log('\n── top-up: pay ₹1000, receive ₹1000 credit ──')
    const customerId = await makeCustomer(A)
    check('a new customer starts at ₹0', await ledgerHolds(A, customerId, 0))

    const r = await topUp(A, customerId, 1000, 'cash')
    check('the top-up returns an invoice number', typeof r.invoiceNumber === 'string' && r.invoiceNumber.length > 0)
    check('…the ledger balance is ₹1000', await ledgerHolds(A, customerId, 1000))

    const led = (await ownerPool.query(
      `select * from wallet_transactions where customer_id=$1`, [customerId])).rows
    check('…as ONE positive credit row', led.length === 1 && led[0].amount === '1000.00')
    check('…tagged wallet_topup and referencing the invoice', led[0].source_type === WALLET_SOURCE.topUp && led[0].source_id === r.invoiceId)

    const inv = (await ownerPool.query('select * from invoices where id=$1', [r.invoiceId])).rows[0]
    check('the top-up raised a real invoice, totalling ₹1000', inv.total === '1000.00')
    check('…marked PAID once tendered', inv.status === 'paid')
    check('…attributed to the customer, with no booking', inv.customer_id === customerId && inv.booking_id === null)

    const items = (await ownerPool.query('select * from invoice_items where invoice_id=$1', [r.invoiceId])).rows
    check('…one line of kind wallet_topup at 0% tax', items.length === 1 && items[0].kind === 'wallet_topup' && items[0].tax_rate === '0.00')

    const pay = (await ownerPool.query('select * from payments where invoice_id=$1', [r.invoiceId])).rows
    check('…settled by ONE captured cash payment of ₹1000', pay.length === 1 && pay[0].method === 'cash' && pay[0].status === 'captured' && pay[0].amount === '1000.00')

    // A top-up is money in advance, so it must be excludable from revenue.
    const split = await ownerPool.query<{ topup: string; sales: string }>(
      `select count(*) filter (where kind = 'wallet_topup')::text topup,
              count(*) filter (where kind <> 'wallet_topup')::text sales
         from invoice_items where tenant_id=$1`, [A.tenantId])
    check('…and is separable from real sales by kind (1 top-up, 0 sales so far)', split.rows[0].topup === '1' && split.rows[0].sales === '0')

    for (const bad of [0, -100]) {
      const r2 = await expectError(() => topUp(A, customerId, bad))
      check(`a ₹${bad} top-up is refused`, r2.threw)
    }
    check('…and the balance is unmoved', await ledgerHolds(A, customerId, 1000))
  }

  // ══ 3. spending it ═══════════════════════════════════════════════════════
  {
    console.log('\n── debit: ₹1000 wallet, ₹800 bill ──')
    const customerId = await makeCustomer(A)
    await topUp(A, customerId, 1000)
    const invoiceId = await makeInvoice(A, 2, customerId) // 2h × ₹400 = ₹800

    const r = await payFromWallet(A, invoiceId, 800)
    check('the wallet pays ₹800', r.amount === 800 && r.settled === true)
    check('…balance falls to ₹200', await ledgerHolds(A, customerId, 200))

    const pay = (await ownerPool.query(
      `select * from payments where invoice_id=$1`, [invoiceId])).rows
    check('…creating an M1 payments row, method=wallet, captured', pay.length === 1 && pay[0].method === 'wallet' && pay[0].status === 'captured' && pay[0].amount === '800.00')
    check('…attributed to the collecting member', pay[0].collected_by === A.membershipId)

    const debit = (await ownerPool.query(
      `select * from wallet_transactions where source_id=$1`, [pay[0].id])).rows
    check('…and a NEGATIVE ledger debit referencing that payment', debit.length === 1 && debit[0].amount === '-800.00' && debit[0].source_type === WALLET_SOURCE.invoicePayment)

    const inv = (await ownerPool.query('select status from invoices where id=$1', [invoiceId])).rows[0]
    check('…the invoice is marked paid', inv.status === 'paid')

    const settlement = await withUser(A.userId, (tx) => getInvoiceSettlement(tx, A.tenantId, invoiceId))
    check('…M1 settlement agrees: total ₹800, paid ₹800, balance ₹0', settlement!.total === 800 && settlement!.paid === 800 && settlement!.balance === 0)
    check('…and the wallet tender appears on the invoice', settlement!.payments.some((p) => p.method === 'wallet' && p.amount === '800.00'))
  }

  // ══ 4. failure cases A / B / C ═══════════════════════════════════════════
  {
    // A. insufficient balance
    const c1 = await makeCustomer(A)
    await topUp(A, c1, 500)
    const inv1 = await makeInvoice(A, 2, c1) // ₹800
    const insufficient = await expectError(() => payFromWallet(A, inv1, 600))
    check('A: paying ₹600 from a ₹500 wallet is REFUSED', insufficient.threw && insufficient.message.includes('Not enough wallet balance'))
    check('…the balance is untouched at ₹500', await ledgerHolds(A, c1, 500))
    check('…no payment row was created', Number((await ownerPool.query('select count(*)::int n from payments where invoice_id=$1', [inv1])).rows[0].n) === 0)
    check('…and the invoice is still issued', (await ownerPool.query('select status from invoices where id=$1', [inv1])).rows[0].status === 'issued')

    // B. exact balance
    const c2 = await makeCustomer(A)
    await topUp(A, c2, 500)
    const inv2 = await makeInvoice(A, 2, c2) // ₹800
    const exact = await payFromWallet(A, inv2, 500)
    check('B: the EXACT balance can be spent', exact.amount === 500)
    check('…leaving ₹0, not negative', await ledgerHolds(A, c2, 0))
    check('…the invoice is part-paid, not settled', exact.settled === false && exact.invoiceBalance === 300)
    const noMore = await expectError(() => payFromWallet(A, inv2, 1))
    check('…and a further ₹1 is refused on an empty wallet', noMore.threw)
    check('…balance still ₹0', await ledgerHolds(A, c2, 0))

    // C. overpayment
    const c3 = await makeCustomer(A)
    await topUp(A, c3, 5000)
    const inv3 = await makeInvoice(A, 2, c3) // ₹800
    const over = await expectError(() => payFromWallet(A, inv3, 900))
    check('C: paying ₹900 against an ₹800 bill is REFUSED', over.threw && over.message.includes('exceeds the remaining balance'))
    check('…the wallet is untouched at ₹5000', await ledgerHolds(A, c3, 5000))
  }

  // ══ 5. D — split payment ═════════════════════════════════════════════════
  {
    console.log('\n── split: ₹500 wallet + ₹300 cash on an ₹800 bill ──')
    const customerId = await makeCustomer(A)
    await topUp(A, customerId, 500)
    const invoiceId = await makeInvoice(A, 2, customerId) // ₹800

    const w = await payFromWallet(A, invoiceId, 500)
    check('the ₹500 wallet tender lands, leaving ₹300', w.invoiceBalance === 300 && w.settled === false)
    check('…wallet is empty', await ledgerHolds(A, customerId, 0))

    const cash = await withUser(A.userId, (tx) =>
      recordPaymentForInvoice(tx, { tenantId: A.tenantId, membershipId: A.membershipId },
        { invoiceId, method: 'cash', amount: 300 }))
    check('…₹300 cash settles the bill', cash.settled === true && cash.balance === 0)

    const settlement = await withUser(A.userId, (tx) => getInvoiceSettlement(tx, A.tenantId, invoiceId))
    check('…two tenders on record: wallet + cash', settlement!.payments.length === 2 && settlement!.payments.map((p) => p.method).sort().join(',') === 'cash,wallet')
    check('…and total − captured = ₹0', settlement!.total === 800 && settlement!.paid === 800 && settlement!.balance === 0)
  }

  // ══ 6. E — CONCURRENT debits cannot overdraw ═════════════════════════════
  {
    console.log('\n── concurrency: ₹500 wallet, simultaneous ₹400 and ₹300 ──')
    const customerId = await makeCustomer(A)
    await topUp(A, customerId, 500)
    const invA = await makeInvoice(A, 2, customerId) // ₹800
    const invB = await makeInvoice(A, 2, customerId) // ₹800

    const [ra, rb] = await Promise.allSettled([
      payFromWallet(A, invA, 400),
      payFromWallet(A, invB, 300),
    ])
    const ok = [ra, rb].filter((r) => r.status === 'fulfilled').length
    check('exactly ONE of the two simultaneous debits succeeds', ok === 1)
    const finalBalance = await balanceOf(A, customerId)
    check('…the balance is never negative', finalBalance >= 0)
    check('…and equals ₹500 minus whichever won', paise(finalBalance) === paise(500 - (ra.status === 'fulfilled' ? 400 : 300)))
    check('…the ledger still reconciles', await withUser(A.userId, (tx) => walletLedgerReconciles(tx, A.tenantId, customerId)))
    const debits = Number((await ownerPool.query(
      `select count(*)::int n from wallet_transactions where customer_id=$1 and amount < 0`,
      [customerId])).rows[0].n)
    check('…and exactly ONE debit row exists', debits === 1)

    // Harder: five at once against a balance that only covers two.
    const c2 = await makeCustomer(A)
    await topUp(A, c2, 200)
    const invs = await Promise.all([1, 2, 3, 4, 5].map(() => makeInvoice(A, 2, c2)))
    const results = await Promise.allSettled(invs.map((i) => payFromWallet(A, i, 100)))
    const wins = results.filter((r) => r.status === 'fulfilled').length
    check('five concurrent ₹100 debits against ₹200 → exactly TWO succeed', wins === 2)
    check('…balance lands at exactly ₹0, never below', await ledgerHolds(A, c2, 0))
  }

  // ══ 7. F/G — atomicity ═══════════════════════════════════════════════════
  {
    // The payment row and the debit are written in one transaction. Force a
    // failure AFTER both by rolling the transaction back, and prove neither
    // survives — this is the "no payment without its debit" guarantee.
    const customerId = await makeCustomer(A)
    await topUp(A, customerId, 1000)
    const invoiceId = await makeInvoice(A, 2, customerId)

    const rolled = await expectError(() =>
      withUser(A.userId, async (tx) => {
        await recordWalletPaymentForInvoice(
          tx, { tenantId: A.tenantId, membershipId: A.membershipId }, { invoiceId, amount: 800 })
        // Something later in the same unit of work fails.
        throw new Error('simulated downstream failure')
      }))
    check('F/G: a failure after the tender aborts the whole unit', rolled.threw)
    check('…NO payment row survives', Number((await ownerPool.query('select count(*)::int n from payments where invoice_id=$1', [invoiceId])).rows[0].n) === 0)
    check('…NO wallet debit survives', await ledgerHolds(A, customerId, 1000))
    check('…and the invoice is still unpaid', (await ownerPool.query('select status from invoices where id=$1', [invoiceId])).rows[0].status === 'issued')

    // And the customer can still pay normally afterwards.
    const retry = await payFromWallet(A, invoiceId, 800)
    check('…a subsequent wallet payment succeeds', retry.settled === true)
    check('…balance ₹200', await ledgerHolds(A, customerId, 200))
  }

  // ══ 8. H/I — ownership ═══════════════════════════════════════════════════
  {
    const aCustomer = await makeCustomer(A)
    await topUp(A, aCustomer, 1000)
    const aInvoice = await makeInvoice(A, 2, aCustomer)

    // H. tenant B cannot touch tenant A's wallet or invoice.
    const crossPay = await expectError(() =>
      withUser(B.userId, (tx) =>
        recordWalletPaymentForInvoice(tx, { tenantId: B.tenantId, membershipId: B.membershipId },
          { invoiceId: aInvoice, amount: 100 })))
    check("H: tenant B cannot pay tenant A's invoice from a wallet", crossPay.threw && crossPay.message === 'Invoice not found.')

    const spoof = await expectError(() =>
      withUser(B.userId, (tx) =>
        recordWalletPaymentForInvoice(tx, { tenantId: A.tenantId, membershipId: B.membershipId },
          { invoiceId: aInvoice, amount: 100 })))
    check("…nor by passing tenant A's id under tenant B's session (RLS)", spoof.threw)

    const crossTopUp = await expectError(() => topUp(B, aCustomer, 500))
    check("…nor top up tenant A's customer", crossTopUp.threw && crossTopUp.message === 'Customer not found.')
    check("…tenant A's balance is untouched", await ledgerHolds(A, aCustomer, 1000))

    const bSees = await withUser(B.userId, (tx) =>
      tx.select().from(schema.walletTransactions))
    check("…and tenant B sees none of tenant A's wallet rows", bSees.every((r) => r.tenantId === B.tenantId))

    // I. customer A's wallet cannot pay customer B's invoice — the wallet is
    // chosen BY the invoice, so there is no parameter to abuse.
    const otherCustomer = await makeCustomer(A)
    const otherInvoice = await makeInvoice(A, 2, otherCustomer)
    const wrongWallet = await expectError(() => payFromWallet(A, otherInvoice, 100))
    check("I: another customer's empty wallet cannot borrow from a funded one", wrongWallet.threw && wrongWallet.message.includes('Not enough wallet balance'))
    check("…the funded customer is untouched", await ledgerHolds(A, aCustomer, 1000))

    // A walk-in invoice has no wallet at all.
    const walkIn = await makeInvoice(A, 2, null)
    const noCustomer = await expectError(() => payFromWallet(A, walkIn, 100))
    check('…a bill with no customer cannot be paid by wallet', noCustomer.threw && noCustomer.message.includes('not linked to a customer'))
  }

  // ══ 9. the ledger sequence from §21 ══════════════════════════════════════
  {
    console.log('\n── ledger: 0 → +1000 → −250 → −750 → 0 ──')
    const customerId = await makeCustomer(A)
    check('₹0', await ledgerHolds(A, customerId, 0))
    await topUp(A, customerId, 1000)
    check('after +₹1000 → ₹1000', await ledgerHolds(A, customerId, 1000))

    const i1 = await makeInvoice(A, 2, customerId)
    await payFromWallet(A, i1, 250)
    check('after −₹250 → ₹750', await ledgerHolds(A, customerId, 750))

    const i2 = await makeInvoice(A, 2, customerId)
    await payFromWallet(A, i2, 750)
    check('after −₹750 → ₹0', await ledgerHolds(A, customerId, 0))

    const i3 = await makeInvoice(A, 2, customerId)
    const overdraw = await expectError(() => payFromWallet(A, i3, 1))
    check('a further −₹1 is REJECTED', overdraw.threw)
    check('…balance is still exactly ₹0', await ledgerHolds(A, customerId, 0))
  }

  // ══ 10. refund of a wallet payment restores the wallet ═══════════════════
  {
    console.log('\n── refund: a wallet payment goes back to the wallet ──')
    const customerId = await makeCustomer(A)
    await topUp(A, customerId, 1000)
    const invoiceId = await makeInvoice(A, 2, customerId)
    const paid = await payFromWallet(A, invoiceId, 800)
    check('₹800 spent, ₹200 left', await ledgerHolds(A, customerId, 200))

    await withUser(A.userId, (tx) =>
      recordRefund(tx, { tenantId: A.tenantId, membershipId: A.membershipId },
        { paymentId: paid.paymentId, amount: 800, reason: 'Customer cancelled' }))

    check('refunding the wallet payment RESTORES the balance to ₹1000', await ledgerHolds(A, customerId, 1000))
    const credit = (await ownerPool.query(
      `select * from wallet_transactions where customer_id=$1 and source_type=$2`,
      [customerId, WALLET_SOURCE.refund])).rows
    check('…as an explicit wallet_refund credit', credit.length === 1 && credit[0].amount === '800.00')

    // A CASH refund must NOT touch the wallet.
    const c2 = await makeCustomer(A)
    await topUp(A, c2, 500)
    const inv2 = await makeInvoice(A, 2, c2)
    const cash = await withUser(A.userId, (tx) =>
      recordPaymentForInvoice(tx, { tenantId: A.tenantId, membershipId: A.membershipId },
        { invoiceId: inv2, method: 'cash', amount: 800 }))
    await withUser(A.userId, (tx) =>
      recordRefund(tx, { tenantId: A.tenantId, membershipId: A.membershipId },
        { paymentId: cash.paymentId, amount: 800, reason: 'Cash back' }))
    check('a CASH refund leaves the wallet alone at ₹500', await ledgerHolds(A, c2, 500))
  }

  // ══ 11. existing tenders still work ══════════════════════════════════════
  {
    for (const method of POS_PAYMENT_METHODS) {
      const customerId = await makeCustomer(A)
      const invoiceId = await makeInvoice(A, 2, customerId)
      const r = await withUser(A.userId, (tx) =>
        recordPaymentForInvoice(tx, { tenantId: A.tenantId, membershipId: A.membershipId },
          { invoiceId, method, amount: 800 }))
      check(`${method} still settles a bill unchanged`, r.settled === true && r.balance === 0)
      check(`…and creates no wallet ledger row`, Number((await ownerPool.query(
        'select count(*)::int n from wallet_transactions where customer_id=$1', [customerId])).rows[0].n) === 0)
    }
  }

  // ══ 12. tenant-wide ledger audit ═════════════════════════════════════════
  {
    const negatives = await ownerPool.query<{ n: string }>(
      `select count(*)::text n from (
         select customer_id, sum(amount) bal from wallet_transactions
          where tenant_id = any($1) group by customer_id having sum(amount) < 0) d`,
      [[A.tenantId, B.tenantId]])
    check('NO customer anywhere has a negative wallet balance', negatives.rows[0].n === '0')

    const orphanDebits = await ownerPool.query<{ n: string }>(
      `select count(*)::text n from wallet_transactions w
        where w.tenant_id = any($1) and w.source_type = $2
          and not exists (select 1 from payments p where p.id = w.source_id)`,
      [[A.tenantId, B.tenantId], WALLET_SOURCE.invoicePayment])
    check('every wallet debit references a real payment row', orphanDebits.rows[0].n === '0')

    const orphanPayments = await ownerPool.query<{ n: string }>(
      `select count(*)::text n from payments p
        where p.tenant_id = any($1) and p.method = 'wallet'
          and not exists (select 1 from wallet_transactions w
                           where w.source_id = p.id and w.source_type = $2)`,
      [[A.tenantId, B.tenantId], WALLET_SOURCE.invoicePayment])
    check('every wallet PAYMENT has its matching ledger debit', orphanPayments.rows[0].n === '0')

    const overpaid = await ownerPool.query<{ n: string }>(
      `select count(*)::text n from (
         select i.id from invoices i
           join payments p on p.invoice_id = i.id and p.status='captured'
          where i.tenant_id = any($1)
          group by i.id, i.total having sum(p.amount) > i.total) d`,
      [[A.tenantId, B.tenantId]])
    check('NO invoice anywhere is overpaid', overpaid.rows[0].n === '0')
  }

  // ── cleanup ───────────────────────────────────────────────────────────────
  await ownerPool.query('delete from tenants where id = any($1)', [[A.tenantId, B.tenantId]])
  await ownerPool.query(`delete from users where email like '%@testwl%.test'`)
  await ownerPool.end()
  await appPool.end()

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error('test harness error:', e instanceof Error ? `${e.name}: ${e.message}` : 'unknown')
  process.exit(1)
})
