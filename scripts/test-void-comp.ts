/**
 * Void/comp an order item, via the request/approve/reject workflow —
 * integration tests against a real database (M17 #6). Drives
 * requestVoidOrderItemCore / decideVoidRequestCore (lib/orders/service.ts)
 * directly, same shape as scripts/test-table-transfer.ts:
 *
 *   - a manager/owner requesting is auto-approved in the same transaction —
 *     same end state as the old direct voidOrderItemCore: flags the item
 *     (never deletes it) and takes it off loadFoodLines/loadOrderFoodLines
 *   - 'voided' and 'comped' are distinguishable on the row afterwards
 *   - a reason is required to request
 *   - an item already voided/comped cannot be requested again
 *   - an item on a `billed` order is refused — it belongs to the invoice's
 *     own void/refund flow, not this one
 *   - an item on a `cancelled` order is refused
 *   - voiding the LAST active item on an order cancels its still-open KOT;
 *     voiding one of several active items leaves the ticket alone
 *   - a non-manager's request sits `pending` and does NOT touch the bill,
 *     the item row, or the KOT until a manager decides it
 *   - a manager approving a pending request applies it exactly like a direct
 *     void/comp, and the request row records who asked + who decided
 *   - a manager rejecting a pending request leaves the item untouched and
 *     billable, and is itself audited
 *   - only one pending request per item at a time
 *   - a decided request cannot be decided again
 *   - every step writes the audit_log row it promises
 *   - tenant isolation (RLS): another tenant's order item / request is invisible
 *
 *   npx tsx scripts/test-void-comp.ts
 */
import { Pool } from 'pg'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { eq, sql } from 'drizzle-orm'
import * as schema from '../db/schema'
import { seatTableSessionCore } from '../lib/booking/service'
import {
  createOrderCore,
  cancelOrderCore,
  requestVoidOrderItemCore,
  decideVoidRequestCore,
  OrderError,
} from '../lib/orders/service'
import { issueInvoiceForBooking, loadFoodLines, loadOrderFoodLines } from '../lib/billing/invoice'
import { loadEnv } from './env'

type Db = NodePgDatabase<typeof schema>

let pass = 0,
  fail = 0
