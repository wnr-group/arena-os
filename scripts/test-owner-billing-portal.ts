/**
 * M16 #5 — the owner billing portal, against a real database.
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs scripts/test-owner-billing-portal.ts
 *
 * ── What is real and what is faked ──────────────────────────────────────────
 *
 * REAL: the database, every RLS policy and grant, the actual getBillingPortal()
 * reader driven inside a real withUser() transaction as a real member, the
 * actual previewPlanChangeFor() / paymentMethodUpdateFlow() /
 * subscribeTenantToPlan() / cancelTenantSubscription() code paths, and the
 * entitlement interpreters the rest of the app enforces with.
 *
 * FAKED: only the HTTP calls to Razorpay, through the seams those modules
 * already expose.
 *
 * The role probes matter most here: the portal is owner-only, and "a manager
 * cannot" has to be proved against the DATABASE, not against a redirect.
 */
import { randomBytes } from 'node:crypto'
import { Pool } from 'pg'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { sql } from 'drizzle-orm'
import * as schema from '../db/schema'
import { loadEnv } from './env'

loadEnv()

type Db = NodePgDatabase<typeof schema>

let pass = 0,
  fail = 0
const check = (l: string, c: boolean) => {
  console.log(`${c ? '✓' : '✗ FAIL'}  ${l}`)
  if (c) pass++
  else fail++
}
const section = (s: string) => console.log(`\n── ${s} ──`)

