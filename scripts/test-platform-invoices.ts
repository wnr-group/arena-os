/**
 * M16 #4 — recurring billing + GST-compliant tenant invoices, end to end
 * against a real database.
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs scripts/test-platform-invoices.ts
 *
 * ── What is real and what is faked ──────────────────────────────────────────
 *
 * REAL: the database and migration 0080 with all of its CHECK constraints (so a
 * rounding bug is a failed INSERT, not a silently wrong bill), the RLS policies
 * and grants, the AES-256-GCM platform credentials, HMAC-SHA256 signatures
 * computed with Razorpay's documented scheme, the actual route handler in
 * app/api/webhooks/platform-razorpay/route.ts driven with real NextRequest
 * objects, and the actual issueSubscriptionInvoice() / creditUnusedPeriod() /
 * subscribeTenantToPlan() code paths.
 *
 * FAKED: only the HTTP calls to Razorpay, through the injectable seams those
 * modules already expose.
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
  const { encryptSecret } = await import('../lib/security/encryption')
  const { subscribeTenantToPlan } = await import('../lib/platform/billing/subscribe')
  const { splitGstInclusive, resolveSupplyPlace, stateCodeFromGstin, stateCodeFromPlaceOfSupply } =
    await import('../lib/platform/billing/gst')
  const { computeProrationCredit } = await import('../lib/platform/billing/proration')
  const { billableChargeFor } = await import('../lib/platform/billing/renewal')
  const { round2 } = await import('../lib/billing/pricing')
  const { financialYearPeriod } = await import('../lib/billing/invoice')
  const { todayInZone } = await import('../lib/booking/time')
  const { drizzle } = await import('drizzle-orm/node-postgres')
  const schema = await import('../db/schema')

  const ownerPool = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })
  const appPool = new Pool({ connectionString: process.env.DATABASE_URL })
  const ownerDb = drizzle(ownerPool, { schema })

  const PLATFORM_SECRET = `whsec_${randomBytes(16).toString('hex')}`
  const PLATFORM_KEY_SECRET = `rzpsecret_${randomBytes(12).toString('hex')}`

  const sign = (rawBody: string, secret: string) =>
    createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')

  const ROOT = (process.env.NEXT_PUBLIC_ROOT_DOMAIN ?? 'lvh.me:3000').split(':')[0]

  /** Raw app-role SQL as a given user — the RLS probes. */
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
  let subSeq = 0
  const fakeGateway = () => ({
    credentials: async () => ({ keyId: 'rzp_test_platform', keySecret: PLATFORM_KEY_SECRET }),
    fetchPlan: async (_c: unknown, planId: string) => {
      const p = gatewayPlanPrices.get(planId)!
      return { id: planId, period: p.period, interval: 1, item: { amount: p.amount, currency: p.currency } }
    },
    createCustomer: async (_c: unknown, params: { email: string }) => ({
      id: `cust_INV${tag}${String(++subSeq).padStart(4, '0')}`,
      email: params.email,
    }),
    createSubscription: async (_c: unknown, params: { planId: string; customerId: string; totalCount: number }) => ({
      id: `sub_INV${tag}${String(++subSeq).padStart(4, '0')}`,
      plan_id: params.planId,
      customer_id: params.customerId,
      status: 'created',
      current_start: null,
      current_end: null,
      charge_at: null,
      short_url: 'https://rzp.io/i/fake',
      paid_count: 0,
      total_count: params.totalCount,
    }),
    cancelSubscription: async (_c: unknown, subscriptionId: string, atCycleEnd: boolean) => ({
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
    }),
  })

  // ── fixtures ──────────────────────────────────────────────────────────────
  // Clear anything a previously-aborted run left behind. `plans.name` is unique
  // across the whole catalogue (0078) and the gateway plan ids are unique too,
  // so a stale fixture would fail the next run on a collision that says nothing
  // about the code under test.
  await ownerPool.query(`delete from tenants where slug like 'tinv%'`)
  await ownerPool.query(`delete from plans where name like 'ZZ Inv %'`)

  const tag = randomBytes(4).toString('hex')
  const created: string[] = []
  const planIds: string[] = []

  async function makeTenant(slug: string, profile?: { gstin?: string; place?: string }) {
    const t = await ownerPool.query<{ id: string }>(
      `insert into tenants (slug,name,status,timezone) values ($1,$2,'active','Asia/Kolkata') returning id`,
      [slug, `${slug} co`],
    )
    const tenantId = t.rows[0].id
    created.push(tenantId)
    await ownerPool.query(`insert into branches (tenant_id,name,is_primary) values ($1,'Main',true)`, [tenantId])
    const u = await ownerPool.query<{ id: string }>(
      `insert into users (email,password_hash,full_name) values ($1,'x','Owner') returning id`,
      [`${slug}@example.test`],
    )
    await ownerPool.query(
      `insert into memberships (tenant_id,user_id,role,status,full_name,email)
       values ($1,$2,'owner','active','Owner',$3)`,
      [tenantId, u.rows[0].id, `${slug}@example.test`],
    )
    // A staff member who is NOT an owner, to prove the access level.
    const m = await ownerPool.query<{ id: string }>(
      `insert into users (email,password_hash,full_name) values ($1,'x','Manager') returning id`,
      [`${slug}-mgr@example.test`],
    )
    await ownerPool.query(
      `insert into memberships (tenant_id,user_id,role,status,full_name,email)
       values ($1,$2,'manager','active','Manager',$3)`,
      [tenantId, m.rows[0].id, `${slug}-mgr@example.test`],
    )
    if (profile) {
      await ownerPool.query(
        `insert into business_profiles (tenant_id, legal_name, gstin, address, place_of_supply)
         values ($1,$2,$3,$4,$5)`,
        [tenantId, `${slug} Legal Pvt Ltd`, profile.gstin ?? null, `12 Test Road, ${slug}`, profile.place ?? null],
      )
    }
    return { tenantId, slug, ownerId: u.rows[0].id, managerId: m.rows[0].id }
  }

  async function makePlan(name: string, monthly: string, annual: string, gwM: string, gwA: string) {
    const r = await ownerPool.query<{ id: string }>(
      `insert into plans (name, monthly_price, annual_price, gateway,
                          gateway_monthly_plan_id, gateway_annual_plan_id)
       values ($1,$2,$3,'razorpay',$4,$5) returning id`,
      [name, monthly, annual, gwM, gwA],
    )
    planIds.push(r.rows[0].id)
    gatewayPlanPrices.set(gwM, { amount: Math.round(Number(monthly) * 100), currency: 'INR', period: 'monthly' })
    gatewayPlanPrices.set(gwA, { amount: Math.round(Number(annual) * 100), currency: 'INR', period: 'yearly' })
    return r.rows[0].id
  }

  // Seller in Tamil Nadu (33). Tenant A is also TN → intra-state (CGST+SGST).
  // Tenant B is in Karnataka (29) → inter-state (IGST).
  const A = await makeTenant(`tinva-${tag}`.slice(0, 20), { gstin: '33AAAAA0000A1Z5', place: 'Tamil Nadu' })
  const B = await makeTenant(`tinvb-${tag}`.slice(0, 20), { gstin: '29BBBBB1111B1Z5', place: 'Karnataka' })

  const PRO = await makePlan(`ZZ Inv Pro ${tag}`, '7999.00', '79990.00', `plan_IM${tag}`, `plan_IA${tag}`)
  const ELITE = await makePlan(`ZZ Inv Elite ${tag}`, '19999.00', '199990.00', `plan_EM${tag}`, `plan_EA${tag}`)

  await ownerPool.query(
    `insert into platform_payment_settings (id, razorpay_key_id, razorpay_key_secret_encrypted,
                                            razorpay_webhook_secret_encrypted)
     values (true,'rzp_test_platform',$1,$2)
     on conflict (id) do update set razorpay_key_secret_encrypted = excluded.razorpay_key_secret_encrypted,
       razorpay_webhook_secret_encrypted = excluded.razorpay_webhook_secret_encrypted`,
    [
      encryptSecret(PLATFORM_KEY_SECRET, 'platform:razorpay'),
      encryptSecret(PLATFORM_SECRET, 'platform:razorpay'),
    ],
  )
  await ownerPool.query(
    `insert into platform_billing_settings (id, seller_legal_name, seller_gstin, seller_address,
                                            seller_state_code, gst_rate, invoice_prefix, credit_note_prefix)
     values (true,'Arena OS Technologies Pvt Ltd','33ZZZZZ9999Z1Z5','1 Platform Road, Chennai','33',18.00,$1,$2)
     on conflict (id) do update set seller_legal_name = excluded.seller_legal_name,
       seller_gstin = excluded.seller_gstin, seller_state_code = excluded.seller_state_code,
       gst_rate = excluded.gst_rate, invoice_prefix = excluded.invoice_prefix,
       credit_note_prefix = excluded.credit_note_prefix`,
    // Distinct prefixes per run so a re-run cannot collide on invoice_number.
    [`T${tag.slice(0, 2)}`.toUpperCase(), `C${tag.slice(0, 2)}`.toUpperCase()],
  )

  // ── helpers ───────────────────────────────────────────────────────────────
  const invoicesFor = async (tenantId: string) =>
    (
      await ownerPool.query(
        `select * from platform_invoices where tenant_id=$1 order by created_at`,
        [tenantId],
      )
    ).rows

  const hour = 3600
  const nowSec = Math.floor(Date.now() / 1000)
  let evtSeq = 0
  const nextEvt = () => `evt_PI${tag}${String(++evtSeq).padStart(4, '0')}`

  const chargeBody = (o: {
    subId: string
    amountPaise: number
    start: number
    end: number
    paymentId: string
    event?: string
    status?: string
    paymentStatus?: string
    invoiceId?: string
  }) =>
    JSON.stringify({
      entity: 'event',
      account_id: 'acc_PLATFORM',
      event: o.event ?? 'subscription.charged',
      contains: ['subscription', 'payment'],
      payload: {
        subscription: {
          entity: {
            id: o.subId,
            entity: 'subscription',
            plan_id: `plan_IM${tag}`,
            status: o.status ?? 'active',
            current_start: o.start,
            current_end: o.end,
          },
        },
        payment: {
          entity: {
            id: o.paymentId,
            entity: 'payment',
            amount: o.amountPaise,
            currency: 'INR',
            status: o.paymentStatus ?? 'captured',
            invoice_id: o.invoiceId ?? `inv_RZP${o.paymentId.slice(-6)}`,
          },
        },
      },
      created_at: nowSec,
    })

  async function deliver(rawBody: string, opts: { signature?: string | null; eventId?: string | null } = {}) {
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

  // ══════════════════════════════════════════════════════════════════════════
  section('1. GST arithmetic, in isolation')
  // ══════════════════════════════════════════════════════════════════════════
  {
    // The ticket's worked example, expressed tax-INCLUSIVE: ₹118 gross at 18%
    // is ₹100 taxable + ₹9 CGST + ₹9 SGST.
    const g = splitGstInclusive(118, 18, false)
    check('₹118 incl. 18% → ₹100 taxable', g.taxableValue === 100)
    check('…CGST ₹9', g.cgst === 9)
    check('…SGST ₹9', g.sgst === 9)
    check('…GST total ₹18', g.taxTotal === 18)
    check('…invoice total ₹118', g.total === 118)

    const pro = splitGstInclusive(7999, 18, false)
    check('₹7999 incl. 18% splits exactly', round2(pro.taxableValue + pro.taxTotal) === 7999)
    check('…CGST + SGST equals the GST total to the paisa', round2(pro.cgst + pro.sgst) === pro.taxTotal)
    check('…taxable value is ₹6778.81', pro.taxableValue === 6778.81)
    check('…GST is ₹1220.19', pro.taxTotal === 1220.19)

    // An odd number of paise is where a naive `tax/2` twice drifts.
    const odd = splitGstInclusive(118.35, 18, false)
    check('an odd-paisa tax still sums exactly', round2(odd.cgst + odd.sgst) === odd.taxTotal)
    check('…and the halves differ by at most one paisa', Math.abs(round2(odd.cgst - odd.sgst)) <= 0.01)

    const inter = splitGstInclusive(7999, 18, true)
    check('inter-state puts everything in IGST', inter.igst === inter.taxTotal && inter.cgst === 0 && inter.sgst === 0)
    check('…with the same taxable value as intra-state', inter.taxableValue === pro.taxableValue)

    const zero = splitGstInclusive(0, 18, false)
    check('a zero amount yields an all-zero split, not a throw', zero.total === 0 && zero.taxTotal === 0)

    // Exhaustive-ish: the identities must hold for a wide spread of amounts.
    let identitiesHold = true
    for (let paise = 1; paise <= 2_500_00; paise += 997) {
      const amt = round2(paise / 100)
      for (const rate of [5, 12, 18, 28]) {
        for (const isInter of [false, true]) {
          const r = splitGstInclusive(amt, rate, isInter)
          if (round2(r.taxableValue + r.taxTotal) !== r.total) identitiesHold = false
          if (round2(r.cgst + r.sgst + r.igst) !== r.taxTotal) identitiesHold = false
        }
      }
    }
    check('taxable+tax=total and cgst+sgst+igst=tax hold across ~2000 amounts × 4 rates', identitiesHold)
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('2. place of supply')
  // ══════════════════════════════════════════════════════════════════════════
  {
    check('a GSTIN yields its state code', stateCodeFromGstin('33AAAAA0000A1Z5') === '33')
    check('an unknown state code is refused, not guessed', stateCodeFromGstin('99AAAAA0000A1Z5') === null)
    check('a place-of-supply name normalises', stateCodeFromPlaceOfSupply('Tamil Nadu') === '33')
    check('…as does a bare code', stateCodeFromPlaceOfSupply('29') === '29')
    check('…and an abbreviation', stateCodeFromPlaceOfSupply('KA') === '29')
    check('unrecognised text yields null', stateCodeFromPlaceOfSupply('Somewhere') === null)

    const same = resolveSupplyPlace({ sellerStateCode: '33', buyerGstin: '33AAAAA0000A1Z5', buyerPlaceOfSupply: null })
    check('same state → intra-state', same.interstate === false)
    const diff = resolveSupplyPlace({ sellerStateCode: '33', buyerGstin: '29BBBBB1111B1Z5', buyerPlaceOfSupply: null })
    check('different states → inter-state', diff.interstate === true)
    const unknown = resolveSupplyPlace({ sellerStateCode: '33', buyerGstin: null, buyerPlaceOfSupply: null })
    check('an unknown buyer state defaults to INTRA-state, never IGST', unknown.interstate === false)
    const gstinWins = resolveSupplyPlace({
      sellerStateCode: '33',
      buyerGstin: '29BBBBB1111B1Z5',
      buyerPlaceOfSupply: 'Tamil Nadu',
    })
    check('the GSTIN outranks a contradictory profile field', gstinWins.stateCode === '29')

    // ── prototype keys are not state names ────────────────────────────────
    //
    // `place_of_supply` is FREE TEXT a tenant owner types (0020). The lookup
    // used `key in map`, which answers true for every member of
    // Object.prototype — so 'constructor' returned a Function and '__proto__'
    // returned Object.prototype, from a function typed `string | null`.
    // resolveSupplyPlace() then found that non-string unequal to the seller's
    // code and declared the supply INTER-STATE, putting IGST on an invoice
    // that should carry CGST+SGST, with a stringified Function in
    // `place_of_supply`. The 0080 CHECKs cannot catch it: the totals still
    // reconcile, only the tax head is wrong — on a document never rewritten.
    for (const key of ['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty']) {
      const code = stateCodeFromPlaceOfSupply(key)
      check(`'${key}' is not a state code`, code === null)
      const r = resolveSupplyPlace({
        sellerStateCode: '33',
        buyerGstin: null,
        buyerPlaceOfSupply: key,
      })
      check(`…and does not flip '${key}' to IGST`, r.interstate === false)
    }
    check(
      'a real state name still resolves after the hardening',
      stateCodeFromPlaceOfSupply('Karnataka') === '29',
    )
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('3. what counts as a billable charge')
  // ══════════════════════════════════════════════════════════════════════════
  {
    const sub = { id: 'sub_x', status: 'active' } as never
    const pay = { id: 'pay_x', amount: 799900, currency: 'INR', status: 'captured' } as never
    check('subscription.charged with a captured payment bills', billableChargeFor('subscription.charged', sub, pay) !== null)
    check('…converted to rupees', billableChargeFor('subscription.charged', sub, pay)?.grossRupees === 7999)
    check('subscription.activated does NOT bill', billableChargeFor('subscription.activated', sub, pay) === null)
    check('subscription.resumed does NOT bill', billableChargeFor('subscription.resumed', sub, pay) === null)
    check('a charge with no payment entity does not bill', billableChargeFor('subscription.charged', sub, null) === null)
    check(
      'an AUTHORIZED (held, not captured) payment does not bill',
      billableChargeFor('subscription.charged', sub, { ...(pay as object), status: 'authorized' } as never) === null,
    )
    check(
      'a zero-amount payment does not bill',
      billableChargeFor('subscription.charged', sub, { ...(pay as object), amount: 0 } as never) === null,
    )
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('4. proration arithmetic, in isolation')
  // ══════════════════════════════════════════════════════════════════════════
  {
    const start = new Date('2026-01-01T00:00:00Z')
    const end = new Date('2026-01-31T00:00:00Z') // 30 days
    const half = computeProrationCredit({
      paidTotal: 7999,
      periodStart: start,
      periodEnd: end,
      at: new Date('2026-01-16T00:00:00Z'), // 15 days left
    })
    check('half a period credits half the amount', half.unusedDays === 15 && half.periodDays === 30)
    check('…₹7999 × 15/30 = ₹3999.50', half.amount === 3999.5)

    const done = computeProrationCredit({ paidTotal: 7999, periodStart: start, periodEnd: end, at: end })
    check('a fully-used period credits nothing', done.amount === 0)

    const past = computeProrationCredit({
      paidTotal: 7999,
      periodStart: start,
      periodEnd: end,
      at: new Date('2026-03-01T00:00:00Z'),
    })
    check('a period already over credits nothing (never negative)', past.amount === 0)

    const early = computeProrationCredit({ paidTotal: 7999, periodStart: start, periodEnd: end, at: start })
    check('cancelling on day one credits the whole amount, capped', early.amount === 7999)

    const broken = computeProrationCredit({ paidTotal: 7999, periodStart: end, periodEnd: start, at: start })
    check('a malformed period credits nothing rather than throwing', broken.amount === 0)
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('5. monthly renewal — the happy path')
  // ══════════════════════════════════════════════════════════════════════════
  let subA = ''
  let gwSubA = ''
  {
    const r = await subscribeTenantToPlan(
      { tenantId: A.tenantId, planId: PRO, billingPeriod: 'monthly' },
      fakeGateway(),
      ownerDb,
    )
    subA = r.subscriptionId
    gwSubA = r.gatewaySubscriptionId

    const start = nowSec
    const end = nowSec + 30 * 24 * hour
    const body = chargeBody({ subId: gwSubA, amountPaise: 799900, start, end, paymentId: `pay_PI${tag}01` })
    const res = await deliver(body, { signature: sign(body, PLATFORM_SECRET), eventId: nextEvt() })
    check('a signed subscription.charged is processed', res.status === 200 && res.body.status === 'processed')

    const rows = await invoicesFor(A.tenantId)
    check('exactly ONE invoice was created', rows.length === 1)
    const inv = rows[0]
    check('…of kind subscription', inv.kind === 'subscription')
    check('…marked paid', inv.status === 'paid')
    // The counter is keyed by (kind, financial year) and is deliberately NOT
    // reset per test run, so asserting on '000001' would only hold on a virgin
    // database. The format and the strictly-climbing property are the real
    // guarantees, and both are checked (the second in section 6).
    check(
      '…numbered PREFIX/FY/NNNNNN from the platform sequence',
      /^T[A-Z0-9]{2}\/\d{4}\/\d{6}$/.test(inv.invoice_number),
    )
    check(
      '…in the current Indian financial year',
      inv.invoice_number.split('/')[1] ===
        financialYearPeriod(todayInZone('Asia/Kolkata')).replace(/\D/g, '').slice(-4),
    )
    check('…and the stored period column agrees', /^\d{4}-\d{2}$/.test(inv.period))
    check('…totalling exactly what Razorpay captured', inv.total === '7999.00')
    check('…subtotal is the gross', inv.subtotal === '7999.00')
    check('…taxable value ₹6778.81', inv.taxable_value === '6778.81')
    // The odd paisa goes to SGST, so the two sum EXACTLY to the GST total —
    // which migration 0080 checks in the database.
    check('…CGST ₹610.10', inv.cgst === '610.10')
    check('…SGST ₹610.09', inv.sgst === '610.09')
    check('…which sum to the GST total exactly', round2(Number(inv.cgst) + Number(inv.sgst)) === Number(inv.tax_total))
    check('…no IGST (same state)', inv.igst === '0.00')
    check('…GST total ₹1220.19', inv.tax_total === '1220.19')
    check(
      'subtotal − adjustment = taxable + tax = total',
      round2(Number(inv.subtotal) - Number(inv.adjustment)) === Number(inv.total) &&
        round2(Number(inv.taxable_value) + Number(inv.tax_total)) === Number(inv.total),
    )
    check('…rate snapshotted', inv.gst_rate === '18.00')

    check('the billing period came from the provider', new Date(inv.billing_period_start).getTime() === start * 1000)
    check('…and its end too', new Date(inv.billing_period_end).getTime() === end * 1000)
    check('…the period TYPE is monthly', inv.billing_period_type === 'monthly')

    check('the plan name is snapshotted', inv.plan_name === `ZZ Inv Pro ${tag}`)
    check('…and the catalogue price beside it', inv.plan_price === '7999.00')
    check('the tenant GSTIN is snapshotted', inv.buyer_gstin === '33AAAAA0000A1Z5')
    check('…the legal name from the business profile', inv.buyer_legal_name.endsWith('Legal Pvt Ltd'))
    check('…and the place of supply', inv.place_of_supply === '33-Tamil Nadu')
    check('the seller letterhead is snapshotted', inv.seller_gstin === '33ZZZZZ9999Z1Z5')

    check('the Razorpay payment reference is stored', inv.gateway_payment_id === `pay_PI${tag}01`)
    check('…the Razorpay invoice id too', inv.gateway_invoice_id?.startsWith('inv_RZP'))
    check('…and the delivery that produced it', typeof inv.gateway_event_id === 'string')
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('6. idempotency')
  // ══════════════════════════════════════════════════════════════════════════
  {
    // Same event id — short-circuited by the webhook_events claim.
    const start = nowSec
    const end = nowSec + 30 * 24 * hour
    const body = chargeBody({ subId: gwSubA, amountPaise: 799900, start, end, paymentId: `pay_PI${tag}02` })
    const sig = sign(body, PLATFORM_SECRET)
    const evt = nextEvt()
    await deliver(body, { signature: sig, eventId: evt })
    const second = await deliver(body, { signature: sig, eventId: evt })
    check('a redelivered event id is a no-op', second.body.status === 'duplicate')

    // DIFFERENT event id, SAME payment — the case the event claim cannot catch.
    const before = (await invoicesFor(A.tenantId)).length
    const again = await deliver(body, { signature: sig, eventId: nextEvt() })
    const after = await invoicesFor(A.tenantId)
    check('the same payment under a NEW event id is accepted (200)', again.status === 200)
    check('…but does NOT create a second invoice', after.length === before)

    const paymentRows = after.filter((r) => r.gateway_payment_id === `pay_PI${tag}02`)
    check('…exactly one invoice carries that payment id', paymentRows.length === 1)

    // Concurrency: three simultaneous deliveries of one fresh payment.
    const body2 = chargeBody({
      subId: gwSubA,
      amountPaise: 799900,
      start,
      end: nowSec + 60 * 24 * hour,
      paymentId: `pay_PI${tag}0C`,
    })
    const sig2 = sign(body2, PLATFORM_SECRET)
    const results = await Promise.all([
      deliver(body2, { signature: sig2, eventId: nextEvt() }),
      deliver(body2, { signature: sig2, eventId: nextEvt() }),
      deliver(body2, { signature: sig2, eventId: nextEvt() }),
    ])
    check('three CONCURRENT deliveries of one payment all answer 200', results.every((r) => r.status === 200))
    const concurrent = (await invoicesFor(A.tenantId)).filter(
      (r) => r.gateway_payment_id === `pay_PI${tag}0C`,
    )
    check('…and produce exactly ONE invoice', concurrent.length === 1)

    const nums = (await invoicesFor(A.tenantId)).map((r) => r.invoice_number)
    check('every invoice number is unique', new Set(nums).size === nums.length)
    const seq = nums.map((n) => Number(String(n).split('/')[2]))
    check(
      'the counter climbs strictly — one number per invoice',
      seq.every((v, i) => i === 0 || v > seq[i - 1]),
    )

    // Total money invoiced must equal money captured — no double-counting.
    const distinctPayments = new Set(
      (await invoicesFor(A.tenantId)).filter((r) => r.gateway_payment_id).map((r) => r.gateway_payment_id),
    )
    const totalInvoiced = (await invoicesFor(A.tenantId))
      .filter((r) => r.kind === 'subscription')
      .reduce((s, r) => round2(s + Number(r.total)), 0)
    check(
      'invoiced total equals ₹7999 × distinct payments',
      totalInvoiced === round2(7999 * distinctPayments.size),
    )
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('7. annual renewal + inter-state (IGST)')
  // ══════════════════════════════════════════════════════════════════════════
  {
    const r = await subscribeTenantToPlan(
      { tenantId: B.tenantId, planId: PRO, billingPeriod: 'annual' },
      fakeGateway(),
      ownerDb,
    )
    const start = nowSec
    const end = nowSec + 365 * 24 * hour
    const body = chargeBody({ subId: r.gatewaySubscriptionId, amountPaise: 7999000, start, end, paymentId: `pay_PI${tag}A1` })
    await deliver(body, { signature: sign(body, PLATFORM_SECRET), eventId: nextEvt() })

    const rows = await invoicesFor(B.tenantId)
    check('an annual renewal creates one invoice', rows.length === 1)
    const inv = rows[0]
    check('…with the annual period type', inv.billing_period_type === 'annual')
    check('…totalling the annual price', inv.total === '79990.00')
    check('…and the annual catalogue price snapshotted', inv.plan_price === '79990.00')
    check('a Karnataka buyer is billed IGST', Number(inv.igst) > 0)
    check('…with no CGST or SGST', inv.cgst === '0.00' && inv.sgst === '0.00')
    check('…IGST equals the whole GST total', inv.igst === inv.tax_total)
    check(
      '…and the arithmetic still closes',
      round2(Number(inv.taxable_value) + Number(inv.tax_total)) === Number(inv.total),
    )
    check('…place of supply names Karnataka', inv.place_of_supply === '29-Karnataka')
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('8. proration on a mid-cycle plan change')
  // ══════════════════════════════════════════════════════════════════════════
  {
    const C = await makeTenant(`tinvc-${tag}`.slice(0, 20), { gstin: '33CCCCC2222C1Z5' })
    const first = await subscribeTenantToPlan(
      { tenantId: C.tenantId, planId: PRO, billingPeriod: 'monthly' },
      fakeGateway(),
      ownerDb,
    )

    // Pay for a 30-day period that started 15 days ago → half unused.
    const start = nowSec - 15 * 24 * hour
    const end = nowSec + 15 * 24 * hour
    const body = chargeBody({ subId: first.gatewaySubscriptionId, amountPaise: 799900, start, end, paymentId: `pay_PI${tag}P1` })
    await deliver(body, { signature: sign(body, PLATFORM_SECRET), eventId: nextEvt() })
    check('the outgoing plan was invoiced', (await invoicesFor(C.tenantId)).length === 1)

    // UPGRADE mid-cycle.
    const second = await subscribeTenantToPlan(
      { tenantId: C.tenantId, planId: ELITE, billingPeriod: 'monthly' },
      fakeGateway(),
      ownerDb,
    )
    check('the upgrade reports a proration credit', second.prorationCredit !== null)

    const rows = await invoicesFor(C.tenantId)
    const note = rows.find((r) => r.kind === 'credit_note')
    check('a credit note was raised', !!note)
    check('…for roughly half the ₹7999 paid', Math.abs(Number(note.total) - 3999.5) <= 0.01)
    check('…with a POSITIVE total (never a negative invoice)', Number(note.total) > 0)
    check('…numbered from the credit-note series', note.invoice_number.startsWith('C'))
    check('…carrying no payment reference (no money moved)', note.gateway_payment_id === null)
    check('…naming the plan being LEFT', note.plan_name === `ZZ Inv Pro ${tag}`)
    check('…and marked issued (outstanding)', note.status === 'issued')
    check(
      '…its own GST arithmetic closes',
      round2(Number(note.taxable_value) + Number(note.tax_total)) === Number(note.total),
    )

    // The next charge on the NEW plan consumes the credit.
    const upStart = nowSec
    const upEnd = nowSec + 30 * 24 * hour
    const upBody = JSON.stringify({
      entity: 'event',
      event: 'subscription.charged',
      payload: {
        subscription: {
          entity: {
            id: second.gatewaySubscriptionId,
            status: 'active',
            current_start: upStart,
            current_end: upEnd,
          },
        },
        payment: {
          entity: { id: `pay_PI${tag}P2`, amount: 1999900, currency: 'INR', status: 'captured' },
        },
      },
    })
    await deliver(upBody, { signature: sign(upBody, PLATFORM_SECRET), eventId: nextEvt() })

    const after = await invoicesFor(C.tenantId)
    const upgraded = after.find((r) => r.gateway_payment_id === `pay_PI${tag}P2`)
    check('the new plan was invoiced', !!upgraded)
    check('…at the gross Razorpay actually captured', upgraded.subtotal === '19999.00')
    // THE INVARIANT: the document totals the money that actually moved.
    // Razorpay captured ₹19,999 and nothing reduces that charge, so an invoice
    // for less would disagree with the bank, under-declare output GST, and
    // understate revenue. The outstanding credit is NOT netted off here.
    check('…and the total EQUALS what was captured', Number(upgraded.total) === 19999)
    check('…with no adjustment applied', Number(upgraded.adjustment) === 0)
    check(
      '…and taxable + GST still equals that total',
      round2(Number(upgraded.taxable_value) + Number(upgraded.tax_total)) === Number(upgraded.total),
    )

    const consumed = (await invoicesFor(C.tenantId)).find((r) => r.id === note.id)
    // The credit is an obligation to the customer, discharged only by a refund
    // or an operator's act. A later charge must never silently cancel it.
    check('the credit note is STILL outstanding', consumed.status === 'issued')
    check('…and still carries its full value', Math.abs(Number(consumed.total) - 3999.5) <= 0.01)

    // ── a DOWNGRADE follows exactly the same rule ─────────────────────────
    // Its own tenant, so the credit is computed against one unambiguous paid
    // period rather than whatever the previous scenario left on the row.
    const E = await makeTenant(`tinve-${tag}`.slice(0, 20), { gstin: '33EEEEE4444E1Z5' })
    const rich = await subscribeTenantToPlan(
      { tenantId: E.tenantId, planId: ELITE, billingPeriod: 'monthly' },
      fakeGateway(),
      ownerDb,
    )
    // A 30-day period that started 10 days ago → 20 days unused.
    const downBody = JSON.stringify({
      entity: 'event',
      event: 'subscription.charged',
      payload: {
        subscription: {
          entity: {
            id: rich.gatewaySubscriptionId,
            status: 'active',
            current_start: nowSec - 10 * 24 * hour,
            current_end: nowSec + 20 * 24 * hour,
          },
        },
        payment: { entity: { id: `pay_PI${tag}P3`, amount: 1999900, currency: 'INR', status: 'captured' } },
      },
    })
    await deliver(downBody, { signature: sign(downBody, PLATFORM_SECRET), eventId: nextEvt() })

    const third = await subscribeTenantToPlan(
      { tenantId: E.tenantId, planId: PRO, billingPeriod: 'monthly' },
      fakeGateway(),
      ownerDb,
    )
    check('a DOWNGRADE also raises a credit note', third.prorationCredit !== null)
    const downNote = (await invoicesFor(E.tenantId)).find((r) => r.kind === 'credit_note')
    // 20 of 30 days unused on a ₹19999 charge — the SAME formula as the
    // upgrade, applied to a dearer plan, so the credit is simply larger.
    check(
      '…for the unused part of the DEARER plan',
      !!downNote && Math.abs(Number(downNote.total) - round2((19999 * 20) / 30)) <= 0.02,
    )
    check('…still positive, never a negative invoice', Number(downNote.total) > 0)
    check('…and it names the plan being left', downNote.plan_name === `ZZ Inv Elite ${tag}`)
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('9. tenant isolation and access level')
  // ══════════════════════════════════════════════════════════════════════════
  {
    const own = await asUser(A.ownerId, (c) => c.query('select id from platform_invoices'))
    check('an owner sees its own invoices', own.rows.length > 0)

    const other = await asUser(B.ownerId, (c) =>
      c.query('select id from platform_invoices where tenant_id=$1', [A.tenantId]),
    )
    check("another tenant's owner sees ZERO of them", other.rows.length === 0)

    const mgr = await asUser(A.managerId, (c) => c.query('select id from platform_invoices'))
    check('a MANAGER sees none — owner-only, like the business profile', mgr.rows.length === 0)

    const upd = await asUser(A.ownerId, (c) =>
      c
        .query(`update platform_invoices set total='0.00' where tenant_id=$1`, [A.tenantId])
        .then(() => null)
        .catch((e: { code?: string }) => e.code),
    )
    check('an owner cannot rewrite an invoice', upd === '42501')

    const ins = await asUser(A.ownerId, (c) =>
      c
        .query(
          `insert into platform_invoices (tenant_id,subscription_id,plan_id,invoice_number,invoice_date,period,
             billing_period_start,billing_period_end,billing_period_type,plan_name,plan_price,
             seller_legal_name,buyer_legal_name,subtotal,taxable_value,gst_rate,total)
           values ($1,$2,$3,'HACK/2627/000001',current_date,'2026-27',now(),now()+interval '1 day','monthly','x',0,'s','b',0,0,18,0)`,
          [A.tenantId, subA, PRO],
        )
        .then(() => null)
        .catch((e: { code?: string }) => e.code),
    )
    check('…nor mint one', ins === '42501')

    const settings = await asUser(A.ownerId, (c) =>
      c
        .query('select * from platform_billing_settings')
        .then(() => null)
        .catch((e: { code?: string }) => e.code),
    )
    check('a tenant cannot read the platform letterhead table', settings === '42501')

    const seq = await asUser(A.ownerId, (c) =>
      c
        .query('select * from platform_sequences')
        .then(() => null)
        .catch((e: { code?: string }) => e.code),
    )
    check('…nor the platform numbering counter', seq === '42501')
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('10. the snapshot really is frozen')
  // ══════════════════════════════════════════════════════════════════════════
  {
    const before = (await invoicesFor(A.tenantId))[0]

    // Change everything an invoice quotes.
    await ownerPool.query(
      `update business_profiles set legal_name='Renamed Pvt Ltd', gstin='27ZZZZZ8888Z1Z5',
         address='99 New Street', place_of_supply='Maharashtra' where tenant_id=$1`,
      [A.tenantId],
    )
    // Tag-unique: plans.name is globally unique (0078), so a fixed string here
    // would collide with whatever a previous run left behind.
    await ownerPool.query(`update plans set name=$1, monthly_price='12345.00' where id=$2`, [
      `ZZ Inv Renamed ${tag}`,
      PRO,
    ])
    await ownerPool.query(`update platform_billing_settings set seller_legal_name='Renamed Arena', gst_rate=28.00 where id=true`)

    const after = (await invoicesFor(A.tenantId))[0]
    check('the buyer legal name did not change', after.buyer_legal_name === before.buyer_legal_name)
    check('…nor the buyer GSTIN', after.buyer_gstin === before.buyer_gstin)
    check('…nor the place of supply', after.place_of_supply === before.place_of_supply)
    check('…nor the plan name', after.plan_name === before.plan_name)
    check('…nor the plan price', after.plan_price === before.plan_price)
    check('…nor the seller name', after.seller_legal_name === before.seller_legal_name)
    check('…nor the GST rate', after.gst_rate === before.gst_rate)
    check('…nor a single money figure', after.total === before.total && after.cgst === before.cgst)

    // Put everything back. These mutations exist only to prove the snapshot is
    // frozen; leaving them in place would make the catalogue price disagree
    // with its Razorpay plan, which subscribeTenantToPlan() rightly refuses.
    await ownerPool.query(
      `update platform_billing_settings set seller_legal_name='Arena OS Technologies Pvt Ltd', gst_rate=18.00 where id=true`,
    )
    await ownerPool.query(`update plans set name=$1, monthly_price='7999.00' where id=$2`, [
      `ZZ Inv Pro ${tag}`,
      PRO,
    ])
    await ownerPool.query(
      `update business_profiles set legal_name=$1, gstin='33AAAAA0000A1Z5',
         address='12 Test Road', place_of_supply='Tamil Nadu' where tenant_id=$2`,
      [`${A.slug} Legal Pvt Ltd`, A.tenantId],
    )
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('11. what must NOT be billed')
  // ══════════════════════════════════════════════════════════════════════════
  {
    const D = await makeTenant(`tinvd-${tag}`.slice(0, 20))
    const r = await subscribeTenantToPlan(
      { tenantId: D.tenantId, planId: PRO, billingPeriod: 'monthly' },
      fakeGateway(),
      ownerDb,
    )
    const start = nowSec
    const end = nowSec + 30 * 24 * hour

    const activated = chargeBody({
      subId: r.gatewaySubscriptionId,
      amountPaise: 799900,
      start,
      end,
      paymentId: `pay_PI${tag}N1`,
      event: 'subscription.activated',
    })
    await deliver(activated, { signature: sign(activated, PLATFORM_SECRET), eventId: nextEvt() })
    check('subscription.activated moves state but raises NO invoice', (await invoicesFor(D.tenantId)).length === 0)

    const failedPay = chargeBody({
      subId: r.gatewaySubscriptionId,
      amountPaise: 799900,
      start,
      end,
      paymentId: `pay_PI${tag}N2`,
      paymentStatus: 'failed',
    })
    await deliver(failedPay, { signature: sign(failedPay, PLATFORM_SECRET), eventId: nextEvt() })
    check('a charge carrying a FAILED payment raises no invoice', (await invoicesFor(D.tenantId)).length === 0)

    const unsigned = chargeBody({ subId: r.gatewaySubscriptionId, amountPaise: 799900, start, end, paymentId: `pay_PI${tag}N3` })
    const bad = await deliver(unsigned, { signature: 'deadbeef'.repeat(8), eventId: nextEvt() })
    check('an invalidly signed charge is rejected (401)', bad.status === 401)
    check('…and raises no invoice', (await invoicesFor(D.tenantId)).length === 0)

    // A business with no profile still gets a document with a name on it.
    const good = chargeBody({ subId: r.gatewaySubscriptionId, amountPaise: 799900, start, end, paymentId: `pay_PI${tag}N4` })
    await deliver(good, { signature: sign(good, PLATFORM_SECRET), eventId: nextEvt() })
    const rows = await invoicesFor(D.tenantId)
    check('a tenant with NO business profile is still invoiced', rows.length === 1)
    check('…falling back to the tenant name', rows[0].buyer_legal_name.endsWith('co'))
    check('…with a blank GSTIN rather than an invented one', rows[0].buyer_gstin === null)
    check('…and taxed intra-state by the documented default', Number(rows[0].igst) === 0)
  }

  // ── cleanup ───────────────────────────────────────────────────────────────
  await ownerPool.query(`delete from webhook_events where gateway='platform_razorpay' and event_id like $1`, [`evt_PI${tag}%`])
  await ownerPool.query('delete from platform_invoices where tenant_id = any($1)', [created])
  await ownerPool.query('delete from tenants where id = any($1)', [created])
  await ownerPool.query('delete from plans where id = any($1)', [planIds])
  await ownerPool.query('delete from platform_payment_settings where id=true')
  await ownerPool.query('delete from platform_billing_settings where id=true')
  await ownerPool.end()
  await appPool.end()

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error('test harness error:', e)
  process.exit(1)
})