const check = (l: string, c: boolean) => {
  console.log(`${c ? '✓' : '✗ FAIL'}  ${l}`)
  if (c) pass++
  else fail++
}

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
    managerUserId: string
    managerMembershipId: string
    itemId: string
    tables: string[]
  }

  async function makeTenant(slug: string, tableCount = 4): Promise<Tenant> {
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
    // The waiter can create orders and RAISE a void/comp request; only the
    // manager membership below can APPROVE/REJECT one (the action layer's
    // requireManager() gate — this script drives the cores directly, so it
    // supplies whichever membership/role it wants to test with).
    const m = await ownerPool.query<{ id: string }>(
      `insert into memberships (tenant_id,user_id,role,status) values ($1,$2,'floor_staff','active')
       on conflict (tenant_id,user_id) do update set role='floor_staff', status='active' returning id`,
      [tenantId, u.rows[0].id],
    )
    const mgrUser = await ownerPool.query<{ id: string }>(
      `insert into users (email,password_hash) values ($1,'x')
       on conflict (email) do update set email=excluded.email returning id`,
      [`manager@${slug}.test`],
    )
    const mgr = await ownerPool.query<{ id: string }>(
      `insert into memberships (tenant_id,user_id,role,status) values ($1,$2,'manager','active')
       on conflict (tenant_id,user_id) do update set role='manager', status='active' returning id`,
      [tenantId, mgrUser.rows[0].id],
    )
    const cat = await ownerPool.query<{ id: string }>(
      `insert into menu_categories (tenant_id,name) values ($1,'Snacks')
       on conflict (tenant_id,name) do update set name=excluded.name returning id`,
      [tenantId],
    )
    const item = await ownerPool.query<{ id: string }>(
      `insert into menu_items (tenant_id,category_id,name,price) values ($1,$2,'Fries','80.00') returning id`,
      [tenantId, cat.rows[0].id],
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
      managerUserId: mgrUser.rows[0].id,
      managerMembershipId: mgr.rows[0].id,
      itemId: item.rows[0].id,
      tables: tableIds,
    }
  }

  async function seat(t: Tenant, resourceId: string, coverCount: number) {
    return withUser(t.userId, (tx) =>
      seatTableSessionCore(
        tx,
        { tenantId: t.tenantId, timezone: TZ, membershipId: t.membershipId },
        { branchId: t.branchId, resourceId, coverCount },
      ),
    )
  }

  async function order(t: Tenant, bookingId: string, qty = 2) {
    return withUser(t.userId, (tx) =>
      createOrderCore(
        tx,
        { tenantId: t.tenantId, timezone: TZ, membershipId: t.membershipId },
        { branchId: t.branchId, bookingId, items: Array.from({ length: qty }, () => ({ menuItemId: t.itemId, qty: 1 })) },
      ),
    )
  }

  async function orderItemIds(orderId: string): Promise<string[]> {
    const { rows } = await ownerPool.query<{ id: string }>(`select id from order_items where order_id=$1 order by id`, [orderId])
    return rows.map((r) => r.id)
  }

  async function orderItemRow(id: string) {
    const { rows } = await ownerPool.query(
      `select void_status, void_reason, voided_by, voided_at from order_items where id=$1`,
      [id],
    )
    return rows[0] as { void_status: string; void_reason: string | null; voided_by: string | null; voided_at: Date | null } | undefined
  }

  async function requestRow(id: string) {
    const { rows } = await ownerPool.query(
      `select status, requested_by, decided_by, decision_note from order_item_void_requests where id=$1`,
      [id],
    )
    return rows[0] as { status: string; requested_by: string | null; decided_by: string | null; decision_note: string | null } | undefined
  }

  async function kotStatus(orderId: string): Promise<string | undefined> {
    const { rows } = await ownerPool.query(`select status from kots where order_id=$1`, [orderId])
    return rows[0]?.status
  }

  async function auditRows(entityId: string) {
    const { rows } = await ownerPool.query(
      `select action, entity_type, before, after from audit_log where entity_id=$1 order by created_at`,
      [entityId],
    )
    return rows as { action: string; entity_type: string; before: unknown; after: unknown }[]
  }

  async function attempt<T>(fn: () => Promise<T>) {
    try {
      const value = await fn()
      return { ok: true as const, value }
    } catch (e) {
      return {
        ok: false as const,
        orderError: e instanceof OrderError,
        message: e instanceof Error ? e.message : String(e),
      }
    }
  }

  const A = await makeTenant('testvoidcomp-a')
  const B = await makeTenant('testvoidcomp-b')

  // A manager requesting their own void/comp is auto-approved in the same
  // transaction — this is the direct equivalent of the old voidOrderItemCore.
  async function voidItem(t: Tenant, orderItemId: string, mode: 'void' | 'comp', reason: string) {
    return withUser(t.managerUserId, (tx) =>
      requestVoidOrderItemCore(
        tx,
        { tenantId: t.tenantId, membershipId: t.managerMembershipId, role: 'manager' },
        { orderItemId, mode, reason },
      ),
    )
  }

  async function requestAsWaiter(t: Tenant, orderItemId: string, mode: 'void' | 'comp', reason: string) {
    return withUser(t.userId, (tx) =>
      requestVoidOrderItemCore(
        tx,
        { tenantId: t.tenantId, membershipId: t.membershipId, role: 'floor_staff' },
        { orderItemId, mode, reason },
      ),
    )
  }

  async function decide(t: Tenant, requestId: string, decision: 'approve' | 'reject', note?: string) {
    return withUser(t.managerUserId, (tx) =>
      decideVoidRequestCore(tx, { tenantId: t.tenantId, membershipId: t.managerMembershipId }, { requestId, decision, note }),
    )
  }

  // ── 1. a manager's own request auto-approves; takes the item off the
  //      bill, leaves the row, writes audit ──────────────────────────────────
  {
    const session = await seat(A, A.tables[0], 4)
    const o = await order(A, session.id, 2)
    const [item1, item2] = await orderItemIds(o.id)

    const before = await withUser(A.userId, (tx) => loadFoodLines(tx, A.tenantId, session.id))
    check('both lines billable before voiding', before.length === 2)

    const r = await attempt(() => voidItem(A, item1, 'void', 'Fired to the wrong table'))
    check('a manager requesting void is auto-approved', r.ok && r.value.status === 'approved')

    const after = await withUser(A.userId, (tx) => loadFoodLines(tx, A.tenantId, session.id))
    check('voided line excluded from the bill', after.length === 1 && after[0].sourceId === item2)

    const row = await orderItemRow(item1)
    check('row kept, flagged voided (not deleted)', row?.void_status === 'voided')
    check('reason recorded', row?.void_reason === 'Fired to the wrong table')
    check('voided_by set to the approving manager', row?.voided_by === A.managerMembershipId)
    check('voided_at set', row?.voided_at !== null)

    const audit = await auditRows(item1)
    check('audit row written for the void', audit.some((a) => a.action === 'order_item.void' && a.entity_type === 'order_item'))
    const auditAfter = audit.find((a) => a.action === 'order_item.void')?.after as { amount?: string; reason?: string } | undefined
    check('audit row carries the amount and reason', auditAfter?.amount === '80.00' && auditAfter?.reason === 'Fired to the wrong table')

    // KOT still active — item2 is still active on the same order.
    check('KOT left alone: another active item remains on the order', (await kotStatus(o.id)) === 'pending')

    // ── voiding the LAST active item cancels the still-open KOT ──────────────
    const r2 = await attempt(() => voidItem(A, item2, 'void', 'Kitchen closed, item 86ed'))
    check('voiding the last active item succeeds', r2.ok)
    check('KOT cancelled once every item on the order is off the tab', (await kotStatus(o.id)) === 'cancelled')

    await withUser(A.userId, (tx) => tx.update(schema.bookings).set({ status: 'completed' }).where(eq(schema.bookings.id, session.id)))
  }

  // ── 2. comp is distinguishable from void, and also excluded from billing ──
  {
    const session = await seat(A, A.tables[1], 2)
    const o = await order(A, session.id, 1)
    const [item] = await orderItemIds(o.id)

    const r = await attempt(() => voidItem(A, item, 'comp', "Manager comped the guest's dessert"))
    check('comp succeeds', r.ok)

    const row = await orderItemRow(item)
    check("comp is flagged 'comped', distinct from 'voided'", row?.void_status === 'comped')

    const lines = await withUser(A.userId, (tx) => loadFoodLines(tx, A.tenantId, session.id))
    check('comped line excluded from the bill same as a void', lines.length === 0)

    const audit = await auditRows(item)
    check('audit row written for the comp, actioned distinctly', audit.some((a) => a.action === 'order_item.comp'))

    // A comp never touches the kitchen ticket — the food was already made.
    check('comping does not cancel the KOT', (await kotStatus(o.id)) === 'pending')

    await withUser(A.userId, (tx) => tx.update(schema.bookings).set({ status: 'completed' }).where(eq(schema.bookings.id, session.id)))
  }

  // ── 3. guards ───────────────────────────────────────────────────────────────
  {
    const session = await seat(A, A.tables[2], 2)
    const o = await order(A, session.id, 1)
    const [item] = await orderItemIds(o.id)

    const noReason = await attempt(() => voidItem(A, item, 'void', '   '))
    check('an empty/whitespace-only reason is refused', !noReason.ok && noReason.orderError)

    await voidItem(A, item, 'void', 'test')
    const already = await attempt(() => voidItem(A, item, 'comp', 'try again'))
    check('an already-voided item cannot be requested again', !already.ok && already.orderError && /already been voided/i.test(already.message))

    // billed order
    const o2 = await order(A, session.id, 1)
    const [item2] = await orderItemIds(o2.id)
    await withUser(A.userId, (tx) => issueInvoiceForBooking(tx, { id: A.tenantId, timezone: TZ }, { bookingId: session.id }))
    const billed = await attempt(() => voidItem(A, item2, 'void', 'too late'))
    check('an item on an already-billed order is refused', !billed.ok && billed.orderError && /already been billed/i.test(billed.message))

    // cancelled order
    const session2 = await seat(A, A.tables[3], 2)
    const o3 = await order(A, session2.id, 1)
    const [item3] = await orderItemIds(o3.id)
    await withUser(A.userId, (tx) => cancelOrderCore(tx, { tenantId: A.tenantId }, o3.id))
    const cancelled = await attempt(() => voidItem(A, item3, 'void', 'moot'))
    check('an item on a cancelled order is refused', !cancelled.ok && cancelled.orderError && /already cancelled/i.test(cancelled.message))

    await withUser(A.userId, (tx) => tx.update(schema.bookings).set({ status: 'completed' }).where(eq(schema.bookings.id, session.id)))
    await withUser(A.userId, (tx) => tx.update(schema.bookings).set({ status: 'completed' }).where(eq(schema.bookings.id, session2.id)))
  }

  // ── 4. a standalone (pay-now) order's food lines are excluded the same way ─
  {
    const standalone = await withUser(A.userId, (tx) =>
      createOrderCore(
        tx,
        { tenantId: A.tenantId, timezone: TZ, membershipId: A.membershipId },
        { branchId: A.branchId, channel: 'online', acceptanceStatus: 'awaiting_payment', items: [{ menuItemId: A.itemId, qty: 1 }] },
      ),
    )
    const [item] = await orderItemIds(standalone.id)
    const before = await withUser(A.userId, (tx) => loadOrderFoodLines(tx, A.tenantId, standalone.id))
    check('standalone order line billable before voiding', before.length === 1)

    await voidItem(A, item, 'void', 'guest cancelled before paying')
    const after = await withUser(A.userId, (tx) => loadOrderFoodLines(tx, A.tenantId, standalone.id))
    check('standalone order line excluded once voided', after.length === 0)
  }

  // ── 5. tenant isolation (RLS) for a direct (manager) request ───────────────
  {
    const session = await seat(A, A.tables[0], 2)
    const o = await order(A, session.id, 1)
    const [item] = await orderItemIds(o.id)

    const cross = await attempt(() => voidItem(B, item, 'void', 'not yours'))
    check("tenant B cannot void tenant A's order item (RLS ⇒ not found)", !cross.ok && cross.orderError && /not found/i.test(cross.message))

    await withUser(A.userId, (tx) => tx.update(schema.bookings).set({ status: 'completed' }).where(eq(schema.bookings.id, session.id)))
  }

  // ── 6. a waiter's request sits pending — no change to the bill/item/KOT —
  //      until a manager approves it ──────────────────────────────────────────
  {
    const session = await seat(A, A.tables[1], 2)
    const o = await order(A, session.id, 1)
    const [item] = await orderItemIds(o.id)

    const req = await attempt(() => requestAsWaiter(A, item, 'void', 'Guest changed their mind'))
    check('a waiter can raise a request', req.ok && req.value.status === 'pending')
    if (!req.ok) throw new Error('request failed, aborting section 6')
    const requestId = req.value.requestId

    const stillBillable = await withUser(A.userId, (tx) => loadFoodLines(tx, A.tenantId, session.id))
    check('the item stays on the bill while the request is pending', stillBillable.length === 1)

    const rowWhilePending = await orderItemRow(item)
    check('the item row is untouched while pending', rowWhilePending?.void_status === 'active')

    const reqAudit = await auditRows(requestId)
    check(
      'raising the request is itself audited',
      reqAudit.some((a) => a.action === 'order_item.void_requested' && a.entity_type === 'order_item_void_request'),
    )

    const dupe = await attempt(() => requestAsWaiter(A, item, 'comp', 'trying again'))
    check('a second request on the same item is refused while one is pending', !dupe.ok && dupe.orderError && /already pending/i.test(dupe.message))

    const decision = await attempt(() => decide(A, requestId, 'approve'))
    check('a manager can approve the pending request', decision.ok)

    const rowAfterApproval = await orderItemRow(item)
    check('approving applies it exactly like a direct void', rowAfterApproval?.void_status === 'voided')
    check('voided_by is the APPROVING manager', rowAfterApproval?.voided_by === A.managerMembershipId)

    const billAfter = await withUser(A.userId, (tx) => loadFoodLines(tx, A.tenantId, session.id))
    check('the item comes off the bill once approved', billAfter.length === 0)

    const decidedRow = await requestRow(requestId)
    check('the request row records who asked and who decided', decidedRow?.status === 'approved' && decidedRow?.requested_by === A.membershipId && decidedRow?.decided_by === A.managerMembershipId)

    const approveAudit = await auditRows(item)
    check('the approval itself is audited on the order_item', approveAudit.some((a) => a.action === 'order_item.void'))

    const redecide = await attempt(() => decide(A, requestId, 'reject'))
    check('a decided request cannot be decided again', !redecide.ok && redecide.orderError && /already been approved/i.test(redecide.message))

    await withUser(A.userId, (tx) => tx.update(schema.bookings).set({ status: 'completed' }).where(eq(schema.bookings.id, session.id)))
  }

  // ── 7. a manager can reject a request — the item stays fully billable ──────
  {
    const session = await seat(A, A.tables[2], 2)
    const o = await order(A, session.id, 1)
    const [item] = await orderItemIds(o.id)

    const req = await attempt(() => requestAsWaiter(A, item, 'comp', 'Guest unhappy with the dish'))
    check('a waiter can raise a comp request', req.ok)
    if (!req.ok) throw new Error('request failed, aborting section 7')
    const requestId = req.value.requestId

    const decision = await attempt(() => decide(A, requestId, 'reject', "Kitchen remade it, guest is happy now"))
    check('a manager can reject the pending request', decision.ok)

    const row = await orderItemRow(item)
    check('a rejected item is untouched — still active', row?.void_status === 'active')

    const bill = await withUser(A.userId, (tx) => loadFoodLines(tx, A.tenantId, session.id))
    check('a rejected item stays fully billable', bill.length === 1)

    const decidedRow = await requestRow(requestId)
    check('the request row is marked rejected, with the note kept', decidedRow?.status === 'rejected' && decidedRow?.decision_note === 'Kitchen remade it, guest is happy now')

    const rejectAudit = await auditRows(requestId)
    check('the rejection is audited', rejectAudit.some((a) => a.action === 'order_item.comp_rejected'))

    // Rejected, so a fresh request on the same item is allowed again.
    const again = await attempt(() => requestAsWaiter(A, item, 'void', 'second attempt after rejection'))
    check('a fresh request is allowed once the previous one was decided', again.ok)

    await withUser(A.userId, (tx) => tx.update(schema.bookings).set({ status: 'completed' }).where(eq(schema.bookings.id, session.id)))
  }

  // ── 8. tenant isolation (RLS) on the decide step ────────────────────────────
  {
    const session = await seat(A, A.tables[3], 2)
    const o = await order(A, session.id, 1)
    const [item] = await orderItemIds(o.id)
    const req = await requestAsWaiter(A, item, 'void', 'cross-tenant test')

    const cross = await attempt(() => decide(B, req.requestId, 'approve'))
    check("tenant B cannot decide tenant A's request (RLS ⇒ not found)", !cross.ok && cross.orderError && /not found/i.test(cross.message))

    await withUser(A.userId, (tx) => tx.update(schema.bookings).set({ status: 'completed' }).where(eq(schema.bookings.id, session.id)))
  }

  // ── cleanup ───────────────────────────────────────────────────────────────
  await ownerPool.query('delete from tenants where id = any($1)', [[A.tenantId, B.tenantId]])
  await ownerPool.query(`delete from users where email like '%@testvoidcomp-%.test'`)
  await ownerPool.end()
  await appPool.end()

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
