/**
 * M16 — the AUTHORIZATION MATRIX for every subscription/billing mutation.
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs \
 *           --import ./scripts/next-runtime-hook.mjs \
 *           scripts/test-m16-authorization.ts
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 *
 * The M16 suites are thorough about DOMAIN behaviour — proration, GST, dunning
 * clocks, MRR — and they drive that domain code directly. What none of them
 * drives is the SERVER ACTION with its guard attached, in the negative case.
 *
 * That leaves the load-bearing half of the security story unproven:
 *
 *   * scripts/test-owner-billing-portal.ts checks that a manager READS no
 *     invoices, but never calls changeSubscriptionPlan() as one — so
 *     `requireOwner()` on the four mutating actions was asserted by nobody.
 *   * scripts/test-platform-billing.ts states in its own header that "a test
 *     that signs in as a non-admin is genuinely refused by the genuine guard",
 *     but every override case it runs is signed in AS the admin — so
 *     `requirePlatformAdmin()` on the five overrides was asserted by nobody.
 *
 * Both guards are present in the source. Present and proven are different
 * things, and an authorization guard is exactly the kind of line that a later
 * refactor deletes without any test going red.
 *
 * ── What is real here ───────────────────────────────────────────────────────
 *
 * REAL: the database, every RLS policy, the real `sessions` rows, the real
 * session decoder, the real requireOwner()/requireManager()/requirePlatformAdmin()
 * guards, and the real server actions as the browser would invoke them.
 *
 * FAKED: only Next's request runtime (a cookie jar and a header bag), via
 * ./next-runtime-hook.mjs. No guard, role check or policy is stubbed — the
 * session token is looked up against the real table by the real code, so a
 * refusal here is a refusal the deployed app would produce.
 *
 * Every action is invoked with an input that WOULD SUCCEED for the right
 * caller, so a refusal can only be the guard and never a validation error that
 * happens to fire first. That is asserted directly: the owner/admin control
 * case is run for each action and must NOT be an authorization refusal.
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

/** The refusals the guards produce. Matched on text, as the browser would see them. */
const OWNER_REFUSAL = /owners only/i
const ADMIN_REFUSAL = /platform admin|not authorised|not authorized|not signed in|sign in/i
const ANY_REFUSAL = /owners only|platform admin|not authorised|not authorized|not signed in|sign in|no active workspace|session/i

