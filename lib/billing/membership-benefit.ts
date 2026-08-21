import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type * as schema from '@/db/schema'
import { getMembershipBenefits } from '@/lib/memberships/customer-memberships'
import { round2 } from './pricing'

/**
 * The membership benefit a bill is entitled to — AROS-61.
 *
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  BILLING DISCOUNT PRECEDENCE (the one authoritative statement of it)     ║
 * ║                                                                          ║
 * ║   1. Base line pricing.                                                  ║
 * ║      Happy-hour adjustments would belong here — `happy_hours` exists as  ║
 * ║      a table (0015) but is NOT wired into billing, so there is nothing   ║
 * ║      to order against yet. When it lands it goes at this step, before    ║
 * ║      the subtotal is struck.                                             ║
 * ║                                                                          ║
 * ║   2. MEMBERSHIP benefit — a percentage of the subtotal, from the         ║
 * ║      customer's purchased SNAPSHOT. Automatic and earned, so it comes    ║
 * ║      first among discounts.                                              ║
 * ║                                                                          ║
 * ║   3. PROMO CODE, or a cashier's keyed-in discount — computed against     ║
 * ║      what REMAINS after the membership benefit, never against the gross  ║
 * ║      subtotal. A promo still REPLACES a keyed-in figure rather than      ║
 * ║      stacking with it, which is the rule migration 0017's billing path   ║
 * ║      already established.                                                ║
 * ║                                                                          ║
 * ║   All of it is subtracted BEFORE GST: priceBill() takes the combined     ║
 * ║   figure as its single `discount`, caps it at the subtotal, and          ║
 * ║   allocates it across tax rates pro-rata. Tax is therefore computed on   ║
 * ║   the discounted value, and the bill can never go negative.              ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * ── Why this module exists ──────────────────────────────────────────────────
 * Two callers need the same answer: issueInvoiceForBooking(), which APPLIES it,
 * and getBillableForBooking(), which PREVIEWS it on the POS screen. One
 * implementation here means the preview cannot drift from the charge.
 *
 * The application is authoritative in exactly ONE place — the invoice path. The
 * preview only displays; nothing it returns is ever persisted.
 *
 * ── What is NOT here, and why ───────────────────────────────────────────────
 * Free hours and wallet credit are part of the membership snapshot but are
 * deliberately NOT applied to a bill by this ticket. Neither has defined
 * semantics in the codebase yet, and guessing at either would mis-bill real
 * money. See the notes at the bottom of this file for exactly what must be
 * decided before they can be implemented.
 */

type Db = NodePgDatabase<typeof schema>

export type AppliedMembershipBenefit = {
  /** customer_memberships.id — the row whose snapshot was used. */
  membershipId: string
  /** Snapshotted plan name, for the receipt. */
  planName: string
  /** Snapshotted percentage, 0–100. */
  discountPercent: number
  /** Rupees, 2dp — the money this benefit takes off the subtotal. */
  discountAmount: number
}

/**
 * The money a membership discount is worth on a given subtotal.
 *
 * Pure, and deliberately so: priceBill() is a pure function and this sits
 * beside it. Uses round2(), the project's single money helper — no new
 * arithmetic and no floating-point comparison.
 *
 * Clamped to [0, subtotal] so a nonsense percentage can never produce a
 * negative discount or one larger than the bill.
 */
export function membershipDiscountAmount(subtotal: number, discountPercent: number): number {
  if (!Number.isFinite(subtotal) || subtotal <= 0) return 0
  if (!Number.isFinite(discountPercent) || discountPercent <= 0) return 0

  const percent = Math.min(round2(discountPercent), 100)
  return Math.min(round2((round2(subtotal) * percent) / 100), round2(subtotal))
}

