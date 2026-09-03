/**
 * The event vocabulary, mirrored from the SQL enums in migration 0076.
 *
 * Deliberately dependency-free (no `server-only`, no db import) so the public
 * event listing, the registration flow and the tournament bracket views can all
 * import these types and labels without dragging a database connection into a
 * client bundle. Keep the unions in sync with the migration, the same way
 * lib/auth/roles.ts mirrors public.member_role.
 */

import type { EventRegistrationMode } from './registration'

export type EventType = 'tournament' | 'class' | 'meetup' | 'watch_party' | 'party'

export type TournamentFormat = 'single_elim' | 'double_elim' | 'round_robin' | 'points'

export type EventStatus =
  | 'draft'
  | 'published'
  | 'registration_open'
  | 'full'
  | 'in_progress'
  | 'completed'
  | 'cancelled'

export const EVENT_TYPES: EventType[] = ['tournament', 'class', 'meetup', 'watch_party', 'party']

export const EVENT_TYPE_LABELS: Record<EventType, string> = {
  tournament: 'Tournament',
  class: 'Class',
  meetup: 'Meetup',
  watch_party: 'Watch Party',
  party: 'Party',
}

export const TOURNAMENT_FORMATS: TournamentFormat[] = [
  'single_elim',
  'double_elim',
  'round_robin',
  'points',
]

export const TOURNAMENT_FORMAT_LABELS: Record<TournamentFormat, string> = {
  single_elim: 'Single Elimination',
  double_elim: 'Double Elimination',
  round_robin: 'Round Robin',
  points: 'Points',
}

export const EVENT_STATUSES: EventStatus[] = [
  'draft',
  'published',
  'registration_open',
  'full',
  'in_progress',
  'completed',
  'cancelled',
]

export const EVENT_STATUS_LABELS: Record<EventStatus, string> = {
  draft: 'Draft',
  published: 'Published',
  registration_open: 'Registration Open',
  full: 'Full',
  in_progress: 'In Progress',
  completed: 'Completed',
  cancelled: 'Cancelled',
}

/**
 * THE public visibility rule (M15 #2). Exactly two statuses are visible to a
 * stranger; the listing, the detail page, the homepage promotion and the
 * metadata generator all derive from this one constant so they cannot drift.
 *
 * It is mirrored by the events_public_select policy in migration 0077, which is
 * the real enforcement — this constant keeps the queries honest and readable,
 * the policy makes a forgotten filter harmless.
 *
 * `full` is deliberately NOT public: an event is hidden when it is full because
 * a manager MOVED it to `full`, a lifecycle act — not because a headcount hit a
 * number. Capacity and visibility are separate concerns.
 */
export const PUBLIC_EVENT_STATUSES = ['published', 'registration_open'] as const satisfies readonly EventStatus[]

export function isPubliclyVisible(status: EventStatus): boolean {
  return (PUBLIC_EVENT_STATUSES as readonly EventStatus[]).includes(status)
}

/** Whether an event accepts new entrants right now. Registration's gate. */
export function acceptsRegistrations(status: EventStatus): boolean {
  return status === 'registration_open'
}

/**
 * Places left, or null when the event is uncapped.
 *
 * `registeredCount` stays a parameter rather than something this function
 * fetches, so one piece of arithmetic serves every counter: the public listing
 * counts through public_event_taken_counts() (migration 0079), the manager
 * screen through getEventEntrantCounts(), and a test can simply pass a number.
 *
 * What counts as taken is defined once — OCCUPYING_STATUSES in
 * ./registration, mirrored by event_registration_occupancy() in SQL: confirmed
 * entries, checked-in entries, and LIVE payment holds. A waitlisted entry never
 * counts, which is what makes a waitlist a waitlist.
 *
 * For a TEAM event the unit is a team, not a player (see 0079's capacity note),
 * which is why callers pair this with placesNoun().
 */
export function spotsRemaining(capacity: number | null, registeredCount: number): number | null {
  if (capacity === null) return null
  return Math.max(0, capacity - registeredCount)
}

/** Only tournaments carry a bracket format — mirrors the events_tournament_format CHECK. */
export function requiresTournamentFormat(type: EventType): boolean {
  return type === 'tournament'
}

/**
 * One event as every reader returns it.
 *
 * `entryFee` is a STRING because the column is numeric(10,2) and this codebase
 * never lets money touch a float — same contract as bookings.total and
 * happy_hours.discountValue. Format it with lib/format.ts formatMoney().
 */
/** What an event reserves for its window (M15 #4, migration 0082). */
export const EVENT_RESOURCE_SCOPES = ['none', 'branch', 'specific'] as const
export type EventResourceScope = (typeof EVENT_RESOURCE_SCOPES)[number]

export type EventRow = {
  id: string
  tenantId: string
  branchId: string
  title: string
  type: EventType
  description: string | null
  bannerUrl: string | null
  startsAt: Date
  endsAt: Date
  capacity: number | null
  entryFee: string
  tournamentFormat: TournamentFormat | null
  /** Solo vs team entry (M15 #3). Decides what one place, and one fee, means. */
  registrationMode: EventRegistrationMode
  /** Players per team; null exactly when the mode is solo. */
  teamSize: number | null
  status: EventStatus
  /** What the event reserves (M15 #4). See lib/events/resource-blocks.ts. */
  resourceScope: EventResourceScope
  createdAt: Date
  updatedAt: Date
}

/** An event plus the branch name, for lists that show where it runs. */
export type EventWithBranch = EventRow & { branchName: string | null }

/**
 * What one place IS, for this event — the word the UI puts next to a number.
 *
 * Capacity counts registrations (migration 0079), and a registration is one
 * person for a solo event and one TEAM for a team one. "3 places left" on a
 * five-a-side tournament would be read as three players when it means three
 * teams, so the noun is derived rather than written out at each call site.
 */
export function placesNoun(mode: EventRegistrationMode, count: number): string {
  if (mode === 'team') return count === 1 ? 'team place' : 'team places'
  return count === 1 ? 'place' : 'places'
}
