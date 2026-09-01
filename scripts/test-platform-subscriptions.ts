/**
 * M16 #3 — platform subscription billing on Razorpay Subscriptions, end to end
 * against a real database.
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs scripts/test-platform-subscriptions.ts
 *
 * ── What is real and what is faked ──────────────────────────────────────────
 *
 * REAL: the database, the migration, every RLS policy and grant, the
 * AES-256-GCM encryption of the platform credentials, the HMAC-SHA256 webhook
 * signatures (computed with Razorpay's documented scheme), the actual route
 * handler in app/api/webhooks/platform-razorpay/route.ts driven with real
 * NextRequest objects, and the actual subscribeTenantToPlan() /
 * cancelTenantSubscription() / applySubscriptionState() code paths.
 *
 * FAKED: only the four HTTP calls to Razorpay, through the injectable seams
 * those modules expose. A test that stubbed the signature check, or reimplemented
 * the state machine, would prove nothing — so neither is stubbed.
 *
 * No secret is ever printed.
 */
import { createHmac, randomBytes } from 'node:crypto'
import { Pool } from 'pg'
import { loadEnv } from './env'

let pass = 0,
  fail = 0
const check = (l: string, c: boolean) => {
  console.log(`${c ? '✓' : '✗ FAIL'}  ${l}`)
  if (c) pass++
  else fail++
}
const section = (s: string) => console.log(`\n── ${s} ──`)