/**
 * The benefit this customer's live membership confers on this subtotal, or null.
 *
 * Returns null — meaning "no benefit" — when the customer has no membership,
 * when the membership is not eligible, or when its snapshot carries no
 * discount. There is no path by which an ineligible membership yields money off.
 *
 * ── Eligibility ─────────────────────────────────────────────────────────────
 * Delegated wholesale to AROS-60's getMembershipBenefits(), which is the single
 * definition in the codebase:
 *
 *     status = 'active'  AND  now() < expires_at  AND  tenant-scoped
 *
 * Both halves are tested there, in SQL, so an expired membership is invisible
 * to this function even though its row still reads status='active'. AROS-60
 * also guarantees at most ONE eligible membership per customer (a partial
 * unique index), so there is no "which one applies?" tie-break to invent here.
 *
 * ── Snapshot, not plan ──────────────────────────────────────────────────────
 * Every number comes off the customer_memberships row. Nothing in this call
 * chain reads membership_plans, so repricing or retiring a plan cannot change
 * what an existing member is charged.
 *
 * ── Tenant scoping ──────────────────────────────────────────────────────────
 * `tenantId` comes from the authenticated context and `customerId` from the
 * BOOKING, never from the browser. The query is tenant-scoped and runs on the
 * RLS connection, so a membership belonging to another tenant matches nothing.
 */
export async function resolveMembershipBenefit(
  tx: Db,
  tenantId: string,
  customerId: string | null,
  subtotal: number,
  now: Date = new Date(),
): Promise<AppliedMembershipBenefit | null> {
  // A walk-in booking has no customer, so there is no membership to find.
  if (!customerId) return null

  const found = await getMembershipBenefits(tx, tenantId, customerId, now)
  if (!found) return null

  const discountPercent = round2(found.benefits.discountPercent)
  const discountAmount = membershipDiscountAmount(subtotal, discountPercent)

  // A membership with a 0% discount is still a membership (it may carry free
  // hours or wallet credit), but it takes nothing off this bill. Reporting null
  // keeps "benefit applied" and "money taken off" the same question.
  if (discountAmount <= 0) return null

  return {
    membershipId: found.membership.id,
    planName: found.membership.planName,
    discountPercent,
    discountAmount,
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * DEFERRED: free hours and wallet credit
 *
 * Both are snapshotted on customer_memberships and both are readable here, but
 * neither is applied to a bill, because neither has semantics the existing code
 * defines. The ticket's instruction is explicit — do not invent business logic
 * that could cause incorrect billing — so they are left out with the open
 * questions written down.
 *
 * FREE HOURS. A booking line is `qty = durationHours(slot)` at
 * `unitPrice = rate_applied` (lib/billing/invoice.ts:loadBookingLines), so
 * "2 free hours" plainly means reducing billed hours by 2. What is undefined:
 *   * ALLOCATION across slots at different rates. A 3-hour booking on a ₹400
 *     bay plus a 1-hour booking on a ₹900 studio, with 2 free hours, is worth
 *     ₹800, ₹1300 or ₹1000 depending on whether hours come off the cheapest
 *     line, the dearest line, or pro-rata. Three defensible rules, three
 *     different charges.
 *   * PARTIAL hours. Whether a 90-minute slot may consume 1.5 of the allowance
 *     or must round.
 *   * INTERACTION with the percentage discount. Whether the membership discount
 *     then applies to the already-reduced subtotal (compounding) or to the
 *     pre-free-hours figure.
 *   * DRAWDOWN TIMING against voided or re-issued bills. AROS-60's
 *     consumeFreeHours() is transactional and CHECK-guarded, but nothing yet
 *     says whether voiding an invoice returns the hours.
 * Until those four are decided, free_hours is carried, displayed, and not spent.
 *
 * WALLET CREDIT. The ledger is built and works: wallet_transactions (0007) is
 * append-only and signed, balance = sum(amount), and AROS-60 CREDITS it at
 * purchase (source_type='membership'). Nothing debits it. The
 * `payment_method` enum carries 'wallet' but POS_PAYMENT_METHODS deliberately
 * excludes it, so the till cannot tender against a balance. Wallet credit is
 * therefore a BALANCE GRANTED AT PURCHASE, not a bill reduction — treating it
 * as an automatic discount here would hand out the same ₹500 on every bill for
 * the life of the membership. Spending it is a payment-method feature, not a
 * pricing one, and belongs in the ticket that adds a wallet tender.
 * ──────────────────────────────────────────────────────────────────────────── */
