/**
 * M16 — the entitlement limit check under concurrency.
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs scripts/test-m16-limit-race.ts
 *
 * ── What this file found ────────────────────────────────────────────────────
 *
 * lib/platform/usage.ts used to document an accepted limitation: two
 * simultaneous requests could both pass a check only one should, but "the
 * overshoot is one item, which for a commercial plan limit is a billing
 * conversation rather than a security failure".
 *
 * An accepted risk is only accepted if its size is the size you think it is, so
 * this measured it. Eight requests were held at the check and released
 * together, against a plan capped at 3 staff with 2 already used. All eight
 * were admitted and the tenant finished with TEN. The overshoot was not a
 * constant — it was the concurrency, which means the cap could be exceeded by
 * as much as a caller cared to parallelise. That is not a billing conversation;
 * it is the limit not existing for anyone who sends requests in parallel.
 *
 * The fix is lockTenantUsage() — a transaction-scoped advisory lock taken
 * BEFORE the count — now called by lib/actions/team.ts and
 * lib/actions/resources.ts. With it, the same eight racers yield exactly one
 * seat and the tenant lands precisely on its cap.
 *
 * ── Why the barrier is the load-bearing part ────────────────────────────────
 *
 * Without it the race does not reproduce: the round trips happen to serialise
 * and all eight requests come back correct, which measures scheduling luck
 * rather than the guarantee. Any future version of this file that drops the
 * barrier will pass whether or not the lock is there, and prove nothing.
 */
import { randomBytes } from 'node:crypto'
import { Pool } from 'pg'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { sql } from 'drizzle-orm'
import * as schema from '../db/schema'
import { loadEnv } from './env'

loadEnv()

type Db = NodePgDatabase<typeof schema>

let pass = 0
let fail = 0
const check = (label: string, cond: boolean, got?: unknown) => {
  console.log(`${cond ? '✓' : '✗ FAIL'}  ${label}${cond ? '' : `  (got: ${JSON.stringify(got)})`}`)
  if (cond) pass++
  else fail++
}

const LIMIT = 3

