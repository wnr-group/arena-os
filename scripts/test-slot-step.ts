/**
 * Booking time step (0162): the duration list, the start-time grid and the
 * server-side grid check all follow the venue's step. Pure — no database.
 */
import { availableStartTimes } from '../lib/booking/availability'
import { buildDurations, isSlotStepPreset } from '../lib/booking/settings'
import { slotGridError } from '../lib/booking/slot-grid'

let failed = 0
function check(name: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) {
    failed++
    if (detail !== undefined) console.log('      ', detail)
  }
}

const TZ = 'Asia/Kolkata'
const hours = { openTime: '10:00', closeTime: '22:00', isClosed: false }
const date = '2030-01-15'
// 8:20 pm IST = 14:50 UTC
const at = (hhmm: string) => new Date(`${date}T${hhmm}:00+05:30`)

// ── durations ──
check('step 30 reproduces the legacy list', JSON.stringify(buildDurations(30)) === JSON.stringify([
  30, 60, 90, 120, 150, 180, 210, 240, ...Array.from({ length: 20 }, (_, i) => (i + 5) * 60),
]))
check('step 20 offers 40/60/80…', buildDurations(20).slice(0, 4).join() === '40,60,80,100', buildDurations(20))
check('step 60 offers whole hours only', buildDurations(60).slice(0, 3).join() === '60,120,180')
check('every duration is a multiple of the step', [5, 10, 15, 20, 30, 60].every((s) => buildDurations(s).every((m) => m % s === 0)))
check('presets validate', isSlotStepPreset(20) && !isSlotStepPreset(25) && !isSlotStepPreset('20'))

// ── start-time grid ──
const s20 = availableStartTimes(date, TZ, hours, [], { durationMinutes: 60, slotMinutes: 20 })
check('20-min grid offers 8:20 pm', s20.some((d) => d.getTime() === at('20:20').getTime()))
const s30 = availableStartTimes(date, TZ, hours, [], { durationMinutes: 60, slotMinutes: 30 })
check('30-min grid does not offer 8:20 pm', !s30.some((d) => d.getTime() === at('20:20').getTime()))

// ── server grid check ──
const slot = (a: string, b: string) => ({ startsAt: at(a), endsAt: at(b) })
check('20:20–21:20 passes on a 20-min step', slotGridError(slot('20:20', '21:20'), TZ, hours, 20) === null)
check('20:20 is refused on a 30-min step', slotGridError(slot('20:20', '21:20'), TZ, hours, 30) !== null)
check('10:07–10:43 is refused (hand-built request)', slotGridError(slot('10:07', '10:43'), TZ, hours, 5) !== null)
check('length off the step is refused', slotGridError(slot('20:00', '20:45'), TZ, hours, 30) !== null)
check('before opening is refused', slotGridError(slot('09:30', '10:30'), TZ, hours, 30) !== null)
check('past closing is refused', slotGridError(slot('21:30', '22:30'), TZ, hours, 30) !== null)
check('ending exactly at close passes', slotGridError(slot('21:00', '22:00'), TZ, hours, 30) === null)
check('closed day is refused', slotGridError(slot('12:00', '13:00'), TZ, { ...hours, isClosed: true }, 30) !== null)
check('open-24h day allows late-night slot', slotGridError(slot('23:00', '23:30'), TZ, { ...hours, open24h: true }, 30) === null)
check('grid anchors to opening time, not midnight', slotGridError(slot('10:15', '11:15'), TZ, { ...hours, openTime: '09:45' }, 30) === null)

console.log(failed ? `\n${failed} FAILED` : '\nAll passed')
process.exit(failed ? 1 : 0)
