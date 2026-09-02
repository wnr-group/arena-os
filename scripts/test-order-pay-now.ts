/**
 * M14 #6 (v2) — pay-now for a standalone order, exercised through the REAL
 * public RLS path (withPublicTenant / arena_app role), not raw owner-pool
 * SQL fixtures pretending to be the app.
 *
 * Why this script exists, specifically: scripts/test-razorpay-webhook.ts
 * seeds its fixtures directly with the OWNER connection and only drives the
 * webhook ROUTE — it never runs createOrderCore or createOrderPaymentIntent
 * under the restricted public connection, so it could not have caught (and
 * did not catch) two real production bugs:
 *
 *   1. lib/payments/order-payment.ts's loadPayableOrder did `SELECT ... FOR
 *      UPDATE` on `orders` from the PUBLIC connection. Postgres requires a
 *      row to also pass the table's UPDATE RLS policy to be lockable that
 *      way — and orders has no public UPDATE policy (by design; see
 *      migration 0056) — so the query silently returned ZERO rows. Fixed by
 *      dropping the lock (not needed: an order's total is immutable after
 *      creation).
 *   2. order_items had a public INSERT policy (0056) but no public SELECT
 *      one, so loadOrderFoodLines — reading items back to price the
 *      Razorpay order — also silently saw zero rows. Fixed by migration
 *      0060.
 *
 * Both failed the exact same way: no error at the SQL level, just an empty
 * result set, which is precisely what RLS is designed to produce and
 * precisely why a raw-SQL-fixture test cannot catch it — the bug is in
 * whether the APP's own restricted role can see its own writes, which only
 * running the real code path through withPublicTenant() exercises.
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs scripts/test-order-pay-now.ts
 */
