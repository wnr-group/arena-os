/**
 * Pure table-reservation rules (M20 / AROS-176) — no database.
 *
 *   npx tsx scripts/test-reservation-rules.ts
 */
import {
  RESERVATION_DEFAULTS,
  isNoShowDue,
  noShowDeadline,
  reservationBlocksWalkin,
  reservationDisplayState,
  reservationEnd,
  validateReservationSettings,
} from '../lib/reservations/rules'

let pass = 0,
  fail = 0
const check = (l: string, c: boolean) => {
  console.log(`${c ? '✓' : '✗ FAIL'}  ${l}`)
  if (c) pass++
  else fail++
}

const at = (iso: string) => new Date(iso)
const T = at('2026-10-23T14:30:00Z') // 20:00 IST

// ── no-show deadline ────────────────────────────────────────────────────────
check('deadline is start + grace', noShowDeadline(T, 15).getTime() === T.getTime() + 15 * 60_000)
check('not due before the deadline', !isNoShowDue(T, 15, at('2026-10-23T14:44:59Z')))
check('not due exactly at the deadline', !isNoShowDue(T, 15, at('2026-10-23T14:45:00Z')))
check('due one second after the deadline', isNoShowDue(T, 15, at('2026-10-23T14:45:01Z')))

// ── walk-in guard ───────────────────────────────────────────────────────────
const res = { startsAt: T, endsAt: reservationEnd(T, 90) }
check('walk-in blocked 30 min before a reservation (45 min buffer)', reservationBlocksWalkin(res, at('2026-10-23T14:00:00Z'), 45, 15))
check('walk-in allowed 60 min before (outside buffer)', !reservationBlocksWalkin(res, at('2026-10-23T13:30:00Z'), 45, 15))
check('walk-in blocked while the reservation is underway but inside grace', reservationBlocksWalkin(res, at('2026-10-23T14:40:00Z'), 45, 15))
check('walk-in allowed once the reservation lapsed (past grace)', !reservationBlocksWalkin(res, at('2026-10-23T14:50:00Z'), 45, 15))
check('walk-in allowed after the reservation window is over', !reservationBlocksWalkin(res, at('2026-10-23T16:30:00Z'), 45, 15))
check('buffer 0 only blocks once the reservation has started', !reservationBlocksWalkin(res, at('2026-10-23T14:29:00Z'), 0, 15) && reservationBlocksWalkin(res, at('2026-10-23T14:31:00Z'), 0, 15))

// ── display state ───────────────────────────────────────────────────────────
const st = (status: string, resourceId: string | null, now: string) =>
  reservationDisplayState({ status, resourceId, reservedFor: T }, 15, at(now))
check('upcoming well before', st('confirmed', null, '2026-10-23T10:00:00Z') === 'upcoming')
check('due within 15 min before', st('confirmed', null, '2026-10-23T14:20:00Z') === 'due')
check('late after start, inside grace', st('confirmed', null, '2026-10-23T14:40:00Z') === 'late')
check('lapsed past grace reads as no_show even before the sweep runs', st('confirmed', null, '2026-10-23T15:00:00Z') === 'no_show')
check('seated once it has a table', st('checked_in', 'tbl', '2026-10-23T14:40:00Z') === 'seated')
check('cancelled stays cancelled', st('cancelled', null, '2026-10-23T10:00:00Z') === 'cancelled')
check('stored no_show stays no_show', st('no_show', null, '2026-10-23T10:00:00Z') === 'no_show')
check('completed after the meal', st('completed', 'tbl', '2026-10-23T18:00:00Z') === 'completed')

// ── settings validation ─────────────────────────────────────────────────────
const ok = { ...RESERVATION_DEFAULTS, enabled: true }
check('defaults (enabled) are valid', validateReservationSettings(ok) === null)
check('defaults are OFF', RESERVATION_DEFAULTS.enabled === false && RESERVATION_DEFAULTS.publicEnabled === false)
check('rejects a 10 minute length', validateReservationSettings({ ...ok, defaultDurationMinutes: 10 }) !== null)
check('rejects a 9 hour length', validateReservationSettings({ ...ok, defaultDurationMinutes: 540 }) !== null)
check('rejects a non-integer grace', validateReservationSettings({ ...ok, noShowGraceMinutes: 7.5 }) !== null)
check('rejects grace under 5', validateReservationSettings({ ...ok, noShowGraceMinutes: 2 }) !== null)
check('allows a 0 minute walk-in buffer', validateReservationSettings({ ...ok, walkinBufferMinutes: 0 }) === null)
check('rejects max party 0', validateReservationSettings({ ...ok, maxPartySize: 0 }) !== null)
check('rejects public booking while reservations are off', validateReservationSettings({ ...ok, enabled: false, publicEnabled: true }) !== null)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
