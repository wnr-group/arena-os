import 'server-only'
import { desc, eq } from 'drizzle-orm'
import { withCustomer, type DB } from '@/db'
import { loyaltyTransactions, walletTransactions } from '@/db/schema'
import { walletBalance, loyaltyPoints } from '@/lib/customers/ledger'
import { loadLoyaltyTiers, lifetimeLoyaltyPoints } from '@/lib/loyalty/data'
import { computeTierStanding, type TierStanding } from '@/lib/loyalty/tiers'
import { requireCustomer } from '@/lib/auth/customer-guard'

/**
 * Wallet & loyalty, read-only, for the signed-in customer.
 *
 * ── Reconciliation with the POS ─────────────────────────────────────────────
 *
 * The balances are NOT recomputed here. Both come from lib/customers/ledger.ts
 * — walletBalance() and loyaltyPoints() — which is the same module the staff
 * customer profile (lib/customers/profile.ts) and the till already call. There
 * is deliberately no second sum anywhere in this file: a portal that added its
 * own arithmetic could drift from the POS by a rounding rule or a filter, and
 * a customer being shown a different balance from the one at the counter is
 * the exact failure this reuse prevents.
 *
 * Those helpers aggregate in SQL (`coalesce(sum(...), 0)`), so no transaction
 * history is loaded into JavaScript to produce a number. The activity lists are
 * separate, LIMIT-ed queries.
 *
 * ── Loyalty tiers ───────────────────────────────────────────────────────────
 *
 * Tiers now exist (migration 0049) and are read through lib/loyalty — the
 * ladder from loadLoyaltyTiers(), the standing from the pure
 * computeTierStanding(). No tier arithmetic happens in this file either.
 *
 * Note the two DIFFERENT point totals below, which is the subtlety of this
 * screen:
 *
 *   loyaltyPoints()        the SPENDABLE balance — what the customer can
 *                          redeem, and what goes down when they do.
 *   lifetimeLoyaltyPoints() what they have EARNED over time — what the tier
 *                          thresholds are measured against, so that redeeming
 *                          rewards never demotes anyone.
 *
 * Both come from the same ledger; neither is stored. See lib/loyalty/tiers.ts
 * for the full reasoning.
 */

/** Matches lib/customers/profile.ts, so portal and staff show the same depth. */
export const LEDGER_LIMIT = 10

export type PortalLedgerEntry = {
  id: string
  /** Signed. Positive is money in / points earned, negative is out / redeemed. */
  amount: string
  reason: string | null
  sourceType: string | null
  createdAt: Date
}

export type PortalWalletData = {
  /** Rupees. Derived from the ledger every time; never stored. */
  walletBalance: number
  /** Points. Derived from the ledger every time; never stored. */
  loyaltyPoints: number
  wallet: PortalLedgerEntry[]
  loyalty: PortalLedgerEntry[]
  /**
   * Where the customer stands on the venue's tier ladder.
   *
   * Keyed on LIFETIME points earned, which is a different number from the
   * `loyaltyPoints` above — that one is the spendable balance and goes down
   * when points are redeemed. See lib/loyalty/tiers.ts.
   */
  tier: TierStanding
  /** The lifetime figure the tier was computed from, for display. */
  lifetimePoints: number
}

export async function getPortalWallet(): Promise<PortalWalletData> {
  const customer = await requireCustomer()
  return withCustomer(customer.id, (tx) => readPortalWallet(tx, customer.tenantId, customer.id))
}

/**
 * The reads, over an ALREADY customer-scoped transaction — same split as the
 * other portal readers so this is drivable from a plain Node script.
 *
 * tenantId and customerId are passed through to the shared ledger helpers
 * because that is their existing signature; neither is trusted as
 * authorisation. Both come from the validated session, and RLS has already
 * reduced every table here to this customer's rows regardless.
 *
 * All four reads share one transaction so the balance and the statement below
 * it cannot disagree — a top-up landing between two round trips would
 * otherwise show a balance that the listed activity does not add up to.
 */
export async function readPortalWallet(
  tx: DB,
  tenantId: string,
  customerId: string,
): Promise<PortalWalletData> {
  const balance = await walletBalance(tx, tenantId, customerId)
  const points = await loyaltyPoints(tx, tenantId, customerId)

  const wallet = await tx
    .select({
      id: walletTransactions.id,
      amount: walletTransactions.amount,
      reason: walletTransactions.reason,
      sourceType: walletTransactions.sourceType,
      createdAt: walletTransactions.createdAt,
    })
    .from(walletTransactions)
    .where(eq(walletTransactions.customerId, customerId))
    .orderBy(desc(walletTransactions.createdAt))
    .limit(LEDGER_LIMIT)

  const loyalty = await tx
    .select({
      id: loyaltyTransactions.id,
      points: loyaltyTransactions.points,
      reason: loyaltyTransactions.reason,
      sourceType: loyaltyTransactions.sourceType,
      createdAt: loyaltyTransactions.createdAt,
    })
    .from(loyaltyTransactions)
    .where(eq(loyaltyTransactions.customerId, customerId))
    .orderBy(desc(loyaltyTransactions.createdAt))
    .limit(LEDGER_LIMIT)

  // The tier ladder and the LIFETIME total — deliberately not `points` above.
  // Both reads are inside the same transaction as the balances, so the tier and
  // the statement it sits beside always describe the same instant.
  const [tiers, lifetimePoints] = [
    await loadLoyaltyTiers(tx, tenantId),
    await lifetimeLoyaltyPoints(tx, tenantId, customerId),
  ]

  return {
    walletBalance: balance,
    loyaltyPoints: points,
    wallet,
    // `points` is an integer column; the shared entry type carries a string so
    // both statements render through one component.
    loyalty: loyalty.map((row) => ({ ...row, amount: String(row.points) })),
    lifetimePoints,
    tier: computeTierStanding(lifetimePoints, tiers),
  }
}
