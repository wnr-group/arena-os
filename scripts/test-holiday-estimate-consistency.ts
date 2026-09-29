/**
 * M27 #4 (AROS-247) — the client-side quick-estimate can't disagree with the
 * server-computed quote once a holiday date is picked. This does NOT touch
 * what actually gets charged (that's #2, already pinned in
 * scripts/test-holiday-pricing.ts) — it pins the two NEW `rate` fields on
 * lib/actions/availability.ts's getAvailableStarts/getAvailableStartsForType
 * (the staff wizard's own read path, FutureWizard.tsx) against
 * quoteBooking's real total for the identical selection, the same "estimate
 * must reconcile to the paise with the real quote" bar #2 already set for
 * the server engine itself.
 *
 * The two PUBLIC availability functions (getPublicAvailableStarts/
 * getPublicAvailableStartsForType) already got their own `rate` field fixed
 * in #2 — components/public-booking/ResourceBookingPage.tsx and
 * ResourceTypeBookingPage.tsx were ALREADY built (M22 #4) to follow
 * whatever `rate` that call resolves rather than compute their own, so the
 * public side needed zero code changes for this ticket; already covered by
 * scripts/test-holiday-pricing.ts's own public-quote-function checks.
 *
 * Covers:
 *   - getAvailableStarts (pinned resource): `rate` reflects a configured
 *     holiday date, and reconciles exactly with quoteBooking's total for
 *     the identical [startsAt, endsAt) window
 *   - getAvailableStartsForType (type-level, auto-assigned unit): same,
 *     plus the client-side priceFor() FORMULA itself (rate × minutes / 60,
 *     × headCount for per-head — literally FutureWizard.tsx's own math)
 *     reconstructs quoteBooking's total exactly
 *   - precedence: a holiday date that's ALSO a weekend day with an active
 *     weekend_rate still quotes the HOLIDAY rate in `rate`
 *   - a date with no holiday_rates row is byte-identical: `rate` matches
 *     the plain weekday/weekend resolution, same as before this ticket
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs \
 *           --import ./scripts/next-runtime-hook.mjs \
 *           scripts/test-holiday-estimate-consistency.ts
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

async function main() {
  const { getAvailableStarts, getAvailableStartsForType } = await import('../lib/actions/availability')
  const { quoteBooking } = await import('../lib/actions/bookings')

  const owner = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })
  const tag = randomBytes(3).toString('hex')

  const slug = `holidayest${tag}`
  const t = await owner.query<{ id: string }>(
    `insert into tenants (slug,name,status,timezone,industry) values ($1,'Holiday Estimate Co','active','Asia/Kolkata','gaming_cafe') returning id`,
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
  await owner.query(`insert into memberships (tenant_id,user_id,branch_id,role,status,full_name) values ($1,$2,$3,'owner','active','Owner')`, [
    tenantId,
    userId,
    branchId,
  ])

  const g = globalThis as { __ARENA_TEST_SESSION?: string; __ARENA_TEST_HEADERS?: Record<string, string> }
  g.__ARENA_TEST_SESSION = token
  g.__ARENA_TEST_HEADERS = { 'x-tenant-slug': slug }

  // PS5: weekday ₹100/hr, weekend ₹150/hr.
  const ps5Type = await owner.query<{ id: string }>(
    `insert into resource_types (tenant_id,name,hourly_rate,weekend_rate) values ($1,'PS5','100.00','150.00') returning id`,
    [tenantId],
  )
  const ps5A = await owner.query<{ id: string }>(
    `insert into resources (tenant_id,branch_id,resource_type_id,name,status) values ($1,$2,$3,'PS5-A','available') returning id`,
    [tenantId, branchId, ps5Type.rows[0].id],
  )

  // Snooker: per_head, min 2 — weekday ₹50/player/hr, weekend ₹80/player/hr.
  const snookerType = await owner.query<{ id: string }>(
    `insert into resource_types (tenant_id,name,hourly_rate,weekend_rate,pricing_mode,min_players)
     values ($1,'Snooker','50.00','80.00','per_head',2) returning id`,
    [tenantId],
  )
  // Not referenced by id below — only its existence matters, so
  // getAvailableStartsForType (snooker's type-level auto-assign test) has a
  // unit to assign.
  await owner.query(
    `insert into resources (tenant_id,branch_id,resource_type_id,name,status) values ($1,$2,$3,'Snooker-A','available')`,
    [tenantId, branchId, snookerType.rows[0].id],
  )

  // Fixed calendar, same reference points test-weekend-pricing.ts/
  // test-happy-hours-reserved-bookings.ts already use: 2046-03-16 Fri
  // (not a default weekend day), -17 Sat (a default weekend day), -20 Tue.
  const HOL_WEEKDAY = '2046-03-20' // Tuesday
  const HOL_WEEKEND = '2046-03-17' // Saturday
  const NO_HOL_DATE = '2046-03-16' // Friday, no holiday_rates row anywhere

  await owner.query(
    `insert into holiday_rates (tenant_id,resource_type_id,date,rate) values
       ($1,$2,$3,'999.00'), ($1,$2,$4,'777.00'), ($1,$5,$3,'60.00')`,
    [tenantId, ps5Type.rows[0].id, HOL_WEEKDAY, HOL_WEEKEND, snookerType.rows[0].id],
  )

  const at = (dateStr: string, hhmm: string) => new Date(`${dateStr}T${hhmm}:00+05:30`)

  // ══ 1. getAvailableStarts (pinned resource): holiday rate, reconciled ═══
  console.log('\n── getAvailableStarts: pinned resource, holiday date ──')
  {
    const avail = await getAvailableStarts({ branchId, resourceId: ps5A.rows[0].id, date: HOL_WEEKDAY, durationMinutes: 120 })
    check('rate = 999.00 (the holiday rate, not weekday 100)', avail.rate === '999.00', avail)

    const startsAt = at(HOL_WEEKDAY, '10:00')
    const endsAt = at(HOL_WEEKDAY, '12:00')
    const quote = await quoteBooking({ branchId, resourceId: ps5A.rows[0].id, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() })
    check('quoteBooking succeeds', !quote.error, quote)
    check('quoteBooking total = 1998.00 (2h × ₹999)', quote.total === 1998)

    const priceForEstimate = (Number(avail.rate) * 120) / 60
    check(
      "priceFor()'s own formula (rate × minutes / 60) reconstructs the server quote EXACTLY",
      priceForEstimate === quote.total,
      { priceForEstimate, serverTotal: quote.total },
    )
  }

  // ══ 2. control: no holiday row — byte-identical to before this ticket ═══
  console.log('\n── getAvailableStarts: no holiday configured (control) ──')
  {
    const avail = await getAvailableStarts({ branchId, resourceId: ps5A.rows[0].id, date: NO_HOL_DATE, durationMinutes: 60 })
    check('rate = 100.00 (plain weekday rate — Friday is not a default weekend day)', avail.rate === '100.00', avail)

    const startsAt = at(NO_HOL_DATE, '10:00')
    const endsAt = at(NO_HOL_DATE, '11:00')
    const quote = await quoteBooking({ branchId, resourceId: ps5A.rows[0].id, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() })
    check('the estimate and the real quote agree: 100.00', Number(avail.rate) === quote.total, { avail, quote })
  }

  // ══ 3. precedence: holiday beats weekend_rate on the same date ══════════
  console.log('\n── getAvailableStartsForType: holiday beats weekend_rate ──')
  {
    const avail = await getAvailableStartsForType({ branchId, resourceTypeId: ps5Type.rows[0].id, date: HOL_WEEKEND, durationMinutes: 90 })
    check('rate = 777.00 (the holiday rate, not weekend_rate 150 or weekday 100)', avail.rate === '777.00', avail)
    check('a unit was auto-assigned', (avail.starts?.length ?? 0) > 0, avail)

    const assigned = avail.starts![0]
    const startsAt = new Date(assigned.startsAt)
    const endsAt = new Date(startsAt.getTime() + 90 * 60_000)
    const quote = await quoteBooking({ branchId, resourceId: assigned.resourceId, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() })
    check('quoteBooking total = 1165.50 (1.5h × ₹777)', quote.total === 1165.5)

    const priceForEstimate = (Number(avail.rate) * 90) / 60
    check('the type-level estimate reconciles exactly with the real quote', priceForEstimate === quote.total, {
      priceForEstimate,
      serverTotal: quote.total,
    })
  }

  // ══ 4. per-head: the estimate's × headCount step reconciles too ═════════
  console.log('\n── per-head holiday rate ──')
  {
    const avail = await getAvailableStartsForType({ branchId, resourceTypeId: snookerType.rows[0].id, date: HOL_WEEKDAY, durationMinutes: 60 })
    check('rate = 60.00 (the per-player holiday rate)', avail.rate === '60.00', avail)

    const assigned = avail.starts![0]
    const startsAt = new Date(assigned.startsAt)
    const endsAt = new Date(startsAt.getTime() + 60 * 60_000)
    const headCount = 3
    const quote = await quoteBooking({
      branchId,
      resourceId: assigned.resourceId,
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
      headCount,
    })
    check('quoteBooking total = 180.00 (₹60/player × 3 players × 1h)', quote.total === 180)

    // FutureWizard.tsx's own priceFor(): rate × headCount, then × minutes/60.
    const priceForEstimate = (Number(avail.rate) * headCount * 60) / 60
    check('the per-head estimate reconciles exactly with the real quote', priceForEstimate === quote.total, {
      priceForEstimate,
      serverTotal: quote.total,
    })
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
