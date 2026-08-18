import { and, eq } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { z } from 'zod'
import type * as schema from '@/db/schema'
import {
  customers,
  invoiceItems,
  invoices,
  loyaltySettings,
  loyaltyTransactions,
} from '@/db/schema'
import { loyaltyPoints } from '@/lib/customers/ledger'
import { paise, round2 } from './pricing'

/**
 * Loyalty points — earning at settlement, redeeming at billing.
 *
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  BILLING DISCOUNT PRECEDENCE — the complete order, as implemented        ║
 * ║                                                                          ║
 * ║    1. Base line pricing.                                                 ║
 * ║       Happy hours would sit here. `happy_hours` exists as a table        ║
 * ║       (0015) but is NOT wired into billing, so there is nothing to       ║
 * ║       order against yet; when it lands it goes at this step.             ║
 * ║                                                                          ║
 * ║    2. MEMBERSHIP benefit — % of subtotal, from the purchased snapshot    ║
 * ║       (AROS-61, lib/billing/membership-benefit.ts).                      ║
 * ║                                                                          ║
 * ║    3. PROMO CODE or a cashier's keyed-in discount — against what         ║
 * ║       remains after (2). A promo still REPLACES a keyed-in figure.       ║
 * ║                                                                          ║
 * ║    4. LOYALTY redemption — against what remains after (3). Last,         ║
 * ║       deliberately: points are a stored-value instrument, so they should ║
 * ║       settle what is genuinely still owed rather than being consumed     ║
 * ║       against value a promo was about to remove anyway. Redeeming ₹200   ║
 * ║       of points on a bill already discounted to ₹150 would burn ₹50 of   ║
 * ║       the customer's points for nothing, so the redemption is CAPPED at  ║
 * ║       the remainder and only the points actually used are debited.       ║
 * ║                                                                          ║
 * ║    All four are subtracted BEFORE GST: the combined figure goes to       ║
 * ║    priceBill() as one `discount`, which caps it at the subtotal and      ║
 * ║    allocates it across tax rates pro-rata.                               ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * ── The ledger is unchanged ─────────────────────────────────────────────────
 * `loyalty_transactions` (0007) is append-only with a signed INTEGER `points`,
 * and the balance is `sum(points)` via loyaltyPoints(). No balance column is
 * added, no second ledger exists, and nothing here caches a balance across
 * statements.
 *
 * ── When points move ────────────────────────────────────────────────────────
 *   REDEEM (debit)  at invoice ISSUE. That is when pricing is frozen in this
 *                   codebase — the discount is baked into the invoice row and
 *                   cannot be applied later — so the debit must be atomic with
 *                   the invoice that grants it.
 *   EARN (credit)   at invoice SETTLEMENT (status → 'paid'). Awarding at issue
 *                   would hand out points for a bill that is never paid.
 * Both are reversed if the invoice is voided.
 */

type Db = NodePgDatabase<typeof schema>

/** Loyalty rule violations the cashier should see verbatim. */
export class LoyaltyError extends Error {}

/** Ledger `source_type` values. Free text in the schema; enumerated here. */
export const LOYALTY_SOURCE = {
  /** Credit — earned when an invoice settles. `source_id` is the invoice. */
  earn: 'invoice_earn',
  /** Debit — spent as a discount at billing. `source_id` is the invoice. */
  redeem: 'invoice_redeem',
  /** Debit — earn taken back when the invoice is voided. */
  earnReversal: 'earn_reversal',
  /** Credit — redemption returned when the invoice is voided. */
  redeemReversal: 'redeem_reversal',
} as const

export type LoyaltyRule = {
  pointsPerUnit: number
  unitAmount: number
  pointValue: number
  minRedeemPoints: number
  isActive: boolean
}

/**
 * Defaults when a tenant has never configured the programme — the ticket's own
 * worked example. Kept here so "no row" and "default row" behave identically.
 */
export const DEFAULT_LOYALTY_RULE: LoyaltyRule = {
  pointsPerUnit: 1,
  unitAmount: 100,
  pointValue: 1,
  minRedeemPoints: 0,
  isActive: true,
}

/** The tenant's earn/redeem rule, or the defaults above. */
export async function loadLoyaltyRule(tx: Db, tenantId: string): Promise<LoyaltyRule> {
  const [row] = await tx
    .select()
    .from(loyaltySettings)
    .where(eq(loyaltySettings.tenantId, tenantId))
    .limit(1)

  if (!row) return DEFAULT_LOYALTY_RULE
  return {
    pointsPerUnit: row.pointsPerUnit,
    unitAmount: round2(Number(row.unitAmount)),
    pointValue: round2(Number(row.pointValue)),
    minRedeemPoints: row.minRedeemPoints,
    isActive: row.isActive,
  }
}

