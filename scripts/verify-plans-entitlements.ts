/**
 * Platform plans, entitlements & tenant subscriptions (M16) — the model,
 * its isolation guarantee, and the reader, against a real database.
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs scripts/verify-plans-entitlements.ts
 *
 * Two connections, the same device every verify-* script in this directory
 * uses: `owner` bypasses RLS and stands in for the platform-admin path
 * (lib/actions/plans.ts writes exactly this way, after requirePlatformAdmin()),
 * while `app` is the restricted arena_app role every tenant request runs as.
 * Anything the app pool cannot do here, a tenant cannot do in production.
 *
 * The reader under test is readEntitlements() itself — the function
 * getEntitlements() delegates to — driven inside a real withUser() transaction,
 * so what is proven is the query the app actually runs, not a copy of it.
 */
import { Pool } from 'pg'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { sql } from 'drizzle-orm'
import * as schema from '../db/schema'
import { loadEnv } from './env'

loadEnv()

type Db = NodePgDatabase<typeof schema>

let pass = 0
let fail = 0
const check = (label: string, cond: boolean) => {
  console.log(`${cond ? '✓' : '✗ FAIL'}  ${label}`)
  if (cond) pass++
  else fail++
}
const section = (s: string) => console.log(`\n── ${s} ──`)

/** Did this statement fail the way a permission/RLS refusal fails? */
async function refused(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn()
    return null
  } catch (e) {
    return (e as { code?: string }).code ?? 'error'
  }
}

