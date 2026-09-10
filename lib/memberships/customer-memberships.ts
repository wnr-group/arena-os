import { and, desc, eq, gt, lte, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { z } from 'zod'
import type * as schema from '@/db/schema'
import { addMonths } from '@/lib/utils/date'
import {
  customerMemberships,
  customers,
  membershipPlans,
  walletTransactions,
} from '@/db/schema'
import {
  MAX_PAYMENT_AMOUNT,
  POS_PAYMENT_METHODS,
  paise,
  recordPaymentForInvoice,
} from '@/lib/billing/payments'
import { issueMembershipInvoice } from '@/lib/billing/invoice'
import { round2 } from '@/lib/billing/pricing'

/**
 * Customer membership lifecycle — purchase, renewal, expiry, cancellation.
 *
 * Takes a `tx` rather than opening its own, the same shape as
 * lib/billing/invoice.ts and lib/payments/deposit-settlement.ts, so the caller
 * supplies an RLS-scoped transaction via withUser() and this stays testable
 * without a request context.
 *
 * ── THE eligibility invariant ───────────────────────────────────────────────
 *
 *     status = 'active'  AND  now() < expires_at  AND  same tenant throughout
 *
 * isEligible() below is the single expression of it, and every read path goes
 * through it. Both halves are tested every time: nothing sweeps this table on a
 * timer, so a lapsed membership sits at status='active' until something touches
 * it. Checking only the column would hand out benefits for a membership that
 * ran out months ago. expireLapsed() exists to tidy the rows, but no
 * correctness anywhere depends on it having run.
 *
 * ── Benefits are read from the SNAPSHOT, never from the plan ────────────────
 * Nothing in this module joins membership_plans to read a price, a discount, a
 * free-hour allowance or a wallet credit. Those come off the customer_membership
 * row, which froze them at purchase. `planId` answers "which plan was this?"
 * and nothing else.
 */

type Db = NodePgDatabase<typeof schema>

/** Membership rule violations the caller should see verbatim. */
export class MembershipError extends Error {}

export type CustomerMembership = typeof customerMemberships.$inferSelect

/** The benefits a membership confers, as numbers, straight off the snapshot. */
export type MembershipBenefits = {
  discountPercent: number
  freeHours: number
  freeHoursRemaining: number
  walletCredit: number
}

/**
 * THE invariant, in one place.
 *
 * `now` is a parameter so expiry can be reasoned about deterministically in
 * tests rather than depending on wall-clock timing.
 */
export function isEligible(
  m: Pick<CustomerMembership, 'status' | 'expiresAt'>,
  now: Date = new Date(),
): boolean {
  return m.status === 'active' && now < m.expiresAt
}

/** Benefits off the snapshot. Callers must check isEligible() first. */
export function benefitsOf(m: CustomerMembership): MembershipBenefits {
  const freeHours = round2(Number(m.freeHours))
  const used = round2(Number(m.freeHoursUsed))
  return {
    discountPercent: round2(Number(m.discountPercent)),
    freeHours,
    freeHoursRemaining: Math.max(0, round2(freeHours - used)),
    walletCredit: round2(Number(m.walletCredit)),
  }
}

/**
 * Moved to lib/utils/date.ts when platform billing needed the same clamping
 * (an admin-assigned subscription's period end has the identical 31st-of-the-
 * month problem a membership expiry does). Re-exported so this module's
 * contract is unchanged — one implementation, two callers, no drift.
 */
export { addMonths } from '@/lib/utils/date'

/**
 * Move lapsed memberships out of 'active'.
 *
 * Housekeeping only — see the invariant note above. Safe to run repeatedly and
 * safe never to run. Scoped to one customer when `customerId` is given, which
 * is how the purchase path clears the way for a renewal.
 */
export async function expireLapsed(
  tx: Db,
  tenantId: string,
  customerId?: string,
  now: Date = new Date(),
): Promise<number> {
  const rows = await tx
    .update(customerMemberships)
    .set({ status: 'expired' })
    .where(
      and(
        eq(customerMemberships.tenantId, tenantId),
        eq(customerMemberships.status, 'active'),
        lte(customerMemberships.expiresAt, now),
        ...(customerId ? [eq(customerMemberships.customerId, customerId)] : []),
      ),
    )
    .returning({ id: customerMemberships.id })
  return rows.length
}

/**
 * The customer's currently-eligible membership, or null.
 *
 * The clock test is in the WHERE clause, so a lapsed row is invisible here even
 * if expireLapsed() has never run. This is the function AROS-61 should call.
 */
export async function getActiveMembership(
  tx: Db,
  tenantId: string,
  customerId: string,
  now: Date = new Date(),
): Promise<CustomerMembership | null> {
  const [row] = await tx
    .select()
    .from(customerMemberships)
    .where(
      and(
        eq(customerMemberships.tenantId, tenantId),
        eq(customerMemberships.customerId, customerId),
        eq(customerMemberships.status, 'active'),
        gt(customerMemberships.expiresAt, now),
      ),
    )
    .limit(1)
  return row ?? null
}

/**
 * Eligible membership plus its benefits — the one call AROS-61 needs to price a
 * bill. Returns null when the customer has no live membership, so a caller that
 * forgets to check eligibility cannot accidentally read benefits.
 */
export async function getMembershipBenefits(
  tx: Db,
  tenantId: string,
  customerId: string,
  now: Date = new Date(),
): Promise<{ membership: CustomerMembership; benefits: MembershipBenefits } | null> {
  const membership = await getActiveMembership(tx, tenantId, customerId, now)
  if (!membership) return null
  return { membership, benefits: benefitsOf(membership) }
}

/** Every membership a customer has ever held, newest first. */
export async function listCustomerMemberships(
  tx: Db,
  tenantId: string,
  customerId: string,
): Promise<CustomerMembership[]> {
  return tx
    .select()
    .from(customerMemberships)
    .where(
      and(
        eq(customerMemberships.tenantId, tenantId),
        eq(customerMemberships.customerId, customerId),
      ),
    )
    .orderBy(desc(customerMemberships.startsAt))
}

export const purchaseMembershipInputSchema = z.object({
  customerId: z.string().uuid('That customer reference is not valid.'),
  planId: z.string().uuid('That plan reference is not valid.'),
  /**
   * How the customer paid. Required whenever the plan costs anything — a
   * membership sale is money crossing the counter, and it is billed and
   * settled through the SAME M1 path as any other tender. Only the counter
   * tenders are accepted; 'online' and 'wallet' are gateway/wallet flows with
   * their own verification, exactly as recordPaymentForInvoice() enforces.
   *
   * Omitted only for a ₹0 comped membership, which owes nothing.
   */
  paymentMethod: z.enum(POS_PAYMENT_METHODS).optional(),
})

export type PurchaseMembershipInput = z.infer<typeof purchaseMembershipInputSchema>

export type PurchaseResult = {
  membershipId: string
  planName: string
  /** Rupees, 2dp — what the customer was charged. */
  pricePaid: number
  startsAt: Date
  expiresAt: Date
  /** Wallet credit granted, if the plan carried any. */
  walletCredited: number
  /** The GST invoice raised for the sale. Null only for a ₹0 comped membership. */
  invoiceId: string | null
  invoiceNumber: string | null
  /** The tender recorded against that invoice. */
  paymentId: string | null
}

/**
 * Sell a membership to a customer.
 *
 * Everything runs in the caller's transaction, so the membership, the wallet
 * credit and the expiry of any superseded membership commit or roll back
 * together. A customer can never end up holding a membership whose wallet
 * credit was never granted, or vice versa.
 *
 * ── What the browser supplies ───────────────────────────────────────────────
 * A customer id and a plan id. Nothing else. The price, the duration and every
 * benefit are read from the plan row inside this transaction and copied onto
 * the membership; there is no amount in the input type, so there is no field a
 * caller could pass one through.
 *
 * ── Renewal ─────────────────────────────────────────────────────────────────
 * A lapsed membership is expired first, clearing the partial unique index for
 * the new row. A membership that is still LIVE blocks the sale — selling a
 * second overlapping membership would make "which discount applies?"
 * ambiguous, and the customer should be told rather than silently double-sold.
 */
export async function purchaseMembership(
  tx: Db,
  actor: {
    tenantId: string
    membershipId: string | null
    /** Tenant timezone — the GST invoice number is scoped to its financial year. */
    timezone: string
    /** Branch for the invoice. The seller's, or the tenant's primary. */
    branchId: string
  },
  input: PurchaseMembershipInput,
  now: Date = new Date(),
): Promise<PurchaseResult> {
  const { customerId, planId, paymentMethod } = purchaseMembershipInputSchema.parse(input)
  const { tenantId } = actor

  // ── 1. the customer must be ours ──────────────────────────────────────────
  // RLS scopes this too; the explicit tenant predicate means a future refactor
  // cannot quietly drop the check.
  const [customer] = await tx
    .select({ id: customers.id, name: customers.name })
    .from(customers)
    .where(and(eq(customers.id, customerId), eq(customers.tenantId, tenantId)))
    .for('update')
    .limit(1)

  if (!customer) throw new MembershipError('Customer not found.')

  // ── 2. the plan must be ours, and on sale ─────────────────────────────────
  const [plan] = await tx
    .select()
    .from(membershipPlans)
    .where(and(eq(membershipPlans.id, planId), eq(membershipPlans.tenantId, tenantId)))
    .limit(1)

  if (!plan) throw new MembershipError('Membership plan not found.')
  if (!plan.isActive) {
    throw new MembershipError(`${plan.name} is no longer on sale.`)
  }

  // ── 3. clear any lapsed membership, then refuse to double-sell ────────────
  // The customer row is locked above, so two tills selling at the same instant
  // serialise here; the partial unique index is the backstop if they somehow
  // do not.
  await expireLapsed(tx, tenantId, customerId, now)

  const live = await getActiveMembership(tx, tenantId, customerId, now)
  if (live) {
    throw new MembershipError(
      `This customer already holds an active ${live.planName} membership until ${live.expiresAt.toISOString().slice(0, 10)}.`,
    )
  }

  // ── 4. price and period, from the PLAN row ────────────────────────────────
  const pricePaid = round2(Number(plan.price))
  if (!Number.isFinite(pricePaid) || paise(pricePaid) < 0) {
    throw new MembershipError('That plan has no valid price.')
  }
  if (pricePaid > MAX_PAYMENT_AMOUNT) {
    throw new MembershipError('That plan price is too large to sell.')
  }
  if (!Number.isInteger(plan.durationMonths) || plan.durationMonths <= 0) {
    throw new MembershipError('That plan has no valid duration.')
  }

  // A priced membership must be paid for. Selling one with no tender would put
  // money on the counter that never reaches the books.
  if (paise(pricePaid) > 0 && !paymentMethod) {
    throw new MembershipError('Choose how the customer is paying.')
  }

  const startsAt = now
  const expiresAt = addMonths(startsAt, plan.durationMonths)

  // ── 5. the snapshot ───────────────────────────────────────────────────────
  // Written as fixed 2-decimal strings, matching how the numeric columns are
  // read back, so a benefit never round-trips through a float on the way in.
  const walletCredit = round2(Number(plan.walletCredit))

  const [created] = await tx
    .insert(customerMemberships)
    .values({
      tenantId,
      customerId,
      planId: plan.id,
      planName: plan.name,
      pricePaid: pricePaid.toFixed(2),
      durationMonths: plan.durationMonths,
      // Copied verbatim from the plan — these are already numeric(…) strings,
      // so passing them straight through is exact.
      discountPercent: plan.discountPercent,
      freeHours: plan.freeHours,
      walletCredit: plan.walletCredit,
      freeHoursUsed: '0',
      status: 'active',
      startsAt,
      expiresAt,
      soldBy: actor.membershipId,
    })
    .returning({ id: customerMemberships.id })

  // ── 6. bill it, and take the money ────────────────────────────────────────
  // Through the SAME M1 path every other sale uses: issueMembershipInvoice()
  // shares priceBill(), the GST sequence and the prefix with the booking bill,
  // and recordPaymentForInvoice() applies the same invoice lock, the same
  // capturedTotal() read and the same overpayment rule a cashier's tender is
  // held to. No second payment flow, no second balance calculation.
  //
  // All of it is in the caller's transaction, so a membership can never exist
  // without its invoice, nor an invoice without its tender.
  let invoiceId: string | null = null
  let invoiceNumber: string | null = null
  let paymentId: string | null = null

  if (paise(pricePaid) > 0) {
    const invoice = await issueMembershipInvoice(
      tx,
      { id: tenantId, timezone: actor.timezone },
      {
        branchId: actor.branchId,
        customerId,
        planName: plan.name,
        price: pricePaid,
        membershipId: created.id,
      },
    )
    invoiceId = invoice.invoiceId
    invoiceNumber = invoice.invoiceNumber

    const tender = await recordPaymentForInvoice(
      tx,
      // recordPaymentForInvoice needs a collecting membership; a membership sale
      // always has one, because canBill() gates the action.
      { tenantId, membershipId: actor.membershipId ?? '' },
      { invoiceId: invoice.invoiceId, method: paymentMethod!, amount: pricePaid },
    )
    paymentId = tender.paymentId

    // Link the bill back onto the membership so the profile can show it and
    // AROS-61 can trace what was charged.
    await tx
      .update(customerMemberships)
      .set({ invoiceId: invoice.invoiceId })
      .where(
        and(
          eq(customerMemberships.id, created.id),
          eq(customerMemberships.tenantId, tenantId),
        ),
      )
  }

  // ── 7. grant the wallet credit ────────────────────────────────────────────
  // Through the existing append-only ledger (0007) — no balance column is
  // touched, because the balance IS the sum of this ledger. Same transaction as
  // the membership, so the two can never disagree.
  if (paise(walletCredit) > 0) {
    await tx.insert(walletTransactions).values({
      tenantId,
      customerId,
      amount: walletCredit.toFixed(2),
      reason: `${plan.name} membership credit`,
      sourceType: 'membership',
      sourceId: created.id,
      createdBy: actor.membershipId,
    })
  }

  // ── 8. keep the denormalised badge in step ────────────────────────────────
  // customers.membership_status is a free-text label the profile header shows.
  // It is a CACHE of the row above, never a source of truth for eligibility.
  await tx
    .update(customers)
    .set({ membershipStatus: plan.name })
    .where(and(eq(customers.id, customerId), eq(customers.tenantId, tenantId)))

  return {
    membershipId: created.id,
    planName: plan.name,
    pricePaid,
    startsAt,
    expiresAt,
    walletCredited: paise(walletCredit) > 0 ? walletCredit : 0,
    invoiceId,
    invoiceNumber,
    paymentId,
  }
}

/**
 * Cancel a membership.
 *
 * Sets status='cancelled' rather than deleting: the customer paid for it and
 * the row is financial history. Benefits stop immediately, because isEligible()
 * requires status='active'.
 *
 * The wallet credit already granted is deliberately NOT clawed back — it may
 * already have been spent, and reversing it would drive the balance negative.
 * A refund is a separate, deliberate act.
 */
export async function cancelMembership(
  tx: Db,
  tenantId: string,
  membershipId: string,
  now: Date = new Date(),
): Promise<void> {
  const rows = await tx
    .update(customerMemberships)
    .set({ status: 'cancelled', cancelledAt: now })
    .where(
      and(
        eq(customerMemberships.id, membershipId),
        eq(customerMemberships.tenantId, tenantId),
        eq(customerMemberships.status, 'active'),
      ),
    )
    .returning({ customerId: customerMemberships.customerId })

  if (rows.length === 0) {
    throw new MembershipError('That membership is not active, or does not exist.')
  }

  // Drop the profile badge only if nothing else is live for this customer.
  const stillLive = await getActiveMembership(tx, tenantId, rows[0].customerId, now)
  if (!stillLive) {
    await tx
      .update(customers)
      .set({ membershipStatus: null })
      .where(
        and(eq(customers.id, rows[0].customerId), eq(customers.tenantId, tenantId)),
      )
  }
}

/**
 * Draw down the free-hours benefit — the hook AROS-61 will use when it applies
 * free hours to a bill.
 *
 * The `free_hours_used <= free_hours` CHECK is the real guarantee: a concurrent
 * double-spend fails at the database rather than handing out hours twice. The
 * WHERE re-tests eligibility so a lapsed membership cannot be drawn against.
 */
export async function consumeFreeHours(
  tx: Db,
  tenantId: string,
  membershipId: string,
  hours: number,
  now: Date = new Date(),
): Promise<number> {
  const requested = round2(hours)
  if (!Number.isFinite(requested) || requested <= 0) {
    throw new MembershipError('Enter a number of hours greater than zero.')
  }

  const rows = await tx
    .update(customerMemberships)
    .set({
      freeHoursUsed: sql`${customerMemberships.freeHoursUsed} + ${requested.toFixed(2)}::numeric`,
    })
    .where(
      and(
        eq(customerMemberships.id, membershipId),
        eq(customerMemberships.tenantId, tenantId),
        eq(customerMemberships.status, 'active'),
        gt(customerMemberships.expiresAt, now),
        // Only as far as the allowance goes.
        sql`${customerMemberships.freeHoursUsed} + ${requested.toFixed(2)}::numeric <= ${customerMemberships.freeHours}`,
      ),
    )
    .returning({ used: customerMemberships.freeHoursUsed })

  if (rows.length === 0) {
    throw new MembershipError('Not enough free hours remaining on this membership.')
  }
  return round2(Number(rows[0].used))
}
