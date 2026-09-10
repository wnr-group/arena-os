/**
 * DEV TOOL — simulate a Razorpay `payment.captured` webhook for a pending
 * deposit or order-payment intent, locally, without any network reachability
 * to your machine.
 *
 * Why this exists: Razorpay's servers call YOUR webhook URL after a payment
 * completes. In local dev that URL is typically something like
 * `https://{slug}.lvh.me:3000/api/webhooks/razorpay` — `lvh.me` resolves to
 * 127.0.0.1 EVERYWHERE, including from Razorpay's own servers, so the
 * request can never actually arrive. Without a public tunnel (ngrok etc.),
 * a pay-now order or a booking deposit paid in the Checkout modal sits stuck
 * forever (payment_intents.status='pending', the order/booking never
 * released), even though the "payment" genuinely succeeded on Razorpay's
 * side in test mode.
 *
 * This script does NOT bypass verification or fake success server-side. It:
 *   1. loads the TENANT'S REAL webhook secret (the same one
 *      lib/settings/razorpay-webhook-secret.ts's loadWebhookSecretBySlug
 *      would, just called directly here),
 *   2. builds a payment.captured payload matching the intent's actual
 *      amount/currency/gateway_order_id,
 *   3. signs it with that real secret — a genuine HMAC-SHA256 over the raw
 *      bytes, exactly Razorpay's documented scheme,
 *   4. and POSTs it through the REAL route handler (app/api/webhooks/
 *      razorpay/route.ts), in-process — the same technique
 *      scripts/test-razorpay-webhook.ts uses, which is what sidesteps the
 *      reachability problem: no network hop, no tunnel, no DNS involved.
 *
 * The only thing "simulated" is Razorpay's own HTTP call; everything this
 * script's payload then goes through is the production code path,
 * unmodified.
 *
 * Usage:
 *   npx tsx --import ./scripts/server-only-hook.mjs scripts/simulate-payment.ts <identifier>
 *
 * where <identifier> is an order number, a booking number, or — for a
 * tournament entry fee — the event title, the gateway order id, or the
 * registration id.
 *
 * Tries an order first, then a booking, by that identifier.
 */
import { createHmac, randomBytes } from 'node:crypto'
import { Pool } from 'pg'
import { loadEnv } from './env'

