/**
 * M16 #6 — self-serve signup & onboarding, end to end against a real database.
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs scripts/test-signup.ts
 *
 * ── What is real and what is faked ──────────────────────────────────────────
 *
 * REAL: the database, every migration, RLS, the shared provisioning transaction
 * (provisionTenant — the SAME one createCompany uses), the trial subscription
 * writer, the actual selfServeSignup() orchestration, the real
 * subscribeTenantToPlan() decision logic, the real webhook route handler driven
 * with real NextRequest objects and real HMAC-SHA256 signatures, the real
 * onboarding reader, and the real slug rules.
 *
 * FAKED: only the HTTP calls to Razorpay, through the injectable seams
 * lib/platform/billing/subscribe.ts already exposes for exactly this. Nothing
 * about the signature check, the state machine or the idempotency is stubbed —
 * stubbing those would prove nothing.
 *
 * No secret is ever printed.
 */
import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { loadEnv } from './env'

loadEnv()

let pass = 0,
  fail = 0
const check = (l: string, c: boolean) => {
  console.log(`${c ? '✓' : '✗ FAIL'}  ${l}`)
  if (c) pass++
  else fail++
}
const section = (s: string) => console.log(`\n── ${s} ──`)

async function main() {
  const { NextRequest } = await import('next/server')
  const { POST } = await import('../app/api/webhooks/platform-razorpay/route')
  const { encryptSecret } = await import('../lib/security/encryption')
  const { provisionTenant } = await import('../lib/platform/provision')
  const { selfServeSignup, attachTrialSubscription, SignupError, SIGNUP_TRIAL_DAYS } =
    await import('../lib/signup/service')
  const { subscribeTenantToPlan } = await import('../lib/platform/billing/subscribe')
  const { listPublicPlans, getPublicPlan } = await import('../lib/platform/plans/public')
  const { normalizeSlug, slugProblem, suggestSlug } = await import('../lib/platform/slug')
  const { getOnboardingProgress } = await import('../lib/onboarding/checklist')
  const { readEntitlements } = await import('../lib/platform/entitlements')
  const { drizzle } = await import('drizzle-orm/node-postgres')
  const schema = await import('../db/schema')
  const { verifyPassword } = await import('../lib/auth/password')

  const owner = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })

  const PLATFORM_SECRET = `whsec_${randomBytes(16).toString('hex')}`
  const PLATFORM_KEY_SECRET = `rzpsecret_${randomBytes(12).toString('hex')}`
  /** Matches PLATFORM_AAD in lib/platform/billing/credentials.ts. */
  const PLATFORM_AAD = 'platform:razorpay'
  const sign = (rawBody: string, secret: string) =>
    createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')

  const tag = randomBytes(3).toString('hex')
  const slugFor = (s: string) => `sgn${tag}-${s}`
  const emailFor = (s: string) => `${s}.${tag}@signup.test`

  // ── fixtures ──────────────────────────────────────────────────────────────
  await owner.query(
    `insert into platform_payment_settings (id, razorpay_key_id, razorpay_key_secret_encrypted, razorpay_webhook_secret_encrypted)
     values (true, $1, $2, $3)
     on conflict (id) do update set razorpay_key_id = excluded.razorpay_key_id,
       razorpay_key_secret_encrypted = excluded.razorpay_key_secret_encrypted,
       razorpay_webhook_secret_encrypted = excluded.razorpay_webhook_secret_encrypted`,
    // The platform credentials are bound to a fixed AAD (PLATFORM_AAD in
    // lib/platform/billing/credentials.ts). Encrypting without it produces
    // ciphertext the real loader refuses — which is the point of the binding.
    [`rzp_test_${tag}`, encryptSecret(PLATFORM_KEY_SECRET, PLATFORM_AAD), encryptSecret(PLATFORM_SECRET, PLATFORM_AAD)],
  )

  const gwMonthly = `plan_sgn_m_${tag}`
  const paidPlan = await owner.query<{ id: string }>(
    `insert into plans (name, monthly_price, annual_price, currency, active, gateway, gateway_monthly_plan_id)
     values ($1,'1500.00','15000.00','INR',true,'razorpay',$2) returning id`,
    [`Signup Pro ${tag}`, gwMonthly],
  )
  const paidPlanId = paidPlan.rows[0].id
  await owner.query(
    `insert into plan_entitlements (plan_id, key, value) values
       ($1,'max_branches','3'::jsonb), ($1,'module.kitchen','true'::jsonb)`,
    [paidPlanId],
  )

  const freePlan = await owner.query<{ id: string }>(
    `insert into plans (name, monthly_price, annual_price, currency, active)
     values ($1,'0.00','0.00','INR',true) returning id`,
    [`Signup Free ${tag}`],
  )
  const freePlanId = freePlan.rows[0].id

  const retiredPlan = await owner.query<{ id: string }>(
    `insert into plans (name, monthly_price, annual_price, currency, active)
     values ($1,'900.00','9000.00','INR',false) returning id`,
    [`Signup Retired ${tag}`],
  )
  const retiredPlanId = retiredPlan.rows[0].id

  const createdTenants: string[] = []
  const createdUsers: string[] = []

  /** The Razorpay seam, faked. Records what it was asked for. */
  const calls = { plans: [] as string[], customers: 0, subscriptions: [] as string[] }
  const gateway = {
    fetchPlan: async (_c: unknown, planId: string) => {
      calls.plans.push(planId)
      return { id: planId, item: { amount: 150000, currency: 'INR' }, period: 'monthly' }
    },
    createCustomer: async () => {
      calls.customers++
      return { id: `cust_${randomBytes(6).toString('hex')}` }
    },
    createSubscription: async (_c: unknown, p: { planId: string }) => {
      calls.subscriptions.push(p.planId)
      const id = `sub_${randomBytes(8).toString('hex')}`
      return { id, short_url: `https://rzp.io/i/${id}`, status: 'created' }
    },
    cancelSubscription: async () => ({ id: 'x', status: 'cancelled' }),
    credentials: async () => ({
      keyId: `rzp_test_${tag}`,
      keySecret: PLATFORM_KEY_SECRET,
      webhookSecret: PLATFORM_SECRET,
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any

  // ══ 1. slug rules (pure) ═════════════════════════════════════════════════
  section('slug rules')

  check('normalize lowercases and hyphenates whitespace', normalizeSlug('  My Venue  ') === 'my-venue')
  check('a valid slug has no problem', slugProblem('neon-arena') === null)
  check('too short is rejected', slugProblem('ab') === 'shape')
  check('uppercase is rejected (normalize first)', slugProblem('Neon') === 'shape')
  check('underscores are rejected', slugProblem('neon_arena') === 'shape')
  check('a leading hyphen is rejected', slugProblem('-neon') === 'shape')
  check('a trailing hyphen is rejected', slugProblem('neon-') === 'shape')
  check('reserved subdomains are rejected', slugProblem('admin') === 'reserved')
  check('…including www', slugProblem('www') === 'reserved')
  check('empty is rejected', slugProblem('') === 'empty')
  check('a 51-char slug is rejected', slugProblem('a'.repeat(51)) === 'shape')
  check('a 50-char slug is accepted', slugProblem('a'.repeat(50)) === null)
  check("suggestSlug strips accents and punctuation", suggestSlug("Joe's Gaming Café") === 'joe-s-gaming-cafe')

  // ══ 2. the public catalogue ══════════════════════════════════════════════
  section('plan catalogue (anonymous, RLS-scoped)')

  const publicPlans = await listPublicPlans()
  check('an active plan is visible to an anonymous reader', publicPlans.some((p) => p.id === paidPlanId))
  check('a RETIRED plan is NOT', !publicPlans.some((p) => p.id === retiredPlanId))
  check('getPublicPlan returns null for a retired plan', (await getPublicPlan(retiredPlanId)) === null)
  const listed = publicPlans.find((p) => p.id === paidPlanId)
  check('prices come through as strings, never floats', typeof listed?.monthlyPrice === 'string')
  check('entitlements are exposed for display', listed?.entitlements['max_branches'] === 3)
  check(
    'the gateway plan reference is NEVER in the public payload',
    listed !== undefined && !('gatewayMonthlyPlanId' in listed) && !JSON.stringify(listed).includes(gwMonthly),
  )

  // ══ 3. trial signup ══════════════════════════════════════════════════════
  section('trial signup')

  const trialSlug = slugFor('trial')
  const trialEmail = emailFor('trialowner')
  const trial = await selfServeSignup({
    companyName: 'Trial Venue',
    slug: trialSlug,
    industry: 'gaming_cafe',
    currency: 'INR',
    timezone: 'Asia/Kolkata',
    ownerName: 'Trial Owner',
    ownerEmail: trialEmail,
    ownerPassword: 'trialpass123',
    planId: paidPlanId,
    billingPeriod: 'monthly',
    intent: 'trial',
  })
  createdTenants.push(trial.tenantId)
  check('trial signup provisions', trial.provisioned === true)
  check('…and reports no plan error', trial.planError === undefined)
  check('…and returns no checkout URL', trial.checkoutUrl === undefined)

  const tRow = await owner.query<{ slug: string; status: string; name: string }>(
    'select slug, status, name from tenants where id=$1',
    [trial.tenantId],
  )
  check('the tenant exists', tRow.rowCount === 1)
  check('…with the chosen slug', tRow.rows[0].slug === trialSlug)
  check("…and account status 'trial' — nobody has paid", tRow.rows[0].status === 'trial')

  const brRow = await owner.query('select id, name, is_primary from branches where tenant_id=$1', [
    trial.tenantId,
  ])
  check('a Main Branch was created', brRow.rowCount === 1)
  check('…and it is primary', brRow.rows[0].is_primary === true)

  const mRow = await owner.query<{ role: string; status: string; user_id: string; email: string }>(
    'select role, status, user_id, email from memberships where tenant_id=$1',
    [trial.tenantId],
  )
  check('exactly one membership was created', mRow.rowCount === 1)
  check("…with role 'owner' — assigned by the SERVER", mRow.rows[0].role === 'owner')
  check('…active', mRow.rows[0].status === 'active')
  check('…and the owner email', mRow.rows[0].email === trialEmail)
  createdUsers.push(mRow.rows[0].user_id)

  const catRow = await owner.query('select 1 from expense_categories where tenant_id=$1', [
    trial.tenantId,
  ])
  check('starter expense categories were seeded', (catRow.rowCount ?? 0) > 0)

  const subRow = await owner.query<{
    status: string
    plan_id: string
    gateway: string | null
    gateway_subscription_id: string | null
    current_period_end: Date
  }>(
    'select status, plan_id, gateway, gateway_subscription_id, current_period_end from tenant_subscriptions where tenant_id=$1',
    [trial.tenantId],
  )
  check('a subscription was attached', subRow.rowCount === 1)
  check("…in 'trialing'", subRow.rows[0].status === 'trialing')
  check('…on the chosen plan', subRow.rows[0].plan_id === paidPlanId)
  check('…with NO gateway object (a trial is not a mandate)', subRow.rows[0].gateway === null)
  check('…and no gateway subscription id', subRow.rows[0].gateway_subscription_id === null)
  const days = Math.round(
    (subRow.rows[0].current_period_end.getTime() - Date.now()) / (24 * 60 * 60 * 1000),
  )
  check(`…running ${SIGNUP_TRIAL_DAYS} days`, days === SIGNUP_TRIAL_DAYS)

  // The owner can actually sign in — the existing staff auth, unmodified.
  const uRow = await owner.query<{ password_hash: string }>(
    'select password_hash from users where id=$1',
    [mRow.rows[0].user_id],
  )
  check('the owner password verifies against the existing hasher',
    await verifyPassword(uRow.rows[0].password_hash, 'trialpass123'))
  check('…and a wrong password does not',
    !(await verifyPassword(uRow.rows[0].password_hash, 'wrongpass123')))

  // Entitlements resolve from the plan the trial is on.
  // readEntitlements takes an already-scoped transaction; the owner handle is
  // what the platform readers use elsewhere.
  const ownerDrizzle = drizzle(owner, { schema })
  const ent = await readEntitlements(ownerDrizzle, trial.tenantId)
  check('entitlements resolve for a trialing subscription', ent.entitlements['max_branches'] === 3)
  check('…and report the trialing status', ent.status === 'trialing')

  // ══ 4. invalid input ═════════════════════════════════════════════════════
  section('invalid input')

  const badSlug = async (slug: string) => {
    try {
      await selfServeSignup({
        companyName: 'X', slug, industry: 'other', currency: 'INR', timezone: 'Asia/Kolkata',
        ownerName: 'X', ownerEmail: emailFor(`x${Math.random()}`), ownerPassword: 'password123',
        planId: paidPlanId, billingPeriod: 'monthly', intent: 'trial',
      })
      return null
    } catch (e) {
      return e
    }
  }
  const shapeErr = await badSlug('no')
  check('an invalid slug is refused', shapeErr instanceof SignupError)
  check('…as a slug field error', (shapeErr as InstanceType<typeof SignupError>).field === 'slug')
  const reservedErr = await badSlug('admin')
  check('a reserved slug is refused', reservedErr instanceof SignupError)

  let retiredErr: unknown = null
  try {
    await selfServeSignup({
      companyName: 'X', slug: slugFor('retired'), industry: 'other', currency: 'INR',
      timezone: 'Asia/Kolkata', ownerName: 'X', ownerEmail: emailFor('retired'),
      ownerPassword: 'password123', planId: retiredPlanId, billingPeriod: 'monthly', intent: 'trial',
    })
  } catch (e) {
    retiredErr = e
  }
  check('a RETIRED plan is refused', retiredErr instanceof SignupError)
  check('…as a plan field error', (retiredErr as InstanceType<typeof SignupError>).field === 'planId')
  const retiredTenant = await owner.query('select 1 from tenants where slug=$1', [slugFor('retired')])
  check('…and NO tenant was provisioned for it', retiredTenant.rowCount === 0)

  let fakePlanErr: unknown = null
  try {
    await selfServeSignup({
      companyName: 'X', slug: slugFor('fakeplan'), industry: 'other', currency: 'INR',
      timezone: 'Asia/Kolkata', ownerName: 'X', ownerEmail: emailFor('fakeplan'),
      ownerPassword: 'password123', planId: randomUUID(), billingPeriod: 'monthly', intent: 'trial',
    })
  } catch (e) {
    fakePlanErr = e
  }
  check('a fabricated plan id is refused the same way', fakePlanErr instanceof SignupError)

  let zeroPaidErr: unknown = null
  try {
    await selfServeSignup({
      companyName: 'X', slug: slugFor('zero'), industry: 'other', currency: 'INR',
      timezone: 'Asia/Kolkata', ownerName: 'X', ownerEmail: emailFor('zero'),
      ownerPassword: 'password123', planId: freePlanId, billingPeriod: 'monthly', intent: 'paid',
    })
  } catch (e) {
    zeroPaidErr = e
  }
  check('a zero-priced plan cannot be PAID for', zeroPaidErr instanceof SignupError)

  // ══ 5. duplicate & concurrent slugs ══════════════════════════════════════
  section('duplicate & concurrent slugs')

  let dupErr: unknown = null
  try {
    await selfServeSignup({
      companyName: 'Copycat', slug: trialSlug, industry: 'other', currency: 'INR',
      timezone: 'Asia/Kolkata', ownerName: 'Other', ownerEmail: emailFor('copycat'),
      ownerPassword: 'password123', planId: paidPlanId, billingPeriod: 'monthly', intent: 'trial',
    })
  } catch (e) {
    dupErr = e
  }
  check('a duplicate slug is refused', dupErr instanceof SignupError)
  check('…as a slug field error', (dupErr as InstanceType<typeof SignupError>).field === 'slug')
  const stillOne = await owner.query('select 1 from tenants where slug=$1', [trialSlug])
  check('…and there is still exactly one tenant on that slug', stillOne.rowCount === 1)

  // THE race. Both start together; the unique index decides, not a prior check.
  const raceSlug = slugFor('race')
  const attempt = (n: number) =>
    selfServeSignup({
      companyName: `Race ${n}`, slug: raceSlug, industry: 'other', currency: 'INR',
      timezone: 'Asia/Kolkata', ownerName: `Racer ${n}`, ownerEmail: emailFor(`race${n}`),
      ownerPassword: 'password123', planId: paidPlanId, billingPeriod: 'monthly', intent: 'trial',
    }).then(
      (r) => ({ ok: true as const, r }),
      (e) => ({ ok: false as const, e }),
    )
  const raced = await Promise.all([attempt(1), attempt(2), attempt(3)])
  const winners = raced.filter((x) => x.ok)
  check('exactly ONE of three concurrent signups wins', winners.length === 1)
  check(
    '…and the losers get a slug field error, not a crash',
    raced.filter((x) => !x.ok).every((x) => (x as { e: unknown }).e instanceof SignupError),
  )
  const raceRows = await owner.query('select id from tenants where slug=$1', [raceSlug])
  check('…and the database holds exactly one tenant for that slug', raceRows.rowCount === 1)
  if (winners.length === 1) createdTenants.push((winners[0] as { r: { tenantId: string } }).r.tenantId)

  // ══ 6. paid signup ═══════════════════════════════════════════════════════
  section('paid signup (platform Razorpay Subscriptions)')

  const paidSlug = slugFor('paid')
  const paidEmail = emailFor('paidowner')
  // selfServeSignup() calls the real subscribeTenantToPlan() with the DEFAULT
  // gateway, which would reach the network — so the paid path is driven here in
  // its two real halves: provision (shared) then subscribe (injected seam).
  const paidProvisioned = await provisionTenant({
    companyName: 'Paid Venue',
    slug: paidSlug,
    industry: 'vr_centre',
    currency: 'INR',
    timezone: 'Asia/Kolkata',
    ownerEmail: paidEmail,
    ownerName: 'Paid Owner',
    ownerPassword: 'paidpass123',
    status: 'trial',
  })
  createdTenants.push(paidProvisioned.tenantId)

  const paidSub = await subscribeTenantToPlan(
    { tenantId: paidProvisioned.tenantId, planId: paidPlanId, billingPeriod: 'monthly' },
    gateway,
  )
  check('a Razorpay subscription was created', !!paidSub.gatewaySubscriptionId)
  check('…using the PLATFORM gateway plan for the chosen period', calls.subscriptions.includes(gwMonthly))
  check('…and the gateway price was verified against the catalogue', calls.plans.includes(gwMonthly))
  check('a hosted checkout URL is returned', !!paidSub.checkoutUrl)

  const paidRow = await owner.query<{ status: string; gateway: string; gateway_subscription_id: string }>(
    'select status, gateway, gateway_subscription_id from tenant_subscriptions where tenant_id=$1',
    [paidProvisioned.tenantId],
  )
  check("the local row is 'trialing' — NOT active before payment", paidRow.rows[0].status === 'trialing')
  check('…and carries the gateway reference', paidRow.rows[0].gateway_subscription_id === paidSub.gatewaySubscriptionId)
  const paidTenant = await owner.query<{ status: string }>('select status from tenants where id=$1', [
    paidProvisioned.tenantId,
  ])
  check("the ACCOUNT is still 'trial' — a checkout is not a payment", paidTenant.rows[0].status === 'trial')

  // ══ 7. webhook confirmation & idempotency ════════════════════════════════
  section('webhook confirmation')

  const chargePayload = (subId: string, paymentId: string) =>
    JSON.stringify({
      event: 'subscription.charged',
      payload: {
        subscription: {
          entity: {
            id: subId,
            status: 'active',
            current_start: Math.floor(Date.now() / 1000),
            current_end: Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
          },
        },
        payment: { entity: { id: paymentId, amount: 150000, currency: 'INR', status: 'captured' } },
      },
    })

  const post = async (body: string, secret = PLATFORM_SECRET) =>
    POST(
      new NextRequest('http://localhost/api/webhooks/platform-razorpay', {
        method: 'POST',
        body,
        headers: { 'x-razorpay-signature': sign(body, secret), 'content-type': 'application/json' },
      }),
    )

  const paymentId = `pay_${randomBytes(8).toString('hex')}`
  const body = chargePayload(paidSub.gatewaySubscriptionId, paymentId)

  const badSig = await post(body, 'wrong-secret')
  check('an INVALID signature is rejected', badSig.status === 400 || badSig.status === 401)
  const stillTrialing = await owner.query<{ status: string }>(
    'select status from tenant_subscriptions where tenant_id=$1',
    [paidProvisioned.tenantId],
  )
  check('…and changed nothing', stillTrialing.rows[0].status === 'trialing')

  const first = await post(body)
  check('a VERIFIED charge webhook is accepted', first.status === 200)
  const afterCharge = await owner.query<{ status: string }>(
    'select status from tenant_subscriptions where tenant_id=$1',
    [paidProvisioned.tenantId],
  )
  check("…and promotes the subscription to 'active'", afterCharge.rows[0].status === 'active')
  const afterTenant = await owner.query<{ status: string }>('select status from tenants where id=$1', [
    paidProvisioned.tenantId,
  ])
  check("…and the ACCOUNT to 'active'", afterTenant.rows[0].status === 'active')

  const subsBefore = await owner.query('select id from tenant_subscriptions where tenant_id=$1', [
    paidProvisioned.tenantId,
  ])
  const second = await post(body)
  check('a DUPLICATE delivery is accepted (Razorpay must not retry forever)', second.status === 200)
  const subsAfter = await owner.query('select id from tenant_subscriptions where tenant_id=$1', [
    paidProvisioned.tenantId,
  ])
  check('…and creates NO second subscription', subsAfter.rowCount === subsBefore.rowCount)
  const invCount = await owner.query(
    'select count(*)::int as n from platform_invoices where tenant_id=$1',
    [paidProvisioned.tenantId],
  )
  check('…and NO second invoice', invCount.rows[0].n <= 1)

  // ══ 8. retries do not duplicate ══════════════════════════════════════════
  section('retry safety')

  const before = await owner.query<{ n: number }>(
    'select count(*)::int as n from memberships where tenant_id=$1',
    [trial.tenantId],
  )
  let retryTrialErr: unknown = null
  try {
    await attachTrialSubscription({
      tenantId: trial.tenantId,
      planId: paidPlanId,
      billingPeriod: 'monthly',
    })
  } catch (e) {
    retryTrialErr = e
  }
  check('re-attaching a plan to a tenant that has one is refused', retryTrialErr instanceof SignupError)
  const subsNow = await owner.query('select id from tenant_subscriptions where tenant_id=$1', [
    trial.tenantId,
  ])
  check('…so there is still exactly ONE subscription', subsNow.rowCount === 1)
  const after = await owner.query<{ n: number }>(
    'select count(*)::int as n from memberships where tenant_id=$1',
    [trial.tenantId],
  )
  check('…and still exactly one membership', after.rows[0].n === before.rows[0].n)

  // An existing email reused for a NEW workspace must reuse the user, not
  // create a second — and must not touch the first workspace.
  const reuseSlug = slugFor('reuse')
  const reuse = await selfServeSignup({
    companyName: 'Second Venue', slug: reuseSlug, industry: 'other', currency: 'INR',
    timezone: 'Asia/Kolkata', ownerName: 'Trial Owner', ownerEmail: trialEmail,
    ownerPassword: 'ignored-because-user-exists', planId: paidPlanId,
    billingPeriod: 'monthly', intent: 'trial',
  })
  createdTenants.push(reuse.tenantId)
  const userCount = await owner.query<{ n: number }>(
    'select count(*)::int as n from users where email=$1',
    [trialEmail],
  )
  check('an existing email creates NO second user', userCount.rows[0].n === 1)
  const bothMemberships = await owner.query<{ n: number }>(
    'select count(*)::int as n from memberships where user_id=$1',
    [mRow.rows[0].user_id],
  )
  check('…it becomes owner of both workspaces', bothMemberships.rows[0].n === 2)
  const pwUnchanged = await owner.query<{ password_hash: string }>(
    'select password_hash from users where id=$1',
    [mRow.rows[0].user_id],
  )
  check(
    '…and the ORIGINAL password still works (signup cannot reset it)',
    await verifyPassword(pwUnchanged.rows[0].password_hash, 'trialpass123'),
  )

  // ══ 9. tenant isolation ══════════════════════════════════════════════════
  section('tenant isolation')

  const app = new Pool({ connectionString: process.env.DATABASE_URL })
  const aUser = mRow.rows[0].user_id
  const paidMember = await owner.query<{ user_id: string }>(
    'select user_id from memberships where tenant_id=$1',
    [paidProvisioned.tenantId],
  )
  const bUser = paidMember.rows[0].user_id

  const asUser = async (userId: string, sql: string, params: unknown[] = []) => {
    const c = await app.connect()
    try {
      await c.query('begin')
      await c.query('select set_config($1,$2,true)', ['app.user_id', userId])
      const r = await c.query(sql, params)
      await c.query('commit')
      return r
    } finally {
      c.release()
    }
  }

  const aSeesOwn = await asUser(aUser, 'select id from tenants where id=$1', [trial.tenantId])
  check('an owner can read their own tenant', aSeesOwn.rowCount === 1)
  const aSeesB = await asUser(aUser, 'select id from tenants where id=$1', [paidProvisioned.tenantId])
  check("…and CANNOT read another signup's tenant", aSeesB.rowCount === 0)
  const bSeesA = await asUser(bUser, 'select id from tenants where id=$1', [trial.tenantId])
  check('…nor the other way round', bSeesA.rowCount === 0)

  const aSeesBSubs = await asUser(
    aUser,
    'select id from tenant_subscriptions where tenant_id=$1',
    [paidProvisioned.tenantId],
  )
  check("a tenant cannot read another's subscription", aSeesBSubs.rowCount === 0)

  const writeAttempt = await asUser(
    aUser,
    `update tenant_subscriptions set status='active' where tenant_id=$1 returning id`,
    [trial.tenantId],
  ).catch(() => ({ rowCount: -1 }))
  check(
    'no tenant may write its OWN subscription (no policy, no grant)',
    writeAttempt.rowCount === 0 || writeAttempt.rowCount === -1,
  )

  const platformSettings = await asUser(aUser, 'select 1 from platform_payment_settings').catch(
    () => ({ rowCount: -1 }),
  )
  check('the app role cannot read platform gateway credentials', platformSettings.rowCount === -1)

  // ══ 10. onboarding checklist ═════════════════════════════════════════════
  section('onboarding checklist')

  const ctxFor = (tenantId: string, userId: string, role: string) =>
    ({
      user: { id: userId, email: 'x@x.test' },
      tenant: { id: tenantId, slug: 'x', name: 'x', status: 'trial', industry: 'other', currency: 'INR', timezone: 'Asia/Kolkata' },
      role,
      membershipId: randomUUID(),
      branchId: null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any

  const fresh = await getOnboardingProgress(ctxFor(trial.tenantId, aUser, 'owner'))
  check('a brand-new workspace gets a checklist', fresh.steps.length > 0)
  check('…with nothing complete yet', fresh.completed === 0)
  check('…so it is not all done', fresh.allDone === false)
  check('…and every step points at a real settings route',
    fresh.steps.every((s) => s.href.startsWith('/')))

  // Do one step for real, and watch it tick.
  const rt = await owner.query<{ id: string }>(
    `insert into resource_types (tenant_id, name, hourly_rate) values ($1,'Bay','100') returning id`,
    [trial.tenantId],
  )
  await owner.query(
    `insert into resources (tenant_id, branch_id, resource_type_id, name) values ($1,$2,$3,'Bay 1')`,
    [trial.tenantId, brRow.rows[0].id, rt.rows[0].id],
  )
  const afterResource = await getOnboardingProgress(ctxFor(trial.tenantId, aUser, 'owner'))
  check('adding a resource ticks the resources step',
    afterResource.steps.find((s) => s.key === 'resources')?.done === true)
  check('…and the completed count moves', afterResource.completed === fresh.completed + 1)

  const cashierView = await getOnboardingProgress(ctxFor(trial.tenantId, aUser, 'cashier'))
  check('a cashier is shown no setup tasks', cashierView.steps.length === 0)
  const ownerOnlyStep = afterResource.steps.find((s) => s.key === 'business-profile')
  check('the owner sees the owner-only business profile step', !!ownerOnlyStep)

  // ══ 11. admin provisioning still works ═══════════════════════════════════
  section('admin createCompany still works (regression)')

  const adminSlug = slugFor('admin')
  const adminProvisioned = await provisionTenant({
    companyName: 'Admin Made', slug: adminSlug, industry: 'dance_studio',
    currency: 'INR', timezone: 'Asia/Kolkata',
    ownerEmail: emailFor('adminowner'), ownerName: 'Admin Owner', ownerPassword: 'adminpass123',
  })
  createdTenants.push(adminProvisioned.tenantId)
  const adminTenant = await owner.query<{ status: string }>('select status from tenants where id=$1', [
    adminProvisioned.tenantId,
  ])
  check("an admin-provisioned tenant defaults to 'active' as before", adminTenant.rows[0].status === 'active')
  const adminBranch = await owner.query('select 1 from branches where tenant_id=$1 and is_primary', [
    adminProvisioned.tenantId,
  ])
  check('…gets a primary Main Branch', adminBranch.rowCount === 1)
  const adminOwner = await owner.query<{ role: string }>(
    'select role from memberships where tenant_id=$1',
    [adminProvisioned.tenantId],
  )
  check('…gets an owner membership', adminOwner.rows[0].role === 'owner')
  const adminCats = await owner.query('select 1 from expense_categories where tenant_id=$1', [
    adminProvisioned.tenantId,
  ])
  check('…and the same starter expense categories', (adminCats.rowCount ?? 0) > 0)

  // The whole point of the extraction: both paths produce identical base setup.
  const shape = async (tenantId: string) => {
    const b = await owner.query<{ n: number }>(
      'select count(*)::int as n from branches where tenant_id=$1',
      [tenantId],
    )
    const m = await owner.query<{ n: number }>(
      "select count(*)::int as n from memberships where tenant_id=$1 and role='owner'",
      [tenantId],
    )
    const c = await owner.query<{ n: number }>(
      'select count(*)::int as n from expense_categories where tenant_id=$1',
      [tenantId],
    )
    return `${b.rows[0].n}/${m.rows[0].n}/${c.rows[0].n}`
  }
  check(
    'a self-serve tenant and an admin tenant have the SAME base setup',
    (await shape(reuse.tenantId)) === (await shape(adminProvisioned.tenantId)),
  )

  // ── cleanup ───────────────────────────────────────────────────────────────
  await app.end()
  for (const id of createdTenants) {
    await owner.query('delete from tenants where id=$1', [id]).catch(() => {})
  }
  await owner.query('delete from users where email like $1', [`%.${tag}@signup.test`]).catch(() => {})
  await owner.query('delete from plans where id = any($1)', [
    [paidPlanId, freePlanId, retiredPlanId],
  ]).catch(() => {})

  console.log(`\n${pass} passed, ${fail} failed`)
  await owner.end()
  if (fail > 0) process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
