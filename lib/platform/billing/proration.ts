import 'server-only'
import type { DB } from '@/db'
import { round2 } from '@/lib/billing/pricing'
import { issueCreditNote, lastPaidInvoiceFor, netPaidTotal } from './invoices'

/**
 * Proration for mid-cycle plan changes (M16 #4).
 *
 * ── WHAT THE GATEWAY ALREADY DOES, AND WHY THAT DECIDES THE RULE ────────────
 *
 * This is the first thing to establish, because it removes most of the design
 * space. M16 #3's subscribeTenantToPlan() does NOT ask Razorpay to modify a
 * subscription in place. A plan change is:
 *
 *     create a NEW Razorpay subscription on the new plan
 *   → cancel the OLD one immediately
 *   → the new subscription charges its plan's FULL price on its first cycle
 *
 * So Razorpay is already the authoritative source of the amount charged, and it
 * charges full price. There is nothing for this module to re-derive, and
 * deliberately no second charge is computed — the ticket's warning against
 * "blindly calculating a second charge" is satisfied structurally: the only
 * money figure that ever reaches an invoice is the one on the payment entity.
 *
 * What Razorpay does NOT do is refund the unused remainder of the period the
 * business already paid for on the old plan. That gap is what proration has to
 * close, and it is the ONLY thing this module computes.
 *
 * ── THE RULE ────────────────────────────────────────────────────────────────
 *
 * On a mid-cycle plan change, Arena OS issues a CREDIT NOTE for the unused
 * remainder of the current paid period:
 *
 *     credit = lastPaidInvoiceTotal × unusedDays ÷ periodDays
 *
 *   * `lastPaidInvoiceTotal` is the gross the business actually paid for the
 *     period it is leaving, read from its own invoice — never from today's
 *     catalogue price, so a price change between the charge and the switch
 *     cannot inflate a credit.
 *   * `periodDays`  = whole days from billing_period_start to billing_period_end.
 *   * `unusedDays`  = whole days from NOW to billing_period_end, clamped to
 *     [0, periodDays].
 *   * Days, not seconds: a subscription period is a calendar arrangement, and
 *     billing someone differently because they clicked at 4pm rather than 9am
 *     is noise, not precision. Whole days are also what a business can check.
 *   * round2() — the project's single money rounder — and never below zero.
 *   * Capped at the amount actually paid, so a clock skew or a mis-stamped
 *     period can never credit more than was received.
 *
 * The credit note is then left OUTSTANDING (`status = 'issued'`) until somebody
 * settles it deliberately — a refund through ./refunds.ts, or a comp through
 * ./overrides.ts — and the owner sees it on their billing page until then.
 *
 * It is deliberately NOT auto-applied to the next invoice. It used to be, and
 * that was wrong: nothing reduces the Razorpay charge (see the section above —
 * the new subscription bills its plan's FULL price), so netting the credit off
 * the DOCUMENT produced an invoice that totalled less than the money actually
 * captured. The customer paid the credit and never got it back, output GST was
 * declared on the reduced figure, and readRevenue() understated platform
 * revenue by exactly the netted amount. A credit is an obligation to the
 * customer; discharging it has to move money or be an explicit operator act,
 * not a silent subtraction on a later bill.
 *
 * ── UPGRADE AND DOWNGRADE ARE THE SAME RULE ─────────────────────────────────
 *
 * The previous ticket defined neither, so this defines both, identically, and
 * says so out loud rather than inventing an asymmetry:
 *
 *   UPGRADE   — the business is charged the new (higher) plan in full now, and
 *               credited the unused part of the old (cheaper) one. Net effect:
 *               it pays the difference for the remaining days, which is what a
 *               prorated upgrade means.
 *
 *   DOWNGRADE — identical. Charged the new (lower) plan in full now, credited
 *               the unused part of the old (dearer) one. The credit is LARGER
 *               than on an upgrade, which is correct: more value was left
 *               unused.
 *
 * One rule, no branch on direction, nothing that behaves differently depending
 * on which way the price moved. Neither direction settles itself: the credit is
 * recorded as an outstanding obligation and an operator decides how to discharge
 * it — refund it (./refunds.ts) or let it stand. That is the deterministic, safe
 * reading of "credit/adjustment", and it is stated on the document itself via
 * the note.
 *
 * ── WHY A CREDIT NOTE RATHER THAN A DISCOUNTED FIRST INVOICE ────────────────
 *
 * Because the first invoice must total what Razorpay actually captured, and
 * Razorpay captured full price. An invoice that said otherwise would disagree
 * with the bank statement. A credit note is the instrument GST already provides
 * for exactly this — a document that reduces a previously-billed amount — and
 * it carries positive figures, so nothing negative is ever persisted.
 */

