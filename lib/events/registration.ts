/**
 * The registration vocabulary and rules — PURE.
 *
 * Dependency-free (no `server-only`, no drizzle, no db import) for the same
 * reason ./lifecycle is: the public registration panel is a client component and
 * has to apply the same rules the server does, without dragging a database
 * driver into the browser bundle. The transactional half lives in
 * ./registrations, and the real enforcement lives in migration 0079.
 *
 * Keep the unions in sync with the SQL enums, the way ./types mirrors 0076.
 */

export type EventRegistrationMode = 'solo' | 'team'

export type EventRegistrationStatus =
  | 'pending_payment'
  | 'registered'
  | 'waitlisted'
  | 'cancelled'
  | 'checked_in'

export const EVENT_REGISTRATION_MODES: EventRegistrationMode[] = ['solo', 'team']

export const EVENT_REGISTRATION_MODE_LABELS: Record<EventRegistrationMode, string> = {
  solo: 'Solo entry',
  team: 'Team entry',
}

export const EVENT_REGISTRATION_STATUSES: EventRegistrationStatus[] = [
  'pending_payment',
  'registered',
  'waitlisted',
  'cancelled',
  'checked_in',
]

export const EVENT_REGISTRATION_STATUS_LABELS: Record<EventRegistrationStatus, string> = {
  pending_payment: 'Payment pending',
  registered: 'Registered',
  waitlisted: 'Waitlisted',
  cancelled: 'Cancelled',
  checked_in: 'Checked in',
}

/**
 * THE occupancy rule, stated once.
 *
 * A place is consumed by a confirmed entry, by someone already through the door,
 * and by a LIVE payment hold — the last of which is what stops two simultaneous
 * paid checkouts overselling the final place. A waitlisted entry consumes
 * nothing; that is what makes it a waitlist.
 *
 * Mirrored exactly by event_registration_occupancy() in migration 0079, which is
 * the enforcement. This copy exists so the UI can explain a number without
 * re-deriving the rule differently.
 */
export const OCCUPYING_STATUSES = [
  'registered',
  'checked_in',
  'pending_payment',
] as const satisfies readonly EventRegistrationStatus[]

/** The statuses that block a second entry by the same customer — idx_event_registrations_active. */
export const ACTIVE_STATUSES = [
  'pending_payment',
  'registered',
  'waitlisted',
  'checked_in',
] as const satisfies readonly EventRegistrationStatus[]

export function isActiveRegistration(status: EventRegistrationStatus): boolean {
  return (ACTIVE_STATUSES as readonly EventRegistrationStatus[]).includes(status)
}

/** True while the entrant still owes money for a place being held for them. */
export function awaitsPayment(status: EventRegistrationStatus): boolean {
  return status === 'pending_payment'
}

/**
 * How long a place is held while the entrant pays.
 *
 * Two windows, both set inside migration 0079 and repeated here only so the UI
 * can say how long someone has:
 *
 *   CHECKOUT   30 minutes — the customer is at the payment page right now.
 *   PROMOTION  24 hours   — they were promoted off the waitlist and have to be
 *                           told about it before they can act.
 *
 * An expired hold is swept back to `cancelled` under the event lock, which is
 * what stops an abandoned checkout from blocking a place forever.
 */
export const CHECKOUT_HOLD_MINUTES = 30
export const PROMOTION_HOLD_HOURS = 24

/**
 * Every refusal the database functions can answer with, mapped to a sentence.
 *
 * The functions return CODES rather than raising, the same shape
 * checkCancelEligibility() uses, so the wording lives here — one place — and
 * both the public panel and the manager screen say the same thing.
 *
 * `not_found` deliberately covers "no such event", "another tenant's event" and
 * "not your registration" identically: distinguishing them would confirm the
 * existence of rows to anyone walking UUIDs.
 */
export const REGISTRATION_REFUSALS: Record<string, string> = {
  not_signed_in: 'Please sign in to register for this event.',
  not_found: 'That event could not be found.',
  not_open: 'Registration is not open for this event.',
  ended: 'This event has already finished.',
  already_registered: 'You are already registered for this event.',
  already_in_team: 'You are already playing for a team in this event.',
  team_name_required: 'This is a team event — give your team a name.',
  team_name_taken: 'A team with that name is already entered. Please pick another.',
  not_a_team_event: 'This event is a solo entry.',
  team_full: 'That team is already full.',
  team_withdrawn: 'That team is no longer entered in this event.',
  already_cancelled: 'This registration has already been cancelled.',
  checked_in: 'You are already checked in — please speak to the venue.',
}

export function refusalMessage(code: string): string {
  return REGISTRATION_REFUSALS[code] ?? 'That did not work. Please refresh and try again.'
}

/** One team, as the join list shows it. Names and headcounts only — never ids of people. */
export type EventTeamOption = {
  teamId: string
  teamName: string
  memberCount: number
  teamSize: number
}

/**
 * Where the signed-in customer stands in one event — the shape
 * my_event_participation() returns.
 *
 * Money fields are null for anyone but the entrant who paid, and there is no
 * payment reference at all: a gateway id has no business in a page payload.
 */
export type EventParticipation = {
  registrationId: string
  status: EventRegistrationStatus
  isCaptain: boolean
  /** False for a team player whose captain holds the entry. */
  isOwnRegistration: boolean
  teamId: string | null
  teamName: string | null
  teamMemberCount: number
  /** 1-based place in the queue, or null when not waitlisted. */
  waitlistPosition: number | null
  paidAmount: string | null
  refundRequired: boolean | null
  holdExpiresAt: Date | null
}
