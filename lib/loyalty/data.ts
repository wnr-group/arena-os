import 'server-only'
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { withUser, type DB } from '@/db'
import { loyaltyTiers, loyaltyTransactions } from '@/db/schema'
import { DEFAULT_TIERS, TIER_EARNING_SOURCE_TYPES, type LoyaltyTier } from './tiers'
import { loadLoyaltyRule, type LoyaltyRule } from '@/lib/billing/loyalty'
import type { ActiveContext } from '@/lib/tenant/context'

/**
 * Loading the inputs the pure computation in ./tiers.ts needs.
 *
 * Both functions take a transaction the caller has already scoped — withUser()
 * for staff, withCustomer() for the portal — so neither decides authorisation
 * and neither needs its own context. RLS (0049) does the scoping either way.
 */

/**
 * The tenant's tier ladder, lowest threshold first.
 *
 * Falls back to DEFAULT_TIERS when the tenant has no rows, so "never
 * configured" behaves exactly like "configured with the defaults" — the same
 * convention loadLoyaltyRule() uses for the earn/redeem rule. Migration 0049
 * seeds tenants that existed when it ran; anything created later lands here.
 */
export async function loadLoyaltyTiers(tx: DB, tenantId: string): Promise<LoyaltyTier[]> {
  const rows = await tx
    .select({
      id: loyaltyTiers.id,
      name: loyaltyTiers.name,
      threshold: loyaltyTiers.threshold,
      perk: loyaltyTiers.perk,
      sortOrder: loyaltyTiers.sortOrder,
    })
    .from(loyaltyTiers)
    .where(eq(loyaltyTiers.tenantId, tenantId))
    .orderBy(asc(loyaltyTiers.threshold), asc(loyaltyTiers.sortOrder))

  return rows.length > 0 ? rows : DEFAULT_TIERS
}

/**
 * LIFETIME POINTS EARNED for one customer — the number tier thresholds are
 * compared against.
 *
 * NOT the same as loyaltyPoints() in lib/customers/ledger.ts, and deliberately
 * a separate function rather than a variant of it. loyaltyPoints() is the
 * SPENDABLE balance (every row, redemptions included) and must stay that way —
 * it is what the till checks before allowing a redemption. This is the
 * lifetime figure, which redemptions must not reduce; see the long note at the
 * top of ./tiers.ts for why conflating them would demote customers for using
 * their rewards.
 *
 * Aggregated in SQL, like every other balance in this codebase: no ledger
 * history is loaded into JavaScript to produce a number.
 *
 * The tenant predicate mirrors loyaltyPoints()' own signature. It is not the
 * authorisation — RLS already scoped the table — but it keeps the query correct
 * on its own terms.
 */
export async function lifetimeLoyaltyPoints(
  tx: DB,
  tenantId: string,
  customerId: string,
): Promise<number> {
  const [row] = await tx
    .select({ total: sql<string>`coalesce(sum(${loyaltyTransactions.points}), 0)` })
    .from(loyaltyTransactions)
    .where(
      and(
        eq(loyaltyTransactions.tenantId, tenantId),
        eq(loyaltyTransactions.customerId, customerId),
        inArray(loyaltyTransactions.sourceType, [...TIER_EARNING_SOURCE_TYPES]),
      ),
    )

  return Number(row?.total ?? 0)
}

/**
 * The tenant's loyalty rule for the SETTINGS page.
 *
 * A thin, tenant-scoped wrapper around loadLoyaltyRule() in
 * lib/billing/loyalty.ts — deliberately not a second query. That function is
 * what the till, the invoice and loyaltyTenderState() all read, so the settings
 * page showing anything else would mean the form and the POS disagreed about
 * what is configured. It also already returns DEFAULT_LOYALTY_RULE when the
 * tenant has no row, which is what makes "never configured" render as the
 * defaults rather than a blank form.
 *
 * withUser() on the restricted app connection, never ownerDb: RLS
 * (loyalty_settings_select, 0039) is the second layer that keeps one tenant out
 * of another's configuration.
 */
export async function getLoyaltySettings(ctx: ActiveContext): Promise<LoyaltyRule> {
  return withUser(ctx.user.id, (tx) => loadLoyaltyRule(tx, ctx.tenant.id))
}