async function main() {
  const { getBillingPortal } = await import('../lib/platform/billing/portal')
  const { previewPlanChangeFor, PreviewError } = await import('../lib/platform/billing/preview')
  const { paymentMethodUpdateFlow } = await import('../lib/platform/billing/payment-method')
  const { subscribeTenantToPlan } = await import('../lib/platform/billing/subscribe')
  const { cancelTenantSubscription } = await import('../lib/platform/billing/cancel')
  const { encryptSecret } = await import('../lib/security/encryption')

  const ownerPool = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })
  const appPool = new Pool({ connectionString: process.env.DATABASE_URL })
  const app = drizzle(appPool, { schema })
  const ownerDb = drizzle(ownerPool, { schema })

  const PLATFORM_KEY_SECRET = `rzpsecret_${randomBytes(12).toString('hex')}`
  const TENANT_KEY_SECRET = `tenantsecret_${randomBytes(12).toString('hex')}`

  /** Same contract as db/index.ts:withUser — an ActiveContext stand-in. */
  const ctxFor = (userId: string, tenantId: string) =>
    ({ user: { id: userId }, tenant: { id: tenantId } }) as never

  async function asUser<T>(userId: string, run: (c: Pool) => Promise<T>): Promise<T> {
    const c = await appPool.connect()
    try {
      await c.query('begin')
      await c.query(`select set_config('app.user_id', $1, true)`, [userId])
      const r = await run(c as unknown as Pool)
      await c.query('commit')
      return r
    } catch (e) {
      await c.query('rollback').catch(() => {})
      throw e
    } finally {
      c.release()
    }
  }

  // ── fake gateway ──────────────────────────────────────────────────────────
  const gatewayPlanPrices = new Map<string, { amount: number; currency: string; period: string }>()
  let seq = 0
  const gatewayCalls: { fn: string; args: unknown }[] = []
  const tag = randomBytes(4).toString('hex')

  const fakeGateway = () => ({
    credentials: async () => ({ keyId: 'rzp_test_platform', keySecret: PLATFORM_KEY_SECRET }),
    fetchPlan: async (_c: unknown, planId: string) => {
      const p = gatewayPlanPrices.get(planId)!
      return { id: planId, period: p.period, interval: 1, item: { amount: p.amount, currency: p.currency } }
    },
    createCustomer: async (_c: unknown, params: { email: string }) => ({
      id: `cust_BP${tag}${String(++seq).padStart(4, '0')}`,
      email: params.email,
    }),
    createSubscription: async (
      _c: { keySecret: string },
      params: { planId: string; customerId: string; totalCount: number },
    ) => {
      gatewayCalls.push({ fn: 'createSubscription', args: { ...params, keySecret: _c.keySecret } })
      return {
        id: `sub_BP${tag}${String(++seq).padStart(4, '0')}`,
        plan_id: params.planId,
        customer_id: params.customerId,
        status: 'created',
        current_start: null,
        current_end: null,
        charge_at: null,
        short_url: `https://rzp.io/i/hosted${seq}`,
        paid_count: 0,
        total_count: params.totalCount,
      }
    },
    cancelSubscription: async (_c: unknown, subscriptionId: string, atCycleEnd: boolean) => {
      gatewayCalls.push({ fn: 'cancelSubscription', args: { subscriptionId, atCycleEnd } })
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
  })

  const fakePmGateway = () => ({
    credentials: async () => ({ keyId: 'rzp_test_platform', keySecret: PLATFORM_KEY_SECRET }),
    fetchSubscription: async (c: { keySecret: string }, subscriptionId: string) => {
      gatewayCalls.push({ fn: 'fetchSubscription', args: { subscriptionId, keySecret: c.keySecret } })
      return {
        id: subscriptionId,
        plan_id: 'plan_x',
        customer_id: null,
        status: 'halted',
        current_start: null,
        current_end: null,
        charge_at: null,
        short_url: 'https://rzp.io/i/reauth',
        paid_count: 1,
        total_count: 120,
      }
    },
  })

  // ── fixtures ──────────────────────────────────────────────────────────────
  await ownerPool.query(`delete from tenants where slug like 'tbp%'`)
  await ownerPool.query(`delete from plans where name like 'ZZ BP %'`)

  const created: string[] = []
  const planIds: string[] = []

  async function makeTenant(slug: string) {
    const t = await ownerPool.query<{ id: string }>(
      `insert into tenants (slug,name,status,timezone) values ($1,$2,'active','Asia/Kolkata') returning id`,
      [slug, `${slug} co`],
    )
    const tenantId = t.rows[0].id
    created.push(tenantId)
    const b = await ownerPool.query<{ id: string }>(
      `insert into branches (tenant_id,name,is_primary) values ($1,'Main',true) returning id`,
      [tenantId],
    )
    const mk = async (email: string, role: string) => {
      const u = await ownerPool.query<{ id: string }>(
        `insert into users (email,password_hash,full_name) values ($1,'x',$2) returning id`,
        [email, role],
      )
      await ownerPool.query(
        `insert into memberships (tenant_id,user_id,branch_id,role,status,full_name,email)
         values ($1,$2,$3,$4,'active',$5,$6)`,
        [tenantId, u.rows[0].id, b.rows[0].id, role, role, email],
      )
      return u.rows[0].id
    }
    const ownerId = await mk(`${slug}-own@example.test`, 'owner')
    const managerId = await mk(`${slug}-mgr@example.test`, 'manager')
    const cashierId = await mk(`${slug}-cash@example.test`, 'cashier')

    // The venue's OWN Razorpay keys, present throughout so every "the platform
    // flow did not use these" assertion has something real to fail against.
    await ownerPool.query(
      `insert into payment_settings (tenant_id, razorpay_key_id, razorpay_key_secret_encrypted)
       values ($1,$2,$3)`,
      [tenantId, `rzp_test_TENANT_${slug}`, encryptSecret(TENANT_KEY_SECRET, tenantId)],
    )
    return { tenantId, slug, ownerId, managerId, cashierId, branchId: b.rows[0].id }
  }

  async function makePlan(
    name: string,
    monthly: string,
    annual: string,
    ents: Record<string, number | boolean | null>,
  ) {
    const gwM = `plan_BPM${tag}${planIds.length}`
    const gwA = `plan_BPA${tag}${planIds.length}`
    const r = await ownerPool.query<{ id: string }>(
      `insert into plans (name, monthly_price, annual_price, gateway,
                          gateway_monthly_plan_id, gateway_annual_plan_id)
       values ($1,$2,$3,'razorpay',$4,$5) returning id`,
      [name, monthly, annual, gwM, gwA],
    )
    const id = r.rows[0].id
    planIds.push(id)
    gatewayPlanPrices.set(gwM, { amount: Math.round(Number(monthly) * 100), currency: 'INR', period: 'monthly' })
    gatewayPlanPrices.set(gwA, { amount: Math.round(Number(annual) * 100), currency: 'INR', period: 'yearly' })
    for (const [k, v] of Object.entries(ents)) {
      await ownerPool.query(
        `insert into plan_entitlements (plan_id, key, value) values ($1,$2,$3::jsonb)`,
        [id, k, JSON.stringify(v)],
      )
    }
    return id
  }

  await ownerPool.query(
    `insert into platform_payment_settings (id, razorpay_key_id, razorpay_key_secret_encrypted,
                                            razorpay_webhook_secret_encrypted)
     values (true,'rzp_test_platform',$1,$2)
     on conflict (id) do update set razorpay_key_secret_encrypted = excluded.razorpay_key_secret_encrypted`,
    [
      encryptSecret(PLATFORM_KEY_SECRET, 'platform:razorpay'),
      encryptSecret(`whsec_${randomBytes(8).toString('hex')}`, 'platform:razorpay'),
    ],
  )

  const A = await makeTenant(`tbpa${tag}`.slice(0, 20))
  const B = await makeTenant(`tbpb${tag}`.slice(0, 20))

  const STARTER = await makePlan(`ZZ BP Starter ${tag}`, '2999.00', '29990.00', {
    max_branches: 1,
    max_staff: 5,
    max_resources: 10,
    'module.payroll': false,
    'module.reports': false,
  })
  const PRO = await makePlan(`ZZ BP Pro ${tag}`, '7999.00', '79990.00', {
    max_branches: 3,
    max_staff: 25,
    max_resources: 50,
    'module.payroll': true,
    'module.reports': true,
  })
  const ELITE = await makePlan(`ZZ BP Elite ${tag}`, '19999.00', '199990.00', {
    max_branches: null, // unlimited
    max_staff: null,
    max_resources: null,
    'module.payroll': true,
    'module.reports': true,
  })

  const portalFor = (t: { ownerId: string; tenantId: string }) =>
    getBillingPortal(ctxFor(t.ownerId, t.tenantId))

  const liveSub = async (tenantId: string) =>
    (
      await ownerPool.query(
        `select * from tenant_subscriptions where tenant_id=$1
          and status in ('trialing','active','past_due')
          order by current_period_start desc limit 1`,
        [tenantId],
      )
    ).rows[0]

  // ══════════════════════════════════════════════════════════════════════════
  section('1. no subscription — the fail-safe state, never "unlimited"')
  // ══════════════════════════════════════════════════════════════════════════
  {
    const p = await portalFor(A)
    check('the portal renders with no subscription', p.subscription === null)
    check('…and reports no plan', p.planName === null)
    check('…with no price', p.currentPrice === null)
    check('every counted limit is DENIED, not unlimited', p.limits.every((l) => l.denied))
    check('…and none reports a null (unlimited) cap', p.limits.every((l) => l.limit === 0))
    check('…the reason is "no plan", which is what the guard says too', p.limits.every((l) => l.deniedReason === 'no_plan'))
    check('no modules are listed, because nothing grants any', p.modules.length === 0)
    check('the catalogue is still offered', p.plans.length >= 3)
    check('…and none is marked current', p.plans.every((x) => !x.isCurrent))
    check('there are no invoices yet', p.invoices.length === 0)
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('2. usage counts come from the same functions the guard uses')
  // ══════════════════════════════════════════════════════════════════════════
  {
    // Put A on Starter (1 branch, 5 staff, 10 resources) by hand, the way a
    // platform admin would, so entitlements exist without a gateway.
    await ownerPool.query(
      `insert into tenant_subscriptions (tenant_id, plan_id, billing_period, status, current_period_end)
       values ($1,$2,'monthly','active', now() + interval '30 days')`,
      [A.tenantId, STARTER],
    )
    // A resource type + two resources, so `max_resources` has something to count.
    const rt = await ownerPool.query<{ id: string }>(
      `insert into resource_types (tenant_id, name, hourly_rate) values ($1,'Bay','100.00') returning id`,
      [A.tenantId],
    )
    for (let i = 0; i < 2; i++) {
      await ownerPool.query(
        `insert into resources (tenant_id, branch_id, resource_type_id, name) values ($1,$2,$3,$4)`,
        [A.tenantId, A.branchId, rt.rows[0].id, `Bay ${i + 1}`],
      )
    }

    const p = await portalFor(A)
    check('the plan is now reported', p.planName === `ZZ BP Starter ${tag}`)
    check('…with its monthly price', p.currentPrice === '2999.00')
    check('…and the subscription row', p.subscription?.status === 'active')

    const branches = p.limits.find((l) => l.key === 'max_branches')!
    check('branches: 1 used of 1', branches.used === 1 && branches.limit === 1)
    check('…and it is not denied', !branches.denied)

    const staff = p.limits.find((l) => l.key === 'max_staff')!
    // 3 memberships were created: owner, manager, cashier.
    check('staff counts ACTIVE memberships (3 of 5)', staff.used === 3 && staff.limit === 5)

    const res = p.limits.find((l) => l.key === 'max_resources')!
    check('resources: 2 used of 10', res.used === 2 && res.limit === 10)

    const payroll = p.modules.find((m) => m.key === 'module.payroll')!
    check('a false module flag renders as Disabled', payroll.enabled === false)
    check('…with a derived label', payroll.label === 'Payroll')
    check('the current plan is marked in the catalogue', p.plans.find((x) => x.id === STARTER)?.isCurrent === true)

    // The number shown must be the number the guard compares against.
    const { checkLimitIn } = await import('../lib/platform/entitlement-guard')
    const refused = await app
      .transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.user_id', ${A.ownerId}, true)`)
        try {
          await checkLimitIn(tx as unknown as Db, A.tenantId, 'max_branches', branches.used)
          return null
        } catch (e) {
          return (e as Error).message
        }
      })
      .catch((e) => String(e))
    check('at the cap, the ENFORCEMENT guard refuses the next one', typeof refused === 'string' && /allows 1/.test(refused))
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('3. unlimited is shown as unlimited, not as a big number')
  // ══════════════════════════════════════════════════════════════════════════
  {
    await ownerPool.query(
      `update tenant_subscriptions set plan_id=$1 where tenant_id=$2 and status='active'`,
      [ELITE, A.tenantId],
    )
    const p = await portalFor(A)
    check('an unlimited limit reports null, not 0', p.limits.every((l) => l.limit === null))
    check('…and is not flagged denied', p.limits.every((l) => !l.denied))
    check('usage is still counted', p.limits.find((l) => l.key === 'max_staff')!.used === 3)
    check('an enabled module renders as Enabled', p.modules.find((m) => m.key === 'module.payroll')!.enabled === true)

    // Put A back on Starter for the remaining sections.
    await ownerPool.query(
      `update tenant_subscriptions set plan_id=$1 where tenant_id=$2 and status='active'`,
      [STARTER, A.tenantId],
    )
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('4. a lapsed subscription is not treated as entitled')
  // ══════════════════════════════════════════════════════════════════════════
  {
    await ownerPool.query(
      // BOTH ends move: tenant_subscriptions_period (0050) requires
      // current_period_end > current_period_start, so a lapsed period has to be
      // a real past window rather than an end date dragged behind its start.
      `update tenant_subscriptions set current_period_start = now() - interval '31 days',
              current_period_end = now() - interval '1 day'
        where tenant_id=$1 and status='active'`,
      [A.tenantId],
    )
    const p = await portalFor(A)
    check('the row is still shown (so the owner can see it)', p.subscription !== null)
    check('…flagged lapsed', p.subscription?.lapsed === true)
    check('…but the ENTITLED plan is null', p.planName === null)
    check('…and every limit is denied', p.limits.every((l) => l.denied))

    await ownerPool.query(
      `update tenant_subscriptions set current_period_start = now(),
              current_period_end = now() + interval '30 days'
        where tenant_id=$1 and status='active'`,
      [A.tenantId],
    )
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('5. owner-only, proved against the database')
  // ══════════════════════════════════════════════════════════════════════════
  {
    // Give A a platform invoice to read.
    const sub = await liveSub(A.tenantId)
    await ownerPool.query(
      `insert into platform_invoices (tenant_id, subscription_id, plan_id, invoice_number, invoice_date,
         period, billing_period_start, billing_period_end, billing_period_type, plan_name, plan_price,
         seller_legal_name, buyer_legal_name, subtotal, taxable_value, gst_rate, cgst, sgst, tax_total, total,
         gateway, gateway_payment_id, status)
       values ($1,$2,$3,$4,current_date,'2026-27', now() - interval '30 days', now(),'monthly','Starter','2999.00',
         'Arena OS','A co','2999.00','2541.53',18,'228.74','228.73','457.47','2999.00','razorpay',$5,'paid')`,
      [A.tenantId, sub.id, STARTER, `BP${tag}/2627/000001`, `pay_BP${tag}01`],
    )

    const ownerRows = await asUser(A.ownerId, (c) => c.query('select id from platform_invoices'))
    check('the OWNER can read its own platform invoices', ownerRows.rows.length === 1)

    const mgrRows = await asUser(A.managerId, (c) => c.query('select id from platform_invoices'))
    check('a MANAGER of the same tenant sees none', mgrRows.rows.length === 0)

    const cashRows = await asUser(A.cashierId, (c) => c.query('select id from platform_invoices'))
    check('a CASHIER sees none', cashRows.rows.length === 0)

    const otherRows = await asUser(B.ownerId, (c) =>
      c.query('select id from platform_invoices where tenant_id=$1', [A.tenantId]),
    )
    check("another tenant's OWNER sees none of them", otherRows.rows.length === 0)

    // The reader itself, driven as a manager: RLS must empty it out.
    const managerPortal = await getBillingPortal(ctxFor(A.managerId, A.tenantId))
    check('getBillingPortal() as a manager returns no invoices', managerPortal.invoices.length === 0)

    // The owner's own portal still has it.
    const ownerPortal = await portalFor(A)
    check('…while the owner sees it through the same reader', ownerPortal.invoices.length === 1)
    check('…with the GST figure for the list', ownerPortal.invoices[0].taxTotal === '457.47')
    check('…and the total', ownerPortal.invoices[0].total === '2999.00')

    // No write path at all from the app role.
    const upd = await asUser(A.ownerId, (c) =>
      c
        .query(`update platform_invoices set total='0.00' where tenant_id=$1`, [A.tenantId])
        .then(() => null)
        .catch((e: { code?: string }) => e.code),
    )
    check('not even an owner may rewrite an invoice', upd === '42501')

    const subUpd = await asUser(A.ownerId, (c) =>
      c
        .query(`update tenant_subscriptions set plan_id=$1 where tenant_id=$2`, [ELITE, A.tenantId])
        .then(() => null)
        .catch((e: { code?: string }) => e.code),
    )
    check('…nor change their own plan directly in the database', subUpd === '42501')
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('6. cross-tenant isolation of the whole portal')
  // ══════════════════════════════════════════════════════════════════════════
  {
    const pb = await portalFor(B)
    check("tenant B's portal shows no subscription of A's", pb.subscription === null)
    check('…and no invoices', pb.invoices.length === 0)
    check('…while still seeing the shared catalogue', pb.plans.length >= 3)
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('7. the plan-change preview')
  // ══════════════════════════════════════════════════════════════════════════
  {
    const up = await previewPlanChangeFor(A.tenantId, PRO, 'monthly', ownerDb)
    check('an upgrade is labelled an upgrade', up.direction === 'upgrade')
    check('…naming the current plan', up.current?.planName === `ZZ BP Starter ${tag}`)
    check('…and the target', up.target.planName === `ZZ BP Pro ${tag}`)
    check('…at the target price', up.target.price === '7999.00')
    check('…Razorpay would capture the FULL new price', up.firstChargeAmount === '7999.00')
    check('…and it takes effect immediately', up.effective === 'immediate')
    check('…the admin-assigned plan is flagged as having no mandate', up.current?.adminAssigned === true)
    check('no credit, because this plan was never charged', up.credit === null)
    check('…so the invoice total equals the charge', up.firstInvoiceTotal === '7999.00')

    const down = await previewPlanChangeFor(A.tenantId, STARTER, 'monthly', ownerDb)
    check('choosing the same plan is neither up nor down', down.direction === 'same')

    const annual = await previewPlanChangeFor(A.tenantId, PRO, 'annual', ownerDb)
    check('the ANNUAL period quotes the annual price', annual.target.price === '79990.00')

    // A plan with no gateway mapping must be refused at preview time too.
    const orphan = await ownerPool.query<{ id: string }>(
      `insert into plans (name, monthly_price, annual_price) values ($1,'100.00','1000.00') returning id`,
      [`ZZ BP Orphan ${tag}`],
    )
    planIds.push(orphan.rows[0].id)
    const err = await previewPlanChangeFor(A.tenantId, orphan.rows[0].id, 'monthly', ownerDb).catch(
      (e) => e,
    )
    check('an unmapped plan is refused before any dialog is shown', err instanceof PreviewError)

    await ownerPool.query(`update plans set active=false where id=$1`, [PRO])
    const retired = await previewPlanChangeFor(A.tenantId, PRO, 'monthly', ownerDb).catch((e) => e)
    check('a retired plan is refused', retired instanceof PreviewError)
    await ownerPool.query(`update plans set active=true where id=$1`, [PRO])
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('8. upgrade, downgrade and proration through the real flow')
  // ══════════════════════════════════════════════════════════════════════════
  {
    const C = await makeTenant(`tbpc${tag}`.slice(0, 20))
    gatewayCalls.length = 0

    const first = await subscribeTenantToPlan(
      { tenantId: C.tenantId, planId: PRO, billingPeriod: 'monthly' },
      fakeGateway(),
      ownerDb,
    )
    check('subscribing uses the PLATFORM key secret', (gatewayCalls.find((c) => c.fn === 'createSubscription')!.args as { keySecret: string }).keySecret === PLATFORM_KEY_SECRET)
    check("…and never the tenant's own key secret", (gatewayCalls.find((c) => c.fn === 'createSubscription')!.args as { keySecret: string }).keySecret !== TENANT_KEY_SECRET)

    const pC = await portalFor(C)
    check('the portal now shows the gateway subscription', pC.subscription?.gatewaySubscriptionId === first.gatewaySubscriptionId)
    check('…as trialing until a payment clears', pC.subscription?.status === 'trialing')

    // Pay for a 30-day period that started 15 days ago, so half is unused.
    const sub = await liveSub(C.tenantId)
    await ownerPool.query(
      `update tenant_subscriptions set status='active',
         current_period_start = now() - interval '15 days',
         current_period_end   = now() + interval '15 days'
       where id=$1`,
      [sub.id],
    )
    await ownerPool.query(
      `insert into platform_invoices (tenant_id, subscription_id, plan_id, invoice_number, invoice_date,
         period, billing_period_start, billing_period_end, billing_period_type, plan_name, plan_price,
         seller_legal_name, buyer_legal_name, subtotal, taxable_value, gst_rate, cgst, sgst, tax_total, total,
         gateway, gateway_payment_id, status)
       values ($1,$2,$3,$4,current_date,'2026-27', now() - interval '15 days', now() + interval '15 days',
         'monthly','Pro','7999.00','Arena OS','C co','7999.00','6778.81',18,'610.10','610.09','1220.19','7999.00',
         'razorpay',$5,'paid')`,
      [C.tenantId, sub.id, PRO, `BP${tag}/2627/000900`, `pay_BP${tag}90`],
    )

    const quote = await previewPlanChangeFor(C.tenantId, ELITE, 'monthly', ownerDb)
    check('the preview now finds a proration credit', quote.credit !== null)
    check('…for 15 of 30 unused days', quote.credit?.unusedDays === 15 && quote.credit?.periodDays === 30)
    check('…worth half the paid amount', quote.credit?.amount === '3999.50')
    check('…the charge is still the FULL new price', quote.firstChargeAmount === '19999.00')
    // The credit is REPORTED but never netted off. Nothing reduces what
    // Razorpay captures, and issueSubscriptionInvoice() writes adjustment = 0,
    // so a quote of `charge − credit` would state a total the business is never
    // billed. test-platform-invoices.ts asserts the same thing from the writing
    // side ("the total EQUALS what was captured", "with no adjustment applied").
    check('…and the invoice total EQUALS the charge, not charge minus credit', quote.firstInvoiceTotal === '19999.00')
    check('…while the credit note is still quoted as an outstanding one', quote.credit?.amount === '3999.50')

    gatewayCalls.length = 0
    const upgraded = await subscribeTenantToPlan(
      { tenantId: C.tenantId, planId: ELITE, billingPeriod: 'monthly' },
      fakeGateway(),
      ownerDb,
    )
    check('the upgrade raised a credit note', upgraded.prorationCredit !== null)
    check('…matching what the preview quoted', upgraded.prorationCredit?.amount === '3999.50')
    check('…and the old mandate was cancelled at the gateway', gatewayCalls.some((c) => c.fn === 'cancelSubscription'))

    const pAfter = await portalFor(C)
    check('the portal now shows the new plan', pAfter.subscription?.planName === `ZZ BP Elite ${tag}`)
    check('…as the current one in the catalogue', pAfter.plans.find((x) => x.id === ELITE)?.isCurrent === true)
    check('…and the previous plan is no longer current', pAfter.plans.find((x) => x.id === PRO)?.isCurrent === false)
    check('the credit note appears in the invoice list', pAfter.invoices.some((i) => i.kind === 'credit_note'))

    // A DOWNGRADE follows the same path and the same rule.
    const downQuote = await previewPlanChangeFor(C.tenantId, STARTER, 'monthly', ownerDb)
    check('a downgrade is labelled a downgrade', downQuote.direction === 'downgrade')
    const downgraded = await subscribeTenantToPlan(
      { tenantId: C.tenantId, planId: STARTER, billingPeriod: 'monthly' },
      fakeGateway(),
      ownerDb,
    )
    check('the downgrade succeeded', typeof downgraded.subscriptionId === 'string')
    const pDown = await portalFor(C)
    check('…and the portal reflects it', pDown.subscription?.planName === `ZZ BP Starter ${tag}`)
    check('…with exactly one live subscription', (await liveSub(C.tenantId)).plan_id === STARTER)
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('9. cancel-at-period-end')
  // ══════════════════════════════════════════════════════════════════════════
  {
    const D = await makeTenant(`tbpd${tag}`.slice(0, 20))
    await subscribeTenantToPlan(
      { tenantId: D.tenantId, planId: PRO, billingPeriod: 'monthly' },
      fakeGateway(),
      ownerDb,
    )
    const sub = await liveSub(D.tenantId)
    await ownerPool.query(
      `update tenant_subscriptions set status='active', current_period_end = now() + interval '20 days'
        where id=$1`,
      [sub.id],
    )

    gatewayCalls.length = 0
    const result = await cancelTenantSubscription(D.tenantId, fakeGateway(), ownerDb)
    check('cancelling an ACTIVE subscription defers to the period end', result.atPeriodEnd === true)
    const call = gatewayCalls.find((c) => c.fn === 'cancelSubscription')!.args as { atCycleEnd: boolean }
    check('…and Razorpay is told cancel_at_cycle_end', call.atCycleEnd === true)

    const p = await portalFor(D)
    check('the subscription is STILL live', p.subscription?.status === 'active')
    check('…flagged as cancelling at period end', p.subscription?.cancelAtPeriodEnd === true)
    check('…the tenant keeps its entitlements until then', p.planName === `ZZ BP Pro ${tag}`)
    check('…and its module flags', p.modules.find((m) => m.key === 'module.payroll')?.enabled === true)

    const tenantStatus = (
      await ownerPool.query('select status from tenants where id=$1', [D.tenantId])
    ).rows[0].status
    check('…and the ACCOUNT is untouched', tenantStatus === 'active')

    const again = await cancelTenantSubscription(D.tenantId, fakeGateway(), ownerDb)
    check('cancelling twice is a no-op, not a gateway error', again.atPeriodEnd === true)
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('10. payment-method update flow')
  // ══════════════════════════════════════════════════════════════════════════
  {
    const E = await makeTenant(`tbpe${tag}`.slice(0, 20))
    const sub = await subscribeTenantToPlan(
      { tenantId: E.tenantId, planId: PRO, billingPeriod: 'monthly' },
      fakeGateway(),
      ownerDb,
    )

    gatewayCalls.length = 0
    const flow = await paymentMethodUpdateFlow(E.tenantId, fakePmGateway(), ownerDb)
    check('a hosted Razorpay URL is returned', flow.url === 'https://rzp.io/i/reauth')
    check("…for THIS tenant's own subscription", (gatewayCalls.find((c) => c.fn === 'fetchSubscription')!.args as { subscriptionId: string }).subscriptionId === sub.gatewaySubscriptionId)
    check('…fetched with the PLATFORM key secret', (gatewayCalls.find((c) => c.fn === 'fetchSubscription')!.args as { keySecret: string }).keySecret === PLATFORM_KEY_SECRET)
    check("…and NOT the tenant's own", (gatewayCalls.find((c) => c.fn === 'fetchSubscription')!.args as { keySecret: string }).keySecret !== TENANT_KEY_SECRET)

    const serialised = JSON.stringify(flow)
    check('nothing secret crosses back to the caller', !serialised.includes(PLATFORM_KEY_SECRET) && !serialised.includes(TENANT_KEY_SECRET))
    check('…the payload is just a URL and a status', JSON.stringify(Object.keys(flow).sort()) === '["gatewayStatus","url"]')

    // An admin-assigned plan has no mandate; that must be said, not linked to.
    const refused = await paymentMethodUpdateFlow(A.tenantId, fakePmGateway(), ownerDb).catch((e) => e)
    check('an admin-assigned plan reports no mandate rather than a broken link', refused instanceof Error && /no payment mandate/i.test(refused.message))
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('11. failure states render from the EXISTING lifecycle')
  // ══════════════════════════════════════════════════════════════════════════
  {
    const F = await makeTenant(`tbpf${tag}`.slice(0, 20))
    await subscribeTenantToPlan(
      { tenantId: F.tenantId, planId: PRO, billingPeriod: 'monthly' },
      fakeGateway(),
      ownerDb,
    )
    const sub = await liveSub(F.tenantId)

    await ownerPool.query(`update tenant_subscriptions set status='past_due' where id=$1`, [sub.id])
    const pastDue = await portalFor(F)
    check('past_due is reported as past_due', pastDue.subscription?.status === 'past_due')
    check('…and access continues (M16 grace rule)', pastDue.planName === `ZZ BP Pro ${tag}`)

    // Grace exhausted: the lifecycle expires the subscription and suspends.
    await ownerPool.query(`update tenant_subscriptions set status='expired' where id=$1`, [sub.id])
    await ownerPool.query(`update tenants set status='suspended' where id=$1`, [F.tenantId])
    const suspended = await portalFor(F)
    check('an expired subscription leaves no live row', suspended.subscription === null)
    check('…and nothing is entitled', suspended.planName === null && suspended.limits.every((l) => l.denied))
    check('…so the catalogue is still offered to recover', suspended.plans.length >= 3)
  }

  // ── cleanup ───────────────────────────────────────────────────────────────
  await ownerPool.query('delete from platform_invoices where tenant_id = any($1)', [created])
  await ownerPool.query('delete from tenants where id = any($1)', [created])
  await ownerPool.query('delete from plans where id = any($1)', [planIds])
  await ownerPool.query('delete from platform_payment_settings where id=true')
  await ownerPool.end()
  await appPool.end()

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error('test harness error:', e)
  process.exit(1)
})
