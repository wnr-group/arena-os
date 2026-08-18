import { and, eq, isNotNull, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type * as schema from '@/db/schema'
import { paymentIntents, payments } from '@/db/schema'
import { paise, recordVerifiedGatewayPayment } from '@/lib/billing/payments'
import { round2 } from '@/lib/billing/pricing'

/**
 * Carrying a paid online deposit onto a booking's invoice — AROS-51.
 *
 * ── This module deliberately contains NO balance arithmetic ─────────────────
 * The balance invariant already exists, once, in M1:
 *
 *     invoice.total − sum(payments where status='captured') = balance due
 *
 * getInvoiceSettlement() is the only thing that computes it, PaymentPanel is
 * the only thing that renders it, and neither is touched by this ticket. All
 * this module does is make sure a deposit the venue already holds appears in
 * that sum, as an ordinary captured payment row with method='online'. Once it
 * does, ₹800 total − ₹200 deposit = ₹600 due falls out of the existing code
 * with nothing new to keep in step.
 *
 * ── Why the carry-over needs its own step ───────────────────────────────────
 * A deposit is taken at booking time (AROS-49) and confirmed by webhook
 * (AROS-50), both usually BEFORE a bill exists. `payments.invoice_id` is NOT
 * NULL, so there is nothing to attach it to at that moment; the money lives on
 * `payment_intents` until an invoice appears. This runs at the two points where
 * an invoice and a paid deposit first coexist:
 *
 *   * invoice creation — the normal order (deposit first, bill later);
 *   * the webhook — when a deposit is confirmed after the bill was raised.
 *
 * Both call THIS function, so the two paths cannot drift apart, and
 * idx_payments_gateway_payment (0025) guarantees they cannot both apply the
 * same money if they race.
 *
 * No `import 'server-only'`, matching lib/billing/invoice.ts and
 * lib/billing/payments.ts: this takes a `tx`, opens no connection, reads no
 * environment and holds no credential. It is a pure transactional core, which
 * is what lets the billing test scripts exercise it directly.
 */

type Db = NodePgDatabase<typeof schema>

const GATEWAY = 'razorpay' as const

export type CarriedDeposit = {
  intentId: string
  gatewayPaymentId: string
  /** Rupees, 2dp. */
  amount: number
  paymentId: string
}

export type UnappliedDeposit = {
  intentId: string
  gatewayPaymentId: string
  amount: number
  /** Why it could not be carried over. Always needs a human. */
  reason: 'exceeds-invoice-balance' | 'invoice-not-payable'
}

export type DepositCarryResult = {
  applied: CarriedDeposit[]
  /**
   * Deposits the venue holds that could NOT be put on this invoice — almost
   * always because the deposit is larger than the bill, which means a refund is
   * owed. Surfaced rather than silently dropped.
   */
  unapplied: UnappliedDeposit[]
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
 * Every settled deposit for a booking — the money the venue is already holding.
 *
 * Read-only, and safe to call outside a billing transaction. Used by the
 * carry-over below and available to any surface that wants to show "₹200
 * already paid online" before a bill exists.
 */
export async function listPaidDeposits(
  tx: Db,
  tenantId: string,
  bookingId: string,
): Promise<{ intentId: string; gatewayPaymentId: string; amount: number }[]> {
  const rows = await tx
    .select({
      intentId: paymentIntents.id,
      gatewayPaymentId: paymentIntents.gatewayPaymentId,
      amount: paymentIntents.amount,
    })
    .from(paymentIntents)
    .where(
      and(
        eq(paymentIntents.tenantId, tenantId),
        eq(paymentIntents.bookingId, bookingId),
        eq(paymentIntents.status, 'paid'),
        isNotNull(paymentIntents.gatewayPaymentId),
      ),
    )
    .orderBy(sql`${paymentIntents.createdAt} asc`)

  return rows.map((r) => ({
    intentId: r.intentId,
    gatewayPaymentId: r.gatewayPaymentId as string,
    amount: round2(Number(r.amount)),
  }))
}

/**
 * Carry every paid, not-yet-applied deposit for a booking onto an invoice.
 *
 * Runs entirely in the caller's transaction, so the invoice, its items and the
 * deposit payment commit or roll back together — a bill can never be raised
 * showing a deposit that was not actually recorded, or vice versa.
 *
 * Idempotent at BOTH layers. It skips a deposit whose gateway payment id is
 * already on a payments row, and if a concurrent path inserts one between that
 * check and this insert, the unique index raises 23505 and it is treated as
 * already applied. Calling this twice for the same invoice is a no-op.
 *
 * Settling the invoice to 'paid' when the deposit covers the whole total is
 * handled by recordVerifiedGatewayPayment(), the same M1 code the cashier's
 * tenders go through — the overpayment rule and the status transition are not
 * reimplemented here.
 */
export async function applyPaidDepositsToInvoice(
  tx: Db,
  tenantId: string,
  bookingId: string,
  invoiceId: string,
): Promise<DepositCarryResult> {
  const deposits = await listPaidDeposits(tx, tenantId, bookingId)
  const result: DepositCarryResult = { applied: [], unapplied: [] }
  if (deposits.length === 0) return result

  for (const deposit of deposits) {
    // Already carried over? Cheap check first; the unique index below is the
    // authority under concurrency.
    const [existing] = await tx
      .select({ id: payments.id })
      .from(payments)
      .where(
        and(
          eq(payments.tenantId, tenantId),
          eq(payments.gatewayPaymentId, deposit.gatewayPaymentId),
        ),
      )
      .limit(1)
    if (existing) continue

    if (paise(deposit.amount) <= 0) continue

    let recorded: { paymentId: string; settled: boolean } | null
    try {
      // The shared M1 path: locks the invoice, re-reads capturedTotal(), and
      // applies the same `alreadyPaid + amount <= total` rule in paise that a
      // cashier's tender is held to. Returns null rather than throwing when the
      // invoice cannot absorb the money.
      recorded = await recordVerifiedGatewayPayment(tx, {
        tenantId,
        invoiceId,
        amount: deposit.amount,
        gateway: GATEWAY,
        gatewayOrderId: '',
        gatewayPaymentId: deposit.gatewayPaymentId,
      })
    } catch (e) {
      // 23505 = another path carried this exact payment over first. Not an
      // error: the money is on the invoice, which is all we wanted.
      if (pgCode(e) === '23505') continue
      throw e
    }

    if (recorded) {
      result.applied.push({
        intentId: deposit.intentId,
        gatewayPaymentId: deposit.gatewayPaymentId,
        amount: deposit.amount,
        paymentId: recorded.paymentId,
      })
    } else {
      // The venue holds this money but the bill cannot take it — the deposit is
      // larger than the total, or the invoice is draft/void/already settled.
      // Reported so a cashier can see a refund is owed instead of the deposit
      // quietly vanishing from the reckoning.
      result.unapplied.push({
        intentId: deposit.intentId,
        gatewayPaymentId: deposit.gatewayPaymentId,
        amount: deposit.amount,
        reason: 'exceeds-invoice-balance',
      })
    }
  }

  return result
}

/**
 * The gateway order id a carried-over deposit came from.
 *
 * applyPaidDepositsToInvoice() writes an empty `gateway_order_id` because it is
 * carrying money already reconciled on the intent; this backfills it from the
 * intent so the payments row is self-describing for a dashboard lookup. Kept
 * separate so the carry-over stays a single, obvious insert.
 */
export async function backfillDepositOrderIds(
  tx: Db,
  tenantId: string,
  invoiceId: string,
): Promise<void> {
  await tx.execute(sql`
    update ${payments} p
       set gateway_order_id = i.gateway_order_id
      from ${paymentIntents} i
     where p.tenant_id = ${tenantId}
       and p.invoice_id = ${invoiceId}
       and p.gateway_payment_id = i.gateway_payment_id
       and p.tenant_id = i.tenant_id
       and coalesce(p.gateway_order_id, '') = ''
  `)
}