async function main() {
  const { readEntitlements } = await import('../lib/platform/entitlements')

  const owner = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })
  const appPool = new Pool({ connectionString: process.env.DATABASE_URL })
  const app = drizzle(appPool, { schema })

  /** Same contract as db/index.ts:withUser. */
  async function withUser<T>(userId: string, fn: (tx: Db) => Promise<T>): Promise<T> {
    return app.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`)
      return fn(tx as unknown as Db)
    })
  }

  /** Raw app-role SQL as a given user, for the RLS probes. */
  async function asUser<T>(userId: string, run: (c: Pool) => Promise<T>): Promise<T> {
    const c = await appPool.connect()
    try {
      await c.query('begin')
      await c.query(`select set_config('app.user_id', $1, true)`, [userId])
      const r = await run(c as unknown as Pool)
      await c.query('commit')
      return r
    } catch (e) {
      await c.query('rollback')
      throw e
    } finally {
      c.release()
    }
  }

  // ── fixtures ──────────────────────────────────────────────────────────────
  // Two tenants with an owner each, so cross-tenant reads have something real
  // to fail against. Dedicated slugs, cleaned up at the end.
  const ids: Record<string, string> = {}

  for (const slug of ['plana', 'planb']) {
    const t = await owner.query<{ id: string }>(
      `insert into tenants (slug, name, status) values ($1, $2, 'active')
       on conflict (slug) do update set status = 'active' returning id`,
      [slug, `${slug} co`],
    )
    ids[`tenant_${slug}`] = t.rows[0].id
    const br = await owner.query<{ id: string }>(
      `insert into branches (tenant_id, name, is_primary) values ($1, 'Main', true)
       on conflict (tenant_id, name) do update set is_primary = true returning id`,
      [t.rows[0].id],
    )
    const u = await owner.query<{ id: string }>(
      `insert into users (email, password_hash, full_name) values ($1, 'x', $2)
       on conflict (email) do update set full_name = excluded.full_name returning id`,
      [`owner@${slug}.test`, `${slug} owner`],
    )
    ids[`user_${slug}`] = u.rows[0].id
    await owner.query(
      `insert into memberships (tenant_id, user_id, branch_id, role, status, full_name, email)
       values ($1, $2, $3, 'owner', 'active', $4, $5)
       on conflict (tenant_id, user_id) do update set status = 'active'`,
      [t.rows[0].id, u.rows[0].id, br.rows[0].id, `${slug} owner`, `owner@${slug}.test`],
    )
  }

  // Clear any subscription left by a previous run so the no-subscription case
  // below starts from a known state.
  for (const slug of ['plana', 'planb']) {
    await owner.query('delete from tenant_subscriptions where tenant_id = $1', [ids[`tenant_${slug}`]])
  }
  await owner.query(`delete from plans where lower(btrim(name)) in ('verify basic','verify retired')`)

  const A = ids.tenant_plana
  const B = ids.tenant_planb
  const userA = ids.user_plana
  const userB = ids.user_planb

  // ── 1. the seeded catalogue ───────────────────────────────────────────────
  section('seed')
  const seeded = await owner.query<{ name: string; n: number }>(
    `select p.name, count(e.id)::int n
       from plans p left join plan_entitlements e on e.plan_id = p.id
      where p.name in ('Starter','Pro','Enterprise')
      group by p.name order by p.name`,
  )
  check('the three default plans are seeded', seeded.rows.length === 3)
  check('every default plan carries entitlements', seeded.rows.every((r) => r.n > 0))
  const proUnlimited = await owner.query<{ value: unknown }>(
    `select e.value from plan_entitlements e join plans p on p.id = e.plan_id
      where p.name = 'Enterprise' and e.key = 'max_branches'`,
  )
  check('"unlimited" is stored as jsonb null, not 0', proUnlimited.rows[0]?.value === null)
  const proModule = await owner.query<{ value: unknown }>(
    `select e.value from plan_entitlements e join plans p on p.id = e.plan_id
      where p.name = 'Pro' and e.key = 'module.payroll'`,
  )
  check('a module flag is stored as a real jsonb boolean', proModule.rows[0]?.value === true)

  // ── 2. constraints ────────────────────────────────────────────────────────
  section('constraints')
  const plan = await owner.query<{ id: string }>(
    `insert into plans (name, monthly_price, annual_price) values ('Verify Basic', 100, 1000) returning id`,
  )
  const planId = plan.rows[0].id

  check(
    'a duplicate plan name is rejected (case-insensitively)',
    (await refused(() => owner.query(`insert into plans (name) values ('verify basic')`))) === '23505',
  )
  check(
    'a negative price is rejected',
    (await refused(() => owner.query(`insert into plans (name, monthly_price) values ('Neg', -1)`))) === '23514',
  )

  await owner.query(`insert into plan_entitlements (plan_id, key, value) values ($1, 'max_branches', '2'::jsonb)`, [planId])
  check(
    'the same key twice on one plan is rejected',
    (await refused(() =>
      owner.query(`insert into plan_entitlements (plan_id, key, value) values ($1, 'max_branches', '3'::jsonb)`, [planId]),
    )) === '23505',
  )
  check(
    'a malformed entitlement key is rejected',
    (await refused(() =>
      owner.query(`insert into plan_entitlements (plan_id, key, value) values ($1, 'Max Branches', '3'::jsonb)`, [planId]),
    )) === '23514',
  )
  check(
    'a non-scalar entitlement value is rejected',
    (await refused(() =>
      owner.query(`insert into plan_entitlements (plan_id, key, value) values ($1, 'nested', '{"a":1}'::jsonb)`, [planId]),
    )) === '23514',
  )

  await owner.query(
    `insert into tenant_subscriptions (tenant_id, plan_id, status, current_period_end)
     values ($1, $2, 'active', now() + interval '30 days')`,
    [A, planId],
  )
  check(
    'a SECOND live subscription for the same tenant is rejected',
    (await refused(() =>
      owner.query(
        `insert into tenant_subscriptions (tenant_id, plan_id, status, current_period_end)
         values ($1, $2, 'trialing', now() + interval '30 days')`,
        [A, planId],
      ),
    )) === '23505',
  )
  check(
    'a period that ends before it starts is rejected',
    (await refused(() =>
      owner.query(
        `insert into tenant_subscriptions (tenant_id, plan_id, status, current_period_start, current_period_end)
         values ($1, $2, 'expired', now(), now() - interval '1 day')`,
        [B, planId],
      ),
    )) === '23514',
  )
  check(
    'a cancelled subscription must carry cancelled_at',
    (await refused(() =>
      owner.query(
        `insert into tenant_subscriptions (tenant_id, plan_id, status, current_period_end)
         values ($1, $2, 'cancelled', now() + interval '1 day')`,
        [B, planId],
      ),
    )) === '23514',
  )
  check(
    'a plan with subscribers cannot be deleted',
    (await refused(() => owner.query(`delete from plans where id = $1`, [planId]))) === '23503',
  )

  // ── 3. the app role cannot WRITE any of the three ──────────────────────────
  section('a tenant user cannot modify platform data')
  for (const [what, stmt] of [
    ['insert a plan', `insert into plans (name) values ('Sneaky')`],
    ['update a plan price', `update plans set monthly_price = 0`],
    ['delete a plan', `delete from plans`],
    ['insert an entitlement', `insert into plan_entitlements (plan_id, key, value) values ('${planId}', 'hax', 'true'::jsonb)`],
    ['update an entitlement', `update plan_entitlements set value = 'true'::jsonb`],
    ['delete an entitlement', `delete from plan_entitlements`],
    ['insert a subscription', `insert into tenant_subscriptions (tenant_id, plan_id, current_period_end) values ('${A}', '${planId}', now() + interval '1 day')`],
    ['upgrade its own subscription', `update tenant_subscriptions set plan_id = '${planId}'`],
    ['delete its own subscription', `delete from tenant_subscriptions`],
  ] as const) {
    const code = await asUser(userA, (c) => c.query(stmt))
      .then(() => null)
      .catch((e) => (e as { code?: string }).code ?? 'error')
    // 42501 = insufficient_privilege: the GRANT is missing, so this never even
    // reaches a policy. That is the intended, stronger refusal.
    check(`a tenant owner cannot ${what} (${code ?? 'ALLOWED!'})`, code === '42501')
  }

  // ── 4. reads: the catalogue and the tenant's own row ──────────────────────
  section('RLS reads')
  const catalogue = await asUser(userA, (c) =>
    c.query<{ name: string }>(`select name from plans order by name`),
  )
  check('a tenant user can read the live catalogue', catalogue.rows.some((r) => r.name === 'Pro'))

  const ownSub = await asUser(userA, (c) =>
    c.query<{ tenant_id: string }>(`select tenant_id from tenant_subscriptions`),
  )
  check('tenant A sees exactly one subscription — its own', ownSub.rows.length === 1)
  check('…and it is A’s', ownSub.rows[0]?.tenant_id === A)

  const otherSub = await asUser(userB, (c) =>
    c.query(`select id from tenant_subscriptions where tenant_id = $1`, [A]),
  )
  check('tenant B CANNOT read tenant A’s subscription, even by tenant id', otherSub.rows.length === 0)

  // ── 5. a RETIRED plan stays readable to its subscriber ────────────────────
  section('retired plan, grandfathered tenant')
  await owner.query(`update plans set active = false where id = $1`, [planId])

  const retiredToSubscriber = await asUser(userA, (c) =>
    c.query(`select name from plans where id = $1`, [planId]),
  )
  check('the subscriber can still read its own retired plan', retiredToSubscriber.rows.length === 1)

  const retiredToStranger = await asUser(userB, (c) =>
    c.query(`select name from plans where id = $1`, [planId]),
  )
  check('a NON-subscriber cannot see the retired plan', retiredToStranger.rows.length === 0)

  const entToStranger = await asUser(userB, (c) =>
    c.query(`select key from plan_entitlements where plan_id = $1`, [planId]),
  )
  check('…nor its entitlements', entToStranger.rows.length === 0)

  const entToSubscriber = await asUser(userA, (c) =>
    c.query(`select key from plan_entitlements where plan_id = $1`, [planId]),
  )
  check('…while the subscriber still can', entToSubscriber.rows.length === 1)

  await owner.query(`update plans set active = true where id = $1`, [planId])

  // ── 6. the reader ─────────────────────────────────────────────────────────
  section('readEntitlements()')
  const a1 = await withUser(userA, (tx) => readEntitlements(tx, A))
  check('an active subscription returns its plan', a1.plan?.name === 'Verify Basic')
  check('…the billing period', a1.billingPeriod === 'monthly')
  check('…the status', a1.status === 'active')
  check('…a real Date for the period end', a1.currentPeriodEnd instanceof Date)
  check('…and the entitlement value, typed', a1.entitlements.max_branches === 2)

  const b1 = await withUser(userB, (tx) => readEntitlements(tx, B))
  check('a tenant with NO subscription gets a null plan', b1.plan === null)
  check('…an empty entitlement map, never null', Object.keys(b1.entitlements).length === 0)
  check('…and null everywhere else', b1.status === null && b1.billingPeriod === null)

  // Cross-tenant through the reader itself: B asks for A's tenant id.
  const cross = await withUser(userB, (tx) => readEntitlements(tx, A))
  check('B asking the reader for A’s tenant id gets the empty answer', cross.plan === null)
  check('…indistinguishable from having no subscription', Object.keys(cross.entitlements).length === 0)

  // Lapsed on the clock while the status still says 'active'.
  await owner.query(
    `update tenant_subscriptions
        set current_period_start = now() - interval '60 days',
            current_period_end   = now() - interval '1 day'
      where tenant_id = $1`,
    [A],
  )
  const lapsed = await withUser(userA, (tx) => readEntitlements(tx, A))
  check('a subscription past its period_end grants nothing, even at status active', lapsed.plan === null)
  check('…and returns no entitlements', Object.keys(lapsed.entitlements).length === 0)

  // Cancelled.
  await owner.query(
    `update tenant_subscriptions
        set status = 'cancelled', cancelled_at = now(),
            current_period_end = now() + interval '30 days'
      where tenant_id = $1`,
    [A],
  )
  const cancelled = await withUser(userA, (tx) => readEntitlements(tx, A))
  check('a cancelled subscription grants nothing', cancelled.plan === null)

  // past_due inside its period still grants — dunning is a conversation.
  await owner.query(
    `update tenant_subscriptions
        set status = 'past_due', cancelled_at = null,
            current_period_end = now() + interval '5 days'
      where tenant_id = $1`,
    [A],
  )
  const pastDue = await withUser(userA, (tx) => readEntitlements(tx, A))
  check('a past_due subscription still grants inside its period', pastDue.plan?.name === 'Verify Basic')
  check('…and reports the past_due status honestly', pastDue.status === 'past_due')

  // A retired plan still grants everything it lists.
  await owner.query(`update plans set active = false where id = $1`, [planId])
  const grandfathered = await withUser(userA, (tx) => readEntitlements(tx, A))
  check('a RETIRED plan still grants its entitlements to an existing subscriber', grandfathered.entitlements.max_branches === 2)
  await owner.query(`update plans set active = true where id = $1`, [planId])

  // A key the reader has never heard of comes straight back — the property
  // that makes entitlements data rather than code.
  await owner.query(
    `insert into plan_entitlements (plan_id, key, value) values ($1, 'module.time_machine', 'true'::jsonb)`,
    [planId],
  )
  const novel = await withUser(userA, (tx) => readEntitlements(tx, A))
  check(
    'a key added at runtime is returned with no code change',
    novel.entitlements['module.time_machine'] === true,
  )

  // ── 7. the seeded demo tenant, end to end ─────────────────────────────────
  section('seeded demo tenant')
  const demo = await owner.query<{ id: string }>(`select id from tenants where slug = 'demo'`)
  if (demo.rows[0]) {
    const demoOwner = await owner.query<{ user_id: string }>(
      `select user_id from memberships where tenant_id = $1 and role = 'owner' and status = 'active' limit 1`,
      [demo.rows[0].id],
    )
    const d = await withUser(demoOwner.rows[0].user_id, (tx) => readEntitlements(tx, demo.rows[0].id))
    check('the seeded demo tenant is on Pro', d.plan?.name === 'Pro')
    check('…with module.payroll on', d.entitlements['module.payroll'] === true)
    check('…module.events off', d.entitlements['module.events'] === false)
    check('…and a numeric branch limit', d.entitlements.max_branches === 3)
  } else {
    check('demo tenant present (run npm run seed:demo)', false)
  }

  // ── cleanup ───────────────────────────────────────────────────────────────
  for (const slug of ['plana', 'planb']) {
    await owner.query('delete from tenant_subscriptions where tenant_id = $1', [ids[`tenant_${slug}`]])
  }
  await owner.query('delete from plans where id = $1', [planId])

  console.log(`\n${pass} passed, ${fail} failed`)
  await owner.end()
  await appPool.end()
  if (fail > 0) process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
