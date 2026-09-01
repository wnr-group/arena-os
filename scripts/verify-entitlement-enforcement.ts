/**
 * Entitlement enforcement (M16 #2) — the fail-closed rules, the limit
 * arithmetic, and the module gates, against a real database.
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs scripts/verify-entitlement-enforcement.ts
 *
 * Drives the REAL guard (lib/platform/entitlement-guard.ts) over real
 * subscriptions on a real tenant, so what is proven is the code the actions
 * call — not a restatement of its rules. The counters in lib/platform/usage.ts
 * are driven the same way, inside a live withUser() transaction, because a
 * count taken anywhere else would not be the count the enforcement uses.
 *
 * Nothing here calls a server action: those need a request context. The action
 * WIRING (which action gates on which key) is verified over HTTP separately;
 * this proves the rules those actions delegate to.
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

/** Ran without throwing? Returns the EntitlementError message, or null. */
async function refusal(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn()
    return null
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}

async function main() {
  const { requireEntitlement, checkLimit, hasEntitlement, limitFor, EntitlementError } =
    await import('../lib/platform/entitlement-guard')
  const { countActiveStaff, countResources, countBranches } = await import('../lib/platform/usage')

  const owner = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })
  const appPool = new Pool({ connectionString: process.env.DATABASE_URL })
  const app = drizzle(appPool, { schema })

  async function withUser<T>(userId: string, fn: (tx: Db) => Promise<T>): Promise<T> {
    return app.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`)
      return fn(tx as unknown as Db)
    })
  }

  // ── fixtures ──────────────────────────────────────────────────────────────
  const t = await owner.query<{ id: string }>(
    `insert into tenants (slug, name, status) values ('entf', 'entf co', 'active')
     on conflict (slug) do update set status = 'active' returning id`,
  )
  const tenantId = t.rows[0].id
  const br = await owner.query<{ id: string }>(
    `insert into branches (tenant_id, name, is_primary) values ($1, 'Main', true)
     on conflict (tenant_id, name) do update set is_primary = true returning id`,
    [tenantId],
  )
  const branchId = br.rows[0].id
  const u = await owner.query<{ id: string }>(
    `insert into users (email, password_hash, full_name) values ('owner@entf.test','x','entf owner')
     on conflict (email) do update set full_name = excluded.full_name returning id`,
  )
  const userId = u.rows[0].id
  await owner.query(
    `insert into memberships (tenant_id, user_id, branch_id, role, status, full_name, email)
     values ($1,$2,$3,'owner','active','entf owner','owner@entf.test')
     on conflict (tenant_id, user_id) do update set status='active', role='owner'`,
    [tenantId, userId, branchId],
  )

  // A private plan for this test, so retuning it cannot disturb the seeded catalogue.
  await owner.query(`delete from tenant_subscriptions where tenant_id = $1`, [tenantId])
  await owner.query(`delete from plans where name = 'Enforcement Test'`)
  const p = await owner.query<{ id: string }>(
    `insert into plans (name, monthly_price, annual_price) values ('Enforcement Test', 1, 1) returning id`,
  )
  const planId = p.rows[0].id

  /** Replace the plan's entitlement rows wholesale. */
  async function setEntitlements(entries: Record<string, unknown>) {
    await owner.query(`delete from plan_entitlements where plan_id = $1`, [planId])
    for (const [k, v] of Object.entries(entries)) {
      await owner.query(
        `insert into plan_entitlements (plan_id, key, value) values ($1, $2, $3::jsonb)`,
        [planId, k, JSON.stringify(v)],
      )
    }
  }

  async function subscribe(status: string, endsInDays: number) {
    await owner.query(`delete from tenant_subscriptions where tenant_id = $1`, [tenantId])
    await owner.query(
      `insert into tenant_subscriptions
         (tenant_id, plan_id, status, current_period_start, current_period_end, cancelled_at)
       values ($1, $2, $3::tenant_subscription_status,
               now() - interval '10 days', now() + ($4 || ' days')::interval,
               case when $3 = 'cancelled' then now() else null end)`,
      [tenantId, planId, status, String(endsInDays)],
    )
  }

  /** The ActiveContext shape the guard needs. */
  const ctx = {
    user: { id: userId, email: 'owner@entf.test', isPlatformAdmin: false },
    tenant: { id: tenantId, slug: 'entf', name: 'entf co', status: 'active', currency: 'INR', timezone: 'Asia/Kolkata', industry: 'gaming_cafe' },
    role: 'owner',
    membershipId: 'unused',
    branchId,
  } as unknown as Parameters<typeof requireEntitlement>[0]

  // ── 1. FAIL-CLOSED: no subscription ───────────────────────────────────────
  section('no subscription at all')
  await owner.query(`delete from tenant_subscriptions where tenant_id = $1`, [tenantId])

  let m = await refusal(() => requireEntitlement(ctx, 'module.payroll'))
  check('a module is REFUSED with no subscription', m !== null)
  check('…and the message says to assign a plan', !!m?.includes('no active plan'))
  check('hasEntitlement() agrees', (await hasEntitlement(ctx, 'module.payroll')) === false)

  m = await refusal(() => checkLimit(ctx, 'max_staff', 0, { one: 'staff member', many: 'staff members' }))
  check('a limit is REFUSED with no subscription, even at count 0', m !== null)
  check('…it is NOT treated as unlimited', !!m?.includes('no active plan'))
  check('limitFor() reports 0, not Infinity', (await limitFor(ctx, 'max_staff')) === 0)

  // ── 2. FAIL-CLOSED: expired / cancelled ───────────────────────────────────
  section('expired and cancelled subscriptions')
  await setEntitlements({ max_staff: 5, 'module.payroll': true })

  await subscribe('active', -1) // period ended yesterday, status still 'active'
  check(
    'a LAPSED subscription refuses a module',
    (await refusal(() => requireEntitlement(ctx, 'module.payroll'))) !== null,
  )
  check(
    '…and refuses a limit',
    (await refusal(() => checkLimit(ctx, 'max_staff', 0))) !== null,
  )

  await subscribe('cancelled', 30)
  check(
    'a CANCELLED subscription refuses a module even inside its period',
    (await refusal(() => requireEntitlement(ctx, 'module.payroll'))) !== null,
  )

  await subscribe('past_due', 5)
  check(
    'a PAST_DUE subscription inside its period still GRANTS',
    (await refusal(() => requireEntitlement(ctx, 'module.payroll'))) === null,
  )

  // ── 3. FAIL-CLOSED: malformed / missing configuration ─────────────────────
  section('missing and malformed entitlements')
  await subscribe('active', 30)

  await setEntitlements({ 'module.payroll': true }) // max_staff absent entirely
  m = await refusal(() => checkLimit(ctx, 'max_staff', 0, { one: 'staff member', many: 'staff members' }))
  check('a MISSING limit key is refused, not treated as unlimited', m !== null)
  check('…and says the plan does not include it', !!m?.includes('does not include'))

  await setEntitlements({ max_staff: true })
  check(
    'a limit key holding a BOOLEAN is refused as misconfigured',
    !!(await refusal(() => checkLimit(ctx, 'max_staff', 0)))?.includes('not configured correctly'),
  )

  await setEntitlements({ max_staff: -1 })
  check(
    'a NEGATIVE limit is refused as misconfigured',
    (await refusal(() => checkLimit(ctx, 'max_staff', 0))) !== null,
  )

  await setEntitlements({ 'module.payroll': 'yes' })
  check(
    'a module key holding a STRING does not grant',
    (await refusal(() => requireEntitlement(ctx, 'module.payroll'))) !== null,
  )
  await setEntitlements({ 'module.payroll': 1 })
  check(
    'a module key holding 1 does not grant — only boolean true does',
    (await refusal(() => requireEntitlement(ctx, 'module.payroll'))) !== null,
  )
  await setEntitlements({ 'module.payroll': false })
  m = await refusal(() => requireEntitlement(ctx, 'module.payroll'))
  check('an explicit false refuses', m !== null)
  check('…with the "upgrade" wording, since a plan does exist', !!m?.includes('not included in your plan'))

  // ── 4. limit arithmetic ───────────────────────────────────────────────────
  section('limit arithmetic')
  await setEntitlements({ max_staff: 5, max_branches: 1, max_resources: 0 })

  check('under the limit passes', (await refusal(() => checkLimit(ctx, 'max_staff', 4))) === null)
  m = await refusal(() => checkLimit(ctx, 'max_staff', 5, { one: 'staff member', many: 'staff members' }))
  check('EXACTLY AT the limit refuses the next one', m !== null)
  check('…with the ticket\'s wording', m === 'Your plan allows 5 staff members. Upgrade your plan to add more.')
  check('OVER the limit (after a downgrade) also refuses', (await refusal(() => checkLimit(ctx, 'max_staff', 9))) !== null)

  m = await refusal(() => checkLimit(ctx, 'max_branches', 1, { one: 'branch', many: 'branches' }))
  check('a limit of 1 uses the SINGULAR noun', m === 'Your plan allows 1 branch. Upgrade your plan to add more.')

  check('a limit of 0 refuses at count 0', (await refusal(() => checkLimit(ctx, 'max_resources', 0))) !== null)

  await setEntitlements({ max_staff: null })
  check('an explicit null means UNLIMITED', (await refusal(() => checkLimit(ctx, 'max_staff', 9999))) === null)
  check('…and limitFor() reports null', (await limitFor(ctx, 'max_staff')) === null)

  // ── 5. the error type ─────────────────────────────────────────────────────
  section('error type')
  await setEntitlements({ 'module.payroll': false })
  let caught: unknown = null
  try {
    await requireEntitlement(ctx, 'module.payroll')
  } catch (e) {
    caught = e
  }
  check('the guard throws EntitlementError', caught instanceof EntitlementError)
  check('…carrying the key that refused', (caught as InstanceType<typeof EntitlementError>)?.key === 'module.payroll')

  // ── 6. the usage counters, in a real transaction ──────────────────────────
  section('usage counters')
  const staffCount = await withUser(userId, (tx) => countActiveStaff(tx, tenantId))
  check('countActiveStaff sees the one owner', staffCount === 1)

  await owner.query(
    `insert into memberships (tenant_id, user_id, branch_id, role, status, full_name, email)
     values ($1,$2,$3,'cashier','disabled','gone','gone@entf.test')
     on conflict (tenant_id, user_id) do update set status='disabled'`,
    [
      tenantId,
      (
        await owner.query<{ id: string }>(
          `insert into users (email, password_hash) values ('gone@entf.test','x')
           on conflict (email) do update set password_hash='x' returning id`,
        )
      ).rows[0].id,
      branchId,
    ],
  )
  check(
    'a DISABLED membership does not consume a seat',
    (await withUser(userId, (tx) => countActiveStaff(tx, tenantId))) === 1,
  )

  check('countBranches sees the one branch', (await withUser(userId, (tx) => countBranches(tx, tenantId))) === 1)

  const rt = await owner.query<{ id: string }>(
    `insert into resource_types (tenant_id, name, hourly_rate) values ($1,'Bay',100)
     on conflict (tenant_id, name) do update set hourly_rate = 100 returning id`,
    [tenantId],
  )
  await owner.query(
    `insert into resources (tenant_id, branch_id, resource_type_id, name, status)
     values ($1,$2,$3,'Bay 1','maintenance') on conflict (tenant_id, name) do nothing`,
    [tenantId, branchId, rt.rows[0].id],
  )
  check(
    'countResources counts a resource parked at maintenance',
    (await withUser(userId, (tx) => countResources(tx, tenantId))) === 1,
  )

  // ── 7. tenant isolation of the gate itself ────────────────────────────────
  section('isolation')
  // A second tenant on no plan; the first tenant's grant must not leak to it.
  const t2 = await owner.query<{ id: string }>(
    `insert into tenants (slug, name, status) values ('entg','entg co','active')
     on conflict (slug) do update set status='active' returning id`,
  )
  const u2 = await owner.query<{ id: string }>(
    `insert into users (email, password_hash) values ('owner@entg.test','x')
     on conflict (email) do update set password_hash='x' returning id`,
  )
  const b2 = await owner.query<{ id: string }>(
    `insert into branches (tenant_id, name, is_primary) values ($1,'Main',true)
     on conflict (tenant_id, name) do update set is_primary=true returning id`,
    [t2.rows[0].id],
  )
  await owner.query(
    `insert into memberships (tenant_id, user_id, branch_id, role, status, full_name, email)
     values ($1,$2,$3,'owner','active','entg owner','owner@entg.test')
     on conflict (tenant_id, user_id) do update set status='active'`,
    [t2.rows[0].id, u2.rows[0].id, b2.rows[0].id],
  )
  await owner.query(`delete from tenant_subscriptions where tenant_id = $1`, [t2.rows[0].id])
  await setEntitlements({ 'module.payroll': true })
  await subscribe('active', 30)

  const ctx2 = {
    ...(ctx as unknown as Record<string, unknown>),
    user: { id: u2.rows[0].id, email: 'owner@entg.test', isPlatformAdmin: false },
    tenant: { ...(ctx as unknown as { tenant: Record<string, unknown> }).tenant, id: t2.rows[0].id, slug: 'entg' },
  } as unknown as typeof ctx

  check(
    'tenant A (subscribed) is granted the module',
    (await refusal(() => requireEntitlement(ctx, 'module.payroll'))) === null,
  )
  check(
    'tenant B (no plan) is REFUSED the same module',
    (await refusal(() => requireEntitlement(ctx2, 'module.payroll'))) !== null,
  )

  // ── cleanup ───────────────────────────────────────────────────────────────
  await owner.query(`delete from tenant_subscriptions where tenant_id = any($1)`, [[tenantId, t2.rows[0].id]])
  await owner.query(`delete from plans where id = $1`, [planId])
  await owner.query(`delete from resources where tenant_id = $1`, [tenantId])
  await owner.query(`delete from resource_types where tenant_id = $1`, [tenantId])

  console.log(`\n${pass} passed, ${fail} failed`)
  await owner.end()
  await appPool.end()
  if (fail > 0) process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
