/**
 * AROS-51 — deposit → balance due → in-venue settlement.
 *
 * The ticket's invariant, which is M1's and is NOT reimplemented anywhere:
 *
 *     invoice.total − sum(captured payments) = balance due
 *
 * These tests assert it end to end through the REAL code: an online deposit
 * settled by AROS-50, an invoice raised by lib/billing/invoice.ts, and cashier
 * tenders taken by recordPaymentForInvoice() — with every balance figure read
 * back from getInvoiceSettlement(), the single M1 calculator.
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs scripts/test-deposit-balance.ts
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
  const { getInvoiceSettlement, recordPaymentForInvoice, paise } = await import(
    '../lib/billing/payments'
  )
  const { applyPaidDepositsToInvoice, listPaidDeposits } = await import(
    '../lib/payments/deposit-settlement'
  )

  const ownerPool = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })
  const appPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 })
  const app = drizzle(appPool, { schema })

  const withUser = <T,>(userId: string, fn: (tx: Db) => Promise<T>): Promise<T> =>
    app.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`)
      return fn(tx as unknown as Db)
    })

  // ── fixtures ──────────────────────────────────────────────────────────────
  let seq = 0
  const tRes = await ownerPool.query<{ id: string }>(
    `insert into tenants (slug,name,status,timezone,currency)
     values ('testbal','testbal co','active','Asia/Kolkata','INR')
     on conflict (slug) do update set status='active' returning id`,
  )
  const tenantId = tRes.rows[0].id
  const bRes = await ownerPool.query<{ id: string }>(
    `insert into branches (tenant_id,name,is_primary) values ($1,'Main',true) returning id`,
    [tenantId],
  )
  const branchId = bRes.rows[0].id
  const uRes = await ownerPool.query<{ id: string }>(
    `insert into users (email,password_hash) values ('cashier@testbal.test','x')
     on conflict (email) do update set email=excluded.email returning id`,
  )
  const userId = uRes.rows[0].id
  const mRes = await ownerPool.query<{ id: string }>(
    `insert into memberships (tenant_id,user_id,role,status) values ($1,$2,'manager','active')
     on conflict (tenant_id,user_id) do update set role='manager' returning id`,
    [tenantId, userId],
  )
  const membershipId = mRes.rows[0].id

  const rtRes = await ownerPool.query<{ id: string }>(
    `insert into resource_types (tenant_id,name,hourly_rate) values ($1,'Bay','400.00') returning id`,
    [tenantId],
  )
  const rRes = await ownerPool.query<{ id: string }>(
    `insert into resources (tenant_id,branch_id,resource_type_id,name)
     values ($1,$2,$3,'Bay 1') returning id`,
    [tenantId, branchId, rtRes.rows[0].id],
  )
  const resourceId = rRes.rows[0].id

  /** A booking worth `hours × ₹400`, with an optional PAID online deposit. */
  async function makeBooking(hours: number, depositPaid?: { amount: string; paymentId: string }) {
    seq++
    const bk = await ownerPool.query<{ id: string }>(
      `insert into bookings (tenant_id,branch_id,booking_number,customer_name,status,source,deposit)
       values ($1,$2,$3,'Guest','confirmed','online',$4) returning id`,
      [tenantId, branchId, `BK-BAL-${String(seq).padStart(3, '0')}`, depositPaid?.amount ?? '0.00'],
    )
    const bookingId = bk.rows[0].id
    const start = new Date(Date.now() + seq * 3_600_000 * 24)
    const end = new Date(start.getTime() + hours * 3_600_000)
    await ownerPool.query(
      `insert into booking_slots (tenant_id,booking_id,resource_id,starts_at,ends_at,
                                  rate_applied,slot_total,resource_name,resource_type_name)
       values ($1,$2,$3,$4,$5,'400.00',$6,'Bay 1','Bay')`,
      [tenantId, bookingId, resourceId, start, end, (hours * 400).toFixed(2)],
    )
    if (depositPaid) {
      // Exactly the state AROS-50 leaves behind: intent paid, payment id set,
      // and NO payments row (no invoice existed yet).
      await ownerPool.query(
        `insert into payment_intents (tenant_id,branch_id,booking_id,gateway_order_id,
                                      gateway_payment_id,amount,currency,status)
         values ($1,$2,$3,$4,$5,$6,'INR','paid')`,
        [tenantId, branchId, bookingId, `order_BAL${seq}`, depositPaid.paymentId, depositPaid.amount],
      )
    }
    return bookingId
  }

  const bill = (bookingId: string) =>
    withUser(userId, (tx) =>
      issueInvoiceForBooking(tx, { id: tenantId, timezone: 'Asia/Kolkata' }, { bookingId }),
    )
  const settlementOf = (invoiceId: string) =>
    withUser(userId, (tx) => getInvoiceSettlement(tx, tenantId, invoiceId))
  const tender = (invoiceId: string, method: 'cash' | 'card' | 'upi', amount: number) =>
    withUser(userId, (tx) =>
      recordPaymentForInvoice(tx, { tenantId, membershipId }, { invoiceId, method, amount }),
    )

  // ══ 1. THE TICKET'S SCENARIO ══════════════════════════════════════════════
  {
    console.log('\n── ₹800 invoice, ₹200 online deposit, then ₹400 cash + ₹200 UPI ──')
    const bookingId = await makeBooking(2, { amount: '200.00', paymentId: 'pay_BAL_TICKET' })

    const deposits = await withUser(userId, (tx) => listPaidDeposits(tx, tenantId, bookingId))
    check('the venue holds a ₹200 paid deposit before any bill exists', deposits.length === 1 && deposits[0].amount === 200)

    const invoice = await bill(bookingId)
    check('the invoice is raised for ₹800', paise(invoice.pricing.total) === 80000)
    check('…and the ₹200 deposit was carried onto it', invoice.deposits.applied.length === 1 && invoice.deposits.applied[0].amount === 200)
    check('…with nothing left unapplied', invoice.deposits.unapplied.length === 0)

    let s = await settlementOf(invoice.invoiceId)
    check('M1 reports total ₹800', s!.total === 800)
    check('…paid ₹200 — the deposit counts as a captured payment', s!.paid === 200)
    check('…BALANCE DUE ₹600', s!.balance === 600)
    check('…the invoice is still payable', s!.payable === true)
    check('…and the deposit appears as an online tender in the payment list', s!.payments.length === 1 && s!.payments[0].method === 'online' && s!.payments[0].status === 'captured')

    // The cashier settles the rest in venue.
    const cash = await tender(invoice.invoiceId, 'cash', 400)
    check('cashier takes ₹400 cash → balance ₹200', cash.balance === 200 && cash.settled === false)

    s = await settlementOf(invoice.invoiceId)
    check('…M1 agrees: paid ₹600, balance ₹200', s!.paid === 600 && s!.balance === 200)

    const upi = await tender(invoice.invoiceId, 'upi', 200)
    check('cashier takes ₹200 UPI → balance ₹0', upi.balance === 0)
    check('…and the invoice settles', upi.settled === true)

    s = await settlementOf(invoice.invoiceId)
    check('FINAL: total ₹800, captured ₹800, balance ₹0', s!.total === 800 && s!.paid === 800 && s!.balance === 0)
    check('FINAL: invoice status is paid', s!.status === 'paid')
    check('FINAL: no longer payable', s!.payable === false)
    check('FINAL: three tenders on record — online, cash, UPI', s!.payments.length === 3 && s!.payments.map((p) => p.method).sort().join(',') === 'cash,online,upi')
    check('FINAL: the invariant holds exactly in paise', paise(s!.total) - s!.payments.filter((p) => p.status === 'captured').reduce((n, p) => n + paise(Number(p.amount)), 0) === paise(s!.balance))
  }

  // ══ 2. no deposit — M1 behaviour is untouched ═════════════════════════════
  {
    const bookingId = await makeBooking(2)
    const invoice = await bill(bookingId)
    const s = await settlementOf(invoice.invoiceId)
    check('a booking with NO deposit bills ₹800 with ₹0 paid', s!.total === 800 && s!.paid === 0 && s!.balance === 800)
    check('…and carries nothing over', invoice.deposits.applied.length === 0 && invoice.deposits.unapplied.length === 0)
    const paid = await tender(invoice.invoiceId, 'cash', 800)
    check('…a single ₹800 cash tender settles it', paid.settled === true && paid.balance === 0)
  }

  // ══ 3. deposit covers the whole bill ══════════════════════════════════════
  {
    const bookingId = await makeBooking(2, { amount: '800.00', paymentId: 'pay_BAL_FULL' })
    const invoice = await bill(bookingId)
    const s = await settlementOf(invoice.invoiceId)
    check('a deposit equal to the total leaves ₹0 due', s!.total === 800 && s!.paid === 800 && s!.balance === 0)
    check('…and the invoice is already PAID when raised', s!.status === 'paid')
    check('…nothing more can be tendered against it', s!.payable === false)

    let refused = false
    try {
      await tender(invoice.invoiceId, 'cash', 1)
    } catch {
      refused = true
    }
    check('…a further tender is refused by the M1 rule', refused)
  }

  // ══ 4. deposit LARGER than the bill — surfaced, never silently dropped ════
  {
    const bookingId = await makeBooking(1, { amount: '900.00', paymentId: 'pay_BAL_OVER' })
    const invoice = await bill(bookingId)
    check('the invoice is ₹400', paise(invoice.pricing.total) === 40000)
    check('…the ₹900 deposit is NOT applied (it would overpay)', invoice.deposits.applied.length === 0)
    check('…it is reported as unapplied, for a refund decision', invoice.deposits.unapplied.length === 1 && invoice.deposits.unapplied[0].amount === 900)

    const s = await settlementOf(invoice.invoiceId)
    check('…captured never exceeds the total', paise(s!.paid) <= paise(s!.total))
    check('…the deposit stays authoritative on the intent', (await withUser(userId, (tx) => listPaidDeposits(tx, tenantId, bookingId))).length === 1)
  }

  // ══ 5. idempotency — the carry-over cannot double-count ═══════════════════
  {
    const bookingId = await makeBooking(2, { amount: '200.00', paymentId: 'pay_BAL_IDEM' })
    const invoice = await bill(bookingId)
    const before = await settlementOf(invoice.invoiceId)
    check('carried once: paid ₹200, balance ₹600', before!.paid === 200 && before!.balance === 600)

    // Re-running the carry-over (what the webhook does if a deposit is
    // confirmed after the bill was raised) must change nothing.
    const again = await withUser(userId, (tx) =>
      applyPaidDepositsToInvoice(tx, tenantId, bookingId, invoice.invoiceId),
    )
    check('a second carry-over applies nothing', again.applied.length === 0)
    const after = await settlementOf(invoice.invoiceId)
    check('…the balance is unchanged at ₹600', after!.paid === 200 && after!.balance === 600)
    check('…and there is still exactly ONE online payment row', after!.payments.filter((p) => p.method === 'online').length === 1)

    // Concurrently, too.
    const results = await Promise.allSettled([
      withUser(userId, (tx) => applyPaidDepositsToInvoice(tx, tenantId, bookingId, invoice.invoiceId)),
      withUser(userId, (tx) => applyPaidDepositsToInvoice(tx, tenantId, bookingId, invoice.invoiceId)),
      withUser(userId, (tx) => applyPaidDepositsToInvoice(tx, tenantId, bookingId, invoice.invoiceId)),
    ])
    check('three concurrent carry-overs do not error', results.every((r) => r.status === 'fulfilled'))
    const final = await settlementOf(invoice.invoiceId)
    check('…still exactly one online payment', final!.payments.filter((p) => p.method === 'online').length === 1)
    check('…and the balance is still ₹600', final!.balance === 600)

    // The DB constraint is the real guarantee, independent of the code above.
    let blocked = false
    try {
      await ownerPool.query(
        `insert into payments (tenant_id,branch_id,invoice_id,method,amount,status,gateway,gateway_payment_id)
         values ($1,$2,$3,'online','200.00','captured','razorpay','pay_BAL_IDEM')`,
        [tenantId, branchId, invoice.invoiceId],
      )
    } catch {
      blocked = true
    }
    check('a duplicate gateway payment id is refused by the unique index', blocked)
  }

  // ══ 6. multiple deposits on one booking ═══════════════════════════════════
  {
    seq++
    const bk = await ownerPool.query<{ id: string }>(
      `insert into bookings (tenant_id,branch_id,booking_number,customer_name,status,source,deposit)
       values ($1,$2,$3,'Guest','confirmed','online','300.00') returning id`,
      [tenantId, branchId, `BK-BAL-${String(seq).padStart(3, '0')}`],
    )
    const bookingId = bk.rows[0].id
    const start = new Date(Date.now() + seq * 3_600_000 * 24)
    await ownerPool.query(
      `insert into booking_slots (tenant_id,booking_id,resource_id,starts_at,ends_at,
                                  rate_applied,slot_total,resource_name,resource_type_name)
       values ($1,$2,$3,$4,$5,'400.00','800.00','Bay 1','Bay')`,
      [tenantId, bookingId, resourceId, start, new Date(start.getTime() + 2 * 3_600_000)],
    )
    for (const [n, amt] of [['1', '300.00'], ['2', '150.00']] as const) {
      await ownerPool.query(
        `insert into payment_intents (tenant_id,branch_id,booking_id,gateway_order_id,
                                      gateway_payment_id,amount,currency,status)
         values ($1,$2,$3,$4,$5,$6,'INR','paid')`,
        [tenantId, branchId, bookingId, `order_MULTI${seq}${n}`, `pay_BAL_MULTI${n}`, amt],
      )
    }

    const invoice = await bill(bookingId)
    check('two paid deposits are both carried over', invoice.deposits.applied.length === 2)
    const s = await settlementOf(invoice.invoiceId)
    check('…₹300 + ₹150 = ₹450 paid against ₹800', s!.paid === 450)
    check('…balance ₹350', s!.balance === 350)
    const rest = await tender(invoice.invoiceId, 'card', 350)
    check('…₹350 on card settles the bill', rest.settled === true && rest.balance === 0)
  }

  // ══ 7. the deposit is a real captured payment, shaped like one ════════════
  {
    const rows = await ownerPool.query(
      `select * from payments where tenant_id=$1 and gateway_payment_id='pay_BAL_TICKET'`,
      [tenantId],
    )
    const p = rows.rows[0]
    check('the carried deposit is method=online, status=captured', p.method === 'online' && p.status === 'captured')
    check('…for ₹200 as numeric(10,2)', p.amount === '200.00')
    check('…with no collecting cashier (no human took it)', p.collected_by === null)
    check('…tagged to the razorpay gateway', p.gateway === 'razorpay')
    check('…and backfilled with its originating order id', typeof p.gateway_order_id === 'string' && p.gateway_order_id.startsWith('order_BAL'))
    check('…on the right branch', p.branch_id === branchId)
  }

  // ══ 8. nothing double-counts across the whole tenant ══════════════════════
  {
    const audit = await ownerPool.query<{ invoice_id: string; total: string; captured: string; balance: string }>(
      `select i.id as invoice_id, i.total,
              coalesce(sum(p.amount) filter (where p.status='captured'),0)::text as captured,
              (i.total - coalesce(sum(p.amount) filter (where p.status='captured'),0))::text as balance
         from invoices i left join payments p on p.invoice_id = i.id and p.tenant_id = i.tenant_id
        where i.tenant_id=$1
        group by i.id, i.total`,
      [tenantId],
    )
    check('every invoice in the tenant has captured <= total', audit.rows.every((r) => Number(r.captured) <= Number(r.total)))
    check('…no negative balance anywhere', audit.rows.every((r) => Number(r.balance) >= 0))

    for (const row of audit.rows) {
      const s = await settlementOf(row.invoice_id)
      if (Number(s!.balance) !== Number(row.balance)) {
        check(`getInvoiceSettlement disagrees with raw SQL for ${row.invoice_id}`, false)
      }
    }
    check('getInvoiceSettlement agrees with raw SQL on every invoice', true)

    const dupes = await ownerPool.query<{ n: string }>(
      `select count(*)::text n from (
         select gateway_payment_id from payments
          where tenant_id=$1 and gateway_payment_id is not null
          group by gateway_payment_id having count(*) > 1) d`,
      [tenantId],
    )
    check('no gateway payment appears on two payment rows', dupes.rows[0].n === '0')
  }

  // ── cleanup ───────────────────────────────────────────────────────────────
  await ownerPool.query('delete from tenants where id=$1', [tenantId])
  await ownerPool.query(`delete from users where email='cashier@testbal.test'`)
  await ownerPool.end()
  await appPool.end()

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error('test harness error:', e instanceof Error ? `${e.name}: ${e.message}` : 'unknown')
  process.exit(1)
})
