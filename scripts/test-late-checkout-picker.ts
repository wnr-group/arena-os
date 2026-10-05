/**
 * M32 #2 — the checkout dialog's "This was a while ago" picker helpers
 * (lib/booking/walkin-end-time.ts): datetime-local value ⇄ branch wall time,
 * and the client-side bounds that mirror the server's. Pure (no DB).
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs scripts/test-late-checkout-picker.ts
 */
import { LATE_CHECKOUT_MAX_DAYS, resolveLateCheckoutEnd, toDatetimeLocal } from '../lib/booking/walkin-end-time'

let pass = 0,
  fail = 0
const check = (l: string, c: boolean) => {
  console.log(`${c ? '✓' : '✗ FAIL'}  ${l}`)
  if (c) pass++
  else fail++
}

async function main() {
  const { WALKIN_LATE_CHECKOUT_MAX_DAYS } = await import('../lib/booking/walkin')
  check('the client bound equals the server bound (7 days)', LATE_CHECKOUT_MAX_DAYS === WALKIN_LATE_CHECKOUT_MAX_DAYS && LATE_CHECKOUT_MAX_DAYS === 7)

  const TZ = 'Asia/Kolkata' // UTC+5:30
  const now = new Date('2030-06-10T10:30:00.000Z') // 16:00 IST
  const startsAt = '2030-06-05T04:30:00.000Z' // 5 Jun 10:00 IST

  check('toDatetimeLocal renders the BRANCH wall time, not UTC', toDatetimeLocal(now, TZ) === '2030-06-10T16:00')
  check('…and rolls the date correctly across midnight', toDatetimeLocal(new Date('2030-06-10T19:00:00.000Z'), TZ) === '2030-06-11T00:30')
  check('…midnight itself is 00:00, never 24:00', toDatetimeLocal(new Date('2030-06-10T18:30:00.000Z'), TZ) === '2030-06-11T00:00')

  const ok = resolveLateCheckoutEnd('2030-06-08T14:30', TZ, now, startsAt)
  check('a time two days back resolves to the right instant (14:30 IST = 09:00Z)', 'iso' in ok && ok.iso === '2030-06-08T09:00:00.000Z')
  check('the pre-filled "now" value is accepted (round-trips)', 'iso' in resolveLateCheckoutEnd(toDatetimeLocal(now, TZ), TZ, now, startsAt))

  const future = resolveLateCheckoutEnd('2030-06-10T16:30', TZ, now, startsAt)
  check('a future time is refused with a clear message', 'error' in future && future.error.toLowerCase().includes('future'))
  const tooOld = resolveLateCheckoutEnd('2030-06-03T15:59', TZ, now, '2030-06-01T00:00:00.000Z')
  check('a time more than 7 days back is refused', 'error' in tooOld && tooOld.error.includes('last 7 days'))
  check('…while exactly 7 days back is still allowed', 'iso' in resolveLateCheckoutEnd('2030-06-03T16:00', TZ, now, '2030-06-01T00:00:00.000Z'))
  const beforeStart = resolveLateCheckoutEnd('2030-06-05T09:00', TZ, now, startsAt)
  check('a time before the session started is refused', 'error' in beforeStart && beforeStart.error.includes('after the session started'))
  check('an empty value is refused', 'error' in resolveLateCheckoutEnd('', TZ, now, startsAt))
  const invalidMsg = 'Enter a valid date and time.'
  const msg = (v: string) => {
    const r = resolveLateCheckoutEnd(v, TZ, now, '2020-01-01T00:00:00.000Z')
    return 'error' in r ? r.error : null
  }
  check('an impossible calendar date (30 Feb) gets the "valid date" message, not rolled into March', msg('2030-02-30T10:00') === invalidMsg)
  check('…and 31 Apr / 31 Jun / 29 Feb in a non-leap year are refused the same way', msg('2030-04-31T10:00') === invalidMsg && msg('2030-06-31T10:00') === invalidMsg && msg('2029-02-29T10:00') === invalidMsg)
  check('…while a real leap day still gets past that check (and fails only on range)', msg('2028-02-29T10:00') !== invalidMsg)
  check('a malformed value is refused','error' in resolveLateCheckoutEnd('2030-06-08 14:30', TZ, now, startsAt) && 'error' in resolveLateCheckoutEnd('2030-13-45T99:99', TZ, now, startsAt))

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}
main().catch((e) => {
  console.error(e)
  process.exit(1)
})
