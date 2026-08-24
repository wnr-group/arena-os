/**
 * Loyalty tiers — the pure computation.
 *
 * No imports, no database, no `server-only`: this is arithmetic over values the
 * caller has already fetched, in the same spirit as lib/billing/pricing.ts. That
 * is what lets scripts/test-loyalty-tiers.ts exercise every boundary without a
 * database, and what keeps the rule in one readable place instead of spread
 * across a query.
 *
 * ══ THE POINTS BASIS ═══════════════════════════════════════════════════════
 *
 * Tiers are keyed on LIFETIME POINTS EARNED — not the spendable balance that
 * loyaltyPoints() returns, and not a rolling window.
 *
 * The distinction is not cosmetic. loyaltyPoints() (lib/customers/ledger.ts) is
 * `sum(points)` across EVERY ledger row, so a redemption lowers it. Keying
 * tiers off that number would DEMOTE a customer for spending the rewards they
 * earned: Gold on Monday, Silver on Tuesday because they redeemed 200 points at
 * the till. A tier records custom given, so it rises with spending and falls
 * only when an earn is genuinely reversed.
 *
 * Migration 0039 already made this derivable with no new storage. It defines
 * four purposes in loyalty_transactions.source_type, and exactly two of them
 * move lifetime earned:
 *
 *     invoice_earn    credit — points earned when an invoice settles
 *     earn_reversal   debit  — that earn taken back when the invoice is voided
 *
 * while invoice_redeem and redeem_reversal move only the spendable balance.
 * Lifetime earned is therefore `sum(points)` filtered to those two — which is
 * what lifetimeLoyaltyPoints() in lib/loyalty/data.ts computes, in SQL.
 *
 * A rolling window ("points earned in the last 12 months") was considered and
 * rejected: nothing in the existing schema or business logic suggests tier
 * expiry, and adding it would mean a customer's tier could silently drop with
 * no ledger event to explain it. If a venue ever wants that, it is a new
 * setting and a new decision, not a reinterpretation of this one.
 */

/**
 * The ledger source types that count toward a tier.
 *
 * Every row loyalty_transactions currently receives carries one of the four
 * values from LOYALTY_SOURCE (lib/billing/loyalty.ts); there is no manual
 * adjustment path today. If one is ever added, it must pick a source type and
 * this list must be revisited deliberately — a goodwill credit that should lift
 * a tier will NOT do so until it appears here, and that omission being visible
 * is the point.
 */
export const TIER_EARNING_SOURCE_TYPES = ['invoice_earn', 'earn_reversal'] as const

/** One rung of the ladder. Mirrors the loyalty_tiers row the portal renders. */
export type LoyaltyTier = {
  id: string
  name: string
  /** Lifetime points earned at or above which this tier is held. */
  threshold: number
  perk: string | null
  sortOrder: number
}

export type TierProgress = {
  /** Lifetime points earned — the number the thresholds are compared against. */
  currentPoints: number
  /** Threshold of the tier currently held. */
  currentThreshold: number
  /** Threshold of the next tier, or null at the top. */
  nextThreshold: number | null
  /** Points still needed for the next tier. 0 at the top. */
  pointsToNext: number
  /** 0–1, clamped. 1 at the top tier. */
  fraction: number
  /** 0–100, rounded to a whole number for display. 100 at the top tier. */
  percentage: number
  /** True when there is no higher tier to reach. */
  isMaxTier: boolean
}

export type TierStanding = {
  /** Null only when the tenant has no tier the customer qualifies for. */
  currentTier: LoyaltyTier | null
  nextTier: LoyaltyTier | null
  progress: TierProgress
}

/**
 * The fallback ladder, used when a tenant has no loyalty_tiers rows.
 *
 * Same convention as DEFAULT_LOYALTY_RULE in lib/billing/loyalty.ts: "no row"
 * and "default row" behave identically, so a tenant created after migration
 * 0049 (which only seeds tenants existing at the time) still gets a sensible
 * ladder. The ids are sentinels, not database keys — they never appear in
 * loyalty_tiers, so nothing can be written against them by mistake.
 */
export const DEFAULT_TIERS: LoyaltyTier[] = [
  { id: 'default-bronze', name: 'Bronze', threshold: 0, perk: 'Welcome to the programme.', sortOrder: 0 },
  { id: 'default-silver', name: 'Silver', threshold: 500, perk: 'Priority booking.', sortOrder: 1 },
  {
    id: 'default-gold',
    name: 'Gold',
    threshold: 1000,
    perk: 'Priority booking and member pricing.',
    sortOrder: 2,
  },
]

