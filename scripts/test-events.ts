/**
 * Proves the event lifecycle and field rules in lib/events/lifecycle.ts:
 *   - every legal transition is accepted and every illegal one rejected,
 *     checked EXHAUSTIVELY over all 7×7 status pairs rather than a sample
 *   - terminal states are genuinely terminal
 *   - the window, capacity, fee and tournament-format rules
 *
 * Pure logic, so like scripts/test-loyalty-tiers.ts it needs no database. The
 * database half — RLS, grants, the CHECK constraints and cross-tenant isolation
 * — is scripts/verify-events-rls.ts.
 *
 *   npx tsx scripts/test-events.ts
 */
import { EVENT_TRANSITIONS, canTransition, isTerminal, validateEventFields } from '../lib/events/lifecycle'
import {
  EVENT_STATUSES,
  EVENT_TYPES,
  PUBLIC_EVENT_STATUSES,
  acceptsRegistrations,
  isPubliclyVisible,
  requiresTournamentFormat,
  spotsRemaining,
  type EventStatus,
} from '../lib/events/types'

let pass = 0,
  fail = 0
const check = (l: string, c: boolean) => {
  console.log(`${c ? '✓' : '✗ FAIL'}  ${l}`)
  if (c) pass++
  else fail++
}

const D = (s: string) => new Date(s)
const BASE = {
  type: 'class' as const,
  startsAt: D('2026-10-01T10:00:00Z'),
  endsAt: D('2026-10-01T12:00:00Z'),
  capacity: 20,
  entryFee: 500,
  tournamentFormat: null,
}

// ══ 1. the transition table ══════════════════════════════════════════════════
console.log('\n── lifecycle shape ──')

check('every status has an entry in the table', EVENT_STATUSES.every((s) => EVENT_TRANSITIONS[s] !== undefined))
check(
  'no transition points at an unknown status',
  EVENT_STATUSES.every((s) => EVENT_TRANSITIONS[s].every((t) => EVENT_STATUSES.includes(t))),
)
check('no status lists itself as a legal move', EVENT_STATUSES.every((s) => !EVENT_TRANSITIONS[s].includes(s)))
check('completed is terminal', isTerminal('completed') && EVENT_TRANSITIONS.completed.length === 0)
check('cancelled is terminal', isTerminal('cancelled') && EVENT_TRANSITIONS.cancelled.length === 0)
check(
  'every non-terminal status can be cancelled',
  EVENT_STATUSES.filter((s) => !isTerminal(s)).every((s) => canTransition(s, 'cancelled')),
)
check(
  'every status except draft is reachable from somewhere',
  EVENT_STATUSES.filter((s) => s !== 'draft').every((target) =>
    EVENT_STATUSES.some((from) => canTransition(from, target)),
  ),
)

// ══ 2. EXHAUSTIVE 7×7 — the point of this file ═══════════════════════════════
console.log('\n── every status pair ──')

// The full set of moves that are allowed, written out independently of the
// implementation so this is a real assertion and not a restatement of it.
const EXPECTED_LEGAL = new Set<string>([
  'draft>published',
  'draft>cancelled',
  'published>draft',
  'published>registration_open',
  'published>cancelled',
  'registration_open>full',
  'registration_open>in_progress',
  'registration_open>cancelled',
  'full>registration_open',
  'full>in_progress',
  'full>cancelled',
  'in_progress>completed',
  'in_progress>cancelled',
])

let pairsOk = 0
const wrong: string[] = []
for (const from of EVENT_STATUSES) {
  for (const to of EVENT_STATUSES) {
    const expected = EXPECTED_LEGAL.has(`${from}>${to}`)
    if (canTransition(from, to) === expected) pairsOk++
    else wrong.push(`${from}→${to} expected ${expected ? 'legal' : 'illegal'}`)
  }
}
check(`all ${EVENT_STATUSES.length ** 2} status pairs behave as specified`, wrong.length === 0)
if (wrong.length) wrong.forEach((w) => console.log(`      ${w}`))
check(`…of which ${EXPECTED_LEGAL.size} are legal moves`, pairsOk === EVENT_STATUSES.length ** 2)

// Specific regressions worth naming, so a failure reads clearly.
check('a completed event cannot go back to draft', !canTransition('completed', 'draft'))
check('a completed event cannot be cancelled', !canTransition('completed', 'cancelled'))
check('a cancelled event cannot be revived', EVENT_STATUSES.every((s) => !canTransition('cancelled', s)))
check('draft cannot jump straight to registration_open', !canTransition('draft', 'registration_open'))
check('draft cannot jump straight to in_progress', !canTransition('draft', 'in_progress'))
check('registration_open cannot skip to completed', !canTransition('registration_open', 'completed'))
check('full ⇄ registration_open is two-way', canTransition('full', 'registration_open') && canTransition('registration_open', 'full'))
check('published can be retracted to draft', canTransition('published', 'draft'))
check('registration_open can NOT be retracted to published', !canTransition('registration_open', 'published'))