async function main() {
  loadEnv()
  const { NextRequest } = await import('next/server')
  const { POST } = await import('../app/api/webhooks/platform-razorpay/route')
  const { encryptSecret, decryptSecret } = await import('../lib/security/encryption')
  const { subscribeTenantToPlan, SubscriptionError } = await import(
    '../lib/platform/billing/subscribe'
  )
  const { cancelTenantSubscription } = await import('../lib/platform/billing/cancel')
  const { mapRazorpayStatus } = await import('../lib/platform/billing/lifecycle')
  const { readEntitlements } = await import('../lib/platform/entitlements')
  // For the regression below: the two readers that inherited the wrong period.
  const { lastPaidInvoiceFor } = await import('../lib/platform/billing/invoices')
  const { computeProrationCredit } = await import('../lib/platform/billing/proration')
  const { drizzle } = await import('drizzle-orm/node-postgres')
  const schema = await import('../db/schema')

  const ownerPool = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })
  const ownerDb = drizzle(ownerPool, { schema })

  // The PLATFORM webhook secret. Never printed.
  const PLATFORM_SECRET = `whsec_${randomBytes(16).toString('hex')}`
  const PLATFORM_KEY_SECRET = `rzpsecret_${randomBytes(12).toString('hex')}`
  // A TENANT's own secret, kept around purely to prove it can never be used here.
  const TENANT_SECRET = `whsec_${randomBytes(16).toString('hex')}`

  /** Razorpay's documented scheme: hex HMAC-SHA256 over the RAW body. */
  const sign = (rawBody: string, secret: string) =>
    createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')

  const ROOT = (process.env.NEXT_PUBLIC_ROOT_DOMAIN ?? 'lvh.me:3000').split(':')[0]

  // ── fake gateway ──────────────────────────────────────────────────────────
  // Records what it was ASKED for, which is the interesting half: the tests
  // below assert on the plan id and credentials the server chose, not just on
  // the row that came out the other end.
  type Call = { fn: string; args: unknown }
  const calls: Call[] = []
  let subSeq = 0

  const gatewayPlanPrices = new Map<string, { amount: number; currency: string; period: string }>()

  const fakeGateway = (over: Record<string, unknown> = {}) => ({
    credentials: async () => ({ keyId: 'rzp_test_platform', keySecret: PLATFORM_KEY_SECRET }),
    fetchPlan: async (creds: { keyId: string; keySecret: string }, planId: string) => {
      calls.push({ fn: 'fetchPlan', args: { planId, keyId: creds.keyId } })
      const p = gatewayPlanPrices.get(planId)
      if (!p) throw new Error(`no fake gateway plan ${planId}`)
      return { id: planId, period: p.period, interval: 1, item: { amount: p.amount, currency: p.currency } }
    },
    createCustomer: async (creds: { keyId: string }, params: { name: string; email: string }) => {
      calls.push({ fn: 'createCustomer', args: { ...params, keyId: creds.keyId } })
      return { id: `cust_FAKE${String(++subSeq).padStart(8, '0')}`, email: params.email }
    },
    createSubscription: async (
      creds: { keyId: string; keySecret: string },
      params: { planId: string; customerId: string; totalCount: number },
    ) => {
      calls.push({ fn: 'createSubscription', args: { ...params, keyId: creds.keyId, keySecret: creds.keySecret } })
      return {
        id: `sub_FAKE${String(++subSeq).padStart(8, '0')}`,
        plan_id: params.planId,
        customer_id: params.customerId,
        status: 'created',
        current_start: null,
        current_end: null,
        charge_at: null,
        short_url: `https://rzp.io/i/fake${subSeq}`,
        paid_count: 0,
        total_count: params.totalCount,
      }
    },
    cancelSubscription: async (
      creds: { keyId: string },
      subscriptionId: string,
      atCycleEnd: boolean,
    ) => {
      calls.push({ fn: 'cancelSubscription', args: { subscriptionId, atCycleEnd, keyId: creds.keyId } })
      return {
        id: subscriptionId,
        plan_id: 'plan_x',
        customer_id: null,
        status: atCycleEnd ? 'active' : 'cancelled',
        current_start: null,
        current_end: null,
        charge_at: null,
        short_url: null,
        paid_count: 0,
        total_count: 1,
      }
    },
    ...over,
  })

  // ── fixtures ──────────────────────────────────────────────────────────────
  const created: string[] = []

  async function makeTenant(slug: string, status = 'trial') {
    const t = await ownerPool.query<{ id: string }>(
      `insert into tenants (slug,name,status,timezone) values ($1,$2,$3,'Asia/Kolkata')
       on conflict (slug) do update set name=excluded.name, status=excluded.status returning id`,
      [slug, `${slug} co`, status],
    )
    const tenantId = t.rows[0].id
    created.push(tenantId)
    await ownerPool.query(
      `insert into branches (tenant_id,name,is_primary) values ($1,'Main',true)`,
      [tenantId],
    )
    const u = await ownerPool.query<{ id: string }>(
      `insert into users (email,password_hash,full_name) values ($1,'x','Owner')
       on conflict (email) do update set full_name='Owner' returning id`,
      [`${slug}@example.test`],
    )
    await ownerPool.query(
      `insert into memberships (tenant_id,user_id,role,status,full_name,email)
       values ($1,$2,'owner','active','Owner',$3)
       on conflict (tenant_id,user_id) do nothing`,
      [tenantId, u.rows[0].id, `${slug}@example.test`],
    )
    // A TENANT-level Razorpay config, deliberately present throughout: every
    // assertion that the platform flow ignores it would be vacuous otherwise.
    await ownerPool.query(
      `insert into payment_settings (tenant_id, razorpay_key_id, razorpay_key_secret_encrypted,
                                     razorpay_webhook_secret_encrypted)
       values ($1,$2,$3,$4)
       on conflict (tenant_id) do update set razorpay_key_id = excluded.razorpay_key_id`,
      [
        tenantId,
        `rzp_test_TENANT_${slug}`,
        encryptSecret(`tenant-api-${randomBytes(6).toString('hex')}`, tenantId),
        encryptSecret(TENANT_SECRET, tenantId),
      ],
    )
    return { tenantId, slug, userId: u.rows[0].id }
  }

  const planIds: string[] = []
  async function makePlan(
    name: string,
    monthly: string,
    annual: string,
    gw: { monthly?: string; annual?: string } | null,
    active = true,
  ) {
    const r = await ownerPool.query<{ id: string }>(
      `insert into plans (name, monthly_price, annual_price, active, gateway,
                          gateway_monthly_plan_id, gateway_annual_plan_id)
       values ($1,$2,$3,$4,$5,$6,$7) returning id`,
      [name, monthly, annual, active, gw ? 'razorpay' : null, gw?.monthly ?? null, gw?.annual ?? null],
    )
    planIds.push(r.rows[0].id)
    if (gw?.monthly) {
      gatewayPlanPrices.set(gw.monthly, {
        amount: Math.round(Number(monthly) * 100),
        currency: 'INR',
        period: 'monthly',
      })
    }
    if (gw?.annual) {
      gatewayPlanPrices.set(gw.annual, {
        amount: Math.round(Number(annual) * 100),
        currency: 'INR',
        period: 'yearly',
      })
    }
    return r.rows[0].id
  }

  const tag = randomBytes(4).toString('hex')
  const gwMonthly = `plan_M${tag}`
  const gwAnnual = `plan_A${tag}`
  const gwOtherMonthly = `plan_OM${tag}`

  const A = await makeTenant('tstsubsa')
  const B = await makeTenant('tstsubsb')

  const PRO = await makePlan(`ZZ Pro ${tag}`, '7999.00', '79990.00', {
    monthly: gwMonthly,
    annual: gwAnnual,
  })
  const RETIRED = await makePlan(`ZZ Retired ${tag}`, '999.00', '9990.00', {
    monthly: gwOtherMonthly,
  }, false)
  const UNMAPPED = await makePlan(`ZZ Unmapped ${tag}`, '499.00', '4990.00', null)
  // A plan whose gateway price does NOT match the catalogue — the misconfiguration
  // that would otherwise charge a business the wrong amount.
  const MISPRICED = await makePlan(`ZZ Mispriced ${tag}`, '1000.00', '10000.00', {
    monthly: `plan_BAD${tag}`,
  })
  gatewayPlanPrices.set(`plan_BAD${tag}`, { amount: 999_00, currency: 'INR', period: 'monthly' })

  // Entitlements, so the lifecycle's effect on access can be observed.
  await ownerPool.query(
    `insert into plan_entitlements (plan_id, key, value) values ($1,'module.payroll','true'::jsonb)`,
    [PRO],
  )

  // The PLATFORM gateway config — encrypted, with the fixed platform AAD.
  await ownerPool.query(
    `insert into platform_payment_settings (id, razorpay_key_id, razorpay_key_secret_encrypted,
                                            razorpay_webhook_secret_encrypted)
     values (true,$1,$2,$3)
     on conflict (id) do update set razorpay_key_id = excluded.razorpay_key_id,
       razorpay_key_secret_encrypted = excluded.razorpay_key_secret_encrypted,
       razorpay_webhook_secret_encrypted = excluded.razorpay_webhook_secret_encrypted`,
    [
      'rzp_test_platform',
      encryptSecret(PLATFORM_KEY_SECRET, 'platform:razorpay'),
      encryptSecret(PLATFORM_SECRET, 'platform:razorpay'),
    ],
  )

  // ── helpers ───────────────────────────────────────────────────────────────
  const subRow = async (id: string) =>
    (await ownerPool.query('select * from tenant_subscriptions where id=$1', [id])).rows[0]
  const liveSub = async (tenantId: string) =>
    (
      await ownerPool.query(
        `select * from tenant_subscriptions where tenant_id=$1
          and status in ('trialing','active','past_due')
          order by current_period_start desc limit 1`,
        [tenantId],
      )
    ).rows[0]
  const tenantStatus = async (tenantId: string) =>
    (await ownerPool.query('select status from tenants where id=$1', [tenantId])).rows[0].status
  const setTenantStatus = (tenantId: string, s: string) =>
    ownerPool.query('update tenants set status=$1 where id=$2', [s, tenantId])

  /** A subscription webhook body, written by hand so the raw bytes are ours. */
  const subBody = (o: {
    event: string
    subId: string
    status: string
    currentStart?: number | null
    currentEnd?: number | null
    paymentId?: string
  }) =>
    JSON.stringify({
      entity: 'event',
      account_id: 'acc_PLATFORM',
      event: o.event,
      contains: o.paymentId ? ['subscription', 'payment'] : ['subscription'],
      payload: {
        subscription: {
          entity: {
            id: o.subId,
            entity: 'subscription',
            plan_id: gwMonthly,
            status: o.status,
            current_start: o.currentStart ?? null,
            current_end: o.currentEnd ?? null,
            // Deliberately present and deliberately LYING: the tenant named
            // here is never the one the webhook affects.
            notes: { tenant_id: B.tenantId },
          },
        },
        ...(o.paymentId
          ? {
              payment: {
                entity: { id: o.paymentId, entity: 'payment', amount: 799900, currency: 'INR', status: 'captured' },
              },
            }
          : {}),
      },
      created_at: 1755500000,
    })

  /** POST to the real route, exactly as Razorpay would. */
  async function deliver(
    rawBody: string,
    opts: { signature?: string | null; eventId?: string | null } = {},
  ) {
    const headers = new Headers({ 'content-type': 'application/json' })
    if (opts.signature !== null) headers.set('x-razorpay-signature', opts.signature ?? '')
    if (opts.eventId) headers.set('x-razorpay-event-id', opts.eventId)
    headers.set('host', ROOT)

    const req = new NextRequest(`https://${ROOT}/api/webhooks/platform-razorpay`, {
      method: 'POST',
      headers,
      body: rawBody,
    })
    const res = await POST(req)
    return { status: res.status, body: (await res.json()) as { status?: string } }
  }

  let evtSeq = 0
  const nextEvt = () => `evt_PS${tag}${String(++evtSeq).padStart(4, '0')}`

  const hour = 3600
  const nowSec = Math.floor(Date.now() / 1000)

  // ══════════════════════════════════════════════════════════════════════════
  section('1. the state mapping, in isolation')
  // ══════════════════════════════════════════════════════════════════════════
  {
    const m = (s: string) => mapRazorpayStatus(s)
    check('authenticated → trialing, account untouched', m('authenticated')?.subscription === 'trialing' && m('authenticated')?.tenant === null)
    check('active → active + tenant active', m('active')?.subscription === 'active' && m('active')?.tenant === 'active')
    check('pending → past_due, account untouched (grace)', m('pending')?.subscription === 'past_due' && m('pending')?.tenant === null)
    check('halted → expired + tenant SUSPENDED', m('halted')?.subscription === 'expired' && m('halted')?.tenant === 'suspended')
    check('paused → expired + tenant suspended', m('paused')?.subscription === 'expired' && m('paused')?.tenant === 'suspended')
    check('cancelled → cancelled + tenant cancelled', m('cancelled')?.subscription === 'cancelled' && m('cancelled')?.tenant === 'cancelled')
    check('completed → expired, account untouched', m('completed')?.subscription === 'expired' && m('completed')?.tenant === null)
    check('expired → expired, account untouched', m('expired')?.subscription === 'expired' && m('expired')?.tenant === null)
    check('an unknown provider status maps to nothing at all', m('teleported') === null)
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('2. subscription creation')
  // ══════════════════════════════════════════════════════════════════════════
  let subA = ''
  let gatewaySubA = ''
  {
    calls.length = 0
    const r = await subscribeTenantToPlan(
      { tenantId: A.tenantId, planId: PRO, billingPeriod: 'monthly' },
      fakeGateway(),
      ownerDb,
    )
    subA = r.subscriptionId
    gatewaySubA = r.gatewaySubscriptionId

    const row = await subRow(subA)
    check('an active plan can be subscribed to', !!row)
    check('…the local row starts TRIALING, not active (no money has moved)', row.status === 'trialing')
    check('…on the plan that was asked for', row.plan_id === PRO)
    check('…with the gateway reference stored', row.gateway === 'razorpay' && row.gateway_subscription_id === gatewaySubA)
    check('…and a Razorpay customer recorded', typeof row.gateway_customer_id === 'string' && row.gateway_customer_id.startsWith('cust_'))
    check('…the checkout URL is returned for the hand-off', (r.checkoutUrl ?? '').startsWith('https://'))
    check('…the account is NOT promoted to active by creation alone', (await tenantStatus(A.tenantId)) === 'trial')

    const createCall = calls.find((c) => c.fn === 'createSubscription')!.args as { planId: string; keySecret: string; totalCount: number }
    check('the MONTHLY gateway plan was chosen for a monthly subscription', createCall.planId === gwMonthly)
    check('…and not the annual one', createCall.planId !== gwAnnual)
    check('the PLATFORM key secret was used', createCall.keySecret === PLATFORM_KEY_SECRET)

    // The single most important negative assertion in this file.
    const tenantCreds = (
      await ownerPool.query('select * from payment_settings where tenant_id=$1', [A.tenantId])
    ).rows[0]
    const tenantPlain = decryptSecret(tenantCreds.razorpay_key_secret_encrypted, A.tenantId)
    check('the TENANT key secret was NOT used', createCall.keySecret !== tenantPlain)
    const keyIds = calls.map((c) => (c.args as { keyId?: string }).keyId)
    check('…and no call used the tenant key ID', !keyIds.includes(tenantCreds.razorpay_key_id))
    check('…every call used the platform key ID', keyIds.every((k) => k === 'rzp_test_platform'))

    check('the price was verified against the gateway plan before creating', calls.some((c) => c.fn === 'fetchPlan'))
  }

  {
    // Annual on the same plan → the OTHER id.
    calls.length = 0
    const r = await subscribeTenantToPlan(
      { tenantId: B.tenantId, planId: PRO, billingPeriod: 'annual' },
      fakeGateway(),
      ownerDb,
    )
    const createCall = calls.find((c) => c.fn === 'createSubscription')!.args as { planId: string }
    check('an ANNUAL subscription selects the annual gateway plan', createCall.planId === gwAnnual)
    const row = await subRow(r.subscriptionId)
    check('…and the row records the annual period', row.billing_period === 'annual')
  }

  {
    const err = await subscribeTenantToPlan(
      { tenantId: A.tenantId, planId: RETIRED, billingPeriod: 'monthly' },
      fakeGateway(),
      ownerDb,
    ).catch((e) => e)
    check('a RETIRED plan is refused', err instanceof SubscriptionError && /no longer available/i.test(err.message))
  }

  {
    const err = await subscribeTenantToPlan(
      { tenantId: A.tenantId, planId: UNMAPPED, billingPeriod: 'monthly' },
      fakeGateway(),
      ownerDb,
    ).catch((e) => e)
    check('a plan with no gateway mapping is refused', err instanceof SubscriptionError)
  }

  {
    // The annual column is null on this plan, so annual must be refused
    // OUTRIGHT rather than falling back to the monthly id.
    calls.length = 0
    const err = await subscribeTenantToPlan(
      { tenantId: A.tenantId, planId: MISPRICED, billingPeriod: 'annual' },
      fakeGateway(),
      ownerDb,
    ).catch((e) => e)
    check('a period with no gateway plan is refused, NOT silently swapped', err instanceof SubscriptionError && /annually/i.test(err.message))
    check('…and nothing was created at the gateway', !calls.some((c) => c.fn === 'createSubscription'))
  }

  {
    calls.length = 0
    const err = await subscribeTenantToPlan(
      { tenantId: A.tenantId, planId: MISPRICED, billingPeriod: 'monthly' },
      fakeGateway(),
      ownerDb,
    ).catch((e) => e)
    check('a gateway plan whose PRICE differs from the catalogue is refused', err instanceof SubscriptionError && /wrong amount/i.test(err.message))
    check('…and no subscription was created', !calls.some((c) => c.fn === 'createSubscription'))
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('3. webhook: signature')
  // ══════════════════════════════════════════════════════════════════════════
  {
    const body = subBody({ event: 'subscription.activated', subId: gatewaySubA, status: 'active' })

    const bad = await deliver(body, { signature: sign(body, TENANT_SECRET), eventId: nextEvt() })
    check("a TENANT's webhook secret cannot sign a platform delivery (401)", bad.status === 401)

    const unsigned = await deliver(body, { signature: null, eventId: nextEvt() })
    check('a missing signature is rejected (401)', unsigned.status === 401)

    const tampered = await deliver(body + ' ', { signature: sign(body, PLATFORM_SECRET), eventId: nextEvt() })
    check('a body altered after signing is rejected (401)', tampered.status === 401)

    check('…and none of that changed the subscription', (await subRow(subA)).status === 'trialing')
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('4. lifecycle: trial → active')
  // ══════════════════════════════════════════════════════════════════════════
  {
    const evt = nextEvt()
    const body = subBody({
      event: 'subscription.charged',
      subId: gatewaySubA,
      status: 'active',
      currentStart: nowSec,
      currentEnd: nowSec + 30 * 24 * hour,
      paymentId: `pay_PS${tag}01`,
    })
    const res = await deliver(body, { signature: sign(body, PLATFORM_SECRET), eventId: evt })
    check('a validly signed subscription.charged is accepted (200)', res.status === 200)
    check('…and reported processed', res.body.status === 'processed')

    const row = await subRow(subA)
    check('the subscription is now ACTIVE', row.status === 'active')
    check('…the billing period came from the provider, not from local arithmetic', new Date(row.current_period_end).getTime() === (nowSec + 30 * 24 * hour) * 1000)
    check('…the payment id is recorded', row.gateway_last_payment_id === `pay_PS${tag}01`)
    check('the ACCOUNT is now active', (await tenantStatus(A.tenantId)) === 'active')

    // The payload named tenant B in `notes`. It must have been ignored.
    check('the lying notes.tenant_id did NOT affect tenant B', (await tenantStatus(B.tenantId)) === 'trial')

    const ev = (await ownerPool.query(`select * from webhook_events where event_id=$1`, [evt])).rows[0]
    check('the delivery is logged under the PLATFORM gateway', ev?.gateway === 'platform_razorpay')
    check('…attributed to the tenant our own row named', ev?.tenant_id === A.tenantId)
    check('…with the subscription reference, not an order id', ev?.subscription_id === gatewaySubA && ev?.order_id === null)

    // Entitlements now flow from the paid plan.
    const ent = await readEntitlements(ownerDb as never, A.tenantId)
    check('the plan now grants its entitlements', ent.entitlements['module.payroll'] === true)
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('5. idempotency')
  // ══════════════════════════════════════════════════════════════════════════
  {
    const evt = nextEvt()
    const body = subBody({
      event: 'subscription.charged',
      subId: gatewaySubA,
      status: 'active',
      currentStart: nowSec,
      currentEnd: nowSec + 30 * 24 * hour,
      paymentId: `pay_PS${tag}02`,
    })
    const sig = sign(body, PLATFORM_SECRET)

    const first = await deliver(body, { signature: sig, eventId: evt })
    const second = await deliver(body, { signature: sig, eventId: evt })
    check('a redelivered event id is a no-op', second.body.status === 'duplicate')
    check('…and the first one was not', first.body.status === 'processed')

    const n = await ownerPool.query<{ n: number }>(
      `select count(*)::int n from webhook_events where gateway='platform_razorpay' and event_id=$1`,
      [evt],
    )
    check('…exactly one delivery-log row exists for it', n.rows[0].n === 1)

    // Concurrency: the unique index must decide the winner, not application
    // timing. A FRESH payload, so the one that wins the claim genuinely has
    // work to do and 'processed' vs 'duplicate' actually distinguishes them.
    const evt2 = nextEvt()
    const body2 = subBody({
      event: 'subscription.charged',
      subId: gatewaySubA,
      status: 'active',
      currentStart: nowSec,
      currentEnd: nowSec + 45 * 24 * hour,
      paymentId: `pay_PS${tag}0C`,
    })
    const sig2 = sign(body2, PLATFORM_SECRET)
    const results = await Promise.all([
      deliver(body2, { signature: sig2, eventId: evt2 }),
      deliver(body2, { signature: sig2, eventId: evt2 }),
      deliver(body2, { signature: sig2, eventId: evt2 }),
    ])
    const outcomes = results.map((r) => r.body.status)
    check('three CONCURRENT deliveries of one event produce exactly one winner', outcomes.filter((o) => o === 'processed').length === 1)
    check('…and two no-ops', outcomes.filter((o) => o === 'duplicate').length === 2)
    check('…all three answered 200', results.every((r) => r.status === 200))
    const claimed = await ownerPool.query<{ n: number }>(
      `select count(*)::int n from webhook_events where gateway='platform_razorpay' and event_id=$1`,
      [evt2],
    )
    check('…and the event was claimed exactly once', claimed.rows[0].n === 1)
    check('…the period was applied once, from the provider', new Date((await subRow(subA)).current_period_end).getTime() === (nowSec + 45 * 24 * hour) * 1000)

    const subs = await ownerPool.query<{ n: number }>(
      `select count(*)::int n from tenant_subscriptions where tenant_id=$1`,
      [A.tenantId],
    )
    check('…and no duplicate subscription row was created', subs.rows[0].n === 1)
  }

  {
    // An out-of-order redelivery of an OLDER period must not shorten the term.
    const body = subBody({
      event: 'subscription.charged',
      subId: gatewaySubA,
      status: 'active',
      currentStart: nowSec - 60 * 24 * hour,
      currentEnd: nowSec - 30 * 24 * hour,
    })
    await deliver(body, { signature: sign(body, PLATFORM_SECRET), eventId: nextEvt() })
    const row = await subRow(subA)
    check('a stale event cannot move the billing period backwards', new Date(row.current_period_end).getTime() === (nowSec + 45 * 24 * hour) * 1000)
  }

  {
    // ── REGRESSION: the first provider period must be able to SHORTEN a
    // locally-seeded one ──────────────────────────────────────────────────
    //
    // subscribeTenantToPlan() seeds current_period_end from the tenant's
    // remaining RUNWAY, which is not a provider value. When that runway
    // outlasts the cycle being bought — an annual → monthly downgrade, or an
    // admin-assigned multi-month plan followed by a monthly checkout — the
    // real 30-day period ends BEFORE the placeholder.
    //
    // An end-only "never backwards" rule discarded it, and the row kept a
    // 300-day period bought with one month's money. Everything downstream
    // inherited that: the GST invoice documented a 300-day window for a
    // MONTHLY charge, and the proration credit computed from that invoice on
    // a later plan change refunded almost the whole payment for days the
    // business had actually consumed.
    const R = await makeTenant(`psrun${tag}`.slice(0, 20))
    const gwSub = `sub_PSRUN${tag}`
    const inserted = await ownerPool.query<{ id: string }>(
      `insert into tenant_subscriptions
         (tenant_id, plan_id, billing_period, status, current_period_start, current_period_end,
          gateway, gateway_subscription_id)
       values ($1,$2,'monthly','trialing', to_timestamp($3), to_timestamp($4), 'razorpay', $5)
       returning id`,
      [R.tenantId, PRO, nowSec, nowSec + 300 * 24 * hour, gwSub],
    )
    const seeded = inserted.rows[0].id

    const paymentId = `pay_PSRUN${tag}`
    const charged = subBody({
      event: 'subscription.charged',
      subId: gwSub,
      status: 'active',
      currentStart: nowSec,
      currentEnd: nowSec + 30 * 24 * hour,
      paymentId,
    })
    const res = await deliver(charged, {
      signature: sign(charged, PLATFORM_SECRET),
      eventId: nextEvt(),
    })
    check('a charge against a locally-seeded period is processed', res.body.status === 'processed')

    const after = (
      await ownerPool.query<{ current_period_start: string; current_period_end: string }>(
        `select current_period_start, current_period_end from tenant_subscriptions where id=$1`,
        [seeded],
      )
    ).rows[0]
    check(
      "…and the provider's REAL period replaces the 300-day placeholder",
      new Date(after.current_period_end).getTime() === (nowSec + 30 * 24 * hour) * 1000,
    )
    check(
      '…start included, so the term is 30 days and not 300',
      Math.round(
        (new Date(after.current_period_end).getTime() -
          new Date(after.current_period_start).getTime()) /
          86_400_000,
      ) === 30,
    )

    const billed = (
      await ownerPool.query<{
        billing_period_start: string
        billing_period_end: string
        billing_period_type: string
      }>(
        `select billing_period_start, billing_period_end, billing_period_type
           from platform_invoices where gateway_payment_id=$1`,
        [paymentId],
      )
    ).rows[0]
    check('…the GST invoice documents that same 30-day window', !!billed &&
      new Date(billed.billing_period_end).getTime() === (nowSec + 30 * 24 * hour) * 1000)
    check('…for a monthly charge, as it says it is', billed?.billing_period_type === 'monthly')

    // The consequence that actually cost money: a plan change once the paid
    // month is fully consumed must credit NOTHING.
    const last = await lastPaidInvoiceFor(ownerDb as never, seeded)
    const spent = computeProrationCredit({
      paidTotal: Number(last!.total),
      periodStart: last!.billingPeriodStart,
      periodEnd: last!.billingPeriodEnd,
      at: new Date((nowSec + 30 * 24 * hour) * 1000),
    })
    check('…so a switch after the whole month credits nothing', spent.amount === 0)
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('6. lifecycle: active → past_due → suspended')
  // ══════════════════════════════════════════════════════════════════════════
  {
    const body = subBody({ event: 'subscription.pending', subId: gatewaySubA, status: 'pending' })
    const res = await deliver(body, { signature: sign(body, PLATFORM_SECRET), eventId: nextEvt() })
    check('a failed charge is accepted (200)', res.status === 200)
    check('the subscription moves to PAST_DUE', (await subRow(subA)).status === 'past_due')
    check('…the account keeps working during grace (still active)', (await tenantStatus(A.tenantId)) === 'active')

    const ent = await readEntitlements(ownerDb as never, A.tenantId)
    check('…and the plan still grants its entitlements', ent.entitlements['module.payroll'] === true)
  }

  {
    const body = subBody({ event: 'subscription.halted', subId: gatewaySubA, status: 'halted' })
    await deliver(body, { signature: sign(body, PLATFORM_SECRET), eventId: nextEvt() })
    check('grace exhaustion expires the subscription', (await subRow(subA)).status === 'expired')
    check('…and SUSPENDS the account', (await tenantStatus(A.tenantId)) === 'suspended')

    const ent = await readEntitlements(ownerDb as never, A.tenantId)
    check('…entitlements are now revoked (fail-closed)', ent.plan === null && Object.keys(ent.entitlements).length === 0)

    const visible = await ownerPool.query(`select * from public.public_tenant_by_slug($1)`, [A.slug])
    check('…and the public booking site stops resolving', visible.rows.length === 0)
  }

  {
    // Paying again must reverse all of it. Nothing was deleted.
    const body = subBody({
      event: 'subscription.charged',
      subId: gatewaySubA,
      status: 'active',
      currentStart: nowSec,
      currentEnd: nowSec + 60 * 24 * hour,
      paymentId: `pay_PS${tag}03`,
    })
    await deliver(body, { signature: sign(body, PLATFORM_SECRET), eventId: nextEvt() })
    check('a later successful charge reactivates the subscription', (await subRow(subA)).status === 'active')
    check('…and un-suspends the account', (await tenantStatus(A.tenantId)) === 'active')
    const ent = await readEntitlements(ownerDb as never, A.tenantId)
    check('…restoring the entitlements untouched', ent.entitlements['module.payroll'] === true)
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('7. cancellation')
  // ══════════════════════════════════════════════════════════════════════════
  {
    calls.length = 0
    const r = await cancelTenantSubscription(A.tenantId, fakeGateway(), ownerDb)
    check('cancelling an ACTIVE subscription defers to the period end', r.atPeriodEnd === true)

    const call = calls.find((c) => c.fn === 'cancelSubscription')!.args as { atCycleEnd: boolean; subscriptionId: string }
    check('…Razorpay is actually told', call.subscriptionId === gatewaySubA)
    check('…with cancel_at_cycle_end', call.atCycleEnd === true)

    const row = await subRow(subA)
    check('…the local row is NOT yet cancelled — the webhook decides that', row.status === 'active')
    check('…only the pending flag is set', row.cancel_at_period_end === true)
    check('…and the account is untouched', (await tenantStatus(A.tenantId)) === 'active')

    const again = await cancelTenantSubscription(A.tenantId, fakeGateway(), ownerDb)
    check('cancelling twice is a no-op, not a gateway error', again.atPeriodEnd === true)
  }

  {
    const body = subBody({ event: 'subscription.cancelled', subId: gatewaySubA, status: 'cancelled' })
    await deliver(body, { signature: sign(body, PLATFORM_SECRET), eventId: nextEvt() })
    const row = await subRow(subA)
    check('the cancellation webhook closes the subscription', row.status === 'cancelled')
    check('…records when', row.cancelled_at !== null)
    check('…clears the pending flag', row.cancel_at_period_end === false)
    check('…and CANCELS the account (this subscription had been paid)', (await tenantStatus(A.tenantId)) === 'cancelled')

    const ent = await readEntitlements(ownerDb as never, A.tenantId)
    check('…entitlements are gone', ent.plan === null)
  }

  {
    // Terminal really is terminal: a late charge must not resurrect anything.
    await setTenantStatus(A.tenantId, 'cancelled')
    const body = subBody({
      event: 'subscription.charged',
      subId: gatewaySubA,
      status: 'active',
      currentStart: nowSec,
      currentEnd: nowSec + 90 * 24 * hour,
      paymentId: `pay_PS${tag}09`,
    })
    const res = await deliver(body, { signature: sign(body, PLATFORM_SECRET), eventId: nextEvt() })
    check('a late charge on a CANCELLED subscription is a no-op', res.body.status === 'duplicate')
    check('…the subscription stays cancelled', (await subRow(subA)).status === 'cancelled')
    check('…and the account is not resurrected', (await tenantStatus(A.tenantId)) === 'cancelled')
  }

  {
    // An abandoned checkout must not close a business's account.
    const C = await makeTenant('tstsubsc', 'active')
    const r = await subscribeTenantToPlan(
      { tenantId: C.tenantId, planId: PRO, billingPeriod: 'monthly' },
      fakeGateway(),
      ownerDb,
    )
    const body = subBody({ event: 'subscription.cancelled', subId: r.gatewaySubscriptionId, status: 'cancelled' })
    await deliver(body, { signature: sign(body, PLATFORM_SECRET), eventId: nextEvt() })
    check('cancelling a NEVER-CHARGED subscription closes the subscription', (await subRow(r.subscriptionId)).status === 'cancelled')
    check('…but leaves the account exactly as it was', (await tenantStatus(C.tenantId)) === 'active')
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('8. switching plans does not orphan the old mandate')
  // ══════════════════════════════════════════════════════════════════════════
  {
    const D = await makeTenant('tstsubsd', 'active')
    const first = await subscribeTenantToPlan(
      { tenantId: D.tenantId, planId: PRO, billingPeriod: 'monthly' },
      fakeGateway(),
      ownerDb,
    )
    // Make it a paid subscription, so the switch is the realistic case.
    const charge = subBody({
      event: 'subscription.charged',
      subId: first.gatewaySubscriptionId,
      status: 'active',
      currentStart: nowSec,
      currentEnd: nowSec + 30 * 24 * hour,
      paymentId: `pay_PS${tag}20`,
    })
    await deliver(charge, { signature: sign(charge, PLATFORM_SECRET), eventId: nextEvt() })

    calls.length = 0
    const second = await subscribeTenantToPlan(
      { tenantId: D.tenantId, planId: PRO, billingPeriod: 'annual' },
      fakeGateway(),
      ownerDb,
    )
    const cancelCall = calls.find((c) => c.fn === 'cancelSubscription')?.args as
      | { subscriptionId: string; atCycleEnd: boolean }
      | undefined
    check('switching cancels the PREVIOUS gateway subscription', cancelCall?.subscriptionId === first.gatewaySubscriptionId)
    check('…immediately, not at cycle end', cancelCall?.atCycleEnd === false)
    check('…the old local row is closed', (await subRow(first.subscriptionId)).status === 'cancelled')
    check('…exactly one live row remains', (await liveSub(D.tenantId)).id === second.subscriptionId)
    check('…on the new billing period', (await subRow(second.subscriptionId)).billing_period === 'annual')

    // And the cancellation webhook for the OLD subscription must not now
    // cancel the account the tenant has just re-subscribed on.
    const body = subBody({ event: 'subscription.cancelled', subId: first.gatewaySubscriptionId, status: 'cancelled' })
    await deliver(body, { signature: sign(body, PLATFORM_SECRET), eventId: nextEvt() })
    check("the old subscription's cancellation does not cancel the account", (await tenantStatus(D.tenantId)) === 'active')
    check('…and does not disturb the new subscription', (await subRow(second.subscriptionId)).status === 'trialing')
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('9. unknown subscriptions and unhandled events')
  // ══════════════════════════════════════════════════════════════════════════
  {
    const body = subBody({ event: 'subscription.charged', subId: 'sub_NEVERSEEN', status: 'active' })
    const res = await deliver(body, { signature: sign(body, PLATFORM_SECRET), eventId: nextEvt() })
    check('a subscription we never created is acknowledged, not invented (200)', res.status === 200 && res.body.status === 'ignored')

    const body2 = subBody({ event: 'payment.captured', subId: gatewaySubA, status: 'active' })
    const res2 = await deliver(body2, { signature: sign(body2, PLATFORM_SECRET), eventId: nextEvt() })
    check('a non-subscription event is acknowledged and ignored', res2.body.status === 'ignored')

    const res3 = await deliver('{not json', { signature: sign('{not json', PLATFORM_SECRET), eventId: nextEvt() })
    check('a signed but malformed body is acknowledged, never retried', res3.status === 200 && res3.body.status === 'ignored')
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('10. secrets')
  // ══════════════════════════════════════════════════════════════════════════
  {
    const row = (await ownerPool.query('select * from platform_payment_settings where id=true')).rows[0]
    check('the platform key secret is stored as ciphertext', row.razorpay_key_secret_encrypted !== PLATFORM_KEY_SECRET && row.razorpay_key_secret_encrypted.startsWith('v1:'))
    check('the platform webhook secret is stored as ciphertext', row.razorpay_webhook_secret_encrypted !== PLATFORM_SECRET && row.razorpay_webhook_secret_encrypted.startsWith('v1:'))
    check('…and the two are different values', row.razorpay_key_secret_encrypted !== row.razorpay_webhook_secret_encrypted)

    // The AAD binding: a platform secret is not decryptable as a tenant's, and
    // a tenant's is not decryptable as the platform's.
    let crossOk = false
    try {
      decryptSecret(row.razorpay_webhook_secret_encrypted, A.tenantId)
      crossOk = true
    } catch {
      /* expected */
    }
    check('a platform ciphertext cannot be decrypted with a tenant AAD', !crossOk)

    const tenantCipher = (
      await ownerPool.query('select razorpay_webhook_secret_encrypted c from payment_settings where tenant_id=$1', [A.tenantId])
    ).rows[0].c
    let reverseOk = false
    try {
      decryptSecret(tenantCipher, 'platform:razorpay')
      reverseOk = true
    } catch {
      /* expected */
    }
    check('…and a tenant ciphertext cannot be decrypted as the platform', !reverseOk)

    const body = subBody({ event: 'subscription.activated', subId: gatewaySubA, status: 'active' })
    const res = await deliver(body, { signature: sign(body, PLATFORM_SECRET), eventId: nextEvt() })
    const serialised = JSON.stringify(res.body)
    check('the webhook response leaks no secret', !serialised.includes(PLATFORM_SECRET) && !serialised.includes(PLATFORM_KEY_SECRET))
    check('…and is just a status word', JSON.stringify(Object.keys(res.body)) === '["status"]')
  }

  // ── cleanup ───────────────────────────────────────────────────────────────
  await ownerPool.query(`delete from webhook_events where gateway='platform_razorpay' and event_id like $1`, [`evt_PS${tag}%`])
  await ownerPool.query('delete from tenants where id = any($1)', [created])
  await ownerPool.query('delete from plans where id = any($1)', [planIds])
  await ownerPool.query('delete from platform_payment_settings where id=true')
  await ownerPool.end()

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error('test harness error:', e instanceof Error ? `${e.name}: ${e.message}` : 'unknown', e)
  process.exit(1)
})
