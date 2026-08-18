/**
 * Refunds and voids — money going back, and bills being struck off.
 *
 * Both are manager-only, both are append-to-the-trail operations, and both take
 * a `tx` (like ./invoice.ts and ./payments.ts) so the caller supplies one
 * RLS-scoped transaction and every write here commits or rolls back together.
 *
 * They are deliberately SEPARATE operations. voidInvoiceRecord() never refunds
 * anything: a bill with money still in the till cannot be struck off, and the
 * manager must refund first. That keeps each movement of money its own
 * decision with its own audit row.
 */
import { and, eq, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type * as schema from '@/db/schema'
import { auditLog, invoices, payments, refunds } from '@/db/schema'
import { paise } from './payments'
import { reverseLoyaltyForVoidedInvoice } from './loyalty'
import { reconcileInvoiceAfterRefund } from './refund-reconciliation'
import { restoreWalletOnRefund } from './wallet-payments'
import { round2 } from './pricing'

type Db = NodePgDatabase<typeof schema>

/** Refund/void rule violations the manager should see verbatim. */
export class RefundError extends Error {}

/** Only a captured payment is money that can come back out. */
export const REFUNDABLE_PAYMENT_STATUS = 'captured'

export type AuditActor = { tenantId: string; membershipId: string }

/**
 * Append one audit row.
 *
 * `tenant_id` and `actor_membership_id` come from the server-derived context
 * and the locked database row — never from the client. The table has only
 * select + insert policies and only select + insert grants, so this trail can
 * be added to and never rewritten.
 */
async function writeAudit(
  tx: Db,
  actor: AuditActor,
  entry: {
    action: string
    entityType: string
    entityId: string
    before: Record<string, unknown>
    after: Record<string, unknown>
  },
): Promise<void> {
  await tx.insert(auditLog).values({
    tenantId: actor.tenantId,
    actorMembershipId: actor.membershipId,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId,
    before: entry.before,
    after: entry.after,
  })
}

/** Rupees already refunded against one payment. Summed exactly, in Postgres. */
export async function refundedForPayment(
  tx: Db,
  tenantId: string,
  paymentId: string,
): Promise<number> {
  const [row] = await tx
    .select({ total: sql<string>`coalesce(sum(${refunds.amount}), 0)::text` })
    .from(refunds)
    .where(and(eq(refunds.tenantId, tenantId), eq(refunds.paymentId, paymentId)))
  return round2(Number(row?.total ?? 0))
}

/** Refunded totals for every payment on an invoice, keyed by payment id. */
export async function refundsByPayment(
  tx: Db,
  tenantId: string,
  invoiceId: string,
): Promise<Map<string, string>> {
  const rows = await tx.execute<{ payment_id: string; total: string }>(sql`
    select r.payment_id, sum(r.amount)::text as total
      from refunds r
      join payments p on p.id = r.payment_id and p.tenant_id = r.tenant_id
     where r.tenant_id = ${tenantId} and p.invoice_id = ${invoiceId}
     group by r.payment_id
  `)
  return new Map(rows.rows.map((r) => [r.payment_id, round2(Number(r.total)).toFixed(2)]))
}

/**
 * Money still held against an invoice: captured payments less what has been
 * refunded on them. A payment already marked 'refunded' contributes nothing.
 *
 * This — not the invoice's own status — is what decides whether a bill may be
 * voided, so a partially refunded payment (which stays 'captured') still blocks
 * the void for its remainder.
 */
export async function outstandingCapturedForInvoice(
  tx: Db,
  tenantId: string,
  invoiceId: string,
): Promise<number> {
  const result = await tx.execute<{ outstanding: string }>(sql`
    select coalesce(sum(p.amount - coalesce(r.total, 0)), 0)::text as outstanding
      from payments p
      left join (
        select payment_id, sum(amount) as total
          from refunds where tenant_id = ${tenantId}
         group by payment_id
      ) r on r.payment_id = p.id
     where p.tenant_id = ${tenantId}
       and p.invoice_id = ${invoiceId}
       and p.status = ${REFUNDABLE_PAYMENT_STATUS}
  `)
  return round2(Number(result.rows[0]?.outstanding ?? 0))
}

export type RecordRefundInput = { paymentId: string; amount: number; reason: string }

export type RecordedRefund = {
  refundId: string
  paymentId: string
  invoiceId: string
  bookingId: string | null
  refundedTotal: number
  remainingRefundable: number
  paymentStatus: string
  fullyRefunded: boolean
}

/**
 * Refund part or all of one captured payment.
 *
 * Opens on `SELECT … FOR UPDATE` against the payment. That lock is what stops
 * two managers over-refunding: the second transaction blocks until the first
 * commits and then re-reads a refunded total that already includes it, instead
 * of the stale figure it would otherwise sum. The invariant it protects is
 * `sum(refunds.amount) <= payments.amount`.
 */
export async function recordRefund(
  tx: Db,
  actor: AuditActor,
  input: RecordRefundInput,
): Promise<RecordedRefund> {
  // ── 1. lock the payment ───────────────────────────────────────────────────
  // RLS applies, so another tenant's payment id simply returns no row.
  const [payment] = await tx
    .select({
      id: payments.id,
      invoiceId: payments.invoiceId,
      amount: payments.amount,
      status: payments.status,
      method: payments.method,
      branchId: payments.branchId,
      collectedBy: payments.collectedBy,
    })
    .from(payments)
    .where(and(eq(payments.id, input.paymentId), eq(payments.tenantId, actor.tenantId)))
    .for('update')
    .limit(1)

  if (!payment) throw new RefundError('Payment not found.')

  // ── 2. is this money that can come back? ──────────────────────────────────
  if (payment.status === 'refunded') {
    throw new RefundError('Payment has already been fully refunded.')
  }
  if (payment.status !== REFUNDABLE_PAYMENT_STATUS) {
    // pending / failed money never reached the till, so it cannot leave it.
    throw new RefundError('Only a captured payment can be refunded.')
  }

  // ── 3. what is left to refund ─────────────────────────────────────────────
  // Read AFTER the lock, so it cannot go stale before the insert.
  const paymentAmount = round2(Number(payment.amount))
  const alreadyRefunded = await refundedForPayment(tx, actor.tenantId, payment.id)
  const refundable = round2(paymentAmount - alreadyRefunded)

  if (paise(refundable) <= 0) throw new RefundError('Payment has already been fully refunded.')

  const amount = round2(input.amount)
  if (paise(amount) <= 0) throw new RefundError('Enter a refund amount greater than zero.')

  // Compared in paise, never rupees. The amount is NOT silently trimmed to the
  // remainder — the manager re-enters an explicit figure.
  if (paise(alreadyRefunded) + paise(amount) > paise(paymentAmount)) {
    throw new RefundError(
      `Refund amount exceeds the remaining refundable amount. ${refundable.toFixed(2)} remains.`,
    )
  }

  const reason = input.reason.trim()
  if (!reason) throw new RefundError('A reason is required.')

  // ── 4. the refund ─────────────────────────────────────────────────────────
  const [refund] = await tx
    .insert(refunds)
    .values({
      tenantId: actor.tenantId,
      paymentId: payment.id,
      amount: amount.toFixed(2),
      reason,
      createdBy: actor.membershipId,
    })
    .returning({ id: refunds.id })

  // ── 4b. wallet restoration ────────────────────────────────────────────────
  // A wallet payment is money that came OUT of the ledger, so refunding it must
  // put the money BACK there rather than into the till. Without this a wallet
  // payment could be refunded financially while the customer's balance stayed
  // wrong — the exact inconsistency the ledger exists to prevent.
  //
  // In this transaction, so the refund and the credit cannot come apart. A
  // no-op for cash/card/UPI, which come back the way they went in.
  const walletRestored = await restoreWalletOnRefund(tx, actor.tenantId, {
    method: payment.method,
    invoiceId: payment.invoiceId,
    refundId: refund.id,
    amount,
    createdBy: actor.membershipId,
  })

  // ── 4c. undo what the payment caused ──────────────────────────────────────
  // Money going back must take its side effects with it: loyalty points earned
  // on this bill, wallet credit a refunded TOP-UP sold, and a membership whose
  // purchase is now fully refunded. Proportional for partial refunds, and
  // cumulative across several of them.
  //
  // In this transaction, so a refund can never exist without its reversal.
  const reconciliation = await reconcileInvoiceAfterRefund(
    tx,
    actor.tenantId,
    payment.invoiceId,
    refund.id,
  )

  // ── 5. payment status ─────────────────────────────────────────────────────
  // Only a FULL refund flips the status; a partial one leaves it 'captured',
  // because part of that tender is still money the business holds.
  const refundedTotal = round2(alreadyRefunded + amount)
  const fullyRefunded = paise(refundedTotal) >= paise(paymentAmount)
  const newStatus = fullyRefunded ? 'refunded' : payment.status

  if (fullyRefunded) {
    await tx
      .update(payments)
      .set({ status: 'refunded' })
      .where(and(eq(payments.id, payment.id), eq(payments.tenantId, actor.tenantId)))
  }

  // ── 6. the trail — same transaction, so it cannot drift from the money ────
  await writeAudit(tx, actor, {
    action: 'refund',
    entityType: 'payment',
    entityId: payment.id,
    before: {
      payment: { id: payment.id, status: payment.status, amount: paymentAmount.toFixed(2) },
      refunded_amount: alreadyRefunded.toFixed(2),
      remaining_refundable: refundable.toFixed(2),
    },
    after: {
      payment: { id: payment.id, status: newStatus, amount: paymentAmount.toFixed(2) },
      refunded_amount: refundedTotal.toFixed(2),
      remaining_refundable: round2(paymentAmount - refundedTotal).toFixed(2),
      refund: { id: refund.id, amount: amount.toFixed(2), method: payment.method },
      wallet_restored: walletRestored,
      loyalty_points_reversed: reconciliation.loyaltyPointsReversed,
      wallet_credit_reversed: reconciliation.walletCreditReversed.toFixed(2),
      membership_cancelled: reconciliation.membershipCancelled,
      reason,
    },
  })

  // For revalidating the pages this touches; read from the invoice, not sent.
  const [invoice] = await tx
    .select({ bookingId: invoices.bookingId })
    .from(invoices)
    .where(and(eq(invoices.id, payment.invoiceId), eq(invoices.tenantId, actor.tenantId)))
    .limit(1)

  return {
    refundId: refund.id,
    paymentId: payment.id,
    invoiceId: payment.invoiceId,
    bookingId: invoice?.bookingId ?? null,
    refundedTotal,
    remainingRefundable: round2(paymentAmount - refundedTotal),
    paymentStatus: newStatus,
    fullyRefunded,
  }
}

export type VoidInvoiceInput = { invoiceId: string; reason: string }

export type VoidedInvoice = {
  invoiceId: string
  invoiceNumber: string
  bookingId: string | null
  previousStatus: string
}

/**
 * Strike an invoice off.
 *
 * Never refunds anything. A bill whose captured payments are not fully refunded
 * is refused, because "VOID" next to ₹1,000 captured and ₹0 refunded is not a
 * state the books can be in. The manager refunds first, then voids.
 */
export async function voidInvoiceRecord(
  tx: Db,
  actor: AuditActor,
  input: VoidInvoiceInput,
): Promise<VoidedInvoice> {
  const [invoice] = await tx
    .select({
      id: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
      status: invoices.status,
      total: invoices.total,
      bookingId: invoices.bookingId,
    })
    .from(invoices)
    .where(and(eq(invoices.id, input.invoiceId), eq(invoices.tenantId, actor.tenantId)))
    .for('update')
    .limit(1)

  if (!invoice) throw new RefundError('Invoice not found.')
  if (invoice.status === 'void') throw new RefundError('This invoice is already void.')

  const reason = input.reason.trim()
  if (!reason) throw new RefundError('A reason is required.')

  // THE rule. Judged on money, not on the invoice's own status, so a partially
  // refunded payment still blocks the void for whatever remains.
  const outstanding = await outstandingCapturedForInvoice(tx, actor.tenantId, invoice.id)
  if (paise(outstanding) > 0) {
    throw new RefundError(
      `Invoice cannot be voided until all captured payments are refunded. ${outstanding.toFixed(2)} is still held.`,
    )
  }

  await tx
    .update(invoices)
    .set({ status: 'void' })
    .where(and(eq(invoices.id, invoice.id), eq(invoices.tenantId, actor.tenantId)))

  // Loyalty goes back the way it came: points earned on a struck-off bill are
  // taken back, and points redeemed against it are returned. Without this a
  // customer could keep 100 points from a bill that never stood, or lose points
  // they spent on one. In this transaction, so it cannot come apart from the
  // void; idempotent per invoice via the ledger's unique index.
  // A void follows a full refund, so the proportional reconciliation above has
  // usually already reversed the earn; this converges on the remainder (and is a
  // no-op when it is already zero) and additionally RETURNS any points the
  // customer redeemed against a bill that no longer stands.
  await reconcileInvoiceAfterRefund(tx, actor.tenantId, invoice.id, invoice.id)
  const loyaltyReversal = await reverseLoyaltyForVoidedInvoice(tx, actor.tenantId, invoice.id)

  await writeAudit(tx, actor, {
    action: 'void_invoice',
    entityType: 'invoice',
    entityId: invoice.id,
    before: {
      status: invoice.status,
      invoice_number: invoice.invoiceNumber,
      total: invoice.total,
    },
    after: {
      status: 'void',
      invoice_number: invoice.invoiceNumber,
      total: invoice.total,
      reason,
      loyalty_earn_reversed: loyaltyReversal.earnReversed,
      loyalty_redeem_returned: loyaltyReversal.redeemReturned,
    },
  })

  return {
    invoiceId: invoice.id,
    invoiceNumber: invoice.invoiceNumber,
    bookingId: invoice.bookingId,
    previousStatus: invoice.status,
  }
}
