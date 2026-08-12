/**
 * Split payments — integration tests against a real database.
 *
 * Drives the same core the server action drives (recordPaymentForInvoice) on an
 * RLS-scoped transaction through `arena_app`:
 *   - cash / card / UPI settle an invoice, singly or split across tenders
 *   - the invoice flips to 'paid' exactly when the last rupee lands
 *   - overpayment is refused, and refused again under concurrency
 *   - only 'captured' rows count toward the balance
 *   - 'online' and 'wallet' can never be recorded here
 *   - another tenant's invoice is invisible and unpayable
 *
 *   npx tsx scripts/test-payments.ts
 */
import { Pool } from 'pg'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { sql } from 'drizzle-orm'
import * as schema from '../db/schema'
import { issueInvoiceForBooking } from '../lib/billing/invoice'
import {
  PaymentError,
  POS_PAYMENT_METHODS,
  getInvoiceSettlement,
  paise,
  recordPaymentForInvoice,
  recordPaymentInputSchema,
  type PosPaymentMethod,
} from '../lib/billing/payments'
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
  const appPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 })
  const app = drizzle(appPool, { schema })

  /** Same contract as db/index.ts:withUser — an RLS-scoped transaction. */
  async function withUser<T>(userId: string, fn: (tx: Db) => Promise<T>): Promise<T> {
    return app.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`)
      return fn(tx as unknown as Db)
    })
  }

  type Actor = { userId: string; tenantId: string; membershipId: string }

  /** Record one tender as `actor`; returns the result or the error message. */
  async function pay(actor: Actor, invoiceId: string, method: string, amount: number) {
    try {
      const r = await withUser(actor.userId, (tx) =>
        recordPaymentForInvoice(
          tx,
          { tenantId: actor.tenantId, membershipId: actor.membershipId },
          { invoiceId, method: method as PosPaymentMethod, amount },
        ),
      )
      return { ok: true as const, ...r }
    } catch (e) {
      return {
        ok: false as const,
        payment: e instanceof PaymentError,
        message: e instanceof Error ? e.message : String(e),
      }
    }
  }

  const settlementOf = (actor: Actor, invoiceId: string) =>
    withUser(actor.userId, (tx) => getInvoiceSettlement(tx, actor.tenantId, invoiceId))

  const rowCount = async (invoiceId: string) =>
    Number((await ownerPool.query('select count(*)::int n from payments where invoice_id=$1', [invoiceId])).rows[0].n)

  const capturedSum = async (invoiceId: string) =>
    (await ownerPool.query(
      `select coalesce(sum(amount),0)::text t from payments where invoice_id=$1 and status='captured'`,
      [invoiceId],
    )).rows[0].t

  const invoiceStatus = async (invoiceId: string) =>
    (await ownerPool.query('select status from invoices where id=$1', [invoiceId])).rows[0].status

  // ── fixtures ──────────────────────────────────────────────────────────────
  async function makeTenant(slug: string): Promise<Actor & { branchId: string; resourceId: string }> {
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
    await ownerPool.query(
      `insert into memberships (tenant_id,user_id,role,status,full_name)
       values ($1,$2,'owner','active','Till Operator')
       on conflict (tenant_id,user_id) do update set role='owner', status='active', full_name='Till Operator'`,
      [tenantId, u.rows[0].id],
    )
    const m = await ownerPool.query<{ id: string }>(
      'select id from memberships where tenant_id=$1 and user_id=$2',
      [tenantId, u.rows[0].id],
    )
    const rt = await ownerPool.query<{ id: string }>(
      `insert into resource_types (tenant_id,name,hourly_rate) values ($1,'PS5','400.00')
       on conflict (tenant_id,name) do update set hourly_rate='400.00' returning id`,
      [tenantId],
    )
    const res = await ownerPool.query<{ id: string }>(
      `insert into resources (tenant_id,branch_id,resource_type_id,name) values ($1,$2,$3,'Station 1')
       on conflict (tenant_id,name) do update set branch_id=excluded.branch_id returning id`,
      [tenantId, b.rows[0].id, rt.rows[0].id],
    )
    return {
      userId: u.rows[0].id,
      tenantId,
      membershipId: m.rows[0].id,
      branchId: b.rows[0].id,
      resourceId: res.rows[0].id,
    }
  }

  let seq = 0
  /** An ISSUED invoice for exactly `total` rupees (2h at total/2 an hour). */
  async function makeInvoice(
    t: Actor & { branchId: string; resourceId: string },
    total: number,
  ): Promise<string> {
    const n = ++seq
    const bk = await ownerPool.query<{ id: string }>(
      `insert into bookings (tenant_id,branch_id,booking_number,status,subtotal,total)
       values ($1,$2,$3,'confirmed','0','0') returning id`,
      [t.tenantId, t.branchId, `PAY-${n}`],
    )
    const start = new Date(Date.UTC(2031, 0, 1 + n, 4, 0, 0))
    await ownerPool.query(
      `insert into booking_slots
         (tenant_id,booking_id,resource_id,starts_at,ends_at,rate_applied,slot_total,
          resource_name,resource_type_name,active)
       values ($1,$2,$3,$4,$5,$6,$7,'Station 1','PS5',true)`,
      [t.tenantId, bk.rows[0].id, t.resourceId, start, new Date(start.getTime() + 2 * 3600_000), (total / 2).toFixed(2), total.toFixed(2)],
    )
    const issued = await withUser(t.userId, (tx) =>
      issueInvoiceForBooking(tx, { id: t.tenantId, timezone: TZ }, { bookingId: bk.rows[0].id }),
    )
    return issued.invoiceId
  }

  const A = await makeTenant('testpaya')
  const B = await makeTenant('testpayb')
  for (const t of [A, B]) {
    await ownerPool.query('delete from invoices where tenant_id=$1', [t.tenantId])
    await ownerPool.query('delete from bookings where tenant_id=$1', [t.tenantId])
    await ownerPool.query('delete from sequences where tenant_id=$1', [t.tenantId])
  }

  // ── 0. input contract ─────────────────────────────────────────────────────
  check('POS methods are exactly cash, card, upi', POS_PAYMENT_METHODS.join(',') === 'cash,card,upi')
  for (const m of ['cash', 'card', 'upi']) {
    check(`schema ACCEPTS method '${m}'`, recordPaymentInputSchema.safeParse({ invoiceId: UUID, method: m, amount: 100 }).success)
  }
  for (const m of ['online', 'wallet', 'crypto', '', 'CASH']) {
    check(`schema REJECTS method '${m}'`, !recordPaymentInputSchema.safeParse({ invoiceId: UUID, method: m, amount: 100 }).success)
  }
  for (const [label, amount] of [['zero', 0], ['negative', -50], ['NaN', NaN], ['Infinity', Infinity], ['non-numeric', 'abc'], ['over numeric(10,2)', 1e12]] as const) {
    check(`schema REJECTS ${label} amount`, !recordPaymentInputSchema.safeParse({ invoiceId: UUID, method: 'cash', amount }).success)
  }
  check('schema REJECTS a malformed invoiceId', !recordPaymentInputSchema.safeParse({ invoiceId: 'not-a-uuid', method: 'cash', amount: 100 }).success)
  check(
    'paise() converts money to integer paise (0.1+0.2 → 30, 800 → 80000)',
    paise(0.1 + 0.2) === 30 && paise(800) === 80000 && paise(0.01) === 1,
  )
  check(
    'paise() rounds half-up before scaling (299.995 → 300.00 → 30000)',
    paise(299.995) === 30000 && paise(299.994) === 29999,
  )

  // ── 1. Example 1 — one payment settles the invoice ────────────────────────
  {
    const inv = await makeInvoice(A, 800)
    const r = await pay(A, inv, 'cash', 800)
    check('E1 ₹800 invoice, cash ₹800 → accepted', r.ok)
    check('E1 paid = 800, balance = 0', r.ok && r.paid === 800 && r.balance === 0)
    check('E1 invoice status = paid', (await invoiceStatus(inv)) === 'paid')
    check('E1 captured sum = 800.00', (await capturedSum(inv)) === '800.00')

    const row = (await ownerPool.query('select method, amount, status, collected_by, tenant_id, branch_id from payments where invoice_id=$1', [inv])).rows[0]
    check("E1 method stored as 'cash'", row.method === 'cash')
    check("E1 status stored as 'captured'", row.status === 'captured')
    check('E1 amount stored at 2dp (800.00)', row.amount === '800.00')
    check('E1 collected_by = the acting membership', row.collected_by === A.membershipId)
    check('E1 tenant_id + branch_id derived server-side', row.tenant_id === A.tenantId && row.branch_id === A.branchId)
  }

  // ── 2. Example 2 — two tenders ────────────────────────────────────────────
  {
    const inv = await makeInvoice(A, 800)
    const one = await pay(A, inv, 'cash', 500)
    check('E2 cash ₹500 of ₹800 → accepted', one.ok)
    check('E2 balance now 300, invoice still issued', one.ok && one.balance === 300 && !one.settled)
    check('E2 invoice status is still issued', (await invoiceStatus(inv)) === 'issued')

    const two = await pay(A, inv, 'upi', 300)
    check('E2 UPI ₹300 → accepted', two.ok)
    check('E2 paid = 800, balance = 0, settled', two.ok && two.paid === 800 && two.balance === 0 && two.settled)
    check('E2 invoice status = paid', (await invoiceStatus(inv)) === 'paid')
    check('E2 two payment rows', (await rowCount(inv)) === 2)
  }

  // ── 3. Example 3 — three tenders, all methods ─────────────────────────────
  {
    const inv = await makeInvoice(A, 1000)
    const a = await pay(A, inv, 'cash', 400)
    const b = await pay(A, inv, 'card', 350)
    const c = await pay(A, inv, 'upi', 250)
    check('E3 ₹1000: cash 400 + card 350 + upi 250 all accepted', a.ok && b.ok && c.ok)
    check('E3 paid = 1000, balance = 0', c.ok && c.paid === 1000 && c.balance === 0)
    check('E3 invoice status = paid', (await invoiceStatus(inv)) === 'paid')
    check('E3 captured sum = 1000.00 over 3 rows', (await capturedSum(inv)) === '1000.00' && (await rowCount(inv)) === 3)

    const s = await settlementOf(A, inv)
    check('E3 settlement reports all three tenders', s?.payments.length === 3)
    check('E3 settlement is no longer payable', s?.payable === false)
    check('E3 settlement carries the collector name', s?.payments[0].collectedByName === 'Till Operator')
  }

  // ── 4. Example 4 — partial payment ────────────────────────────────────────
  {
    const inv = await makeInvoice(A, 800)
    const r = await pay(A, inv, 'cash', 300)
    check('E4 ₹800 invoice, cash ₹300 → accepted', r.ok)
    check('E4 paid = 300, balance = 500', r.ok && r.paid === 300 && r.balance === 500)
    check('E4 invoice stays issued', (await invoiceStatus(inv)) === 'issued')
    const s = await settlementOf(A, inv)
    check('E4 settlement: total 800, paid 300, balance 500, still payable', s?.total === 800 && s?.paid === 300 && s?.balance === 500 && s.payable === true)
  }

  // ── 5. Example 5 — overpayment ────────────────────────────────────────────
  {
    const inv = await makeInvoice(A, 800)
    await pay(A, inv, 'cash', 500)
    const over = await pay(A, inv, 'upi', 350)
    check('E5 ₹350 against a ₹300 balance → REJECTED', !over.ok && over.payment)
    check('E5 …with the exceeds-balance message quoting 300.00', !over.ok && /exceeds the remaining balance/i.test(over.message) && over.message.includes('300.00'))
    check('E5 the amount was NOT silently reduced — still one row', (await rowCount(inv)) === 1)
    check('E5 paid remains 500.00', (await capturedSum(inv)) === '500.00')
    check('E5 invoice remains issued', (await invoiceStatus(inv)) === 'issued')

    const exact = await pay(A, inv, 'upi', 300)
    check('E5 the exact ₹300 balance IS accepted', exact.ok && exact.settled)
    check('E5 …and settles the invoice', (await invoiceStatus(inv)) === 'paid')

    // One paisa over is still over.
    const inv2 = await makeInvoice(A, 800)
    const paisaOver = await pay(A, inv2, 'cash', 800.01)
    check('E5 ₹800.01 on a ₹800 invoice → REJECTED (one paisa counts)', !paisaOver.ok && paisaOver.payment)
    check('E5 …and no row was written', (await rowCount(inv2)) === 0)
  }

  // ── 6. Example 6 — already paid ───────────────────────────────────────────
  {
    const inv = await makeInvoice(A, 800)
    await pay(A, inv, 'cash', 800)
    const again = await pay(A, inv, 'cash', 100)
    check('E6 a payment against a PAID invoice → REJECTED', !again.ok && again.payment)
    check('E6 …with the already-paid message', !again.ok && /already paid/i.test(again.message))
    check('E6 …and no second row', (await rowCount(inv)) === 1)
    check('E6 captured sum unchanged at 800.00', (await capturedSum(inv)) === '800.00')
  }

  // ── 7. only 'captured' counts ─────────────────────────────────────────────
  {
    const inv = await makeInvoice(A, 800)
    for (const st of ['pending', 'failed', 'refunded']) {
      await ownerPool.query(
        `insert into payments (tenant_id,branch_id,invoice_id,method,amount,status)
         values ($1,$2,$3,'card','200.00',$4)`,
        [A.tenantId, A.branchId, inv, st],
      )
    }
    const s = await settlementOf(A, inv)
    check('pending/failed/refunded rows do NOT reduce the balance', s?.paid === 0 && s?.balance === 800)
    const full = await pay(A, inv, 'cash', 800)
    check('…so the full ₹800 is still accepted', full.ok && full.settled)
    check('captured sum is 800.00 despite ₹600 of non-captured rows', (await capturedSum(inv)) === '800.00')
    check('all four rows exist on the invoice', (await rowCount(inv)) === 4)
  }

  // ── 8. invoice state ──────────────────────────────────────────────────────
  {
    const draft = await makeInvoice(A, 500)
    await ownerPool.query(`update invoices set status='draft' where id=$1`, [draft])
    const rd = await pay(A, draft, 'cash', 100)
    check('a DRAFT invoice cannot take payment', !rd.ok && rd.payment && /not been issued/i.test(rd.message))
    check('…and no row was written', (await rowCount(draft)) === 0)

    const voided = await makeInvoice(A, 500)
    await ownerPool.query(`update invoices set status='void' where id=$1`, [voided])
    const rv = await pay(A, voided, 'cash', 100)
    check('a VOID invoice cannot take payment', !rv.ok && rv.payment && /voided/i.test(rv.message))
    check('…and no row was written', (await rowCount(voided)) === 0)

    const missing = await pay(A, UUID, 'cash', 100)
    check('an unknown invoice id → "Invoice not found."', !missing.ok && /invoice not found/i.test(missing.message))
  }

  // ── 9. method guard in the core itself ────────────────────────────────────
  {
    const inv = await makeInvoice(A, 500)
    for (const m of ['online', 'wallet']) {
      const r = await pay(A, inv, m, 100)
      check(`the core REJECTS '${m}' even though the DB enum allows it`, !r.ok && r.payment && /cash, card or upi/i.test(r.message))
    }
    check('…and no row was written by either attempt', (await rowCount(inv)) === 0)
  }

  // ── 10. amount edge cases at the core ─────────────────────────────────────
  {
    const inv = await makeInvoice(A, 300)
    const zero = await pay(A, inv, 'cash', 0)
    check('the core REJECTS a zero amount', !zero.ok && zero.payment)
    const neg = await pay(A, inv, 'cash', -100)
    check('the core REJECTS a negative amount', !neg.ok && neg.payment)
    check('…and neither wrote a row', (await rowCount(inv)) === 0)

    // Paise precision: 299.99 + 0.01 must settle exactly, not 299.999999…
    const a = await pay(A, inv, 'cash', 299.99)
    check('₹299.99 of a ₹300 invoice → accepted, balance 0.01', a.ok && a.balance === 0.01)
    check('…invoice still issued at a 1-paisa balance', (await invoiceStatus(inv)) === 'issued')
    const b = await pay(A, inv, 'upi', 0.01)
    check('₹0.01 settles it exactly', b.ok && b.settled && b.balance === 0)
    check('…invoice status = paid', (await invoiceStatus(inv)) === 'paid')
    check('…captured sum is exactly 300.00', (await capturedSum(inv)) === '300.00')
  }

  // ── 11. tenant isolation ──────────────────────────────────────────────────
  {
    const invA = await makeInvoice(A, 800)
    const cross = await pay(B, invA, 'cash', 800)
    check("tenant B cannot pay tenant A's invoice (RLS ⇒ not found)", !cross.ok && cross.payment && /invoice not found/i.test(cross.message))
    check('…and no payment row was created', (await rowCount(invA)) === 0)

    // Even naming tenant A's id does not help: RLS scopes on the USER.
    const spoof = await pay({ ...B, tenantId: A.tenantId }, invA, 'cash', 800)
    check("tenant B cannot pay it by claiming tenant A's tenant id", !spoof.ok)
    check('…still no payment row', (await rowCount(invA)) === 0)

    const readCross = await settlementOf(B, invA)
    check("tenant B cannot even READ tenant A's settlement", readCross === null)

    // And B's own invoice works, proving the refusals were not incidental.
    const invB = await makeInvoice(B, 400)
    const own = await pay(B, invB, 'card', 400)
    check('tenant B CAN pay its own invoice', own.ok && own.settled)

    const bRows = (await ownerPool.query('select tenant_id from payments where invoice_id=$1', [invB])).rows
    check('…and that row carries tenant B', bRows.length === 1 && bRows[0].tenant_id === B.tenantId)
  }

  // ── 12. concurrency — the row lock must prevent overpayment ───────────────
  {
    // Two ₹500 tenders on a ₹800 invoice: together they would be ₹1000.
    const inv = await makeInvoice(A, 800)
    const race = await Promise.all([pay(A, inv, 'cash', 500), pay(A, inv, 'upi', 500)])
    check('two simultaneous ₹500 tenders on ₹800 → exactly ONE succeeds', race.filter((r) => r.ok).length === 1)
    check('…the loser is told it exceeds the balance', race.some((r) => !r.ok && /exceeds the remaining balance/i.test(r.message)))
    check('…captured sum is 500.00, never 1000.00', (await capturedSum(inv)) === '500.00')
    check('…and only one row exists', (await rowCount(inv)) === 1)

    // Two ₹400 tenders that DO fit: both must land and settle the invoice.
    const inv2 = await makeInvoice(A, 800)
    const both = await Promise.all([pay(A, inv2, 'cash', 400), pay(A, inv2, 'card', 400)])
    check('two simultaneous ₹400 tenders on ₹800 → BOTH succeed', both.every((r) => r.ok))
    check('…captured sum is exactly 800.00', (await capturedSum(inv2)) === '800.00')
    check('…invoice status = paid', (await invoiceStatus(inv2)) === 'paid')

    // Five racers on a ₹1000 invoice, ₹300 each: at most three can fit.
    const inv3 = await makeInvoice(A, 1000)
    const many = await Promise.all(Array.from({ length: 5 }, () => pay(A, inv3, 'cash', 300)))
    const okCount = many.filter((r) => r.ok).length
    check('5 simultaneous ₹300 tenders on ₹1000 → exactly 3 succeed', okCount === 3)
    check('…captured sum is 900.00, never above the ₹1000 total', (await capturedSum(inv3)) === '900.00')
  }

  // ── 13. the invariant, across every invoice this run touched ──────────────
  {
    const bad = await ownerPool.query<{ n: string }>(
      `select i.id
         from invoices i
         join (select invoice_id, sum(amount) paid from payments
                where status='captured' group by invoice_id) p on p.invoice_id = i.id
        where i.tenant_id = any($1) and p.paid > i.total`,
      [[A.tenantId, B.tenantId]],
    )
    check('NO invoice anywhere has captured payments exceeding its total', bad.rows.length === 0)

    const mismatched = await ownerPool.query(
      `select i.id from invoices i
         left join (select invoice_id, sum(amount) paid from payments
                     where status='captured' group by invoice_id) p on p.invoice_id = i.id
        where i.tenant_id = any($1) and i.status='paid'
          and coalesce(p.paid,0) <> i.total`,
      [[A.tenantId, B.tenantId]],
    )
    check("every invoice marked 'paid' is captured to exactly its total", mismatched.rows.length === 0)
  }

  // ── cleanup ───────────────────────────────────────────────────────────────
  await ownerPool.query('delete from tenants where id = any($1)', [[A.tenantId, B.tenantId]])
  await ownerPool.query(`delete from users where email like '%@testpay%.test'`)
  await ownerPool.end()
  await appPool.end()

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
