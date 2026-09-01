/**
 * AROS-114 — platform billing dashboard, metrics and manual overrides, end to
 * end against a real database.
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs \
 *           --import ./scripts/next-runtime-hook.mjs \
 *           scripts/test-platform-billing.ts
 *
 * ── What is real and what is faked ──────────────────────────────────────────
 *
 * REAL: the database, migrations 0050–0054, every RLS policy and grant, the
 * actual SQL aggregates behind MRR / mix / churn / revenue, the actual server
 * actions WITH their requirePlatformAdmin() guards driven through real session
 * rows, the actual override and refund domain code, the actual platform webhook
 * route handler with real HMAC signatures, and the actual audit_log writes.
 *
 * FAKED: two things.
 *   * the HTTP call to Razorpay's refund endpoint, through the injectable seam
 *     lib/platform/billing/refunds.ts exposes;
 *   * Next's request runtime (cookies + revalidatePath), via
 *     ./next-runtime-hook.mjs — which supplies a cookie jar and nothing else.
 *     No guard, no policy and no business rule is stubbed, so a test that signs
 *     in as a non-admin is refused by the genuine guard.
 *
 * ── How the platform-wide figures are isolated ──────────────────────────────
 *
 * The dashboard is deliberately platform-wide, so absolute counts depend on
 * whatever else is in the database. Every assertion here is therefore either
 *   * a DELTA against a baseline taken before the fixtures exist, or
 *   * scoped to a private currency ('XTS', the ISO test code) which gives the
 *     MRR aggregate its own row, or
 *   * scoped to a historical date range no other fixture touches.
 *
 * No secret is ever printed.
 */
import { createHash, createHmac, randomBytes } from 'node:crypto'
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

const DAY_MS = 86_400_000
/** The private currency that isolates this run's MRR from every other row. */
const CUR = 'XTS'