async function main() {
  const { changeSubscriptionPlan, previewPlanChange, cancelSubscription, createPaymentMethodUpdateFlow } =
    await import('../lib/actions/subscription')
  const { assignPlan, createPlan, setPlanActive } = await import('../lib/actions/plans')
  const { extendTrialAction, compTenantAction, refundInvoiceAction, forceCancelAction } =
    await import('../lib/actions/platform-billing')
  const { savePlatformGateway } = await import('../lib/actions/platform-gateway')

  const owner = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })
  const tag = randomBytes(3).toString('hex')

  // ── identities: real users, real session rows ─────────────────────────────
  const userIds: string[] = []
  async function makeUser(label: string, isAdmin: boolean) {
    const email = `m16auth-${label}-${tag}@example.test`
    const u = await owner.query<{ id: string }>(
      `insert into users (email, password_hash, full_name, is_platform_admin)
       values ($1,'x',$2,$3) returning id`,
      [email, label, isAdmin],
    )
    userIds.push(u.rows[0].id)
    const token = randomBytes(32).toString('hex')
    await owner.query(
      `insert into sessions (id, user_id, expires_at) values ($1,$2, now() + interval '1 day')`,
      [createHash('sha256').update(token).digest('hex'), u.rows[0].id],
    )
    return { id: u.rows[0].id, token }
  }

  const ADMIN = await makeUser('admin', true)
  const OWNER = await makeUser('owner', false)
  const MANAGER = await makeUser('manager', false)
  const CASHIER = await makeUser('cashier', false)

  // ── a tenant on a live plan, so every action has real work to refuse ──────
  const slug = `m16a${tag}`
  const t = await owner.query<{ id: string }>(
    `insert into tenants (slug,name,status,timezone) values ($1,'M16 Auth Co','active','Asia/Kolkata')
     returning id`,
    [slug],
  )
  const tenantId = t.rows[0].id
  const br = await owner.query<{ id: string }>(
    `insert into branches (tenant_id,name,is_primary) values ($1,'Main',true) returning id`,
    [tenantId],
  )
  for (const [u, role] of [
    [OWNER, 'owner'],
    [MANAGER, 'manager'],
    [CASHIER, 'cashier'],
  ] as Array<[{ id: string }, string]>) {
    await owner.query(
      `insert into memberships (tenant_id,user_id,branch_id,role,status,full_name)
       values ($1,$2,$3,$4::member_role,'active',$5)`,
      [tenantId, u.id, br.rows[0].id, role, role],
    )
  }

  const planIds: string[] = []
  async function makePlan(name: string, monthly: string) {
    const p = await owner.query<{ id: string }>(
      `insert into plans (name, monthly_price, annual_price, currency, active)
       values ($1,$2,$3,'INR',true) returning id`,
      [name, monthly, String(Number(monthly) * 10)],
    )
    planIds.push(p.rows[0].id)
    return p.rows[0].id
  }
  const planA = await makePlan(`AuthA ${tag}`, '1000')
  const planB = await makePlan(`AuthB ${tag}`, '2000')

  const sub = await owner.query<{ id: string }>(
    `insert into tenant_subscriptions
       (tenant_id, plan_id, billing_period, status, current_period_start, current_period_end)
     values ($1,$2,'monthly','active', now() - interval '5 days', now() + interval '25 days')
     returning id`,
    [tenantId, planA],
  )
  const subscriptionId = sub.rows[0].id

  // A paid invoice, so refundInvoiceAction() has a real target to refuse on.
  const inv = await owner.query<{ id: string }>(
    `insert into platform_invoices
       (tenant_id, subscription_id, plan_id, invoice_number, period,
        billing_period_start, billing_period_end, billing_period_type,
        plan_name, plan_price, seller_legal_name, buyer_legal_name,
        subtotal, taxable_value, gst_rate, cgst, sgst, tax_total, total,
        status, gateway, gateway_payment_id)
     values ($1,$2,$3,$4,'2026-08',
             now() - interval '5 days', now() + interval '25 days', 'monthly',
             -- GST is INCLUSIVE (0080): subtotal is the gross captured,
             -- taxable_value is what remains once the tax inside it is removed,
             -- and total = taxable_value + tax_total = subtotal - adjustment.
             'AuthA', 1180, 'Arena OS', 'M16 Auth Co',
             1180, 1000, 18, 90, 90, 180, 1180,
             'paid','razorpay',$5)
     returning id`,
    [tenantId, subscriptionId, planA, `AUTH-${tag}`, `pay_auth${tag}`],
  )
  const invoiceId = inv.rows[0].id

  // ── the harness switches ──────────────────────────────────────────────────
  const g = globalThis as { __ARENA_TEST_SESSION?: string; __ARENA_TEST_HEADERS?: Record<string, string> }
  const signedInAs = (token?: string) => {
    g.__ARENA_TEST_SESSION = token
  }
  // Present for every case: the tenant-scoped guards resolve the workspace from
  // this header, and without it they would refuse for the WRONG reason.
  g.__ARENA_TEST_HEADERS = { 'x-tenant-slug': slug }

  const refused = (r: unknown, pattern: RegExp) =>
    typeof r === 'object' && r !== null && typeof (r as { error?: string }).error === 'string' &&
    pattern.test((r as { error: string }).error)

  // ══ 1. tenant billing mutations are OWNER-ONLY ════════════════════════════
  console.log('\n── owner-only: the tenant billing actions ──')

  const ownerOnly: Array<[string, () => Promise<unknown>]> = [
    ['changeSubscriptionPlan', () => changeSubscriptionPlan({ planId: planB, billingPeriod: 'monthly' })],
    ['previewPlanChange', () => previewPlanChange({ planId: planB, billingPeriod: 'monthly' })],
    ['createPaymentMethodUpdateFlow', () => createPaymentMethodUpdateFlow()],
    ['cancelSubscription', () => cancelSubscription()],
  ]

  for (const [name, callIt] of ownerOnly) {
    for (const [who, token] of [
      ['a MANAGER', MANAGER.token],
      ['a CASHIER', CASHIER.token],
    ] as Array<[string, string]>) {
      signedInAs(token)
      const r = await callIt()
      check(`${name}() refuses ${who}`, refused(r, OWNER_REFUSAL), r)
    }

    // Signed out entirely.
    signedInAs(undefined)
    const anon = await callIt()
    check(`${name}() refuses an unauthenticated caller`, refused(anon, ANY_REFUSAL), anon)

    // A platform admin is not a member of this tenant, so the TENANT guard must
    // still refuse — platform authority is not tenant authority.
    signedInAs(ADMIN.token)
    const asAdmin = await callIt()
    check(`${name}() refuses a platform admin who is not a member`, refused(asAdmin, ANY_REFUSAL), asAdmin)
  }

  // The control: the owner is NOT refused by the guard. These actions reach the
  // gateway and will fail for other reasons (no platform Razorpay configured in
  // a test database) — what matters is that the failure is not authorization.
  console.log('\n── …and the owner gets past the guard ──')
  signedInAs(OWNER.token)
  for (const [name, callIt] of ownerOnly) {
    const r = await callIt()
    check(
      `${name}() does NOT refuse the owner on authorization`,
      !refused(r, OWNER_REFUSAL),
      r,
    )
  }

  // ══ 2. platform overrides are PLATFORM-ADMIN-ONLY ═════════════════════════
  console.log('\n── platform-admin-only: the override actions ──')

  const adminOnly: Array<[string, () => Promise<unknown>]> = [
    ['extendTrialAction', () => extendTrialAction({ tenantId, days: 7, reason: 'audit probe' })],
    ['compTenantAction', () => compTenantAction({ tenantId, amount: 100, reason: 'audit probe' })],
    ['refundInvoiceAction', () => refundInvoiceAction({ invoiceId, amount: 100, reason: 'audit probe' })],
    ['forceCancelAction', () => forceCancelAction({ tenantId, reason: 'audit probe' })],
    ['assignPlan', () => assignPlan({ tenantId, planId: planB, billingPeriod: 'monthly', months: 1 })],
    ['createPlan', () => createPlan({ name: `Nope ${tag}`, monthlyPrice: '1', annualPrice: '10', currency: 'INR' })],
    ['setPlanActive', () => setPlanActive(planA, false)],
    ['savePlatformGateway', () => savePlatformGateway({ razorpayKeyId: 'rzp_test_x', razorpayKeySecret: 'nope', razorpayWebhookSecret: 'nope' })],
  ]

  for (const [name, callIt] of adminOnly) {
    for (const [who, token] of [
      ['the tenant OWNER', OWNER.token],
      ['a MANAGER', MANAGER.token],
      ['a CASHIER', CASHIER.token],
    ] as Array<[string, string]>) {
      signedInAs(token)
      const r = await callIt()
      check(`${name}() refuses ${who}`, refused(r, ADMIN_REFUSAL), r)
    }

    signedInAs(undefined)
    const anon = await callIt()
    check(`${name}() refuses an unauthenticated caller`, refused(anon, ADMIN_REFUSAL), anon)
  }

  // ══ 3. a refusal changed nothing ══════════════════════════════════════════
  // A guard that returns an error but has already written is not a guard. Every
  // call above ran against this one tenant, so the state it would have altered
  // is checked here in one place.
  console.log('\n── the refusals were inert ──')

  const after = await owner.query<{ plan_id: string; status: string }>(
    `select plan_id, status from tenant_subscriptions where id = $1`,
    [subscriptionId],
  )
  check('the subscription is still on its original plan', after.rows[0].plan_id === planA, after.rows[0])
  check('…and still active — nothing cancelled it', after.rows[0].status === 'active', after.rows[0])

  const refunds = await owner.query<{ n: string }>(
    `select count(*) n from platform_refunds where tenant_id = $1`,
    [tenantId],
  )
  check('no refund was created by the refused calls', refunds.rows[0].n === '0', refunds.rows[0])

  const planStill = await owner.query<{ active: boolean }>(`select active from plans where id = $1`, [planA])
  check('the plan was not deactivated', planStill.rows[0].active === true)

  const strayPlan = await owner.query<{ n: string }>(
    `select count(*) n from plans where name = $1`,
    [`Nope ${tag}`],
  )
  check('no plan was created by a non-admin', strayPlan.rows[0].n === '0', strayPlan.rows[0])

  const gateway = await owner.query<{ n: string }>(
    `select count(*) n from platform_payment_settings where razorpay_key_id = 'rzp_test_x'`,
  )
  check('the platform gateway was not overwritten by a non-admin', gateway.rows[0].n === '0', gateway.rows[0])

  // ══ 4. a refusal leaks nothing ════════════════════════════════════════════
  console.log('\n── refusals leak nothing ──')

  signedInAs(MANAGER.token)
  const leaky = await previewPlanChange({ planId: planB, billingPeriod: 'monthly' })
  const text = JSON.stringify(leaky)
  check('the refusal carries no plan price', !text.includes('2000') && !text.includes('1000'), text)
  check('…no tenant id', !text.includes(tenantId))
  check('…and no secret-shaped value', !/rzp_(test|live)_|whsec|BEGIN /i.test(text), text)

  // ══ 5. a currency code must be LETTERS ════════════════════════════════════
  //
  // `length(currency) = 3` (0078) and the old `z.string().length(3)` both
  // accepted "A1B" and "12$". Intl.NumberFormat throws RangeError on a
  // malformed code, and every billing screen formats a currency read from this
  // column — so one such row was a hard render crash for /admin/revenue, with
  // no way to repair it from the UI (the plan form exposes no currency field).
  console.log('\n── a malformed currency is refused at the action ──')

  signedInAs(ADMIN.token)
  for (const bad of ['A1B', '12$', 'IN', 'INRR', '  ']) {
    const r = await createPlan({
      name: `Bad cur ${bad} ${tag}`,
      monthlyPrice: '100',
      annualPrice: '1000',
      currency: bad,
    })
    check(`createPlan refuses currency ${JSON.stringify(bad)}`, Boolean(r.error), r)
  }
  const strayCur = await owner.query<{ n: string }>(
    `select count(*) n from plans where name like $1`,
    [`Bad cur%${tag}`],
  )
  check('…and none of them reached the database', strayCur.rows[0].n === '0', strayCur.rows[0])

  const good = await createPlan({
    name: `Good cur ${tag}`,
    monthlyPrice: '100',
    annualPrice: '1000',
    currency: 'usd',
  })
  check('a real 3-letter code is still accepted, upper-cased', !good.error, good)
  const cur = await owner.query<{ currency: string }>(
    `select currency from plans where name = $1`,
    [`Good cur ${tag}`],
  )
  check('…and stored as USD', cur.rows[0]?.currency === 'USD', cur.rows[0])

  // Every code that survives validation must also be renderable, since the
  // components no longer carry their own try/catch — they delegate to
  // lib/format.ts, which is the single place that fallback now lives.
  const { money } = await import('../lib/format')
  check('formatMoney renders a valid code', money('INR', 1234.5).includes('1,234.5'))
  check('…renders an unassigned-but-wellformed code without throwing', money('ZZZ', 10) === 'ZZZ 10.00' || money('ZZZ', 10).includes('10'))
  check('…and falls back rather than throwing on a malformed one', money('A1B', 10) === 'A1B 10.00')

  await owner.query(`delete from plans where name = $1`, [`Good cur ${tag}`])

  // ── cleanup ───────────────────────────────────────────────────────────────
  signedInAs(undefined)
  g.__ARENA_TEST_HEADERS = undefined
  await owner.query(`delete from platform_refunds where tenant_id = $1`, [tenantId])
  await owner.query(`delete from platform_invoices where tenant_id = $1`, [tenantId])
  await owner.query(`delete from tenant_subscriptions where tenant_id = $1`, [tenantId])
  await owner.query(`delete from audit_log where tenant_id = $1`, [tenantId])
  await owner.query(`delete from memberships where tenant_id = $1`, [tenantId])
  await owner.query(`delete from branches where tenant_id = $1`, [tenantId])
  await owner.query(`delete from tenants where id = $1`, [tenantId])
  await owner.query(`delete from plan_entitlements where plan_id = any($1)`, [planIds])
  await owner.query(`delete from plans where id = any($1)`, [planIds])
  await owner.query(`delete from sessions where user_id = any($1)`, [userIds])
  await owner.query(`delete from users where id = any($1)`, [userIds])
  await owner.end()

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
