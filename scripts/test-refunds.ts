/**
 * Refunds and voids — integration tests against a real database.
 *
 * Drives the same core the server actions drive (recordRefund /
 * voidInvoiceRecord) on RLS-scoped transactions through `arena_app`:
 *   - full, partial and topping-up refunds, and what each does to the payment
 *   - over-refund refused, including two managers racing for the same money
 *   - pending/failed money cannot be refunded; a refunded payment cannot again
 *   - a paid invoice cannot be voided while captured money remains
 *   - exactly one audit row per successful operation, none for a failed one
 *   - refunds RLS is manager-only, and both are tenant-scoped
 *
 *   npx tsx scripts/test-refunds.ts
 */
import { Pool } from 'pg'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { sql } from 'drizzle-orm'
import * as schema from '../db/schema'
import { issueInvoiceForBooking } from '../lib/billing/invoice'
import { recordPaymentForInvoice } from '../lib/billing/payments'
import {
  RefundError,
  outstandingCapturedForInvoice,
  recordRefund,
  refundedForPayment,
  voidInvoiceRecord,
} from '../lib/billing/refunds'
import { isManager } from '../lib/auth/roles'
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

  async function withUser<T>(userId: string, fn: (tx: Db) => Promise<T>): Promise<T> {
    return app.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`)
      return fn(tx as unknown as Db)
    })
  }

  type Actor = {
    userId: string
    tenantId: string
    membershipId: string
    branchId: string
    resourceId: string
    cashierUserId: string
    cashierMembershipId: string
  }

  async function refund(a: Actor, paymentId: string, amount: number, reason = 'Customer overcharged', as?: { userId: string; membershipId: string }) {
    const who = as ?? { userId: a.userId, membershipId: a.membershipId }
    try {
      const r = await withUser(who.userId, (tx) =>
        recordRefund(tx, { tenantId: a.tenantId, membershipId: who.membershipId }, { paymentId, amount, reason }))
      return { ok: true as const, ...r }
    } catch (e) {
      return { ok: false as const, refundErr: e instanceof RefundError, message: e instanceof Error ? e.message : String(e) }
    }
  }

  async function doVoid(a: Actor, invoiceId: string, reason = 'Incorrect bill', as?: { userId: string; membershipId: string }) {
    const who = as ?? { userId: a.userId, membershipId: a.membershipId }
    try {
      const r = await withUser(who.userId, (tx) =>
        voidInvoiceRecord(tx, { tenantId: a.tenantId, membershipId: who.membershipId }, { invoiceId, reason }))
      return { ok: true as const, ...r }
    } catch (e) {
      return { ok: false as const, refundErr: e instanceof RefundError, message: e instanceof Error ? e.message : String(e) }
    }
  }

  const auditRows = async (entityId: string) =>
    (await ownerPool.query(
      `select action, entity_type, entity_id, actor_membership_id, tenant_id, "before", "after"
         from audit_log where entity_id=$1 order by created_at`, [entityId])).rows

  const refundRows = async (paymentId: string) =>
    (await ownerPool.query('select amount, reason, created_by from refunds where payment_id=$1 order by created_at', [paymentId])).rows

  const paymentStatus = async (id: string) =>
    (await ownerPool.query('select status from payments where id=$1', [id])).rows[0].status

  const invoiceStatus = async (id: string) =>
    (await ownerPool.query('select status from invoices where id=$1', [id])).rows[0].status

  const refundSum = async (paymentId: string) =>
    (await ownerPool.query(`select coalesce(sum(amount),0)::text t from refunds where payment_id=$1`, [paymentId])).rows[0].t

  async function makeTenant(slug: string): Promise<Actor> {
    const t = await ownerPool.query<{ id: string }>(
      `insert into tenants (slug,name,status,timezone) values ($1,$2,'active',$3)
       on conflict (slug) do update set name=excluded.name returning id`, [slug, `${slug} co`, TZ])
    const tenantId = t.rows[0].id
    const b = await ownerPool.query<{ id: string }>(
      `insert into branches (tenant_id,name,is_primary) values ($1,'Main',true)
       on conflict (tenant_id,name) do update set is_primary=true returning id`, [tenantId])
    const mkUser = async (email: string, role: string) => {
      const u = await ownerPool.query<{ id: string }>(
        `insert into users (email,password_hash) values ($1,'x')
         on conflict (email) do update set email=excluded.email returning id`, [email])
      await ownerPool.query(
        `insert into memberships (tenant_id,user_id,role,status) values ($1,$2,$3,'active')
         on conflict (tenant_id,user_id) do update set role=excluded.role, status='active'`,
        [tenantId, u.rows[0].id, role])
      const m = await ownerPool.query<{ id: string }>(
        'select id from memberships where tenant_id=$1 and user_id=$2', [tenantId, u.rows[0].id])
      return { userId: u.rows[0].id, membershipId: m.rows[0].id }
    }
    const manager = await mkUser(`manager@${slug}.test`, 'manager')
    const cashier = await mkUser(`cashier@${slug}.test`, 'cashier')
    const rt = await ownerPool.query<{ id: string }>(
      `insert into resource_types (tenant_id,name,hourly_rate) values ($1,'PS5','500.00')
       on conflict (tenant_id,name) do update set hourly_rate='500.00' returning id`, [tenantId])
    const res = await ownerPool.query<{ id: string }>(
      `insert into resources (tenant_id,branch_id,resource_type_id,name) values ($1,$2,$3,'S1')
       on conflict (tenant_id,name) do update set name='S1' returning id`, [tenantId, b.rows[0].id, rt.rows[0].id])
    return {
      userId: manager.userId, tenantId, membershipId: manager.membershipId,
      branchId: b.rows[0].id, resourceId: res.rows[0].id,
      cashierUserId: cashier.userId, cashierMembershipId: cashier.membershipId,
    }
  }

  let seq = 0
  /** An issued invoice for `total`, optionally settled with one cash payment. */
  async function makeInvoice(a: Actor, total: number) {
    const n = ++seq
    const bk = await ownerPool.query<{ id: string }>(
      `insert into bookings (tenant_id,branch_id,booking_number,status,subtotal,total)
       values ($1,$2,$3,'confirmed','0','0') returning id`, [a.tenantId, a.branchId, `RF-${n}`])
    const s = new Date(Date.UTC(2035, 0, n, 4, 0, 0))
    await ownerPool.query(
      `insert into booking_slots (tenant_id,booking_id,resource_id,starts_at,ends_at,rate_applied,slot_total,resource_name,resource_type_name,active)
       values ($1,$2,$3,$4,$5,$6,$7,'S1','PS5',true)`,
      [a.tenantId, bk.rows[0].id, a.resourceId, s, new Date(s.getTime() + 2 * 3600_000), (total / 2).toFixed(2), total.toFixed(2)])
    const issued = await withUser(a.userId, (tx) =>
      issueInvoiceForBooking(tx, { id: a.tenantId, timezone: TZ }, { bookingId: bk.rows[0].id }))
    return issued.invoiceId
  }

  const payFor = (a: Actor, invoiceId: string, method: 'cash' | 'card' | 'upi', amount: number) =>
    withUser(a.userId, (tx) =>
      recordPaymentForInvoice(tx, { tenantId: a.tenantId, membershipId: a.membershipId }, { invoiceId, method, amount }))

  const A = await makeTenant('testrefa')
  const B = await makeTenant('testrefb')
  for (const t of [A, B]) {
    await ownerPool.query('delete from audit_log where tenant_id=$1', [t.tenantId])
    await ownerPool.query('delete from invoices where tenant_id=$1', [t.tenantId])
    await ownerPool.query('delete from bookings where tenant_id=$1', [t.tenantId])
    await ownerPool.query('delete from sequences where tenant_id=$1', [t.tenantId])
  }

  // ── 0. role model ─────────────────────────────────────────────────────────
  check('isManager: owner/manager only', isManager('owner') && isManager('manager') && !isManager('cashier') && !isManager('floor_staff'))

  // ── 1. full refund ────────────────────────────────────────────────────────
  {
    const inv = await makeInvoice(A, 1000)
    const p = await payFor(A, inv, 'cash', 1000)
    const r = await refund(A, p.paymentId, 1000, 'Duplicate payment')
    check('R1 a full ₹1000 refund is accepted', r.ok)
    check('R1 payment.status = refunded', (await paymentStatus(p.paymentId)) === 'refunded')
    check('R1 one refund row at 1000.00', (await refundRows(p.paymentId)).length === 1 && (await refundSum(p.paymentId)) === '1000.00')
    check('R1 the reason is stored on the refund', (await refundRows(p.paymentId))[0].reason === 'Duplicate payment')
    check('R1 created_by is the acting manager', (await refundRows(p.paymentId))[0].created_by === A.membershipId)
    check('R1 nothing left refundable', r.ok && r.remainingRefundable === 0 && r.fullyRefunded)

    const audits = await auditRows(p.paymentId)
    check('R1 exactly ONE audit row', audits.length === 1)
    check("R1 action = 'refund', entity_type = 'payment'", audits[0].action === 'refund' && audits[0].entity_type === 'payment')
    check('R1 audit entity_id is the payment', audits[0].entity_id === p.paymentId)
    check('R1 audit actor is the manager membership', audits[0].actor_membership_id === A.membershipId)
    check('R1 audit tenant is the payment tenant', audits[0].tenant_id === A.tenantId)
    check('R1 audit BEFORE captures the pre-state', audits[0].before?.payment?.status === 'captured' && audits[0].before?.refunded_amount === '0.00' && audits[0].before?.remaining_refundable === '1000.00')
    check('R1 audit AFTER captures the post-state', audits[0].after?.payment?.status === 'refunded' && audits[0].after?.refunded_amount === '1000.00' && audits[0].after?.remaining_refundable === '0.00')
    check('R1 audit AFTER carries the reason', audits[0].after?.reason === 'Duplicate payment')
  }

  // ── 2. partial, then topping up to full ───────────────────────────────────
  {
    const inv = await makeInvoice(A, 1000)
    const p = await payFor(A, inv, 'cash', 1000)

    const first = await refund(A, p.paymentId, 400)
    check('R2 a partial ₹400 refund is accepted', first.ok)
    check('R2 payment stays CAPTURED after a partial refund', (await paymentStatus(p.paymentId)) === 'captured')
    check('R2 ₹600 remains refundable', first.ok && first.remainingRefundable === 600)
    check('R2 one audit row so far', (await auditRows(p.paymentId)).length === 1)

    const second = await refund(A, p.paymentId, 600)
    check('R2 a second ₹600 refund tops it up', second.ok)
    check('R2 payment.status = refunded once the total is reached', (await paymentStatus(p.paymentId)) === 'refunded')
    check('R2 refunds total 1000.00 over 2 rows', (await refundSum(p.paymentId)) === '1000.00' && (await refundRows(p.paymentId)).length === 2)
    check('R2 two audit rows, one per refund', (await auditRows(p.paymentId)).length === 2)

    const audits = await auditRows(p.paymentId)
    check('R2 the second audit BEFORE shows 400 already refunded', audits[1].before?.refunded_amount === '400.00' && audits[1].before?.remaining_refundable === '600.00')
    check('R2 …and AFTER shows the payment fully refunded', audits[1].after?.refunded_amount === '1000.00' && audits[1].after?.payment?.status === 'refunded')
  }

  // ── 3. over-refund ────────────────────────────────────────────────────────
  {
    const inv = await makeInvoice(A, 1000)
    const p = await payFor(A, inv, 'cash', 1000)
    await refund(A, p.paymentId, 400)

    const over = await refund(A, p.paymentId, 700)
    check('R3 ₹700 against a ₹600 remainder is REFUSED', !over.ok && over.refundErr && /exceeds the remaining refundable/i.test(over.message))
    check('R3 …quoting the 600.00 that remains', !over.ok && over.message.includes('600.00'))
    check('R3 no extra refund row', (await refundRows(p.paymentId)).length === 1)
    check('R3 refunds still total 400.00', (await refundSum(p.paymentId)) === '400.00')
    check('R3 payment still captured', (await paymentStatus(p.paymentId)) === 'captured')
    check('R3 NO audit row for the refused refund', (await auditRows(p.paymentId)).length === 1)

    const paisaOver = await refund(A, p.paymentId, 600.01)
    check('R3 even one paisa over is refused', !paisaOver.ok)
    const exact = await refund(A, p.paymentId, 600)
    check('R3 the exact remainder IS accepted', exact.ok)
  }

  // ── 4. invalid amounts and states ─────────────────────────────────────────
  {
    const inv = await makeInvoice(A, 500)
    const p = await payFor(A, inv, 'cash', 500)

    check('R4 a zero refund is refused', !(await refund(A, p.paymentId, 0)).ok)
    check('R4 a negative refund is refused', !(await refund(A, p.paymentId, -100)).ok)
    check('R4 a blank reason is refused', !(await refund(A, p.paymentId, 100, '   ')).ok)
    check('R4 …and none of those wrote a row', (await refundRows(p.paymentId)).length === 0)
    check('R4 …nor an audit row', (await auditRows(p.paymentId)).length === 0)

    await refund(A, p.paymentId, 500)
    const again = await refund(A, p.paymentId, 1)
    check('R4 a fully refunded payment cannot be refunded again', !again.ok && /already been fully refunded/i.test(again.message))
    check('R4 …and no extra audit row', (await auditRows(p.paymentId)).length === 1)

    const missing = await refund(A, UUID, 100)
    check('R4 an unknown payment id → "Payment not found."', !missing.ok && /payment not found/i.test(missing.message))
  }

  // ── 5. money that never reached the till ──────────────────────────────────
  {
    const inv = await makeInvoice(A, 500)
    for (const status of ['pending', 'failed']) {
      const row = await ownerPool.query<{ id: string }>(
        `insert into payments (tenant_id,branch_id,invoice_id,method,amount,status)
         values ($1,$2,$3,'card','200.00',$4) returning id`, [A.tenantId, A.branchId, inv, status])
      const r = await refund(A, row.rows[0].id, 100)
      check(`R5 a '${status}' payment cannot be refunded`, !r.ok && r.refundErr && /only a captured payment/i.test(r.message))
      check(`R5 …and wrote no refund or audit row`, (await refundRows(row.rows[0].id)).length === 0 && (await auditRows(row.rows[0].id)).length === 0)
    }
  }

  // ── 6. tenant isolation ───────────────────────────────────────────────────
  {
    const inv = await makeInvoice(A, 500)
    const p = await payFor(A, inv, 'cash', 500)

    const cross = await refund(B, p.paymentId, 100)
    check("R6 tenant B cannot refund tenant A's payment", !cross.ok && /payment not found/i.test(cross.message))
    check('R6 …and no refund row was created', (await refundRows(p.paymentId)).length === 0)

    const crossVoid = await doVoid(B, inv)
    check("R6 tenant B cannot void tenant A's invoice", !crossVoid.ok && /invoice not found/i.test(crossVoid.message))
    check('R6 …and the invoice is untouched', (await invoiceStatus(inv)) !== 'void')
    check('R6 …with no audit rows written anywhere', (await auditRows(p.paymentId)).length === 0 && (await auditRows(inv)).length === 0)
  }

  // ── 7. refunds RLS is manager-only ────────────────────────────────────────
  {
    const inv = await makeInvoice(A, 500)
    const p = await payFor(A, inv, 'cash', 500)

    // The action layer uses requireManager(); this proves the DB layer holds
    // independently, by driving the core as the CASHIER's membership.
    const asCashier = await refund(A, p.paymentId, 100, 'sneaky', { userId: A.cashierUserId, membershipId: A.cashierMembershipId })
    check('R7 a CASHIER cannot insert a refund (refunds_manager_write RLS)', !asCashier.ok)
    check('R7 …and no refund row exists', (await refundRows(p.paymentId)).length === 0)
    check('R7 …and no audit row was committed either (same transaction)', (await auditRows(p.paymentId)).length === 0)

    const cashierRead = await withUser(A.cashierUserId, (tx) =>
      tx.execute(sql`select id from payments where id = ${p.paymentId}`))
    check('R7 a cashier CAN still read the payment (member select)', cashierRead.rows.length === 1)

    const managerOk = await refund(A, p.paymentId, 100)
    check('R7 a MANAGER can refund the same payment', managerOk.ok)
  }

  // ── 8. void ───────────────────────────────────────────────────────────────
  {
    // issued, no payments → voidable
    const clean = await makeInvoice(A, 800)
    const v = await doVoid(A, clean, 'Wrong booking')
    check('V1 an issued invoice with no payments can be voided', v.ok)
    check('V1 invoice.status = void', (await invoiceStatus(clean)) === 'void')
    const audits = await auditRows(clean)
    check('V1 exactly ONE audit row', audits.length === 1)
    check("V1 action = 'void_invoice', entity_type = 'invoice'", audits[0].action === 'void_invoice' && audits[0].entity_type === 'invoice')
    check('V1 audit actor + tenant are server-derived', audits[0].actor_membership_id === A.membershipId && audits[0].tenant_id === A.tenantId)
    check('V1 audit BEFORE has the old status and the number/total', audits[0].before?.status === 'issued' && audits[0].before?.total === '800.00' && Boolean(audits[0].before?.invoice_number))
    check("V1 audit AFTER has status 'void' and the reason", audits[0].after?.status === 'void' && audits[0].after?.reason === 'Wrong booking')

    const twice = await doVoid(A, clean)
    check('V2 voiding an already-void invoice is REFUSED', !twice.ok && /already void/i.test(twice.message))
    check('V2 …and writes no second audit row', (await auditRows(clean)).length === 1)

    const blank = await doVoid(A, await makeInvoice(A, 100), '  ')
    check('V3 a blank reason is refused', !blank.ok)
  }

  // ── 9. the paid-invoice rule ──────────────────────────────────────────────
  {
    // Partially paid → the captured part blocks the void.
    const partial = await makeInvoice(A, 800)
    const pp = await payFor(A, partial, 'cash', 300)
    const blocked = await doVoid(A, partial)
    check('V4 an invoice with a partial captured payment CANNOT be voided', !blocked.ok && /cannot be voided until all captured payments are refunded/i.test(blocked.message))
    check('V4 …quoting the 300.00 still held', !blocked.ok && blocked.message.includes('300.00'))
    check('V4 …and the invoice keeps its status', (await invoiceStatus(partial)) === 'issued')
    check('V4 …with no audit row', (await auditRows(partial)).length === 0)

    // A PARTIAL refund is not enough — the remainder still blocks it.
    await refund(A, pp.paymentId, 100)
    const stillBlocked = await doVoid(A, partial)
    check('V5 a PARTIAL refund does not unblock the void (200.00 still held)', !stillBlocked.ok && stillBlocked.message.includes('200.00'))

    await refund(A, pp.paymentId, 200)
    const nowOk = await doVoid(A, partial, 'Customer cancellation')
    check('V5 once the payment is fully refunded the void succeeds', nowOk.ok)
    check('V5 …invoice.status = void', (await invoiceStatus(partial)) === 'void')
  }

  // ── 10. multi-tender paid invoice ─────────────────────────────────────────
  {
    const inv = await makeInvoice(A, 800)
    const cash = await payFor(A, inv, 'cash', 500)
    const upi = await payFor(A, inv, 'upi', 300)
    check('V6 the invoice is paid', (await invoiceStatus(inv)) === 'paid')

    const blocked = await doVoid(A, inv)
    check('V6 a PAID invoice cannot be voided while money is captured', !blocked.ok && blocked.message.includes('800.00'))

    await refund(A, cash.paymentId, 500)
    const halfway = await doVoid(A, inv)
    check('V6 refunding only the cash leg is not enough (300.00 remains)', !halfway.ok && halfway.message.includes('300.00'))

    await refund(A, upi.paymentId, 300)
    const outstanding = await withUser(A.userId, (tx) => outstandingCapturedForInvoice(tx, A.tenantId, inv))
    check('V6 outstanding captured is now 0', outstanding === 0)
    const done = await doVoid(A, inv, 'Customer cancellation')
    check('V6 with BOTH legs refunded the void succeeds', done.ok)
    check('V6 …invoice.status = void', (await invoiceStatus(inv)) === 'void')
    check('V6 …and the void audit records it came from "paid"', (await auditRows(inv))[0].before?.status === 'paid')
  }

  // ── 11. concurrency ───────────────────────────────────────────────────────
  {
    // ₹700 + ₹500 against ₹1000: together they would over-refund.
    const inv = await makeInvoice(A, 1000)
    const p = await payFor(A, inv, 'cash', 1000)
    const race = await Promise.all([refund(A, p.paymentId, 700), refund(A, p.paymentId, 500)])
    check('C1 two simultaneous refunds of 700 + 500 on ₹1000 → exactly ONE succeeds', race.filter((r) => r.ok).length === 1)
    const total = Number(await refundSum(p.paymentId))
    check('C1 refunds total never exceeds the payment (≤ 1000)', total <= 1000)
    check('C1 …and equals the winner’s amount (700 or 500)', total === 700 || total === 500)
    check('C1 exactly one audit row', (await auditRows(p.paymentId)).length === 1)

    // Two halves that DO fit must both land.
    const inv2 = await makeInvoice(A, 1000)
    const p2 = await payFor(A, inv2, 'cash', 1000)
    const both = await Promise.all([refund(A, p2.paymentId, 500), refund(A, p2.paymentId, 500)])
    check('C2 two simultaneous ₹500 refunds on ₹1000 → BOTH succeed', both.every((r) => r.ok))
    check('C2 refunds total exactly 1000.00', (await refundSum(p2.paymentId)) === '1000.00')
    check('C2 payment ends refunded', (await paymentStatus(p2.paymentId)) === 'refunded')
    check('C2 two audit rows', (await auditRows(p2.paymentId)).length === 2)

    // Five racers on ₹1000, ₹300 each: at most three fit.
    const inv3 = await makeInvoice(A, 1000)
    const p3 = await payFor(A, inv3, 'cash', 1000)
    const many = await Promise.all(Array.from({ length: 5 }, () => refund(A, p3.paymentId, 300)))
    check('C3 5 simultaneous ₹300 refunds on ₹1000 → exactly 3 succeed', many.filter((r) => r.ok).length === 3)
    check('C3 refunds total 900.00, never above 1000', (await refundSum(p3.paymentId)) === '900.00')
  }

  // ── 12. global invariants ─────────────────────────────────────────────────
  {
    const breached = await ownerPool.query(
      `select p.id from payments p
         join (select payment_id, sum(amount) t from refunds group by payment_id) r on r.payment_id = p.id
        where p.tenant_id = any($1) and r.t > p.amount`, [[A.tenantId, B.tenantId]])
    check('NO payment anywhere has refunds exceeding its amount', breached.rows.length === 0)

    const voidedWithMoney = await ownerPool.query(
      `select i.id from invoices i
        where i.tenant_id = any($1) and i.status = 'void'
          and exists (
            select 1 from payments p
             where p.invoice_id = i.id and p.status = 'captured'
               and p.amount > coalesce((select sum(amount) from refunds where payment_id = p.id), 0)
          )`, [[A.tenantId, B.tenantId]])
    check('NO void invoice still holds unrefunded captured money', voidedWithMoney.rows.length === 0)

    const refundedTotals = await ownerPool.query(
      `select p.id from payments p
        where p.tenant_id = any($1) and p.status = 'refunded'
          and coalesce((select sum(amount) from refunds where payment_id = p.id),0) <> p.amount`, [[A.tenantId, B.tenantId]])
    check("every payment marked 'refunded' is refunded to exactly its amount", refundedTotals.rows.length === 0)

    const orphanAudits = await ownerPool.query(
      `select id from audit_log where tenant_id = any($1) and (actor_membership_id is null or "before" is null or "after" is null)`,
      [[A.tenantId, B.tenantId]])
    check('every audit row has an actor and both before/after snapshots', orphanAudits.rows.length === 0)

    const actions = await ownerPool.query<{ action: string }>(
      `select distinct action from audit_log where tenant_id = any($1)`, [[A.tenantId, B.tenantId]])
    check("only 'refund' and 'void_invoice' actions were written", actions.rows.every((r) => ['refund', 'void_invoice'].includes(r.action)))
  }

  // ── 13. refundedForPayment helper ─────────────────────────────────────────
  {
    const inv = await makeInvoice(A, 400)
    const p = await payFor(A, inv, 'cash', 400)
    check('refundedForPayment is 0 before any refund', (await withUser(A.userId, (tx) => refundedForPayment(tx, A.tenantId, p.paymentId))) === 0)
    await refund(A, p.paymentId, 150)
    check('…and 150 after a partial refund', (await withUser(A.userId, (tx) => refundedForPayment(tx, A.tenantId, p.paymentId))) === 150)
  }

  // ── cleanup ───────────────────────────────────────────────────────────────
  await ownerPool.query('delete from tenants where id = any($1)', [[A.tenantId, B.tenantId]])
  await ownerPool.query(`delete from users where email like '%@testref%.test'`)
  await ownerPool.end()
  await appPool.end()

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
