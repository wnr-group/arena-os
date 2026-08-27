/**
 * Recording payments against an issued invoice — split tenders, cash/card/UPI.
 *
 * Takes a `tx` rather than opening its own (same shape as ./invoice.ts and
 * lib/customers/service.ts), so the caller supplies an RLS-scoped transaction
 * via withUser() and the lock, the balance check and the insert all commit or
 * roll back together.
 *
 * The browser supplies only an invoice id, a method and an amount. The total,
 * the branch, the tenant and the collecting membership are all derived here.
 */
import { and, eq, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { z } from 'zod'
import type * as schema from '@/db/schema'
import { invoices, memberships, payments } from '@/db/schema'
import { settleInvoicePaid } from './loyalty'
import { paise, round2 } from './pricing'

type Db = NodePgDatabase<typeof schema>

/** Payment rule violations the cashier should see verbatim. */
export class PaymentError extends Error {}

/**
 * Tenders a cashier can take at the counter. The `payment_method` enum also
 * carries 'online' and 'wallet' — those are gateway/wallet flows with their own
 * verification and are deliberately NOT accepted here.
 */
export const POS_PAYMENT_METHODS = ['cash', 'card', 'upi'] as const
export type PosPaymentMethod = (typeof POS_PAYMENT_METHODS)[number]

export const PAYMENT_METHOD_LABELS: Record<PosPaymentMethod, string> = {
  cash: 'Cash',
  card: 'Card',
  upi: 'UPI',
}

/** Only invoices in this state can take money. */
export const PAYABLE_INVOICE_STATUS = 'issued'

/** numeric(10,2) tops out here; reject before Postgres raises a numeric overflow. */
export const MAX_PAYMENT_AMOUNT = 99_999_999.99

/**
 * Money as whole paise. Defined in ./pricing (the dependency-free money module)
 * and re-exported here so the many existing `from './payments'` imports keep
 * working. Moving the definition is what breaks the payments ↔ loyalty cycle.
 */
export { paise }

export type RecordedPayment = {
  id: string
  method: string
  amount: string
  status: string
  collectedByName: string | null
  createdAt: Date
}

export type InvoiceSettlement = {
  invoiceId: string
  invoiceNumber: string
  status: string
  bookingId: string | null
  /** Rupees, 2dp. */
  total: number
  paid: number
  balance: number
  payments: RecordedPayment[]
  /** True when the invoice can still take money right now. */
  payable: boolean
}

/** Every payment recorded against an invoice, newest last. */
export async function listInvoicePayments(
  tx: Db,
  tenantId: string,
  invoiceId: string,
): Promise<RecordedPayment[]> {
  return tx
    .select({
      id: payments.id,
      method: payments.method,
      amount: payments.amount,
      status: payments.status,
      collectedByName: memberships.fullName,
      createdAt: payments.createdAt,
    })
    .from(payments)
    .leftJoin(memberships, eq(memberships.id, payments.collectedBy))
    .where(and(eq(payments.tenantId, tenantId), eq(payments.invoiceId, invoiceId)))
    .orderBy(payments.createdAt)
}

/**
 * Rupees already captured against an invoice.
 *
 * Summed in Postgres over `numeric`, which is exact — no float addition — and
 * scoped to status='captured'. A pending, failed or refunded row is money that
 * is NOT in the till, so it must never reduce the balance owed.
 */
export async function capturedTotal(tx: Db, tenantId: string, invoiceId: string): Promise<number> {
  const [row] = await tx
    .select({ total: sql<string>`coalesce(sum(${payments.amount}), 0)::text` })
    .from(payments)
    .where(
      and(
        eq(payments.tenantId, tenantId),
        eq(payments.invoiceId, invoiceId),
        eq(payments.status, 'captured'),
      ),
    )
  return round2(Number(row?.total ?? 0))
}

/**
 * The invoice's settlement state — what it costs, what has been taken, what is
 * left. Read-only; used by the POS screen. Returns null when the invoice does
 * not exist or belongs to another tenant (RLS makes those indistinguishable).
 */
export async function getInvoiceSettlement(
  tx: Db,
  tenantId: string,
  invoiceId: string,
): Promise<InvoiceSettlement | null> {
  const [invoice] = await tx
    .select({
      id: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
      status: invoices.status,
      total: invoices.total,
      bookingId: invoices.bookingId,
    })
    .from(invoices)
    .where(and(eq(invoices.id, invoiceId), eq(invoices.tenantId, tenantId)))
    .limit(1)

  if (!invoice) return null

  // Sequential, not Promise.all: these share ONE transaction client, and a
  // Postgres connection cannot run two queries at once (pg deprecates it and
  // removes it in v9).
  const rows = await listInvoicePayments(tx, tenantId, invoice.id)
  const paid = await capturedTotal(tx, tenantId, invoice.id)

  const total = round2(Number(invoice.total))
  const balance = round2(total - paid)

  return {
    invoiceId: invoice.id,
    invoiceNumber: invoice.invoiceNumber,
    status: invoice.status,
    bookingId: invoice.bookingId,
    total,
    paid,
    balance,
    payments: rows,
    payable: invoice.status === PAYABLE_INVOICE_STATUS && paise(balance) > 0,
  }
}

/**
 * The action's input contract, kept here beside the rules it guards so it can
 * be exercised without a request context (scripts/test-payments.ts).
 */
export const recordPaymentInputSchema = z.object({
  invoiceId: z.string().uuid('That invoice reference is not valid.'),
  // Counter tenders only. 'online' and 'wallet' exist in the DB enum but are
  // gateway/wallet flows with their own verification, so z.enum rejects them
  // and they can never reach the till through this path.
  method: z.enum(POS_PAYMENT_METHODS, {
    errorMap: () => ({ message: 'Choose cash, card or UPI.' }),
  }),
  amount: z.coerce
    .number({ invalid_type_error: 'Enter a valid amount.' })
    .finite('Enter a valid amount.')
    .positive('Enter an amount greater than zero.')
    .max(MAX_PAYMENT_AMOUNT, 'That amount is too large.'),
  /**
   * Retry token. A double-clicked button or a retried request carries the
   * SAME key, and the second attempt returns the first result rather than
   * taking the money twice. Optional so server-side callers that are
   * already idempotent by other means need not supply one.
   */
  idempotencyKey: z.string().trim().min(8).max(128).optional(),
})

export type RecordPaymentInput = {
  invoiceId: string
  method: PosPaymentMethod
  amount: number
  idempotencyKey?: string
}

export type RecordPaymentResult = {
  paymentId: string
  paid: number
  balance: number
  invoiceStatus: string
  settled: boolean
  /** Read off the invoice so the caller can revalidate /pos/[bookingId]. */
  bookingId: string | null
  /** True when this call recognised itself as a retry and took no money. */
  deduplicated?: boolean
}

/**
 * Take a tender against an invoice.
 *
 * Everything below runs in the caller's transaction, opened by a
 * `SELECT … FOR UPDATE` on the invoice row. That lock is what makes
 * overpayment impossible under concurrency: two cashiers submitting at the same
 * instant are serialised on it, so the second one reads a balance that already
 * includes the first one's payment instead of the stale figure it would
 * otherwise see.
 */
export async function recordPaymentForInvoice(
  tx: Db,
  actor: { tenantId: string; membershipId: string },
  input: RecordPaymentInput,
): Promise<RecordPaymentResult> {
  // ── 0. method, independently of the caller's validation ───────────────────
  // The action's Zod schema already rejects 'online'/'wallet', but this core is
  // reachable from anywhere a `tx` is, so the rule is enforced here too.
  if (!(POS_PAYMENT_METHODS as readonly string[]).includes(input.method)) {
    throw new PaymentError('Choose cash, card or UPI.')
  }

  // ── 1. lock the invoice ───────────────────────────────────────────────────
  // RLS applies to this read, so another tenant's invoice id simply returns no
  // row — indistinguishable from a bad id, which is what we want.
  const [invoice] = await tx
    .select({
      id: invoices.id,
      status: invoices.status,
      total: invoices.total,
      branchId: invoices.branchId,
      bookingId: invoices.bookingId,
    })
    .from(invoices)
    .where(and(eq(invoices.id, input.invoiceId), eq(invoices.tenantId, actor.tenantId)))
    .for('update')
    .limit(1)

  if (!invoice) throw new PaymentError('Invoice not found.')

  // ── 1b. have we already taken this exact tender? ──────────────────────────
  // Checked AFTER the invoice lock, which is what makes it race-free: two
  // simultaneous submissions of one click serialise on that lock, so the
  // second sees the first's row rather than a stale absence. The unique index
  // on (tenant_id, idempotency_key) is the backstop if they ever did not.
  //
  // A recognised retry is NOT an error — it returns what the first call
  // returned, which is what a cashier who clicked twice expects to see.
  if (input.idempotencyKey) {
    const [existing] = await tx
      .select({ id: payments.id, invoiceId: payments.invoiceId })
      .from(payments)
      .where(
        and(
          eq(payments.tenantId, actor.tenantId),
          eq(payments.idempotencyKey, input.idempotencyKey),
        ),
      )
      .limit(1)

    if (existing) {
      // A key is minted per attempt, so reuse against a DIFFERENT invoice
      // means the client is confused — refuse rather than silently ignore.
      if (existing.invoiceId !== invoice.id) {
        throw new PaymentError('That payment reference has already been used.')
      }
      const paidNow = await capturedTotal(tx, actor.tenantId, invoice.id)
      const invoiceTotal = round2(Number(invoice.total))
      return {
        paymentId: existing.id,
        paid: paidNow,
        balance: round2(invoiceTotal - paidNow),
        invoiceStatus: invoice.status,
        settled: paise(paidNow) >= paise(invoiceTotal),
        bookingId: invoice.bookingId,
        deduplicated: true,
      }
    }
  }

  // ── 2. can this invoice still take money? ─────────────────────────────────
  if (invoice.status === 'paid') throw new PaymentError('This invoice is already paid.')
  if (invoice.status === 'void') throw new PaymentError('This invoice has been voided.')
  if (invoice.status !== PAYABLE_INVOICE_STATUS) {
    throw new PaymentError('This invoice has not been issued yet.')
  }

  // ── 3. what is actually owed ──────────────────────────────────────────────
  // Read AFTER the lock, so the figure cannot go stale before the insert.
  const total = round2(Number(invoice.total))
  const alreadyPaid = await capturedTotal(tx, actor.tenantId, invoice.id)
  const remaining = round2(total - alreadyPaid)

  if (paise(remaining) <= 0) throw new PaymentError('Invoice is already fully paid.')

  // ── 4. validate the tender ────────────────────────────────────────────────
  const amount = round2(input.amount)
  if (paise(amount) <= 0) throw new PaymentError('Enter an amount greater than zero.')

  // The rule: alreadyPaid + amount <= total. Compared in paise, never rupees.
  // The amount is NOT silently reduced to the balance — the cashier re-enters it.
  if (paise(alreadyPaid) + paise(amount) > paise(total)) {
    throw new PaymentError(
      `Payment exceeds the remaining balance. ${remaining.toFixed(2)} is outstanding.`,
    )
  }

  // ── 5. insert the tender ──────────────────────────────────────────────────
  // tenant_id, branch_id and collected_by come from the server: the context and
  // the locked invoice row. Nothing here is client-supplied.
  const [payment] = await tx
    .insert(payments)
    .values({
      tenantId: actor.tenantId,
      branchId: invoice.branchId,
      invoiceId: invoice.id,
      method: input.method,
      amount: amount.toFixed(2),
      status: 'captured',
      collectedBy: actor.membershipId,
      idempotencyKey: input.idempotencyKey ?? null,
    })
    .returning({ id: payments.id })

  // ── 6. settle the invoice, only once the money is actually recorded ───────
  const newPaid = round2(alreadyPaid + amount)
  const settled = paise(newPaid) >= paise(total)

  if (settled) {
    // THE settlement seam: marks the invoice paid AND awards loyalty points,
    // in this transaction. Every payment path goes through it so earning can
    // neither be missed on one route nor happen twice on another.
    await settleInvoicePaid(tx, actor.tenantId, invoice.id)
  }

  return {
    paymentId: payment.id,
    paid: newPaid,
    balance: round2(total - newPaid),
    invoiceStatus: settled ? 'paid' : invoice.status,
    settled,
    bookingId: invoice.bookingId,
  }
}

/**
 * Record a GATEWAY payment against an issued invoice.
 *
 * Sibling to recordPaymentForInvoice() above, deliberately separate rather than
 * a flag on it, because the two have different trust models:
 *
 *   recordPaymentForInvoice   a cashier asserts money is in the till. Restricted
 *                             to POS_PAYMENT_METHODS, needs a collecting
 *                             membership, and refuses 'online' outright.
 *   this function             Razorpay has ALREADY taken the money and a
 *                             verified webhook signature says so. There is no
 *                             cashier, so `collected_by` is null, and the method
 *                             is 'online' by definition.
 *
 * What it does NOT relax is the money arithmetic: the same invoice lock, the
 * same capturedTotal() read after the lock, and the same
 * `alreadyPaid + amount <= total` rule compared in paise. A gateway payment can
 * no more overpay an invoice than a cashier can.
 *
 * Returns null WITHOUT throwing when the invoice cannot absorb the amount. The
 * money has already moved at the gateway, so refusing to record the deposit
 * against an invoice must never fail the webhook — the caller keeps the
 * authoritative record on the payment intent and an operator reconciles.
 */
export async function recordVerifiedGatewayPayment(
  tx: Db,
  params: {
    tenantId: string
    invoiceId: string
    amount: number
    gateway: string
    gatewayOrderId: string
    gatewayPaymentId: string
  },
): Promise<{ paymentId: string; settled: boolean } | null> {
  const [invoice] = await tx
    .select({
      id: invoices.id,
      status: invoices.status,
      total: invoices.total,
      branchId: invoices.branchId,
    })
    .from(invoices)
    .where(and(eq(invoices.id, params.invoiceId), eq(invoices.tenantId, params.tenantId)))
    .for('update')
    .limit(1)

  // No invoice, or one that cannot take money (draft/void/already paid).
  if (!invoice) return null
  if (invoice.status !== PAYABLE_INVOICE_STATUS) return null

  const total = round2(Number(invoice.total))
  const alreadyPaid = await capturedTotal(tx, params.tenantId, invoice.id)
  const amount = round2(params.amount)

  if (paise(amount) <= 0) return null
  // The overpayment rule, in paise. A deposit larger than what is still owed is
  // not recorded here; it stays on the payment intent for reconciliation.
  if (paise(alreadyPaid) + paise(amount) > paise(total)) return null

  const [payment] = await tx
    .insert(payments)
    .values({
      tenantId: params.tenantId,
      branchId: invoice.branchId,
      invoiceId: invoice.id,
      method: 'online',
      amount: amount.toFixed(2),
      status: 'captured',
      gateway: params.gateway,
      gatewayOrderId: params.gatewayOrderId,
      gatewayPaymentId: params.gatewayPaymentId,
      // No cashier took this money.
      collectedBy: null,
    })
    .returning({ id: payments.id })

  const newPaid = round2(alreadyPaid + amount)
  const settled = paise(newPaid) >= paise(total)

  if (settled) {
    await settleInvoicePaid(tx, params.tenantId, invoice.id)
  }

  return { paymentId: payment.id, settled }
}
