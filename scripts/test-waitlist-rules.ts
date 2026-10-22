/**
 * Pure walk-in waitlist rules (M20 / AROS-177) — no database.
 *
 *   npx tsx scripts/test-waitlist-rules.ts
 */
import {
  DEFAULT_TURN_MINUTES,
  averageTurnMinutes,
  buildReadyMessage,
  estimateWaitMinutes,
  isOverQuote,
  validateWaitlistInput,
  waitedMinutes,
  waitlistSummary,
  whatsappUrl,
} from '../lib/waitlist/rules'

let pass = 0,
  fail = 0
const check = (l: string, c: boolean) => {
  console.log(`${c ? '✓' : '✗ FAIL'}  ${l}`)
  if (c) pass++
  else fail++
}
const at = (iso: string) => new Date(iso)
const NOW = at('2026-10-23T14:30:00Z')

// ── turnover ────────────────────────────────────────────────────────────────
check('too few samples -> default turnover', averageTurnMinutes([50, 60, 70]) === DEFAULT_TURN_MINUTES)
check('mean of enough samples', averageTurnMinutes([40, 50, 60, 70, 80]) === 60)
check('glitches (<10m, >300m) are ignored', averageTurnMinutes([1, 40, 50, 60, 70, 80, 900]) === 60)

// ── wait estimate ───────────────────────────────────────────────────────────
const est = (o: Partial<Parameters<typeof estimateWaitMinutes>[0]>) =>
  estimateWaitMinutes({ avgTurnMinutes: 60, occupiedElapsedMinutes: [], freeTables: 0, queueAhead: 0, ...o })
check('a free table and nobody ahead -> no wait', est({ freeTables: 1, queueAhead: 0 }) === 0)
check('free tables are used up by the queue ahead', est({ freeTables: 1, queueAhead: 1, occupiedElapsedMinutes: [30] }) === 30)
check('first in line waits for the soonest table to turn', est({ occupiedElapsedMinutes: [20, 50, 10] }) === 10)
check('second in line waits for the second-soonest', est({ occupiedElapsedMinutes: [20, 50, 10], queueAhead: 1 }) === 40)
check('an overrunning table counts as 5 minutes, not negative', est({ occupiedElapsedMinutes: [90] }) === 5)
check('past the occupied tables -> a second round of turnovers', est({ occupiedElapsedMinutes: [30, 30], queueAhead: 2 }) === 90)
check('estimates round up to 5 minutes', est({ occupiedElapsedMinutes: [43] }) === 20)
check('nothing seated and no free table (all held) falls back to one turnover', est({}) === 60)

// ── summary / quote ─────────────────────────────────────────────────────────
check('waited minutes', waitedMinutes(at('2026-10-23T14:00:00Z'), NOW) === 30)
check('never negative', waitedMinutes(at('2026-10-23T15:00:00Z'), NOW) === 0)
const sum = waitlistSummary([{ createdAt: at('2026-10-23T14:20:00Z') }, { createdAt: at('2026-10-23T13:50:00Z') }], NOW)
check('summary: count and longest wait', sum.count === 2 && sum.longestMinutes === 40)
check('summary of an empty queue', waitlistSummary([], NOW).count === 0 && waitlistSummary([], NOW).longestMinutes === 0)
check('over quote once waited past it', isOverQuote(20, at('2026-10-23T14:00:00Z'), NOW) && !isOverQuote(30, at('2026-10-23T14:00:00Z'), NOW))
check('no quote is never "over"', !isOverQuote(null, at('2026-10-23T10:00:00Z'), NOW))

// ── message + click-to-chat ─────────────────────────────────────────────────
const msg = buildReadyMessage('  Priya Sharma ', 'Spice Route')
check('message greets by first name and names the venue', msg.startsWith('Hi Priya,') && msg.includes('Spice Route'))
const url = whatsappUrl('+919876543210', msg)
check('wa.me link uses digits only and encodes the text', !!url && url.startsWith('https://wa.me/919876543210?text=') && !url.includes(' '))
check('no phone -> no link', whatsappUrl(null, msg) === null && whatsappUrl('', msg) === null)

// ── validation ──────────────────────────────────────────────────────────────
check('valid entry passes', validateWaitlistInput({ name: 'A', partySize: 2, quotedWaitMinutes: 15 }) === null)
check('blank name refused', validateWaitlistInput({ name: ' ', partySize: 2 }) !== null)
check('party of 0 refused', validateWaitlistInput({ name: 'A', partySize: 0 }) !== null)
check('negative quote refused', validateWaitlistInput({ name: 'A', partySize: 2, quotedWaitMinutes: -5 }) !== null)
check('null quote allowed', validateWaitlistInput({ name: 'A', partySize: 2, quotedWaitMinutes: null }) === null)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
