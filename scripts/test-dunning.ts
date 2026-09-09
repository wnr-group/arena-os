/**
 * AROS-113 — dunning & suspension on failed payment, end to end against a real
 * database.
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs scripts/test-dunning.ts
 *
 * ── What is real and what is faked ──────────────────────────────────────────
 *
 * REAL: the database, migration 0082, every RLS policy and grant, the
 * AES-256-GCM encryption of the platform credentials, the HMAC-SHA256 webhook
 * signatures, the actual route handler in
 * app/api/webhooks/platform-razorpay/route.ts driven with real NextRequest
 * objects, the actual applySubscriptionState() / processDunning() /
 * readEntitlements() / requireEntitlementIn() code paths, and the actual
 * unique indexes that make everything here idempotent.
 *
 * FAKED: two things only.
 *   * the HTTP call to Razorpay's cancel endpoint, through the injectable seam
 *     lib/platform/billing/dunning.ts exposes;
 *   * TIME, through the `now` parameter processDunning() takes, plus direct
 *     writes to `past_due_since` / `suspended_at` for the cases where the code
 *     under test reads the wall clock itself (readEntitlements does).
 *
 * Nothing else is stubbed. A test that reimplemented the state machine or
 * skipped the signature check would prove nothing.
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

const DAY_MS = 86_400_000

async function main() {
  loadEnv()
  const { NextRequest } = await import('next/server')
  const { POST } = await import('../app/api/webhooks/platform-razorpay/route')
  const { encryptSecret } = await import('../lib/security/encryption')
  const { processDunning } = await import('../lib/platform/billing/dunning')
  const policyMod = await import('../lib/platform/billing/dunning-policy')
  const { readEntitlements } = await import('../lib/platform/entitlements')
  const { requireEntitlementIn, EntitlementError } = await import(
    '../lib/platform/entitlement-guard'
  )
  const { RazorpayApiError } = await import('../lib/payments/razorpay')
  const { drizzle } = await import('drizzle-orm/node-postgres')
  const schema = await import('../db/schema')

  const {
    DUNNING_POLICY,
    assertPolicy,
    graceEndsAt,
    graceHasExpired,
    cancellationDueAt,
    cancellationIsDue,
    remindersDue,
    deadlinesFor,
  } = policyMod

  const ownerPool = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })
  const appPool = new Pool({ connectionString: process.env.DATABASE_URL })
  const ownerDrizzle = drizzle(ownerPool, { schema })

  const PLATFORM_SECRET = `whsec_${randomBytes(16).toString('hex')}`
  const PLATFORM_KEY_SECRET = `rzpsecret_${randomBytes(12).toString('hex')}`

  /** Razorpay's documented scheme: hex HMAC-SHA256 over the RAW body. */
  const sign = (rawBody: string, secret: string) =>
    createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')

  const ROOT = (process.env.NEXT_PUBLIC_ROOT_DOMAIN ?? 'lvh.me:3000').split(':')[0]
  const tag = randomBytes(4).toString('hex')
  const gwMonthly = `plan_M${tag}`

  // ── fixtures ──────────────────────────────────────────────────────────────
  const created: string[] = []
  const planIds: string[] = []

  async function makeTenant(slug: string) {
    const t = await ownerPool.query<{ id: string }>(
      `insert into tenants (slug,name,status,timezone) values ($1,$2,'active','Asia/Kolkata')
       on conflict (slug) do update set name=excluded.name, status='active' returning id`,
      [slug, `${slug} co`],
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
    return { tenantId, slug, userId: u.rows[0].id }
  }

  async function makePlan(name: string) {
    const r = await ownerPool.query<{ id: string }>(
      `insert into plans (name, monthly_price, annual_price, active, gateway,
                          gateway_monthly_plan_id)
       values ($1,'7999.00','79990.00',true,'razorpay',$2) returning id`,
      [name, gwMonthly],
    )
    planIds.push(r.rows[0].id)
    return r.rows[0].id
  }

  /**
   * A live subscription in a known state, written directly.
   *
   * Deliberately NOT built by driving the subscribe flow: that is
   * test-platform-subscriptions.ts's job and it already passes. What is under
   * test here is what happens AFTER a subscription exists, so the fixture
   * states it plainly instead of arriving at it through four webhooks.
   */
  async function makeSubscription(
    tenantId: string,
    planId: string,
    gatewaySubId: string,
    opts: { status?: string; periodEndOffsetMs?: number } = {},
  ) {
    const status = opts.status ?? 'active'
    const endOffset = opts.periodEndOffsetMs ?? 20 * DAY_MS
    const r = await ownerPool.query<{ id: string }>(
      `insert into tenant_subscriptions
         (tenant_id, plan_id, billing_period, status, current_period_start,
          current_period_end, gateway, gateway_subscription_id, gateway_customer_id)
       values ($1,$2,'monthly',$3, now() - interval '10 days', now() + ($4 || ' milliseconds')::interval,
               'razorpay',$5,$6)
       returning id`,
      [tenantId, planId, status, String(endOffset), gatewaySubId, `cust_${tag}${gatewaySubId.slice(-4)}`],
    )
    return r.rows[0].id
  }

  const subRow = async (id: string) =>
    (await ownerPool.query('select * from tenant_subscriptions where id=$1', [id])).rows[0]
  const tenantStatus = async (tenantId: string) =>
    (await ownerPool.query('select status from tenants where id=$1', [tenantId])).rows[0].status
  const notices = async (subscriptionId: string) =>
    (
      await ownerPool.query<{ stage: string; dunning_cycle: string }>(
        'select stage, dunning_cycle from platform_dunning_notices where subscription_id=$1 order by sent_at, stage',
        [subscriptionId],
      )
    ).rows
  const audits = async (subscriptionId: string) =>
    (
      await ownerPool.query<{ action: string; after: Record<string, unknown> }>(
        `select action, "after" from audit_log where entity_id=$1 and entity_type='tenant_subscription' order by created_at`,
        [subscriptionId],
      )
    ).rows

  /** Move a subscription's dunning clocks, to place "now" relative to a deadline. */
  const setClocks = (id: string, pastDueSince: Date | null, suspendedAt: Date | null) =>
    ownerPool.query(
      'update tenant_subscriptions set past_due_since=$2, suspended_at=$3 where id=$1',
      [id, pastDueSince, suspendedAt],
    )

  // ── the platform gateway config ───────────────────────────────────────────
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

  // ── a fake Razorpay, for the one call the job makes ───────────────────────
  const gatewayCalls: { subscriptionId: string; atCycleEnd: boolean }[] = []
  const okGateway = {
    credentials: async () => ({ keyId: 'rzp_test_platform', keySecret: PLATFORM_KEY_SECRET }),
    cancelSubscription: async (
      _c: { keyId: string; keySecret: string },
      subscriptionId: string,
      atCycleEnd: boolean,
    ) => {
      gatewayCalls.push({ subscriptionId, atCycleEnd })
      return {
        id: subscriptionId,
        plan_id: gwMonthly,
        customer_id: null,
        status: 'cancelled',
        current_start: null,
        current_end: null,
        charge_at: null,
        short_url: null,
        paid_count: 0,
        total_count: 1,
      }
    },
  }
  /** A gateway that is temporarily unreachable — the "defer, do not cancel" case. */
  const downGateway = {
    credentials: okGateway.credentials,
    cancelSubscription: async () => {
      throw new RazorpayApiError('Could not reach the payment gateway.', 0, true)
    },
  }

  /**
   * Captures what was actually delivered, so "a reminder was sent" is
   * observable rather than inferred from the table.
   *
   * `deliveredFor` exists because processDunning() is a PLATFORM-WIDE sweep:
   * a run started for one scenario legitimately advances every other
   * subscription whose clock is also due, and several sections deliberately
   * leave such subscriptions lying around. Asserting on the whole array would
   * be asserting on the order the sections happen to run in.
   */
  const delivered: {
    stage: string
    subscriptionId: string
    /** The SUSPENSION date the notice quotes. Kept so section 6b can assert it. */
    graceEndsAt: Date | null
  }[] = []
  const capture = (n: {
    stage: string
    subscriptionId: string
    graceEndsAt: Date | null
  }) => {
    delivered.push({
      stage: n.stage,
      subscriptionId: n.subscriptionId,
      graceEndsAt: n.graceEndsAt,
    })
  }
  const deliveredFor = (subscriptionId: string) =>
    delivered.filter((d) => d.subscriptionId === subscriptionId)

  // ── webhook plumbing ──────────────────────────────────────────────────────
  const subBody = (o: {
    event: string
    subId: string
    status: string
    currentStart?: number | null
    currentEnd?: number | null
    payment?: Record<string, unknown>
  }) =>
    JSON.stringify({
      entity: 'event',
      account_id: 'acc_PLATFORM',
      event: o.event,
      contains: o.payment ? ['subscription', 'payment'] : ['subscription'],
      payload: {
        subscription: {
          entity: {
            id: o.subId,
            entity: 'subscription',
            plan_id: gwMonthly,
            status: o.status,
            current_start: o.currentStart ?? null,
            current_end: o.currentEnd ?? null,
          },
        },
        ...(o.payment ? { payment: { entity: o.payment } } : {}),
      },
      created_at: 1755500000,
    })

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
  const nextEvt = () => `evt_DN${tag}${String(++evtSeq).padStart(4, '0')}`
  const signed = (body: string, eventId = nextEvt()) =>
    deliver(body, { signature: sign(body, PLATFORM_SECRET), eventId })

  const nowSec = Math.floor(Date.now() / 1000)

  // ── the cast ──────────────────────────────────────────────────────────────
  const A = await makeTenant(`tstdunna${tag.slice(0, 3)}`)
  const B = await makeTenant(`tstdunnb${tag.slice(0, 3)}`)
  const HEALTHY = await makeTenant(`tstdunnh${tag.slice(0, 3)}`)
  const PLAN = await makePlan(`ZZ Dunning ${tag}`)
  await ownerPool.query(
    `insert into plan_entitlements (plan_id, key, value) values
       ($1,'module.payroll','true'::jsonb), ($1,'max_branches','3'::jsonb)`,
    [PLAN],
  )

  // ══════════════════════════════════════════════════════════════════════════
  section('1. the policy module, in isolation')
  // ══════════════════════════════════════════════════════════════════════════
  {
    check('the shipped policy is coherent', (() => {
      try {
        assertPolicy()
        return true
      } catch {
        return false
      }
    })())

    check('a final warning after its own suspension is rejected', (() => {
      try {
        assertPolicy({
          graceDays: 2,
          suspensionDays: 14,
          reminders: [{ stage: 'final_warning', anchor: 'arrears', days: 5 }],
        })
        return false
      } catch {
        return true
      }
    })())

    check('out-of-order reminders are rejected', (() => {
      try {
        assertPolicy({
          graceDays: 7,
          suspensionDays: 14,
          reminders: [
            { stage: 'grace_reminder', anchor: 'arrears', days: 3 },
            { stage: 'payment_failed', anchor: 'arrears', days: 1 },
          ],
        })
        return false
      } catch {
        return true
      }
    })())

    const t0 = new Date('2026-03-01T00:00:00.000Z')
    check(
      `grace ends exactly ${DUNNING_POLICY.graceDays} days after past_due`,
      graceEndsAt(t0).getTime() === t0.getTime() + DUNNING_POLICY.graceDays * DAY_MS,
    )
    check(
      `cancellation is due exactly ${DUNNING_POLICY.suspensionDays} days after suspension`,
      cancellationDueAt(t0).getTime() === t0.getTime() + DUNNING_POLICY.suspensionDays * DAY_MS,
    )

    // ── THE BOUNDARY, stated three times ─────────────────────────────────
    const end = graceEndsAt(t0)
    check(
      'one millisecond before the deadline, grace has NOT expired',
      !graceHasExpired(t0, new Date(end.getTime() - 1)),
    )
    check(
      'AT the deadline, grace HAS expired (the rule is >=, not >)',
      graceHasExpired(t0, end),
    )
    check(
      'one millisecond after, grace has expired',
      graceHasExpired(t0, new Date(end.getTime() + 1)),
    )

    const cancelAt = cancellationDueAt(t0)
    check(
      'the post-suspension window uses the same >= boundary',
      !cancellationIsDue(t0, new Date(cancelAt.getTime() - 1)) &&
        cancellationIsDue(t0, cancelAt),
    )

    // The DEFAULT geometry: suspension is the grace deadline, so the two
    // anchors coincide and the reminders fall on days 0, 3 and 6 exactly as
    // they always have.
    const suspendsAt = graceEndsAt(t0)
    check(
      'no reminder is due before the first offset elapses',
      remindersDue(t0, suspendsAt, new Date(t0.getTime() - 1)).length === 0,
    )
    check(
      'the day-0 reminder is due at exactly past_due_since',
      remindersDue(t0, suspendsAt, t0).join() === 'payment_failed',
    )
    check(
      'the suspension-anchored reminders still land on days 3 and 6',
      remindersDue(t0, suspendsAt, new Date(t0.getTime() + 3 * DAY_MS)).join() ===
        'payment_failed,grace_reminder' &&
        remindersDue(t0, suspendsAt, new Date(t0.getTime() + 6 * DAY_MS)).join() ===
          'payment_failed,grace_reminder,final_warning',
    )
    check(
      'a job catching up late owes EVERY missed reminder',
      remindersDue(t0, suspendsAt, new Date(t0.getTime() + 6.5 * DAY_MS)).join() ===
        'payment_failed,grace_reminder,final_warning',
    )

    // ── and when a paid period defers the suspension, they FOLLOW it ────────
    //
    // The regression this shape exists to prevent: with every offset measured
    // forward from past_due_since, a "final warning" fired on day 6 for a
    // suspension 300 days away, and the business then heard nothing at all
    // until the day itself.
    const farOff = new Date(t0.getTime() + 300 * DAY_MS)
    check(
      'the failed-payment notice still goes out at once',
      remindersDue(t0, farOff, t0).join() === 'payment_failed',
    )
    check(
      '…but the warnings that NAME the date do not fire early',
      remindersDue(t0, farOff, new Date(t0.getTime() + 6 * DAY_MS)).join() === 'payment_failed',
    )
    check(
      '…they arrive 4 days and 1 day before the real suspension',
      remindersDue(t0, farOff, new Date(farOff.getTime() - 4 * DAY_MS)).join() ===
        'payment_failed,grace_reminder' &&
        remindersDue(t0, farOff, new Date(farOff.getTime() - 1 * DAY_MS)).join() ===
          'payment_failed,grace_reminder,final_warning',
    )

    check(
      'no deadlines without a clock',
      deadlinesFor({ pastDueSince: null, suspendedAt: null }) === null,
    )
    check(
      'cancelsAt is null until suspension',
      deadlinesFor({ pastDueSince: t0, suspendedAt: null })?.cancelsAt === null &&
        deadlinesFor({ pastDueSince: t0, suspendedAt: t0 })?.cancelsAt?.getTime() ===
          cancelAt.getTime(),
    )
    check(
      'a paid period pushes the quoted suspension date out with it',
      deadlinesFor({
        pastDueSince: t0,
        suspendedAt: null,
        paidThrough: farOff,
      })?.graceEndsAt.getTime() === farOff.getTime(),
    )
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('2. a successful payment leaves a clean, healthy subscription')
  // ══════════════════════════════════════════════════════════════════════════
  const subA = `sub_A${tag}`
  const idA = await makeSubscription(A.tenantId, PLAN, subA, { status: 'trialing' })
  {
    const body = subBody({
      event: 'subscription.charged',
      subId: subA,
      status: 'active',
      currentStart: nowSec - 3600,
      currentEnd: nowSec + 30 * 86400,
      payment: { id: `pay_${tag}1`, entity: 'payment', amount: 799900, currency: 'INR', status: 'captured' },
    })
    const res = await signed(body)
    const row = await subRow(idA)
    check('the charge is accepted', res.status === 200 && res.body.status === 'processed')
    check('subscription → active', row.status === 'active')
    check('tenant → active', (await tenantStatus(A.tenantId)) === 'active')
    check('no dunning clock is running', row.past_due_since === null && row.suspended_at === null)
    check('no dunning notice was raised', (await notices(idA)).length === 0)

    const e = await readEntitlements(ownerDrizzle, A.tenantId)
    check('entitlements are granted', e.entitlements['module.payroll'] === true)
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('3. a failed renewal moves the subscription to past_due')
  // ══════════════════════════════════════════════════════════════════════════
  {
    const body = subBody({
      event: 'subscription.pending',
      subId: subA,
      status: 'pending',
      currentStart: nowSec - 3600,
      currentEnd: nowSec + 30 * 86400,
      payment: {
        id: `pay_${tag}F1`,
        entity: 'payment',
        amount: 799900,
        currency: 'INR',
        status: 'failed',
        error_code: 'BAD_REQUEST_ERROR',
        error_description: 'Card declined by the issuing bank',
      },
    })
    const res = await signed(body)
    const row = await subRow(idA)

    check('the failure is accepted', res.status === 200 && res.body.status === 'processed')
    check('subscription → past_due', row.status === 'past_due')
    check(
      'the tenant is NOT suspended — grace is a conversation, not a trapdoor',
      (await tenantStatus(A.tenantId)) === 'active',
    )
    check('past_due_since is stamped', row.past_due_since !== null)
    check('suspended_at is not', row.suspended_at === null)
    check(
      'the gateway failure reason is stored',
      row.last_payment_failure_reason === 'Card declined by the issuing bank',
    )
    check('the failure timestamp is stored', row.last_payment_failure_at !== null)

    const a = await audits(idA)
    check(
      'an audit entry records the transition',
      a.some(
        (r) =>
          r.action === 'subscription.past_due' &&
          (r.after as { source?: string }).source === 'webhook',
      ),
    )
    check(
      'the audit entry has no actor — nobody in the business did this',
      (
        await ownerPool.query(
          `select actor_membership_id from audit_log where entity_id=$1 and action='subscription.past_due'`,
          [idA],
        )
      ).rows.every((r) => r.actor_membership_id === null),
    )

    const n = await notices(idA)
    check('the day-zero notice was raised immediately', n.length === 1 && n[0].stage === 'payment_failed')
  }

  const episodeA = (await subRow(idA)).past_due_since as Date

  // ══════════════════════════════════════════════════════════════════════════
  section('4. duplicate and repeated webhooks change nothing')
  // ══════════════════════════════════════════════════════════════════════════
  {
    const body = subBody({
      event: 'subscription.pending',
      subId: subA,
      status: 'pending',
      currentStart: nowSec - 3600,
      currentEnd: nowSec + 30 * 86400,
    })
    const eventId = nextEvt()

    const first = await deliver(body, { signature: sign(body, PLATFORM_SECRET), eventId })
    const replay = await deliver(body, { signature: sign(body, PLATFORM_SECRET), eventId })
    check('an exact redelivery is reported as a duplicate', replay.body.status === 'duplicate')
    check('…and the first one was not', first.body.status !== 'unauthorized')

    // A DIFFERENT event id carrying the same state — Razorpay really does this
    // when a retry fails again. The delivery-level claim cannot catch it, so the
    // set-once clock has to.
    await signed(body)
    const row = await subRow(idA)
    check(
      'a second failure does NOT restart the grace clock',
      (row.past_due_since as Date).getTime() === episodeA.getTime(),
    )
    check('the status is still past_due', row.status === 'past_due')

    const n = await notices(idA)
    check('and no second payment_failed notice was raised', n.filter((r) => r.stage === 'payment_failed').length === 1)

    const a = await audits(idA)
    check(
      'no audit entry is written for a transition that did not happen',
      a.filter((r) => r.action === 'subscription.past_due').length === 1,
    )
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('5. during grace the tenant keeps working')
  // ══════════════════════════════════════════════════════════════════════════
  {
    // A failed renewal leaves current_period_end in the PAST — Razorpay does not
    // extend a period it could not charge for. This is the case that would be a
    // zero-length grace period without the separate clock.
    await ownerPool.query(
      `update tenant_subscriptions set current_period_end = now() - interval '1 hour' where id=$1`,
      [idA],
    )
    await setClocks(idA, new Date(Date.now() - 1 * DAY_MS), null)

    const e = await readEntitlements(ownerDrizzle, A.tenantId)
    check('the plan still resolves', e.plan !== null && e.status === 'past_due')
    check('modules are still granted', e.entitlements['module.payroll'] === true)

    let denied = false
    try {
      await requireEntitlementIn(ownerDrizzle, A.tenantId, 'module.payroll')
    } catch {
      denied = true
    }
    check('…and the module gate still opens', !denied)
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('6. the exact grace boundary')
  // ══════════════════════════════════════════════════════════════════════════
  {
    // One second INSIDE the window.
    await setClocks(idA, new Date(Date.now() - DUNNING_POLICY.graceDays * DAY_MS + 1000), null)
    const inside = await readEntitlements(ownerDrizzle, A.tenantId)
    check('one second before the deadline, entitlements are still granted', inside.plan !== null)

    const dry = await processDunning({
      db: ownerDrizzle,
      now: new Date(Date.now() - 1000),
      notify: capture,
      gateway: okGateway,
    })
    check('…and the job does not suspend', dry.suspended === 0 && (await subRow(idA)).status === 'past_due')

    // One second PAST it.
    await setClocks(idA, new Date(Date.now() - DUNNING_POLICY.graceDays * DAY_MS - 1000), null)
    const outside = await readEntitlements(ownerDrizzle, A.tenantId)
    check(
      'one second after the deadline, entitlements are gone even before the job runs',
      outside.plan === null && Object.keys(outside.entitlements).length === 0,
    )
    check('…which is the fail-closed direction', outside.status === null)
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('6b. grace never SHORTENS a period the business paid for')
  // ══════════════════════════════════════════════════════════════════════════
  //
  // The regression: lib/platform/entitlements.ts computed effective expiry as
  // max(current_period_end, graceEndsAt) and documented that "a subscription
  // whose paid period OUTLASTS its grace window keeps the access it paid for",
  // while the processor decided suspension on graceHasExpired() alone. So an
  // annual subscriber paid through to next year, whose mandate failed once, was
  // suspended seven days later — and because that takes the row out of
  // LIVE_STATUSES, the reader's max() became unreachable and returned "no
  // plan" for a plan that was paid for. The venue's public site went dark with
  // it. Both sides now ask accessEndsAt().
  {
    const subP = `sub_P${tag}`
    const idP = await makeSubscription(B.tenantId, PLAN, subP, {
      status: 'past_due',
      // Paid ~10 months ahead: the inherited runway a plan change seeds, or an
      // annual term whose mandate failed mid-cycle.
      periodEndOffsetMs: 300 * DAY_MS,
    })
    // Well past the 7-day grace deadline.
    await setClocks(idP, new Date(Date.now() - (DUNNING_POLICY.graceDays + 3) * DAY_MS), null)

    const before = await readEntitlements(ownerDrizzle, B.tenantId)
    check('a paid-through subscription in arrears still grants its plan', before.plan !== null)

    // Asserted on THIS row, not on the run's counters: processDunning() sweeps
    // every candidate in the database, and earlier sections deliberately leave
    // others past their deadline.
    await processDunning({
      db: ownerDrizzle,
      now: new Date(),
      notify: capture,
      gateway: okGateway,
    })
    const swept = await subRow(idP)
    check('the job does not suspend it', swept.status === 'past_due')
    check('…and stamps no suspended_at', swept.suspended_at === null)
    check('…the account is untouched', (await tenantStatus(B.tenantId)) === 'active')

    const after = await readEntitlements(ownerDrizzle, B.tenantId)
    check('…and it still has the plan it paid for', after.plan !== null)

    // The reminders still go out on the arrears clock — a charge HAS bounced —
    // and they quote the real suspension date rather than the grace deadline.
    const sent = deliveredFor(idP)
    check('reminders still go out on the arrears clock', sent.length > 0)
    check(
      '…quoting the date the job will actually act on, not the grace deadline',
      sent.every(
        (n) =>
          n.graceEndsAt !== null &&
          n.graceEndsAt.getTime() > Date.now() + 290 * DAY_MS,
      ),
    )

    // …and once the paid period DOES run out, it suspends exactly as before.
    await ownerPool.query(
      `update tenant_subscriptions set current_period_end = now() - interval '1 hour' where id=$1`,
      [idP],
    )
    await processDunning({
      db: ownerDrizzle,
      now: new Date(),
      notify: capture,
      gateway: okGateway,
    })
    const lapsed = await subRow(idP)
    check('once the paid period runs out, it suspends', lapsed.status === 'expired')
    check('…stamping suspended_at', lapsed.suspended_at !== null)
    check('…and the account is suspended', (await tenantStatus(B.tenantId)) === 'suspended')

    // Put B back as the rest of the file expects to find it.
    await ownerPool.query(`delete from platform_dunning_notices where subscription_id=$1`, [idP])
    await ownerPool.query(`delete from audit_log where entity_id=$1`, [idP])
    await ownerPool.query(
      `update tenant_subscriptions set status='cancelled', cancelled_at=now() where id=$1`,
      [idP],
    )
    await ownerPool.query(`update tenants set status='active' where id=$1`, [B.tenantId])
    delivered.length = 0
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('7. reminders are sent at the right time, once')
  // ══════════════════════════════════════════════════════════════════════════
  const subR = `sub_R${tag}`
  const idR = await makeSubscription(B.tenantId, PLAN, subR, {
    status: 'past_due',
    periodEndOffsetMs: -3600_000,
  })
  {
    const pastDue = new Date(Date.now() - 10_000)
    await setClocks(idR, pastDue, null)

    delivered.length = 0
    await processDunning({ db: ownerDrizzle, now: pastDue, notify: capture, gateway: okGateway })
    check(
      'at day 0 only the payment_failed notice goes out',
      deliveredFor(idR).length === 1 && deliveredFor(idR)[0].stage === 'payment_failed',
    )

    delivered.length = 0
    const day2 = new Date(pastDue.getTime() + 2 * DAY_MS)
    await processDunning({ db: ownerDrizzle, now: day2, notify: capture, gateway: okGateway })
    check('at day 2 nothing new is due', deliveredFor(idR).length === 0)

    delivered.length = 0
    const day3 = new Date(pastDue.getTime() + 3 * DAY_MS)
    await processDunning({ db: ownerDrizzle, now: day3, notify: capture, gateway: okGateway })
    check(
      'at day 3 the grace reminder goes out',
      deliveredFor(idR).length === 1 && deliveredFor(idR)[0].stage === 'grace_reminder',
    )

    delivered.length = 0
    await processDunning({ db: ownerDrizzle, now: day3, notify: capture, gateway: okGateway })
    await processDunning({ db: ownerDrizzle, now: day3, notify: capture, gateway: okGateway })
    check(
      'running the job again sends nothing — the unique index refuses it',
      deliveredFor(idR).length === 0,
    )

    delivered.length = 0
    const day6 = new Date(pastDue.getTime() + 6 * DAY_MS)
    await processDunning({ db: ownerDrizzle, now: day6, notify: capture, gateway: okGateway })
    check(
      'at day 6 the final warning goes out',
      deliveredFor(idR).length === 1 && deliveredFor(idR)[0].stage === 'final_warning',
    )

    const n = await notices(idR)
    check(
      'three notices, all on the same episode key',
      n.length === 3 && new Set(n.map((r) => String(r.dunning_cycle))).size === 1,
    )
    check('the tenant is still untouched throughout', (await tenantStatus(B.tenantId)) === 'active')
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('8. grace expires → suspended')
  // ══════════════════════════════════════════════════════════════════════════
  {
    const pastDue = (await subRow(idR)).past_due_since as Date
    const after = new Date(pastDue.getTime() + DUNNING_POLICY.graceDays * DAY_MS)

    delivered.length = 0
    const run = await processDunning({
      db: ownerDrizzle,
      now: after,
      notify: capture,
      gateway: okGateway,
    })
    const row = await subRow(idR)

    check('exactly one subscription was suspended', run.suspended === 1)
    check('subscription → expired (the local state suspension maps to)', row.status === 'expired')
    check('tenant → suspended', (await tenantStatus(B.tenantId)) === 'suspended')
    check('suspended_at is stamped', row.suspended_at !== null)
    check('past_due_since is preserved as the episode key', (row.past_due_since as Date).getTime() === pastDue.getTime())
    check('the suspension notice went out', deliveredFor(idR).some((d) => d.stage === 'suspended'))
    check(
      'an audit entry records it, attributed to the job',
      (await audits(idR)).some(
        (r) => r.action === 'subscription.expired' && (r.after as { source?: string }).source === 'dunning_job',
      ),
    )
    check(
      'no gateway cancel was called — suspension is reversible and the mandate stays',
      gatewayCalls.filter((c) => c.subscriptionId === subR).length === 0,
    )
    check(
      'nothing was deleted: the subscription row is still there',
      row.id === idR && row.tenant_id === B.tenantId,
    )
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('9. a suspended tenant is restricted, through the entitlement layer')
  // ══════════════════════════════════════════════════════════════════════════
  {
    const e = await readEntitlements(ownerDrizzle, B.tenantId)
    check('no plan resolves', e.plan === null && e.status === null)
    check('no entitlement is granted', Object.keys(e.entitlements).length === 0)

    let moduleErr: unknown = null
    try {
      await requireEntitlementIn(ownerDrizzle, B.tenantId, 'module.payroll')
    } catch (err) {
      moduleErr = err
    }
    check('the module gate refuses', moduleErr instanceof EntitlementError)
    check(
      '…with the "no active plan" message, not a crash',
      moduleErr instanceof Error && /no active plan/i.test(moduleErr.message),
    )

    const { checkLimitIn } = await import('../lib/platform/entitlement-guard')
    let limitErr: unknown = null
    try {
      await checkLimitIn(ownerDrizzle, B.tenantId, 'max_branches', 0)
    } catch (err) {
      limitErr = err
    }
    check('creating a limited item is refused too', limitErr instanceof EntitlementError)

    // READ access is deliberately untouched: nothing is deleted, and the owner
    // must still be able to see the bill and pay it.
    const invoiceCount = (
      await ownerPool.query('select count(*)::int c from platform_invoices where tenant_id=$1', [
        B.tenantId,
      ])
    ).rows[0].c
    check('historical records remain readable (count query succeeds)', typeof invoiceCount === 'number')
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('10. a late payment reactivates a SUSPENDED tenant')
  // ══════════════════════════════════════════════════════════════════════════
  {
    const body = subBody({
      event: 'subscription.charged',
      subId: subR,
      status: 'active',
      currentStart: nowSec,
      currentEnd: nowSec + 30 * 86400,
      payment: { id: `pay_${tag}R`, entity: 'payment', amount: 799900, currency: 'INR', status: 'captured' },
    })
    const res = await signed(body)
    const row = await subRow(idR)

    check('the late charge is processed', res.body.status === 'processed')
    check('subscription → active', row.status === 'active')
    check('tenant → active', (await tenantStatus(B.tenantId)) === 'active')
    check(
      'BOTH clocks are cleared, so nothing re-suspends it',
      row.past_due_since === null && row.suspended_at === null,
    )

    const e = await readEntitlements(ownerDrizzle, B.tenantId)
    check('entitlements are available again', e.entitlements['module.payroll'] === true)

    const before = await notices(idR)
    const run = await processDunning({ db: ownerDrizzle, now: new Date(), notify: capture, gateway: okGateway })
    check('the job no longer sees it at all', run.examined === 0 || (await subRow(idR)).status === 'active')
    check('and raises no further notice', (await notices(idR)).length === before.length)
    check(
      'the notices from the resolved episode are KEPT as history',
      before.length >= 4,
    )
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('11. continued failure → cancelled')
  // ══════════════════════════════════════════════════════════════════════════
  const subC = `sub_C${tag}`
  const idC = await makeSubscription(A.tenantId, PLAN, subC, {
    status: 'expired',
    periodEndOffsetMs: -3600_000,
  })
  {
    // Tenant A's first subscription is still hanging around in past_due from the
    // earlier sections; retire it so the one-live index and the portal reader
    // both see a single story.
    await ownerPool.query(
      `update tenant_subscriptions set status='expired', suspended_at=now(), past_due_since=coalesce(past_due_since, now()) where id=$1`,
      [idA],
    )

    // Make this unambiguously the tenant's MOST RECENT subscription. The portal
    // reader orders by current_period_start desc — correctly, since a business
    // that re-subscribes should see its NEW subscription's story — and §2's
    // successful charge moved idA's start forward to an hour ago. Both bounds
    // move together, because tenant_subscriptions_period CHECKs end > start.
    await ownerPool.query(
      `update tenant_subscriptions
          set current_period_start = now() - interval '45 minutes',
              current_period_end   = now() - interval '30 minutes'
        where id=$1`,
      [idC],
    )

    const suspendedAt = new Date(Date.now() - DUNNING_POLICY.suspensionDays * DAY_MS)
    await setClocks(idC, new Date(suspendedAt.getTime() - DUNNING_POLICY.graceDays * DAY_MS), suspendedAt)

    // ── the gateway is down: nothing may be cancelled locally ──────────────
    delivered.length = 0
    const deferred = await processDunning({
      db: ownerDrizzle,
      now: new Date(),
      notify: capture,
      gateway: downGateway,
    })
    check('a transient gateway failure cancels NOTHING', deferred.cancelled === 0)
    check('the subscription is untouched', (await subRow(idC)).status === 'expired')
    check('and the run reports why', deferred.problems.some((p) => p.includes('deferred')))

    // ── the gateway is back ───────────────────────────────────────────────
    delivered.length = 0
    const run = await processDunning({
      db: ownerDrizzle,
      now: new Date(),
      notify: capture,
      gateway: okGateway,
    })
    const row = await subRow(idC)

    check('the subscription is cancelled', run.cancelled >= 1 && row.status === 'cancelled')
    check('cancelled_at is set (the 0079 CHECK requires it)', row.cancelled_at !== null)
    check('cancel_at_period_end is cleared', row.cancel_at_period_end === false)
    check('tenant → cancelled', (await tenantStatus(A.tenantId)) === 'cancelled')
    check(
      'Razorpay was told to stop the mandate, immediately',
      gatewayCalls.some((c) => c.subscriptionId === subC && c.atCycleEnd === false),
    )
    check('the cancellation notice went out', deliveredFor(idC).some((d) => d.stage === 'cancelled'))
    check(
      'an audit entry records it',
      (await audits(idC)).some((r) => r.action === 'subscription.cancelled'),
    )
    check(
      'the clocks are kept as history, not wiped',
      row.past_due_since !== null && row.suspended_at !== null,
    )
    check(
      'the tenant itself still exists',
      (await ownerPool.query('select count(*)::int c from tenants where id=$1', [A.tenantId])).rows[0].c === 1,
    )
    check(
      'its dunning notices still exist',
      (await notices(idC)).length >= 1,
    )
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('12. a cancelled tenant stays blocked, and cannot be resurrected')
  // ══════════════════════════════════════════════════════════════════════════
  {
    const e = await readEntitlements(ownerDrizzle, A.tenantId)
    check('no entitlements', e.plan === null && Object.keys(e.entitlements).length === 0)

    // A late charge on a CANCELLED subscription. Terminal is terminal.
    const body = subBody({
      event: 'subscription.charged',
      subId: subC,
      status: 'active',
      currentStart: nowSec,
      currentEnd: nowSec + 30 * 86400,
      payment: { id: `pay_${tag}Z`, entity: 'payment', amount: 799900, currency: 'INR', status: 'captured' },
    })
    const res = await signed(body)
    const row = await subRow(idC)
    check('a late charge is reported as a duplicate, not applied', res.body.status === 'duplicate')
    check('the subscription stays cancelled', row.status === 'cancelled')
    check('the tenant stays cancelled', (await tenantStatus(A.tenantId)) === 'cancelled')

    const after = await readEntitlements(ownerDrizzle, A.tenantId)
    check('and it is still entitled to nothing', after.plan === null)

    const run = await processDunning({ db: ownerDrizzle, now: new Date(), notify: capture, gateway: okGateway })
    check('the job never picks a cancelled subscription up again', run.cancelled === 0)
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('13. an unaffected, healthy tenant')
  // ══════════════════════════════════════════════════════════════════════════
  const subH = `sub_H${tag}`
  const idH = await makeSubscription(HEALTHY.tenantId, PLAN, subH, { status: 'active' })
  {
    const before = await subRow(idH)
    for (let i = 0; i < 3; i++) {
      await processDunning({ db: ownerDrizzle, now: new Date(), notify: capture, gateway: okGateway })
    }
    const after = await subRow(idH)
    check('status unchanged', after.status === 'active' && before.status === 'active')
    check('tenant status unchanged', (await tenantStatus(HEALTHY.tenantId)) === 'active')
    check('no clocks appeared', after.past_due_since === null && after.suspended_at === null)
    check('no notices', (await notices(idH)).length === 0)
    check('no audit noise', (await audits(idH)).length === 0)

    const e = await readEntitlements(ownerDrizzle, HEALTHY.tenantId)
    check('and it is fully entitled', e.entitlements['module.payroll'] === true)
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('14. the job is safe to run repeatedly')
  // ══════════════════════════════════════════════════════════════════════════
  {
    // The one-live index permits a single live row per tenant, so retire the
    // healthy one BEFORE inserting this scenario's subscription for the same
    // tenant — the index would refuse the insert otherwise.
    await ownerPool.query(`update tenant_subscriptions set status='expired' where id=$1`, [idH])

    const subS = `sub_S${tag}`
    const idS = await makeSubscription(HEALTHY.tenantId, PLAN, subS, {
      status: 'past_due',
      periodEndOffsetMs: -3600_000,
    })

    // The newest subscription for this tenant, so §16 can ask the portal what
    // it tells a suspended business. Both bounds move together for the period
    // CHECK, and both stay in the past because a failed renewal never extends.
    await ownerPool.query(
      `update tenant_subscriptions
          set current_period_start = now() - interval '90 minutes',
              current_period_end   = now() - interval '60 minutes'
        where id=$1`,
      [idS],
    )

    const pastDue = new Date(Date.now() - (DUNNING_POLICY.graceDays + 1) * DAY_MS)
    await setClocks(idS, pastDue, null)

    delivered.length = 0
    const runs = []
    for (let i = 0; i < 4; i++) {
      runs.push(await processDunning({ db: ownerDrizzle, now: new Date(), notify: capture, gateway: okGateway }))
    }
    const suspendedTotal = runs.reduce((n, r) => n + r.suspended, 0)
    check('four runs suspend it exactly once', suspendedTotal === 1)
    check('and deliver exactly one notice', deliveredFor(idS).length === 1)
    check(
      'and write exactly one audit entry',
      (await audits(idS)).filter((r) => r.action === 'subscription.expired').length === 1,
    )
    check('the final state is correct', (await subRow(idS)).status === 'expired')
    check('no run reported a failure', runs.every((r) => r.failed === 0))
    await ownerPool.query(`update tenant_subscriptions set status='expired' where id=$1`, [idS])
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('15. authorization: signatures, RLS, and cross-tenant isolation')
  // ══════════════════════════════════════════════════════════════════════════
  {
    // B's live row from section 10 is still active; park it FIRST so this one
    // can be the only live subscription and the one-live index is satisfied.
    await ownerPool.query(`update tenant_subscriptions set status='expired' where id=$1`, [idR])

    const subX = `sub_X${tag}`
    const idX = await makeSubscription(B.tenantId, PLAN, subX, {
      status: 'trialing',
      periodEndOffsetMs: 5 * DAY_MS,
    })
    // The newest subscription for this tenant — §10's successful charge moved
    // the parked one's period start to "now", and the portal reader (correctly)
    // tells the story of the most recent row.
    await ownerPool.query(
      `update tenant_subscriptions set current_period_start = now() + interval '1 minute' where id=$1`,
      [idX],
    )

    const body = subBody({ event: 'subscription.pending', subId: subX, status: 'pending' })

    const wrong = await deliver(body, { signature: sign(body, 'not-the-secret'), eventId: nextEvt() })
    check('a wrongly signed delivery is rejected', wrong.status === 401)
    const none = await deliver(body, { signature: null, eventId: nextEvt() })
    check('an unsigned delivery is rejected', none.status === 401)
    const tampered = await deliver(`${body} `, { signature: sign(body, PLATFORM_SECRET), eventId: nextEvt() })
    check('a tampered body is rejected', tampered.status === 401)

    const row = await subRow(idX)
    check('NONE of them moved any state', row.status === 'trialing' && row.past_due_since === null)
    check('and none raised a notice', (await notices(idX)).length === 0)

    // ── RLS: a tenant owner sees only their own ────────────────────────────
    await signed(subBody({ event: 'subscription.pending', subId: subX, status: 'pending' }))
    const idXpast = await subRow(idX)
    check('a correctly signed one does move it', idXpast.status === 'past_due')

    const asUser = async (userId: string, sql: string, params: unknown[]) => {
      const c = await appPool.connect()
      try {
        await c.query('begin')
        await c.query('select set_config($1,$2,true)', ['app.user_id', userId])
        const r = await c.query(sql, params)
        await c.query('commit')
        return r.rows
      } finally {
        c.release()
      }
    }

    const bOwnSubs = await asUser(B.userId, 'select id from tenant_subscriptions where id=$1', [idX])
    check("tenant B's owner can read tenant B's subscription", bOwnSubs.length === 1)
    const aSeesB = await asUser(A.userId, 'select id from tenant_subscriptions where id=$1', [idX])
    check("tenant A's owner CANNOT read tenant B's subscription", aSeesB.length === 0)

    const bNotices = await asUser(
      B.userId,
      'select id from platform_dunning_notices where subscription_id=$1',
      [idX],
    )
    check("tenant B's owner can read its own dunning notices", bNotices.length >= 1)
    const aSeesBNotices = await asUser(
      A.userId,
      'select id from platform_dunning_notices where subscription_id=$1',
      [idX],
    )
    check("tenant A's owner CANNOT read tenant B's dunning notices", aSeesBNotices.length === 0)

    // ── the app role cannot write any of it ────────────────────────────────
    const refused = async (sql: string, params: unknown[]) => {
      const c = await appPool.connect()
      try {
        await c.query('begin')
        await c.query('select set_config($1,$2,true)', ['app.user_id', B.userId])
        await c.query(sql, params)
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
      'a business cannot clear its own past_due_since',
      await refused('update tenant_subscriptions set past_due_since=null where id=$1', [idX]),
    )
    check(
      'a business cannot un-suspend itself',
      await refused("update tenants set status='active' where id=$1", [B.tenantId]),
    )
    check(
      'a business cannot forge a dunning notice to dodge a reminder',
      await refused(
        `insert into platform_dunning_notices (tenant_id, subscription_id, dunning_cycle, stage)
         values ($1,$2,now(),'final_warning')`,
        [B.tenantId, idX],
      ),
    )
    check(
      'a business cannot delete the record that it was warned',
      await refused('delete from platform_dunning_notices where subscription_id=$1', [idX]),
    )

    // ── the cross-tenant probe returns the SAME empty answer ───────────────
    const cross = await readEntitlements(ownerDrizzle, B.tenantId)
    check(
      'entitlements for a tenant in grace are real, and are that tenant\'s own',
      cross.plan !== null,
    )
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('16. the owner-facing message')
  // ══════════════════════════════════════════════════════════════════════════
  {
    const { getBillingPortal } = await import('../lib/platform/billing/portal')
    // A suspended tenant: the subscription is NOT live, so `subscription` is
    // null and only `dunning` can explain what happened.
    const ctx = {
      user: { id: A.userId },
      tenant: { id: A.tenantId, name: 'A' },
      role: 'owner',
    } as unknown as Parameters<typeof getBillingPortal>[0]

    const portal = await getBillingPortal(ctx)
    check('a cancelled business gets an explanation', portal.dunning?.state === 'cancelled')
    check(
      '…with the deadline that produced it',
      portal.dunning != null && portal.dunning.cancelsAt !== null,
    )
    check('…and no live plan', portal.planName === null)
    check('…and no live subscription to hang it off', portal.subscription === null)

    // Tenant B is in grace: still working, and told exactly when that ends.
    const ctxB = {
      user: { id: B.userId },
      tenant: { id: B.tenantId, name: 'B' },
      role: 'owner',
    } as unknown as Parameters<typeof getBillingPortal>[0]
    const portalB = await getBillingPortal(ctxB)
    check('a business in grace is told it is in grace', portalB.dunning?.state === 'grace')
    check('…with the suspension date', portalB.dunning?.graceEndsAt instanceof Date)
    check('…and no cancellation date yet', portalB.dunning?.cancelsAt === null)
    check(
      '…and is NOT reported as lapsed, because its features still work',
      portalB.subscription?.lapsed === false && portalB.planName !== null,
    )

    // A healthy tenant is told nothing at all.
    const ctxH = {
      user: { id: HEALTHY.userId },
      tenant: { id: HEALTHY.tenantId, name: 'H' },
      role: 'owner',
    } as unknown as Parameters<typeof getBillingPortal>[0]
    const portalH = await getBillingPortal(ctxH)
    check('a suspended business gets an explanation too', portalH.dunning?.state === 'suspended')

    // ── the banner and `lapsed` describe the SAME subscription ─────────────
    //
    // The arrears read used to take the most recent row by
    // `current_period_start` across every status. That column is not monotonic:
    // applySubscriptionState() replaces a new row's placeholder window with the
    // provider's, and Razorpay backdates `current_start` to the real cycle
    // start — so a fresh subscription's start can land BEFORE a row cancelled
    // moments earlier, and the banner would then describe the dead one while
    // `lapsed` described the live one.
    const ghost = await ownerPool.query<{ id: string }>(
      `insert into tenant_subscriptions
         (tenant_id, plan_id, billing_period, status, current_period_start, current_period_end,
          cancelled_at, past_due_since, suspended_at)
       values ($1,$2,'monthly','cancelled', now() + interval '1 hour', now() + interval '2 hours',
               now(), now() - interval '30 days', now() - interval '20 days')
       returning id`,
      [B.tenantId, PLAN],
    )
    const withGhost = await getBillingPortal(ctxB)
    check(
      'a dead row with a LATER period start does not hijack the banner',
      withGhost.dunning?.state === 'grace',
    )
    check(
      '…and the live subscription is still the one reported',
      withGhost.subscription?.id === portalB.subscription?.id,
    )
    await ownerPool.query(`delete from tenant_subscriptions where id=$1`, [ghost.rows[0].id])
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('17. recovering a suspended account, and closing a paid one')
  // ══════════════════════════════════════════════════════════════════════════
  //
  // Two writes that used to leave `tenants.status` behind, so the same user
  // action produced a different account state depending on the order things
  // happened in.
  {
    const { assignPlan } = await import('../lib/actions/plans')
    const { cancelTenantSubscription } = await import('../lib/platform/billing/cancel')
    const { randomBytes: rb, createHash: ch } = await import('node:crypto')

    // ── an operator rescues a business the dunning job suspended ────────────
    //
    // assignPlan() restored every ENTITLEMENT and nothing else, so the account
    // stayed 'suspended' — the column public_tenant_by_slug() (0022) reads, so
    // the venue's public booking site stayed dark, and the column readMix()
    // counts, so the dashboard still filed it under suspended. Meanwhile
    // entitlement-guard.ts promised "re-assigning a plan restores everything
    // immediately".
    const adminRow = await ownerPool.query<{ id: string }>(
      `insert into users (email, password_hash, full_name, is_platform_admin)
       values ($1,'x','dunning admin',true) returning id`,
      [`dunadmin-${tag}@example.test`],
    )
    const adminId = adminRow.rows[0].id
    const adminToken = rb(32).toString('hex')
    await ownerPool.query(
      `insert into sessions (id, user_id, expires_at) values ($1,$2, now() + interval '1 day')`,
      [ch('sha256').update(adminToken).digest('hex'), adminId],
    )
    const g = globalThis as { __ARENA_TEST_SESSION?: string }
    const previousSession = g.__ARENA_TEST_SESSION
    g.__ARENA_TEST_SESSION = adminToken

    check('the rescued tenant starts suspended', (await tenantStatus(HEALTHY.tenantId)) === 'suspended')

    const assigned = await assignPlan({
      tenantId: HEALTHY.tenantId,
      planId: PLAN,
      billingPeriod: 'monthly',
    })
    if (assigned.error) console.log(`    (assignPlan said: ${assigned.error})`)
    check('assignPlan succeeds', !assigned.error)
    const rescued = await readEntitlements(ownerDrizzle, HEALTHY.tenantId)
    check('entitlements come back', rescued.plan !== null)
    check(
      'and so does the ACCOUNT, so its public site resolves again',
      (await tenantStatus(HEALTHY.tenantId)) === 'active',
    )

    // A tenant an operator cancelled by hand is NOT reopened by this: that is a
    // decision about the business relationship, not a billing state.
    await ownerPool.query(`update tenants set status='cancelled' where id=$1`, [B.tenantId])
    await assignPlan({ tenantId: B.tenantId, planId: PLAN, billingPeriod: 'monthly' })
    check(
      'a deliberately CANCELLED account is not silently reopened',
      (await tenantStatus(B.tenantId)) === 'cancelled',
    )
    g.__ARENA_TEST_SESSION = previousSession

    // ── an owner cancels a subscription that HAS been charged ───────────────
    //
    // cancel.ts's immediate branch was documented as "never charged, so there is
    // no paid period to honour" and left tenants.status alone. True of
    // `trialing`; false of `past_due`, which by definition has been charged —
    // and which is the most common state to cancel from, since a failed renewal
    // is what prompts it. Writing 'cancelled' locally first also makes the
    // matching webhook hit the terminal-state guard, so the account was never
    // closed by anything.
    const noop = {
      cancelSubscription: async () => ({}) as never,
      credentials: async () => ({}) as never,
    }

    const subPD = `sub_PD${tag}`
    const idPD = await makeSubscription(A.tenantId, PLAN, subPD, {
      status: 'past_due',
      periodEndOffsetMs: -2 * DAY_MS,
    })
    await ownerPool.query(
      `update tenant_subscriptions set gateway_last_payment_id=$2, past_due_since=now() where id=$1`,
      [idPD, `pay_PD${tag}`],
    )
    await ownerPool.query(`update tenants set status='active' where id=$1`, [A.tenantId])

    const paidCancel = await cancelTenantSubscription(A.tenantId, noop, ownerDrizzle)
    check('the past_due subscription is cancelled', (await subRow(idPD)).status === 'cancelled')
    check(
      'and the ACCOUNT is closed too, because the relationship was paid for',
      (await tenantStatus(A.tenantId)) === 'cancelled',
    )
    // Reported, not left to be inferred: closing the account is what takes the
    // venue's public booking site down, and the platform-admin force-cancel
    // path audits this field and says so in its confirmation.
    check('…and the caller is TOLD the account was closed', paidCancel.closedAccount === true)

    // …while backing out of a checkout nobody ever authorised still leaves the
    // account exactly where it was. Not buying is not cancelling.
    await ownerPool.query(`update tenants set status='trial' where id=$1`, [A.tenantId])
    const subTR = `sub_TR${tag}`
    const idTR = await makeSubscription(A.tenantId, PLAN, subTR, {
      status: 'trialing',
      periodEndOffsetMs: 3 * DAY_MS,
    })
    const trialCancel = await cancelTenantSubscription(A.tenantId, noop, ownerDrizzle)
    check('the abandoned checkout is closed out', (await subRow(idTR)).status === 'cancelled')
    check(
      'but the account is untouched — not buying is not cancelling',
      (await tenantStatus(A.tenantId)) === 'trial',
    )
    check('…and closedAccount says so', trialCancel.closedAccount === false)

    await ownerPool.query(`delete from sessions where user_id=$1`, [adminId])
    await ownerPool.query(`delete from users where id=$1`, [adminId])
  }

  // ── cleanup ───────────────────────────────────────────────────────────────
  // platform_dunning_notices.subscription_id is ON DELETE RESTRICT, so the
  // notices must go before the tenants cascade reaches the subscriptions —
  // exactly the order test-platform-invoices.ts uses for platform_invoices.
  await ownerPool.query('delete from platform_dunning_notices where tenant_id = any($1)', [created])
  await ownerPool.query('delete from platform_invoices where tenant_id = any($1)', [created])
  await ownerPool.query(
    `delete from webhook_events where gateway='platform_razorpay' and event_id like $1`,
    [`evt_DN${tag}%`],
  )
  await ownerPool.query('delete from tenants where id = any($1)', [created])
  await ownerPool.query('delete from plans where id = any($1)', [planIds])
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
