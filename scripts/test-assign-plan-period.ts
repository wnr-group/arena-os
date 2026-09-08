/**
 * assignPlan()'s period-end arithmetic: literal months, and no month-end
 * overflow.
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs \
 *           --import ./scripts/next-runtime-hook.mjs \
 *           scripts/test-assign-plan-period.ts
 *
 * ── The two things this pins ────────────────────────────────────────────────
 *
 * 1. `months` is LITERAL. It used to be multiplied by twelve for an annual
 *    plan, so a field documented "months of runway" meant YEARS whenever
 *    `billingPeriod` was annual — 12 read as 144 months, 36 as 36 years. What
 *    masked it is that no caller ever passed the field: every one relied on the
 *    default, where 1 × 12 was the right answer for the wrong reason. So the
 *    default behaviour (below) and the explicit behaviour are BOTH asserted —
 *    testing only one of them is how this survived.
 *
 * 2. `addMonths()`, not `setMonth()`. Assigning a one-month plan on 31 August
 *    asks for 31 September, which JavaScript resolves forward to 1 October: a
 *    day of free access, in the wrong calendar month. `current_period_end` is
 *    what readEntitlements() checks its clock against, so the day is real.
 *
 * The arithmetic half is driven directly against the helper because the date
 * assignPlan() starts from is `new Date()` — unfixable from outside — so a test
 * that went only through the action could never reach 31 August. The action is
 * still driven for real, to pin the unit and the defaults.
 */
import { randomBytes, createHash } from 'crypto'
import { Pool } from 'pg'
import { loadEnv } from './env'
import { addMonths } from '../lib/utils/date'

loadEnv()

let pass = 0
let fail = 0
const check = (label: string, cond: boolean) => {
  console.log(`${cond ? '✓' : '✗ FAIL'}  ${label}`)
  if (cond) pass++
  else fail++
}
const section = (s: string) => console.log(`\n── ${s} ──`)

const iso = (d: Date) => d.toISOString().slice(0, 10)
/** Whole months between two instants, rounded — enough to tell 12 from 144. */
const monthsBetween = (a: Date, b: Date) =>
  (b.getUTCFullYear() - a.getUTCFullYear()) * 12 +
  (b.getUTCMonth() - a.getUTCMonth()) +
  (b.getUTCDate() < a.getUTCDate() ? -1 : 0)

