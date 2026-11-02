/**
 * Pure table-reservation rules (M20 / AROS-176) — no DB, no `server-only`, so
 * the service, the actions and the unit tests share one definition.
 */

export type ReservationSettings = {
  enabled: boolean
  defaultDurationMinutes: number
  noShowGraceMinutes: number
  walkinBufferMinutes: number
  publicEnabled: boolean
  maxPartySize: number
  /** M20 (0151): the walk-in waitlist. Independent of `enabled`. */
  waitlistEnabled: boolean
}

/** What a tenant with no reservation_settings row gets — reservations off. */
export const RESERVATION_DEFAULTS: ReservationSettings = {
  enabled: false,
  defaultDurationMinutes: 90,
  noShowGraceMinutes: 15,
  walkinBufferMinutes: 45,
  publicEnabled: false,
  maxPartySize: 12,
  waitlistEnabled: false,
}

/** Same bounds as the 0150 CHECK constraints — validated here so a bad value
 *  is a friendly message, not a constraint violation. */
export const RESERVATION_LIMITS = {
  defaultDurationMinutes: { min: 15, max: 480 },
  noShowGraceMinutes: { min: 5, max: 240 },
  walkinBufferMinutes: { min: 0, max: 480 },
  maxPartySize: { min: 1, max: 100 },
} as const

/** Staff may take a larger party than the public cap, but not an absurd one. */
export const STAFF_MAX_PARTY_SIZE = 100

/** Step (minutes) of the start times offered on the booking forms. */
export const RESERVATION_SLOT_MINUTES = 30

const MIN = 60_000

export function reservationEnd(start: Date, minutes: number): Date {
  return new Date(start.getTime() + minutes * MIN)
}

/** The instant after which an unseated reservation counts as a no-show. */
export function noShowDeadline(reservedFor: Date, graceMinutes: number): Date {
  return new Date(reservedFor.getTime() + graceMinutes * MIN)
}

export function isNoShowDue(reservedFor: Date, graceMinutes: number, now: Date): boolean {
  return now.getTime() > noShowDeadline(reservedFor, graceMinutes).getTime()
}

/**
 * Does a reservation make a walk-in unseatable at its table right now?
 * True while the reservation (still within its no-show grace) starts inside
 * the walk-in buffer, or is already underway. `endsAt` bounds it so a
 * reservation that is entirely over never blocks.
 */
export function reservationBlocksWalkin(
  r: { startsAt: Date; endsAt: Date },
  now: Date,
  bufferMinutes: number,
  graceMinutes: number,
): boolean {
  if (r.endsAt.getTime() <= now.getTime()) return false
  if (isNoShowDue(r.startsAt, graceMinutes, now)) return false
  return r.startsAt.getTime() < now.getTime() + bufferMinutes * MIN
}

/** An open session that has overrun its expected length still holds its table
 *  for at least this much longer — the same "can't plausibly be vacated" window
 *  freeTablesForWindow always used. */
export const OVERRUN_HOLD_MINUTES = 30

/** A table with a party seated (an open table session): when it was seated and
 *  how long it was expected to last (reserved_minutes; walk-ins have none). */
export type OpenSession = { checkedInAt: Date; reservedMinutes: number | null }

/**
 * When an open session is expected to free its table: seated time + the
 * reservation length (or the venue default for a walk-in), but never earlier
 * than OVERRUN_HOLD_MINUTES from now — a party still seated past their time has
 * not left yet.
 */
export function openSessionOccupiedUntil(s: OpenSession, now: Date, defaultMinutes: number): Date {
  const expected = s.checkedInAt.getTime() + (s.reservedMinutes ?? defaultMinutes) * MIN
  return new Date(Math.max(expected, now.getTime() + OVERRUN_HOLD_MINUTES * MIN))
}

/**
 * Seated parties have no booking_slots row (a table session has no time window),
 * so the slot exclusion constraint can't see them. This is the rule that does:
 * does the open session still hold the table during [start, end)?
 */