import { randomUUID } from 'node:crypto'
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
  const { withPublicTenant, ownerDb } = await import('../db')
  const { createOrderCore } = await import('../lib/orders/service')
  const { getPublicBookingForOrder } = await import('../lib/booking/public-confirmation')
  const { loadOrderFoodLines } = await import('../lib/billing/invoice')
  const {
    createOrderPaymentIntent,
    createOrderPaymentIntentInputSchema,
    OrderPaymentError,
  } = await import('../lib/payments/order-payment')
  const { sql } = await import('drizzle-orm')

  const ownerPool = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })

  const slug = 'testpaynow'
  const t = await ownerPool.query<{ id: string }>(
    `insert into tenants (slug,name,status,timezone) values ($1,'Pay Now Co','active','Asia/Kolkata')
     on conflict (slug) do update set status='active' returning id`,
    [slug],
  )
  const tenantId = t.rows[0].id
  await ownerPool.query('delete from branches where tenant_id=$1', [tenantId])
  const b = await ownerPool.query<{ id: string }>(
    `insert into branches (tenant_id,name,is_primary) values ($1,'Main',true) returning id`,
    [tenantId],
  )
  const branchId = b.rows[0].id

  const cat = await ownerPool.query<{ id: string }>(
    `insert into menu_categories (tenant_id,name) values ($1,'Test Category') returning id`,
    [tenantId],
  )
  const item = await ownerPool.query<{ id: string }>(
    `insert into menu_items (tenant_id,category_id,name,price,status) values ($1,$2,'Test Burger','249.00','available') returning id`,
    [tenantId, cat.rows[0].id],
  )
  const menuItemId = item.rows[0].id

  const cust = await ownerPool.query<{ id: string }>(
    `insert into customers (tenant_id,phone,name) values ($1,$2,'Pay Now Guest')
     on conflict (tenant_id,phone) do update set name=excluded.name returning id`,
    [tenantId, '+919812300001'],
  )
  const customerId = cust.rows[0].id

  // ── 1. place a standalone order through the REAL createOrderCore, under
  //      withPublicTenant — same call shape lib/actions/public-orders.ts's
  //      placeOnlineOrder uses for a pay-now order. ─────────────────────────
  const created = await withPublicTenant(tenantId, (tx) =>
    createOrderCore(
      tx,
      { tenantId, timezone: 'Asia/Kolkata', membershipId: null },
      {
        branchId,
        customerId,
        channel: 'online',
        acceptanceStatus: 'awaiting_payment',
        idempotencyKey: randomUUID(),
        items: [{ menuItemId, qty: 2 }],
      },
    ),
  )
  check('order created via createOrderCore under withPublicTenant', Boolean(created.id))

  const orderRow = async () =>
    (await ownerPool.query('select * from orders where id=$1', [created.id])).rows[0]

  check('…sits at acceptance_status=awaiting_payment', (await orderRow()).acceptance_status === 'awaiting_payment')

  // ── 2. loadOrderFoodLines under the SAME public connection — this is
  //      exactly where bug #2 (no order_items_public_select) hid. ─────────
  const lines = await withPublicTenant(tenantId, (tx) => loadOrderFoodLines(tx, tenantId, created.id))
  check('order_items are readable under the PUBLIC connection (0060)', lines.length === 1)
  check('…with the right quantity and price', lines[0]?.qty === 2 && lines[0]?.unitPrice === 249)

  // Belt and braces: prove this is genuinely RLS, not a fluke — the owner
  // connection (which bypasses RLS) must see the same row count regardless.
  const ownerCount = await ownerDb.execute<{ n: string }>(
    sql`select count(*)::int as n from order_items where order_id = ${created.id}`,
  )
  check('…and the owner connection agrees on the row count', Number(ownerCount.rows[0].n) === lines.length)

  // ── 3. createOrderPaymentIntent under the PUBLIC connection, with a fake
  //      gateway so no real Razorpay call happens — this is exactly where
  //      bug #1 (the disallowed FOR UPDATE) hid. ─────────────────────────
  let gatewayCalls = 0
  const fakeCreateOrder = async (
    _credentials: { keyId: string; keySecret: string },
    params: { amountPaise: number; currency: string; receipt: string },
  ) => {
    gatewayCalls++
    return {
      id: `order_FAKE${randomUUID().replace(/-/g, '').slice(0, 14)}`,
      amount: params.amountPaise,
      currency: params.currency,
      status: 'created',
      receipt: params.receipt,
    }
  }

  const v = createOrderPaymentIntentInputSchema.parse({ orderId: created.id })
  const checkout = await createOrderPaymentIntent(v, {
    runInTx: (fn) => withPublicTenant(tenantId, fn),
    credentials: { keyId: 'rzp_test_fake', keySecret: 'fake-secret' },
    createOrder: fakeCreateOrder,
    actor: { tenantId },
  })

  check('createOrderPaymentIntent succeeds under the public connection (not "Order not found")', Boolean(checkout.orderId))
  check('…priced at ₹498 (2 × ₹249)', checkout.amountRupees === 498 && checkout.amount === 49800)
  check('…exactly one gateway call was made', gatewayCalls === 1)

  const intentRow = (
    await ownerPool.query('select * from payment_intents where gateway_order_id=$1', [checkout.orderId])
  ).rows[0]
  check('…a payment_intents row was persisted, naming the order', intentRow?.order_id === created.id && intentRow?.booking_id === null)
  check('…purpose=order_payment, status=pending', intentRow?.purpose === 'order_payment' && intentRow?.status === 'pending')

  // ── 4. calling it again reuses the same pending intent (idempotent) and
  //      makes NO second gateway call. ─────────────────────────────────────
  const again = await createOrderPaymentIntent(v, {
    runInTx: (fn) => withPublicTenant(tenantId, fn),
    credentials: { keyId: 'rzp_test_fake', keySecret: 'fake-secret' },
    createOrder: fakeCreateOrder,
    actor: { tenantId },
  })
  check('a second call reuses the pending intent', again.orderId === checkout.orderId && again.reused === true)
  check('…without calling the gateway again', gatewayCalls === 1)

  // ── 5. an order attached to a booking is refused — pay-now is standalone
  //      only, "no open booking to add to". ────────────────────────────────
  const bk = await ownerPool.query<{ confirmation_token: string }>(
    `insert into bookings (tenant_id,branch_id,booking_number,customer_name,status,source,subtotal,total)
     values ($1,$2,$3,'Guest','confirmed','online','0','0') returning confirmation_token`,
    [tenantId, branchId, `BK-PN-${randomUUID().slice(0, 8)}`],
  )

  // Resolved through the same public path the "add food to your visit"
  // nudge uses (lib/actions/public-orders.ts), not the raw id from the
  // fixture insert above — this is what actually exercises the
  // withPublicTenant bookingId branch in createOrderCore end-to-end,
  // including the RLS-shaped SELECT that resolves the token.
  const resolvedBooking = await getPublicBookingForOrder(tenantId, bk.rows[0].confirmation_token)
  check('booking resolves via the public confirmation-token path', Boolean(resolvedBooking))

  const withBooking = await withPublicTenant(tenantId, (tx) =>
    createOrderCore(
      tx,
      { tenantId, timezone: 'Asia/Kolkata', membershipId: null },
      {
        branchId,
        bookingId: resolvedBooking!.id,
        customerId,
        channel: 'online',
        acceptanceStatus: 'awaiting_payment',
        idempotencyKey: randomUUID(),
        items: [{ menuItemId, qty: 1 }],
      },
    ),
  )
  check('order attaches to the booking under withPublicTenant (no false "Booking not found")', Boolean(withBooking.id))
  try {
    await createOrderPaymentIntent(createOrderPaymentIntentInputSchema.parse({ orderId: withBooking.id }), {
      runInTx: (fn) => withPublicTenant(tenantId, fn),
      credentials: { keyId: 'rzp_test_fake', keySecret: 'fake-secret' },
      createOrder: fakeCreateOrder,
      actor: { tenantId },
    })
    check('an order attached to a booking is refused pay-now', false)
  } catch (e) {
    check(
      'an order attached to a booking is refused pay-now',
      e instanceof OrderPaymentError && /booking/i.test(e.message),
    )
  }
  check('…and no gateway call was made for it', gatewayCalls === 1)

  // ── cleanup ───────────────────────────────────────────────────────────────
  await ownerPool.query('delete from tenants where id=$1', [tenantId])
  await ownerPool.end()

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error('test harness error:', e instanceof Error ? `${e.name}: ${e.message}` : e)
  process.exit(1)
})