/**
 * Points earned on a given eligible spend.
 *
 * ── The earn rule ───────────────────────────────────────────────────────────
 * `pointsPerUnit` points for every WHOLE `unitAmount` of spend, floored. At the
 * default 1 per ₹100: ₹999 → 9 points, ₹1000 → 10. Never fractional — the
 * ledger column is `integer`, so a fraction cannot be stored and must not be
 * conjured by rounding up.
 *
 * Compared in paise, so a spend of ₹99.999999 (float noise) cannot tip a unit.
 */
export function pointsForSpend(eligibleSpend: number, rule: LoyaltyRule): number {
  if (!rule.isActive) return 0
  if (!Number.isFinite(eligibleSpend) || eligibleSpend <= 0) return 0
  if (rule.unitAmount <= 0 || rule.pointsPerUnit <= 0) return 0

  const units = Math.floor(paise(eligibleSpend) / paise(rule.unitAmount))
  return units * rule.pointsPerUnit
}

/** Rupees that `points` are worth under a rule. */
export function discountForPoints(points: number, rule: LoyaltyRule): number {
  if (!Number.isFinite(points) || points <= 0) return 0
  return round2(Math.floor(points) * rule.pointValue)
}

/** Points needed to fund `amount` of discount, rounded UP so it is covered. */
export function pointsForDiscount(amount: number, rule: LoyaltyRule): number {
  if (!Number.isFinite(amount) || amount <= 0 || rule.pointValue <= 0) return 0
  return Math.ceil(paise(amount) / paise(rule.pointValue))
}

/**
 * THE eligible-spend rule, in one place.
 *
 *     eligible spend = subtotal − discount   (i.e. the taxable value)
 *
 * Pre-tax and post-discount, chosen deliberately:
 *   * GST is money remitted to the government, not revenue the venue earned —
 *     rewarding it would pay the customer for the tax they were charged.
 *   * Post-discount means points are NOT earned on value a promo, a membership
 *     benefit or a redemption already took off. Without this, redeeming points
 *     would re-earn a slice of them and the programme would leak.
 *
 * `taxableValue` is not a stored column, but it is exactly `subtotal − discount`
 * from the frozen invoice row, so it is historically stable.
 */
export function eligibleSpendFor(invoice: { subtotal: string; discount: string }): number {
  return round2(round2(Number(invoice.subtotal)) - round2(Number(invoice.discount)))
}

/**
 * Lock a customer's loyalty balance for the rest of the transaction.
 *
 * Identical device to the wallet (lib/billing/wallet-payments.ts): the ledger is
 * append-only so there is no row to lock, and two concurrent redemptions would
 * each read the same balance, each find it sufficient, and both insert. Locking
 * the CUSTOMER row serialises every points operation for that customer.
 *
 * Lock ordering across the codebase is always CUSTOMER → INVOICE, so a loyalty
 * redemption and a wallet tender cannot deadlock against each other.
 */
