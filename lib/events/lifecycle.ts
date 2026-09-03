/**
 * Event lifecycle and field rules — PURE.
 *
 * Deliberately free of `server-only`, drizzle and db/schema imports so the
 * management UI, the future public listing and the registration flow can all
 * apply the same rules without pulling a database driver into a client bundle.
 * The transactional half (updateEventStatusCore) lives in ./service.
 *
 * ── Why the transition table is not a CHECK constraint ──────────────────────
 *
 * A CHECK sees only the row being written, never the row it replaces, so it
 * cannot express "a completed event may not return to draft". That rule needs
 * both values, so it is enforced where both are in hand — after a `for update`
 * read in ./service, exactly as updateKotStatusCore does for kitchen tickets.
 *
 * The database still enforces everything a single row CAN express: the window,
 * the capacity floor, the fee floor and the tournament/format equivalence are
 * all CHECK constraints in migration 0078. validateEventFields() states the
 * same rules early so a manager gets a sentence instead of a constraint
 * violation; it is not the only line of defence.
 */
import {
  requiresTournamentFormat,
  type EventStatus,
  type EventType,
  type TournamentFormat,
} from './types'
import type { EventRegistrationMode } from './registration'

/** Lifecycle and validation violations the caller may show verbatim. */
export class EventError extends Error {}

/**
 * Legal moves through the lifecycle.
 *
 *   draft → published → registration_open ⇄ full → in_progress → completed
 *
 * Notes on the shapes that are not a straight line:
 *
 *   * `registration_open ⇄ full` is deliberately two-way. Capacity is reached
 *     and released as entrants join and withdraw, so `full` is a state the
 *     event moves in and out of, not a milestone it passes.
 *   * `published → draft` is allowed: an event announced by mistake must be
 *     retractable before anyone has registered. Once registration has opened
 *     there are entrants to consider, so the way back closes.
 *   * `cancelled` is reachable from every active state and from none of the
 *     terminal ones — a completed event already happened and cannot be called
 *     off retroactively.
 *   * `completed` and `cancelled` are terminal. Nothing leaves them.
 *
 * `in_progress → registration_open` is intentionally absent: late entries are a
 * registration concern (a later M15 story may allow them while in progress),
 * not a reason to reopen a running event's lifecycle.
 */
export const EVENT_TRANSITIONS: Record<EventStatus, EventStatus[]> = {
  draft: ['published', 'cancelled'],
  published: ['draft', 'registration_open', 'cancelled'],
  registration_open: ['full', 'in_progress', 'cancelled'],
  full: ['registration_open', 'in_progress', 'cancelled'],
  in_progress: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
}

export function canTransition(from: EventStatus, to: EventStatus): boolean {
  return EVENT_TRANSITIONS[from].includes(to)
}

/** Terminal states — nothing may leave them. Used to disable UI as well. */
export function isTerminal(status: EventStatus): boolean {
  return EVENT_TRANSITIONS[status].length === 0
}

/**
 * The field rules, stated once so the form, the action, the tests and any
 * future caller agree. Returns an error message, or null when the shape is
 * valid. Mirrors the CHECK constraints in 0078 one-for-one.
 */
export function validateEventFields(v: {
  type: EventType
  startsAt: Date
  endsAt: Date
  capacity: number | null
  entryFee: number
  tournamentFormat: TournamentFormat | null
  /** M15 #3. Optional so existing callers that predate teams still type-check. */
  registrationMode?: EventRegistrationMode
  teamSize?: number | null
}): string | null {
  if (Number.isNaN(v.startsAt.getTime())) return 'Start time is not a valid date.'
  if (Number.isNaN(v.endsAt.getTime())) return 'End time is not a valid date.'
  if (v.endsAt <= v.startsAt) return 'End time must be after start time.'

  if (v.capacity !== null) {
    if (!Number.isInteger(v.capacity)) return 'Capacity must be a whole number.'
    if (v.capacity < 1) return 'Capacity must be at least 1, or left blank for unlimited.'
  }

  if (!Number.isFinite(v.entryFee)) return 'Entry fee is not a valid amount.'
  if (v.entryFee < 0) return 'Entry fee cannot be negative.'

  if (requiresTournamentFormat(v.type) && v.tournamentFormat === null) {
    return 'A tournament needs a bracket format.'
  }
  if (!requiresTournamentFormat(v.type) && v.tournamentFormat !== null) {
    return 'Only tournaments have a bracket format.'
  }

  // The team rules, mirroring the events_team_size CHECK in migration 0081 one
  // for one. Stated here too so a manager gets a sentence rather than a
  // constraint violation — the same division of labour the fee and window rules
  // above already use.
  //
  // The bounds are not arbitrary: a "team" of one is a solo entry wearing a
  // different word, and the upper bound stops a typo turning a five-a-side into
  // a five-hundred-a-side.
  const mode = v.registrationMode ?? 'solo'
  const teamSize = v.teamSize ?? null
  if (mode === 'team') {
    if (teamSize === null) return 'A team event needs a team size.'
    if (!Number.isInteger(teamSize)) return 'Team size must be a whole number.'
    if (teamSize < MIN_TEAM_SIZE || teamSize > MAX_TEAM_SIZE) {
      return `Team size must be between ${MIN_TEAM_SIZE} and ${MAX_TEAM_SIZE}.`
    }
  } else if (teamSize !== null) {
    return 'Only team events have a team size.'
  }

  return null
}

/** Mirrors the events_team_size CHECK bounds in migration 0081. */
export const MIN_TEAM_SIZE = 2
export const MAX_TEAM_SIZE = 50
