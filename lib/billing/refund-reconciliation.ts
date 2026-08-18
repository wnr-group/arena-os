import { and, eq, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type * as schema from '@/db/schema'
import {
  customerMemberships,
  invoiceItems,
  invoices,
  loyaltyTransactions,
  payments,
  refunds,
  walletTransactions,
} from '@/db/schema'
import { LOYALTY_SOURCE } from './loyalty'
import { paise, round2 } from './pricing'
import { WALLET_SOURCE } from './wallet-payments'

/**
 * Undoing what a payment caused, when the money goes back.
 *
 * ── The defect this exists to close ─────────────────────────────────────────
 * Refunding a bill returned the money and left every side effect standing:
 *
 *   * loyalty points earned on the bill stayed in the customer's balance;
 *   * a refunded wallet TOP-UP returned the cash AND kept the credit, which
 *     duplicates the money outright;
 *   * a refunded membership purchase left the membership active.
 *
 * Each of those is a way for a customer to end up better off than before they
 * paid. This module reconciles all three, in the refund's own transaction, for
 * PARTIAL refunds as well as full ones.
 *
 * ── Why counters instead of summing the ledger ──────────────────────────────
 * Every reversal entry is keyed to the REFUND that caused it (source_id = the
 * refund), so that many partial refunds can each write one under the ledger's
 * unique index. That leaves no way to total them per invoice, so the invoice
 * carries `loyalty_points_reversed` / `wallet_credit_reversed` (migration
 * 0030). Each reconciliation writes only the DELTA between what SHOULD be
 * undone and what already has been:
 *
 *   * re-running it writes nothing (idempotent);
 *   * a later refund tops it up (cumulative);
 *   * flooring happens ONCE against the cumulative target, so three refunds of
 *     a third each reverse 10 points, not floor(10/3) × 3 = 9.
 */

type Db = NodePgDatabase<typeof schema>

export type RefundReconciliation = {
  /** Points clawed back by this refund. */
  loyaltyPointsReversed: number
  /** Wallet credit clawed back (a refunded top-up). */
  walletCreditReversed: number
  /** Membership cancelled because its purchase was fully refunded. */
  membershipCancelled: boolean
}

/** Drizzle wraps driver errors; the SQLSTATE lives on `cause`. */
function pgCode(e: unknown): string | undefined {
  let cur: unknown = e
  for (let d = 0; d < 5 && cur && typeof cur === 'object'; d++) {
    const o = cur as { code?: unknown; cause?: unknown }
    if (typeof o.code === 'string') return o.code
    cur = o.cause
  }
}

/**
 * How much of an invoice has been refunded, as a fraction of its total.
 *
 * Summed in Postgres across every refund on every payment of the invoice, so a
 * sequence of partial refunds converges on 1 exactly. Clamped to [0, 1]: a
 * ₹0 invoice cannot be fractionally refunded, and rounding must never let the
 * fraction exceed 1 and over-reverse.
 */
export async function refundedFractionOfInvoice(
  tx: Db,
  tenantId: string,
  invoiceId: string,
): Promise<{ fraction: number; refunded: number; total: number }> {
  const [row] = await tx
    .select({ total: invoices.total })
    .from(invoices)
    .where(and(eq(invoices.id, invoiceId), eq(invoices.tenantId, tenantId)))
    .limit(1)

  const total = round2(Number(row?.total ?? 0))

  const result = await tx.execute<{ refunded: string }>(sql`
    select coalesce(sum(r.amount), 0)::text as refunded
      from ${refunds} r
      join ${payments} p on p.id = r.payment_id and p.tenant_id = r.tenant_id
     where r.tenant_id = ${tenantId} and p.invoice_id = ${invoiceId}
  `)
  const refunded = round2(Number(result.rows[0]?.refunded ?? 0))

  if (paise(total) <= 0) return { fraction: refunded > 0 ? 1 : 0, refunded, total }
  return { fraction: Math.min(1, refunded / total), refunded, total }
}

/**
 * Reconcile every side effect of an invoice against how much of it has now been
 * refunded.
 *
 * Called from recordRefund() inside its transaction, and again from the void
 * path so a struck-off bill converges on "fully undone" regardless of which
 * route got it there. Safe to call repeatedly.
 *
 * `sourceId` is what the reversal entries reference — the refund for a refund,
 * the invoice for a void — so each event writes at most one entry per concern
 * under the ledger's unique index.
 */
export async function reconcileInvoiceAfterRefund(
  tx: Db,
  tenantId: string,
  invoiceId: string,
  sourceId: string,
): Promise<RefundReconciliation> {
  const out: RefundReconciliation = {
    loyaltyPointsReversed: 0,
    walletCreditReversed: 0,
    membershipCancelled: false,
  }

  const [invoice] = await tx
    .select({
      id: invoices.id,
      customerId: invoices.customerId,
      total: invoices.total,
      pointsEarned: invoices.loyaltyPointsEarned,
      pointsReversed: invoices.loyaltyPointsReversed,
      creditReversed: invoices.walletCreditReversed,
    })
    .from(invoices)
    .where(and(eq(invoices.id, invoiceId), eq(invoices.tenantId, tenantId)))
    .for('update')
    .limit(1)

  // A walk-in bill has no customer, so nothing was granted to take back.
  if (!invoice?.customerId) return out

  const { fraction } = await refundedFractionOfInvoice(tx, tenantId, invoice.id)

  // ── 1. loyalty points earned on this bill ─────────────────────────────────
  // Target: keep only the points proportional to what the customer actually
  // still paid. Floored, so a partial refund never claws back more than its
  // share, and computed against the CUMULATIVE total so repeated partials
  // converge exactly.
  if (invoice.pointsEarned > 0) {
    const keep = Math.floor(invoice.pointsEarned * (1 - fraction))
    const shouldHaveReversed = invoice.pointsEarned - keep
    const delta = shouldHaveReversed - invoice.pointsReversed

    if (delta > 0) {
      const written = await appendLedgerOnce(tx, () =>
        tx.insert(loyaltyTransactions).values({
          tenantId,
          customerId: invoice.customerId as string,
          points: -delta,
          reason: `Points reversed — ${Math.round(fraction * 100)}% of the bill refunded`,
          sourceType: LOYALTY_SOURCE.earnReversal,
          sourceId,
        }),
      )
      if (written) {
        await tx
          .update(invoices)
          .set({ loyaltyPointsReversed: invoice.pointsReversed + delta })
          .where(and(eq(invoices.id, invoice.id), eq(invoices.tenantId, tenantId)))
        out.loyaltyPointsReversed = delta
      }
    }
  }

  // ── 2. wallet credit sold by this invoice ─────────────────────────────────
  // A refunded TOP-UP must take the credit back, or the customer holds the cash
  // and the credit at once. Proportional, so a half-refunded ₹1000 top-up
  // leaves ₹500 of credit.
  const [topUpLine] = await tx
    .select({ lineTotal: invoiceItems.lineTotal })
    .from(invoiceItems)
    .where(
      and(
        eq(invoiceItems.tenantId, tenantId),
        eq(invoiceItems.invoiceId, invoice.id),
        eq(invoiceItems.kind, 'wallet_topup'),
      ),
    )
    .limit(1)

  if (topUpLine) {
    const credited = round2(Number(topUpLine.lineTotal))
    const alreadyReversed = round2(Number(invoice.creditReversed))
    const shouldHaveReversed = round2(credited * fraction)
    const delta = round2(shouldHaveReversed - alreadyReversed)

    if (paise(delta) > 0) {
      const written = await appendLedgerOnce(tx, () =>
        tx.insert(walletTransactions).values({
          tenantId,
          customerId: invoice.customerId as string,
          // NEGATIVE: taking the credit back out.
          amount: (-delta).toFixed(2),
          reason: 'Wallet top-up refunded',
          sourceType: WALLET_SOURCE.topUpReversal,
          sourceId,
        }),
      )
      if (written) {
        await tx
          .update(invoices)
          .set({ walletCreditReversed: round2(alreadyReversed + delta).toFixed(2) })
          .where(and(eq(invoices.id, invoice.id), eq(invoices.tenantId, tenantId)))
        out.walletCreditReversed = delta
      }
    }
  }

  // ── 3. a membership bought on this invoice ────────────────────────────────
  // Cancelled only on a FULL refund: you cannot hold 60% of a membership, so a
  // partial refund leaves it standing for a human to judge. Benefits stop the
  // moment status leaves 'active', because eligibility requires it.
  if (paise(round2(fraction * 100)) >= paise(100)) {
    const cancelled = await tx
      .update(customerMemberships)
      .set({ status: 'cancelled', cancelledAt: new Date() })
      .where(
        and(
          eq(customerMemberships.tenantId, tenantId),
          eq(customerMemberships.invoiceId, invoice.id),
          eq(customerMemberships.status, 'active'),
        ),
      )
      .returning({ id: customerMemberships.id })
    out.membershipCancelled = cancelled.length > 0
  }

  return out
}

/**
 * Run a ledger insert, treating a uniqueness collision as "already written".
 *
 * The unique index on (tenant, source_type, source_id) is what makes each
 * reversal happen at most once per event, even under a concurrent retry.
 */
async function appendLedgerOnce(tx: Db, insert: () => Promise<unknown>): Promise<boolean> {
  try {
    await insert()
    return true
  } catch (e) {
    if (pgCode(e) === '23505') return false
    throw e
  }
}