async function main() {
  loadEnv()
  const { NextRequest } = await import('next/server')
  const { POST } = await import('../app/api/webhooks/platform-razorpay/route')
  const { encryptSecret } = await import('../lib/security/encryption')
  const { drizzle } = await import('drizzle-orm/node-postgres')
  const schema = await import('../db/schema')

  const metrics = await import('../lib/platform/billing/metrics')
  const { getTenantBillingDetail } = await import('../lib/platform/billing/tenant-detail')
  const overrides = await import('../lib/platform/billing/overrides')
  const refundsMod = await import('../lib/platform/billing/refunds')
  const actions = await import('../lib/actions/platform-billing')
  const { assignPlan } = await import('../lib/actions/plans')
  const { PlatformError } = await import('../lib/platform/guard')
  const { RazorpayApiError } = await import('../lib/payments/razorpay')

  const ownerPool = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })
  const appPool = new Pool({ connectionString: process.env.DATABASE_URL })
  const ownerDb = drizzle(ownerPool, { schema })

  const PLATFORM_SECRET = `whsec_${randomBytes(16).toString('hex')}`
  const PLATFORM_KEY_SECRET = `rzpsecret_${randomBytes(12).toString('hex')}`
  const sign = (raw: string, secret: string) =>
    createHmac('sha256', secret).update(raw, 'utf8').digest('hex')
  const ROOT = (process.env.NEXT_PUBLIC_ROOT_DOMAIN ?? 'lvh.me:3000').split(':')[0]

  const tag = randomBytes(4).toString('hex')

  // ── purge anything a previous run of THIS suite left behind ───────────────
  //
  // The isolation devices below are a shared private currency ('XTS') and a
  // shared historical window (2019), not a per-run tag — a currency code is
  // three characters and a date is a date. So a run that was interrupted before
  // its cleanup would inflate the next run's aggregates and the failures would
  // look like real ones.
  //
  // Scoped by this suite's own naming (`t114…` slugs, `ZZ114 …` plans,
  // `aros114-…` users), so it can never touch a fixture belonging to another
  // script or to a developer's own data. FK order matters: the restrict
  // references from platform_refunds and platform_dunning_notices have to go
  // before the tenants cascade reaches their subscriptions.
  {
    const stale = `select id from tenants where slug like 't114%'`
    await ownerPool.query(`delete from platform_refunds where tenant_id in (${stale})`)
    await ownerPool.query(`delete from platform_dunning_notices where tenant_id in (${stale})`)
    await ownerPool.query(`delete from platform_invoices where tenant_id in (${stale})`)
    await ownerPool.query(`delete from tenants where slug like 't114%'`)
    await ownerPool.query(`delete from plans where name like 'ZZ114 %'`)
    await ownerPool.query(`delete from users where email like 'aros114-%@example.test'`)
    await ownerPool.query(`delete from webhook_events where event_id like 'evt114%'`)
  }

  // ── identities ────────────────────────────────────────────────────────────
  const userIds: string[] = []
  async function makeUser(kind: 'admin' | 'tenant', label: string) {
    const email = `aros114-${kind}-${label}-${tag}@example.test`
    const u = await ownerPool.query<{ id: string }>(
      `insert into users (email, password_hash, full_name, is_platform_admin)
       values ($1,'x',$2,$3) returning id`,
      [email, `${kind} ${label}`, kind === 'admin'],
    )
    userIds.push(u.rows[0].id)
    // A REAL session row, read by the REAL session code. The cookie jar stub
    // only carries the token; everything else about signing in is genuine.
    const token = randomBytes(32).toString('hex')
    await ownerPool.query(
      `insert into sessions (id, user_id, expires_at) values ($1,$2, now() + interval '1 day')`,
      [createHash('sha256').update(token).digest('hex'), u.rows[0].id],
    )
    return { id: u.rows[0].id, email, token }
  }

  const ADMIN = await makeUser('admin', 'a')
  const OUTSIDER = await makeUser('tenant', 'b')

  const signedInAs = (token: string | undefined) => {
    ;(globalThis as { __ARENA_TEST_SESSION?: string }).__ARENA_TEST_SESSION = token
  }

  // ── fixtures ──────────────────────────────────────────────────────────────
  const tenantIds: string[] = []
  const planIds: string[] = []

  async function makeTenant(label: string, status = 'active') {
    const slug = `t114${label}${tag}`.slice(0, 30)
    const t = await ownerPool.query<{ id: string }>(
      `insert into tenants (slug,name,status,timezone) values ($1,$2,$3,'Asia/Kolkata') returning id`,
      [slug, `AROS114 ${label}`, status],
    )
    tenantIds.push(t.rows[0].id)
    await ownerPool.query(`insert into branches (tenant_id,name,is_primary) values ($1,'Main',true)`, [
      t.rows[0].id,
    ])
    return t.rows[0].id
  }

  /** An OWNER membership, so the tenant-side RLS checks are meaningful. */
  async function makeOwner(tenantId: string, label: string) {
    const email = `aros114-owner-${label}-${tag}@example.test`
    const u = await ownerPool.query<{ id: string }>(
      `insert into users (email,password_hash,full_name) values ($1,'x','Owner') returning id`,
      [email],
    )
    userIds.push(u.rows[0].id)
    await ownerPool.query(
      `insert into memberships (tenant_id,user_id,role,status,full_name,email)
       values ($1,$2,'owner','active','Owner',$3)`,
      [tenantId, u.rows[0].id, email],
    )
    return u.rows[0].id
  }

  async function makePlan(name: string, monthly: string, annual: string, currency = CUR) {
    const r = await ownerPool.query<{ id: string }>(
      `insert into plans (name, monthly_price, annual_price, currency, active)
       values ($1,$2,$3,$4,true) returning id`,
      [`ZZ114 ${name} ${tag}`, monthly, annual, currency],
    )
    planIds.push(r.rows[0].id)
    return r.rows[0].id
  }

  async function makeSub(
    tenantId: string,
    planId: string,
    o: {
      status?: string
      startOffsetDays?: number
      endOffsetDays?: number
      billingPeriod?: 'monthly' | 'annual'
      gatewaySubscriptionId?: string | null
      cancelledOffsetDays?: number | null
      createdOffsetDays?: number
      suspendedOffsetDays?: number | null
    } = {},
  ) {
    const r = await ownerPool.query<{ id: string }>(
      `insert into tenant_subscriptions
         (tenant_id, plan_id, billing_period, status, current_period_start, current_period_end,
          gateway, gateway_subscription_id, cancelled_at, created_at, suspended_at, past_due_since)
       values ($1,$2,$3,$4,
               now() + ($5 || ' days')::interval,
               now() + ($6 || ' days')::interval,
               case when $7::text is null then null else 'razorpay' end,
               $7,
               case when $8::text is null then null else now() + ($8 || ' days')::interval end,
               now() + ($9 || ' days')::interval,
               case when $10::text is null then null else now() + ($10 || ' days')::interval end,
               case when $10::text is null then null else now() + ($10 || ' days')::interval end)
       returning id`,
      [
        tenantId,
        planId,
        o.billingPeriod ?? 'monthly',
        o.status ?? 'active',
        String(o.startOffsetDays ?? -10),
        String(o.endOffsetDays ?? 20),
        o.gatewaySubscriptionId ?? null,
        o.cancelledOffsetDays === undefined || o.cancelledOffsetDays === null
          ? null
          : String(o.cancelledOffsetDays),
        String(o.createdOffsetDays ?? -10),
        o.suspendedOffsetDays === undefined || o.suspendedOffsetDays === null
          ? null
          : String(o.suspendedOffsetDays),
      ],
    )
    return r.rows[0].id
  }

  // The platform gateway config, so credential-dependent paths are realistic.
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
  await ownerPool.query(
    `insert into platform_billing_settings (id, seller_legal_name, seller_state_code, gst_rate)
     values (true,'Arena OS Test','29','18.00')
     on conflict (id) do update set seller_legal_name = excluded.seller_legal_name,
       seller_state_code = excluded.seller_state_code`,
  )

  const RANGE_DAYS = 90
  const today = new Date()
  const iso = (d: Date) => d.toISOString().slice(0, 10)
  const range = {
    start: iso(new Date(today.getTime() - (RANGE_DAYS - 1) * DAY_MS)),
    end: iso(today),
  }

  signedInAs(ADMIN.token)
  const baseline = await metrics.getPlatformBillingDashboard({
    range,
    bucket: 'month',
    db: ownerDb,
  })
  const baseMix = baseline.mix

  // ══════════════════════════════════════════════════════════════════════════
  section('1. MRR and ARR')
  // ══════════════════════════════════════════════════════════════════════════
  const PLAN_M = await makePlan('Monthly', '1000.00', '10000.00')
  const PLAN_A = await makePlan('Annual', '2000.00', '12000.00')

  const T_MONTHLY = await makeTenant('mon')
  const T_ANNUAL = await makeTenant('ann')
  const T_TRIAL = await makeTenant('tri', 'trial')
  const T_PASTDUE = await makeTenant('pd')
  const T_SUSPENDED = await makeTenant('sus', 'suspended')
  const T_CANCELLED = await makeTenant('can', 'cancelled')
  const T_LAPSED = await makeTenant('lap')

  await makeSub(T_MONTHLY, PLAN_M, { status: 'active', billingPeriod: 'monthly' })
  await makeSub(T_ANNUAL, PLAN_A, { status: 'active', billingPeriod: 'annual' })
  await makeSub(T_TRIAL, PLAN_M, { status: 'trialing' })
  await makeSub(T_PASTDUE, PLAN_M, { status: 'past_due', endOffsetDays: -1 })
  await makeSub(T_SUSPENDED, PLAN_M, {
    status: 'expired',
    endOffsetDays: -5,
    suspendedOffsetDays: -2,
  })
  await makeSub(T_CANCELLED, PLAN_M, {
    status: 'cancelled',
    endOffsetDays: -5,
    cancelledOffsetDays: -3,
  })
  // Active on the status column but past its period end: granting nothing, and
  // therefore NOT revenue.
  await makeSub(T_LAPSED, PLAN_M, { status: 'active', endOffsetDays: -1 })

  {
    const d = await metrics.getPlatformBillingDashboard({ range, bucket: 'month', db: ownerDb })
    const x = d.mrr.find((m) => m.currency === CUR)

    check('the private test currency gets its own MRR row', x !== undefined)
    // monthly 1000 + annual 12000/12 = 1000 → 2000
    check('a monthly plan contributes its monthly price', x?.mrr === 2000)
    check('…which means an annual plan is normalised by twelve', x?.mrr === 1000 + 12000 / 12)
    check('ARR is MRR × 12', x?.arr === 24000)
    check('two active subscriptions are counted', x?.activeCount === 2)
    check('a past_due subscription is reported as revenue AT RISK, not as MRR', x?.pastDueMrr === 1000 && x?.pastDueCount === 1)
    check('a lapsed "active" row is excluded from MRR', x?.activeCount === 2)
    check('…and surfaced so the omission is visible', x?.lapsedActiveCount === 1)
    check('a trial contributes nothing to MRR', x?.mrr === 2000)
    check('currencies are never summed together', d.mrr.every((m) => m.currency === CUR || m.currency !== CUR))
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('2. subscription mix, counted per tenant')
  // ══════════════════════════════════════════════════════════════════════════
  {
    // A tenant with THREE historical subscriptions and one live row — the shape
    // that would produce four rows in a naive count.
    const T_HISTORY = await makeTenant('hist')
    // Each closed period sits entirely in the past and before the next —
    // tenant_subscriptions_period (0050) CHECKs end > start.
    await makeSub(T_HISTORY, PLAN_M, { status: 'cancelled', startOffsetDays: -90, endOffsetDays: -60, cancelledOffsetDays: -60, createdOffsetDays: -90 })
    await makeSub(T_HISTORY, PLAN_M, { status: 'cancelled', startOffsetDays: -60, endOffsetDays: -30, cancelledOffsetDays: -30, createdOffsetDays: -60 })
    await makeSub(T_HISTORY, PLAN_A, { status: 'expired', startOffsetDays: -30, endOffsetDays: -20, createdOffsetDays: -30 })
    await makeSub(T_HISTORY, PLAN_M, { status: 'active', startOffsetDays: -10, endOffsetDays: 15, createdOffsetDays: -10 })

    const d = await metrics.getPlatformBillingDashboard({ range, bucket: 'month', db: ownerDb })
    const m = d.mix

    check('trials +1', m.trialing - baseMix.trialing === 1)
    // T_MONTHLY, T_ANNUAL, T_LAPSED and T_HISTORY are all live+active rows.
    check('active +4', m.active - baseMix.active === 4)
    check('past due +1', m.pastDue - baseMix.pastDue === 1)
    check('suspended +1', m.suspended - baseMix.suspended === 1)
    check('cancelled +1', m.cancelled - baseMix.cancelled === 1)
    check('the six buckets sum to the tenant count', m.trialing + m.active + m.pastDue + m.suspended + m.cancelled + m.noPlan === m.tenants)

    const row = d.tenants.filter((t) => t.tenantId === T_HISTORY)
    check('a tenant with four subscriptions appears ONCE in the table', row.length === 1)
    check('…on its LIVE subscription', row[0]?.status === 'active')
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('3. churn, including its boundaries')
  // ══════════════════════════════════════════════════════════════════════════
  {
    // A private historical window nothing else in the database touches, so the
    // figures are absolute rather than deltas.
    const win = { start: '2019-06-01', end: '2019-06-30' }
    const T_CHURN = await makeTenant('chn')
    const T_STAY = await makeTenant('sty')
    const T_EDGE = await makeTenant('edg')

    const at = (d: string) => `'${d}'::timestamptz`
    // Live before the window, cancelled inside it → churned.
    await ownerPool.query(
      `insert into tenant_subscriptions
        (tenant_id, plan_id, billing_period, status, current_period_start, current_period_end,
         cancelled_at, created_at)
       values ($1,$2,'monthly','cancelled', ${at('2019-01-01')}, ${at('2019-12-31')},
               ${at('2019-06-15')}, ${at('2019-01-01')})`,
      [T_CHURN, PLAN_M],
    )
    // Live throughout → not churned.
    await ownerPool.query(
      `insert into tenant_subscriptions
        (tenant_id, plan_id, billing_period, status, current_period_start, current_period_end, created_at)
       values ($1,$2,'monthly','active', ${at('2019-01-01')}, ${at('2020-12-31')}, ${at('2019-01-01')})`,
      [T_STAY, PLAN_M],
    )

    const churn = (
      await metrics.getPlatformBillingDashboard({ range: win, bucket: 'month', db: ownerDb })
    ).churn

    check('two tenants were live at the start of the window', churn.activeAtStart === 2)
    check('one of them churned', churn.churned === 1)
    check('the rate is 50%', churn.churnRatePercent === 50)
    check('the hard-cancellation count is reported alongside', churn.cancelledInPeriod === 1)

    // ── the boundary: cancelled at the very first instant of the window ────
    await ownerPool.query(
      `insert into tenant_subscriptions
        (tenant_id, plan_id, billing_period, status, current_period_start, current_period_end,
         cancelled_at, created_at)
       values ($1,$2,'monthly','cancelled', ${at('2019-01-01')}, ${at('2019-12-31')},
               '2019-06-01T00:00:00+05:30'::timestamptz, ${at('2019-01-01')})`,
      [T_EDGE, PLAN_M],
    )
    const edge = (
      await metrics.getPlatformBillingDashboard({ range: win, bucket: 'month', db: ownerDb })
    ).churn
    check(
      'a cancellation AT the opening instant counts inside the window',
      edge.cancelledInPeriod === 2,
    )
    check(
      '…and its tenant is not "live at the start", so it is not in the denominator',
      edge.activeAtStart === 2,
    )

    // ── zero denominator ──────────────────────────────────────────────────
    const empty = (
      await metrics.getPlatformBillingDashboard({
        range: { start: '1990-01-01', end: '1990-01-31' },
        bucket: 'month',
        db: ownerDb,
      })
    ).churn
    check('nothing was live in 1990', empty.activeAtStart === 0)
    check('…so the churn rate is NULL, not 0 and not NaN', empty.churnRatePercent === null)
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('4. revenue over time reconciles with the invoices')
  // ══════════════════════════════════════════════════════════════════════════
  const T_REV = await makeTenant('rev')
  const REV_SUB = await makeSub(T_REV, PLAN_M, { status: 'active' })
  let paidInvoiceId = ''
  {
    const win = { start: '2019-06-01', end: '2019-06-30' }
    const mkInvoice = async (o: {
      number: string
      date: string
      total: string
      kind?: string
      status?: string
      paymentId?: string | null
    }) => {
      const r = await ownerPool.query<{ id: string }>(
        `insert into platform_invoices
           (tenant_id, subscription_id, plan_id, kind, invoice_number, invoice_date, period,
            billing_period_start, billing_period_end, billing_period_type,
            plan_name, plan_price, seller_legal_name, buyer_legal_name,
            subtotal, adjustment, taxable_value, gst_rate, cgst, sgst, igst, tax_total, total,
            currency, status, gateway, gateway_payment_id)
         values ($1,$2,$3,$4,$5,$6::date,'2019-20',
                 $6::date, $6::date + 30, 'monthly',
                 'ZZ114', $7, 'Arena OS Test', 'AROS114 rev',
                 $7, 0, $7, 0, 0, 0, 0, 0, $7,
                 $8, $9, 'razorpay', $10)
         returning id`,
        [
          T_REV,
          REV_SUB,
          PLAN_M,
          o.kind ?? 'subscription',
          `${o.number}-${tag}`,
          o.date,
          o.total,
          CUR,
          o.status ?? 'paid',
          o.paymentId ?? null,
        ],
      )
      return r.rows[0].id
    }

    paidInvoiceId = await mkInvoice({
      number: 'INV1',
      date: '2019-06-05',
      total: '1000.00',
      paymentId: `pay_114${tag}`,
    })
    await mkInvoice({ number: 'INV2', date: '2019-06-20', total: '500.00', paymentId: `pay_114b${tag}` })
    // A VOID invoice — never cash.
    await mkInvoice({ number: 'INV3', date: '2019-06-21', total: '999.00', status: 'void' })
    // A credit note — an entitlement to a discount, not money that moved.
    await mkInvoice({ number: 'CN1', date: '2019-06-22', total: '250.00', kind: 'credit_note', status: 'issued' })

    const d = await metrics.getPlatformBillingDashboard({ range: win, bucket: 'month', db: ownerDb })
    check('gross revenue is the sum of PAID subscription invoices', d.revenueTotals.gross === 1500)
    check('a void invoice is not revenue', d.revenueTotals.gross === 1500)
    check('the invoice count matches', d.revenueTotals.invoices === 2)
    check('credit notes are reported separately', d.revenueTotals.creditsIssued === 250)
    check('…and NOT deducted from revenue', d.revenueTotals.net === 1500)
    check('one monthly bucket', d.revenue.length === 1 && d.revenue[0].bucketStart === '2019-06-01')

    const daily = await metrics.getPlatformBillingDashboard({ range: win, bucket: 'day', db: ownerDb })
    // One bucket per DAY IN THE RANGE — all 30 of June, not just the four that
    // carry a document. The series is a time axis, so the 26 silent days are
    // part of the answer: a chart that omits them draws 5 June flush against 20
    // June and invents a fortnight of trading that never happened.
    check('bucketing by day spans the whole range, gaps included', daily.revenue.length === 30)
    check('…every day in the range is present exactly once', new Set(daily.revenue.map((p) => p.bucketStart)).size === 30)
    check('…the series is contiguous and ordered', daily.revenue[0].bucketStart === '2019-06-01' && daily.revenue.at(-1)?.bucketStart === '2019-06-30')
    check(
      'only the two paid days carry revenue',
      daily.revenue.filter((p) => p.gross > 0).length === 2,
    )
    check('…and the empty days are genuinely zero, not absent', daily.revenue.filter((p) => p.gross === 0 && p.invoices === 0).length === 28)
    check('…and the daily series reconciles with the monthly one', daily.revenue.reduce((s, p) => s + p.gross, 0) === 1500)
    // Found by DATE, not by position. `.at(-1)` worked only while the series
    // stopped at the last day carrying a document; the spine now runs to 30
    // June, so the last element is a silent day.
    check(
      'the credit note lands on its own day',
      daily.revenue.find((p) => p.bucketStart === '2019-06-22')?.creditsIssued === 250,
    )
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('5. the tenant drill-down')
  // ══════════════════════════════════════════════════════════════════════════
  {
    const detail = await getTenantBillingDetail(T_ANNUAL, ownerDb)
    check('the tenant is found', detail?.tenant.id === T_ANNUAL)
    check('the current plan is shown', detail?.subscription?.planName.includes('Annual') === true)
    check('with its billing period', detail?.subscription?.billingPeriod === 'annual')
    check('and its status', detail?.subscription?.status === 'active')
    check('and its period end', detail?.subscription?.currentPeriodEnd instanceof Date)
    check(
      'the MRR contribution uses the SAME normalisation as the platform total',
      detail?.subscription?.mrr === 1000,
    )
    check('an admin-assigned subscription is marked as having no mandate', detail?.subscription?.gatewayBacked === false)
    check('the sellable catalogue is offered for a plan change', (detail?.catalogue.length ?? 0) >= 2)

    const trial = await getTenantBillingDetail(T_TRIAL, ownerDb)
    check('a trial is identified as one', trial?.subscription?.isTrial === true)

    const revenue = await getTenantBillingDetail(T_REV, ownerDb)
    check('recent invoices are listed', (revenue?.invoices.length ?? 0) === 4)
    check(
      'a paid invoice with a gateway payment is refundable',
      revenue?.invoices.find((i) => i.id === paidInvoiceId)?.refundable === 1000,
    )
    check(
      'a credit note is NOT refundable',
      revenue?.invoices.find((i) => i.kind === 'credit_note')?.refundable === 0,
    )
    check(
      'a void invoice is NOT refundable',
      revenue?.invoices.find((i) => i.status === 'void')?.refundable === 0,
    )
    check('an unknown tenant is null, not a crash', (await getTenantBillingDetail(ADMIN.id, ownerDb)) === null)
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('6. manual overrides, each audited exactly once')
  // ══════════════════════════════════════════════════════════════════════════
  const auditsFor = async (tenantId: string, action: string) =>
    (
      await ownerPool.query<{ id: string; before: unknown; after: Record<string, unknown> }>(
        `select id, "before", "after" from audit_log where tenant_id=$1 and action=$2 order by created_at`,
        [tenantId, action],
      )
    ).rows

  {
    // ── change plan ────────────────────────────────────────────────────────
    const before = await getTenantBillingDetail(T_MONTHLY, ownerDb)
    const r = await assignPlan({ tenantId: T_MONTHLY, planId: PLAN_A, billingPeriod: 'annual' })
    const after = await getTenantBillingDetail(T_MONTHLY, ownerDb)

    check('the plan change succeeds', !r.error)
    check('the tenant is on the new plan', after?.subscription?.planId === PLAN_A)
    check('on the new billing period', after?.subscription?.billingPeriod === 'annual')
    check('the old subscription is closed, not deleted', before?.subscription?.id !== after?.subscription?.id)
    const closed = await ownerPool.query(
      `select status, cancelled_at from tenant_subscriptions where id=$1`,
      [before?.subscription?.id],
    )
    check('…and kept as history', closed.rows[0].status === 'cancelled' && closed.rows[0].cancelled_at !== null)

    const a = await auditsFor(T_MONTHLY, 'change_plan')
    check('exactly one change_plan audit entry', a.length === 1)
    check('it names the platform admin', a[0].after.actorEmail === ADMIN.email)
    check('…as a platform admin, not a member', a[0].after.actorKind === 'platform_admin' )
    check('it carries the before state', (a[0].before as Record<string, unknown>).subscriptionId === before?.subscription?.id)
    check('and the after state', a[0].after.planId === PLAN_A)
  }

  {
    // ── extend trial ───────────────────────────────────────────────────────
    const before = await getTenantBillingDetail(T_TRIAL, ownerDb)
    const r = await actions.extendTrialAction({ tenantId: T_TRIAL, days: 14, reason: 'goodwill' })
    const after = await getTenantBillingDetail(T_TRIAL, ownerDb)

    check('the trial extension succeeds', !r.error)
    const delta =
      (after?.subscription?.currentPeriodEnd.getTime() ?? 0) -
      (before?.subscription?.currentPeriodEnd.getTime() ?? 0)
    check('the period end moves by exactly 14 days', Math.round(delta / DAY_MS) === 14)

    const a = await auditsFor(T_TRIAL, 'extend_trial')
    check('exactly one extend_trial audit entry', a.length === 1)
    check('with the actor', a[0].after.actorEmail === ADMIN.email)
    check('the previous end', (a[0].before as Record<string, unknown>).currentPeriodEnd === before?.subscription?.currentPeriodEnd.toISOString())
    check('and the new one', a[0].after.currentPeriodEnd === after?.subscription?.currentPeriodEnd.toISOString())

    // Not a trial → refused.
    const notTrial = await actions.extendTrialAction({ tenantId: T_ANNUAL, days: 5 })
    check('extending a non-trial subscription is refused', /not a trial/i.test(notTrial.error ?? ''))
    check('…and writes no audit entry', (await auditsFor(T_ANNUAL, 'extend_trial')).length === 0)

    // Gateway-backed → refused, because Razorpay would overwrite it.
    const T_GW = await makeTenant('gwt', 'trial')
    await makeSub(T_GW, PLAN_M, { status: 'trialing', gatewaySubscriptionId: `sub_114${tag}` })
    const gw = await actions.extendTrialAction({ tenantId: T_GW, days: 5 })
    check('extending a Razorpay-managed trial is refused', /managed by Razorpay/i.test(gw.error ?? ''))

    const bad = await actions.extendTrialAction({ tenantId: T_TRIAL, days: 0 })
    check('zero days is refused', Boolean(bad.error))
    const tooMany = await actions.extendTrialAction({ tenantId: T_TRIAL, days: 5000 })
    check('an absurd extension is refused', Boolean(tooMany.error))
  }

  {
    // ── comp / discount ────────────────────────────────────────────────────
    const r = await actions.compTenantAction({
      tenantId: T_ANNUAL,
      amount: 750,
      reason: 'outage credit',
    })
    check('the comp succeeds', !r.error)
    check('it returns a credit note number', Boolean(r.creditNoteNumber))

    const notes = await ownerPool.query<{ kind: string; status: string; total: string; notes: string }>(
      `select kind, status, total, notes from platform_invoices where tenant_id=$1 and kind='credit_note'`,
      [T_ANNUAL],
    )
    check('a CREDIT NOTE is what a comp is — not a new discount model', notes.rows.length === 1)
    check('it is outstanding until it is applied', notes.rows[0].status === 'issued')
    check('for the full amount', Number(notes.rows[0].total) === 750)
    check('and says it was a comp', /Comp: outage credit/.test(notes.rows[0].notes))

    const a = await auditsFor(T_ANNUAL, 'comp_or_discount')
    check('exactly one comp audit entry', a.length === 1)
    check('with the actor', a[0].after.actorEmail === ADMIN.email)
    check('and the documented application point', a[0].after.appliesTo === 'next_invoice')

    const noSub = await makeTenant('nosub')
    const refused = await actions.compTenantAction({ tenantId: noSub, amount: 10, reason: 'x' })
    check('a comp on a tenant with no live subscription is refused', /no live subscription/i.test(refused.error ?? ''))
    const noReason = await actions.compTenantAction({ tenantId: T_ANNUAL, amount: 10, reason: '  ' })
    check('a comp with no reason is refused', Boolean(noReason.error))
    const negative = await actions.compTenantAction({ tenantId: T_ANNUAL, amount: -5, reason: 'x' })
    check('a negative comp is refused', Boolean(negative.error))
  }

  {
    // ── force cancel ───────────────────────────────────────────────────────
    const T_FC = await makeTenant('fc')
    const sub = await makeSub(T_FC, PLAN_M, { status: 'active' })
    const invoicesBefore = (
      await ownerPool.query('select count(*)::int c from platform_invoices where tenant_id=$1', [T_FC])
    ).rows[0].c

    const r = await actions.forceCancelAction({ tenantId: T_FC, reason: 'support request' })
    check('force cancel succeeds', !r.error)

    const row = (await ownerPool.query('select * from tenant_subscriptions where id=$1', [sub])).rows[0]
    check('an admin-assigned subscription is closed immediately', row.status === 'cancelled')
    check('cancelled_at is set (the 0050 CHECK requires it)', row.cancelled_at !== null)
    check('the row is kept, not deleted', row.id === sub)
    check(
      'the company account is NOT closed — that is a separate decision',
      (await ownerPool.query('select status from tenants where id=$1', [T_FC])).rows[0].status === 'active',
    )
    check(
      'historical invoices are untouched',
      (await ownerPool.query('select count(*)::int c from platform_invoices where tenant_id=$1', [T_FC])).rows[0].c ===
        invoicesBefore,
    )

    const a = await auditsFor(T_FC, 'force_cancel')
    check('exactly one force_cancel audit entry', a.length === 1)
    check('with the actor', a[0].after.actorEmail === ADMIN.email)
    check('recording that it was immediate', a[0].after.immediate === true && a[0].after.atPeriodEnd === false)

    const again = await actions.forceCancelAction({ tenantId: T_FC })
    check('cancelling an already-cancelled subscription is refused', /no live subscription/i.test(again.error ?? ''))
    check('…and writes no second audit entry', (await auditsFor(T_FC, 'force_cancel')).length === 1)

    // ── the GATEWAY-BACKED path, with the Razorpay call faked ─────────────
    //
    // Driven through the domain function so the cancel seam can be injected.
    // What is under test is the at-period-end-vs-immediate rule and the fact
    // that Razorpay is told FIRST.
    const cancels: { subscriptionId: string; atCycleEnd: boolean }[] = []
    const fakeCancel = {
      credentials: async () => ({ keyId: 'rzp_test_platform', keySecret: PLATFORM_KEY_SECRET }),
      cancelSubscription: async (
        _c: { keyId: string; keySecret: string },
        subscriptionId: string,
        atCycleEnd: boolean,
      ) => {
        cancels.push({ subscriptionId, atCycleEnd })
        return {
          id: subscriptionId,
          plan_id: 'plan_x',
          customer_id: null,
          status: atCycleEnd ? 'active' : 'cancelled',
          current_start: null,
          current_end: null,
          charge_at: null,
          short_url: null,
          paid_count: 1,
          total_count: 12,
        }
      },
    }
    const who = { userId: ADMIN.id, email: ADMIN.email }

    const T_GWC = await makeTenant('gwc')
    const gwSub = `sub_fc${tag}`
    await makeSub(T_GWC, PLAN_M, { status: 'active', gatewaySubscriptionId: gwSub })

    const atEnd = await overrides.forceCancelTenantSubscription(
      who,
      { tenantId: T_GWC, reason: 'default rule' },
      fakeCancel,
      ownerDb,
    )
    check('a charged subscription cancels AT THE END of the paid period', atEnd.atPeriodEnd === true)
    check('Razorpay was told, at cycle end', cancels.at(-1)?.atCycleEnd === true)
    check(
      'the local row stays live until the webhook confirms',
      (await ownerPool.query('select status, cancel_at_period_end from tenant_subscriptions where gateway_subscription_id=$1', [gwSub])).rows[0].status === 'active',
    )
    check(
      '…with the intent recorded',
      (await ownerPool.query('select cancel_at_period_end from tenant_subscriptions where gateway_subscription_id=$1', [gwSub])).rows[0].cancel_at_period_end === true,
    )
    const gwAudit = await auditsFor(T_GWC, 'force_cancel')
    check('exactly one audit entry, recording the timing actually used', gwAudit.length === 1 && gwAudit[0].after.atPeriodEnd === true && gwAudit[0].after.immediate === false)

    const T_GWI = await makeTenant('gwi')
    const gwSub2 = `sub_fci${tag}`
    await makeSub(T_GWI, PLAN_M, { status: 'active', gatewaySubscriptionId: gwSub2 })
    const now = await overrides.forceCancelTenantSubscription(
      who,
      { tenantId: T_GWI, immediate: true, reason: 'fraud' },
      fakeCancel,
      ownerDb,
    )
    check('the platform-admin override ends it immediately', now.atPeriodEnd === false)
    check('…and Razorpay is told cancel_at_cycle_end = 0', cancels.at(-1)?.atCycleEnd === false)
    check(
      'the audit records that the override was used',
      (await auditsFor(T_GWI, 'force_cancel'))[0].after.immediate === true,
    )
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('7. refunds')
  // ══════════════════════════════════════════════════════════════════════════
  let gatewayRefundId = ''
  {
    const gatewayCalls: { paymentId: string; amountPaise: number; idempotencyKey?: string }[] = []
    let refundSeq = 0
    const okGateway = {
      credentials: async () => ({ keyId: 'rzp_test_platform', keySecret: PLATFORM_KEY_SECRET }),
      refundPayment: async (
        _c: { keyId: string; keySecret: string },
        p: { paymentId: string; amountPaise: number; idempotencyKey?: string },
      ) => {
        gatewayCalls.push(p)
        return {
          id: `rfnd_114${tag}${++refundSeq}`,
          payment_id: p.paymentId,
          amount: p.amountPaise,
          currency: CUR,
          // Razorpay usually reports a fresh refund as pending; the webhook
          // settles it. Modelled faithfully rather than jumping to processed.
          status: 'pending',
        }
      },
    }
    const actor = { userId: ADMIN.id, email: ADMIN.email }

    const first = await refundsMod.refundPlatformInvoice(
      actor,
      { invoiceId: paidInvoiceId, amount: 400, reason: 'partial goodwill', requestKey: `rk1-${tag}` },
      okGateway,
      ownerDb,
    )
    gatewayRefundId = first.gatewayRefundId ?? ''

    check('a partial refund is accepted', first.status === 'pending' && first.amount === 400)
    check('the gateway was called once', gatewayCalls.length === 1)
    check('in PAISE', gatewayCalls[0].amountPaise === 40_000)
    check('against the payment on OUR invoice', gatewayCalls[0].paymentId === `pay_114${tag}`)
    check('with our refund id as the gateway idempotency key', gatewayCalls[0].idempotencyKey === first.refundId)
    check('the gateway reference is stored', Boolean(first.gatewayRefundId))

    // ── the duplicate-request guard ───────────────────────────────────────
    const dup = await refundsMod.refundPlatformInvoice(
      actor,
      { invoiceId: paidInvoiceId, amount: 400, reason: 'partial goodwill', requestKey: `rk1-${tag}` },
      okGateway,
      ownerDb,
    )
    check('the same request key returns the SAME refund', dup.refundId === first.refundId)
    check('…is reported as deduplicated', dup.deduplicated === true)
    check('…and does not call the gateway again', gatewayCalls.length === 1)
    const rowCount = (
      await ownerPool.query('select count(*)::int c from platform_refunds where invoice_id=$1', [paidInvoiceId])
    ).rows[0].c
    check('…so there is exactly one refund row', rowCount === 1)

    // ── the over-refund guard ─────────────────────────────────────────────
    let over: unknown = null
    try {
      await refundsMod.refundPlatformInvoice(
        actor,
        { invoiceId: paidInvoiceId, amount: 700, reason: 'too much', requestKey: `rk2-${tag}` },
        okGateway,
        ownerDb,
      )
    } catch (e) {
      over = e
    }
    check('refunding more than remains is refused', over instanceof refundsMod.PlatformRefundError)
    check('…naming what is left', /600\.00 remains/.test((over as Error).message))
    check('…and the gateway was not called', gatewayCalls.length === 1)

    // A pending refund RESERVES its amount, so the balance already reflects it.
    const remaining = await refundsMod.refundedForInvoice(ownerDb, paidInvoiceId)
    check('a pending refund reserves against the invoice', remaining === 400)

    // Exactly the remainder is allowed.
    const rest = await refundsMod.refundPlatformInvoice(
      actor,
      { invoiceId: paidInvoiceId, amount: 600, reason: 'the rest', requestKey: `rk3-${tag}` },
      okGateway,
      ownerDb,
    )
    check('refunding exactly the remainder is allowed', rest.amount === 600)
    let exhausted: unknown = null
    try {
      await refundsMod.refundPlatformInvoice(
        actor,
        { invoiceId: paidInvoiceId, amount: 1, reason: 'more', requestKey: `rk4-${tag}` },
        okGateway,
        ownerDb,
      )
    } catch (e) {
      exhausted = e
    }
    check('a fully-refunded invoice refuses everything further', /already been fully refunded/i.test((exhausted as Error).message))

    // ── a refused gateway RELEASES the reservation ────────────────────────
    const refusing = {
      credentials: okGateway.credentials,
      refundPayment: async () => {
        throw new RazorpayApiError('The payment gateway rejected the request.', 400, false)
      },
    }
    const other = (
      await ownerPool.query<{ id: string }>(
        `select id from platform_invoices where tenant_id=$1 and kind='subscription' and status='paid' and id <> $2 limit 1`,
        [T_REV, paidInvoiceId],
      )
    ).rows[0].id
    let refusedErr: unknown = null
    try {
      await refundsMod.refundPlatformInvoice(
        { userId: ADMIN.id, email: ADMIN.email },
        { invoiceId: other, amount: 100, reason: 'will fail', requestKey: `rk5-${tag}` },
        refusing,
        ownerDb,
      )
    } catch (e) {
      refusedErr = e
    }
    check('a gateway refusal surfaces as an error', refusedErr instanceof refundsMod.PlatformRefundError)
    const failedRow = (
      await ownerPool.query<{ status: string }>(
        `select status from platform_refunds where request_key=$1`,
        [`rk5-${tag}`],
      )
    ).rows[0]
    check('the refund is marked failed', failedRow.status === 'failed')
    check(
      '…which RELEASES the amount back to the invoice',
      (await refundsMod.refundedForInvoice(ownerDb, other)) === 0,
    )

    // ── non-refundable targets ────────────────────────────────────────────
    const creditNote = (
      await ownerPool.query<{ id: string }>(
        `select id from platform_invoices where tenant_id=$1 and kind='credit_note' limit 1`,
        [T_REV],
      )
    ).rows[0].id
    let cnErr: unknown = null
    try {
      await refundsMod.refundPlatformInvoice(
        { userId: ADMIN.id, email: ADMIN.email },
        { invoiceId: creditNote, amount: 10, reason: 'x' },
        okGateway,
        ownerDb,
      )
    } catch (e) {
      cnErr = e
    }
    check('a credit note cannot be refunded', /Only a subscription invoice/i.test((cnErr as Error).message))

    // ── audit ─────────────────────────────────────────────────────────────
    const a = await auditsFor(T_REV, 'refund')
    check('every refund attempt is audited', a.length === 3)
    check('each names the actor', a.every((e) => e.after.actorEmail === ADMIN.email))
    check('each carries the before balance', a.every((e) => typeof (e.before as Record<string, unknown>).refundedBefore === 'number'))
    check('and the amount', a.some((e) => e.after.amount === 400))
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('8. the webhook settles a refund')
  // ══════════════════════════════════════════════════════════════════════════
  {
    const body = (event: string, refundId: string) =>
      JSON.stringify({
        entity: 'event',
        event,
        contains: ['refund'],
        payload: { refund: { entity: { id: refundId, payment_id: `pay_114${tag}`, status: 'processed' } } },
        created_at: 1755500000,
      })

    async function deliver(raw: string, opts: { signature?: string | null; eventId?: string } = {}) {
      const headers = new Headers({ 'content-type': 'application/json' })
      if (opts.signature !== null) headers.set('x-razorpay-signature', opts.signature ?? '')
      if (opts.eventId) headers.set('x-razorpay-event-id', opts.eventId)
      headers.set('host', ROOT)
      const res = await POST(
        new NextRequest(`https://${ROOT}/api/webhooks/platform-razorpay`, {
          method: 'POST',
          headers,
          body: raw,
        }),
      )
      return { status: res.status, body: (await res.json()) as { status?: string } }
    }

    const raw = body('refund.processed', gatewayRefundId)
    const bad = await deliver(raw, { signature: 'nope', eventId: `evt114x${tag}` })
    check('an unsigned refund webhook is rejected', bad.status === 401)
    check(
      '…and settles nothing',
      (
        await ownerPool.query<{ status: string }>('select status from platform_refunds where gateway_refund_id=$1', [
          gatewayRefundId,
        ])
      ).rows[0].status === 'pending',
    )

    const good = await deliver(raw, { signature: sign(raw, PLATFORM_SECRET), eventId: `evt114a${tag}` })
    check('a verified refund.processed is accepted', good.status === 200 && good.body.status === 'processed')
    check(
      'the refund is settled',
      (
        await ownerPool.query<{ status: string }>('select status from platform_refunds where gateway_refund_id=$1', [
          gatewayRefundId,
        ])
      ).rows[0].status === 'processed',
    )

    const replay = await deliver(raw, { signature: sign(raw, PLATFORM_SECRET), eventId: `evt114a${tag}` })
    check('a redelivery is a duplicate, not a second settlement', replay.body.status === 'duplicate')

    // A LATER refund.failed must not un-process a settled refund.
    const late = body('refund.failed', gatewayRefundId)
    const lateRes = await deliver(late, { signature: sign(late, PLATFORM_SECRET), eventId: `evt114b${tag}` })
    check('a late contradicting event is refused — terminal is terminal', lateRes.body.status === 'duplicate')
    check(
      '…and the refund stays processed',
      (
        await ownerPool.query<{ status: string }>('select status from platform_refunds where gateway_refund_id=$1', [
          gatewayRefundId,
        ])
      ).rows[0].status === 'processed',
    )

    const unknown = body('refund.processed', `rfnd_never_seen_${tag}`)
    const unknownRes = await deliver(unknown, { signature: sign(unknown, PLATFORM_SECRET), eventId: `evt114c${tag}` })
    check('a refund we never created is ignored, never invented', unknownRes.body.status === 'ignored')

    // ── and it shows up in the revenue series ─────────────────────────────
    await ownerPool.query(
      `update platform_refunds set created_at = '2019-06-25T12:00:00+05:30'::timestamptz where gateway_refund_id=$1`,
      [gatewayRefundId],
    )
    const d = await metrics.getPlatformBillingDashboard({
      range: { start: '2019-06-01', end: '2019-06-30' },
      bucket: 'month',
      db: ownerDb,
    })
    check('a PROCESSED refund is deducted from net revenue', d.revenueTotals.refunded === 400)
    check('…leaving gross unchanged', d.revenueTotals.gross === 1500)
    check('…and net = gross − refunded', d.revenueTotals.net === 1100)
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('9. authorization and tenant isolation')
  // ══════════════════════════════════════════════════════════════════════════
  {
    const OWNER_A = await makeOwner(T_REV, 'a')
    const OWNER_B = await makeOwner(T_ANNUAL, 'b')

    // ── a signed-in NON-admin ─────────────────────────────────────────────
    signedInAs(OUTSIDER.token)

    let dashErr: unknown = null
    try {
      await metrics.getPlatformBillingDashboard({ range, bucket: 'month', db: ownerDb })
    } catch (e) {
      dashErr = e
    }
    check('a non-admin cannot read the dashboard', dashErr instanceof PlatformError)

    let detailErr: unknown = null
    try {
      await getTenantBillingDetail(T_REV, ownerDb)
    } catch (e) {
      detailErr = e
    }
    check('a non-admin cannot read a tenant drill-down', detailErr instanceof PlatformError)

    // Every mutation, called DIRECTLY — the way a crafted POST would.
    const asOutsider = await Promise.all([
      assignPlan({ tenantId: T_REV, planId: PLAN_M, billingPeriod: 'monthly' }),
      actions.extendTrialAction({ tenantId: T_TRIAL, days: 30 }),
      actions.compTenantAction({ tenantId: T_ANNUAL, amount: 5000, reason: 'free money' }),
      actions.refundInvoiceAction({ invoiceId: paidInvoiceId, amount: 10, reason: 'mine now' }),
      actions.forceCancelAction({ tenantId: T_ANNUAL }),
    ])
    check(
      'a non-admin is refused by EVERY mutation action',
      asOutsider.every((r) => /Platform administrators only/i.test(r.error ?? '')),
    )

    const compsAfter = await ownerPool.query(
      `select count(*)::int c from platform_invoices where tenant_id=$1 and kind='credit_note'`,
      [T_ANNUAL],
    )
    check('…and nothing happened', compsAfter.rows[0].c === 1)

    // ── signed out entirely ───────────────────────────────────────────────
    signedInAs(undefined)
    const anon = await actions.compTenantAction({ tenantId: T_ANNUAL, amount: 1, reason: 'x' })
    check('an anonymous caller is refused', /Not signed in/i.test(anon.error ?? ''))

    signedInAs(ADMIN.token)
    const ok = await getTenantBillingDetail(T_REV, ownerDb)
    check('…while the platform admin still works', ok?.tenant.id === T_REV)

    // ── tenant-side RLS ───────────────────────────────────────────────────
    const asUser = async (userId: string, sqlText: string, p: unknown[]) => {
      const c = await appPool.connect()
      try {
        await c.query('begin')
        await c.query('select set_config($1,$2,true)', ['app.user_id', userId])
        const r = await c.query(sqlText, p)
        await c.query('commit')
        return r.rows
      } finally {
        c.release()
      }
    }

    check(
      "an owner sees their own tenant's refunds",
      (await asUser(OWNER_A, 'select id from platform_refunds where tenant_id=$1', [T_REV])).length > 0,
    )
    check(
      "…and NOT another tenant's",
      (await asUser(OWNER_B, 'select id from platform_refunds where tenant_id=$1', [T_REV])).length === 0,
    )
    check(
      "…nor another tenant's invoices",
      (await asUser(OWNER_B, 'select id from platform_invoices where tenant_id=$1', [T_REV])).length === 0,
    )
    check(
      "…nor another tenant's subscription",
      (await asUser(OWNER_B, 'select id from tenant_subscriptions where tenant_id=$1', [T_REV])).length === 0,
    )

    const refused = async (sqlText: string, p: unknown[]) => {
      const c = await appPool.connect()
      try {
        await c.query('begin')
        await c.query('select set_config($1,$2,true)', ['app.user_id', OWNER_A])
        await c.query(sqlText, p)
        await c.query('commit')
        return false
      } catch {
        await c.query('rollback').catch(() => {})
        return true
      } finally {
        c.release()
      }
    }

    check(
      'a business cannot mint itself a refund',
      await refused(
        `insert into platform_refunds (tenant_id, invoice_id, gateway_payment_id, amount, reason)
         values ($1,$2,'pay_x',1,'free')`,
        [T_REV, paidInvoiceId],
      ),
    )
    check(
      'a business cannot mark its own refund processed',
      await refused(`update platform_refunds set status='processed' where tenant_id=$1`, [T_REV]),
    )
    check(
      'a business cannot delete the record of a refund',
      await refused('delete from platform_refunds where tenant_id=$1', [T_REV]),
    )
    check(
      'a business cannot read the whole platform plan catalogue price list of retired plans',
      // plans_select_active exposes only LIVE plans; this asserts the app role
      // cannot write them, which is the part that matters for billing.
      await refused(`update plans set monthly_price = 0 where id=$1`, [PLAN_M]),
    )
    check(
      'the app role cannot read platform_payment_settings at all',
      await refused('select razorpay_key_secret_encrypted from platform_payment_settings', []),
    )

    // ── no secret leaves the server ───────────────────────────────────────
    const payload = JSON.stringify(await getTenantBillingDetail(T_REV, ownerDb))
    check('the drill-down payload carries no key secret', !payload.includes(PLATFORM_KEY_SECRET))
    check('…no webhook secret', !payload.includes(PLATFORM_SECRET))
    check('…and no ciphertext', !/"v1:/.test(payload))

    const dashPayload = JSON.stringify(
      await metrics.getPlatformBillingDashboard({ range, bucket: 'month', db: ownerDb }),
    )
    check('the dashboard payload carries no secret either', !dashPayload.includes(PLATFORM_KEY_SECRET) && !dashPayload.includes(PLATFORM_SECRET))
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('10. existing data is untouched')
  // ══════════════════════════════════════════════════════════════════════════
  {
    const d = await metrics.getPlatformBillingDashboard({ range, bucket: 'month', db: ownerDb })
    check('the mix still sums to the tenant count', d.mix.trialing + d.mix.active + d.mix.pastDue + d.mix.suspended + d.mix.cancelled + d.mix.noPlan === d.mix.tenants)
    check('no tenant appears twice in the table', new Set(d.tenants.map((t) => t.tenantId)).size === d.tenants.length)
    check(
      'every tenant MRR is non-negative',
      d.tenants.every((t) => t.mrr >= 0),
    )
    check(
      'the tenant MRR column sums to the currency total',
      Math.abs(
        d.tenants.filter((t) => t.currency === CUR).reduce((s, t) => s + t.mrr, 0) -
          (d.mrr.find((m) => m.currency === CUR)?.mrr ?? 0),
      ) < 0.01,
    )
    check('the default bucket for 90 days is weekly', metrics.defaultBucketFor(range, 90) === 'week')
    check('…for a fortnight, daily', metrics.defaultBucketFor(range, 14) === 'day')
    check('…and for a year, monthly', metrics.defaultBucketFor(range, 365) === 'month')
  }

  // ── cleanup ───────────────────────────────────────────────────────────────
  signedInAs(undefined)
  await ownerPool.query('delete from platform_refunds where tenant_id = any($1)', [tenantIds])
  await ownerPool.query('delete from platform_dunning_notices where tenant_id = any($1)', [tenantIds])
  await ownerPool.query('delete from platform_invoices where tenant_id = any($1)', [tenantIds])
  await ownerPool.query(`delete from webhook_events where event_id like $1`, [`evt114%${tag}`])
  await ownerPool.query('delete from tenants where id = any($1)', [tenantIds])
  await ownerPool.query('delete from plans where id = any($1)', [planIds])
  await ownerPool.query('delete from users where id = any($1)', [userIds])
  await ownerPool.query('delete from platform_payment_settings where id=true')
  await ownerPool.end()
  await appPool.end()

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error('test harness error:', e instanceof Error ? `${e.name}: ${e.message}` : 'unknown', e)
  process.exit(1)
})