export function openSessionBlocksWindow(s: OpenSession, start: Date, end: Date, now: Date, defaultMinutes: number): boolean {
  return start.getTime() < openSessionOccupiedUntil(s, now, defaultMinutes).getTime() && end.getTime() > s.checkedInAt.getTime()
}

export type ReservationStatusLabel = 'upcoming' | 'due' | 'late' | 'seated' | 'no_show' | 'cancelled' | 'completed'

/**
 * Display state of a reservation. `due` = within 15 min before start (or at
 * start); `late` = past start, still inside the no-show grace.
 */
export function reservationDisplayState(
  r: { status: string; resourceId: string | null; reservedFor: Date },
  graceMinutes: number,
  now: Date,
): ReservationStatusLabel {
  if (r.status === 'cancelled') return 'cancelled'
  if (r.status === 'no_show') return 'no_show'
  if (r.status === 'completed') return 'completed'
  if (r.resourceId) return 'seated'
  if (isNoShowDue(r.reservedFor, graceMinutes, now)) return 'no_show'
  const diff = r.reservedFor.getTime() - now.getTime()
  if (diff < 0) return 'late'
  if (diff <= 15 * MIN) return 'due'
  return 'upcoming'
}

export type SettingsPatch = Partial<Omit<ReservationSettings, never>>

/** Validate a settings object; returns the first problem or null. */
export function validateReservationSettings(s: ReservationSettings): string | null {
  const L = RESERVATION_LIMITS
  const int = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n)
  if (!int(s.defaultDurationMinutes) || s.defaultDurationMinutes < L.defaultDurationMinutes.min || s.defaultDurationMinutes > L.defaultDurationMinutes.max) {
    return `Reservation length must be between ${L.defaultDurationMinutes.min} and ${L.defaultDurationMinutes.max} minutes.`
  }
  if (!int(s.noShowGraceMinutes) || s.noShowGraceMinutes < L.noShowGraceMinutes.min || s.noShowGraceMinutes > L.noShowGraceMinutes.max) {
    return `No-show grace must be between ${L.noShowGraceMinutes.min} and ${L.noShowGraceMinutes.max} minutes.`
  }
  if (!int(s.walkinBufferMinutes) || s.walkinBufferMinutes < L.walkinBufferMinutes.min || s.walkinBufferMinutes > L.walkinBufferMinutes.max) {
    return `Walk-in buffer must be between ${L.walkinBufferMinutes.min} and ${L.walkinBufferMinutes.max} minutes.`
  }
  if (!int(s.maxPartySize) || s.maxPartySize < L.maxPartySize.min || s.maxPartySize > L.maxPartySize.max) {
    return `Largest online party must be between ${L.maxPartySize.min} and ${L.maxPartySize.max}.`
  }
  if (s.publicEnabled && !s.enabled) return 'Turn reservations on before opening them to the public.'
  return null
}

/** Most future, unseated reservations one phone number may hold on the public
 *  site. The phone is unverified, so this bounds how many tables a single
 *  caller can sit on; staff are not subject to it. */
export const PUBLIC_MAX_OPEN_RESERVATIONS_PER_PHONE = 3

export type TableSeats = { minSeats: number | null; maxSeats: number | null }

/** Whether a party of `partySize` may be put on a table. A NULL bound is "no
 *  limit" on that side, so a table with no seats set takes any party. */
export function tableFitsParty(t: TableSeats, partySize: number): boolean {
  if (t.minSeats !== null && partySize < t.minSeats) return false
  if (t.maxSeats !== null && partySize > t.maxSeats) return false
  return true
}

/** Whether `start` lies on the venue's start-time grid — every
 *  RESERVATION_SLOT_MINUTES from opening, the same grid the picker offers. */
export function isOnSlotGrid(start: Date, open: Date): boolean {
  const step = RESERVATION_SLOT_MINUTES * 60_000
  return (start.getTime() - open.getTime()) % step === 0
}