async function main() {
  const { checkLimitIn } = await import('../lib/platform/entitlement-guard')
  const { countActiveStaff, lockTenantUsage } = await import('../lib/platform/usage')

  const owner = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })
  const appPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 20 })
  const app = drizzle(appPool, { schema })
  const tag = randomBytes(3).toString('hex')

  // ── a tenant on a plan capped at LIMIT staff ──────────────────────────────
  const t = await owner.query<{ id: string }>(
    `insert into tenants (slug,name,status,timezone)
     values ($1,'Race Co','active','Asia/Kolkata') returning id`,
    [`m16r${tag}`],
  )
  const tenantId = t.rows[0].id
  const br = await owner.query<{ id: string }>(
    `insert into branches (tenant_id,name,is_primary) values ($1,'Main',true) returning id`,
    [tenantId],
  )
  const branchId = br.rows[0].id

  const p = await owner.query<{ id: string }>(
    `insert into plans (name, monthly_price, annual_price, currency, active)
     values ($1,'1000','10000','INR',true) returning id`,
    [`Race ${tag}`],
  )
  const planId = p.rows[0].id
  await owner.query(
    `insert into plan_entitlements (plan_id, key, value) values ($1,'max_staff',$2::jsonb)`,
    [planId, String(LIMIT)],
  )
  await owner.query(
    `insert into tenant_subscriptions
       (tenant_id, plan_id, billing_period, status, current_period_start, current_period_end)
     values ($1,$2,'monthly','active', now() - interval '1 day', now() + interval '30 days')`,
    [tenantId, planId],
  )

  const userIds: string[] = []
  async function makeUser(n: number) {
    const u = await owner.query<{ id: string }>(
      `insert into users (email, password_hash, full_name) values ($1,'x',$2) returning id`,
      [`m16race-${n}-${tag}@example.test`, `race ${n}`],
    )
    userIds.push(u.rows[0].id)
    return u.rows[0].id
  }

  // The signed-in actor whose RLS context every attempt runs under: a real
  // OWNER of this tenant, so tenant_subscriptions_select admits the row. It
  // occupies a seat like any other member, which the counts below account for.
  const ACTOR = await makeUser(-1)
  await owner.query(
    `insert into memberships (tenant_id,user_id,branch_id,role,status,full_name)
     values ($1,$2,$3,'owner','active','actor')`,
    [tenantId, ACTOR, branchId],
  )

  /**
   * Exactly what lib/actions/team.ts does: count in the tx, check, insert.
   *
   * `app.user_id` is set to a real active member the same way withUser() does —
   * without it RLS hides tenant_subscriptions, readEntitlements() returns the
   * empty answer, and every attempt would be refused for want of a plan rather
   * than for want of a seat. (That it fails closed in that case is correct, and
   * is asserted by scripts/verify-entitlement-enforcement.ts.)
   */
  async function seatAttempt(userId: string, barrier?: () => Promise<void>): Promise<'created' | 'refused'> {
    try {
      await app.transaction(async (tx) => {
        const t2 = tx as unknown as Db
        await t2.execute(sql`select set_config('app.user_id', ${ACTOR}, true)`)
        // The same two lines, in the same order, that lib/actions/team.ts uses.
        // Drop the lock and this file fails: that is the point of it.
        await lockTenantUsage(t2, tenantId)
        await checkLimitIn(t2, tenantId, 'max_staff', await countActiveStaff(t2, tenantId), {
          one: 'staff member',
          many: 'staff members',
        })
        // Hold every racer here until all of them have passed the check, which
        // forces the exact interleaving the caveat describes. Without it the
        // round trips happen to serialise and the window never opens, which
        // measures scheduling luck rather than the guarantee.
        if (barrier) await barrier()
        // Inside the SAME transaction as the count — the whole point. Writing
        // it on another connection would commit immediately and serialise the
        // racers, measuring the harness instead of the code.
        await t2.execute(sql`
          insert into memberships (tenant_id, user_id, branch_id, role, status, full_name)
          values (${tenantId}, ${userId}, ${branchId}, 'cashier', 'active', 'racer')
        `)
      })
      return 'created'
    } catch {
      return 'refused'
    }
  }

  const activeStaff = async () => {
    const r = await owner.query<{ n: string }>(
      `select count(*) n from memberships where tenant_id=$1 and status='active'`,
      [tenantId],
    )
    return Number(r.rows[0].n)
  }

  // ══ 1. the serial path is exact ═══════════════════════════════════════════
  // The path every ordinary user takes. If this is ever off by one the limit is
  // simply wrong, concurrency or not.
  console.log('\n── serially, the cap is exact ──')

  // ACTOR already holds one of the seats, so LIMIT - 1 remain.
  check('the actor occupies the first seat', (await activeStaff()) === 1)
  for (let i = 0; i < LIMIT - 1; i++) {
    const r = await seatAttempt(await makeUser(i))
    check(`seat ${i + 2} of ${LIMIT} is allowed`, r === 'created', r)
  }
  const overOne = await seatAttempt(await makeUser(99))
  check(`the ${LIMIT + 1}th is refused`, overOne === 'refused', overOne)
  check(`…leaving exactly ${LIMIT} active staff`, (await activeStaff()) === LIMIT)

  // ══ 2. concurrently, measure the real overshoot ═══════════════════════════
  console.log('\n── concurrently, the documented window ──')

  // Reset to one seat short of the cap, so a correct system admits exactly one
  // more no matter how many requests arrive at once.
  // Everything except ACTOR, whose membership is what gives the app connection
  // its RLS context — removing it would make every attempt fail closed.
  await owner.query(`delete from memberships where tenant_id=$1 and user_id <> $2`, [tenantId, ACTOR])
  for (let i = 0; i < LIMIT - 2; i++) {
    await owner.query(
      `insert into memberships (tenant_id,user_id,branch_id,role,status,full_name)
       values ($1,$2,$3,'cashier','active','seeded')`,
      [tenantId, await makeUser(100 + i), branchId],
    )
  }
  check(`starts one under the cap (${LIMIT - 1})`, (await activeStaff()) === LIMIT - 1)

  const RACERS = 8
  const racers = await Promise.all(Array.from({ length: RACERS }, (_, i) => makeUser(200 + i)))

  // A barrier that releases once every racer has cleared its limit check — or
  // after a short timeout, whichever comes first.
  //
  // The timeout is load-bearing, not defensive. With the fix in place the
  // racers CANNOT all arrive: lockTenantUsage() serialises them, so the first
  // holds the lock while the rest queue behind it, and a barrier that waited
  // for all eight would deadlock. Timing out means the test still stretches the
  // window as wide as it can and then lets the code answer for itself —
  // reproducing the overshoot when the lock is absent, and confirming exactly
  // one seat when it is present.
  let arrived = 0
  let release: () => void
  const gate = new Promise<void>((r) => {
    release = r
  })
  const barrier = async () => {
    if (++arrived === RACERS) release()
    await Promise.race([gate, new Promise<void>((r) => setTimeout(r, 750))])
  }

  const results = await Promise.all(racers.map((u) => seatAttempt(u, barrier)))
  const created = results.filter((r) => r === 'created').length
  const finalCount = await activeStaff()
  const overshoot = finalCount - LIMIT

  console.log(
    `  ${RACERS} simultaneous requests, cap ${LIMIT}, started at ${LIMIT - 1}: ` +
      `${created} admitted, final ${finalCount}, overshoot ${overshoot}`,
  )

  // THE assertion. Before lockTenantUsage() this read 8 admitted / final 10 /
  // overshoot 7 — the cap simply did not apply under concurrency.
  check('exactly ONE of the eight was admitted', created === 1, { created, RACERS })
  check(`…so the tenant lands exactly on its cap of ${LIMIT}`, finalCount === LIMIT, finalCount)
  check('…and the plan limit was not exceeded at all', overshoot === 0, overshoot)

  // ══ 3. and once over, everything further is refused ═══════════════════════
  console.log('\n── over the cap, the gate stays shut ──')
  const after = await seatAttempt(await makeUser(300))
  check('a later serial attempt is refused', after === 'refused', after)
  check('…and added nothing', (await activeStaff()) === finalCount)

  // ── cleanup ───────────────────────────────────────────────────────────────
  await owner.query(`delete from memberships where tenant_id=$1`, [tenantId])
  await owner.query(`delete from tenant_subscriptions where tenant_id=$1`, [tenantId])
  await owner.query(`delete from branches where tenant_id=$1`, [tenantId])
  await owner.query(`delete from tenants where id=$1`, [tenantId])
  await owner.query(`delete from plan_entitlements where plan_id=$1`, [planId])
  await owner.query(`delete from plans where id=$1`, [planId])
  await owner.query(`delete from users where id = any($1)`, [userIds])
  await owner.end()
  await appPool.end()

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
