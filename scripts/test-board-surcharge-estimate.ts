/**
 * M29 #4 — the staff wizard's client-side estimate for a board-with-surcharge
 * type can't disagree with the server-computed quote. Pins the new `extraRate`
 * field on lib/actions/availability.ts's getAvailableStarts /
 * getAvailableStartsForType against quoteBooking's real total for the same
 * selection, using FutureWizard.tsx's own priceFor() formula:
 *
 *     ((rate + max(0, players − included) × extraRate) × minutes) / 60
 *
 * to the paise, across weekday / weekend / holiday-on-a-weekday /
 * holiday-on-a-weekend, several player counts and durations, for both the
 * pinned-unit and type-level read paths.
 *
 * Also pins that a plain board and a per_head type (even with the surcharge
 * columns accidentally set) get NO extraRate, and that the per_head quote is
 * not double-priced.
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs \
 *           --import ./scripts/next-runtime-hook.mjs \
 *           scripts/test-board-surcharge-estimate.ts
 */
import { createHash, randomBytes } from 'node:crypto'
import { Pool } from 'pg'
import { loadEnv } from './env'

loadEnv()

let pass = 0
let fail = 0
const check = (label: string, cond: boolean, got?: unknown) => {
  console.log(`${cond ? '✓' : '✗ FAIL'}  ${label}${cond ? '' : `  (got: ${JSON.stringify(got)})`}`)
  if (cond) pass++
  else fail++
}
const round2 = (n: number) => Math.round(n * 100) / 100

