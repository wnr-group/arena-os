/**
 * AROS-50 — Razorpay webhook, end to end against a real database.
 *
 * These tests drive the ACTUAL route handler (app/api/webhooks/razorpay
 * route.ts) with real NextRequest objects and REAL HMAC-SHA256 signatures
 * computed with Razorpay's documented scheme. Nothing about the crypto is
 * stubbed — a test that faked the signature check would prove nothing.
 *
 * Covers: valid signature, tampered body, wrong secret, missing signature,
 * duplicate + concurrent delivery, replay, amount/currency/order/tenant/booking
 * mismatch, cancelled and already-settled intents, non-capture events, the
 * raw-body requirement, the invoice projection, and (M14 #6, v2) the SAME
 * route settling a standalone order's pay-now: invoice + payment creation,
 * the acceptance_status release to the kitchen, idempotency, and cross-tenant
 * isolation for that path too.
 *
 * No secret is printed.
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs scripts/test-razorpay-webhook.ts
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

async function main() {
  loadEnv()
  const { NextRequest } = await import('next/server')
  const { POST } = await import('../app/api/webhooks/razorpay/route')
  const { encryptSecret } = await import('../lib/security/encryption')
  const { verifyWebhookSignature } = await import('../lib/payments/razorpay-webhook')

  const ownerPool = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })

  // Stand-in webhook secrets. Never printed.
  const SECRET_A = `whsec_${randomBytes(16).toString('hex')}`
  const SECRET_B = `whsec_${randomBytes(16).toString('hex')}`

  /** Razorpay's documented scheme: hex HMAC-SHA256 of the RAW body. */
  const sign = (rawBody: string, secret: string) =>
    createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')

  const ROOT = (process.env.NEXT_PUBLIC_ROOT_DOMAIN ?? 'lvh.me:3000').split(':')[0]

  /** Post a raw body to the route, exactly as Razorpay would. */
  async function deliver(
    slug: string,
    rawBody: string,
    opts: { signature?: string | null; eventId?: string | null } = {},
  ) {
    const headers = new Headers({ 'content-type': 'application/json' })
    if (opts.signature !== null) {
      headers.set('x-razorpay-signature', opts.signature ?? '')
    }
    if (opts.eventId) headers.set('x-razorpay-event-id', opts.eventId)
    headers.set('host', `${slug}.${ROOT}`)

    const req = new NextRequest(`https://${slug}.${ROOT}/api/webhooks/razorpay`, {
      method: 'POST',
      headers,
      body: rawBody,
    })
    const res = await POST(req)
    return { status: res.status, body: (await res.json()) as { status?: string } }
  }

  /** A payment.captured body. Written by hand so the raw bytes are ours. */
  const capturedBody = (o: {
    orderId: string
    paymentId: string
    amountPaise: number
    currency?: string
    status?: string
    event?: string
  }) =>
    JSON.stringify({
      entity: 'event',
      account_id: 'acc_TEST',
      event: o.event ?? 'payment.captured',
      contains: ['payment'],
      payload: {
        payment: {
          entity: {
            id: o.paymentId,
            entity: 'payment',
            amount: o.amountPaise,
            currency: o.currency ?? 'INR',
            status: o.status ?? 'captured',
            order_id: o.orderId,
            method: 'upi',
          },
        },
      },
      created_at: 1755500000,
    })

  // ── fixtures ──────────────────────────────────────────────────────────────
  let seq = 0
  async function makeTenant(slug: string, webhookSecret: string) {
    const t = await ownerPool.query<{ id: string }>(
      `insert into tenants (slug,name,status,timezone) values ($1,$2,'active','Asia/Kolkata')
       on conflict (slug) do update set name=excluded.name, status='active' returning id`,
      [slug, `${slug} co`],
    )
    const tenantId = t.rows[0].id
    const b = await ownerPool.query<{ id: string }>(
      `insert into branches (tenant_id,name,is_primary) values ($1,'Main',true) returning id`,
      [tenantId],
    )
    await ownerPool.query(
      `insert into payment_settings (tenant_id, razorpay_key_id, razorpay_key_secret_encrypted,
                                     razorpay_webhook_secret_encrypted)
       values ($1,$2,$3,$4)
       on conflict (tenant_id) do update set razorpay_webhook_secret_encrypted = excluded.razorpay_webhook_secret_encrypted`,
      [
        tenantId,
        `rzp_test_${slug}`,
        encryptSecret(`apikey-${randomBytes(6).toString('hex')}`, tenantId),
        encryptSecret(webhookSecret, tenantId),
      ],
    )
    return { slug, tenantId, branchId: b.rows[0].id }
  }

  async function makeIntent(
    t: { tenantId: string; branchId: string },
    amount: string,
    o: { status?: string; currency?: string } = {},
  ) {
    seq++
    const bk = await ownerPool.query<{ id: string }>(
      `insert into bookings (tenant_id,branch_id,booking_number,customer_name,status,source,
                             subtotal,total,deposit)
       values ($1,$2,$3,'Guest','confirmed','online','2000.00','2000.00',$4) returning id`,
      [t.tenantId, t.branchId, `BK-WH-${String(seq).padStart(3, '0')}`, amount],
    )
    const orderId = `order_WH${String(seq).padStart(10, '0')}`
    const pi = await ownerPool.query<{ id: string }>(
      `insert into payment_intents (tenant_id,branch_id,booking_id,gateway_order_id,amount,currency,status)
       values ($1,$2,$3,$4,$5,$6,$7) returning id`,
      [t.tenantId, t.branchId, bk.rows[0].id, orderId, amount, o.currency ?? 'INR', o.status ?? 'pending'],
    )
    return { intentId: pi.rows[0].id, bookingId: bk.rows[0].id, orderId }
  }

  const intentRow = async (id: string) =>
    (await ownerPool.query('select * from payment_intents where id=$1', [id])).rows[0]
  const paymentCount = async (tenantId: string) =>
    Number((await ownerPool.query('select count(*)::int n from payments where tenant_id=$1', [tenantId])).rows[0].n)

  // ── M14 #6 (v2) fixtures: a standalone (no-booking) order, paid via the
  // SAME webhook a booking deposit uses — see lib/payments/webhook.ts's
  // branch on payment_intents.purpose.
  async function makeStandaloneOrder(
    t: { tenantId: string; branchId: string },
    o: { acceptanceStatus?: string; status?: string } = {},
  ) {
    seq++
    const c = await ownerPool.query<{ id: string }>(
      `insert into customers (tenant_id, phone, name) values ($1,$2,$3)
       on conflict (tenant_id, phone) do update set name = excluded.name returning id`,
      [t.tenantId, `+9198766${String(10000 + seq).slice(-5)}`, 'Order-WH Guest'],
    )
    const ord = await ownerPool.query<{ id: string }>(
      `insert into orders (tenant_id,branch_id,order_number,status,channel,acceptance_status,customer_id)
       values ($1,$2,$3,$4,'online',$5,$6) returning id`,
      [
        t.tenantId,
        t.branchId,
        `OR-WH-${String(seq).padStart(3, '0')}`,
        o.status ?? 'open',
        o.acceptanceStatus ?? 'awaiting_payment',
        c.rows[0].id,
      ],
    )
    return { dbOrderId: ord.rows[0].id, customerId: c.rows[0].id }
  }

  /** A single-line order totalling exactly `amount` (0% tax, qty 1). */
  async function makeOrderIntent(
    t: { tenantId: string; branchId: string },
    amount: string,
    o: { acceptanceStatus?: string; status?: string } = {},
  ) {
    seq++
    const { dbOrderId, customerId } = await makeStandaloneOrder(t, o)
    await ownerPool.query(
      `insert into order_items (tenant_id, order_id, item_name, unit_price, tax_rate, qty, line_total)
       values ($1,$2,'Test Item',$3,'0',1,$3)`,
      [t.tenantId, dbOrderId, amount],
    )
    const orderId = `order_OWH${String(seq).padStart(10, '0')}`
    const pi = await ownerPool.query<{ id: string }>(
      `insert into payment_intents (tenant_id,branch_id,order_id,purpose,gateway_order_id,amount,currency,status)
       values ($1,$2,$3,'order_payment',$4,$5,'INR','pending') returning id`,
      [t.tenantId, t.branchId, dbOrderId, orderId, amount],
    )
    return { intentId: pi.rows[0].id, dbOrderId, customerId, orderId }
  }

  const orderRow = async (id: string) =>
    (await ownerPool.query('select * from orders where id=$1', [id])).rows[0]
  const paymentByGatewayId = async (gatewayPaymentId: string) =>
    (await ownerPool.query('select * from payments where gateway_payment_id=$1', [gatewayPaymentId])).rows[0]

  const A = await makeTenant('testwha', SECRET_A)
  const B = await makeTenant('testwhb', SECRET_B)

  // ── 1. the signing primitive, in isolation ────────────────────────────────
  {
    const body = '{"event":"payment.captured"}'
    const sig = sign(body, SECRET_A)
    check('a correctly computed signature verifies', verifyWebhookSignature(body, sig, SECRET_A))
    check('…the same body under a DIFFERENT secret does not', !verifyWebhookSignature(body, sig, SECRET_B))
    check('…one flipped byte in the body breaks it', !verifyWebhookSignature(body + ' ', sig, SECRET_A))
    check('…an uppercase hex signature still verifies', verifyWebhookSignature(body, sig.toUpperCase(), SECRET_A))
    check('…a truncated signature is refused', !verifyWebhookSignature(body, sig.slice(0, 32), SECRET_A))
    check('…a non-hex signature is refused', !verifyWebhookSignature(body, 'z'.repeat(64), SECRET_A))
    check('…an empty signature is refused', !verifyWebhookSignature(body, '', SECRET_A))
    check('…a null signature is refused', !verifyWebhookSignature(body, null, SECRET_A))
    check('…an empty secret can never verify', !verifyWebhookSignature(body, sig, ''))
  }

  // ── 2. the happy path ─────────────────────────────────────────────────────
  {
    const { intentId, bookingId, orderId } = await makeIntent(A, '500.00')
    const body = capturedBody({ orderId, paymentId: 'pay_WH0000000001', amountPaise: 50000 })
    const res = await deliver(A.slug, body, { signature: sign(body, SECRET_A), eventId: 'evt_WH01' })

    check('a validly signed payment.captured is accepted (200)', res.status === 200)
    check('…reported as processed', res.body.status === 'processed')

    const row = await intentRow(intentId)
    check('…the intent is now PAID', row.status === 'paid')
    check('…with the Razorpay payment id persisted', row.gateway_payment_id === 'pay_WH0000000001')
    check('…the amount is untouched', row.amount === '500.00')
    check('…and the booking is the one our intent named', row.booking_id === bookingId)

    const ev = (await ownerPool.query(`select * from webhook_events where event_id='evt_WH01'`)).rows[0]
    check('…the delivery is logged against the verified tenant', ev?.tenant_id === A.tenantId && ev.outcome === 'processed')
    check('…no invoice payment row (no invoice exists yet — that is AROS-51)', (await paymentCount(A.tenantId)) === 0)
  }

  // ── 3. tampering ──────────────────────────────────────────────────────────
  {
    const { intentId, orderId } = await makeIntent(A, '500.00')
    const honest = capturedBody({ orderId, paymentId: 'pay_WH0000000002', amountPaise: 50000 })
    const signature = sign(honest, SECRET_A)

    // The classic attack: keep the signature, raise the amount.
    const tampered = capturedBody({ orderId, paymentId: 'pay_WH0000000002', amountPaise: 1 })
    const res = await deliver(A.slug, tampered, { signature, eventId: 'evt_WH02' })
    check('a tampered body with the original signature is REJECTED (401)', res.status === 401)
    check('…the intent is still pending', (await intentRow(intentId)).status === 'pending')

    // One byte, nothing semantic.
    const oneByte = honest.replace('"captured"', '"captured "')
    check('…one changed byte is also rejected', (await deliver(A.slug, oneByte, { signature, eventId: 'evt_WH02b' })).status === 401)

    // Signed by the wrong tenant.
    const wrongSecret = await deliver(A.slug, honest, { signature: sign(honest, SECRET_B), eventId: 'evt_WH03' })
    check("a body signed with ANOTHER tenant's secret is rejected", wrongSecret.status === 401)

    const noSig = await deliver(A.slug, honest, { signature: null, eventId: 'evt_WH04' })
    check('a missing signature header is rejected', noSig.status === 401)
    const junkSig = await deliver(A.slug, honest, { signature: 'not-a-signature', eventId: 'evt_WH05' })
    check('a malformed signature is rejected', junkSig.status === 401)

    check('…and after all of that the intent is STILL pending', (await intentRow(intentId)).status === 'pending')
    check('…with no payment id', (await intentRow(intentId)).gateway_payment_id === null)
    check('…and no webhook_events row was written for a rejected signature', Number((await ownerPool.query(`select count(*)::int n from webhook_events where event_id in ('evt_WH02','evt_WH02b','evt_WH03','evt_WH04','evt_WH05')`)).rows[0].n) === 0)

    // Now the honest one works, proving the fixture was valid all along.
    const good = await deliver(A.slug, honest, { signature, eventId: 'evt_WH06' })
    check('the untampered body with the same signature IS accepted', good.status === 200 && good.body.status === 'processed')
  }

  // ── 4. the raw-body requirement ───────────────────────────────────────────
  {
    const { intentId, orderId } = await makeIntent(A, '500.00')
    // A body whose re-serialisation differs from the original bytes: extra
    // whitespace and a float that JSON.stringify would rewrite as an integer.
    const raw = `{ "event": "payment.captured",\n  "payload": { "payment": { "entity": {\n    "id": "pay_WH0000000003", "order_id": "${orderId}",\n    "amount": 50000, "currency": "INR", "status": "captured" } } } }`
    const reserialised = JSON.stringify(JSON.parse(raw))
    check('the raw body and its re-serialisation genuinely differ', raw !== reserialised)
    check('…and their signatures differ too', sign(raw, SECRET_A) !== sign(reserialised, SECRET_A))

    const res = await deliver(A.slug, raw, { signature: sign(raw, SECRET_A), eventId: 'evt_WH07' })
    check('the route verifies against the RAW bytes, not a re-serialisation', res.status === 200 && res.body.status === 'processed')
    check('…and processed the payment', (await intentRow(intentId)).gateway_payment_id === 'pay_WH0000000003')

    // The inverse: signing the re-serialised form must NOT be accepted.
    const { orderId: o2 } = await makeIntent(A, '500.00')
    const raw2 = raw.replace(orderId, o2).replace('pay_WH0000000003', 'pay_WH0000000004')
    const wrong = await deliver(A.slug, raw2, {
      signature: sign(JSON.stringify(JSON.parse(raw2)), SECRET_A),
      eventId: 'evt_WH08',
    })
    check('…a signature over the RE-SERIALISED body is rejected', wrong.status === 401)
  }

  // ── 5. idempotency: duplicate, replay, concurrent ─────────────────────────
  {
    const { intentId, orderId } = await makeIntent(A, '500.00')
    const body = capturedBody({ orderId, paymentId: 'pay_WH0000000010', amountPaise: 50000 })
    const signature = sign(body, SECRET_A)

    const first = await deliver(A.slug, body, { signature, eventId: 'evt_WH10' })
    check('first delivery is processed', first.body.status === 'processed')

    // Exact replay: same bytes, same signature, same event id.
    const replay = await deliver(A.slug, body, { signature, eventId: 'evt_WH10' })
    check('an exact REPLAY is a no-op (200 duplicate)', replay.status === 200 && replay.body.status === 'duplicate')

    // Retry under a NEW event id — same payment. This is why payment id, not
    // event id, is the money-level key.
    const retry = await deliver(A.slug, body, { signature, eventId: 'evt_WH11' })
    check('a redelivery under a DIFFERENT event id is also a no-op', retry.body.status === 'duplicate')

    // No event id header at all — the payment id must still carry idempotency.
    const noEvent = await deliver(A.slug, body, { signature })
    check('a delivery with NO event id is still deduped by payment id', noEvent.body.status === 'duplicate')

    const rows = await ownerPool.query(
      `select count(*)::int n from payment_intents where gateway_payment_id='pay_WH0000000010'`,
    )
    check('…exactly ONE intent carries that payment id', rows.rows[0].n === 1)
    check('…and it is paid exactly once', (await intentRow(intentId)).status === 'paid')

    // A DIFFERENT payment against the same, already-settled intent.
    const second = capturedBody({ orderId, paymentId: 'pay_WH0000000011', amountPaise: 50000 })
    const dbl = await deliver(A.slug, second, { signature: sign(second, SECRET_A), eventId: 'evt_WH12' })
    check('a SECOND payment on a settled intent is rejected (no double charge)', dbl.body.status === 'rejected')
    check('…and the original payment id is unchanged', (await intentRow(intentId)).gateway_payment_id === 'pay_WH0000000010')
  }

  // ── 6. concurrent duplicate delivery ──────────────────────────────────────
  {
    const { intentId, orderId } = await makeIntent(A, '500.00')
    const body = capturedBody({ orderId, paymentId: 'pay_WH0000000020', amountPaise: 50000 })
    const signature = sign(body, SECRET_A)

    // Same event id (Razorpay retrying) and different event ids (two edges),
    // all at once — the harder case.
    const results = await Promise.all([
      deliver(A.slug, body, { signature, eventId: 'evt_WH20' }),
      deliver(A.slug, body, { signature, eventId: 'evt_WH20' }),
      deliver(A.slug, body, { signature, eventId: 'evt_WH21' }),
      deliver(A.slug, body, { signature, eventId: 'evt_WH22' }),
      deliver(A.slug, body, { signature }),
    ])

    const processed = results.filter((r) => r.body.status === 'processed').length
    check('five concurrent deliveries → exactly ONE processed', processed === 1)
    check('…every other response is a safe 200', results.every((r) => r.status === 200))
    check('…exactly one intent row carries the payment id', Number((await ownerPool.query(`select count(*)::int n from payment_intents where gateway_payment_id='pay_WH0000000020'`)).rows[0].n) === 1)
    check('…the intent is paid', (await intentRow(intentId)).status === 'paid')
    check('…and no duplicate payments row exists', (await paymentCount(A.tenantId)) === 0)
  }

  // ── 7. content mismatches ─────────────────────────────────────────────────
  {
    const cases: [string, { amountPaise?: number; currency?: string; status?: string; badOrder?: boolean }][] = [
      ['the amount is lower than our record (₹1 vs ₹500)', { amountPaise: 100 }],
      ['the amount is higher than our record', { amountPaise: 500000 }],
      ['the amount is off by one paisa', { amountPaise: 49999 }],
      ['the currency is not ours', { currency: 'USD' }],
      ['the payment entity is not captured', { status: 'authorized' }],
      ['the order id names a different order', { badOrder: true }],
    ]
    let n = 30
    for (const [label, o] of cases) {
      const { intentId, orderId } = await makeIntent(A, '500.00')
      const paymentId = `pay_WH00000000${n}`
      const body = capturedBody({
        orderId: o.badOrder ? 'order_SOMEONE_ELSE' : orderId,
        paymentId,
        amountPaise: o.amountPaise ?? 50000,
        currency: o.currency,
        status: o.status,
      })
      const res = await deliver(A.slug, body, { signature: sign(body, SECRET_A), eventId: `evt_WH${n}` })
      // A bad order id matches no intent at all → 'ignored'; the rest are
      // matched and then refused → 'rejected'. Neither pays.
      const refused = res.body.status === 'rejected' || res.body.status === 'ignored'
      check(`a validly SIGNED webhook is refused when ${label}`, res.status === 200 && refused)
      check(`…the intent stays pending and unpaid`, (await intentRow(intentId)).status === 'pending' && (await intentRow(intentId)).gateway_payment_id === null)
      n++
    }
    check('no payments row was created by any mismatch', (await paymentCount(A.tenantId)) === 0)
  }

  // ── 8. unknown order, and non-capture events ──────────────────────────────
  {
    const ghost = capturedBody({ orderId: 'order_NEVER_CREATED', paymentId: 'pay_WH0000000050', amountPaise: 50000 })
    const res = await deliver(A.slug, ghost, { signature: sign(ghost, SECRET_A), eventId: 'evt_WH50' })
    check('a signed webhook for an UNKNOWN order creates nothing', res.status === 200 && res.body.status === 'ignored')
    check('…and no intent was invented', Number((await ownerPool.query(`select count(*)::int n from payment_intents where gateway_order_id='order_NEVER_CREATED'`)).rows[0].n) === 0)

    for (const event of ['payment.failed', 'payment.authorized', 'order.paid', 'refund.created']) {
      const { intentId, orderId } = await makeIntent(A, '500.00')
      const body = capturedBody({ orderId, paymentId: `pay_EV_${event}`, amountPaise: 50000, event })
      const r = await deliver(A.slug, body, { signature: sign(body, SECRET_A), eventId: `evt_${event}` })
      check(`a signed '${event}' does NOT mark anything paid`, r.status === 200 && r.body.status === 'ignored')
      check(`…the intent is untouched`, (await intentRow(intentId)).status === 'pending')
    }

    const garbage = 'not json at all'
    const g = await deliver(A.slug, garbage, { signature: sign(garbage, SECRET_A), eventId: 'evt_WH51' })
    check('a signed but non-JSON body is safely ignored', g.status === 200 && g.body.status === 'ignored')

    const shaped = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'x' } } } })
    const s = await deliver(A.slug, shaped, { signature: sign(shaped, SECRET_A), eventId: 'evt_WH52' })
    check('a signed payload missing required fields is safely ignored', s.status === 200 && s.body.status === 'ignored')
  }

  // ── 9. cross-tenant ───────────────────────────────────────────────────────
  {
    const bIntent = await makeIntent(B, '900.00')
    const body = capturedBody({ orderId: bIntent.orderId, paymentId: 'pay_WH0000000060', amountPaise: 90000 })

    // Tenant A's URL, tenant A's secret, but naming tenant B's order.
    const crossed = await deliver(A.slug, body, { signature: sign(body, SECRET_A), eventId: 'evt_WH60' })
    check("tenant A's signed webhook cannot settle tenant B's order", crossed.status === 200 && crossed.body.status === 'ignored')
    check("…tenant B's intent is untouched", (await intentRow(bIntent.intentId)).status === 'pending')

    // Tenant B's order posted to tenant A's URL but signed with B's secret:
    // the signature fails because A's secret is the one loaded for that host.
    const wrongHost = await deliver(A.slug, body, { signature: sign(body, SECRET_B), eventId: 'evt_WH61' })
    check("…and B's secret does not verify at A's webhook URL", wrongHost.status === 401)
    check("…B's intent STILL untouched", (await intentRow(bIntent.intentId)).status === 'pending')

    // The legitimate delivery, at B's own URL with B's own secret.
    const legit = await deliver(B.slug, body, { signature: sign(body, SECRET_B), eventId: 'evt_WH62' })
    check("tenant B's own webhook settles tenant B's order", legit.body.status === 'processed')
    check('…and tenant A gained nothing from any of it', (await paymentCount(A.tenantId)) === 0)

    const unknownSlug = await deliver('testwh-nope', body, { signature: sign(body, SECRET_B), eventId: 'evt_WH63' })
    check('an unknown tenant slug is rejected as unauthorized', unknownSlug.status === 401)
  }

  // ── 10. intents that must not be settled ──────────────────────────────────
  {
    for (const status of ['cancelled', 'failed'] as const) {
      const { intentId, orderId } = await makeIntent(A, '500.00', { status })
      const body = capturedBody({ orderId, paymentId: `pay_WH_${status}`, amountPaise: 50000 })
      const r = await deliver(A.slug, body, { signature: sign(body, SECRET_A), eventId: `evt_WH_${status}` })
      check(`a payment against a ${status} intent is rejected, not auto-captured`, r.body.status === 'rejected')
      check(`…and it stays ${status}`, (await intentRow(intentId)).status === status)
    }
  }

  // ── 11. the invoice projection ────────────────────────────────────────────
  {
    const { intentId, bookingId, orderId } = await makeIntent(A, '500.00')
    const inv = await ownerPool.query<{ id: string }>(
      `insert into invoices (tenant_id,branch_id,invoice_number,booking_id,subtotal,total,status,issued_at)
       values ($1,$2,$3,$4,'2000.00','2000.00','issued',now()) returning id`,
      [A.tenantId, A.branchId, `INV/WH/${seq}`, bookingId],
    )
    const body = capturedBody({ orderId, paymentId: 'pay_WH0000000070', amountPaise: 50000 })
    const r = await deliver(A.slug, body, { signature: sign(body, SECRET_A), eventId: 'evt_WH70' })
    check('with an issued invoice present, the deposit is processed', r.body.status === 'processed')
    check('…the intent is paid', (await intentRow(intentId)).status === 'paid')

    const pay = (await ownerPool.query(`select * from payments where invoice_id=$1`, [inv.rows[0].id])).rows
    check('…a payments row was recorded through the M1 path', pay.length === 1)
    check('…as method=online, status=captured', pay[0].method === 'online' && pay[0].status === 'captured')
    check('…for ₹500 with the gateway references attached', pay[0].amount === '500.00' && pay[0].gateway_payment_id === 'pay_WH0000000070' && pay[0].gateway_order_id === orderId)
    check('…with no collecting cashier (no human took this money)', pay[0].collected_by === null)

    const invRow = (await ownerPool.query('select status from invoices where id=$1', [inv.rows[0].id])).rows[0]
    check('…the ₹2000 invoice is NOT settled by a ₹500 deposit', invRow.status === 'issued')

    // Overpayment guard: a deposit larger than the invoice must not be recorded
    // against it, and must not fail the webhook either.
    const small = await makeIntent(A, '5000.00')
    const smallInv = await ownerPool.query<{ id: string }>(
      `insert into invoices (tenant_id,branch_id,invoice_number,booking_id,subtotal,total,status,issued_at)
       values ($1,$2,$3,$4,'100.00','100.00','issued',now()) returning id`,
      [A.tenantId, A.branchId, `INV/WH/OVER${seq}`, small.bookingId],
    )
    const bigBody = capturedBody({ orderId: small.orderId, paymentId: 'pay_WH0000000071', amountPaise: 500000 })
    const br = await deliver(A.slug, bigBody, { signature: sign(bigBody, SECRET_A), eventId: 'evt_WH71' })
    check('a deposit larger than the invoice still settles the intent', br.body.status === 'processed' && (await intentRow(small.intentId)).status === 'paid')
    check('…but is NOT recorded as an overpayment on the invoice', Number((await ownerPool.query('select count(*)::int n from payments where invoice_id=$1', [smallInv.rows[0].id])).rows[0].n) === 0)
  }

  // ── 12. nothing secret escapes ────────────────────────────────────────────
  {
    const { orderId } = await makeIntent(A, '500.00')
    const body = capturedBody({ orderId, paymentId: 'pay_WH0000000080', amountPaise: 50000 })
    const res = await deliver(A.slug, body, { signature: sign(body, SECRET_A), eventId: 'evt_WH80' })
    const serialised = JSON.stringify(res.body)
    check('the webhook response contains no webhook secret', !serialised.includes(SECRET_A))
    check('…no API key secret', !serialised.includes('apikey-'))
    check('…and is just a status word', JSON.stringify(Object.keys(res.body)) === '["status"]')

    const settingsRow = (await ownerPool.query('select * from payment_settings where tenant_id=$1', [A.tenantId])).rows[0]
    check('the stored webhook secret is ciphertext, not plaintext', settingsRow.razorpay_webhook_secret_encrypted !== SECRET_A && settingsRow.razorpay_webhook_secret_encrypted.startsWith('v1:'))
    check('…and is a DIFFERENT value from the API key secret', settingsRow.razorpay_webhook_secret_encrypted !== settingsRow.razorpay_key_secret_encrypted)

    const anyPlaintext = await ownerPool.query(
      `select count(*)::int n from payment_settings
        where razorpay_webhook_secret_encrypted is not null
          and razorpay_webhook_secret_encrypted !~ '^v[0-9]+:'`,
    )
    check('no plaintext webhook secret exists anywhere in the table', anyPlaintext.rows[0].n === 0)
  }

  // ── 13. order_payment: pay-now for a standalone order (M14 #6, v2) ────────
  {
    const { intentId, dbOrderId, customerId, orderId } = await makeOrderIntent(A, '354.00')

    // Before payment: invisible to BOTH the staff accept/reject queue
    // (which filters acceptance_status='pending') and /kitchen (which
    // filters acceptance_status='accepted') — see lib/orders/data.ts and
    // lib/kots/data.ts, neither of which needed a code change for this.
    const before = await orderRow(dbOrderId)
    check('before payment: the order sits at awaiting_payment', before.acceptance_status === 'awaiting_payment')
    check('…neither pending (staff queue) nor accepted (kitchen)', before.acceptance_status !== 'pending' && before.acceptance_status !== 'accepted')

    const body = capturedBody({ orderId, paymentId: 'pay_WH_ORD001', amountPaise: 35400 })
    const res = await deliver(A.slug, body, { signature: sign(body, SECRET_A), eventId: 'evt_WH_ORD01' })

    check('a validly signed order-payment is accepted (200)', res.status === 200)
    check('…reported as processed', res.body.status === 'processed')

    const intent = await intentRow(intentId)
    check('…the intent is now PAID', intent.status === 'paid')
    check('…it names the order, not a booking', intent.order_id === dbOrderId && intent.booking_id === null)

    const order = await orderRow(dbOrderId)
    check('…released to the kitchen (acceptance_status → accepted)', order.acceptance_status === 'accepted')
    check('…and billed, so it can never be picked up by a bill a second time', order.status === 'billed')

    const pay = await paymentByGatewayId('pay_WH_ORD001')
    check('…a captured payment was recorded', pay !== undefined && pay.status === 'captured' && pay.method === 'online')
    check('…for the full order total, with the gateway references attached', pay.amount === '354.00' && pay.gateway_order_id === orderId)
    check('…with no collecting cashier (no human took this money)', pay.collected_by === null)

    const inv = (await ownerPool.query('select * from invoices where id=$1', [pay.invoice_id])).rows[0]
    check('…a standalone invoice was raised (no booking)', inv.booking_id === null)
    check('…for the customer this order was placed under', inv.customer_id === customerId)
    check('…totalling exactly the order, fully settled', inv.total === '354.00' && inv.status === 'paid')

    const items = (await ownerPool.query('select * from invoice_items where invoice_id=$1', [inv.id])).rows
    check('…exactly one food line, sourced from the order item', items.length === 1 && items[0].kind === 'food')
  }

  // Idempotency: a redelivery for an already-settled order must not raise a
  // second invoice or re-flip a status that already moved.
  {
    const { intentId, dbOrderId, orderId } = await makeOrderIntent(A, '200.00')
    const body = capturedBody({ orderId, paymentId: 'pay_WH_ORD002', amountPaise: 20000 })
    const signature = sign(body, SECRET_A)

    const first = await deliver(A.slug, body, { signature, eventId: 'evt_WH_ORD02' })
    check('first delivery is processed', first.body.status === 'processed')
    const invoicesAfterFirst = Number(
      (await ownerPool.query('select count(*)::int n from invoices where tenant_id=$1', [A.tenantId])).rows[0].n,
    )

    const replay = await deliver(A.slug, body, { signature, eventId: 'evt_WH_ORD02' })
    check('an exact replay is a no-op (duplicate)', replay.body.status === 'duplicate')
    const invoicesAfterReplay = Number(
      (await ownerPool.query('select count(*)::int n from invoices where tenant_id=$1', [A.tenantId])).rows[0].n,
    )
    check('…no second invoice was raised', invoicesAfterReplay === invoicesAfterFirst)

    const retry = await deliver(A.slug, body, { signature, eventId: 'evt_WH_ORD02b' })
    check('…nor under a different event id for the same payment', retry.body.status === 'duplicate')

    check('…the intent settled exactly once', (await intentRow(intentId)).status === 'paid')
    check(
      '…and the order is still exactly one step past awaiting_payment',
      (await orderRow(dbOrderId)).acceptance_status === 'accepted',
    )
  }

  // An order NOT sitting at awaiting_payment (already accepted through some
  // other path, or already billed) must refuse rather than double-process —
  // the same discipline section 10 proves for a cancelled/failed deposit
  // intent, here proved for the order's own state instead of the intent's.
  {
    const { orderId, dbOrderId, intentId } = await makeOrderIntent(A, '150.00', { acceptanceStatus: 'accepted' })
    const body = capturedBody({ orderId, paymentId: 'pay_WH_ORD003', amountPaise: 15000 })
    const res = await deliver(A.slug, body, { signature: sign(body, SECRET_A), eventId: 'evt_WH_ORD03' })

    check('a payment for an order not awaiting payment is rejected', res.body.status === 'rejected')
    check('…the intent stays pending, unsettled', (await intentRow(intentId)).status === 'pending')
    const order = await orderRow(dbOrderId)
    check('…the order status is untouched', order.status === 'open' && order.acceptance_status === 'accepted')
    check('…no invoice or payment was created for it', (await paymentByGatewayId('pay_WH_ORD003')) === undefined)
  }

  // Cross-tenant: tenant A's signed webhook must not be able to settle
  // tenant B's order-payment intent, mirroring section 9 for deposits.
  {
    const bIntent = await makeOrderIntent(B, '999.00')
    const body = capturedBody({ orderId: bIntent.orderId, paymentId: 'pay_WH_ORD004', amountPaise: 99900 })
    const crossed = await deliver(A.slug, body, { signature: sign(body, SECRET_A), eventId: 'evt_WH_ORD04' })
    check("tenant A's signed webhook cannot settle tenant B's order", crossed.status === 200 && crossed.body.status === 'ignored')
    check("…tenant B's order is untouched", (await orderRow(bIntent.dbOrderId)).acceptance_status === 'awaiting_payment')
  }

  // ── cleanup ───────────────────────────────────────────────────────────────
  await ownerPool.query('delete from webhook_events where tenant_id = any($1)', [[A.tenantId, B.tenantId]])
  await ownerPool.query('delete from tenants where id = any($1)', [[A.tenantId, B.tenantId]])
  await ownerPool.end()

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error('test harness error:', e instanceof Error ? `${e.name}: ${e.message}` : 'unknown')
  process.exit(1)
})
