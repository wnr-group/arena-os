/**
 * Splitting a restaurant bill into independently-payable checks — even
 * N-way, by seat, or by item (M18 #2). Integration tests against a real
 * database, same shape as scripts/test-seat-tagging.ts/test-modifiers.ts.
 * Drives issueSplitBillForBooking (lib/billing/split.ts) directly:
 *
 *   - even/by-seat/by-item splits all reconcile EXACTLY to the un-split
 *     whole, to the paisa, including an odd/prime total
 *   - by-item: every order_items.id appears in exactly one check's
 *     invoice_items.source_id — none missing, none duplicated
 *   - by-seat: a shared/unassigned item's value is fully distributed across
 *     every seat's check, none lost
 *   - a booking that's already been split refuses a second bill/split
 *     (findLiveBilling)
 *   - each check is settled independently via the existing payments core
 *     (recordPaymentForInvoice) — no changes needed there
 *   - a booking cannot complete while any check is unpaid, and can the
 *     instant the last one is (assertBookingFullyPaid)
 *
 *   npx tsx scripts/test-split-bill.ts
 */
import { Pool } from 'pg'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { sql } from 'drizzle-orm'
import * as schema from '../db/schema'
import { seatTableSessionCore, assertBookingFullyPaid, BookingError } from '../lib/booking/service'
import { createOrderCore } from '../lib/orders/service'
import { issueInvoiceForBooking, BillingError } from '../lib/billing/invoice'
import { issueSplitBillForBooking, type SplitInput } from '../lib/billing/split'
import { recordPaymentForInvoice, PaymentError } from '../lib/billing/payments'
import { loadEnv } from './env'

type Db = NodePgDatabase<typeof schema>

let pass = 0,
  fail = 0
const check = (l: string, c: boolean) => {
  console.log(`${c ? '✓' : '✗ FAIL'}  ${l}`)
  if (c) pass++
  else fail++
}
const paise = (n: number | string) => Math.round(Number(n) * 100)

const TZ = 'Asia/Kolkata'