async function main() {
  const { getAvailableStarts, getAvailableStartsForType } = await import('../lib/actions/availability')
  const { quoteBooking } = await import('../lib/actions/bookings')

  const owner = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })
  const tag = randomBytes(3).toString('hex')
  const slug = `boardest${tag}`
  const t = await owner.query<{ id: string }>(
    `insert into tenants (slug,name,status,timezone,industry) values ($1,'Board Estimate Co','active','Asia/Kolkata','gaming_cafe') returning id`,
    [slug],
  )
  const tenantId = t.rows[0].id
  const br = await owner.query<{ id: string }>(
    `insert into branches (tenant_id,name,is_primary) values ($1,'Main',true) returning id`,
    [tenantId],
  )
  const branchId = br.rows[0].id
  const u = await owner.query<{ id: string }>(
    `insert into users (email, password_hash, full_name) values ($1,'x','Owner') returning id`,
    [`owner-${tag}@example.test`],
  )
  const userId = u.rows[0].id
  const token = randomBytes(32).toString('hex')
  await owner.query(`insert into sessions (id, user_id, expires_at) values ($1,$2, now() + interval '1 day')`, [
    createHash('sha256').update(token).digest('hex'),
    userId,
  ])
  await owner.query(
    `insert into memberships (tenant_id,user_id,branch_id,role,status,full_name) values ($1,$2,$3,'owner','active','Owner')`,
    [tenantId, userId, branchId],
  )
  const g = globalThis as { __ARENA_TEST_SESSION?: string; __ARENA_TEST_HEADERS?: Record<string, string> }
  g.__ARENA_TEST_SESSION = token
  g.__ARENA_TEST_HEADERS = { 'x-tenant-slug': slug }

  // Board: weekday ₹300, weekend ₹400, 2 included, extra ₹50 weekday / ₹80 weekend.
  const boardType = (
    await owner.query<{ id: string }>(
      `insert into resource_types (tenant_id,name,hourly_rate,weekend_rate,included_players,extra_player_rate,extra_player_weekend_rate)
       values ($1,'Board','300.00','400.00',2,'50.00','80.00') returning id`,
      [tenantId],
    )
  ).rows[0].id
  const board = (
    await owner.query<{ id: string }>(
      `insert into resources (tenant_id,branch_id,resource_type_id,name,status) values ($1,$2,$3,'Board-1','available') returning id`,
      [tenantId, branchId, boardType],
    )
  ).rows[0].id
  const plainType = (
    await owner.query<{ id: string }>(
      `insert into resource_types (tenant_id,name,hourly_rate) values ($1,'Plain','100.00') returning id`,
      [tenantId],
    )
  ).rows[0].id
  const plain = (
    await owner.query<{ id: string }>(
      `insert into resources (tenant_id,branch_id,resource_type_id,name,status) values ($1,$2,$3,'Plain-1','available') returning id`,
      [tenantId, branchId, plainType],
    )
  ).rows[0].id
  // per_head with the surcharge columns accidentally set.
  const headType = (
    await owner.query<{ id: string }>(
      `insert into resource_types (tenant_id,name,hourly_rate,pricing_mode,min_players,included_players,extra_player_rate)
       values ($1,'Head','50.00','per_head',2,1,'20.00') returning id`,
      [tenantId],
    )
  ).rows[0].id
  const head = (
    await owner.query<{ id: string }>(
      `insert into resources (tenant_id,branch_id,resource_type_id,name,status) values ($1,$2,$3,'Head-1','available') returning id`,
      [tenantId, branchId, headType],
    )
  ).rows[0].id

  // 2046-03-16 Fri, -17 Sat, -20 Tue, -24 Sat (holiday), -28 Wed (holiday).
  const DAYS = [
    { label: 'weekday (Fri)', date: '2046-03-16' },
    { label: 'weekend (Sat)', date: '2046-03-17' },
    { label: 'holiday on a weekday (Wed)', date: '2046-03-28' },
    { label: 'holiday on a weekend (Sat)', date: '2046-03-24' },
  ]
  await owner.query(
    `insert into holiday_rates (tenant_id,resource_type_id,date,rate) values ($1,$2,'2046-03-28','500.00'), ($1,$2,'2046-03-24','550.00')`,
    [tenantId, boardType],
  )
  const at = (d: string, hhmm: string) => new Date(`${d}T${hhmm}:00+05:30`)
  const INCLUDED = 2

  for (const day of DAYS) {
    console.log(`\n── ${day.label} ──`)
    for (const minutes of [60, 90]) {
      const pinned = await getAvailableStarts({ branchId, resourceId: board, date: day.date, durationMinutes: minutes })
      const typed = await getAvailableStartsForType({ branchId, resourceTypeId: boardType, date: day.date, durationMinutes: minutes })
      const startsAt = at(day.date, '10:00')
      const endsAt = new Date(startsAt.getTime() + minutes * 60_000)
      for (const players of [1, 3, 5]) {
        const quote = await quoteBooking({
          branchId,
          resourceId: board,
          startsAt: startsAt.toISOString(),
          endsAt: endsAt.toISOString(),
          headCount: players,
        })
        for (const [path, avail] of [['pinned', pinned], ['type-level', typed]] as const) {
          const est = round2(
            ((Number(avail.rate) + Math.max(0, players - INCLUDED) * Number(avail.extraRate)) * minutes) / 60,
          )
          check(
            `${path} ${minutes}m × ${players} players: estimate ${est.toFixed(2)} = server ${quote.total?.toFixed(2)}`,
            avail.extraRate !== undefined && quote.total === est,
            { rate: avail.rate, extraRate: avail.extraRate, est, server: quote.total, err: quote.error },
          )
        }
      }
    }
  }

  console.log('\n── the day-resolved extra rate itself ──')
  {
    const wd = await getAvailableStarts({ branchId, resourceId: board, date: '2046-03-16', durationMinutes: 60 })
    const we = await getAvailableStarts({ branchId, resourceId: board, date: '2046-03-17', durationMinutes: 60 })
    const hol = await getAvailableStarts({ branchId, resourceId: board, date: '2046-03-24', durationMinutes: 60 })
    check('weekday extraRate = 50.00', wd.extraRate === '50.00', wd.extraRate)
    check('weekend extraRate = 80.00', we.extraRate === '80.00', we.extraRate)
    check('holiday base replaces rate (550.00) but the extra rate stays day-resolved (weekend 80.00)', hol.rate === '550.00' && hol.extraRate === '80.00', hol)
  }

  console.log('\n── no surcharge: plain board and per_head get no extraRate ──')
  {
    const p1 = await getAvailableStarts({ branchId, resourceId: plain, date: '2046-03-16', durationMinutes: 60 })
    const p2 = await getAvailableStartsForType({ branchId, resourceTypeId: plainType, date: '2046-03-16', durationMinutes: 60 })
    check('plain board: extraRate undefined (both paths)', p1.extraRate === undefined && p2.extraRate === undefined, [p1.extraRate, p2.extraRate])
    const h1 = await getAvailableStarts({ branchId, resourceId: head, date: '2046-03-16', durationMinutes: 60 })
    const h2 = await getAvailableStartsForType({ branchId, resourceTypeId: headType, date: '2046-03-16', durationMinutes: 60 })
    check('per_head (columns accidentally set): extraRate undefined (both paths)', h1.extraRate === undefined && h2.extraRate === undefined, [h1.extraRate, h2.extraRate])
    const quote = await quoteBooking({
      branchId,
      resourceId: head,
      startsAt: at('2046-03-16', '10:00').toISOString(),
      endsAt: at('2046-03-16', '11:00').toISOString(),
      headCount: 4,
    })
    check('per_head quote = 4 × ₹50 = 200.00, not double-priced', quote.total === 200, quote)
    const plainQuote = await quoteBooking({
      branchId,
      resourceId: plain,
      startsAt: at('2046-03-16', '10:00').toISOString(),
      endsAt: at('2046-03-16', '11:00').toISOString(),
    })
    check('plain board quote needs no headCount: 100.00', plainQuote.total === 100, plainQuote)
  }

  await owner.query('delete from tenants where id = $1', [tenantId])
  await owner.query('delete from users where id = $1', [userId])
  await owner.end()

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