async function main() {
  loadEnv()
  const identifier = process.argv[2]
  if (!identifier) {
    console.error('Usage: simulate-payment.ts <order-number | booking-number | event-title | gateway-order-id | registration-id>')
    process.exit(1)
  }

  const { NextRequest } = await import('next/server')
  const { POST } = await import('../app/api/webhooks/razorpay/route')
  const { loadWebhookSecretBySlug } = await import('../lib/settings/razorpay-webhook-secret')
  const { paise } = await import('../lib/billing/pricing')

  const pool = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })

  type Target = { kind: 'order' | 'booking' | 'event registration'; label: string; tenantId: string }
  type Intent = { id: string; gatewayOrderId: string; amount: string; currency: string; status: string }

  async function findByOrder(): Promise<{ target: Target; intent: Intent } | null> {
    const o = await pool.query<{ id: string; tenant_id: string; order_number: string }>(
      `select id, tenant_id, order_number from orders where order_number = $1`,
      [identifier],
    )
    if (o.rows.length === 0) return null
    const order = o.rows[0]
    const pi = await pool.query<Intent>(
      `select id, gateway_order_id as "gatewayOrderId", amount, currency, status
         from payment_intents
        where order_id = $1 and purpose = 'order_payment'
        order by created_at desc limit 1`,
      [order.id],
    )
    if (pi.rows.length === 0) return null
    return { target: { kind: 'order', label: order.order_number, tenantId: order.tenant_id }, intent: pi.rows[0] }
  }

  async function findByBooking(): Promise<{ target: Target; intent: Intent } | null> {
    const b = await pool.query<{ id: string; tenant_id: string; booking_number: string }>(
      `select id, tenant_id, booking_number from bookings where booking_number = $1`,
      [identifier],
    )
    if (b.rows.length === 0) return null
    const booking = b.rows[0]
    const pi = await pool.query<Intent>(
      `select id, gateway_order_id as "gatewayOrderId", amount, currency, status
         from payment_intents
        where booking_id = $1 and purpose = 'booking_deposit'
        order by created_at desc limit 1`,
      [booking.id],
    )
    if (pi.rows.length === 0) return null
    return { target: { kind: 'booking', label: booking.booking_number, tenantId: booking.tenant_id }, intent: pi.rows[0] }
  }

  /**
   * An EVENT REGISTRATION (M15). Same shape as the two above, added because
   * the events entry fee goes through the identical intent → webhook path and
   * therefore gets identically stuck in local dev — but this script predates
   * M15 and only knew about orders and bookings.
   *
   * Looked up by the EVENT's title rather than a number, because a
   * registration has no human-facing reference: the customer sees the event,
   * not an id. The newest pending intent for that event wins, which is what
   * you want after retrying a checkout a few times.
   */
  async function findByEvent(): Promise<{ target: Target; intent: Intent } | null> {
    const pi = await pool.query<Intent & { title: string; tenant_id: string }>(
      `select pi.id, pi.gateway_order_id as "gatewayOrderId", pi.amount, pi.currency, pi.status,`
        + ` e.title, e.tenant_id`
        + ` from payment_intents pi`
        + ` join event_registrations r on r.id = pi.event_registration_id`
        + ` join events e on e.id = r.event_id`
        + ` where pi.purpose = 'event_registration'`
        + `   and (e.title = $1 or pi.gateway_order_id = $1 or r.id::text = $1)`
        + ` order by pi.status = 'pending' desc, pi.created_at desc limit 1`,
      [identifier],
    )
    if (pi.rows.length === 0) return null
    const row = pi.rows[0]
    return {
      target: { kind: 'event registration', label: row.title, tenantId: row.tenant_id },
      intent: row,
    }
  }

  const found = (await findByOrder()) ?? (await findByBooking()) ?? (await findByEvent())
  if (!found) {
    console.error(`No order, booking or event registration "${identifier}" with a payment_intents row was found.`)
    await pool.end()
    process.exit(1)
  }

  const { target, intent } = found
  console.log(`Found ${target.kind} ${target.label}: intent ${intent.id}, status=${intent.status}, amount=₹${intent.amount}`)

  if (intent.status !== 'pending') {
    console.log(`This intent is already '${intent.status}' — nothing to simulate. If you want to re-test, place a new order/deposit.`)
    await pool.end()
    return
  }

  const slugRow = await pool.query<{ slug: string }>(`select slug from tenants where id = $1`, [target.tenantId])
  const slug = slugRow.rows[0]?.slug
  if (!slug) {
    console.error(`Tenant ${target.tenantId} has no slug — cannot resolve a webhook URL for it.`)
    await pool.end()
    process.exit(1)
  }

  const webhookTenant = await loadWebhookSecretBySlug(slug)
  if (!webhookTenant) {
    console.error(
      `Tenant "${slug}" has no webhook secret configured (Settings → Payments in the app) — cannot sign a payload for it.`,
    )
    await pool.end()
    process.exit(1)
  }

  const amountPaise = paise(Number(intent.amount))
  const paymentId = `pay_SIM${randomBytes(7).toString('hex')}`
  const body = JSON.stringify({
    entity: 'event',
    account_id: 'acc_SIMULATED',
    event: 'payment.captured',
    contains: ['payment'],
    payload: {
      payment: {
        entity: {
          id: paymentId,
          entity: 'payment',
          amount: amountPaise,
          currency: intent.currency,
          status: 'captured',
          order_id: intent.gatewayOrderId,
          method: 'upi',
        },
      },
    },
    created_at: Math.floor(Date.now() / 1000),
  })

  const signature = createHmac('sha256', webhookTenant.webhookSecret).update(body, 'utf8').digest('hex')
  const eventId = `evt_SIM${randomBytes(8).toString('hex')}`

  const ROOT = (process.env.NEXT_PUBLIC_ROOT_DOMAIN ?? 'lvh.me:3000').split(':')[0]
  const req = new NextRequest(`https://${slug}.${ROOT}/api/webhooks/razorpay`, {
    method: 'POST',
    headers: new Headers({
      'content-type': 'application/json',
      'x-razorpay-signature': signature,
      'x-razorpay-event-id': eventId,
      host: `${slug}.${ROOT}`,
    }),
    body,
  })

  console.log(`Delivering a signed payment.captured (payment ${paymentId}) through the real route handler...`)
  const res = await POST(req)
  const json = (await res.json()) as { status?: string }
  console.log(`Response: ${res.status} ${JSON.stringify(json)}`)

  if (target.kind === 'order') {
    const after = await pool.query(
      `select status, acceptance_status from orders where order_number = $1`,
      [identifier],
    )
    console.log('Order now:', after.rows[0])
  } else {
    const after = await pool.query(`select status from payment_intents where id = $1`, [intent.id])
    console.log('Intent now:', after.rows[0])
  }

  await pool.end()
}

main().catch((e) => {
  console.error('simulate-payment failed:', e instanceof Error ? `${e.name}: ${e.message}` : e)
  process.exit(1)
})