async function main() {
  loadEnv()

  const ownerPool = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })
  const appPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 })
  const app = drizzle(appPool, { schema })

  async function withUser<T>(userId: string, fn: (tx: Db) => Promise<T>): Promise<T> {
    return app.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`)
      return fn(tx as unknown as Db)
    })
  }

  type Tenant = {
    tenantId: string
    branchId: string
    userId: string
    membershipId: string
    itemId5: string // 5% GST item, 100.00
    itemId18: string // 18% GST item, 250.00
    tables: string[]
  }

  async function makeTenant(slug: string, tableCount = 3): Promise<Tenant> {
    const t = await ownerPool.query<{ id: string }>(
      `insert into tenants (slug,name,status,timezone,industry) values ($1,$2,'active',$3,'restaurant')
       on conflict (slug) do update set name=excluded.name returning id`,
      [slug, `${slug} co`, TZ],
    )
    const tenantId = t.rows[0].id
    const b = await ownerPool.query<{ id: string }>(
      `insert into branches (tenant_id,name,is_primary) values ($1,'Main',true)
       on conflict (tenant_id,name) do update set is_primary=true returning id`,
      [tenantId],
    )
    const branchId = b.rows[0].id
    const u = await ownerPool.query<{ id: string }>(
      `insert into users (email,password_hash) values ($1,'x')
       on conflict (email) do update set email=excluded.email returning id`,
      [`waiter@${slug}.test`],
    )
    const m = await ownerPool.query<{ id: string }>(
      `insert into memberships (tenant_id,user_id,role,status) values ($1,$2,'owner','active')
       on conflict (tenant_id,user_id) do update set role='owner', status='active' returning id`,
      [tenantId, u.rows[0].id],
    )
    const cat = await ownerPool.query<{ id: string }>(
      `insert into menu_categories (tenant_id,name) values ($1,'Mains')
       on conflict (tenant_id,name) do update set name=excluded.name returning id`,
      [tenantId],
    )
    const tax5 = await ownerPool.query<{ id: string }>(
      `insert into tax_rates (tenant_id,name,percent) values ($1,'GST 5','5.00') returning id`,
      [tenantId],
    )
    const tax18 = await ownerPool.query<{ id: string }>(
      `insert into tax_rates (tenant_id,name,percent) values ($1,'GST 18','18.00') returning id`,
      [tenantId],
    )
    const item5 = await ownerPool.query<{ id: string }>(
      `insert into menu_items (tenant_id,category_id,name,price,tax_rate_id) values ($1,$2,'Pasta','100.00',$3) returning id`,
      [tenantId, cat.rows[0].id, tax5.rows[0].id],
    )
    const item18 = await ownerPool.query<{ id: string }>(
      `insert into menu_items (tenant_id,category_id,name,price,tax_rate_id) values ($1,$2,'Wine','250.00',$3) returning id`,
      [tenantId, cat.rows[0].id, tax18.rows[0].id],
    )
    const rt = await ownerPool.query<{ id: string }>(
      `insert into resource_types (tenant_id,name,hourly_rate) values ($1,'Table','0')
       on conflict (tenant_id,name) do update set name=excluded.name returning id`,
      [tenantId],
    )
    const tableIds: string[] = []
    for (let i = 0; i < tableCount; i++) {
      const r = await ownerPool.query<{ id: string }>(
        `insert into resources (tenant_id,branch_id,resource_type_id,name) values ($1,$2,$3,$4) returning id`,
        [tenantId, branchId, rt.rows[0].id, `T${i + 1}`],
      )
      tableIds.push(r.rows[0].id)
    }
    return {
      tenantId,
      branchId,
      userId: u.rows[0].id,
      membershipId: m.rows[0].id,
      itemId5: item5.rows[0].id,
      itemId18: item18.rows[0].id,
      tables: tableIds,
    }
  }

  async function seat(t: Tenant, resourceId: string, coverCount: number) {
    return withUser(t.userId, (tx) =>
      seatTableSessionCore(tx, { tenantId: t.tenantId, timezone: TZ, membershipId: t.membershipId }, { branchId: t.branchId, resourceId, coverCount }),
    )
  }

  async function order(t: Tenant, bookingId: string, items: { menuItemId: string; qty: number; seatNo?: number }[]) {
    return withUser(t.userId, (tx) =>
      createOrderCore(tx, { tenantId: t.tenantId, timezone: TZ, membershipId: t.membershipId }, { branchId: t.branchId, bookingId, items }),
    )
  }

  async function whole(t: Tenant, bookingId: string) {
    return withUser(t.userId, (tx) => issueInvoiceForBooking(tx, { id: t.tenantId, timezone: TZ }, { bookingId }))
  }

  async function split(t: Tenant, bookingId: string, input: SplitInput) {
    return withUser(t.userId, (tx) =>
      issueSplitBillForBooking(tx, { id: t.tenantId, timezone: TZ }, { bookingId, ...input }),
    )
  }

  async function attempt<T>(fn: () => Promise<T>) {
    try {
      const value = await fn()
      return { ok: true as const, value }
    } catch (e) {
      return {
        ok: false as const,
        billing: e instanceof BillingError,
        booking: e instanceof BookingError,
        payment: e instanceof PaymentError,
        message: e instanceof Error ? e.message : String(e),
      }
    }
  }

  async function complete(t: Tenant, bookingId: string) {
    await withUser(t.userId, (tx) => assertBookingFullyPaid(tx, t.tenantId, bookingId))
    await withUser(t.userId, (tx) => tx.update(schema.bookings).set({ status: 'completed' }).where(sql`${schema.bookings.id} = ${bookingId}`))
  }

  async function cancel(t: Tenant, bookingId: string) {
    await withUser(t.userId, (tx) => tx.update(schema.bookings).set({ status: 'cancelled' }).where(sql`${schema.bookings.id} = ${bookingId}`))
  }

  async function invoiceRows(bookingId: string) {
    const { rows } = await ownerPool.query(
      `select id, invoice_number, bill_group_id, bill_group_seq, subtotal, discount, tax_total, total, status
       from invoices where booking_id=$1 and status != 'void' order by bill_group_seq`,
      [bookingId],
    )
    return rows as {
      id: string
      invoice_number: string
      bill_group_id: string | null
      bill_group_seq: number | null
      subtotal: string
      discount: string
      tax_total: string
      total: string
      status: string
    }[]
  }

  async function invoiceItemRows(invoiceId: string) {
    const { rows } = await ownerPool.query(
      `select source_id, description, kind, line_total, tax_rate from invoice_items where invoice_id=$1 order by created_at`,
      [invoiceId],
    )
    return rows as { source_id: string | null; description: string; kind: string; line_total: string; tax_rate: string }[]
  }

  async function orderItemIds(bookingId: string) {
    const { rows } = await ownerPool.query(
      `select oi.id from order_items oi join orders o on o.id = oi.order_id where o.booking_id=$1`,
      [bookingId],
    )
    return rows.map((r) => r.id as string)
  }

  const A = await makeTenant('testsplitbill-a')
  const B = await makeTenant('testsplitbill-b')

  // ── 1. even split reconciles exactly, including an odd/prime total ─────────
  {
    const session = await seat(A, A.tables[0], 4)
    // 7 × Pasta (100.00, 5%) = 700.00, split 3 ways — 233.33 / 233.33 / 233.34,
    // deliberately NOT evenly divisible by 3.
    await order(A, session.id, [{ menuItemId: A.itemId5, qty: 7 }])

    const result = await split(A, session.id, { mode: 'even', checkCount: 3 })
    const rows = await invoiceRows(session.id)
    check('even split writes 3 invoice rows sharing one bill_group_id', rows.length === 3 && new Set(rows.map((r) => r.bill_group_id)).size === 1)
    check('bill_group_seq is 1..3', rows.map((r) => r.bill_group_seq).sort().join(',') === '1,2,3')

    const sumTotal = rows.reduce((s, r) => s + paise(r.total), 0)
    const sumSubtotal = rows.reduce((s, r) => s + paise(r.subtotal), 0)
    const sumTax = rows.reduce((s, r) => s + paise(r.tax_total), 0)
    // whole: subtotal 700.00, 5% tax = 35.00, total 735.00
    check('even split subtotal sums to 700.00', sumSubtotal === paise(700))
    check('even split tax sums to 35.00', sumTax === paise(35))
    check('even split total sums to 735.00, despite not dividing evenly by 3', sumTotal === paise(735))
    check('no two checks are more than a paisa apart (fair rounding remainder)', Math.max(...rows.map((r) => paise(r.total))) - Math.min(...rows.map((r) => paise(r.total))) <= 1)
    check('every check total is > 0', result.checks.every((c) => c.pricing.total > 0))

    await cancel(A, session.id)
  }

  // ── 2. by-item split: every order_items.id in exactly one check ────────────
  {
    const session = await seat(A, A.tables[0], 4)
    const o1 = await order(A, session.id, [{ menuItemId: A.itemId18, qty: 1 }]) // Wine
    const o2 = await order(A, session.id, [{ menuItemId: A.itemId5, qty: 2 }]) // 2x Pasta
    const ids = await orderItemIds(session.id)
    check('2 order_items exist to split (1 wine line + 1 pasta line, qty 2)', ids.length === 2)
    void o1
    void o2

    const [wineItemId, pastaItemId] = ids
    await split(A, session.id, {
      mode: 'item',
      checkCount: 2,
      assignments: { [wineItemId]: 0, [pastaItemId]: 1 },
    })
    const rows = await invoiceRows(session.id)
    check('by-item split writes 2 checks', rows.length === 2)

    const allSourceIds: string[] = []
    for (const r of rows) {
      const items = await invoiceItemRows(r.id)
      check(`check ${r.bill_group_seq} carries only real assigned lines, no synthetic shared lines`, items.every((i) => i.source_id !== null))
      allSourceIds.push(...items.map((i) => i.source_id as string))
    }
    check('every order_items.id appears exactly once across all checks', JSON.stringify(allSourceIds.sort()) === JSON.stringify([...ids].sort()))

    const sumTotal = rows.reduce((s, r) => s + paise(r.total), 0)
    // subtotal = 250 (wine) + 200 (2×100 pasta) = 450; tax = 18%×250=45 + 5%×200=10 = 55; total = 505.00
    check('by-item split total sums to 505.00', sumTotal === paise(505))

    await cancel(A, session.id)
  }

  // ── 3. by-seat split with a shared/unassigned item ──────────────────────────
  {
    const session = await seat(A, A.tables[0], 4)
    await order(A, session.id, [{ menuItemId: A.itemId18, qty: 1, seatNo: 1 }]) // Wine, seat 1
    await order(A, session.id, [{ menuItemId: A.itemId5, qty: 1, seatNo: 2 }]) // Pasta, seat 2
    await order(A, session.id, [{ menuItemId: A.itemId5, qty: 1 }]) // shared Pasta, no seat

    await split(A, session.id, { mode: 'seat' })
    const rows = await invoiceRows(session.id)
    check('by-seat split writes 2 checks (seat 1 and seat 2)', rows.length === 2)

    let sharedValue = 0
    for (const r of rows) {
      const items = await invoiceItemRows(r.id)
      const shared = items.filter((i) => i.source_id === null)
      check(`check ${r.bill_group_seq} carries its own real line plus a shared-pool line`, items.some((i) => i.source_id !== null) && shared.length === 1)
      sharedValue += shared.reduce((s, i) => s + paise(i.line_total), 0)
    }
    check('the shared item (100.00) is fully distributed across both checks, none lost', sharedValue === paise(100))

    const sumTotal = rows.reduce((s, r) => s + paise(r.total), 0)
    // subtotal = 250 (wine) + 100 (seat2 pasta) + 100 (shared pasta) = 450; tax = 45 + 5 + 5 = 55; total = 505.00
    check('by-seat split total sums to 505.00', sumTotal === paise(505))

    await cancel(A, session.id)
  }

  // ── 4. a booking that's already split refuses a second bill/split ──────────
  {
    const session = await seat(A, A.tables[0], 4)
    await order(A, session.id, [{ menuItemId: A.itemId5, qty: 1 }])
    await split(A, session.id, { mode: 'even', checkCount: 2 })

    const again = await attempt(() => split(A, session.id, { mode: 'even', checkCount: 3 }))
    check('splitting an already-split booking again is refused', !again.ok && again.billing && /already been split/i.test(again.message))

    const normal = await attempt(() => whole(A, session.id))
    check('billing an already-split booking normally is also refused', !normal.ok && normal.billing && /already been split/i.test(normal.message))

    await cancel(A, session.id)
  }

  // ── 5. splitting an already normally-billed booking is refused ─────────────
  {
    const session = await seat(A, A.tables[0], 4)
    await order(A, session.id, [{ menuItemId: A.itemId5, qty: 1 }])
    const inv = await whole(A, session.id)

    const attemptSplit = await attempt(() => split(A, session.id, { mode: 'even', checkCount: 2 }))
    check('splitting an already normally-billed booking is refused', !attemptSplit.ok && attemptSplit.billing && /already been billed/i.test(attemptSplit.message) && attemptSplit.message.includes(inv.invoiceNumber))

    await cancel(A, session.id)
  }

  // ── 6. each check settles independently; completion gate ───────────────────
  {
    const session = await seat(A, A.tables[0], 4)
    await order(A, session.id, [{ menuItemId: A.itemId5, qty: 2 }]) // 200.00 + 5% = 210.00
    const result = await split(A, session.id, { mode: 'even', checkCount: 2 })
    const [c1, c2] = result.checks

    const blocked = await attempt(() => complete(A, session.id))
    check('booking cannot complete while any check is unpaid', !blocked.ok && blocked.booking && /split/i.test(blocked.message))

    await withUser(A.userId, (tx) =>
      recordPaymentForInvoice(tx, { tenantId: A.tenantId, membershipId: A.membershipId }, { invoiceId: c1.invoiceId, method: 'cash', amount: c1.pricing.total }),
    )
    const stillBlocked = await attempt(() => complete(A, session.id))
    check('…still blocked with one of two checks paid', !stillBlocked.ok && stillBlocked.booking)

    await withUser(A.userId, (tx) =>
      recordPaymentForInvoice(tx, { tenantId: A.tenantId, membershipId: A.membershipId }, { invoiceId: c2.invoiceId, method: 'upi', amount: c2.pricing.total }),
    )
    const nowOk = await attempt(() => complete(A, session.id))
    check('…and completes the instant the last check is paid', nowOk.ok)
  }

  // ── 7. tenant isolation: cross-tenant booking id is invisible to split ─────
  {
    const session = await seat(B, B.tables[0], 2)
    await order(B, session.id, [{ menuItemId: B.itemId5, qty: 1 }])
    const cross = await attempt(() =>
      withUser(A.userId, (tx) => issueSplitBillForBooking(tx, { id: A.tenantId, timezone: TZ }, { bookingId: session.id, mode: 'even', checkCount: 2 })),
    )
    check("tenant A cannot split tenant B's booking (RLS ⇒ not found)", !cross.ok && cross.billing && /not found/i.test(cross.message))
    await cancel(B, session.id)
  }

  // ── cleanup ───────────────────────────────────────────────────────────────
  await ownerPool.query('delete from tenants where id = any($1)', [[A.tenantId, B.tenantId]])
  await ownerPool.query(`delete from users where email like '%@testsplitbill-%.test'`)
  await ownerPool.end()
  await appPool.end()

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
