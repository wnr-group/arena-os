/**
 * An admin-created company is born ON A PLAN — the forward half of the
 * guarantee migration 0085 repairs backwards.
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs \
 *           --import ./scripts/next-runtime-hook.mjs \
 *           scripts/verify-admin-create-plan.ts
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * 0085 grandfathers every tenant that existed before M16. It is a one-shot
 * repair, and it cannot cover a company created after it runs. `createCompany()`
 * used to call `provisionTenant()` — which deliberately creates no subscription
 * — and then stop, so every company an admin created was born with payroll,
 * expenses and every report refused and its staff and resources capped. The
 * backfill would have started re-accumulating broken companies the next day.
 *
 * So the plan is now part of creating a company, and this proves it: the whole
 * action is driven for real, as a real platform admin with a real session row,
 * and the result is checked through the REAL entitlement guard — the same
 * functions lib/actions/payroll.ts and lib/actions/expenses.ts call.
 *
 * REAL: the database, the real `sessions` row and session decoder, the real
 * requirePlatformAdmin(), the real provisionTenant() and assignPlan(), the real
 * guard. Stubbed: only `next/headers` and `next/cache`, which are request-scoped
 * (see ./next-runtime-stub.cjs) — no guard, policy or business rule among them.
 */
import { randomBytes, createHash } from 'crypto'
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