// ══ 3. field validation ══════════════════════════════════════════════════════
console.log('\n── field rules ──')

check('a well-formed event validates', validateEventFields(BASE) === null)

check('ends_at must be after starts_at', validateEventFields({ ...BASE, endsAt: D('2026-10-01T09:00:00Z') }) !== null)
check('a zero-length event is rejected', validateEventFields({ ...BASE, endsAt: BASE.startsAt }) !== null)
check(
  'one second of duration is enough',
  validateEventFields({ ...BASE, endsAt: new Date(BASE.startsAt.getTime() + 1000) }) === null,
)
check('an unparseable start date is rejected', validateEventFields({ ...BASE, startsAt: D('nonsense') }) !== null)
check('an unparseable end date is rejected', validateEventFields({ ...BASE, endsAt: D('nonsense') }) !== null)

check('capacity null means unlimited and is allowed', validateEventFields({ ...BASE, capacity: null }) === null)
check('capacity 1 is allowed', validateEventFields({ ...BASE, capacity: 1 }) === null)
check('capacity 0 is rejected', validateEventFields({ ...BASE, capacity: 0 }) !== null)
check('negative capacity is rejected', validateEventFields({ ...BASE, capacity: -5 }) !== null)
check('fractional capacity is rejected', validateEventFields({ ...BASE, capacity: 2.5 }) !== null)

check('a free event (fee 0) is allowed', validateEventFields({ ...BASE, entryFee: 0 }) === null)
check('a negative entry fee is rejected', validateEventFields({ ...BASE, entryFee: -1 }) !== null)
check('NaN entry fee is rejected', validateEventFields({ ...BASE, entryFee: Number.NaN }) !== null)
check('Infinity entry fee is rejected', validateEventFields({ ...BASE, entryFee: Number.POSITIVE_INFINITY }) !== null)

console.log('\n── tournament format ──')
check(
  'a tournament without a format is rejected',
  validateEventFields({ ...BASE, type: 'tournament', tournamentFormat: null }) !== null,
)
check(
  'a tournament with a format is accepted',
  validateEventFields({ ...BASE, type: 'tournament', tournamentFormat: 'double_elim' }) === null,
)
check(
  'a non-tournament carrying a format is rejected',
  validateEventFields({ ...BASE, type: 'party', tournamentFormat: 'single_elim' }) !== null,
)
check(
  'every non-tournament type rejects a format',
  EVENT_TYPES.filter((t) => t !== 'tournament').every(
    (t) => validateEventFields({ ...BASE, type: t, tournamentFormat: 'points' }) !== null,
  ),
)
check(
  'every non-tournament type is fine without one',
  EVENT_TYPES.filter((t) => t !== 'tournament').every(
    (t) => validateEventFields({ ...BASE, type: t, tournamentFormat: null }) === null,
  ),
)
check('requiresTournamentFormat is true only for tournaments', EVENT_TYPES.every((t) => requiresTournamentFormat(t) === (t === 'tournament')))

// ══ 4. the reusable predicates the later stories depend on ═══════════════════
console.log('\n── public/registration surface ──')
check('only registration_open accepts entrants', EVENT_STATUSES.every((s) => acceptsRegistrations(s) === (s === 'registration_open')))
// M15 #2: exactly two statuses are public. Asserted against the full status
// list so adding a status later cannot silently make it visible.
const EXPECTED_PUBLIC: EventStatus[] = ['published', 'registration_open']
check(
  'exactly published + registration_open are public',
  EVENT_STATUSES.every((s) => isPubliclyVisible(s) === EXPECTED_PUBLIC.includes(s)),
)
for (const s of ['draft', 'full', 'in_progress', 'completed', 'cancelled'] as EventStatus[]) {
  check(`${s} is NEVER public`, !isPubliclyVisible(s))
}
check(
  'the constant and the predicate agree',
  EVENT_STATUSES.every((s) => isPubliclyVisible(s) === (PUBLIC_EVENT_STATUSES as readonly EventStatus[]).includes(s)),
)

console.log('\n── spots remaining (M15 #3 dependency) ──')
check('uncapped event reports null, not a number', spotsRemaining(null, 0) === null)
check('capacity 20, nobody registered -> 20', spotsRemaining(20, 0) === 20)
check('capacity 20, 5 registered -> 15', spotsRemaining(20, 5) === 15)
check('capacity 20, 20 registered -> 0', spotsRemaining(20, 20) === 0)
check('never negative when overbooked', spotsRemaining(20, 25) === 0)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
