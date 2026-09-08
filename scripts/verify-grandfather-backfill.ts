/**
 * Migration 0085 — existing tenants keep payroll, expenses and reports after
 * M16 deploys, against a real database.
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs scripts/verify-grandfather-backfill.ts
 *
 * ── What this proves, and why it is shaped this way ─────────────────────────
 *
 * M16's gates are fail-closed: a tenant with no `tenant_subscriptions` row is
 * refused payroll, expenses, every report, and is capped on staff and
 * resources. Every tenant that existed before M16 is that tenant, and nothing
 * in 0078–0084 gives them a row. 0085 is the backfill that closes it.
 *
 * The test EXECUTES db/migrations/0085_grandfather_existing_tenants.sql itself
 * rather than restating what it should do. A test that re-implements the
 * migration proves the test author and the migration author agree, which is not
 * the property anybody needs. Reading the real file means an edit to the
 * migration that breaks the guarantee fails here.
 *
 * It is driven through the REAL guard (lib/platform/entitlement-guard.ts) — the
 * same functions lib/actions/payroll.ts and lib/actions/expenses.ts call — so
 * what passes is the code path the actions take.
 *
 * ── Safe to run against a dev database ──────────────────────────────────────
 *
 * 0085 is idempotent and grandfathers EVERY tenant with no live subscription,
 * so running it here can create rows for tenants this test did not make. The
 * cleanup at the bottom removes exactly the Grandfathered subscriptions that
 * did not exist when the test started, and leaves everything else — including a
 * Grandfathered plan that was already there from a real deploy — untouched.
 */
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { Pool } from 'pg'
import { loadEnv } from './env'