async function main() {
  const { createCompany } = await import('../lib/actions/platform')
  const { requireEntitlement, limitFor } = await import('../lib/platform/entitlement-guard')

  const owner = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })
  const tag = randomBytes(3).toString('hex')

  // ── a real platform admin with a real session ─────────────────────────────
  const u = await owner.query<{ id: string }>(
    `insert into users (email, password_hash, full_name, is_platform_admin)
     values ($1,'x','create admin',true) returning id`,
    [`createplan-${tag}@example.test`],
  )
  const adminId = u.rows[0].id
  const token = randomBytes(32).toString('hex')
  await owner.query(
    `insert into sessions (id, user_id, expires_at) values ($1,$2, now() + interval '1 day')`,
    [createHash('sha256').update(token).digest('hex'), adminId],
  )
  const g = globalThis as { __ARENA_TEST_SESSION?: string }
  g.__ARENA_TEST_SESSION = token

  // ── two plans: one sellable, one retired ──────────────────────────────────
  const live = await owner.query<{ id: string }>(
    `insert into plans (name, monthly_price, annual_price, active)
     values ($1, 4999, 49990, true) returning id`,
    [`Create Test Live ${tag}`],
  )
  const livePlanId = live.rows[0].id
  await owner.query(
    `insert into plan_entitlements (plan_id, key, value)
     select $1, k, v::jsonb from unnest(
       array['max_branches','max_staff','max_resources','module.payroll','module.expenses','module.reports'],
       array['2','10','20','true','true','true']
     ) as t(k, v)`,
    [livePlanId],
  )

  const retired = await owner.query<{ id: string }>(
    `insert into plans (name, monthly_price, annual_price, active)
     values ($1, 0, 0, false) returning id`,
    [`Create Test Retired ${tag}`],
  )
  const retiredPlanId = retired.rows[0].id

  const slugsUsed: string[] = []
  const create = (slug: string, extra: Record<string, unknown>) => {
    slugsUsed.push(slug)
    return createCompany({
      companyName: `Create Co ${slug}`,
      slug,
      industry: 'gaming_cafe',
      ownerName: 'Create Owner',
      ownerEmail: `owner-${slug}@example.test`,
      ownerPassword: 'password123',
      ...extra,
    } as Parameters<typeof createCompany>[0])
  }

  const tenantBySlug = (slug: string) =>
    owner.query<{ id: string }>(`select id from tenants where slug = $1`, [slug])

  // ══ 1. the happy path ═════════════════════════════════════════════════════
  section('a company created with a plan can actually be used')

  const okSlug = `cpok${tag}`
  const ok = await create(okSlug, { planId: livePlanId, billingPeriod: 'monthly' })
  check('the action succeeded', !ok.error && ok.slug === okSlug)
  check('…with no partial-failure warning', !ok.warning)

  const made = await tenantBySlug(okSlug)
  check('the tenant exists', made.rowCount === 1)
  const newTenantId = made.rows[0]?.id

  const sub = await owner.query<{ status: string; plan_id: string; billing_period: string }>(
    `select status, plan_id, billing_period from tenant_subscriptions
      where tenant_id = $1 and status in ('trialing','active','past_due')`,
    [newTenantId],
  )
  check('it has exactly one LIVE subscription', sub.rowCount === 1)
  check('…on the plan that was chosen', sub.rows[0]?.plan_id === livePlanId)
  check('…with the billing period that was chosen', sub.rows[0]?.billing_period === 'monthly')

  // The point of the whole change: not "a row exists" but "the features work".
  // Driven through the guard the actions themselves call.
  const ownerUser = await owner.query<{ id: string; email: string }>(
    `select u.id, u.email from users u
       join memberships m on m.user_id = u.id
      where m.tenant_id = $1 and m.role = 'owner'`,
    [newTenantId],
  )
  const branch = await owner.query<{ id: string }>(
    `select id from branches where tenant_id = $1 limit 1`,
    [newTenantId],
  )
  const ctx = {
    user: { id: ownerUser.rows[0].id, email: ownerUser.rows[0].email, isPlatformAdmin: false },
    tenant: {
      id: newTenantId,
      slug: okSlug,
      name: `Create Co ${okSlug}`,
      status: 'active',
      currency: 'INR',
      timezone: 'Asia/Kolkata',
      industry: 'gaming_cafe',
    },
    role: 'owner',
    membershipId: 'unused',
    branchId: branch.rows[0].id,
  } as unknown as Parameters<typeof requireEntitlement>[0]

  const granted = async (key: string) => {
    try {
      await requireEntitlement(ctx, key)
      return true
    } catch {
      return false
    }
  }
  check('payroll works for the new company', await granted('module.payroll'))
  check('expenses works for the new company', await granted('module.expenses'))
  check('reports work for the new company', await granted('module.reports'))
  check('its staff limit is the plan’s 10, not a denial', (await limitFor(ctx, 'max_staff')) === 10)

  // ══ 2. a plan is not optional ═════════════════════════════════════════════
  //
  // The regression this change closes. A company created without a plan is the
  // exact broken workspace 0085 had to repair, so the action must refuse rather
  // than create one — and it must refuse BEFORE writing anything.
  section('creating a company without a plan is refused')

  const noPlanSlug = `cpnp${tag}`
  const noPlan = await create(noPlanSlug, {})
  check('the action refused', !!noPlan.error)
  check('…and named the plan as the problem', /plan/i.test(noPlan.error ?? ''))
  check('…and created NO tenant', (await tenantBySlug(noPlanSlug)).rowCount === 0)

  // ══ 3. a retired plan cannot start a company ══════════════════════════════
  //
  // `active = false` means "grandfathering only, never sell this again" — the
  // Grandfathered plan 0085 creates is exactly such a row, and starting a new
  // company on a free unlimited tier would be the worst possible reading of it.
  section('a retired plan cannot start a company')

  const retSlug = `cpret${tag}`
  const ret = await create(retSlug, { planId: retiredPlanId })
  check('the action refused', !!ret.error)
  check('…and said the plan is retired', /retired/i.test(ret.error ?? ''))
  check('…and created NO tenant', (await tenantBySlug(retSlug)).rowCount === 0)

  // ══ 4. an unknown plan id ═════════════════════════════════════════════════
  //
  // Checked before provisioning, so a stale form does not cost a half-made
  // company. This is what makes the partial-failure path narrow enough to
  // merely report rather than unwind.
  section('an unknown plan id is refused before anything is written')

  const badSlug = `cpbad${tag}`
  const bad = await create(badSlug, { planId: '00000000-0000-0000-0000-000000000000' })
  check('the action refused', !!bad.error)
  check('…and created NO tenant', (await tenantBySlug(badSlug)).rowCount === 0)

  // ── cleanup ───────────────────────────────────────────────────────────────
  const madeIds = (
    await owner.query<{ id: string }>(`select id from tenants where slug = any($1)`, [slugsUsed])
  ).rows.map((r) => r.id)
  if (madeIds.length > 0) {
    await owner.query(`delete from tenant_subscriptions where tenant_id = any($1)`, [madeIds])
    await owner.query(`delete from tenants where id = any($1)`, [madeIds])
  }
  await owner.query(`delete from plan_entitlements where plan_id = any($1)`, [
    [livePlanId, retiredPlanId],
  ])
  await owner.query(`delete from plans where id = any($1)`, [[livePlanId, retiredPlanId]])
  await owner.query(`delete from sessions where user_id = $1`, [adminId])
  await owner.query(`delete from users where email like $1`, [`owner-cp%${tag}@example.test`])
  await owner.query(`delete from users where id = $1`, [adminId])

  console.log(`\n${pass} passed, ${fail} failed`)
  await owner.end()
  if (fail > 0) process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
