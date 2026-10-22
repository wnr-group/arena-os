/**
 * Pure walk-in waitlist rules (M20 / AROS-177) — no DB, no `server-only`, so the
 * service, the screens and the unit tests share one definition.
 */

export type WaitlistStatus = 'waiting' | 'notified' | 'seated' | 'left'

export const ACTIVE_WAITLIST_STATUSES: WaitlistStatus[] = ['waiting', 'notified']

/** Used until there are enough finished table sessions to average. */
export const DEFAULT_TURN_MINUTES = 60
/** Fewer samples than this and the average isn't trusted. */
export const MIN_TURN_SAMPLES = 5
/** A table session outside this range is a data glitch or an all-day sitter, not turnover. */
export const TURN_SAMPLE_BOUNDS = { min: 10, max: 300 } as const

const MIN = 60_000

/** Mean table-session length (minutes) from finished sessions; default when too few. */
export function averageTurnMinutes(durationsMinutes: number[]): number {
  const usable = durationsMinutes.filter((d) => d >= TURN_SAMPLE_BOUNDS.min && d <= TURN_SAMPLE_BOUNDS.max)
  if (usable.length < MIN_TURN_SAMPLES) return DEFAULT_TURN_MINUTES
  return Math.round(usable.reduce((a, b) => a + b, 0) / usable.length)
}

const roundUp5 = (n: number) => Math.max(5, Math.ceil(n / 5) * 5)

/**
 * Quote for a party joining the back of the queue.
 *
 * `occupiedElapsedMinutes` = how long each currently-seated table has been
 * seated. A table frees in (average − elapsed) minutes, floored at 5 for one
 * that is already overrunning. The k-th party in line (k = queueAhead −
 * freeTables) waits for the k-th table to free; past the tables currently
 * occupied it waits for a second round of turnovers. 0 when a table is free
 * for them right now. An estimate, always rounded up to 5 minutes.
 */
export function estimateWaitMinutes(input: {
  avgTurnMinutes: number
  occupiedElapsedMinutes: number[]
  freeTables: number
  queueAhead: number
}): number {
  const { avgTurnMinutes: avg, occupiedElapsedMinutes, freeTables, queueAhead } = input
  if (freeTables > queueAhead) return 0
  const remaining = occupiedElapsedMinutes.map((e) => Math.max(5, avg - e)).sort((a, b) => a - b)
  if (remaining.length === 0) return roundUp5(avg)
  const k = queueAhead - freeTables
  if (k < remaining.length) return roundUp5(remaining[k])
  const tableCount = remaining.length + freeTables
  const extraRounds = Math.ceil((k - remaining.length + 1) / Math.max(1, tableCount))
  return roundUp5(remaining[remaining.length - 1] + extraRounds * avg)
}

export function waitedMinutes(createdAt: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - createdAt.getTime()) / MIN))
}

/** What the floor map shows: how many are waiting and how long the longest has. */
export function waitlistSummary(entries: { createdAt: Date }[], now: Date): { count: number; longestMinutes: number } {
  let longest = 0
  for (const e of entries) longest = Math.max(longest, waitedMinutes(e.createdAt, now))
  return { count: entries.length, longestMinutes: longest }
}

/** Past the quote? Used to flag a party that has waited longer than they were told. */
export function isOverQuote(quotedMinutes: number | null, createdAt: Date, now: Date): boolean {
  return quotedMinutes !== null && waitedMinutes(createdAt, now) > quotedMinutes
}

export function buildReadyMessage(guestName: string, venueName: string): string {
  const first = guestName.trim().split(/\s+/)[0] || 'there'
  return `Hi ${first}, your table at ${venueName} is ready! Please check in with the host within 10 minutes.`
}

/** wa.me click-to-chat link for an E.164 number; null when there is no usable number. */
export function whatsappUrl(phoneE164: string | null | undefined, message: string): string | null {
  const digits = (phoneE164 ?? '').replace(/\D/g, '')
  if (digits.length < 8) return null
  return `https://wa.me/${digits}?text=${encodeURIComponent(message)}`
}

export const WAITLIST_MAX_PARTY = 100

export function validateWaitlistInput(i: { name: string; partySize: number; quotedWaitMinutes?: number | null }): string | null {
  if (!i.name.trim()) return 'Enter the guest’s name.'
  if (!Number.isInteger(i.partySize) || i.partySize < 1) return 'Party size must be at least 1.'
  if (i.partySize > WAITLIST_MAX_PARTY) return `Party size can’t exceed ${WAITLIST_MAX_PARTY}.`
  const q = i.quotedWaitMinutes
  if (q !== undefined && q !== null && (!Number.isInteger(q) || q < 0 || q > 600)) {
    return 'Quoted wait must be between 0 and 600 minutes.'
  }
  return null
}
