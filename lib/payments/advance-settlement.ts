/**
 * Carrying a pre-collected cash advance onto a booking's invoice — M26 #2.
 *
 * Sibling to applyPaidDepositsToInvoice (./deposit-settlement.ts), which does
 * the identical "money the venue already holds → a real payment row" carry-
 * over for an ONLINE Razorpay deposit. This is the same idea for CASH
 * collected at the counter before the booking even existed
 * (bookings.advance_paid, M26 #1) — a separate module and a separate booking
 * column on purpose: a Razorpay deposit is money verified through a gateway
 * signature, an advance is a staff assertion that cash is already in the
 * till, and bookings.deposit is already wired to the "Pay Deposit" Razorpay
 * button as money still OWED online — folding cash into that column would
 * make the button try to re-charge money already collected.
 *
 * gaming_cafe only, re-checked HERE against the tenant row rather than
 * trusted from the caller or from advance_paid being non-zero — the same
 * "never trust a stored value without re-validating its precondition"
 * discipline priceBookingSlots applies to a slot's setupId, and
 * completeBookingIfFullySettled (lib/booking/service.ts) applies to its own
 * industry gate.
 *
 * No `import 'server-only'`, matching lib/billing/invoice.ts and
 * lib/payments/deposit-settlement.ts: this takes a `tx`, opens no
 * connection, reads no environment and holds no credential.
 */
import { and, eq } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type * as schema from '@/db/schema'
import { auditLog, bookings, invoices, payments, tenants } from '@/db/schema'
import { capturedTotal, paise } from '@/lib/billing/payments'
import { settleInvoicePaid } from '@/lib/billing/loyalty'
import { round2 } from '@/lib/billing/pricing'
import { completeBookingIfFullySettled } from '@/lib/booking/service'

type Db = NodePgDatabase<typeof schema>

export type AppliedAdvance = {
  paymentId: string
  /** Rupees, 2dp — capped at what the invoice can still take, never the raw advance_paid. */
  amount: number
}

/**
 * Fold a gaming-cafe booking's pre-collected cash advance onto the invoice
 * that was just raised for it.
 *
 * Runs in the caller's transaction — called from issueInvoiceForBooking right
 * after the invoice and its items are inserted — so the invoice and the
 * advance's carry-over commit or roll back together: a bill can never be
 * raised showing an advance that was not actually recorded, or the reverse.
 *
 * Returns null (a no-op) for: every non-gaming_cafe tenant; a booking with
 * nothing collected upfront (advance_paid = 0); and a booking whose advance
 * was already applied (advance_applied = true). That last check is what
 * makes this safe to call at most once per booking no matter how billing is
 * retried — advance_applied flips to true in the SAME update that would
 * otherwise let a second call re-apply the same cash.
 *
 * Capped at the invoice's remaining balance, not the full advance_paid: if
 * the customer paid ₹1000 upfront but the real bill is only ₹800, exactly
 * ₹800 is applied (the booking fully settles) and the ₹200 difference is
 * handled the same way any cash overpayment is — staff hands back change at
 * the counter. This does not track or refund the excess; that is out of
 * scope for v1.
 */
export async function applyAdvancePaymentToInvoice(
  tx: Db,
  tenantId: string,
  bookingId: string,
  invoiceId: string,
): Promise<AppliedAdvance | null> {
  const [t] = await tx.select({ industry: tenants.industry }).from(tenants).where(eq(tenants.id, tenantId)).limit(1)
  if (t?.industry !== 'gaming_cafe') return null

  const [booking] = await tx
    .select({
      advancePaid: bookings.advancePaid,
      advanceApplied: bookings.advanceApplied,
      createdBy: bookings.createdBy,
    })
    .from(bookings)
    .where(and(eq(bookings.id, bookingId), eq(bookings.tenantId, tenantId)))
    .limit(1)
  if (!booking || booking.advanceApplied) return null

  const advancePaid = round2(Number(booking.advancePaid))
  if (paise(advancePaid) <= 0) return null

  const [invoice] = await tx
    .select({
      id: invoices.id,
      status: invoices.status,
      total: invoices.total,
      branchId: invoices.branchId,
    })
    .from(invoices)
    .where(and(eq(invoices.id, invoiceId), eq(invoices.tenantId, tenantId)))
    .for('update')
    .limit(1)
  if (!invoice) return null

  const total = round2(Number(invoice.total))
  const alreadyPaid = await capturedTotal(tx, tenantId, invoice.id)
  const amount = round2(Math.min(advancePaid, Math.max(0, total - alreadyPaid)))

  // Flipped true regardless of whether there was anything left to apply (e.g.
  // a free/fully-comped bill leaves nothing to absorb) — this booking's
  // advance has been reckoned with once, and must never be considered again.
  await tx
    .update(bookings)
    .set({ advanceApplied: true })
    .where(and(eq(bookings.id, bookingId), eq(bookings.tenantId, tenantId)))

  if (paise(amount) <= 0) return null

  const [payment] = await tx
    .insert(payments)
    .values({
      tenantId,
      branchId: invoice.branchId,
      invoiceId: invoice.id,
      method: 'cash',
      amount: amount.toFixed(2),
      status: 'captured',
      // No cashier took this money right now — it was collected earlier, at
      // the counter, before the booking existed. Same reasoning as
      // recordVerifiedGatewayPayment's collectedBy: null for a gateway
      // payment nobody at the till handled.
      collectedBy: null,
    })
    .returning({ id: payments.id })

  // Durable, append-only record that real money landed on this invoice —
  // same discipline every other payment-recording path in this codebase
  // follows (see writeAudit's own doc comment in lib/billing/invoice.ts).
  // Attributed to whoever created the booking (who collected the cash), not
  // whoever happens to be raising the bill now.
  await tx.insert(auditLog).values({
    tenantId,
    actorMembershipId: booking.createdBy,
    action: 'booking.advance_applied',
    entityType: 'invoice',
    entityId: invoice.id,
    before: { booking_id: bookingId, advance_paid: advancePaid.toFixed(2) },
    after: { invoice_id: invoice.id, amount_applied: amount.toFixed(2) },
  })

  const newPaid = round2(alreadyPaid + amount)
  const settled = paise(newPaid) >= paise(total)
  if (settled) {
    // THE settlement seam (lib/billing/loyalty.ts) — marks the invoice paid
    // and awards loyalty points, exactly as a cashier's final tender would.
    await settleInvoicePaid(tx, tenantId, invoice.id)
    // Wrapped so an auto-complete hiccup never rolls back an advance that was
    // already carried onto the invoice (fail-open, mirroring
    // applyPaidDepositsToInvoice's own carry-over).
    try {
      await completeBookingIfFullySettled(tx, tenantId, bookingId)
    } catch (e) {
      console.error(`advance carry-over: auto-complete failed for booking ${bookingId}`, e)
    }
  }

  return { paymentId: payment.id, amount }
}
