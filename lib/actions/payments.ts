'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { withUser } from '@/db'
import { requireContext, AuthError } from '@/lib/auth/guard'
import { canBill } from '@/lib/auth/roles'
import { and, eq } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type * as schema from '@/db/schema'
import { branches } from '@/db/schema'
import { BillingError } from '@/lib/billing/invoice'
import {
  PaymentError,
  recordPaymentForInvoice,
  recordPaymentInputSchema,
} from '@/lib/billing/payments'
import {
  WalletError,
  recordWalletPaymentForInvoice,
  topUpWallet,
  topUpWalletInputSchema,
  walletPaymentInputSchema,
} from '@/lib/billing/wallet-payments'

/** The tenant's primary branch — the fallback branch for a top-up invoice. */
async function primaryBranchIdFor(
  tx: NodePgDatabase<typeof schema>,
  tenantId: string,
): Promise<string | null> {
  const [row] = await tx
    .select({ id: branches.id })
    .from(branches)
    .where(and(eq(branches.tenantId, tenantId), eq(branches.isPrimary, true)))
    .limit(1)
  return row?.id ?? null
}
import {
  createDepositOrder as createDepositOrderCore,
  createDepositOrderInputSchema,
  DepositError,
  OrphanedOrderError,
  type DepositCheckout,
} from '@/lib/payments/deposits'
import { createRazorpayOrder, RazorpayApiError } from '@/lib/payments/razorpay'
import {
  PaymentNotConfiguredError,
  requireRazorpayCredentials,
} from '@/lib/settings/razorpay-credentials'

type RecordPaymentResult = {
  error?: string
  paymentId?: string
  paid?: number
  balance?: number
  settled?: boolean
}

/** Same shape as lib/actions/billing.ts:fail() — only safe text reaches the till. */
function fail(e: unknown): RecordPaymentResult {
  if (e instanceof AuthError || e instanceof PaymentError) return { error: e.message }
  if (e instanceof z.ZodError) return { error: e.issues[0]?.message ?? 'Check the values entered.' }
  console.error('[payments] recordPayment failed:', e)
  return { error: 'Could not record the payment. Please try again.' }
}

/**
 * Record one tender against an issued invoice.
 *
 * The client sends an invoice id, a method and an amount — never a total, a
 * balance, a branch, a tenant or a membership. The invoice is re-read and
 * row-locked server-side, and the balance is recomputed from the captured
 * payments actually in the database.
 */
export async function recordPayment(
  input: z.input<typeof recordPaymentInputSchema>,
): Promise<RecordPaymentResult> {
  try {
    const ctx = await requireContext()
    if (!canBill(ctx.role)) {
      throw new AuthError('You do not have permission to record payments.')
    }
    const v = recordPaymentInputSchema.parse(input)

    const result = await withUser(ctx.user.id, (tx) =>
      recordPaymentForInvoice(
        tx,
        { tenantId: ctx.tenant.id, membershipId: ctx.membershipId },
        v,
      ),
    )

    // The POS screen is keyed by booking, so revalidate the invoice's own
    // booking page. bookingId is read server-side from the invoice, never sent.
    if (result.bookingId) revalidatePath(`/pos/${result.bookingId}`)
    revalidatePath('/bookings')

    return {
      paymentId: result.paymentId,
      paid: result.paid,
      balance: result.balance,
      settled: result.settled,
    }
  } catch (e) {
    return fail(e)
  }
}

/* ── AROS-49: Razorpay deposit orders ────────────────────────────────────────
 *
 * Creating a gateway order is NOT taking a payment. Everything below leaves the
 * intent at status='pending'; AROS-50's webhook is the only thing that may ever
 * mark a deposit received.
 */

type DepositOrderResult = {
  error?: string
  /** Present only on success — exactly the fields Checkout needs. */
  checkout?: DepositCheckout
}

/**
 * Failure text for the deposit path.
 *
 * Deliberately narrow: a DepositError is a business rule the user should read
 * verbatim, a RazorpayApiError has already been sanitised of credentials by
 * lib/payments/razorpay.ts, and anything else becomes a generic message. No
 * branch here interpolates an unknown error's own text.
 */
function failDeposit(e: unknown): DepositOrderResult {
  if (e instanceof AuthError || e instanceof DepositError) return { error: e.message }
  if (e instanceof PaymentNotConfiguredError) {
    return { error: 'Online payments are not set up for this venue yet.' }
  }
  if (e instanceof z.ZodError) return { error: e.issues[0]?.message ?? 'Check the values entered.' }

  if (e instanceof OrphanedOrderError) {
    // The one case worth a loud, specific log: a gateway order exists that this
    // database has no row for. The order id is a public reference, not a
    // secret, and it is what makes the orphan findable in the Razorpay
    // dashboard. No money has moved.
    console.error(
      `[payments] deposit intent NOT persisted after gateway order ${e.gatewayOrderId} was created — reconcile this order`,
    )
    return { error: e.message }
  }

  if (e instanceof RazorpayApiError) {
    // Status only. The message is already sanitised, but the log stays terse so
    // no future edit can widen it into dumping the request.
    console.error(`[payments] razorpay order creation failed with status ${e.status}`)
    return {
      error: e.retriable
        ? 'The payment gateway is not responding. Please try again in a moment.'
        : e.message,
    }
  }

  console.error('[payments] createDepositOrder failed:', e instanceof Error ? e.name : 'unknown')
  return { error: 'Could not start the deposit payment. Please try again.' }
}

