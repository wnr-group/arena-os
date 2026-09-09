/**
 * Test support (M16 #2): put a fixture tenant on a plan that enables everything.
 *
 * Entitlement enforcement is FAIL-CLOSED — a tenant with no subscription is
 * granted nothing (see lib/platform/entitlement-guard.ts). The verification
 * scripts create throwaway tenants directly in SQL, which therefore have no
 * plan, so any script that drives a gated module (reports, payroll, expenses)
 * must say so explicitly.
 *
 * Calling this is the script's way of stating "this fixture is a paying
 * customer" — the thing that used to be true implicitly, before plans existed.
 * It deliberately does NOT weaken the guard or add a test-only bypass to it:
 * production code has one code path, and these scripts exercise that path.
 *
 * Idempotent, and safe to call for many tenants — they share one hidden plan
 * row rather than each minting their own.
 */

/** Just enough of pg's Client/Pool for this helper; scripts use both. */
type Queryable = {
  query: (text: string, values?: unknown[]) => Promise<{ rows: { id: string }[] }>
}

/** Marked inactive so it never appears in the real catalogue or the admin UI. */
const FIXTURE_PLAN = 'Test Fixture (all modules)'

export async function entitleTenant(db: Queryable, tenantId: string): Promise<void> {
  const plan = await db.query(
    `insert into public.plans (name, monthly_price, annual_price, active)
     values ($1, 0, 0, false)
     on conflict (lower(btrim(name))) do update set active = false
     returning id`,
    [FIXTURE_PLAN],
  )
  const planId = plan.rows[0].id

  // Every module on, every limit unlimited (null). A fixture must never fail a
  // check for a reason the test is not about.
  const entries: [string, string][] = [
    ['module.payroll', 'true'],
    ['module.expenses', 'true'],
    ['module.reports', 'true'],
    ['module.events', 'true'],
    ['max_branches', 'null'],
    ['max_staff', 'null'],
    ['max_resources', 'null'],
  ]
  for (const [key, value] of entries) {
    await db.query(
      `insert into public.plan_entitlements (plan_id, key, value)
       values ($1, $2, $3::jsonb)
       on conflict (plan_id, key) do update set value = excluded.value`,
      [planId, key, value],
    )
  }

  // `where not exists` rather than on-conflict: idx_tenant_subscriptions_one_live
  // is a PARTIAL unique index, and a re-run must not open a second live row.
  await db.query(
    `insert into public.tenant_subscriptions
       (tenant_id, plan_id, status, current_period_start, current_period_end)
     select $1, $2, 'active', now(), now() + interval '365 days'
      where not exists (
        select 1 from public.tenant_subscriptions s
         where s.tenant_id = $1 and s.status in ('trialing','active','past_due')
      )`,
    [tenantId, planId],
  )
}
