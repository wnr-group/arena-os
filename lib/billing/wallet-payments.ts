import { and, eq, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { z } from 'zod'
import type * as schema from '@/db/schema'
import { customers, invoices, payments, walletTransactions } from '@/db/schema'
import { walletBalance } from '@/lib/customers/ledger'
import { issueWalletTopUpInvoice } from './invoice'
import { settleInvoicePaid } from './loyalty'
import {
  MAX_PAYMENT_AMOUNT,
  PAYABLE_INVOICE_STATUS,
  POS_PAYMENT_METHODS,
  capturedTotal,
  paise,
  recordPaymentForInvoice,
  type PosPaymentMethod,
} from './payments'
import { round2 } from './pricing'

/**
 * Wallet top-up and wallet tender — the two ends of the existing ledger.
 *
 * ── The ledger is unchanged and remains the source of truth ─────────────────
 * `wallet_transactions` (migration 0007) is append-only with a SIGNED `amount`:
 * positive credits, negative debits, and the balance is `sum(amount)` via
 * walletBalance() in lib/customers/ledger.ts. Nothing here introduces a balance
 * column, and nothing here caches a balance across statements.
 *
 * ── Why 'wallet' is NOT in POS_PAYMENT_METHODS ──────────────────────────────
 * recordPaymentForInvoice() accepts any method in POS_PAYMENT_METHODS and knows
 * nothing about ledgers. Adding 'wallet' to that list would let a cashier
 * record a wallet payment with NO corresponding debit — money off the invoice
 * that never leaves the wallet. The list therefore stays the cash-drawer
 * tenders, and a wallet tender goes through
 * recordWalletPaymentForInvoice() below, which is the only path that can create
 * a payments row with method='wallet' and does so together with its debit, in
 * one transaction. WALLET_METHOD and POS_TENDER_OPTIONS exist for the UI.
 */

type Db = NodePgDatabase<typeof schema>

/** Wallet rule violations the cashier should see verbatim. */
export class WalletError extends Error {}

/** The gateway-less tender backed by a customer's ledger balance. */
export const WALLET_METHOD = 'wallet' as const

/** Everything the till may offer. Cash-drawer tenders plus the wallet. */
export const POS_TENDER_OPTIONS = [...POS_PAYMENT_METHODS, WALLET_METHOD] as const
export type PosTender = (typeof POS_TENDER_OPTIONS)[number]

export const TENDER_LABELS: Record<PosTender, string> = {
  cash: 'Cash',
  card: 'Card',
  upi: 'UPI',
  wallet: 'Wallet',
}

/** Ledger `source_type` values. Free text in the schema; enumerated here. */
export const WALLET_SOURCE = {
  /** Credit — bought at the till. `source_id` is the top-up invoice. */
  topUp: 'wallet_topup',
  /** Debit — spent on a bill. `source_id` is the payments row. */
  invoicePayment: 'invoice_payment',
  /** Credit — restored when a wallet payment is refunded. `source_id` = refund. */
  refund: 'wallet_refund',
  /** Debit — credit taken back when the TOP-UP that sold it is refunded. */
  topUpReversal: 'topup_reversal',
} as const

/**
 * Lock a customer's wallet for the rest of the transaction.
 *
 * THE concurrency primitive. `wallet_transactions` is append-only, so there is
 * no ledger row to lock — two simultaneous debits would otherwise each read the
 * same balance, each find it sufficient, and both insert, overdrawing the
 * wallet. Locking the CUSTOMER row serialises every wallet operation for that
 * customer, so the second transaction blocks until the first commits and then
 * reads a balance that already includes it.
 *
 * The same idiom recordPaymentForInvoice() uses on the invoice row to make
 * overpayment impossible, applied to the wallet.
 *
 * Returns the customer id, or throws when the customer is not this tenant's —
 * RLS makes "another tenant's customer" and "no such customer" the same answer.
 */
async function lockWallet(tx: Db, tenantId: string, customerId: string): Promise<string> {
  const [customer] = await tx
    .select({ id: customers.id })
    .from(customers)
    .where(and(eq(customers.id, customerId), eq(customers.tenantId, tenantId)))
    .for('update')
    .limit(1)

  if (!customer) throw new WalletError('Customer not found.')
  return customer.id
}

/** Shared money validation: positive, finite, within numeric(10,2). */
function validAmount(amount: number, label: string): number {
  const value = round2(amount)
  if (!Number.isFinite(value) || paise(value) <= 0) {
    throw new WalletError(`Enter a ${label} greater than zero.`)
  }
  if (value > MAX_PAYMENT_AMOUNT) throw new WalletError('That amount is too large.')
  return value
}

// ── top-up ───────────────────────────────────────────────────────────────────

export const topUpWalletInputSchema = z.object({
  customerId: z.string().uuid('That customer reference is not valid.'),
  amount: z.coerce
    .number({ invalid_type_error: 'Enter a valid amount.' })
    .finite('Enter a valid amount.')
    .positive('Enter an amount greater than zero.')
    .max(MAX_PAYMENT_AMOUNT, 'That amount is too large.'),
  /** Retry token — see recordPaymentInputSchema. */
  idempotencyKey: z.string().trim().min(8).max(128).optional(),
  /** How the customer paid for the credit. Cash-drawer tenders only. */
  method: z.enum(POS_PAYMENT_METHODS, {
    errorMap: () => ({ message: 'Choose cash, card or UPI.' }),
  }),
})

export type TopUpWalletInput = z.infer<typeof topUpWalletInputSchema>

export type TopUpResult = {
  invoiceId: string
  invoiceNumber: string
  paymentId: string
  /** Rupees credited. */
  amount: number
  /** Ledger balance after the credit. */
  balance: number
}

/**
 * Sell wallet credit at the till.
 *
 * A top-up is NOT free credit: the customer pays face value and the ledger is
 * credited only because that money was actually taken. The whole thing is one
 * transaction —
 *
 *   lock wallet → issue invoice → capture tender → credit ledger
 *
 * — so there is no state in which credit exists without its payment, or a
 * payment exists without its credit. A failure anywhere rolls back all of it,
 * including the invoice sequence bump.
 *
 * The tender goes through recordPaymentForInvoice(), the same M1 path a booking
 * bill uses: same invoice lock, same overpayment rule, same 'captured' status.
 * No second payment mechanism.
 *
 * `method` is restricted to cash/card/UPI — topping a wallet up FROM the wallet
 * is circular, and the Zod enum makes it unrepresentable.
 */
export async function topUpWallet(
  tx: Db,
  actor: { tenantId: string; membershipId: string; timezone: string; branchId: string },
  input: TopUpWalletInput,
): Promise<TopUpResult> {
  const { customerId, amount, method } = topUpWalletInputSchema.parse(input)
  const value = validAmount(amount, 'top-up amount')

  // Locked first, so a top-up and a debit for the same customer serialise
  // against each other and the balance reported below cannot go stale.
  await lockWallet(tx, actor.tenantId, customerId)

  const invoice = await issueWalletTopUpInvoice(
    tx,
    { id: actor.tenantId, timezone: actor.timezone },
    { branchId: actor.branchId, customerId, amount: value },
  )

  const tender = await recordPaymentForInvoice(
    tx,
    { tenantId: actor.tenantId, membershipId: actor.membershipId },
    {
      invoiceId: invoice.invoiceId,
      method: method as PosPaymentMethod,
      amount: value,
      idempotencyKey: input.idempotencyKey,
    },
  )

  // The credit — only now, with the money genuinely captured.
  await tx.insert(walletTransactions).values({
    tenantId: actor.tenantId,
    customerId,
    // Positive: a credit. Written as a fixed 2-decimal string, matching how the
    // numeric column is read back.
    amount: value.toFixed(2),
    reason: `Wallet top-up · ${invoice.invoiceNumber}`,
    sourceType: WALLET_SOURCE.topUp,
    sourceId: invoice.invoiceId,
    createdBy: actor.membershipId,
  })

  return {
    invoiceId: invoice.invoiceId,
    invoiceNumber: invoice.invoiceNumber,
    paymentId: tender.paymentId,
    amount: value,
    balance: await walletBalance(tx, actor.tenantId, customerId),
  }
}

// ── spending it ──────────────────────────────────────────────────────────────

export const walletPaymentInputSchema = z.object({
  invoiceId: z.string().uuid('That invoice reference is not valid.'),
  amount: z.coerce
    .number({ invalid_type_error: 'Enter a valid amount.' })
    .finite('Enter a valid amount.')
    .positive('Enter an amount greater than zero.')
    .max(MAX_PAYMENT_AMOUNT, 'That amount is too large.'),
  /** Retry token — see recordPaymentInputSchema. */
  idempotencyKey: z.string().trim().min(8).max(128).optional(),
})

export type WalletPaymentInput = z.infer<typeof walletPaymentInputSchema>

export type WalletPaymentResult = {
  paymentId: string
  /** Rupees debited. */
  amount: number
  /** Ledger balance after the debit. */
  balance: number
  /** Invoice figures after the tender. */
  paid: number
  invoiceBalance: number
  settled: boolean
  bookingId: string | null
}

/**
 * Tender part or all of an invoice from the customer's wallet.
 *
 * ── The two invariants, both enforced under locks ───────────────────────────
 *   balance − amount >= 0      the wallet can never be overdrawn
 *   captured + amount <= total the invoice can never be overpaid
 *
 * The customer row is locked first and the invoice row second — always in that
 * order, everywhere, so two wallet tenders can never deadlock by grabbing them
 * in opposite orders. Both balances are read AFTER their lock, so neither can
 * be stale by the time the insert happens.
 *
 * Partial tenders are allowed, because the M1 till already supports split
 * payments: recordPaymentForInvoice() settles the invoice only when the
 * captured total reaches the invoice total. ₹500 of wallet plus ₹300 of cash on
 * an ₹800 bill is therefore just two tenders, and the second one settles it.
 *
 * The payments row and the ledger debit are inserted in the same transaction.
 * There is no ordering of failures that leaves one without the other.
 */
export async function recordWalletPaymentForInvoice(
  tx: Db,
  actor: { tenantId: string; membershipId: string },
  input: WalletPaymentInput,
): Promise<WalletPaymentResult> {
  const { invoiceId, amount, idempotencyKey } = walletPaymentInputSchema.parse(input)
  const value = validAmount(amount, 'payment amount')

  // ── 1. the invoice, and the customer whose wallet may pay it ──────────────
  // Read before the locks purely to learn WHICH customer to lock. RLS scopes
  // it, so another tenant's invoice id returns nothing.
  const [invoice] = await tx
    .select({
      id: invoices.id,
      status: invoices.status,
      total: invoices.total,
      customerId: invoices.customerId,
      bookingId: invoices.bookingId,
      branchId: invoices.branchId,
    })
    .from(invoices)
    .where(and(eq(invoices.id, invoiceId), eq(invoices.tenantId, actor.tenantId)))
    .limit(1)

  if (!invoice) throw new WalletError('Invoice not found.')

  // A walk-in bill has no customer, so there is no wallet that could pay it.
  // This is also the check that stops customer A's wallet paying customer B's
  // invoice: the wallet is chosen BY the invoice, never by the caller.
  if (!invoice.customerId) {
    throw new WalletError('This bill is not linked to a customer, so it cannot be paid by wallet.')
  }

  // A recognised retry returns the first result rather than debiting again.
  if (idempotencyKey) {
    const [seen] = await tx
      .select({ id: payments.id, amount: payments.amount })
      .from(payments)
      .where(
        and(eq(payments.tenantId, actor.tenantId), eq(payments.idempotencyKey, idempotencyKey)),
      )
      .limit(1)
    if (seen) {
      const total = round2(Number(invoice.total))
      const paidNow = await capturedTotal(tx, actor.tenantId, invoice.id)
      return {
        paymentId: seen.id,
        amount: round2(Number(seen.amount)),
        balance: await walletBalance(tx, actor.tenantId, invoice.customerId),
        paid: paidNow,
        invoiceBalance: round2(total - paidNow),
        settled: paise(paidNow) >= paise(total),
        bookingId: invoice.bookingId,
      }
    }
  }

  if (invoice.status === 'paid') throw new WalletError('This invoice is already paid.')
  if (invoice.status === 'void') throw new WalletError('This invoice has been voided.')
  if (invoice.status !== PAYABLE_INVOICE_STATUS) {
    throw new WalletError('This invoice has not been issued yet.')
  }

  // ── 2. lock the wallet, then check the balance ────────────────────────────
  // Customer BEFORE invoice, always — see the note above on lock ordering.
  await lockWallet(tx, actor.tenantId, invoice.customerId)

  const balance = await walletBalance(tx, actor.tenantId, invoice.customerId)
  if (paise(balance) < paise(value)) {
    throw new WalletError(
      `Not enough wallet balance. ${round2(balance).toFixed(2)} available.`,
    )
  }

  // ── 3. the invoice side, under its own lock ───────────────────────────────
  // recordPaymentForInvoice() would do this, but it refuses 'wallet' by design
  // (see the module note), so the same rule is applied here against the same
  // locked row and the same capturedTotal() helper. The lock is what makes the
  // overpayment check safe under concurrency.
  const [locked] = await tx
    .select({ id: invoices.id, status: invoices.status, total: invoices.total })
    .from(invoices)
    .where(and(eq(invoices.id, invoice.id), eq(invoices.tenantId, actor.tenantId)))
    .for('update')
    .limit(1)

  if (!locked) throw new WalletError('Invoice not found.')
  if (locked.status !== PAYABLE_INVOICE_STATUS) {
    throw new WalletError('This invoice can no longer take a payment.')
  }

  const total = round2(Number(locked.total))
  const alreadyPaid = await capturedTotal(tx, actor.tenantId, invoice.id)
  const remaining = round2(total - alreadyPaid)

  if (paise(remaining) <= 0) throw new WalletError('Invoice is already fully paid.')
  if (paise(alreadyPaid) + paise(value) > paise(total)) {
    throw new WalletError(
      `Payment exceeds the remaining balance. ${remaining.toFixed(2)} is outstanding.`,
    )
  }

  // ── 4. the payment ────────────────────────────────────────────────────────
  const [payment] = await tx
    .insert(payments)
    .values({
      tenantId: actor.tenantId,
      branchId: invoice.branchId,
      invoiceId: invoice.id,
      method: WALLET_METHOD,
      amount: value.toFixed(2),
      status: 'captured',
      collectedBy: actor.membershipId,
      idempotencyKey: idempotencyKey ?? null,
    })
    .returning({ id: payments.id })

  // ── 5. the debit, referencing that payment ────────────────────────────────
  // NEGATIVE amount — the ledger is signed, so a debit is a negative credit and
  // the balance stays `sum(amount)`. Written last so `source_id` can name the
  // payment it settles; both are in this transaction, so neither can outlive
  // the other.
  await tx.insert(walletTransactions).values({
    tenantId: actor.tenantId,
    customerId: invoice.customerId,
    amount: (-value).toFixed(2),
    reason: 'Wallet payment',
    sourceType: WALLET_SOURCE.invoicePayment,
    sourceId: payment.id,
    createdBy: actor.membershipId,
  })

  // ── 6. settle the invoice, only once the money is recorded ────────────────
  const newPaid = round2(alreadyPaid + value)
  const settled = paise(newPaid) >= paise(total)

  if (settled) {
    // Same seam as every other tender — see lib/billing/loyalty.ts.
    await settleInvoicePaid(tx, actor.tenantId, invoice.id)
  }

  const newBalance = round2(balance - value)

  return {
    paymentId: payment.id,
    amount: value,
    balance: newBalance,
    paid: newPaid,
    invoiceBalance: round2(total - newPaid),
    settled,
    bookingId: invoice.bookingId,
  }
}

/**
 * Restore wallet credit when a wallet payment is refunded.
 *
 * Called from recordRefund() inside its transaction. A wallet payment is money
 * that came OUT of the ledger, so refunding it must put the money back there
 * rather than into the till — otherwise the customer is refunded financially
 * while their balance stays wrong, which is precisely the state the wallet
 * ledger exists to prevent.
 *
 * A no-op for every other method: cash comes back as cash.
 */
export async function restoreWalletOnRefund(
  tx: Db,
  tenantId: string,
  params: {
    method: string
    invoiceId: string
    refundId: string
    amount: number
    createdBy: string | null
  },
): Promise<boolean> {
  if (params.method !== WALLET_METHOD) return false

  const value = round2(params.amount)
  if (paise(value) <= 0) return false

  // The customer comes off the INVOICE, never from a caller, so a refund can
  // only ever credit the wallet the payment was taken from.
  const [invoice] = await tx
    .select({ customerId: invoices.customerId })
    .from(invoices)
    .where(and(eq(invoices.id, params.invoiceId), eq(invoices.tenantId, tenantId)))
    .limit(1)

  if (!invoice?.customerId) return false

  await tx.insert(walletTransactions).values({
    tenantId,
    customerId: invoice.customerId,
    amount: value.toFixed(2),
    reason: 'Refund of wallet payment',
    sourceType: WALLET_SOURCE.refund,
    sourceId: params.refundId,
    createdBy: params.createdBy,
  })
  return true
}

/**
 * Wallet state for the till: the balance, and whether it may be spent here.
 *
 * Read-only. The authoritative checks live in
 * recordWalletPaymentForInvoice(); this exists so the payment panel can offer
 * the option, pre-fill a sensible amount and explain why it is unavailable.
 */
export async function walletTenderState(
  tx: Db,
  tenantId: string,
  invoiceId: string,
): Promise<{ customerId: string; balance: number; maxSpendable: number } | null> {
  const [invoice] = await tx
    .select({
      id: invoices.id,
      customerId: invoices.customerId,
      total: invoices.total,
      status: invoices.status,
    })
    .from(invoices)
    .where(and(eq(invoices.id, invoiceId), eq(invoices.tenantId, tenantId)))
    .limit(1)

  if (!invoice?.customerId) return null

  const balance = round2(await walletBalance(tx, tenantId, invoice.customerId))
  const alreadyPaid = await capturedTotal(tx, tenantId, invoice.id)
  const remaining = round2(round2(Number(invoice.total)) - alreadyPaid)
  const payable = invoice.status === PAYABLE_INVOICE_STATUS ? remaining : 0

  return {
    customerId: invoice.customerId,
    balance,
    // Never more than the wallet holds, never more than the bill still owes.
    maxSpendable: round2(Math.max(0, Math.min(balance, payable))),
  }
}

/** Ledger balance for a customer — re-exported so callers have one import. */
export { walletBalance }

/** True when the ledger is exactly `sum(amount)`. Used by tests and audits. */
export async function walletLedgerReconciles(
  tx: Db,
  tenantId: string,
  customerId: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ total: sql<string>`coalesce(sum(${walletTransactions.amount}), 0)::text` })
    .from(walletTransactions)
    .where(
      and(
        eq(walletTransactions.tenantId, tenantId),
        eq(walletTransactions.customerId, customerId),
      ),
    )
  const derived = round2(Number(row?.total ?? 0))
  return paise(derived) === paise(await walletBalance(tx, tenantId, customerId))
}
