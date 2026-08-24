/**
 * AROS-60 — customer memberships: purchase, activate, expiry.
 *
 * The invariant under test:
 *
 *     eligible  ⇔  status = 'active'  AND  now < expires_at  AND  same tenant
 *
 * and the snapshot rule: repricing a plan must NEVER change what an existing
 * member already bought.
 *
 *   npx tsx scripts/test-customer-memberships.ts
 */
import { Pool } from 'pg'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { and, eq, sql } from 'drizzle-orm'
import * as schema from '../db/schema'
import { customerMemberships } from '../db/schema'
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
    purchaseMembership,
    cancelMembership,
    getActiveMembership,
    getMembershipBenefits,
    listCustomerMemberships,
    consumeFreeHours,
    expireLapsed,
    isEligible,
    benefitsOf,
    addMonths,
    MembershipError,
  } = await import('../lib/memberships/customer-memberships')
  const { walletBalance } = await import('../lib/customers/ledger')
  const { canBill } = await import('../lib/auth/roles')

  const ownerPool = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })
  const appPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 })
  const app = drizzle(appPool, { schema })

  const withUser = <T,>(userId: string, fn: (tx: Db) => Promise<T>): Promise<T> =>
    app.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`)
      return fn(tx as unknown as Db)
    })

  function pgCode(e: unknown): string | undefined {
    let cur: unknown = e
    for (let d = 0; d < 5 && cur && typeof cur === 'object'; d++) {
      const o = cur as { code?: unknown; cause?: unknown }
      if (typeof o.code === 'string') return o.code
      cur = o.cause
    }
  }
  const expectError = async (fn: () => Promise<unknown>) => {
    try {
      await fn()
      return { threw: false, message: '', isMembershipError: false }
    } catch (e) {
      return {
        threw: true,
        message: e instanceof Error ? e.message : '',
        isMembershipError: e instanceof MembershipError,
      }
    }
  }

  // ── fixtures ──────────────────────────────────────────────────────────────
  let seq = 0
  async function makeTenant(slug: string) {
    const t = await ownerPool.query<{ id: string }>(
      `insert into tenants (slug,name,status,timezone) values ($1,$2,'active','Asia/Kolkata')
       on conflict (slug) do update set status='active' returning id`,
      [slug, `${slug} co`],
    )
    const tenantId = t.rows[0].id
    const br = await ownerPool.query<{ id: string }>(
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
         on conflict (tenant_id,user_id) do update set role=excluded.role returning id`,
        [tenantId, u.rows[0].id, role],
      )
      return { userId: u.rows[0].id, membershipId: m.rows[0].id }
    }
    return {
      tenantId,
      branchId: br.rows[0].id,
      manager: await mkUser('manager'),
      cashier: await mkUser('cashier'),
      kitchen: await mkUser('kitchen_staff'),
    }
  }

  async function makeCustomer(tenantId: string) {
    seq++
    const r = await ownerPool.query<{ id: string }>(
      `insert into customers (tenant_id,phone,name) values ($1,$2,$3) returning id`,
      // customers.phone is CHECKed as E.164: '+' then 8–15 digits.
      [tenantId, `+9190${String(seq).padStart(8, '0')}`, `Guest ${seq}`],
    )
    return r.rows[0].id
  }

  async function makePlan(
    tenantId: string,
    o: Partial<{
      name: string
      price: string
      months: number
      discount: string
      freeHours: string
      wallet: string
      active: boolean
    }> = {},
  ) {
    seq++
    const r = await ownerPool.query<{ id: string }>(
      `insert into membership_plans (tenant_id,name,price,duration_months,discount_percent,
                                     free_hours,wallet_credit,is_active)
       values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
      [
        tenantId,
        o.name ?? `Plan ${seq}`,
        o.price ?? '2000.00',
        o.months ?? 1,
        o.discount ?? '10.00',
        o.freeHours ?? '2.00',
        o.wallet ?? '500.00',
        o.active ?? true,
      ],
    )
    return r.rows[0].id
  }

  const rowOf = async (id: string) =>
    (await ownerPool.query('select * from customer_memberships where id=$1', [id])).rows[0]

  // Start clean: a run that aborted mid-way leaves rows behind, and makeTenant
  // reuses the slug, so fixture ids would collide on the second attempt.
  await ownerPool.query(`delete from tenants where slug in ('testcma','testcmb')`)
  await ownerPool.query(`delete from users where email like '%@testcm%.test'`)

  const A = await makeTenant('testcma')
  const B = await makeTenant('testcmb')
  const actorA = {
    tenantId: A.tenantId,
    membershipId: A.cashier.membershipId,
    timezone: 'Asia/Kolkata',
    branchId: A.branchId,
  }
  const sellA = (
    customerId: string,
    planId: string,
    now?: Date,
    method: 'cash' | 'card' | 'upi' | undefined = 'cash',
  ) =>
    withUser(A.cashier.userId, (tx) =>
      purchaseMembership(tx, actorA, { customerId, planId, paymentMethod: method }, now),
    )

  // ── 1. the date helper, in isolation ──────────────────────────────────────
  {
    const jan31 = new Date(Date.UTC(2026, 0, 31, 10, 0, 0))
    check('31 Jan + 1 month clamps to 28 Feb (no rollover into March)', addMonths(jan31, 1).toISOString().slice(0, 10) === '2026-02-28')
    const jan31Leap = new Date(Date.UTC(2028, 0, 31, 10, 0, 0))
    check('…and to 29 Feb in a leap year', addMonths(jan31Leap, 1).toISOString().slice(0, 10) === '2028-02-29')
    const mar15 = new Date(Date.UTC(2026, 2, 15, 10, 0, 0))
    check('15 Mar + 1 month is 15 Apr', addMonths(mar15, 1).toISOString().slice(0, 10) === '2026-04-15')
    check('…+ 12 months crosses the year', addMonths(mar15, 12).toISOString().slice(0, 10) === '2027-03-15')
    check('…and the time of day is preserved', addMonths(mar15, 1).getUTCHours() === 10)
  }

  // ── 2. the invariant, as a pure function ──────────────────────────────────
  {
    const future = new Date(Date.now() + 86_400_000)
    const past = new Date(Date.now() - 86_400_000)
    check('active + not expired = ELIGIBLE', isEligible({ status: 'active', expiresAt: future }))
    check('active + PAST expiry = not eligible (the clock is checked too)', !isEligible({ status: 'active', expiresAt: past }))
    check('expired + future expiry = not eligible', !isEligible({ status: 'expired', expiresAt: future }))
    check('cancelled + future expiry = not eligible', !isEligible({ status: 'cancelled', expiresAt: future }))
    // Exactly at the boundary: expiry is exclusive.
    const at = new Date()
    check('at the exact expiry instant it is NOT eligible', !isEligible({ status: 'active', expiresAt: at }, at))
  }

  // ── 3. purchase ───────────────────────────────────────────────────────────
  {
    const customerId = await makeCustomer(A.tenantId)
    const planId = await makePlan(A.tenantId, { name: 'Gold', price: '2000.00', months: 1 })
    const now = new Date()
    const result = await sellA(customerId, planId, now)

    check('a cashier can sell a membership', typeof result.membershipId === 'string')
    check('…charged the PLAN price, ₹2000', result.pricePaid === 2000)
    check('…expiring one month out', result.expiresAt.getTime() === addMonths(now, 1).getTime())
    check('…and ₹500 wallet credit was granted', result.walletCredited === 500)

    const row = await rowOf(result.membershipId)
    check('the membership row is active', row.status === 'active')
    check('…with the plan name snapshotted', row.plan_name === 'Gold')
    check('…price, discount, free hours and wallet credit all snapshotted', row.price_paid === '2000.00' && row.discount_percent === '10.00' && row.free_hours === '2.00' && row.wallet_credit === '500.00')
    check('…free hours start unconsumed', row.free_hours_used === '0.00')
    check('…tenant, customer and plan come from the server', row.tenant_id === A.tenantId && row.customer_id === customerId && row.plan_id === planId)
    check('…sold_by records the acting membership', row.sold_by === A.cashier.membershipId)
    check('…and the sale is linked to the GST invoice it raised', row.invoice_id !== null && row.invoice_id === result.invoiceId)

    const bal = await withUser(A.cashier.userId, (tx) => walletBalance(tx, A.tenantId, customerId))
    check('the wallet ledger shows the ₹500 credit', bal === 500)
    const led = await ownerPool.query(
      `select * from wallet_transactions where customer_id=$1`, [customerId])
    check('…as ONE append-only entry sourced to the membership', led.rows.length === 1 && led.rows[0].source_type === 'membership' && led.rows[0].source_id === result.membershipId)

    const cust = (await ownerPool.query('select membership_status from customers where id=$1', [customerId])).rows[0]
    check('the profile badge is set to the plan name', cust.membership_status === 'Gold')

    const live = await withUser(A.cashier.userId, (tx) => getActiveMembership(tx, A.tenantId, customerId))
    check('getActiveMembership finds it', live?.id === result.membershipId)
    const withBenefits = await withUser(A.cashier.userId, (tx) => getMembershipBenefits(tx, A.tenantId, customerId))
    check('getMembershipBenefits returns 10% / 2h / ₹500', withBenefits?.benefits.discountPercent === 10 && withBenefits?.benefits.freeHours === 2 && withBenefits?.benefits.walletCredit === 500)
    check('…with 2 free hours remaining', withBenefits?.benefits.freeHoursRemaining === 2)
  }

  // ══ 3b. THE MONEY: billed and settled through the M1 path ════════════════
  {
    console.log('\n── a membership sale raises a GST invoice and takes a tender ──')
    const customerId = await makeCustomer(A.tenantId)
    const planId = await makePlan(A.tenantId, { name: 'Billed', price: '2000.00' })
    const sold = await sellA(customerId, planId, undefined, 'card')

    check('the sale returns an invoice number', typeof sold.invoiceNumber === 'string' && sold.invoiceNumber!.length > 0)
    check('…and a payment id', typeof sold.paymentId === 'string')
    check('…the membership is linked to its invoice', (await rowOf(sold.membershipId)).invoice_id === sold.invoiceId)

    const inv = (await ownerPool.query('select * from invoices where id=$1', [sold.invoiceId])).rows[0]
    check('the invoice totals ₹2000', inv.total === '2000.00')
    check('…is marked PAID once the tender lands', inv.status === 'paid')
    check('…carries no booking (a membership stands alone)', inv.booking_id === null)
    check('…is attributed to the customer', inv.customer_id === customerId)
    check('…and is numbered in the tenant GST sequence', inv.invoice_number === sold.invoiceNumber && /\/\d{4}\/\d{6}$/.test(inv.invoice_number))

    const items = (await ownerPool.query('select * from invoice_items where invoice_id=$1', [sold.invoiceId])).rows
    check('one invoice line, of kind "membership"', items.length === 1 && items[0].kind === 'membership')
    check('…priced at ₹2000 × 1', items[0].unit_price === '2000.00' && items[0].qty === '1.00' && items[0].line_total === '2000.00')
    check('…sourced to the membership row', items[0].source_id === sold.membershipId)
    check('…at 0% tax (plans carry no tax rate yet — no rate is invented)', items[0].tax_rate === '0.00')

    const pay = (await ownerPool.query('select * from payments where invoice_id=$1', [sold.invoiceId])).rows
    check('exactly ONE tender was recorded', pay.length === 1)
    check('…by the chosen method, captured, for ₹2000', pay[0].method === 'card' && pay[0].status === 'captured' && pay[0].amount === '2000.00')
    check('…attributed to the selling member', pay[0].collected_by === A.cashier.membershipId)

    // The M1 balance calculator must agree — no second calculation exists.
    const { getInvoiceSettlement } = await import('../lib/billing/payments')
    const settlement = await withUser(A.cashier.userId, (tx) =>
      getInvoiceSettlement(tx, A.tenantId, sold.invoiceId!))
    check('getInvoiceSettlement reports total ₹2000, paid ₹2000, balance ₹0', settlement!.total === 2000 && settlement!.paid === 2000 && settlement!.balance === 0)
    check('…and the invoice is no longer payable', settlement!.payable === false)

    // A priced membership cannot be sold without saying how it was paid.
    // Called directly, not through sellA: a default parameter would swallow an
    // explicit `undefined` and quietly substitute 'cash'.
    const unpaidCustomer = await makeCustomer(A.tenantId)
    const noMethod = await expectError(() =>
      withUser(A.cashier.userId, (tx) =>
        purchaseMembership(tx, actorA, { customerId: unpaidCustomer, planId })))
    check('selling a PRICED membership with no tender is REFUSED', noMethod.threw && noMethod.isMembershipError)

    // Atomicity: a failed sale leaves no invoice and no payment behind.
    const before = Number((await ownerPool.query('select count(*)::int n from invoices where tenant_id=$1', [A.tenantId])).rows[0].n)
    await expectError(() => sellA(customerId, planId)) // already holds one
    const after = Number((await ownerPool.query('select count(*)::int n from invoices where tenant_id=$1', [A.tenantId])).rows[0].n)
    check('a refused sale writes NO invoice (the transaction rolls back)', before === after)
  }

  // ══ 3c. K — the client cannot dictate commercial values ══════════════════
  {
    const customerId = await makeCustomer(A.tenantId)
    const planId = await makePlan(A.tenantId, {
      name: 'Tamper', price: '2000.00', months: 3, discount: '10.00', freeHours: '2.00', wallet: '500.00',
    })

    // A hostile client sends every commercial field it can think of. The input
    // schema has no such fields, so Zod strips them and nothing downstream ever
    // looks at them — the values below exist only to prove they are ignored.
    const forged = {
      customerId,
      planId,
      paymentMethod: 'cash' as const,
      price: 1,
      pricePaid: '1.00',
      amount: 1,
      discountPercent: '99.00',
      freeHours: '99.00',
      walletCredit: '9999.00',
      durationMonths: 99,
      expiresAt: new Date(Date.now() + 10 * 365 * 86_400_000).toISOString(),
      status: 'active',
      tenantId: B.tenantId,
    }
    const sold = await withUser(A.cashier.userId, (tx) =>
      purchaseMembership(tx, actorA, forged as unknown as { customerId: string; planId: string }))

    const row = await rowOf(sold.membershipId)
    check('a forged price of ₹1 is ignored — charged the plan’s ₹2000', row.price_paid === '2000.00')
    check('…forged benefits are ignored — 10% / 2h / ₹500 from the plan', row.discount_percent === '10.00' && row.free_hours === '2.00' && row.wallet_credit === '500.00')
    check('…a forged 99-month duration is ignored — 3 months from the plan', row.duration_months === 3)
    check('…a forged expiry is ignored — computed from the plan duration', new Date(row.expires_at).getTime() === addMonths(new Date(row.starts_at), 3).getTime())
    check('…a forged tenantId is ignored — the row belongs to the session tenant', row.tenant_id === A.tenantId)
    check('…and the INVOICE was raised for ₹2000, not ₹1', (await ownerPool.query('select total from invoices where id=$1', [sold.invoiceId])).rows[0].total === '2000.00')
    check('…as was the tender', (await ownerPool.query('select amount from payments where invoice_id=$1', [sold.invoiceId])).rows[0].amount === '2000.00')
    check('…and the wallet credit granted is the plan’s ₹500, not ₹9999', (await withUser(A.cashier.userId, (tx) => walletBalance(tx, A.tenantId, customerId))) === 500)
  }

  // ══ 3d. L — a failed payment leaves NO active paid membership ════════════
  {
    const customerId = await makeCustomer(A.tenantId)
    const planId = await makePlan(A.tenantId, { name: 'Fails', price: '2000.00' })

    const invoicesBefore = Number((await ownerPool.query('select count(*)::int n from invoices where tenant_id=$1', [A.tenantId])).rows[0].n)
    const paymentsBefore = Number((await ownerPool.query('select count(*)::int n from payments where tenant_id=$1', [A.tenantId])).rows[0].n)
    const walletBefore = await withUser(A.cashier.userId, (tx) => walletBalance(tx, A.tenantId, customerId))

    // Force the tender to fail at the LAST step, after the membership row, the
    // invoice and its line have all been written. 'online' is rejected outright
    // by recordPaymentForInvoice (POS tenders only), which is a real failure of
    // the real payment path rather than a stubbed one.
    const failed = await expectError(() =>
      withUser(A.cashier.userId, (tx) =>
        purchaseMembership(tx, actorA, {
          customerId,
          planId,
          paymentMethod: 'online' as unknown as 'cash',
        })))
    check('a payment failure aborts the purchase', failed.threw)

    check('…NO membership row survives', Number((await ownerPool.query('select count(*)::int n from customer_memberships where customer_id=$1', [customerId])).rows[0].n) === 0)
    check('…the customer has no active membership', (await withUser(A.cashier.userId, (tx) => getActiveMembership(tx, A.tenantId, customerId))) === null)
    check('…and no benefits', (await withUser(A.cashier.userId, (tx) => getMembershipBenefits(tx, A.tenantId, customerId))) === null)
    check('…NO invoice was left behind', Number((await ownerPool.query('select count(*)::int n from invoices where tenant_id=$1', [A.tenantId])).rows[0].n) === invoicesBefore)
    check('…NO payment row was left behind', Number((await ownerPool.query('select count(*)::int n from payments where tenant_id=$1', [A.tenantId])).rows[0].n) === paymentsBefore)
    check('…NO wallet credit was granted', (await withUser(A.cashier.userId, (tx) => walletBalance(tx, A.tenantId, customerId))) === walletBefore)
    check('…and the profile badge was not set', (await ownerPool.query('select membership_status from customers where id=$1', [customerId])).rows[0].membership_status === null)

    // The customer can still buy properly afterwards.
    const retry = await sellA(customerId, planId)
    check('…and a subsequent, valid purchase succeeds', typeof retry.membershipId === 'string' && retry.paymentId !== null)
  }

  // ══ 4. THE SNAPSHOT RULE ══════════════════════════════════════════════════
  {
    console.log('\n── repricing a plan must not touch an existing membership ──')
    const customerId = await makeCustomer(A.tenantId)
    const planId = await makePlan(A.tenantId, {
      name: 'Snapshot Gold', price: '2000.00', months: 1, discount: '10.00', freeHours: '2.00', wallet: '500.00',
    })
    const sold = await sellA(customerId, planId)
    const before = await rowOf(sold.membershipId)

    // The manager reprices EVERYTHING about the plan.
    await ownerPool.query(
      `update membership_plans set price='9999.00', discount_percent='99.00',
              free_hours='99.00', wallet_credit='9999.00', duration_months=99, name='Renamed'
       where id=$1`, [planId])

    const after = await rowOf(sold.membershipId)
    check('the membership price is UNCHANGED at ₹2000', after.price_paid === '2000.00')
    check('…the discount is UNCHANGED at 10%', after.discount_percent === '10.00')
    check('…the free hours are UNCHANGED at 2', after.free_hours === '2.00')
    check('…the wallet credit is UNCHANGED at ₹500', after.wallet_credit === '500.00')
    check('…the duration is UNCHANGED at 1 month', after.duration_months === 1)
    check('…the plan NAME is unchanged (snapshotted, not joined)', after.plan_name === 'Snapshot Gold')
    check('…and the expiry did not move', after.expires_at.getTime() === before.expires_at.getTime())

    const benefits = await withUser(A.cashier.userId, (tx) => getMembershipBenefits(tx, A.tenantId, customerId))
    check('benefits read back are STILL the purchased ones, not the plan’s', benefits?.benefits.discountPercent === 10 && benefits?.benefits.freeHours === 2 && benefits?.benefits.walletCredit === 500)

    // Deactivating the plan must not revoke a sold membership either.
    await ownerPool.query(`update membership_plans set is_active=false where id=$1`, [planId])
    const stillLive = await withUser(A.cashier.userId, (tx) => getActiveMembership(tx, A.tenantId, customerId))
    check('retiring the plan does NOT revoke an existing membership', stillLive !== null)
    const otherCustomer = await makeCustomer(A.tenantId)
    const retiredSale = await expectError(() => sellA(otherCustomer, planId))
    check('…but the plan can no longer be sold', retiredSale.message.includes('no longer on sale'))

    // And the plan cannot be deleted out from under it.
    let fkHeld = false
    try {
      await ownerPool.query('delete from membership_plans where id=$1', [planId])
    } catch (e) {
      fkHeld = pgCode(e) === '23503'
    }
    check('…nor deleted while a membership references it (FK restrict)', fkHeld)
  }

  // ── 5. one active membership per customer ─────────────────────────────────
  {
    const customerId = await makeCustomer(A.tenantId)
    const plan1 = await makePlan(A.tenantId, { name: 'Dup A' })
    const plan2 = await makePlan(A.tenantId, { name: 'Dup B' })
    await sellA(customerId, plan1)

    const second = await expectError(() => sellA(customerId, plan2))
    check('a customer cannot hold TWO active memberships', second.threw && second.isMembershipError)
    check('…and the message says when the current one runs out', second.message.includes('already holds an active'))

    // The DB index is the real guarantee.
    let indexHeld = false
    try {
      await ownerPool.query(
        `insert into customer_memberships (tenant_id,customer_id,plan_id,plan_name,price_paid,
                                           duration_months,expires_at,status)
         values ($1,$2,$3,'Sneak','1.00',1,now() + interval '1 month','active')`,
        [A.tenantId, customerId, plan2],
      )
    } catch (e) {
      indexHeld = pgCode(e) === '23505'
    }
    check('a second active row is refused by the partial unique index', indexHeld)

    // Concurrency: two tills at once.
    const raceCustomer = await makeCustomer(A.tenantId)
    const results = await Promise.allSettled([
      sellA(raceCustomer, plan1),
      sellA(raceCustomer, plan2),
    ])
    const ok = results.filter((r) => r.status === 'fulfilled').length
    check('two simultaneous sales → exactly ONE succeeds', ok === 1)
    const rows = await ownerPool.query(
      `select count(*)::int n from customer_memberships where customer_id=$1 and status='active'`,
      [raceCustomer])
    check('…and the customer holds exactly one active membership', rows.rows[0].n === 1)
  }

  // ── 6. expiry ─────────────────────────────────────────────────────────────
  {
    const customerId = await makeCustomer(A.tenantId)
    const planId = await makePlan(A.tenantId, { name: 'Expiring' })
    const sold = await sellA(customerId, planId)

    // Backdate so it has lapsed. status stays 'active' — nothing swept it.
    await ownerPool.query(
      `update customer_memberships set starts_at = now() - interval '2 months',
              expires_at = now() - interval '1 day' where id=$1`, [sold.membershipId])
    check('the row is still marked active in the database', (await rowOf(sold.membershipId)).status === 'active')

    const live = await withUser(A.cashier.userId, (tx) => getActiveMembership(tx, A.tenantId, customerId))
    check('…but getActiveMembership returns NOTHING — the clock is checked', live === null)
    const benefits = await withUser(A.cashier.userId, (tx) => getMembershipBenefits(tx, A.tenantId, customerId))
    check('…and no benefits are handed out', benefits === null)

    // Renewal works: the lapsed row is swept, the new one is inserted.
    const renewed = await sellA(customerId, planId)
    check('a lapsed membership does not block renewal', typeof renewed.membershipId === 'string')
    check('…the old one is now marked expired', (await rowOf(sold.membershipId)).status === 'expired')
    check('…and the new one is active', (await rowOf(renewed.membershipId)).status === 'active')
    check('…the customer has two rows of history', (await withUser(A.cashier.userId, (tx) => listCustomerMemberships(tx, A.tenantId, customerId))).length === 2)

    // The sweep is idempotent and safe to run at any time.
    const swept = await withUser(A.cashier.userId, (tx) => expireLapsed(tx, A.tenantId))
    check('a second sweep expires nothing new', swept === 0)
  }

  // ── 7. cancellation ───────────────────────────────────────────────────────
  {
    const customerId = await makeCustomer(A.tenantId)
    const planId = await makePlan(A.tenantId, { name: 'Cancel Me', wallet: '300.00' })
    const sold = await sellA(customerId, planId)

    await withUser(A.cashier.userId, (tx) => cancelMembership(tx, A.tenantId, sold.membershipId))
    const row = await rowOf(sold.membershipId)
    check('cancelling sets status=cancelled', row.status === 'cancelled')
    check('…stamps cancelled_at', row.cancelled_at !== null)
    check('…and does NOT delete the row (it is financial history)', row.price_paid !== null)

    const live = await withUser(A.cashier.userId, (tx) => getActiveMembership(tx, A.tenantId, customerId))
    check('…benefits stop immediately', live === null)
    check('…the profile badge is cleared', (await ownerPool.query('select membership_status from customers where id=$1', [customerId])).rows[0].membership_status === null)

    const bal = await withUser(A.cashier.userId, (tx) => walletBalance(tx, A.tenantId, customerId))
    check('…wallet credit already granted is NOT clawed back', bal === 300)

    const again = await expectError(() =>
      withUser(A.cashier.userId, (tx) => cancelMembership(tx, A.tenantId, sold.membershipId)))
    check('cancelling twice is refused', again.threw && again.isMembershipError)

    // And the customer can buy again afterwards.
    const fresh = await sellA(customerId, planId)
    check('a cancelled membership does not block a new purchase', typeof fresh.membershipId === 'string')
  }

  // ── 8. free-hours drawdown (the AROS-61 hook) ─────────────────────────────
  {
    const customerId = await makeCustomer(A.tenantId)
    const planId = await makePlan(A.tenantId, { name: 'Hours', freeHours: '5.00' })
    const sold = await sellA(customerId, planId)

    const used = await withUser(A.cashier.userId, (tx) => consumeFreeHours(tx, A.tenantId, sold.membershipId, 2))
    check('2 of 5 free hours can be consumed', used === 2)
    const b = await withUser(A.cashier.userId, (tx) => getMembershipBenefits(tx, A.tenantId, customerId))
    check('…3 hours remain', b?.benefits.freeHoursRemaining === 3)

    const over = await expectError(() =>
      withUser(A.cashier.userId, (tx) => consumeFreeHours(tx, A.tenantId, sold.membershipId, 4)))
    check('consuming more than remains is REFUSED', over.threw && over.isMembershipError)
    check('…and the used figure did not move', (await rowOf(sold.membershipId)).free_hours_used === '2.00')

    for (const bad of [0, -1, NaN]) {
      const r = await expectError(() =>
        withUser(A.cashier.userId, (tx) => consumeFreeHours(tx, A.tenantId, sold.membershipId, bad)))
      check(`consuming ${bad} hours is refused`, r.threw)
    }

    // The CHECK constraint is the real guarantee against a concurrent overspend.
    let checkHeld = false
    try {
      await ownerPool.query(
        `update customer_memberships set free_hours_used='99.00' where id=$1`, [sold.membershipId])
    } catch (e) {
      checkHeld = pgCode(e) === '23514'
    }
    check('the DB refuses used > allowance (free_hours_drawdown CHECK)', checkHeld)

    // A lapsed membership cannot be drawn against.
    // Backdate both ends — the period CHECK requires expires_at > starts_at.
    await ownerPool.query(
      `update customer_memberships set starts_at = now() - interval '2 months',
              expires_at = now() - interval '1 day' where id=$1`,
      [sold.membershipId])
    const lapsed = await expectError(() =>
      withUser(A.cashier.userId, (tx) => consumeFreeHours(tx, A.tenantId, sold.membershipId, 1)))
    check('an EXPIRED membership cannot have hours drawn from it', lapsed.threw && lapsed.isMembershipError)
  }

  // ── 9. validation and eligibility of inputs ───────────────────────────────
  {
    const customerId = await makeCustomer(A.tenantId)
    const inactive = await makePlan(A.tenantId, { name: 'Retired', active: false })
    const r1 = await expectError(() => sellA(customerId, inactive))
    check('a retired plan cannot be sold', r1.threw && r1.message.includes('no longer on sale'))

    const r2 = await expectError(() => sellA(customerId, '00000000-0000-4000-8000-000000000000'))
    check('an unknown plan id is refused', r2.threw && r2.message === 'Membership plan not found.')

    const spare = await makePlan(A.tenantId)
    const r3 = await expectError(() => sellA('00000000-0000-4000-8000-000000000000', spare))
    check('an unknown customer id is refused', r3.threw && r3.message === 'Customer not found.')

    const r4 = await expectError(() => sellA('not-a-uuid', spare))
    check('a malformed id is refused by validation', r4.threw)

    // A free plan is legitimate (a comped membership); zero price must work.
    const freePlan = await makePlan(A.tenantId, { name: 'Comp', price: '0.00', wallet: '0.00' })
    const freeCustomer = await makeCustomer(A.tenantId)
    // Direct, so no default payment method is substituted — a ₹0 membership
    // must sell with no tender at all.
    const comped = await withUser(A.cashier.userId, (tx) =>
      purchaseMembership(tx, actorA, { customerId: freeCustomer, planId: freePlan }))
    check('a ₹0 plan can be sold with no tender (a comped membership)', comped.pricePaid === 0)
    check('…and grants no wallet credit', comped.walletCredited === 0)
    check('…and raises NO invoice, because nothing is owed', comped.invoiceId === null && comped.paymentId === null)
    check('…with no wallet ledger entry at all', Number((await ownerPool.query('select count(*)::int n from wallet_transactions where customer_id=$1', [freeCustomer])).rows[0].n) === 0)

    check('canBill covers owner/manager/cashier, not kitchen', canBill('owner') && canBill('manager') && canBill('cashier') && !canBill('kitchen_staff'))
  }

  // ── 10. tenant isolation ──────────────────────────────────────────────────
  {
    const aCustomer = await makeCustomer(A.tenantId)
    const aPlan = await makePlan(A.tenantId, { name: 'Iso A' })
    const sold = await sellA(aCustomer, aPlan)

    const bCustomer = await makeCustomer(B.tenantId)
    const bPlan = await makePlan(B.tenantId, { name: 'Iso B' })
    const actorB = {
      tenantId: B.tenantId,
      membershipId: B.cashier.membershipId,
      timezone: 'Asia/Kolkata',
      branchId: B.branchId,
    }
    const sellB = (c: string, p: string) =>
      withUser(B.cashier.userId, (tx) =>
        purchaseMembership(tx, actorB, { customerId: c, planId: p, paymentMethod: 'cash' }))

    const crossCustomer = await expectError(() => sellB(aCustomer, bPlan))
    check("tenant B cannot sell to tenant A's customer", crossCustomer.threw && crossCustomer.message === 'Customer not found.')
    const crossPlan = await expectError(() => sellB(bCustomer, aPlan))
    check("tenant B cannot sell tenant A's plan", crossPlan.threw && crossPlan.message === 'Membership plan not found.')

    // Forging tenant A's id into the actor: RLS on the app connection blocks it.
    const spoof = await expectError(() =>
      withUser(B.cashier.userId, (tx) =>
        purchaseMembership(
          tx,
          {
            tenantId: A.tenantId,
            membershipId: B.cashier.membershipId,
            timezone: 'Asia/Kolkata',
            branchId: A.branchId,
          },
          { customerId: aCustomer, planId: aPlan, paymentMethod: 'cash' },
        )))
    check("…nor by forging tenant A's id into the actor", spoof.threw)

    const bRows = await withUser(B.cashier.userId, (tx) => tx.select().from(customerMemberships))
    check("tenant B sees only its own memberships", bRows.every((r) => r.tenantId === B.tenantId))
    check("…and never tenant A's", !bRows.some((r) => r.id === sold.membershipId))

    const targeted = await withUser(B.cashier.userId, (tx) =>
      tx.select().from(customerMemberships).where(eq(customerMemberships.id, sold.membershipId)))
    check("…not even by id", targeted.length === 0)

    const crossCancel = await withUser(B.cashier.userId, (tx) =>
      tx.update(customerMemberships).set({ status: 'cancelled', cancelledAt: new Date() })
        .where(eq(customerMemberships.id, sold.membershipId))
        .returning({ id: customerMemberships.id }))
    check("tenant B cannot cancel tenant A's membership (0 rows)", crossCancel.length === 0)
    check("…and it is still active", (await rowOf(sold.membershipId)).status === 'active')

    const crossBenefits = await withUser(B.cashier.userId, (tx) =>
      getMembershipBenefits(tx, B.tenantId, aCustomer))
    check("tenant B reads no benefits for tenant A's customer", crossBenefits === null)

    // The composite FK makes a cross-tenant row structurally impossible even
    // with the owner connection.
    let fkHeld = false
    try {
      await ownerPool.query(
        `insert into customer_memberships (tenant_id,customer_id,plan_id,plan_name,price_paid,
                                           duration_months,expires_at)
         values ($1,$2,$3,'Cross','1.00',1,now() + interval '1 month')`,
        [B.tenantId, aCustomer, bPlan],
      )
    } catch (e) {
      fkHeld = pgCode(e) === '23503'
    }
    check("a membership pointing at another tenant's customer is refused by the FK", fkHeld)
  }

  // ── 11. no plaintext drift between snapshot and plan ──────────────────────
  {
    const audit = await ownerPool.query<{ n: string }>(
      `select count(*)::text n from customer_memberships cm
        where cm.tenant_id = any($1)
          and not exists (select 1 from membership_plans p
                           where p.id = cm.plan_id and p.tenant_id = cm.tenant_id)`,
      [[A.tenantId, B.tenantId]])
    check('every membership still points at a plan in its own tenant', audit.rows[0].n === '0')

    const bad = await ownerPool.query<{ n: string }>(
      `select count(*)::text n from customer_memberships
        where tenant_id = any($1)
          and (expires_at <= starts_at or price_paid < 0 or free_hours_used > free_hours
               or discount_percent < 0 or discount_percent > 100)`,
      [[A.tenantId, B.tenantId]])
    check('no membership violates its own CHECK constraints', bad.rows[0].n === '0')

    const dupes = await ownerPool.query<{ n: string }>(
      `select count(*)::text n from (
         select tenant_id, customer_id from customer_memberships
          where status='active' group by tenant_id, customer_id having count(*) > 1) d`)
    check('no customer anywhere holds two active memberships', dupes.rows[0].n === '0')
  }

  // ── cleanup ───────────────────────────────────────────────────────────────
  await ownerPool.query('delete from tenants where id = any($1)', [[A.tenantId, B.tenantId]])
  await ownerPool.query(`delete from users where email like '%@testcm%.test'`)
  await ownerPool.end()
  await appPool.end()

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error('test harness error:', e instanceof Error ? `${e.name}: ${e.message}` : 'unknown')
  process.exit(1)
})
