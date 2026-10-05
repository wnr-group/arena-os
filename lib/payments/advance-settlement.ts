/**
 * Carrying a pre-collected cash advance onto a booking's invoice — M26 #2.
 *
 * Sibling to applyPaidDepositsToInvoice (./deposit-settlement.ts), which does
 * the identical "money the venue already holds → a real payment row" carry-
 * over for an ONLINE Razorpay deposit. This is the same idea for CASH
 * collected at the counter before the booking even existed
 * (advance_payments, M30 #1; was bookings.advance_paid) — a separate module and a separate booking
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
import { and, asc, eq, isNull } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type * as schema from '@/db/schema'
import { advancePayments, auditLog, bookings, invoices, payments, tenants } from '@/db/schema'
import { capturedTotal, paise, type PosPaymentMethod } from '@/lib/billing/payments'
import { settleInvoicePaid } from '@/lib/billing/loyalty'
import { round2 } from '@/lib/billing/pricing'
import { completeBookingIfFullySettled } from '@/lib/booking/service'

type Db = NodePgDatabase<typeof schema>

export type AppliedAdvance = {
  /** One entry per tender that landed as a payments row, each with its OWN method. */
  applied: { paymentId: string; method: PosPaymentMethod; amount: number }[]
  /** Rupees, 2dp — sum of `applied`: capped at what the invoice could take, never the raw tender total. */
  amount: number
}

/**
 * Fold a gaming-cafe booking's pre-collected advance tenders onto the invoice
 * that was just raised for it (M30 #3).
 *
 * Every unconsumed advance_payments row (invoice_id is null) becomes its OWN
 * captured payments row carrying that tender's own method — a cash + card +
 * UPI advance is three payments, not one lumped 'cash' payment.
 *
 * Runs in the caller's transaction — called from issueInvoiceForBooking right
 * after the invoice and its items are inserted — so the invoice and the
 * advance's carry-over commit or roll back together.
 *
 * Returns null (a no-op) for: every non-gaming_cafe tenant; a booking with no
 * unconsumed tenders; and an invoice that cannot be found. Idempotent per
 * ROW: a tender is reckoned with by stamping its invoice_id, so re-running
 * billing can never apply the same tender twice.
 *
 * Capped per tender at the invoice's remaining balance: if ₹500 is tendered
 * with only ₹300 of room left, ₹300 is applied, the row is still stamped
 * (reckoned with once), and the ₹200 is handed back as change at the counter
 * — the excess is not tracked (v1 scope, unchanged). Tenders are taken oldest
 * first; once the invoice is covered the loop stops and any tenders not
 * reached stay unconsumed. The first tender is always reckoned with, even if
 * the invoice has no room (free bill / covered by a deposit), matching what
 * the single-lump version did.
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
    .select({ createdBy: bookings.createdBy })
    .from(bookings)
    .where(and(eq(bookings.id, bookingId), eq(bookings.tenantId, tenantId)))
    .limit(1)
  if (!booking) return null

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

  // Locked so two concurrent bill-raises can't both read the same row as
  // unconsumed. Oldest first — arbitrary but deterministic.
  const tenders = await tx
    .select()
    .from(advancePayments)
    .where(
      and(
        eq(advancePayments.tenantId, tenantId),
        eq(advancePayments.bookingId, bookingId),
        isNull(advancePayments.invoiceId),
      ),
    )
    .orderBy(asc(advancePayments.createdAt), asc(advancePayments.id))
    .for('update')
  if (tenders.length === 0) return null

  const total = round2(Number(invoice.total))
  const alreadyPaid = await capturedTotal(tx, tenantId, invoice.id)
  let remaining = round2(Math.max(0, total - alreadyPaid))

  const applied: AppliedAdvance['applied'] = []
  const reckoned: { method: string; tendered: string; applied: string }[] = []
  for (const tender of tenders) {
    const tendered = round2(Number(tender.amount))
    const amount = round2(Math.min(tendered, remaining))

    // Stamped regardless of how much was absorbed — reckoned with once, the
    // excess is not tracked.
    await tx
      .update(advancePayments)
      .set({ invoiceId: invoice.id })
      .where(and(eq(advancePayments.id, tender.id), eq(advancePayments.tenantId, tenantId)))

    if (paise(amount) > 0) {
      const [payment] = await tx
        .insert(payments)
        .values({
          tenantId,
          branchId: invoice.branchId,
          invoiceId: invoice.id,
          method: tender.method as PosPaymentMethod,
          amount: amount.toFixed(2),
          status: 'captured',
          // Nobody is taking this money right now — it was collected earlier;
          // carry over whoever collected it then, if known.
          collectedBy: tender.collectedBy,
        })
        .returning({ id: payments.id })
      applied.push({ paymentId: payment.id, method: tender.method as PosPaymentMethod, amount })
      remaining = round2(remaining - amount)
    }
    reckoned.push({ method: tender.method, tendered: tendered.toFixed(2), applied: amount.toFixed(2) })

    if (paise(remaining) <= 0) break
  }

  const amount = round2(applied.reduce((sum, a) => sum + a.amount, 0))
  if (applied.length === 0) return null

  // Durable, append-only record that real money landed on this invoice, with
  // per-tender detail (method, tendered, applied). Attributed to whoever
  // created the booking, not whoever happens to be raising the bill now.
  await tx.insert(auditLog).values({
    tenantId,
    actorMembershipId: booking.createdBy,
    action: 'booking.advance_applied',
    entityType: 'invoice',
    entityId: invoice.id,
    before: { booking_id: bookingId, tenders: reckoned.map(({ method, tendered }) => ({ method, amount: tendered })) },
    after: {
      invoice_id: invoice.id,
      amount_applied: amount.toFixed(2),
      tenders: reckoned,
    },
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
    //
    // CodeRabbit review: a plain try/catch around a SQL error here isn't
    // enough — Postgres marks the WHOLE surrounding transaction aborted the
    // moment one statement fails, so every later statement in it (including
    // ones already run, like the invoice/payment/audit rows above) fails
    // too once the outer caller tries to commit, rolling back exactly the
    // advance carry-over this try/catch exists to protect. Running it in a
    // nested transaction instead — Drizzle 0.45's tx.transaction() is a
    // real Postgres SAVEPOINT — so a SQL error here only rolls back to the
    // savepoint, not the whole outer transaction; the catch below still
    // contains it exactly as before. (deposit-settlement.ts's own carry-over
    // has this identical pre-existing gap — out of scope to touch here, but
    // worth a follow-up.)
    try {
      await tx.transaction(async (sp) => {
        await completeBookingIfFullySettled(sp, tenantId, bookingId)
      })
    } catch (e) {
      console.error(`advance carry-over: auto-complete failed for booking ${bookingId}`, e)
    }
  }

  return { applied, amount }
}
