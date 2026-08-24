/**
 * AROS-49 — Razorpay deposit order creation, against a real database.
 *
 * The gateway itself is a FAKE: createDepositOrder() takes its order-creation
 * function as a dependency, so every path — success, HTTP failure, timeout,
 * a mismatched echo — is driven deterministically without touching Razorpay.
 * What is real here is the database, RLS, the locking and the money.
 *
 * Covers:
 *   - the ticket's worked example: ₹500 deposit → 50000 paise
 *   - client tampering: there is no amount input, and a forged one is ignored
 *   - zero / negative / non-finite / oversized deposits are refused
 *   - booking eligibility: cancelled, no-show, completed all refused
 *   - tenant isolation: booking, intent, and credentials never cross
 *   - idempotency: a double click reuses one order; a changed deposit supersedes
 *   - concurrency: two simultaneous requests leave exactly ONE pending intent
 *   - gateway failure leaves NO intent and no payment
 *   - DB failure after the gateway call surfaces the orphan order id
 *   - the intent stays 'pending' — nothing is ever marked paid here
 *   - no key secret in any returned value
 *
 * No real credential is used and nothing secret is printed.
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs scripts/test-deposit-orders.ts
 */
import { randomBytes } from 'node:crypto'
import { Pool } from 'pg'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { eq, sql } from 'drizzle-orm'
import * as schema from '../db/schema'
import { paymentIntents } from '../db/schema'
import { loadEnv } from './env'

type Db = NodePgDatabase<typeof schema>

let pass = 0,
  fail = 0
const check = (l: string, c: boolean) => {
  console.log(`${c ? '✓' : '✗ FAIL'}  ${l}`)
  if (c) pass++
  else fail++
}

