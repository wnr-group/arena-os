/**
 * What a refund and a void report back — the figures their confirmations quote.
 *
 * Both used to close their dialog and refresh the page in silence: no
 * confirmation, nothing to say whether money had actually moved or a bill had
 * been struck off. The manager had to re-read the invoice to find out.
 *
 * refundPayment() now returns the amounts recordRefund() worked out from the
 * LOCKED payment row — what is still refundable, and what has been refunded in
 * total — and voidInvoice() returns the invoice number it struck off. The
 * toasts quote those rather than the browser's idea of what it just did. They
 * are the values pinned here; the toasts themselves are one line of
 * presentation over them.
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs --import ./scripts/next-runtime-hook.mjs scripts/test-refund-notification.ts
 */
import { createHash, randomBytes } from 'node:crypto'
import { Pool } from 'pg'
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
  loadEnv()
  const { refundPayment, voidInvoice } = await import('../lib/actions/refunds')

  const owner = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })

  const slug = 'testrefundnotif'
  const t = await owner.query<{ id: string }>(
    `insert into tenants (slug,name,status,timezone) values ($1,$2,'active',$3)
     on conflict (slug) do update set name=excluded.name returning id`, [slug, `${slug} co`, TZ])
  const tenantId = t.rows[0].id
  const b = await owner.query<{ id: string }>(
    `insert into branches (tenant_id,name,is_primary) values ($1,'Main',true)
     on conflict (tenant_id,name) do update set is_primary=true returning id`, [tenantId])
  const branchId = b.rows[0].id
  const u = await owner.query<{ id: string }>(
    `insert into users (email,password_hash) values ($1,'x')
     on conflict (email) do update set email=excluded.email returning id`, [`owner@${slug}.test`])
  const userId = u.rows[0].id
  await owner.query(
    `insert into memberships (tenant_id,user_id,role,status) values ($1,$2,'owner','active')
     on conflict (tenant_id,user_id) do update set role='owner', status='active'`, [tenantId, userId])

  // requireManager() runs for real against a real session row.
  const token = randomBytes(32).toString('hex')
  await owner.query(
    `insert into sessions (id, user_id, expires_at) values ($1,$2, now() + interval '1 day')
     on conflict (id) do nothing`,
    [createHash('sha256').update(token).digest('hex'), userId])
  const g = globalThis as { __ARENA_TEST_SESSION?: string; __ARENA_TEST_HEADERS?: Record<string, string> }
  g.__ARENA_TEST_SESSION = token
  g.__ARENA_TEST_HEADERS = { 'x-tenant-slug': slug }

  const wipe = async () => {
    await owner.query(
      `delete from refunds where payment_id in (select id from payments where tenant_id=$1)`, [tenantId])
    await owner.query('delete from payments where tenant_id=$1', [tenantId])
    await owner.query('delete from invoices where tenant_id=$1', [tenantId])
  }
  await wipe()

  let seq = 0
  /** An invoice with one captured tender, ready to refund. */
  async function paidInvoice(total: number, method = 'cash') {
    seq++
    const inv = await owner.query<{ id: string }>(
      `insert into invoices (tenant_id,branch_id,invoice_number,status,subtotal,discount,
                             tax_total,total,issued_at)
       values ($1,$2,$3,'paid',$4,0,0,$4, now()) returning id`,
      [tenantId, branchId, `RN-${seq}`, total.toFixed(2)])
    const p = await owner.query<{ id: string }>(
      `insert into payments (tenant_id,branch_id,invoice_id,method,amount,status)
       values ($1,$2,$3,$4::payment_method,$5,'captured') returning id`,
      [tenantId, branchId, inv.rows[0].id, method, total.toFixed(2)])
    return { invoiceId: inv.rows[0].id, paymentId: p.rows[0].id }
  }

  // ══ 1. a full refund ═════════════════════════════════════════════════════
  console.log('\n── refunding a ₹500 payment in full ──')
  {
    await wipe()
    const { paymentId } = await paidInvoice(500)
    const r = await refundPayment({ paymentId, amount: 500, reason: 'customer cancelled' })

    check('it succeeds', r.success === true && !r.error)
    check('…and says the payment is fully refunded', r.fullyRefunded === true)
    check('…with ₹500.00 refunded in total', r.refundedTotal === '500.00')
    check('…and nothing left to refund', r.remainingRefundable === '0.00')
    check('…carrying a refund id for the audit trail', typeof r.refundId === 'string')
  }

  // ══ 2. a partial refund ══════════════════════════════════════════════════
  console.log('\n── refunding ₹200 of a ₹500 payment ──')
  {
    await wipe()
    const { paymentId } = await paidInvoice(500)
    const r = await refundPayment({ paymentId, amount: 200, reason: 'one game unplayed' })

    check('it succeeds', r.success === true)
    check('…and does NOT claim the payment is fully refunded', r.fullyRefunded === false)
    check('…₹200.00 refunded so far', r.refundedTotal === '200.00')
    check('…₹300.00 still refundable — the figure the toast quotes',
      r.remainingRefundable === '300.00')
  }

  // ══ 3. a second partial refund finishes it ═══════════════════════════════
  console.log('\n── then the remaining ₹300 ──')
  {
    const p = await owner.query<{ id: string }>(
      `select id from payments where tenant_id=$1 limit 1`, [tenantId])
    const r = await refundPayment({ paymentId: p.rows[0].id, amount: 300, reason: 'rest of it' })

    check('it succeeds', r.success === true)
    check('…and NOW reports fully refunded', r.fullyRefunded === true)
    check('…₹500.00 refunded in total across both', r.refundedTotal === '500.00')
    check('…nothing left', r.remainingRefundable === '0.00')
  }

  // ══ 4. refusals carry a readable reason, and no figures ══════════════════
  // The dialog keeps these inline and stays open, so there is nothing to
  // announce — but the message has to be one a manager can act on.
  console.log('\n── refusals ──')
  {
    await wipe()
    const { paymentId } = await paidInvoice(100)

    const tooMuch = await refundPayment({ paymentId, amount: 250, reason: 'over' })
    check('over-refunding is refused', Boolean(tooMuch.error) && !tooMuch.success)
    check('…and says how much remains', (tooMuch.error ?? '').includes('100.00'))
    check('…with no figures to announce', tooMuch.remainingRefundable === undefined)

    const noReason = await refundPayment({ paymentId, amount: 50, reason: '   ' })
    check('a blank reason is refused', Boolean(noReason.error))

    const zero = await refundPayment({ paymentId, amount: 0, reason: 'nothing' })
    check('a zero amount is refused', Boolean(zero.error))

    const stillThere = await owner.query<{ c: string }>(
      `select coalesce(sum(amount),0)::text c from refunds where payment_id=$1`, [paymentId])
    check('…and none of them moved any money', stillThere.rows[0].c === '0')
  }

  // ══ 5. an already-exhausted payment ══════════════════════════════════════
  console.log('\n── refunding what is already gone ──')
  {
    await wipe()
    const { paymentId } = await paidInvoice(100)
    await refundPayment({ paymentId, amount: 100, reason: 'first' })
    const again = await refundPayment({ paymentId, amount: 100, reason: 'again' })
    check('a second full refund is refused', Boolean(again.error))
    check('…saying it has already been refunded',
      (again.error ?? '').toLowerCase().includes('already'))
  }

  // ══ 6. voiding an invoice ════════════════════════════════════════════════
  console.log('\n── voiding ──')
  {
    await wipe()
    // Nothing collected, so there is nothing to refund first.
    seq++
    const inv = await owner.query<{ id: string; invoice_number: string }>(
      `insert into invoices (tenant_id,branch_id,invoice_number,status,subtotal,discount,
                             tax_total,total,issued_at)
       values ($1,$2,$3,'issued','400.00',0,0,'400.00', now())
       returning id, invoice_number`,
      [tenantId, branchId, `RN-VOID-${seq}`])

    const r = await voidInvoice({ invoiceId: inv.rows[0].id, reason: 'billed in error' })
    check('it succeeds', r.success === true && !r.error)
    check('…and names the invoice it struck off — what the toast shows',
      r.invoiceNumber === inv.rows[0].invoice_number)

    const after = await owner.query<{ status: string }>(
      `select status from invoices where id=$1`, [inv.rows[0].id])
    check('…and the invoice really is void', after.rows[0].status === 'void')
  }

  console.log('\n── voiding is refused while money is still held ──')
  {
    await wipe()
    const { invoiceId, paymentId } = await paidInvoice(600)
    const blocked = await voidInvoice({ invoiceId, reason: 'try it' })
    check('a bill with captured money cannot be voided', Boolean(blocked.error))
    check('…and the refusal says how much is held',
      (blocked.error ?? '').includes('600.00'))
    check('…with no invoice number to announce', blocked.invoiceNumber === undefined)

    // Refund first, then it goes through — the order the dialog tells you to
    // follow, and the reason the two are separate operations.
    await refundPayment({ paymentId, amount: 600, reason: 'refund before void' })
    const ok = await voidInvoice({ invoiceId, reason: 'now void it' })
    check('once refunded, the void succeeds', ok.success === true)
    check('…and names the invoice', typeof ok.invoiceNumber === 'string')
  }

  await wipe()
  await owner.query('delete from sessions where user_id=$1', [userId])
  g.__ARENA_TEST_SESSION = undefined
  g.__ARENA_TEST_HEADERS = undefined
  await owner.end()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