/**
 * Open a Razorpay order for a booking's deposit.
 *
 * The client sends a booking id and NOTHING else — no amount, no tenant, no
 * branch, no currency. The deposit is read from `bookings.deposit` under a row
 * lock, the tenant comes from the session, and the gateway credentials are the
 * ones belonging to that same tenant, loaded through the AROS-48 server-only
 * helper. There is no code path by which tenant A's booking could be charged
 * against tenant B's Razorpay account.
 *
 * Role rule follows recordPayment(): cashier and up, the roles that may take
 * money. The return value carries the publishable key id and never the secret.
 */
export async function createDepositOrder(
  input: z.input<typeof createDepositOrderInputSchema>,
): Promise<DepositOrderResult> {
  try {
    const ctx = await requireContext()
    if (!canBill(ctx.role)) {
      throw new AuthError('You do not have permission to take payments.')
    }
    const v = createDepositOrderInputSchema.parse(input)

    // AROS-48's loader. Throws PaymentNotConfiguredError when this venue has no
    // gateway configured; the decrypted secret stays inside `credentials` and
    // is handed only to the Razorpay client.
    const credentials = await requireRazorpayCredentials(ctx)

    const checkout = await createDepositOrderCore(v, {
      runInTx: (fn) => withUser(ctx.user.id, fn),
      credentials,
      createOrder: createRazorpayOrder,
      actor: { tenantId: ctx.tenant.id, membershipId: ctx.membershipId },
    })

    revalidatePath('/bookings')
    return { checkout }
  } catch (e) {
    return failDeposit(e)
  }
}

/* ── Wallet: top-up and tender ───────────────────────────────────────────────
 *
 * Both go through the existing M1 machinery — issueWalletTopUpInvoice() +
 * recordPaymentForInvoice() for the top-up, and a dedicated atomic path for the
 * tender. Neither introduces a balance column: wallet_transactions stays the
 * source of truth and walletBalance() stays the only way to read it.
 */

type WalletResult = {
  error?: string
  /** Ledger balance after the operation. */
  balance?: number
  invoiceNumber?: string
  settled?: boolean
}

function failWallet(e: unknown, op: string): WalletResult {
  if (e instanceof AuthError || e instanceof WalletError || e instanceof PaymentError) {
    return { error: e.message }
  }
  if (e instanceof BillingError) return { error: e.message }
  if (e instanceof z.ZodError) return { error: e.issues[0]?.message ?? 'Check the values entered.' }
  console.error(`[wallet] ${op} failed:`, e instanceof Error ? e.name : 'unknown')
  return { error: 'Could not complete the wallet operation. Please try again.' }
}

/**
 * Sell wallet credit at the till.
 *
 * The client sends a customer id, an amount and how it was paid — never a
 * balance. The server raises the invoice, captures the tender and credits the
 * ledger in ONE transaction, so credit cannot exist without its payment.
 *
 * Cashier and up, matching every other path that takes money.
 */
export async function topUpCustomerWallet(
  input: z.input<typeof topUpWalletInputSchema>,
): Promise<WalletResult> {
  try {
    const ctx = await requireContext()
    if (!canBill(ctx.role)) {
      throw new AuthError('You do not have permission to take payments.')
    }
    const v = topUpWalletInputSchema.parse(input)

    const result = await withUser(ctx.user.id, async (tx) => {
      // invoices.branch_id is NOT NULL; a top-up is not branch-scoped, so use
      // the seller's branch and fall back to the tenant's primary. Resolved
      // server-side, never sent by the client.
      const branchId = ctx.branchId ?? (await primaryBranchIdFor(tx, ctx.tenant.id))
      if (!branchId) throw new WalletError('This venue has no branch configured.')

      return topUpWallet(
        tx,
        {
          tenantId: ctx.tenant.id,
          membershipId: ctx.membershipId,
          timezone: ctx.tenant.timezone,
          branchId,
        },
        v,
      )
    })

    revalidatePath(`/customers/${v.customerId}`)
    revalidatePath('/customers')
    return { balance: result.balance, invoiceNumber: result.invoiceNumber }
  } catch (e) {
    return failWallet(e, 'top-up')
  }
}

/**
 * Tender part or all of an invoice from the customer's wallet.
 *
 * The client sends an invoice id and an amount. WHICH wallet is decided by the
 * invoice's own `customer_id`, read server-side — there is no field by which a
 * caller could nominate someone else's wallet. Balance sufficiency and invoice
 * overpayment are both re-checked under locks inside the transaction.
 */
export async function payInvoiceFromWallet(
  input: z.input<typeof walletPaymentInputSchema>,
): Promise<WalletResult> {
  try {
    const ctx = await requireContext()
    if (!canBill(ctx.role)) {
      throw new AuthError('You do not have permission to record payments.')
    }
    const v = walletPaymentInputSchema.parse(input)

    const result = await withUser(ctx.user.id, (tx) =>
      recordWalletPaymentForInvoice(
        tx,
        { tenantId: ctx.tenant.id, membershipId: ctx.membershipId },
        v,
      ),
    )

    if (result.bookingId) revalidatePath(`/pos/${result.bookingId}`)
    revalidatePath('/bookings')
    return { balance: result.balance, settled: result.settled }
  } catch (e) {
    return failWallet(e, 'payment')
  }
}