/**
 * Sort a ladder by threshold, ascending.
 *
 * computeTierStanding() calls this itself, so callers may pass tiers in ANY
 * order — a reader that sorted by sort_order, a hand-written array in a test,
 * or rows straight out of a query with no ORDER BY. The ladder's meaning comes
 * from its thresholds, not from the order it arrived in, and depending on the
 * caller to sort correctly would make the rule silently wrong rather than
 * loudly wrong.
 *
 * `sortOrder` breaks ties for DISPLAY only; the unique (tenant_id, threshold)
 * constraint in 0049 means a real tie cannot exist in the database.
 */
export function sortTiers(tiers: readonly LoyaltyTier[]): LoyaltyTier[] {
  return [...tiers].sort((a, b) => a.threshold - b.threshold || a.sortOrder - b.sortOrder)
}

/**
 * Where a customer stands.
 *
 * ── Boundary rule ───────────────────────────────────────────────────────────
 *
 *   points >= tier.threshold  ⇒  the customer qualifies for that tier
 *
 * and the HIGHEST qualifying tier wins. With Bronze 0 / Silver 500 / Gold 1000:
 *
 *     0 → Bronze      499 → Bronze     500 → Silver
 *   999 → Silver     1000 → Gold      1500 → Gold
 *
 * ── Cases that would otherwise produce nonsense ─────────────────────────────
 *
 *   * no tiers configured     → currentTier and nextTier null, 0%, not max.
 *   * points below the lowest threshold (a ladder that starts above 0) →
 *     currentTier null, nextTier the lowest rung, and progress measured from 0.
 *   * at the top rung          → nextTier null, pointsToNext 0, 100%.
 *   * adjacent thresholds      → the span is at least 1, so the division below
 *     can never be by zero even if two rungs are one point apart.
 *   * negative points (a ledger dominated by reversals) → treated as 0 rather
 *     than producing a negative percentage.
 */
export function computeTierStanding(
  points: number,
  tiers: readonly LoyaltyTier[],
): TierStanding {
  // A NaN or negative total would poison every comparison below. Lifetime
  // earned should never be negative, but a ledger where reversals outweigh
  // earns is arithmetically possible, and 0 is the only sane floor.
  const currentPoints = Number.isFinite(points) ? Math.max(0, Math.trunc(points)) : 0

  const ladder = sortTiers(tiers)

  if (ladder.length === 0) {
    return {
      currentTier: null,
      nextTier: null,
      progress: {
        currentPoints,
        currentThreshold: 0,
        nextThreshold: null,
        pointsToNext: 0,
        fraction: 0,
        percentage: 0,
        // Not "max": there is no ladder at all, which is a different thing from
        // standing at the top of one.
        isMaxTier: false,
      },
    }
  }

  // The highest rung whose threshold the customer has reached. `null` when the
  // ladder's lowest threshold is above their points.
  let currentTier: LoyaltyTier | null = null
  for (const tier of ladder) {
    if (currentPoints >= tier.threshold) currentTier = tier
    else break
  }

  const nextTier = ladder.find((tier) => tier.threshold > currentPoints) ?? null

  const currentThreshold = currentTier?.threshold ?? 0
  const isMaxTier = nextTier === null

  if (isMaxTier) {
    return {
      currentTier,
      nextTier: null,
      progress: {
        currentPoints,
        currentThreshold,
        nextThreshold: null,
        pointsToNext: 0,
        fraction: 1,
        percentage: 100,
        isMaxTier: true,
      },
    }
  }

  const nextThreshold = nextTier.threshold
  // nextThreshold > currentPoints >= currentThreshold, so the span is >= 1 and
  // this division is always safe.
  const span = nextThreshold - currentThreshold
  const gained = currentPoints - currentThreshold

  const fraction = clamp01(span > 0 ? gained / span : 0)

  return {
    currentTier,
    nextTier,
    progress: {
      currentPoints,
      currentThreshold,
      nextThreshold,
      pointsToNext: Math.max(0, nextThreshold - currentPoints),
      fraction,
      // Rounded for display. Deliberately allowed to read 0% or 100% only when
      // the fraction genuinely is 0 or 1 — see clamp01.
      percentage: Math.round(fraction * 100),
      isMaxTier: false,
    },
  }
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0
  if (n < 0) return 0
  if (n > 1) return 1
  return n
}