/** Milliseconds in a day, for the whole-day arithmetic above. */
const DAY_MS = 24 * 60 * 60 * 1000

export type ProrationCredit = {
  /** Gross rupees to credit. Zero when there is nothing to prorate. */
  amount: number
  unusedDays: number
  periodDays: number
  reason: string
}

/**
 * Compute the credit for abandoning `paidTotal` worth of a period early.
 *
 * Pure arithmetic, exported so it can be tested without a database. Every
 * clamp here is deliberate: a period that has already ended credits nothing, a
 * period that has not started credits everything, and neither case throws.
 */
export function computeProrationCredit(input: {
  paidTotal: number
  periodStart: Date
  periodEnd: Date
  at: Date
}): ProrationCredit {
  const paid = round2(Math.max(0, Number.isFinite(input.paidTotal) ? input.paidTotal : 0))

  const startMs = input.periodStart.getTime()
  const endMs = input.periodEnd.getTime()
  const atMs = input.at.getTime()

  // A malformed period (end before start, or an invalid date) credits nothing
  // rather than producing a nonsense figure.
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    return { amount: 0, unusedDays: 0, periodDays: 0, reason: '' }
  }

  // Whole days, rounded so a period stamped 29.99 days by clock drift is still
  // 30. Ceil would inflate every period by a day; floor would deflate it.
  const periodDays = Math.max(1, Math.round((endMs - startMs) / DAY_MS))
  const unusedDays = Math.min(
    periodDays,
    Math.max(0, Math.round((endMs - atMs) / DAY_MS)),
  )

  if (unusedDays <= 0 || paid <= 0) {
    return { amount: 0, unusedDays: 0, periodDays, reason: '' }
  }

  // Capped at what was paid — belt and braces against a clock skew that made
  // unusedDays exceed periodDays before the clamp above.
  const amount = Math.min(paid, round2((paid * unusedDays) / periodDays))

  return {
    amount,
    unusedDays,
    periodDays,
    reason: `Proration credit for ${unusedDays} unused day${unusedDays === 1 ? '' : 's'} of ${periodDays} on the previous plan.`,
  }
}

/**
 * Issue the credit note for a subscription being replaced mid-cycle.
 *
 * Called from subscribeTenantToPlan()'s swap transaction, so the credit and the
 * closing of the old row commit together — there is no window in which the old
 * subscription is gone but its unused remainder has not been credited.
 *
 * Returns null, and writes nothing, when there is nothing to credit:
 *
 *   * the outgoing subscription was never charged (no paid invoice) — a
 *     business that abandons an unpaid checkout is owed nothing;
 *   * its period has already run out;
 *   * or the computed credit rounds to zero.
 *
 * Each of those is a normal outcome, not an error, so none of them throws.
 */
export async function creditUnusedPeriod(
  tx: DB,
  params: {
    tenantId: string
    /** The subscription being REPLACED — the credit belongs to its period. */
    subscriptionId: string
    at?: Date
  },
): Promise<{ invoiceNumber: string; amount: string } | null> {
  const last = await lastPaidInvoiceFor(tx, params.subscriptionId)
  if (!last) return null

  const credit = computeProrationCredit({
    // NET of anything already refunded against that charge. Crediting the gross
    // would hand back a second time money the business has already had back —
    // see netPaidTotal() in ./invoices.ts.
    paidTotal: netPaidTotal(last),
    periodStart: last.billingPeriodStart,
    periodEnd: last.billingPeriodEnd,
    at: params.at ?? new Date(),
  })

  if (credit.amount <= 0) return null

  const note = await issueCreditNote(tx, {
    tenantId: params.tenantId,
    subscriptionId: params.subscriptionId,
    // The plan being LEFT: the credit reverses part of that plan's charge, so
    // the document must name it, not the plan being moved to.
    planId: last.planId,
    billingPeriodType: last.billingPeriodType,
    // The remaining window, so the document says precisely what is being
    // credited rather than restating the whole original period.
    billingPeriodStart: params.at ?? new Date(),
    billingPeriodEnd: last.billingPeriodEnd,
    grossAmount: credit.amount,
    currency: last.currency,
    reason: credit.reason,
  })

  return note ? { invoiceNumber: note.invoiceNumber, amount: note.total } : null
}
