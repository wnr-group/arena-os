/**
 * M30 #5 — the staff wizards' split-tender entry: what gets SENT and what the
 * running total SHOWS both come from cleanAdvanceTenders, so they must agree,
 * and careless empty/zero rows must never reach the server.
 *
 * Pure (no DB):  npx tsx scripts/test-advance-tender-form.ts
 */
import { cleanAdvanceTenders, sumAdvanceTenders, type AdvanceTenderRow } from '../components/bookings/new/advance-tenders'

let pass = 0,
  fail = 0
const check = (l: string, c: boolean) => {
  console.log(`${c ? '✓' : '✗ FAIL'}  ${l}`)
  if (c) pass++
  else fail++
}
const row = (key: number, method: AdvanceTenderRow['method'], amount: string): AdvanceTenderRow => ({ key, method, amount })

check('no rows → nothing sent, total 0', cleanAdvanceTenders([]).length === 0 && sumAdvanceTenders([]) === 0)

const one = cleanAdvanceTenders([row(1, 'upi', '250')])
check('one row → one tender with its own method', one.length === 1 && one[0].method === 'upi' && one[0].amount === 250)

const mixed = cleanAdvanceTenders([row(1, 'cash', '300'), row(2, 'upi', '200'), row(3, 'card', '50.5')])
check('several mixed rows are all sent, in order, each with its own method', mixed.map((t) => t.method).join() === 'cash,upi,card')
check('running total equals the sum of exactly what is sent', sumAdvanceTenders(mixed) === 550.5)

const messy = cleanAdvanceTenders([row(1, 'cash', ''), row(2, 'card', '0'), row(3, 'upi', '-5'), row(4, 'cash', '  '), row(5, 'card', 'abc'), row(6, 'upi', '120')])
check('empty, zero, negative, blank and garbage rows are filtered out client-side', messy.length === 1 && messy[0].method === 'upi' && messy[0].amount === 120)
check('…and the total only counts the surviving row', sumAdvanceTenders(messy) === 120)

check('amounts are rounded to paise', cleanAdvanceTenders([row(1, 'cash', '10.006')])[0].amount === 10.01)
check('float drift does not leak into the total (0.1 + 0.2)', sumAdvanceTenders(cleanAdvanceTenders([row(1, 'cash', '0.1'), row(2, 'upi', '0.2')])) === 0.3)
check('a sub-paisa amount that rounds to zero is dropped', cleanAdvanceTenders([row(1, 'cash', '0.004')]).length === 0)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