async function main() {
  const { assignPlan } = await import('../lib/actions/plans')

  // ══ 1. the clamp, directly ════════════════════════════════════════════════
  section('addMonths() clamps instead of overflowing')

  const aug31 = new Date('2026-08-31T10:00:00.000Z')
  check('31 Aug + 1 month = 30 Sep, not 1 Oct', iso(addMonths(aug31, 1)) === '2026-09-30')
  check('31 Aug + 2 months = 31 Oct (no clamp needed)', iso(addMonths(aug31, 2)) === '2026-10-31')

  const jan31 = new Date('2026-01-31T10:00:00.000Z')
  check('31 Jan + 1 month = 28 Feb in a common year', iso(addMonths(jan31, 1)) === '2026-02-28')
  check(
    '31 Jan + 1 month = 29 Feb in a leap year',
    iso(addMonths(new Date('2028-01-31T10:00:00.000Z'), 1)) === '2028-02-29',
  )
  check('31 Jan + 12 months = 31 Jan next year', iso(addMonths(jan31, 12)) === '2027-01-31')
  check('31 May + 1 month = 30 Jun', iso(addMonths(new Date('2026-05-31T00:00:00.000Z'), 1)) === '2026-06-30')

  // The time of day is part of the instant and must survive the arithmetic —
  // the period end is a timestamptz, not a date.
  check('the time of day is preserved', addMonths(aug31, 1).toISOString().endsWith('T10:00:00.000Z'))

  // Every 31st into the following month: the exhaustive form of the case above.
  // Seven months have 31 days (Jan Mar May Jul Aug Oct Dec) and five of those
  // landings need a clamp — Jul→Aug and Dec→Jan are the two that do not,
  // because August and January also have 31 days.
  let clamped = 0
  let overflowed = 0
  for (let m = 0; m < 12; m++) {
    const start = new Date(Date.UTC(2026, m, 31))
    if (start.getUTCDate() !== 31) continue // not a 31-day month
    const got = addMonths(start, 1)
    if (got.getUTCMonth() !== (m + 1) % 12) overflowed++
    else if (got.getUTCDate() < 31) clamped++
  }
  check('every 31st + 1 month lands in the NEXT month, never the one after', overflowed === 0)
  check('…and five of those seven landings clamped', clamped === 5)

  // ══ 2. the unit, through the real action ══════════════════════════════════
  const owner = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })
  const tag = randomBytes(3).toString('hex')

  const u = await owner.query<{ id: string }>(
    `insert into users (email, password_hash, full_name, is_platform_admin)
     values ($1,'x','period admin',true) returning id`,
    [`period-${tag}@example.test`],
  )
  const adminId = u.rows[0].id
  const token = randomBytes(32).toString('hex')
  await owner.query(
    `insert into sessions (id, user_id, expires_at) values ($1,$2, now() + interval '1 day')`,
    [createHash('sha256').update(token).digest('hex'), adminId],
  )
  ;(globalThis as { __ARENA_TEST_SESSION?: string }).__ARENA_TEST_SESSION = token

  const t = await owner.query<{ id: string }>(
    `insert into tenants (slug, name, status) values ($1,'period co','active') returning id`,
    [`per${tag}`],
  )
  const tenantId = t.rows[0].id
  const p = await owner.query<{ id: string }>(
    `insert into plans (name, monthly_price, annual_price, active)
     values ($1, 100, 1000, true) returning id`,
    [`Period Test ${tag}`],
  )
  const planId = p.rows[0].id

  /** Assign, then read back how long the live row actually runs for. */
  async function runwayMonths(args: Record<string, unknown>): Promise<number> {
    await owner.query(
      `update tenant_subscriptions set status='cancelled', cancelled_at=now()
        where tenant_id=$1 and status in ('trialing','active','past_due')`,
      [tenantId],
    )
    const r = await assignPlan({ tenantId, planId, ...args } as Parameters<typeof assignPlan>[0])
    if (r.error) throw new Error(`assignPlan refused: ${r.error}`)
    const row = await owner.query<{ s: Date; e: Date }>(
      `select current_period_start s, current_period_end e from tenant_subscriptions
        where tenant_id=$1 and status in ('trialing','active','past_due')`,
      [tenantId],
    )
    return monthsBetween(row.rows[0].s, row.rows[0].e)
  }

  section('the DEFAULT is one billing cycle')
  // Unchanged behaviour, and the reason the old multiplier looked correct.
  // Every caller in the app omits the field, so this is the path that matters
  // most and the one a fix must not disturb.
  check('monthly, omitted → 1 month', (await runwayMonths({ billingPeriod: 'monthly' })) === 1)
  check('annual, omitted → 12 months', (await runwayMonths({ billingPeriod: 'annual' })) === 12)

  section('an EXPLICIT months is taken literally, on both periods')
  check('monthly, months: 1 → 1 month', (await runwayMonths({ billingPeriod: 'monthly', months: 1 })) === 1)
  check('monthly, months: 12 → 12 months', (await runwayMonths({ billingPeriod: 'monthly', months: 12 })) === 12)
  // The regression. This used to be 12 × 12 = 144 months.
  check(
    'annual, months: 12 → 12 months, NOT 144',
    (await runwayMonths({ billingPeriod: 'annual', months: 12 })) === 12,
  )
  check(
    'annual, months: 1 → 1 month, NOT 12',
    (await runwayMonths({ billingPeriod: 'annual', months: 1 })) === 1,
  )
  // The old worst case: 36 annual "months" was thirty-six YEARS.
  check(
    'annual, months: 36 → 36 months, NOT 36 years',
    (await runwayMonths({ billingPeriod: 'annual', months: 36 })) === 36,
  )
  check(
    'the same number means the same runway on either period',
    (await runwayMonths({ billingPeriod: 'annual', months: 6 })) ===
      (await runwayMonths({ billingPeriod: 'monthly', months: 6 })),
  )

  section('the documented bounds still hold')
  const tooBig = await assignPlan({ tenantId, planId, months: 37 } as Parameters<typeof assignPlan>[0])
  check('months: 37 is refused (max 36)', !!tooBig.error)
  const zero = await assignPlan({ tenantId, planId, months: 0 } as Parameters<typeof assignPlan>[0])
  check('months: 0 is refused (min 1)', !!zero.error)

  // ── cleanup ───────────────────────────────────────────────────────────────
  await owner.query(`delete from tenant_subscriptions where tenant_id = $1`, [tenantId])
  await owner.query(`delete from tenants where id = $1`, [tenantId])
  await owner.query(`delete from plans where id = $1`, [planId])
  await owner.query(`delete from sessions where user_id = $1`, [adminId])
  await owner.query(`delete from users where id = $1`, [adminId])

  console.log(`\n${pass} passed, ${fail} failed`)
  await owner.end()
  if (fail > 0) process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