async function lockCustomer(tx: Db, tenantId: string, customerId: string): Promise<void> {
  const [row] = await tx
    .select({ id: customers.id })
    .from(customers)
    .where(and(eq(customers.id, customerId), eq(customers.tenantId, tenantId)))
    .for('update')
    .limit(1)
  if (!row) throw new LoyaltyError('Customer not found.')
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
 * Append one ledger entry, returning false when this (purpose, source) has
 * already been written.
 *
 * The unique index on (tenant_id, source_type, source_id) is what makes this a
 * CLAIM rather than a check: two concurrent finalisations of the same invoice
 * both attempt the insert, exactly one wins, and the loser gets 23505. An
 * application-level "if not exists" would let both through.
 */
async function appendOnce(
  tx: Db,
  row: {
    tenantId: string
    customerId: string
    points: number
    reason: string
    sourceType: string
    sourceId: string
  },
): Promise<boolean> {
  try {
    await tx.insert(loyaltyTransactions).values(row)
    return true
  } catch (e) {
    if (pgCode(e) === '23505') return false
    throw e
  }
}

// ── redeeming, at invoice issue ──────────────────────────────────────────────

export type RedeemedLoyalty = {
  /** Points actually debited — may be fewer than requested if capped. */
  points: number
  /** Rupees taken off the bill. */
  discount: number
  /** ₹ per point honoured, snapshotted onto the invoice. */
  pointValue: number
}

/**
 * Price a requested redemption against the balance and what is still owed.
 *
 * PURE of side effects — nothing is debited here. The caller uses this to work
 * out the discount before priceBill(), and commits it with commitRedemption()
 * once the invoice row exists to reference.
 *
 * `maxDiscountable` is what remains after the membership benefit and any
 * promo/keyed-in discount, per the precedence at the top of this file. The
 * redemption is capped at it and the points are recomputed from the capped
 * amount, so a customer is never charged points for discount they cannot use.
 */
export async function priceRedemption(
  tx: Db,
  tenantId: string,
  customerId: string | null,
  requestedPoints: number,
  maxDiscountable: number,
  rule: LoyaltyRule,
): Promise<RedeemedLoyalty | null> {
  if (!customerId) throw new LoyaltyError('This bill is not linked to a customer.')
  if (!rule.isActive) throw new LoyaltyError('The loyalty programme is not active.')

  const points = Math.floor(requestedPoints)
  if (!Number.isFinite(points) || points <= 0) {
    throw new LoyaltyError('Enter a number of points greater than zero.')
  }
  if (rule.minRedeemPoints > 0 && points < rule.minRedeemPoints) {
    throw new LoyaltyError(`Redeem at least ${rule.minRedeemPoints} points.`)
  }

  // Balance read AFTER the lock the caller has already taken.
  const balance = await loyaltyPoints(tx, tenantId, customerId)
  if (points > balance) {
    throw new LoyaltyError(`Not enough points. ${balance} available.`)
  }

  if (round2(maxDiscountable) <= 0) {
    throw new LoyaltyError('There is nothing left on this bill to redeem against.')
  }

  const requestedDiscount = discountForPoints(points, rule)
  // Cap at what is genuinely still owed, then charge only the points that
  // funded the capped amount — never more.
  const discount = Math.min(requestedDiscount, round2(maxDiscountable))
  const spent = paise(discount) === paise(requestedDiscount)
    ? points
    : pointsForDiscount(discount, rule)

  if (spent <= 0 || paise(discount) <= 0) return null

  return { points: spent, discount, pointValue: rule.pointValue }
}

/**
 * Debit the priced redemption, referencing the invoice it discounted.
 *
 * Called inside the invoice transaction, after the invoice row exists. The
 * unique index makes it idempotent per invoice, so a retried finalisation
 * cannot debit twice.
 */
export async function commitRedemption(
  tx: Db,
  tenantId: string,
  customerId: string,
  invoiceId: string,
  redeemed: RedeemedLoyalty,
): Promise<void> {
  const written = await appendOnce(tx, {
    tenantId,
    customerId,
    // NEGATIVE: the ledger is signed, so a redemption is a negative credit.
    points: -redeemed.points,
    reason: `Redeemed ${redeemed.points} points`,
    sourceType: LOYALTY_SOURCE.redeem,
    sourceId: invoiceId,
  })
  if (!written) {
    throw new LoyaltyError('These points have already been redeemed against this bill.')
  }
}

// ── earning, at settlement ───────────────────────────────────────────────────

/**
 * Award points for an invoice that has just been settled.
 *
 * Called from settleInvoicePaid() — the single seam every payment path funnels
 * through — so no route to 'paid' can miss it and none can double-award.
 *
 * Idempotent by the unique index on (tenant, 'invoice_earn', invoice_id):
 * re-finalising the same invoice writes nothing the second time. Returns the
 * points awarded, or 0 when none were (no customer, programme off, spend below
 * one unit, or already awarded).
 *
 * A voided invoice never reaches here, because void requires every captured
 * payment to be refunded first.
 */
export async function awardPointsForSettledInvoice(
  tx: Db,
  tenantId: string,
  invoiceId: string,
): Promise<number> {
  const [invoice] = await tx
    .select({
      id: invoices.id,
      customerId: invoices.customerId,
      subtotal: invoices.subtotal,
      discount: invoices.discount,
      status: invoices.status,
    })
    .from(invoices)
    .where(and(eq(invoices.id, invoiceId), eq(invoices.tenantId, tenantId)))
    .limit(1)

  // A walk-in bill has nobody to reward.
  if (!invoice?.customerId) return 0
  // Never for a void bill. 'issued' is allowed because the caller is settling
  // it in this same transaction and the row may not be updated yet.
  if (invoice.status === 'void') return 0

  // A WALLET TOP-UP earns nothing. Buying ₹1000 of credit is not spending
  // ₹1000 — the spending happens later, when the credit is used on a real bill,
  // and that bill earns. Awarding here as well would pay twice for one rupee:
  // top up (+10) then spend it (+10) = 20 points for ₹1000, repeatable
  // indefinitely. Membership purchases DO earn: they are a genuine sale.
  const [topUpLine] = await tx
    .select({ id: invoiceItems.id })
    .from(invoiceItems)
    .where(
      and(
        eq(invoiceItems.tenantId, tenantId),
        eq(invoiceItems.invoiceId, invoice.id),
        eq(invoiceItems.kind, 'wallet_topup'),
      ),
    )
    .limit(1)
  if (topUpLine) return 0

  const rule = await loadLoyaltyRule(tx, tenantId)
  if (!rule.isActive) return 0

  const eligibleSpend = eligibleSpendFor(invoice)
  const points = pointsForSpend(eligibleSpend, rule)
  if (points <= 0) return 0

  const written = await appendOnce(tx, {
    tenantId,
    customerId: invoice.customerId,
    points,
    reason: `Earned on ${eligibleSpend.toFixed(2)} eligible spend`,
    sourceType: LOYALTY_SOURCE.earn,
    sourceId: invoice.id,
  })
  // Already awarded — a retry, not an error.
  if (!written) return 0

  // Snapshot onto the bill so a receipt can say "earned 10 points" without
  // recomputing against a rule that may since have changed.
  await tx
    .update(invoices)
    .set({ loyaltyPointsEarned: points })
    .where(and(eq(invoices.id, invoice.id), eq(invoices.tenantId, tenantId)))

  return points
}

/**
 * Mark an invoice paid AND award its loyalty points, atomically.
 *
 * THE settlement seam. Every path that settles a bill — cash/card/UPI, wallet,
 * a verified gateway payment, a carried-over deposit — calls this instead of
 * updating the status itself, so earning cannot be forgotten on one route and
 * cannot happen twice on another.
 */
export async function settleInvoicePaid(
  tx: Db,
  tenantId: string,
  invoiceId: string,
): Promise<number> {
  await tx
    .update(invoices)
    .set({ status: 'paid' })
    .where(and(eq(invoices.id, invoiceId), eq(invoices.tenantId, tenantId)))

  return awardPointsForSettledInvoice(tx, tenantId, invoiceId)
}

// ── reversal, on void ────────────────────────────────────────────────────────

/**
 * Return points a customer REDEEMED against an invoice that has been voided.
 *
 * The bill no longer stands, so the points spent on it come back.
 *
 * ── This no longer touches the EARN side ────────────────────────────────────
 * reconcileInvoiceAfterRefund() owns that, because it is the only place that
 * knows how much has already been clawed back by partial refunds. When this
 * function also reversed the full earn, a bill that was half-refunded (−5 of
 * 10) and then voided got a further −10, driving the balance to −5. The earn is
 * reconciled proportionally; only the redemption is returned here.
 *
 * Idempotent per invoice by the ledger's unique index.
 */
export async function reverseLoyaltyForVoidedInvoice(
  tx: Db,
  tenantId: string,
  invoiceId: string,
): Promise<{ earnReversed: number; redeemReturned: number }> {
  const [invoice] = await tx
    .select({
      id: invoices.id,
      customerId: invoices.customerId,
      pointsRedeemed: invoices.loyaltyPointsRedeemed,
    })
    .from(invoices)
    .where(and(eq(invoices.id, invoiceId), eq(invoices.tenantId, tenantId)))
    .limit(1)

  if (!invoice?.customerId) return { earnReversed: 0, redeemReturned: 0 }

  // The earn side is reconciled by reconcileInvoiceAfterRefund(), which tracks
  // what partial refunds have already clawed back. Reversing it again here
  // would double-count.
  const earnReversed = 0
  let redeemReturned = 0

  if (invoice.pointsRedeemed > 0) {
    const written = await appendOnce(tx, {
      tenantId,
      customerId: invoice.customerId,
      points: invoice.pointsRedeemed,
      reason: 'Points returned — invoice voided',
      sourceType: LOYALTY_SOURCE.redeemReversal,
      sourceId: invoice.id,
    })
    if (written) redeemReturned = invoice.pointsRedeemed
  }

  return { earnReversed, redeemReturned }
}

// ── the till's view ──────────────────────────────────────────────────────────

export const redeemInputSchema = z.object({
  points: z.coerce
    .number({ invalid_type_error: 'Enter a number of points.' })
    .int('Points must be a whole number.')
    .positive('Enter a number of points greater than zero.')
    .max(10_000_000, 'That is more points than any balance.'),
})

/**
 * What the bill screen needs to offer a redemption: the balance and the rule.
 * Read-only. Every limit is re-checked under a lock when the bill is raised.
 */
export async function loyaltyTenderState(
  tx: Db,
  tenantId: string,
  customerId: string | null,
): Promise<{ balance: number; rule: LoyaltyRule } | null> {
  if (!customerId) return null
  const rule = await loadLoyaltyRule(tx, tenantId)
  if (!rule.isActive) return null
  return { balance: await loyaltyPoints(tx, tenantId, customerId), rule }
}

/** Ledger balance — re-exported so callers have one import site. */
export { loyaltyPoints }

/** Locks the customer, then returns the balance. For the redemption path. */
export async function lockedLoyaltyBalance(
  tx: Db,
  tenantId: string,
  customerId: string,
): Promise<number> {
  await lockCustomer(tx, tenantId, customerId)
  return loyaltyPoints(tx, tenantId, customerId)
}