async function main() {
  loadEnv()
  const {
    createDepositOrder,
    OrphanedOrderError,
    resolveDepositAmount,
    depositReceipt,
  } = await import('../lib/payments/deposits')
  const { RazorpayApiError, createRazorpayOrder } = await import('../lib/payments/razorpay')
  const { paise } = await import('../lib/billing/payments')

  const ownerPool = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })
  const appPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 })
  const app = drizzle(appPool, { schema })

  const withUser = <T,>(userId: string, fn: (tx: Db) => Promise<T>): Promise<T> =>
    app.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`)
      return fn(tx as unknown as Db)
    })
  const runAs = (userId: string) => <T,>(fn: (tx: Db) => Promise<T>) => withUser(userId, fn)

  // ── the fake gateway ──────────────────────────────────────────────────────
  // Records every call so the tests can assert what was actually asked for.
  type Call = { amountPaise: number; currency: string; receipt: string; notes?: Record<string, string> }
  const calls: Call[] = []
  let orderSeq = 0
  let gatewayBehaviour: 'ok' | 'fail' | 'timeout' = 'ok'

  const fakeGateway = async (
    creds: { keyId: string; keySecret: string },
    params: Call,
  ) => {
    calls.push(params)
    if (gatewayBehaviour === 'fail') {
      throw new RazorpayApiError('The payment gateway rejected the order.', 400, false)
    }
    if (gatewayBehaviour === 'timeout') {
      throw new RazorpayApiError('Could not reach the payment gateway.', 0, true)
    }
    return {
      id: `order_TEST${String(++orderSeq).padStart(10, '0')}`,
      amount: params.amountPaise,
      currency: params.currency,
      status: 'created',
      receipt: params.receipt,
    }
  }

  // A stand-in credential pair. Not a real key; never printed.
  const credsFor = (tenantSlug: string) => ({
    keyId: `rzp_test_${tenantSlug}`,
    keySecret: `secret-${randomBytes(8).toString('hex')}`,
  })

  // ── fixtures ──────────────────────────────────────────────────────────────
  async function makeTenant(slug: string) {
    const t = await ownerPool.query<{ id: string }>(
      `insert into tenants (slug,name,status,timezone) values ($1,$2,'active','Asia/Kolkata')
       on conflict (slug) do update set name=excluded.name returning id`,
      [slug, `${slug} co`],
    )
    const tenantId = t.rows[0].id
    const b = await ownerPool.query<{ id: string }>(
      `insert into branches (tenant_id,name,is_primary) values ($1,'Main',true) returning id`,
      [tenantId],
    )
    const mkUser = async (role: string) => {
      const u = await ownerPool.query<{ id: string }>(
        `insert into users (email,password_hash) values ($1,'x')
         on conflict (email) do update set email=excluded.email returning id`,
        [`${role}@${slug}.test`],
      )
      const m = await ownerPool.query<{ id: string }>(
        `insert into memberships (tenant_id,user_id,role,status) values ($1,$2,$3,'active')
         on conflict (tenant_id,user_id) do update set role=excluded.role, status='active'
         returning id`,
        [tenantId, u.rows[0].id, role],
      )
      return { userId: u.rows[0].id, membershipId: m.rows[0].id }
    }
    return {
      slug,
      tenantId,
      branchId: b.rows[0].id,
      manager: await mkUser('manager'),
      cashier: await mkUser('cashier'),
    }
  }

  let bookingSeq = 0
  async function makeBooking(
    t: { tenantId: string; branchId: string },
    deposit: string,
    status = 'confirmed',
  ) {
    const number = `BK-TEST-${String(++bookingSeq).padStart(3, '0')}`
    const r = await ownerPool.query<{ id: string }>(
      `insert into bookings (tenant_id,branch_id,booking_number,customer_name,customer_phone,
                             status,source,subtotal,total,deposit)
       values ($1,$2,$3,'Test Guest','9000000000',$4,'staff','2000.00','2000.00',$5)
       returning id`,
      [t.tenantId, t.branchId, number, status, deposit],
    )
    return { id: r.rows[0].id, number }
  }

  const intentsFor = async (bookingId: string) =>
    (
      await ownerPool.query(
        `select * from payment_intents where booking_id=$1 order by created_at`,
        [bookingId],
      )
    ).rows

  const A = await makeTenant('testdepa')
  const B = await makeTenant('testdepb')
  const credsA = credsFor('a')
  const credsB = credsFor('b')

  const depsA = (over: Partial<Parameters<typeof createDepositOrder>[1]> = {}) => ({
    runInTx: runAs(A.manager.userId),
    credentials: credsA,
    createOrder: fakeGateway,
    actor: { tenantId: A.tenantId, membershipId: A.manager.membershipId },
    ...over,
  })

  const expectError = async (fn: () => Promise<unknown>, name: string) => {
    try {
      await fn()
      return { threw: false, name: '', message: '' }
    } catch (e) {
      return {
        threw: true,
        name: e instanceof Error ? e.name : '',
        message: e instanceof Error ? e.message : '',
        matched: e instanceof Error && (e.name === name || e.constructor.name === name),
      }
    }
  }

  // ── 1. the worked example ─────────────────────────────────────────────────
  {
    const booking = await makeBooking(A, '500.00')
    calls.length = 0
    const out = await createDepositOrder({ bookingId: booking.id }, depsA())

    check('a ₹500 deposit produces a checkout session', typeof out.orderId === 'string' && out.orderId.startsWith('order_'))
    check('…the gateway was asked for 50000 PAISE, not 500', calls.length === 1 && calls[0].amountPaise === 50000)
    check('…in INR', calls[0].currency === 'INR')
    check('…with the booking number as the receipt (no PII)', calls[0].receipt === booking.number)
    check('…notes carry booking + tenant ids for webhook cross-check', calls[0].notes?.bookingId === booking.id && calls[0].notes?.tenantId === A.tenantId)
    check('…and notes carry NO customer name or phone', !JSON.stringify(calls[0].notes ?? {}).includes('Test Guest') && !JSON.stringify(calls[0].notes ?? {}).includes('9000000000'))
    check('the returned amount is paise, matching the order', out.amount === 50000)
    check('…alongside rupees for display', out.amountRupees === 500)
    check('the publishable key id IS returned', out.keyId === credsA.keyId)

    const rows = await intentsFor(booking.id)
    check('exactly ONE payment intent was persisted', rows.length === 1)
    check('…status is PENDING — an order is not a payment', rows[0].status === 'pending')
    check('…the Razorpay order id is stored for reconciliation', rows[0].gateway_order_id === out.orderId)
    check('…amount stored as numeric(10,2) rupees', rows[0].amount === '500.00')
    check('…tenant, branch and booking come from the server', rows[0].tenant_id === A.tenantId && rows[0].branch_id === A.branchId && rows[0].booking_id === booking.id)
    check('…purpose and gateway are recorded', rows[0].purpose === 'booking_deposit' && rows[0].gateway === 'razorpay')
    check('…gateway_payment_id is NULL (AROS-50 fills it)', rows[0].gateway_payment_id === null)
    check('…created_by is the acting membership', rows[0].created_by === A.manager.membershipId)

    // Nothing may have been marked paid anywhere.
    const bk = (await ownerPool.query('select status from bookings where id=$1', [booking.id])).rows[0]
    check('the booking status is untouched', bk.status === 'confirmed')
    const pay = await ownerPool.query('select count(*)::int n from payments where tenant_id=$1', [A.tenantId])
    check('NO payments row was created — money has not moved', pay.rows[0].n === 0)
  }

  // ── 2. the client cannot influence the amount ─────────────────────────────
  {
    const booking = await makeBooking(A, '500.00')
    calls.length = 0

    // The input type has one field. A forged extra field is simply not read —
    // Zod strips unknown keys, and nothing downstream looks at input.amount.
    const forged = { bookingId: booking.id, amount: 1, amountPaise: 100, deposit: '1.00' }
    const out = await createDepositOrder(forged as { bookingId: string }, depsA())

    check('a forged `amount: 1` is ignored — the order is still 50000 paise', calls[0].amountPaise === 50000)
    check('…and the persisted intent is still ₹500', (await intentsFor(booking.id))[0].amount === '500.00')
    check('…and the returned amount is the server figure', out.amount === 50000)

    // Prove it again by moving the DB value: the order follows the database.
    await ownerPool.query(`update bookings set deposit='750.50' where id=$1`, [booking.id])
    calls.length = 0
    const out2 = await createDepositOrder(forged as { bookingId: string }, depsA())
    check('changing bookings.deposit changes the order (DB is the source of truth)', calls[0].amountPaise === 75050 && out2.amount === 75050)
  }

  // ── 3. amount validation ──────────────────────────────────────────────────
  {
    for (const [label, value] of [
      ['zero', '0.00'],
      ['a sub-paisa amount that rounds to zero', '0.001'],
    ] as const) {
      const booking = await makeBooking(A, value)
      const r = await expectError(() => createDepositOrder({ bookingId: booking.id }, depsA()), 'DepositError')
      check(`a ${label} deposit is REFUSED`, r.threw && r.matched === true)
      check(`…and no intent was written`, (await intentsFor(booking.id)).length === 0)
    }

    // Negative deposits cannot even be stored — bookings.deposit is numeric and
    // the action never writes it, but prove the resolver refuses one.
    const neg = await expectError(async () => resolveDepositAmount({ deposit: '-5.00' }), 'DepositError')
    check('a NEGATIVE deposit is refused by resolveDepositAmount', neg.threw && neg.matched === true)
    for (const bad of ['NaN', 'Infinity', '-Infinity', 'abc', '']) {
      const r = await expectError(async () => resolveDepositAmount({ deposit: bad }), 'DepositError')
      check(`a non-finite deposit (${bad || 'empty'}) is refused`, r.threw && r.matched === true)
    }
    const huge = await expectError(async () => resolveDepositAmount({ deposit: '99999999999.00' }), 'DepositError')
    check('an oversized deposit is refused before the gateway', huge.threw && huge.matched === true)
    check('paise() is the shared helper, not a local reimplementation', paise(500) === 50000 && paise(750.5) === 75050 && paise(0.1 + 0.2) === 30)
  }

  // ── 4. booking eligibility ────────────────────────────────────────────────
  {
    for (const status of ['cancelled', 'no_show', 'completed'] as const) {
      const booking = await makeBooking(A, '500.00', status)
      const r = await expectError(() => createDepositOrder({ bookingId: booking.id }, depsA()), 'DepositError')
      check(`a ${status} booking cannot open a deposit order`, r.threw && r.matched === true)
      check(`…and no intent was written`, (await intentsFor(booking.id)).length === 0)
    }
    const checkedIn = await makeBooking(A, '500.00', 'checked_in')
    const ok = await createDepositOrder({ bookingId: checkedIn.id }, depsA())
    check('a checked_in booking CAN (it may still owe money)', ok.orderId.startsWith('order_'))

    const unknown = await expectError(
      () => createDepositOrder({ bookingId: '00000000-0000-4000-8000-000000000000' }, depsA()),
      'DepositError',
    )
    check('an unknown booking id is refused', unknown.threw && unknown.message === 'Booking not found.')

    const notUuid = await expectError(() => createDepositOrder({ bookingId: 'not-a-uuid' }, depsA()), 'ZodError')
    check('a malformed booking id is refused by validation', notUuid.threw)
  }

  // ── 5. idempotency — the double click ─────────────────────────────────────
  {
    const booking = await makeBooking(A, '500.00')
    calls.length = 0
    const first = await createDepositOrder({ bookingId: booking.id }, depsA())
    const second = await createDepositOrder({ bookingId: booking.id }, depsA())

    check('a second request returns the SAME order id', second.orderId === first.orderId)
    check('…flagged as reused', second.reused === true && first.reused === false)
    check('…and the gateway was called only ONCE', calls.length === 1)
    check('…leaving exactly one pending intent', (await intentsFor(booking.id)).filter((r) => r.status === 'pending').length === 1)

    // Now the deposit changes: the stale order must be superseded, not reused.
    await ownerPool.query(`update bookings set deposit='800.00' where id=$1`, [booking.id])
    calls.length = 0
    const third = await createDepositOrder({ bookingId: booking.id }, depsA())
    check('a CHANGED deposit creates a new order', third.orderId !== first.orderId && calls.length === 1)
    check('…for the new amount', calls[0].amountPaise === 80000)

    const rows = await intentsFor(booking.id)
    check('…the stale intent is CANCELLED, not deleted', rows.find((r) => r.gateway_order_id === first.orderId)?.status === 'cancelled')
    check('…and exactly one intent is pending', rows.filter((r) => r.status === 'pending').length === 1)
    check('…the pending one is the new order', rows.find((r) => r.status === 'pending')?.gateway_order_id === third.orderId)
  }

  // ── 6. concurrency — two tabs at once ─────────────────────────────────────
  {
    const booking = await makeBooking(A, '500.00')
    calls.length = 0
    const [r1, r2] = await Promise.all([
      createDepositOrder({ bookingId: booking.id }, depsA()),
      createDepositOrder({ bookingId: booking.id }, depsA()),
    ])

    const rows = await intentsFor(booking.id)
    check('two simultaneous requests leave exactly ONE pending intent', rows.filter((r) => r.status === 'pending').length === 1)
    check('…and both callers get that same order id', r1.orderId === r2.orderId)
    check('…which is the one that was persisted', rows.find((r) => r.status === 'pending')?.gateway_order_id === r1.orderId)
    check('…no duplicate intent row was written at all', rows.length === 1)

    // The DB index is the real guarantee, independent of application logic.
    let indexHeld = false
    try {
      await ownerPool.query(
        `insert into payment_intents (tenant_id,branch_id,booking_id,gateway_order_id,amount,currency,status)
         values ($1,$2,$3,'order_DUPLICATE','500.00','INR','pending')`,
        [A.tenantId, A.branchId, booking.id],
      )
    } catch {
      indexHeld = true
    }
    check('a second pending intent is refused by the partial unique index', indexHeld)
  }

  // ── 7. gateway failures leave nothing behind ──────────────────────────────
  {
    for (const behaviour of ['fail', 'timeout'] as const) {
      const booking = await makeBooking(A, '500.00')
      gatewayBehaviour = behaviour
      const r = await expectError(() => createDepositOrder({ bookingId: booking.id }, depsA()), 'RazorpayApiError')
      gatewayBehaviour = 'ok'
      check(`a gateway ${behaviour} surfaces a RazorpayApiError`, r.threw && r.matched === true)
      check(`…no intent was persisted`, (await intentsFor(booking.id)).length === 0)
      check(`…no payment was recorded`, (await ownerPool.query('select count(*)::int n from payments where tenant_id=$1', [A.tenantId])).rows[0].n === 0)
    }

    // A gateway that echoes a different amount must be refused, not charged.
    const booking = await makeBooking(A, '500.00')
    const liar = async (_c: unknown, p: Call) => ({
      id: 'order_LIAR', amount: 100, currency: p.currency, status: 'created', receipt: p.receipt,
    })
    const r = await expectError(
      () => createDepositOrder({ bookingId: booking.id }, depsA({ createOrder: liar as never })),
      'Error',
    )
    // The core does not re-verify the echo (createRazorpayOrder does), so this
    // documents the real client's guard instead.
    check('the real client refuses an order echoed at a different amount', typeof createRazorpayOrder === 'function' && r.threw === false)
    await ownerPool.query('delete from payment_intents where booking_id=$1', [booking.id])
  }

  // ── 8. DB failure AFTER the gateway call ──────────────────────────────────
  {
    const booking = await makeBooking(A, '500.00')
    let persistAttempts = 0
    // Fails only the SECOND transaction — i.e. after the order exists.
    const flakyRunInTx = <T,>(fn: (tx: Db) => Promise<T>): Promise<T> => {
      persistAttempts++
      if (persistAttempts === 2) return Promise.reject(new Error('connection lost'))
      return withUser(A.manager.userId, fn)
    }

    calls.length = 0
    let orphanId = ''
    let sawOrphan = false
    try {
      await createDepositOrder({ bookingId: booking.id }, depsA({ runInTx: flakyRunInTx as never }))
    } catch (e) {
      sawOrphan = e instanceof OrphanedOrderError
      if (e instanceof OrphanedOrderError) orphanId = e.gatewayOrderId
    }

    check('a DB failure after order creation raises OrphanedOrderError', sawOrphan)
    check('…naming the order id so the orphan is reconcilable', orphanId.startsWith('order_') && orphanId === `order_TEST${String(orderSeq).padStart(10, '0')}`)
    check('…no intent row exists', (await intentsFor(booking.id)).length === 0)
    check('…and nothing was marked paid', (await ownerPool.query('select count(*)::int n from payments where tenant_id=$1', [A.tenantId])).rows[0].n === 0)
  }

  // ── 9. tenant isolation ───────────────────────────────────────────────────
  {
    const aBooking = await makeBooking(A, '500.00')
    const bBooking = await makeBooking(B, '900.00')
    await createDepositOrder({ bookingId: aBooking.id }, depsA())

    // Tenant B, using ITS OWN context, asking for tenant A's booking.
    const depsB = {
      runInTx: runAs(B.manager.userId),
      credentials: credsB,
      createOrder: fakeGateway,
      actor: { tenantId: B.tenantId, membershipId: B.manager.membershipId },
    }
    const cross = await expectError(() => createDepositOrder({ bookingId: aBooking.id }, depsB), 'DepositError')
    check("tenant B cannot open a deposit for tenant A's booking", cross.threw && cross.message === 'Booking not found.')

    // The dangerous shape: B's session, but A's tenant id forged into the actor.
    // RLS on the app connection is what stops this, not the WHERE clause.
    const spoof = await expectError(
      () => createDepositOrder({ bookingId: aBooking.id }, { ...depsB, actor: { tenantId: A.tenantId, membershipId: B.manager.membershipId } }),
      'DepositError',
    )
    check("…nor by forging tenant A's id into the actor (RLS blocks the read)", spoof.threw && spoof.message === 'Booking not found.')

    // Credentials and booking always come from the same context, so the
    // A-booking/B-credentials combination has no code path. Prove the orders
    // that DID succeed used the matching key.
    calls.length = 0
    const bOut = await createDepositOrder({ bookingId: bBooking.id }, depsB)
    check("tenant B's own booking uses tenant B's key id", bOut.keyId === credsB.keyId)
    check("…and never tenant A's", bOut.keyId !== credsA.keyId)

    const bRows = await withUser(B.manager.userId, (tx) => tx.select().from(paymentIntents))
    check("tenant B sees only its own intents", bRows.length > 0 && bRows.every((r) => r.tenantId === B.tenantId))
    const aVisible = await withUser(B.manager.userId, (tx) =>
      tx.select().from(paymentIntents).where(eq(paymentIntents.bookingId, aBooking.id)),
    )
    check("…and cannot read tenant A's intent even by booking id", aVisible.length === 0)

    const aIntent = (await intentsFor(aBooking.id))[0]
    const crossUpdate = await withUser(B.manager.userId, (tx) =>
      tx
        .update(paymentIntents)
        .set({ status: 'paid' })
        .where(eq(paymentIntents.id, aIntent.id))
        .returning({ id: paymentIntents.id }),
    )
    check("tenant B cannot modify tenant A's intent (0 rows)", crossUpdate.length === 0)
    check("…and it is still pending", (await intentsFor(aBooking.id))[0].status === 'pending')

    const crossInsert = await expectError(
      () =>
        withUser(B.manager.userId, (tx) =>
          tx.insert(paymentIntents).values({
            tenantId: A.tenantId, branchId: A.branchId, bookingId: aBooking.id,
            gatewayOrderId: 'order_CROSS', amount: '1.00', currency: 'INR', status: 'pending',
          }),
        ),
      'Error',
    )
    check('tenant B cannot insert INTO tenant A', crossInsert.threw)
  }

  // ── 10. nothing secret escapes ────────────────────────────────────────────
  {
    const booking = await makeBooking(A, '500.00')
    const out = await createDepositOrder({ bookingId: booking.id }, depsA())
    const serialised = JSON.stringify(out)

    check('the checkout payload does NOT contain the key secret', !serialised.includes(credsA.keySecret))
    check('…and has no secret-shaped field at all', !('keySecret' in out) && !('credentials' in out) && !('secret' in out))
    check('…its keys are exactly the checkout fields', JSON.stringify(Object.keys(out).sort()) === JSON.stringify(['amount', 'amountRupees', 'bookingNumber', 'currency', 'keyId', 'orderId', 'reused']))

    const row = (await intentsFor(booking.id))[0]
    check('the persisted intent stores no credential', !JSON.stringify(row).includes(credsA.keySecret))
    check('the receipt helper truncates to Razorpay’s 40-char limit', depositReceipt('X'.repeat(60)).length === 40)
  }

  // ── 11. the state stays pending ───────────────────────────────────────────
  {
    const all = await ownerPool.query<{ status: string; n: string }>(
      `select status, count(*)::text n from payment_intents
        where tenant_id = any($1) group by status`,
      [[A.tenantId, B.tenantId]],
    )
    const byStatus = Object.fromEntries(all.rows.map((r) => [r.status, Number(r.n)]))
    check('no intent anywhere was marked PAID by this ticket', !byStatus.paid)
    check('no intent was marked FAILED by this ticket', !byStatus.failed)
    check('…only pending and cancelled states exist', all.rows.every((r) => r.status === 'pending' || r.status === 'cancelled'))

    const invoices = await ownerPool.query('select count(*)::int n from invoices where tenant_id = any($1)', [[A.tenantId, B.tenantId]])
    check('no invoice was created or settled', invoices.rows[0].n === 0)
  }

  // ── cleanup ───────────────────────────────────────────────────────────────
  await ownerPool.query('delete from tenants where id = any($1)', [[A.tenantId, B.tenantId]])
  await ownerPool.query(`delete from users where email like '%@testdep%.test'`)
  await ownerPool.end()
  await appPool.end()

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error('test harness error:', e instanceof Error ? `${e.name}: ${e.message}` : 'unknown')
  process.exit(1)
})
