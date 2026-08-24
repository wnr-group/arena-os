/**
 * Proves the loyalty tier rules in lib/loyalty/tiers.ts:
 *   - a customer holds the HIGHEST tier whose threshold they have reached
 *     (points >= threshold), checked on every boundary
 *   - progress is measured between the held threshold and the next one, and is
 *     clamped so it can never read below 0% or above 100%
 *   - the top tier reports no next tier, 0 points to go, and 100%
 *   - a ladder supplied out of order gives the same answer as a sorted one
 *   - degenerate configurations (none, one rung, adjacent rungs, a ladder that
 *     starts above zero) produce sane values rather than NaN or Infinity
 *
 * Pure logic, so like scripts/test-pricing.ts it needs no database.
 *
 *   npx tsx scripts/test-loyalty-tiers.ts
 */
import {
  computeTierStanding,
  sortTiers,
  DEFAULT_TIERS,
  TIER_EARNING_SOURCE_TYPES,
  type LoyaltyTier,
} from '../lib/loyalty/tiers'

let pass = 0,
  fail = 0
const check = (l: string, c: boolean) => {
  console.log(`${c ? '✓' : '✗ FAIL'}  ${l}`)
  if (c) pass++
  else fail++
}

/** A rung, so each test only spells out the numbers it cares about. */
const tier = (name: string, threshold: number, sortOrder = threshold): LoyaltyTier => ({
  id: `t-${name.toLowerCase()}`,
  name,
  threshold,
  perk: null,
  sortOrder,
})

const BRONZE = tier('Bronze', 0, 0)
const SILVER = tier('Silver', 500, 1)
const GOLD = tier('Gold', 1000, 2)
const LADDER = [BRONZE, SILVER, GOLD]

// ══ 1. the points basis ══════════════════════════════════════════════════════
console.log('\n── points basis ──')

check(
  'only earn and earn-reversal count toward a tier',
  TIER_EARNING_SOURCE_TYPES.length === 2 &&
    TIER_EARNING_SOURCE_TYPES.includes('invoice_earn') &&
    TIER_EARNING_SOURCE_TYPES.includes('earn_reversal'),
)
check(
  'redemptions are NOT part of the basis (spending must not demote)',
  !(TIER_EARNING_SOURCE_TYPES as readonly string[]).includes('invoice_redeem') &&
    !(TIER_EARNING_SOURCE_TYPES as readonly string[]).includes('redeem_reversal'),
)

// ══ 2. boundaries ════════════════════════════════════════════════════════════
console.log('\n── boundaries (Bronze 0 / Silver 500 / Gold 1000) ──')

const at = (points: number) => computeTierStanding(points, LADDER)

const BOUNDARY_CASES: Array<[number, string]> = [
  [0, 'Bronze'],
  [1, 'Bronze'],
  [499, 'Bronze'],
  [500, 'Silver'],
  [501, 'Silver'],
  [999, 'Silver'],
  [1000, 'Gold'],
  [1001, 'Gold'],
  [1_000_000, 'Gold'],
]
for (const [points, expected] of BOUNDARY_CASES) {
  check(`${points} → ${expected}`, at(points).currentTier?.name === expected)
}

check('the threshold itself qualifies (>=, not >)', at(500).currentTier?.name === 'Silver')
check('one point short does not', at(499).currentTier?.name === 'Bronze')

// ══ 3. progress ══════════════════════════════════════════════════════════════
console.log('\n── progress ──')

const mid = at(750)
check('750 → current tier Silver', mid.currentTier?.name === 'Silver')
check('750 → next tier Gold', mid.nextTier?.name === 'Gold')
check('750 → 250 points to go', mid.progress.pointsToNext === 250)
check('750 → 50%', mid.progress.percentage === 50)
check('750 → fraction 0.5', mid.progress.fraction === 0.5)
check('750 → thresholds reported as 500 → 1000', mid.progress.currentThreshold === 500 && mid.progress.nextThreshold === 1000)
check('750 → not max tier', mid.progress.isMaxTier === false)
check('750 → currentPoints echoed back', mid.progress.currentPoints === 750)

const justIn = at(500)
check('at a threshold, progress restarts at 0%', justIn.progress.percentage === 0)
check('…with the full span still to go', justIn.progress.pointsToNext === 500)

const nearlyThere = at(999)
check('999 → 1 point to go', nearlyThere.progress.pointsToNext === 1)
check('999 → 100% rounded but NOT max tier', nearlyThere.progress.percentage === 100 && !nearlyThere.progress.isMaxTier)
check('…and the fraction is still below 1', nearlyThere.progress.fraction < 1)

const early = at(250)
check('250 → Bronze, half way to Silver', early.currentTier?.name === 'Bronze' && early.progress.percentage === 50)

// ══ 4. the top tier ══════════════════════════════════════════════════════════
console.log('\n── top tier ──')

for (const points of [1000, 1500, 99_999]) {
  const top = at(points)
  check(`${points} → Gold`, top.currentTier?.name === 'Gold')
  check(`${points} → no next tier`, top.nextTier === null)
  check(`${points} → 0 points to next`, top.progress.pointsToNext === 0)
  check(`${points} → 100%`, top.progress.percentage === 100)
  check(`${points} → flagged as max tier`, top.progress.isMaxTier === true)
  check(`${points} → nextThreshold null`, top.progress.nextThreshold === null)
}

// ══ 5. ordering ══════════════════════════════════════════════════════════════
console.log('\n── ordering ──')