loadEnv()

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
  const { requireEntitlement, checkLimit, limitFor } = await import(
    '../lib/platform/entitlement-guard'
  )
  const { getEntitlements } = await import('../lib/platform/entitlements')

  const owner = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })

  const MIGRATION = readFileSync(
    resolve(process.cwd(), 'db/migrations/0085_grandfather_existing_tenants.sql'),
    'utf8',
  )
  /** Run the real migration, exactly as scripts/migrate.ts would. */
  const runMigration = () => owner.query(MIGRATION)

  // Everything on the Grandfathered plan BEFORE this test ran, so cleanup can
  // remove only what the test caused. Empty on a database that never deployed.
  const preexisting = await owner.query<{ id: string }>(
    `select s.id from tenant_subscriptions s
       join plans p on p.id = s.plan_id
      where lower(btrim(p.name)) = 'grandfathered'`,
  )
  const preexistingIds = new Set(preexisting.rows.map((r) => r.id))
  const planPreexisted =
    (await owner.query(`select 1 from plans where lower(btrim(name)) = 'grandfathered'`)).rowCount! >
    0

  // ── fixtures: a tenant shaped exactly like a pre-M16 one ──────────────────
  //
  // Real tenant, real owner membership, and NO subscription row — which is
  // precisely the state every existing customer is in the moment M16 deploys.
  const t = await owner.query<{ id: string }>(
    `insert into tenants (slug, name, status) values ('gfath', 'grandfather co', 'active')
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
    `insert into users (email, password_hash, full_name) values ('owner@gfath.test','x','gfath owner')
     on conflict (email) do update set full_name = excluded.full_name returning id`,
  )
  const userId = u.rows[0].id
  await owner.query(
    `insert into memberships (tenant_id, user_id, branch_id, role, status, full_name, email)
     values ($1,$2,$3,'owner','active','gfath owner','owner@gfath.test')
     on conflict (tenant_id, user_id) do update set status='active', role='owner'`,
    [tenantId, userId, branchId],
  )
  // The pre-M16 state. Also undoes a previous run of this script.
  await owner.query(`delete from tenant_subscriptions where tenant_id = $1`, [tenantId])

  const ctx = {
    user: { id: userId, email: 'owner@gfath.test', isPlatformAdmin: false },
    tenant: {
      id: tenantId,
      slug: 'gfath',
      name: 'grandfather co',
      status: 'active',
      currency: 'INR',
      timezone: 'Asia/Kolkata',
      industry: 'gaming_cafe',
    },
    role: 'owner',
    membershipId: 'unused',
    branchId,
  } as unknown as Parameters<typeof requireEntitlement>[0]

  // ── 1. the regression, demonstrated ───────────────────────────────────────
  //
  // Not a formality: if these PASS, the rest of the test proves nothing, because
  // the tenant was already entitled and the backfill would be untestable here.
  section('before the backfill — an existing tenant is refused everything')

  check(
    'payroll is REFUSED (lib/actions/payroll.ts gate)',
    (await refusal(() => requireEntitlement(ctx, 'module.payroll'))) !== null,
  )
  check(
    'expenses is REFUSED (lib/actions/expenses.ts gate)',
    (await refusal(() => requireEntitlement(ctx, 'module.expenses'))) !== null,
  )
  check(
    'reports are REFUSED (lib/reports/*.ts gate)',
    (await refusal(() => requireEntitlement(ctx, 'module.reports'))) !== null,
  )
  check(
    'adding staff is CAPPED even at count 0 (lib/actions/team.ts gate)',
    (await refusal(() =>
      checkLimit(ctx, 'max_staff', 0, { one: 'staff member', many: 'staff members' }),
    )) !== null,
  )

  // ── 2. run the real migration ─────────────────────────────────────────────
  section('running db/migrations/0085_grandfather_existing_tenants.sql')
  await runMigration()
  console.log('  (applied)')

  // ── 3. the guarantee ──────────────────────────────────────────────────────
  //
  // getEntitlements() is React-cached per request; this script is not a request,
  // so each call re-reads. Nothing here relies on that either way — the checks
  // below go through the guard, which is what the actions do.
  section('after the backfill — the same tenant works again')

  check(
    'payroll is GRANTED',
    (await refusal(() => requireEntitlement(ctx, 'module.payroll'))) === null,
  )
  check(
    'expenses is GRANTED',
    (await refusal(() => requireEntitlement(ctx, 'module.expenses'))) === null,
  )
  check(
    'reports are GRANTED',
    (await refusal(() => requireEntitlement(ctx, 'module.reports'))) === null,
  )

  // Unlimited, not a number: a pre-M16 tenant may already hold more staff than
  // any finite tier allows, so a cap would refuse a business its own existing
  // headcount. `null` from limitFor() is the reader's word for unlimited; a
  // denial would come back as 0.
  check('max_staff is UNLIMITED (null, not 0)', (await limitFor(ctx, 'max_staff')) === null)
  check('max_resources is UNLIMITED', (await limitFor(ctx, 'max_resources')) === null)
  check('max_branches is UNLIMITED', (await limitFor(ctx, 'max_branches')) === null)
  check(
    'a huge existing staff count still admits one more',
    (await refusal(() =>
      checkLimit(ctx, 'max_staff', 100_000, { one: 'staff member', many: 'staff members' }),
    )) === null,
  )

  // module.events is deliberately NOT granted: grandfathering keeps what a
  // business had, and M15 never shipped.
  check(
    'module.events is still refused (not gifted)',
    (await refusal(() => requireEntitlement(ctx, 'module.events'))) !== null,
  )

  const e = await getEntitlements(ctx)
  check('the tenant is on the Grandfathered plan', e.plan?.name === 'Grandfathered')
  check('…with a live status', e.status === 'active')
  // The clock rule in readEntitlements() means a period end in the past reads as
  // NO_SUBSCRIPTION however 'active' the row says it is. A one-month backfill
  // would therefore have re-broken everything thirty days later.
  check(
    '…and a period end far enough out that it cannot lapse',
    !!e.currentPeriodEnd && e.currentPeriodEnd.getTime() > Date.now() + 365 * 24 * 3600 * 1000,
  )

  // ── 4. the plan must not become purchasable ───────────────────────────────
  section('the Grandfathered plan is not offerable')

  const planRow = await owner.query<{ id: string; active: boolean; monthly_price: string }>(
    `select id, active, monthly_price from plans where lower(btrim(name)) = 'grandfathered'`,
  )
  check('exactly one Grandfathered plan exists', planRow.rowCount === 1)
  check('it is retired (active = false)', planRow.rows[0].active === false)
  check('it is priced at zero', Number(planRow.rows[0].monthly_price) === 0)

  // The public signup picker reads through `plans_select_active`; a retired plan
  // is invisible to it. This is the check that stops the backfill accidentally
  // publishing a free unlimited tier.
  const { listPublicPlans } = await import('../lib/platform/plans/public')
  const publicPlans = await listPublicPlans()
  check(
    'it is absent from the public signup catalogue',
    !publicPlans.some((p) => p.name === 'Grandfathered'),
  )

  // ── 5. idempotency ────────────────────────────────────────────────────────
  //
  // idx_tenant_subscriptions_one_live is a PARTIAL unique index, so a second
  // insert for the same tenant would raise rather than duplicate quietly. Both
  // outcomes are failures; this proves neither happens.
  section('running it a second time changes nothing')

  const before = await owner.query<{ n: string }>(
    `select count(*) n from tenant_subscriptions where tenant_id = $1`,
    [tenantId],
  )
  await runMigration()
  const after = await owner.query<{ n: string }>(
    `select count(*) n from tenant_subscriptions where tenant_id = $1`,
    [tenantId],
  )
  check('no second subscription row', before.rows[0].n === after.rows[0].n)
  check('still exactly one row for the tenant', after.rows[0].n === '1')

  const ents = await owner.query<{ n: string }>(
    `select count(*) n from plan_entitlements pe
       join plans p on p.id = pe.plan_id
      where lower(btrim(p.name)) = 'grandfathered'`,
  )
  check('entitlements were not duplicated', ents.rows[0].n === '7')

  // ── 6. it leaves a paying tenant alone ────────────────────────────────────
  //
  // The `not exists` clause is keyed on the three LIVE statuses. A tenant that
  // already subscribed — mid-trial, or assigned a tier by an operator — must
  // come out the other side on the plan it had, not silently moved onto a free
  // one.
  section('a tenant that already has a plan is untouched')

  const t2 = await owner.query<{ id: string }>(
    `insert into tenants (slug, name, status) values ('gfpaid', 'paying co', 'active')
     on conflict (slug) do update set status = 'active' returning id`,
  )
  const paidTenantId = t2.rows[0].id
  await owner.query(`delete from tenant_subscriptions where tenant_id = $1`, [paidTenantId])
  await owner.query(`delete from plans where name = 'Grandfather Test Tier'`)
  const p2 = await owner.query<{ id: string }>(
    `insert into plans (name, monthly_price, annual_price) values ('Grandfather Test Tier', 1, 1)
     returning id`,
  )
  const paidPlanId = p2.rows[0].id
  await owner.query(
    `insert into tenant_subscriptions
       (tenant_id, plan_id, status, current_period_start, current_period_end)
     values ($1, $2, 'active', now() - interval '1 day', now() + interval '30 days')`,
    [paidTenantId, paidPlanId],
  )

  await runMigration()

  const stillOn = await owner.query<{ name: string; n: string }>(
    `select p.name, count(*) over () n
       from tenant_subscriptions s
       join plans p on p.id = s.plan_id
      where s.tenant_id = $1
        and s.status in ('trialing','active','past_due')`,
    [paidTenantId],
  )
  check('the paying tenant still has exactly one live subscription', stillOn.rowCount === 1)
  check('…and it is still its own plan', stillOn.rows[0]?.name === 'Grandfather Test Tier')

  // ── cleanup ───────────────────────────────────────────────────────────────
  //
  // Only what this run created. A Grandfathered subscription that existed before
  // the test — a real deployed backfill — is left exactly where it was.
  const nowGrandfathered = await owner.query<{ id: string }>(
    `select s.id from tenant_subscriptions s
       join plans p on p.id = s.plan_id
      where lower(btrim(p.name)) = 'grandfathered'`,
  )
  const created = nowGrandfathered.rows.map((r) => r.id).filter((id) => !preexistingIds.has(id))
  if (created.length > 0) {
    await owner.query(`delete from tenant_subscriptions where id = any($1)`, [created])
  }
  await owner.query(`delete from tenant_subscriptions where tenant_id = any($1)`, [
    [tenantId, paidTenantId],
  ])
  await owner.query(`delete from plans where id = $1`, [paidPlanId])
  if (!planPreexisted) {
    await owner.query(
      `delete from plan_entitlements where plan_id in
         (select id from plans where lower(btrim(name)) = 'grandfathered')`,
    )
    await owner.query(`delete from plans where lower(btrim(name)) = 'grandfathered'`)
  }

  console.log(`\n${pass} passed, ${fail} failed`)
  await owner.end()
  if (fail > 0) process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
