/**
 * M15 #3 — event registration, capacity, waitlist, teams and paid entry,
 * exercised through the REAL customer RLS path (withCustomer / arena_app), not
 * owner-pool SQL pretending to be the app.
 *
 * Same reasoning as scripts/test-order-pay-now.ts: the interesting failures in
 * this codebase are not exceptions, they are EMPTY RESULT SETS — a query the
 * restricted role is not allowed to see returns zero rows and the code carries
 * on believing nothing was there. A fixture-driven test on the owner connection
 * cannot catch that, because the owner sees everything. So every customer
 * action below runs through the same wrapper the app uses.
 *
 * The section that matters most is §4: N simultaneous registrations against a
 * capacity of 1, fired with Promise.all on separate pooled connections, with
 * the invariant `occupancy <= capacity` asserted afterwards. If the event lock
 * in claim_event_registration() were ever removed, that is the test that fails.
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs scripts/test-event-registrations.ts
 */
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { loadEnv } from './env'

let pass = 0
let fail = 0
const check = (label: string, cond: boolean, detail?: unknown) => {
  console.log(`${cond ? '✓' : '✗ FAIL'}  ${label}`)
  if (cond) pass++
  else {
    fail++
    if (detail !== undefined) console.log('        got:', detail)
  }
}

async function main() {
  loadEnv()

  const { withCustomer } = await import('../db')
  const {
    claimEventRegistration,
    cancelOwnEventRegistration,
    cancelEventRegistrationAsStaff,
    joinEventTeam,
    getMyEventParticipation,
    listPublicEventTeams,
    getPublicEventTakenCounts,
  } = await import('../lib/events/registrations')
  const {
    createEventRegistrationPayment,
    EventRegistrationPaymentError,
  } = await import('../lib/payments/event-registration-payment')
  const { applyVerifiedPaymentWebhook } = await import('../lib/payments/webhook')
  const { sql } = await import('drizzle-orm')

  const owner = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })

  // webhook_events is an append-only DELIVERY log keyed on (gateway, event_id):
  // that is the point of it, so a redelivery is recognised. It therefore
  // survives between runs, so a fixed delivery id would be seen as a duplicate
  // the second time this file is run. A per-run prefix keeps the idempotency
  // assertions honest WITHIN a run without pretending the log can be reset.
  const RUN = randomUUID().slice(0, 8)
  // Gateway order ids are globally unique (idx_payment_intents_gateway_order,
  // deliberately not tenant-scoped), so these carry the run prefix too.
  const ORDER_TAMPERED = `order_${RUN}_tampered`
  const ORDER_CORRECT = `order_${RUN}_correct`
  const ORDER_OTHER = `order_${RUN}_other`
  const ORDER_LATE = `order_${RUN}_late`
  const PAY_FORGED = `pay_${RUN}_forged`

  // ══ fixtures ═══════════════════════════════════════════════════════════════
  // Two tenants, so every isolation claim is tested against a real neighbour
  // rather than asserted.
  async function makeTenant(slug: string, name: string) {
    const t = await owner.query<{ id: string }>(
      `insert into tenants (slug,name,status,timezone) values ($1,$2,'active','Asia/Kolkata')
       on conflict (slug) do update set status='active' returning id`,
      [slug, name],
    )
    const tenantId = t.rows[0].id
    // Clean slate for reruns — registrations cascade from events.
    await owner.query('delete from events where tenant_id=$1', [tenantId])
    await owner.query('delete from customers where tenant_id=$1', [tenantId])
    await owner.query('delete from branches where tenant_id=$1', [tenantId])
    const b = await owner.query<{ id: string }>(
      `insert into branches (tenant_id,name,is_primary,status) values ($1,'Main',true,'active') returning id`,
      [tenantId],
    )
    const u = await owner.query<{ id: string }>(
      `insert into users (email,password_hash) values ($1,'x')
       on conflict (email) do update set email=excluded.email returning id`,
      [`manager@${slug}.test`],
    )
    await owner.query(
      `insert into memberships (tenant_id,user_id,role,status) values ($1,$2,'manager','active')
       on conflict (tenant_id,user_id) do update set role='manager', status='active'`,
      [tenantId, u.rows[0].id],
    )
    const cashier = await owner.query<{ id: string }>(
      `insert into users (email,password_hash) values ($1,'x')
       on conflict (email) do update set email=excluded.email returning id`,
      [`cashier@${slug}.test`],
    )
    await owner.query(
      `insert into memberships (tenant_id,user_id,role,status) values ($1,$2,'cashier','active')
       on conflict (tenant_id,user_id) do update set role='cashier', status='active'`,
      [tenantId, cashier.rows[0].id],
    )
    return { tenantId, branchId: b.rows[0].id, managerId: u.rows[0].id, cashierId: cashier.rows[0].id }
  }

  const A = await makeTenant('testevtreg', 'Event Reg Co')
  const B = await makeTenant('testevtregb', 'Other Venue')

  let phoneSeq = 0
  async function makeCustomer(tenantId: string, name: string) {
    phoneSeq++
    const p = `+9198${String(70000000 + phoneSeq).slice(0, 8)}`
    const r = await owner.query<{ id: string }>(
      `insert into customers (tenant_id,phone,name) values ($1,$2,$3) returning id`,
      [tenantId, p, name],
    )
    return r.rows[0].id
  }

  type EventOpts = {
    capacity?: number | null
    fee?: string
    mode?: 'solo' | 'team'
    teamSize?: number | null
    status?: string
  }
  async function makeEvent(
    t: { tenantId: string; branchId: string },
    title: string,
    o: EventOpts = {},
  ) {
    const r = await owner.query<{ id: string }>(
      `insert into events
         (tenant_id,branch_id,title,type,starts_at,ends_at,capacity,entry_fee,
          registration_mode,team_size,status)
       values ($1,$2,$3,'class', now() + interval '7 days', now() + interval '7 days 3 hours',
               $4,$5,$6::event_registration_mode,$7,$8::event_status)
       returning id`,
      [
        t.tenantId,
        t.branchId,
        title,
        o.capacity === undefined ? null : o.capacity,
        o.fee ?? '0',
        o.mode ?? 'solo',
        o.teamSize ?? null,
        o.status ?? 'registration_open',
      ],
    )
    // `class`, not `tournament`: a tournament would need a bracket format
    // (events_tournament_format, 0078) and this file is not about that rule.
    return r.rows[0].id
  }

  const reg = (id: string) =>
    owner
      .query(
        `select status, paid_amount, payment_reference, payment_hold_expires_at, refund_required,
                team_id, customer_id, created_at
           from event_registrations where id=$1`,
        [id],
      )
      .then((r) => r.rows[0])

  const occupancy = (eventId: string) =>
    owner
      .query<{ n: string }>(
        `select public.event_registration_occupancy($1::uuid)::text as n`,
        [eventId],
      )
      .then((r) => Number(r.rows[0].n))

  const statusesOn = (eventId: string) =>
    owner
      .query<{ status: string }>(`select status from event_registrations where event_id=$1`, [eventId])
      .then((r) => r.rows.map((x) => x.status))

  // ══ 1. FREE EVENT ══════════════════════════════════════════════════════════
  console.log('\n── free event ──')

  const freeEvent = await makeEvent(A, 'Free Friday', { capacity: 2, fee: '0' })
  const c1 = await makeCustomer(A.tenantId, 'Asha')
  const c2 = await makeCustomer(A.tenantId, 'Bimal')
  const c3 = await makeCustomer(A.tenantId, 'Chetan')
  const c4 = await makeCustomer(A.tenantId, 'Divya')

  const r1 = await claimEventRegistration(c1, freeEvent, null)
  check('a free event registers immediately', r1.ok && r1.status === 'registered', r1)
  if (!r1.ok) throw new Error('cannot continue')

  const row1 = await reg(r1.registrationId)
  check('…the correct customer is attached', row1.customer_id === c1)
  check('…paid amount is exactly 0', Number(row1.paid_amount) === 0, row1.paid_amount)
  check('…no payment reference is invented', row1.payment_reference === null)
  check('…no capacity hold is left behind', row1.payment_hold_expires_at === null)

  const intents = await owner.query(
    `select id from payment_intents where event_registration_id=$1`,
    [r1.registrationId],
  )
  check('…and NO Razorpay intent is created for a free entry', intents.rowCount === 0)

  // ══ 2. DUPLICATE ═══════════════════════════════════════════════════════════
  console.log('\n── duplicate registration ──')

  const dup = await claimEventRegistration(c1, freeEvent, null)
  check('the same customer cannot register twice', !dup.ok && dup.refusal === 'already_registered', dup)

  const dupRow = await owner.query(
    `select count(*)::int as n from event_registrations where event_id=$1 and customer_id=$2`,
    [freeEvent, c1],
  )
  check('…and no second row was written', dupRow.rows[0].n === 1)

  // The database refuses it too, not just the function.
  const rawDup = await owner
    .query(
      `insert into event_registrations (tenant_id,event_id,customer_id,status,registered_at)
       values ($1,$2,$3,'registered',now())`,
      [A.tenantId, freeEvent, c1],
    )
    .then(() => false)
    .catch(() => true)
  check('…the partial unique index refuses a duplicate even on the owner connection', rawDup)

  // ══ 3. CAPACITY AND WAITLIST ═══════════════════════════════════════════════
  console.log('\n── capacity and waitlist ──')

  const r2 = await claimEventRegistration(c2, freeEvent, null)
  check('the second of two places is taken', r2.ok && r2.status === 'registered', r2)

  const r3 = await claimEventRegistration(c3, freeEvent, null)
  check('the third entrant is WAITLISTED, not refused', r3.ok && r3.status === 'waitlisted', r3)

  const r4 = await claimEventRegistration(c4, freeEvent, null)
  check('so is the fourth', r4.ok && r4.status === 'waitlisted', r4)

  check('occupancy equals capacity and no more', (await occupancy(freeEvent)) === 2)

  const w3 = await getMyEventParticipation(c3, freeEvent)
  const w4 = await getMyEventParticipation(c4, freeEvent)
  check('the waitlist keeps its order (first waiter is position 1)', w3?.waitlistPosition === 1, w3)
  check('…and the second is position 2', w4?.waitlistPosition === 2, w4)
  check('a waitlisted entrant is charged nothing', w3?.paidAmount === '0.00' || Number(w3?.paidAmount) === 0, w3?.paidAmount)

  // ══ 4. CONCURRENCY — THE POINT OF THIS FILE ════════════════════════════════
  console.log('\n── concurrent registration against capacity = 1 ──')

  const raceEvent = await makeEvent(A, 'One Place Only', { capacity: 1, fee: '0' })
  const racers: string[] = []
  for (let i = 0; i < 10; i++) racers.push(await makeCustomer(A.tenantId, `Racer ${i}`))

  // Fired together on separate pooled connections. Without the `for update` on
  // the event row inside claim_event_registration(), several of these would
  // read occupancy 0 and all insert a confirmed registration.
  const raced = await Promise.all(racers.map((c) => claimEventRegistration(c, raceEvent, null)))

  const confirmed = raced.filter((r) => r.ok && r.status === 'registered').length
  const waited = raced.filter((r) => r.ok && r.status === 'waitlisted').length
  check(`exactly ONE of ${racers.length} simultaneous entrants is confirmed`, confirmed === 1, {
    confirmed,
    waited,
  })
  check('…every other entrant is waitlisted, none lost', waited === racers.length - 1, { waited })
  check('…and occupancy never exceeded capacity', (await occupancy(raceEvent)) === 1)

  const raceRows = await statusesOn(raceEvent)
  check(
    '…the table itself holds exactly one confirmed row',
    raceRows.filter((s) => s === 'registered').length === 1,
    raceRows,
  )

  // Same again on a PAID event, where a confirmed place is held by a
  // pending_payment hold rather than a registration — the state the
  // "both customers pay at once" scenario turns on.
  const racePaid = await makeEvent(A, 'One Paid Place', { capacity: 1, fee: '750.00' })
  const paidRacers: string[] = []
  for (let i = 0; i < 8; i++) paidRacers.push(await makeCustomer(A.tenantId, `PaidRacer ${i}`))
  const pRaced = await Promise.all(paidRacers.map((c) => claimEventRegistration(c, racePaid, null)))
  const holding = pRaced.filter((r) => r.ok && r.status === 'pending_payment').length
  check('exactly ONE simultaneous entrant gets the paid hold', holding === 1, { holding })
  check(
    '…the rest are waitlisted BEFORE any of them sees a payment page',
    pRaced.filter((r) => r.ok && r.status === 'waitlisted').length === paidRacers.length - 1,
  )
  check('…occupancy is 1', (await occupancy(racePaid)) === 1)

  // ══ 5. CANCELLATION AND FIFO PROMOTION ═════════════════════════════════════
  console.log('\n── cancellation frees a place, FIFO promotion fills it ──')

  const cancelled = await cancelOwnEventRegistration(c1, r1.registrationId)
  check('a customer can cancel their own registration', cancelled === 'cancelled', cancelled)

  const after1 = await reg(r1.registrationId)
  check('…the row is kept, status cancelled (never deleted)', after1.status === 'cancelled')
  check('…no refund is flagged for an entry that paid nothing', after1.refund_required === false)

  const p3 = await getMyEventParticipation(c3, freeEvent)
  const p4 = await getMyEventParticipation(c4, freeEvent)
  check('the FIRST waiter is promoted, not the last', p3?.status === 'registered', p3?.status)
  check('…and the second waiter stays waiting', p4?.status === 'waitlisted', p4?.status)
  check('…promotion did not exceed capacity', (await occupancy(freeEvent)) === 2)

  const twice = await cancelOwnEventRegistration(c1, r1.registrationId)
  check('cancelling twice has no second effect', twice === 'already_cancelled', twice)
  check('…and capacity is unchanged by the repeat', (await occupancy(freeEvent)) === 2)

  const notMine = await cancelOwnEventRegistration(c2, r3.ok ? r3.registrationId : '')
  check("a customer cannot cancel someone else's registration", notMine === 'not_found', notMine)
  const stillC3 = await reg(r3.ok ? r3.registrationId : '')
  check('…and that registration is untouched', stillC3.status === 'registered', stillC3.status)

  // ══ 6. STAFF PERMISSIONS ═══════════════════════════════════════════════════
  console.log('\n── staff cancellation ──')

  const staffCancel = await cancelEventRegistrationAsStaff(A.managerId, r2.ok ? r2.registrationId : '')
  check('a manager can cancel an entrant', staffCancel === 'cancelled', staffCancel)
  const p4b = await getMyEventParticipation(c4, freeEvent)
  check('…which promotes the next waiter', p4b?.status === 'registered', p4b?.status)

  const cashierCancel = await cancelEventRegistrationAsStaff(
    A.cashierId,
    r4.ok ? r4.registrationId : '',
  )
  check('a CASHIER cannot cancel an entrant', cashierCancel === 'not_found', cashierCancel)

  const crossStaff = await cancelEventRegistrationAsStaff(B.managerId, r4.ok ? r4.registrationId : '')
  check("another tenant's manager cannot cancel it either", crossStaff === 'not_found', crossStaff)

  // ══ 7. PAID EVENT ══════════════════════════════════════════════════════════
  console.log('\n── paid event: intent creation ──')

  const paidEvent = await makeEvent(A, 'Paid Cup', { capacity: 1, fee: '500.00' })
  const pc1 = await makeCustomer(A.tenantId, 'Payer One')
  const pc2 = await makeCustomer(A.tenantId, 'Payer Two')

  const pr1 = await claimEventRegistration(pc1, paidEvent, null)
  check('a paid entry starts UNCONFIRMED (pending_payment)', pr1.ok && pr1.status === 'pending_payment', pr1)
  if (!pr1.ok) throw new Error('cannot continue')
  check('…the fee comes back from the database, not the browser', pr1.entryFee === '500.00', pr1.entryFee)

  const prRow = await reg(pr1.registrationId)
  check('…paid amount is still 0 before payment', Number(prRow.paid_amount) === 0)
  check('…a capacity hold is set', prRow.payment_hold_expires_at !== null)

  // THE payment/capacity race: the second customer is waitlisted while the
  // first is still at the payment page, so both cannot pay into one place.
  const pr2 = await claimEventRegistration(pc2, paidEvent, null)
  check('a second entrant is waitlisted while the first holds the place', pr2.ok && pr2.status === 'waitlisted', pr2)

  // A fake gateway — a real HTTP call has no place in a test suite. The seam is
  // CreateOrderFn, the same one deposits and order pay-now inject.
  let gatewaySawPaise = -1
  let gatewaySawCurrency = ''
  const fakeCreateOrder = async (
    _creds: { keyId: string; keySecret: string },
    params: { amountPaise: number; currency: string; receipt: string },
  ) => {
    gatewaySawPaise = params.amountPaise
    gatewaySawCurrency = params.currency
    return {
      id: `order_test_${params.receipt.slice(-12)}`,
      amount: params.amountPaise,
      currency: params.currency,
      status: 'created',
      receipt: params.receipt,
    }
  }

  const checkout = await createEventRegistrationPayment(
    { registrationId: pr1.registrationId },
    {
      runInTx: (fn) => withCustomer(pc1, fn),
      credentials: { keyId: 'rzp_test_tenantA', keySecret: 'secretA' },
      createOrder: fakeCreateOrder,
      actor: { tenantId: A.tenantId },
    },
  )
  check('a Razorpay order is opened for the entry fee', checkout.orderId.startsWith('order_test_'))
  check('…priced in paise from the EVENT fee (50000)', gatewaySawPaise === 50000, gatewaySawPaise)
  check('…in INR', gatewaySawCurrency === 'INR')
  check("…using the tenant's own key id", checkout.keyId === 'rzp_test_tenantA')
  check('…and the browser is told the same amount', checkout.amount === 50000 && checkout.amountRupees === 500)

  const intentRow = await owner.query<{ amount: string; status: string; purpose: string; tid: string }>(
    `select amount, status, purpose, tenant_id as tid from payment_intents where event_registration_id=$1`,
    [pr1.registrationId],
  )
  check('one pending intent is stored', intentRow.rowCount === 1)
  check('…for the event fee, in rupees', intentRow.rows[0].amount === '500.00', intentRow.rows[0].amount)
  check('…still pending — creating an order is not taking a payment', intentRow.rows[0].status === 'pending')
  check('…with the reusable purpose, not a new one', intentRow.rows[0].purpose === 'event_registration')

  // A waitlisted entrant owes nothing and must not be able to open a gateway
  // order — being on a waitlist is not an invitation to pay.
  let waitlistPayError = ''
  try {
    await createEventRegistrationPayment(
      { registrationId: pr2.ok ? pr2.registrationId : '' },
      {
        runInTx: (fn) => withCustomer(pc2, fn),
        credentials: { keyId: 'rzp_test_tenantA', keySecret: 'secretA' },
        createOrder: fakeCreateOrder,
        actor: { tenantId: A.tenantId },
      },
    )
  } catch (e) {
    waitlistPayError = e instanceof EventRegistrationPaymentError ? 'refused' : 'other'
  }
  check('a waitlisted entrant cannot open a payment', waitlistPayError === 'refused', waitlistPayError)

  const reused = await createEventRegistrationPayment(
    { registrationId: pr1.registrationId },
    {
      runInTx: (fn) => withCustomer(pc1, fn),
      credentials: { keyId: 'rzp_test_tenantA', keySecret: 'secretA' },
      createOrder: fakeCreateOrder,
      actor: { tenantId: A.tenantId },
    },
  )
  check('a second "Pay" press reuses the same order', reused.reused && reused.orderId === checkout.orderId)
  const intentCount = await owner.query(
    `select count(*)::int as n from payment_intents where event_registration_id=$1`,
    [pr1.registrationId],
  )
  check('…and does not open a second one', intentCount.rows[0].n === 1)

  // ── the frontend cannot choose the price ──────────────────────────────────
  console.log('\n── the browser cannot set the amount ──')

  await owner.query(`update payment_intents set status='cancelled' where event_registration_id=$1`, [
    pr1.registrationId,
  ])

  const tampered = await withCustomer(pc1, (tx) =>
    tx
      .execute(
        sql`insert into payment_intents
              (tenant_id, branch_id, event_registration_id, purpose, gateway, gateway_order_id,
               amount, currency, status)
            values (${A.tenantId}::uuid, ${A.branchId}::uuid, ${pr1.registrationId}::uuid,
                    'event_registration', 'razorpay', ${ORDER_TAMPERED}, '1.00', 'INR', 'pending')`,
      )
      .then(() => 'accepted')
      .catch(() => 'refused'),
  )
  check('an intent for ₹1 on a ₹500 event is REFUSED by the database', tampered === 'refused', tampered)

  const rightPrice = await withCustomer(pc1, (tx) =>
    tx
      .execute(
        sql`insert into payment_intents
              (tenant_id, branch_id, event_registration_id, purpose, gateway, gateway_order_id,
               amount, currency, status)
            values (${A.tenantId}::uuid, ${A.branchId}::uuid, ${pr1.registrationId}::uuid,
                    'event_registration', 'razorpay', ${ORDER_CORRECT}, '500.00', 'INR', 'pending')`,
      )
      .then(() => 'accepted')
      .catch((e) => String(e)),
  )
  check('…while the event\'s own price is accepted', rightPrice === 'accepted', rightPrice)

  const foreignReg = await withCustomer(pc2, (tx) =>
    tx
      .execute(
        sql`insert into payment_intents
              (tenant_id, branch_id, event_registration_id, purpose, gateway, gateway_order_id,
               amount, currency, status)
            values (${A.tenantId}::uuid, ${A.branchId}::uuid, ${pr1.registrationId}::uuid,
                    'event_registration', 'razorpay', ${ORDER_OTHER}, '500.00', 'INR', 'pending')`,
      )
      .then(() => 'accepted')
      .catch(() => 'refused'),
  )
  check("a customer cannot open an order against someone else's registration", foreignReg === 'refused')

  // A customer cannot write the registration itself, at all.
  const selfConfirm = await withCustomer(pc1, (tx) =>
    tx
      .execute(
        sql`update event_registrations set status='registered', paid_amount='500.00',
                   payment_reference=${PAY_FORGED}, payment_hold_expires_at=null
             where id=${pr1.registrationId}::uuid`,
      )
      .then((r) => r.rowCount ?? 0)
      .catch(() => -1),
  )
  check('a customer cannot confirm their own registration by hand', selfConfirm <= 0, selfConfirm)
  check(
    '…it is still pending payment',
    (await reg(pr1.registrationId)).status === 'pending_payment',
  )

  // ══ 8. THE WEBHOOK ═════════════════════════════════════════════════════════
  console.log('\n── verified webhook confirms; nothing else does ──')

  const liveOrder = ORDER_CORRECT
  const payment = (over: Partial<Record<string, unknown>> = {}) => ({
    id: `pay_${RUN}_1`,
    order_id: liveOrder,
    amount: 50000,
    currency: 'INR',
    status: 'captured',
    ...over,
  })

  const wrongAmount = await applyVerifiedPaymentWebhook({
    verifiedTenantId: A.tenantId,
    eventType: 'payment.captured',
    eventId: `evt_${RUN}_wrong_amount`,
    payment: payment({ amount: 100 }) as never,
  })
  check('a payment for the wrong amount is REJECTED', wrongAmount.kind === 'rejected', wrongAmount)
  check(
    '…and the registration is still unconfirmed',
    (await reg(pr1.registrationId)).status === 'pending_payment',
  )

  const notCaptured = await applyVerifiedPaymentWebhook({
    verifiedTenantId: A.tenantId,
    eventType: 'payment.captured',
    eventId: `evt_${RUN}_failed`,
    payment: payment({ id: `pay_${RUN}_failed`, status: 'failed' }) as never,
  })
  check('a FAILED payment does not confirm a registration', notCaptured.kind === 'rejected', notCaptured)

  const wrongTenant = await applyVerifiedPaymentWebhook({
    verifiedTenantId: B.tenantId,
    eventType: 'payment.captured',
    eventId: `evt_${RUN}_wrong_tenant`,
    payment: payment({ id: `pay_${RUN}_wrong_tenant` }) as never,
  })
  check(
    "a webhook signed by ANOTHER tenant cannot settle this order",
    wrongTenant.kind === 'ignored',
    wrongTenant,
  )
  check(
    '…still unconfirmed',
    (await reg(pr1.registrationId)).status === 'pending_payment',
  )

  const good = await applyVerifiedPaymentWebhook({
    verifiedTenantId: A.tenantId,
    eventType: 'payment.captured',
    eventId: `evt_${RUN}_good`,
    payment: payment() as never,
  })
  check(
    'a verified, correctly-priced capture CONFIRMS the registration',
    good.kind === 'processed' && good.purpose === 'event_registration' && good.registrationOutcome === 'confirmed',
    good,
  )

  const confirmedRow = await reg(pr1.registrationId)
  check('…status is registered', confirmedRow.status === 'registered', confirmedRow.status)
  check('…the verified amount is stored', confirmedRow.paid_amount === '500.00', confirmedRow.paid_amount)
  check('…the verified payment reference is stored', confirmedRow.payment_reference === `pay_${RUN}_1`)
  check('…and the hold is released', confirmedRow.payment_hold_expires_at === null)
  check('…capacity is still 1', (await occupancy(paidEvent)) === 1)

  const redelivered = await applyVerifiedPaymentWebhook({
    verifiedTenantId: A.tenantId,
    eventType: 'payment.captured',
    eventId: `evt_${RUN}_good_again`,
    payment: payment() as never,
  })
  check('a redelivered webhook is a no-op', redelivered.kind === 'duplicate', redelivered)
  const afterRedelivery = await owner.query(
    `select count(*)::int as n from event_registrations where event_id=$1 and customer_id=$2`,
    [paidEvent, pc1],
  )
  check('…no duplicate registration is created', afterRedelivery.rows[0].n === 1)
  check('…and the amount is not doubled', (await reg(pr1.registrationId)).paid_amount === '500.00')

  const sameEventId = await applyVerifiedPaymentWebhook({
    verifiedTenantId: A.tenantId,
    eventType: 'payment.captured',
    eventId: `evt_${RUN}_good`,
    payment: payment() as never,
  })
  check('…and the delivery id itself is claimed only once', sameEventId.kind === 'duplicate')

  // ══ 9. PAYMENT LANDS AFTER THE PLACE IS GONE ═══════════════════════════════
  console.log('\n── a payment that can no longer be honoured ──')

  const lateEvent = await makeEvent(A, 'Late Payment Cup', { capacity: 1, fee: '300.00' })
  const lc1 = await makeCustomer(A.tenantId, 'Late One')
  const lc2 = await makeCustomer(A.tenantId, 'Late Two')

  const lr1 = await claimEventRegistration(lc1, lateEvent, null)
  check('the first entrant takes the hold', lr1.ok && lr1.status === 'pending_payment')
  if (!lr1.ok) throw new Error('cannot continue')

  await owner.query(
    `insert into payment_intents (tenant_id,branch_id,event_registration_id,purpose,gateway,
                                  gateway_order_id,amount,currency,status)
     values ($1,$2,$3,'event_registration','razorpay',$4,'300.00','INR','pending')`,
    [A.tenantId, A.branchId, lr1.registrationId, ORDER_LATE],
  )

  // Their checkout is abandoned: the hold lapses and the place is released.
  await owner.query(
    `update event_registrations set payment_hold_expires_at = now() - interval '1 minute' where id=$1`,
    [lr1.registrationId],
  )

  const lr2 = await claimEventRegistration(lc2, lateEvent, null)
  check('the lapsed hold is swept and the place goes to the next entrant', lr2.ok && lr2.status === 'pending_payment', lr2)
  check('…the abandoned entry is cancelled, unpaid', (await reg(lr1.registrationId)).status === 'cancelled')

  const late = await applyVerifiedPaymentWebhook({
    verifiedTenantId: A.tenantId,
    eventType: 'payment.captured',
    eventId: `evt_${RUN}_late`,
    payment: { id: `pay_${RUN}_late`, order_id: ORDER_LATE, amount: 30000, currency: 'INR', status: 'captured' } as never,
  })
  check(
    'their late payment does NOT oversell the event',
    late.kind === 'processed' && late.purpose === 'event_registration' && late.registrationOutcome === 'unfulfillable',
    late,
  )
  check('…capacity is still 1', (await occupancy(lateEvent)) === 1)

  const lateRow = await reg(lr1.registrationId)
  check('…the customer is not silently charged: a refund is flagged', lateRow.refund_required === true)
  check('…the money and its reference are recorded against the entry', lateRow.paid_amount === '300.00' && lateRow.payment_reference === `pay_${RUN}_late`)
  check('…and the entry stays cancelled', lateRow.status === 'cancelled')

  // ══ 10. PAID WAITLIST PROMOTION ════════════════════════════════════════════
  console.log('\n── promotion on a paid event asks for payment, it does not gift a place ──')

  const promoEvent = await makeEvent(A, 'Promotion Cup', { capacity: 1, fee: '400.00' })
  const qa = await makeCustomer(A.tenantId, 'Queue A')
  const qb = await makeCustomer(A.tenantId, 'Queue B')

  const qra = await claimEventRegistration(qa, promoEvent, null)
  const qrb = await claimEventRegistration(qb, promoEvent, null)
  check('the second entrant waits', qrb.ok && qrb.status === 'waitlisted')
  if (!qra.ok || !qrb.ok) throw new Error('cannot continue')

  await cancelOwnEventRegistration(qa, qra.registrationId)
  const promoted = await reg(qrb.registrationId)
  check(
    'the promoted entrant is asked to PAY, not marked paid',
    promoted.status === 'pending_payment',
    promoted.status,
  )
  check('…with nothing recorded as paid', Number(promoted.paid_amount) === 0)
  check('…no payment reference is invented', promoted.payment_reference === null)
  check('…and a hold reserves the place for them', promoted.payment_hold_expires_at !== null)
  check('…capacity is still respected', (await occupancy(promoEvent)) === 1)

  // ══ 11. TEAMS ══════════════════════════════════════════════════════════════
  console.log('\n── team events ──')

  const teamEvent = await makeEvent(A, 'Five-a-side', {
    capacity: 2,
    fee: '0',
    mode: 'team',
    teamSize: 3,
  })
  const t1 = await makeCustomer(A.tenantId, 'Captain One')
  const t2 = await makeCustomer(A.tenantId, 'Player Two')
  const t3 = await makeCustomer(A.tenantId, 'Player Three')
  const t4 = await makeCustomer(A.tenantId, 'Player Four')
  const t5 = await makeCustomer(A.tenantId, 'Captain Five')
  const t6 = await makeCustomer(A.tenantId, 'Captain Six')

  const noName = await claimEventRegistration(t1, teamEvent, null)
  check('a team event refuses an entry with no team name', !noName.ok && noName.refusal === 'team_name_required', noName)

  const team1 = await claimEventRegistration(t1, teamEvent, 'Thunderbolts')
  check('a captain can enter a team', team1.ok && team1.status === 'registered', team1)
  if (!team1.ok) throw new Error('cannot continue')
  check('…and the team exists', team1.teamId !== null)

  const captainRow = await owner.query<{ n: number }>(
    `select count(*)::int as n from event_team_members where team_id=$1 and customer_id=$2 and is_captain`,
    [team1.teamId, t1],
  )
  check('…with the captain as its first member', captainRow.rows[0].n === 1)

  check('a team-mate can join', (await joinEventTeam(t2, team1.teamId!)) === 'joined')
  check('…but not twice', (await joinEventTeam(t2, team1.teamId!)) === 'already_in_team')

  const dupMember = await owner
    .query(
      `insert into event_team_members (tenant_id,event_id,team_id,customer_id)
       values ($1,$2,$3,$4)`,
      [A.tenantId, teamEvent, team1.teamId, t2],
    )
    .then(() => false)
    .catch(() => true)
  check('…and the unique index refuses a duplicate member outright', dupMember)

  check('a third player fills the team', (await joinEventTeam(t3, team1.teamId!)) === 'joined')
  check('a fourth is refused — team_size is 3', (await joinEventTeam(t4, team1.teamId!)) === 'team_full')

  const nameClash = await claimEventRegistration(t4, teamEvent, '  thunderbolts ')
  check(
    'a second team cannot reuse the name (case- and space-insensitively)',
    !nameClash.ok && nameClash.refusal === 'team_name_taken',
    nameClash,
  )

  const team2 = await claimEventRegistration(t5, teamEvent, 'Rangers')
  check('a second team takes the second place', team2.ok && team2.status === 'registered', team2)

  const team3 = await claimEventRegistration(t6, teamEvent, 'Wanderers')
  check('a third team is waitlisted — capacity counts TEAMS', team3.ok && team3.status === 'waitlisted', team3)
  check('…occupancy is 2 teams, not 6 players', (await occupancy(teamEvent)) === 2)

  const playerCantCaptain = await claimEventRegistration(t2, teamEvent, 'Breakaway')
  check(
    'a player already in a team cannot also enter their own',
    !playerCantCaptain.ok && playerCantCaptain.refusal === 'already_in_team',
    playerCantCaptain,
  )

  const soloOnTeamEvent = await claimEventRegistration(t4, freeEvent, 'Should Not Work')
  check(
    'a team name on a SOLO event is refused, not ignored',
    !soloOnTeamEvent.ok && soloOnTeamEvent.refusal === 'not_a_team_event',
    soloOnTeamEvent,
  )

  const teamsList = await listPublicEventTeams(A.tenantId, teamEvent)
  check('the public team list shows the entered teams', teamsList.length === 3, teamsList.length)
  check(
    '…with headcounts and no customer ids',
    teamsList.every((t) => typeof t.memberCount === 'number' && !('customerId' in t)),
  )

  // Cross-event / cross-tenant team references.
  const otherEvent = await makeEvent(A, 'Different Event', { capacity: 4, fee: '0' })
  const crossEventMember = await owner
    .query(
      `insert into event_team_members (tenant_id,event_id,team_id,customer_id)
       values ($1,$2,$3,$4)`,
      [A.tenantId, otherEvent, team1.teamId, t4],
    )
    .then(() => false)
    .catch(() => true)
  check('a member row cannot point a team at a different event', crossEventMember)

  const bCustomer = await makeCustomer(B.tenantId, 'Neighbour')
  const crossTenantJoin = await joinEventTeam(bCustomer, team1.teamId!)
  check("another tenant's customer cannot join this team", crossTenantJoin === 'not_found', crossTenantJoin)

  const crossTenantTeam = await owner
    .query(
      `insert into event_teams (tenant_id,event_id,name,captain_customer_id)
       values ($1,$2,'Invaders',$3)`,
      [B.tenantId, teamEvent, bCustomer],
    )
    .then(() => false)
    .catch(() => true)
  check("a team cannot be entered into another tenant's event", crossTenantTeam)

  const crossTenantCaptain = await owner
    .query(
      `insert into event_teams (tenant_id,event_id,name,captain_customer_id)
       values ($1,$2,'Ringer',$3)`,
      [A.tenantId, teamEvent, bCustomer],
    )
    .then(() => false)
    .catch(() => true)
  check("a team cannot be captained by another tenant's customer", crossTenantCaptain)

  // Cancelling a team entry withdraws the team.
  await cancelOwnEventRegistration(t1, team1.registrationId)
  const teamStatus = await owner.query<{ status: string }>(
    `select status from event_teams where id=$1`,
    [team1.teamId],
  )
  check('cancelling a team entry withdraws the team', teamStatus.rows[0].status === 'withdrawn')
  const joinWithdrawn = await joinEventTeam(t4, team1.teamId!)
  check('…and nobody can join it afterwards', joinWithdrawn === 'team_withdrawn', joinWithdrawn)
  const promotedTeam = await reg(team3.ok ? team3.registrationId : '')
  check('…the waitlisted team is promoted into the freed place', promotedTeam.status === 'registered')

  // ══ 12. CROSS-TENANT REGISTRATION ══════════════════════════════════════════
  console.log('\n── cross-tenant isolation ──')

  const crossClaim = await claimEventRegistration(bCustomer, freeEvent, null)
  check("a customer cannot register for another tenant's event", !crossClaim.ok && crossClaim.refusal === 'not_found', crossClaim)

  const crossRead = await withCustomer(bCustomer, (tx) =>
    tx
      .execute(sql`select id from event_registrations`)
      .then((r) => r.rows.length)
      .catch(() => -1),
  )
  check("…and sees none of tenant A's registrations", crossRead === 0, crossRead)

  const ownRead = await withCustomer(c3, (tx) =>
    tx.execute(sql`select id, customer_id from event_registrations`).then((r) => r.rows),
  )
  check(
    'a customer sees ONLY their own registrations',
    ownRead.length > 0 && ownRead.every((r) => r.customer_id === c3),
    ownRead.map((r) => r.customer_id),
  )

  const crossRegInsert = await owner
    .query(
      `insert into event_registrations (tenant_id,event_id,customer_id,status,registered_at)
       values ($1,$2,$3,'registered',now())`,
      [B.tenantId, freeEvent, bCustomer],
    )
    .then(() => false)
    .catch(() => true)
  check("a registration cannot name another tenant's event, even from the owner connection", crossRegInsert)

  const crossCustomerReg = await owner
    .query(
      `insert into event_registrations (tenant_id,event_id,customer_id,status,registered_at)
       values ($1,$2,$3,'registered',now())`,
      [A.tenantId, freeEvent, bCustomer],
    )
    .then(() => false)
    .catch(() => true)
  check("…nor another tenant's customer", crossCustomerReg)

  // ══ 13. PUBLIC COUNTS ══════════════════════════════════════════════════════
  console.log('\n── what a stranger can see ──')

  const counts = await getPublicEventTakenCounts(A.tenantId)
  check('the public places-taken count is available', counts.get(paidEvent) === 1, counts.get(paidEvent))
  check('…and counts teams for a team event', counts.get(teamEvent) === 2, counts.get(teamEvent))

  const { withPublicTenant } = await import('../db')
  const strangerRows = await withPublicTenant(A.tenantId, (tx) =>
    tx
      .execute(sql`select id from event_registrations`)
      .then((r) => r.rows.length)
      .catch(() => -1),
  )
  check('an anonymous visitor gets NO registration rows at all', strangerRows === 0, strangerRows)

  const strangerRefs = await withPublicTenant(A.tenantId, (tx) =>
    tx
      .execute(sql`select payment_reference from event_registrations where payment_reference is not null`)
      .then((r) => r.rows.length)
      .catch(() => -1),
  )
  check('…and no payment references', strangerRefs === 0, strangerRefs)

  // ══ 14. THE INVARIANT ══════════════════════════════════════════════════════
  console.log('\n── the invariant, over every event this run created ──')

  const breaches = await owner.query<{ id: string; capacity: number; taken: number }>(
    `select e.id, e.capacity, public.event_registration_occupancy(e.id) as taken
       from events e
      where e.tenant_id = $1 and e.capacity is not null
        and public.event_registration_occupancy(e.id) > e.capacity`,
    [A.tenantId],
  )
  check('confirmed registrations never exceed capacity, on any event', breaches.rowCount === 0, breaches.rows)

  await owner.end()

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