const shuffled = [GOLD, BRONZE, SILVER]
check(
  'a ladder supplied out of order gives the same answer',
  computeTierStanding(750, shuffled).currentTier?.name === 'Silver' &&
    computeTierStanding(750, shuffled).nextTier?.name === 'Gold',
)
check(
  'sortTiers puts thresholds ascending',
  sortTiers(shuffled).map((t) => t.name).join(',') === 'Bronze,Silver,Gold',
)
check('sortTiers does not mutate its input', shuffled[0].name === 'Gold')
check(
  'every boundary still holds with a shuffled ladder',
  BOUNDARY_CASES.every(([p, expected]) => computeTierStanding(p, shuffled).currentTier?.name === expected),
)

// ══ 6. degenerate configurations ═════════════════════════════════════════════
console.log('\n── degenerate ladders ──')

const none = computeTierStanding(750, [])
check('no tiers → no current tier', none.currentTier === null)
check('no tiers → no next tier', none.nextTier === null)
check('no tiers → 0%', none.progress.percentage === 0)
check('no tiers → NOT reported as max tier', none.progress.isMaxTier === false)
check('no tiers → points still echoed', none.progress.currentPoints === 750)

// A ladder whose lowest rung is above zero: the customer holds nothing yet.
const startsHigh = [tier('Silver', 500, 1), tier('Gold', 1000, 2)]
const below = computeTierStanding(100, startsHigh)
check('below the lowest threshold → no current tier', below.currentTier === null)
check('…but the lowest rung is the next one', below.nextTier?.name === 'Silver')
check('…progress measured from zero', below.progress.currentThreshold === 0 && below.progress.percentage === 20)
check('…with the right gap', below.progress.pointsToNext === 400)

const single = computeTierStanding(50, [BRONZE])
check('a one-rung ladder is immediately max', single.currentTier?.name === 'Bronze' && single.progress.isMaxTier)
check('…with 100% and nothing to go', single.progress.percentage === 100 && single.progress.pointsToNext === 0)

// Adjacent thresholds — the span is 1, so the division must not blow up.
const adjacent = [tier('A', 10, 0), tier('B', 11, 1)]
const between = computeTierStanding(10, adjacent)
check('adjacent thresholds → correct tier', between.currentTier?.name === 'A')
check('…1 point to next', between.progress.pointsToNext === 1)
check('…0% and finite', between.progress.percentage === 0 && Number.isFinite(between.progress.fraction))
check('…and one more point promotes', computeTierStanding(11, adjacent).currentTier?.name === 'B')

// Two rungs at the SAME threshold cannot exist in the database (unique
// (tenant_id, threshold), migration 0049) but the function must not panic.
const dupes = [tier('X', 100, 0), tier('Y', 100, 1)]
const dup = computeTierStanding(150, dupes)
check('duplicate thresholds resolve deterministically by sortOrder', dup.currentTier?.name === 'Y')
check('…and still report max tier', dup.progress.isMaxTier === true)

// ══ 7. hostile inputs ════════════════════════════════════════════════════════
console.log('\n── hostile input ──')

const negative = at(-500)
check('negative points are floored to 0', negative.progress.currentPoints === 0)
check('…landing on the lowest tier', negative.currentTier?.name === 'Bronze')
check('…never a negative percentage', negative.progress.percentage >= 0)

const nan = at(Number.NaN)
check('NaN points are treated as 0', nan.progress.currentPoints === 0 && nan.currentTier?.name === 'Bronze')
const inf = at(Number.POSITIVE_INFINITY)
check('Infinity does not produce NaN progress', Number.isFinite(inf.progress.fraction))
// Non-finite input is floored to 0, so it lands on the LOWEST tier, not the
// highest. That direction is deliberate: a tier grants entitlements, so a
// nonsense points value must fail closed. Awarding Gold for a NaN would be the
// far worse failure. This cannot arise in practice — the number comes from a
// SQL sum over an integer column — but the safe direction is worth pinning.
check('…and fails CLOSED to the lowest tier, never the highest', inf.currentTier?.name === 'Bronze')
check('…with 0 points recorded', inf.progress.currentPoints === 0)

const fractional = at(750.9)
check('fractional points are truncated, not rounded up', fractional.progress.currentPoints === 750)

// The invariants that must hold for EVERY input.
let invariantsHold = true
for (let p = -50; p <= 1200; p += 7) {
  const r = at(p)
  if (r.progress.percentage < 0 || r.progress.percentage > 100) invariantsHold = false
  if (r.progress.fraction < 0 || r.progress.fraction > 1) invariantsHold = false
  if (!Number.isFinite(r.progress.fraction)) invariantsHold = false
  if (r.progress.pointsToNext < 0) invariantsHold = false
  if (r.nextTier === null && !r.progress.isMaxTier && r.currentTier !== null) invariantsHold = false
}
check('across a sweep of -50…1200: percentage stays within 0–100', invariantsHold)
check('…fraction stays finite and within 0–1', invariantsHold)
check('…pointsToNext is never negative', invariantsHold)

// ══ 8. the shipped defaults ══════════════════════════════════════════════════
console.log('\n── DEFAULT_TIERS ──')

check('there are three default tiers', DEFAULT_TIERS.length === 3)
check(
  'they are Bronze 0 / Silver 500 / Gold 1000',
  DEFAULT_TIERS.map((t) => `${t.name}:${t.threshold}`).join(',') === 'Bronze:0,Silver:500,Gold:1000',
)
check(
  'the defaults match the seeded ladder on every boundary',
  BOUNDARY_CASES.every(([p, expected]) => computeTierStanding(p, DEFAULT_TIERS).currentTier?.name === expected),
)
check(
  'default ids are sentinels, not database keys',
  DEFAULT_TIERS.every((t) => t.id.startsWith('default-')),
)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
