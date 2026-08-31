/**
 * Table transfer / merge / split integration tests against a real database
 * (M17 #5). Drives the same transactional cores the floor-map dialogs drive
 * — transferTableCore, mergeTablesCore, splitTableCore — on an RLS-scoped
 * transaction through `arena_app`, same shape as scripts/test-kitchen.ts:
 *
 *   - transfer moves resource_id and brings orders along for free (they key
 *     off booking_id, which never changes)
 *   - transfer is blocked into an occupied table (23505 on
 *     idx_bookings_open_table_session), into itself, and once billed
 *   - merge moves every open order onto the survivor, sums cover counts,
 *     closes the loser (frees its table), and is blocked once either side
 *     is billed or the two bookings aren't distinct/same-branch
 *   - split creates a new session on a free table, moves only the selected
 *     open orders, decrements the source's cover count, and refuses to move
 *     an order that's no longer open or take the whole party's covers
 *   - every successful operation writes the audit_log rows it promises
 *   - tenant isolation (RLS): another tenant's booking is invisible
 *
 *   npx tsx scripts/test-table-transfer.ts
 */
import { Pool } from 'pg'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { and, eq, sql } from 'drizzle-orm'
import * as schema from '../db/schema'
import { seatTableSessionCore, transferTableCore, mergeTablesCore, splitTableCore, BookingError } from '../lib/booking/service'
import { createOrderCore } from '../lib/orders/service'
import { issueInvoiceForBooking } from '../lib/billing/invoice'
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

  type Tenant = { tenantId: string; branchId: string; userId: string; membershipId: string; itemId: string; tables: string[] }

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
      [`owner@${slug}.test`],
    )
    const m = await ownerPool.query<{ id: string }>(
      `insert into memberships (tenant_id,user_id,role,status) values ($1,$2,'owner','active')
       on conflict (tenant_id,user_id) do update set role='owner', status='active' returning id`,
      [tenantId, u.rows[0].id],
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
    return { tenantId, branchId, userId: u.rows[0].id, membershipId: m.rows[0].id, itemId: item.rows[0].id, tables: tableIds }
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

  async function order(t: Tenant, bookingId: string) {
    return withUser(t.userId, (tx) =>
      createOrderCore(
        tx,
        { tenantId: t.tenantId, timezone: TZ, membershipId: t.membershipId },
        { branchId: t.branchId, bookingId, items: [{ menuItemId: t.itemId, qty: 1 }] },
      ),
    )
  }

  async function attempt<T>(fn: () => Promise<T>) {
    try {
      const value = await fn()
      return { ok: true as const, value }
    } catch (e) {
      // Drizzle wraps driver errors in a DrizzleQueryError — the pg error
      // (code/constraint) lives on `.cause`, not the wrapper itself. Same
      // unwrap lib/actions/bookings.ts:pgError() does for the real UI.
      const cause = (e && typeof e === 'object' && 'cause' in e ? (e as { cause?: unknown }).cause : undefined) as
        | { code?: string; constraint?: string }
        | undefined
      const direct = e as { code?: string; constraint?: string } | undefined
      return {
        ok: false as const,
        bookingError: e instanceof BookingError,
        code: direct?.code ?? cause?.code ?? null,
        constraint: direct?.constraint ?? cause?.constraint ?? null,
        message: e instanceof Error ? e.message : String(e),
      }
    }
  }

  async function bookingRow(id: string) {
    const { rows } = await ownerPool.query(
      `select status, resource_id, cover_count from bookings where id=$1`,
      [id],
    )
    return rows[0] as { status: string; resource_id: string | null; cover_count: number | null } | undefined
  }

  async function orderBookingId(id: string) {
    const { rows } = await ownerPool.query(`select booking_id, status from orders where id=$1`, [id])
    return rows[0] as { booking_id: string | null; status: string }
  }

  async function auditRows(entityId: string) {
    const { rows } = await ownerPool.query(
      `select action, entity_type, before, after from audit_log where entity_id=$1 order by created_at`,
      [entityId],
    )
    return rows as { action: string; entity_type: string; before: unknown; after: unknown }[]
  }

  const A = await makeTenant('testtabxfer-a')
  const B = await makeTenant('testtabxfer-b')

  // ── 1. transfer ────────────────────────────────────────────────────────────
  {
    const session = await seat(A, A.tables[0], 3)
    const o = await order(A, session.id)
    const before = await bookingRow(session.id)
    check('seated at T1', before?.resource_id === A.tables[0] && before?.status === 'checked_in')

    const r = await attempt(() =>
      withUser(A.userId, (tx) =>
        transferTableCore(tx, { tenantId: A.tenantId, membershipId: A.membershipId }, { bookingId: session.id, targetResourceId: A.tables[1] }),
      ),
    )
    check('transfer to a free table succeeds', r.ok)

    const after = await bookingRow(session.id)
    check('booking now points at the new table', after?.resource_id === A.tables[1])
    const ord = await orderBookingId(o.id)
    check("the order's booking_id is untouched — it followed for free", ord.booking_id === session.id)

    const audit = await auditRows(session.id)
    check('transfer wrote an audit row', audit.some((a) => a.action === 'transfer_table'))

    // guard: transfer into itself
    const same = await attempt(() =>
      withUser(A.userId, (tx) =>
        transferTableCore(tx, { tenantId: A.tenantId, membershipId: A.membershipId }, { bookingId: session.id, targetResourceId: A.tables[1] }),
      ),
    )
    check('transferring to the same table is refused', !same.ok && same.bookingError)

    // guard: transfer into an occupied table
    const other = await seat(A, A.tables[2], 2)
    const occupied = await attempt(() =>
      withUser(A.userId, (tx) =>
        transferTableCore(tx, { tenantId: A.tenantId, membershipId: A.membershipId }, { bookingId: session.id, targetResourceId: A.tables[2] }),
      ),
    )
    check(
      'transferring into an occupied table is refused (idx_bookings_open_table_session)',
      !occupied.ok && occupied.code === '23505' && occupied.constraint === 'idx_bookings_open_table_session',
    )
    check('…and the session stayed put', (await bookingRow(session.id))?.resource_id === A.tables[1])

    // guard: transfer once billed
    await withUser(A.userId, (tx) => issueInvoiceForBooking(tx, { id: A.tenantId, timezone: TZ }, { bookingId: session.id }))
    const billed = await attempt(() =>
      withUser(A.userId, (tx) =>
        transferTableCore(tx, { tenantId: A.tenantId, membershipId: A.membershipId }, { bookingId: session.id, targetResourceId: A.tables[3] }),
      ),
    )
    check('transferring an already-billed session is refused', !billed.ok && billed.bookingError)

    await withUser(A.userId, (tx) => tx.update(schema.bookings).set({ status: 'completed' }).where(eq(schema.bookings.id, other.id)))
    await withUser(A.userId, (tx) => tx.update(schema.bookings).set({ status: 'completed' }).where(eq(schema.bookings.id, session.id)))
  }

  // ── 2. merge ───────────────────────────────────────────────────────────────
  {
    const survivor = await seat(A, A.tables[2], 2)
    const loser = await seat(A, A.tables[3], 3)
    const keptOrder = await order(A, survivor.id)
    const movingOrder1 = await order(A, loser.id)
    const movingOrder2 = await order(A, loser.id)

    const r = await attempt(() =>
      withUser(A.userId, (tx) =>
        mergeTablesCore(tx, { tenantId: A.tenantId, membershipId: A.membershipId }, { intoBookingId: survivor.id, fromBookingId: loser.id }),
      ),
    )
    check('merge succeeds', r.ok && r.value.movedOrderCount === 2)

    check('both moved orders now belong to the survivor', (await orderBookingId(movingOrder1.id)).booking_id === survivor.id && (await orderBookingId(movingOrder2.id)).booking_id === survivor.id)
    check("the survivor's own order is untouched", (await orderBookingId(keptOrder.id)).booking_id === survivor.id)

    const survivorRow = await bookingRow(survivor.id)
    check('cover counts summed (2 + 3 = 5)', survivorRow?.cover_count === 5)

    const loserRow = await bookingRow(loser.id)
    check('the loser closed out (completed) and its table is free', loserRow?.status === 'completed')

    const seatAgain = await seat(A, A.tables[3], 1)
    check('the freed table can be seated again', Boolean(seatAgain.id))
    await withUser(A.userId, (tx) => tx.update(schema.bookings).set({ status: 'completed' }).where(eq(schema.bookings.id, seatAgain.id)))

    check('merge wrote an audit row on the survivor', (await auditRows(survivor.id)).some((a) => a.action === 'merge_tables_into'))
    check('merge wrote an audit row on the loser', (await auditRows(loser.id)).some((a) => a.action === 'merge_tables_from'))

    // guard: merging a booking into itself
    const selfMerge = await attempt(() =>
      withUser(A.userId, (tx) =>
        mergeTablesCore(tx, { tenantId: A.tenantId, membershipId: A.membershipId }, { intoBookingId: survivor.id, fromBookingId: survivor.id }),
      ),
    )
    check('merging a table into itself is refused', !selfMerge.ok && selfMerge.bookingError)

    // guard: the loser is no longer an open session (already merged away)
    const staleMerge = await attempt(() =>
      withUser(A.userId, (tx) =>
        mergeTablesCore(tx, { tenantId: A.tenantId, membershipId: A.membershipId }, { intoBookingId: survivor.id, fromBookingId: loser.id }),
      ),
    )
    check('merging an already-closed session is refused', !staleMerge.ok && staleMerge.bookingError)

    await withUser(A.userId, (tx) => tx.update(schema.bookings).set({ status: 'completed' }).where(eq(schema.bookings.id, survivor.id)))
  }

  // ── 3. split ───────────────────────────────────────────────────────────────
  {
    const source = await seat(A, A.tables[0], 5)
    const staysOrder = await order(A, source.id)
    const movesOrder = await order(A, source.id)

    const r = await attempt(() =>
      withUser(A.userId, (tx) =>
        splitTableCore(
          tx,
          { tenantId: A.tenantId, timezone: TZ, membershipId: A.membershipId },
          { sourceBookingId: source.id, targetResourceId: A.tables[1], orderIds: [movesOrder.id], coverCount: 2 },
        ),
      ),
    )
    check('split succeeds and returns the new booking', r.ok && Boolean(r.value.id) && r.value.movedOrderCount === 1)
    if (!r.ok) throw new Error('split failed, aborting split assertions')
    const newBookingId = r.value.id

    const newRow = await bookingRow(newBookingId)
    check('new session seated on the target table with the split-off cover count', newRow?.resource_id === A.tables[1] && newRow?.cover_count === 2)

    const sourceRow = await bookingRow(source.id)
    check('source cover count decremented (5 - 2 = 3)', sourceRow?.cover_count === 3)

    check('the moved order now belongs to the new session', (await orderBookingId(movesOrder.id)).booking_id === newBookingId)
    check('the other order stayed on the source', (await orderBookingId(staysOrder.id)).booking_id === source.id)

    check('split wrote an audit row on the source', (await auditRows(source.id)).some((a) => a.action === 'split_table_from'))
    check('split wrote an audit row on the new session', (await auditRows(newBookingId)).some((a) => a.action === 'split_table_into'))

    // guard: taking the whole party's covers
    const wholeParty = await attempt(() =>
      withUser(A.userId, (tx) =>
        splitTableCore(
          tx,
          { tenantId: A.tenantId, timezone: TZ, membershipId: A.membershipId },
          { sourceBookingId: source.id, targetResourceId: A.tables[2], orderIds: [], coverCount: 3 },
        ),
      ),
    )
    check("splitting off the whole party's covers is refused", !wholeParty.ok && wholeParty.bookingError)

    // guard: an order that is no longer open
    await withUser(A.userId, (tx) => tx.update(schema.orders).set({ status: 'cancelled' }).where(eq(schema.orders.id, staysOrder.id)))
    const staleOrder = await attempt(() =>
      withUser(A.userId, (tx) =>
        splitTableCore(
          tx,
          { tenantId: A.tenantId, timezone: TZ, membershipId: A.membershipId },
          { sourceBookingId: source.id, targetResourceId: A.tables[2], orderIds: [staysOrder.id], coverCount: 1 },
        ),
      ),
    )
    check('splitting a no-longer-open order is refused', !staleOrder.ok && staleOrder.bookingError)

    // guard: a table with fewer than 2 guests has no valid split at all —
    // there'd be no one left to move.
    const lonelyGuest = await seat(A, A.tables[2], 1)
    const notEnoughGuests = await attempt(() =>
      withUser(A.userId, (tx) =>
        splitTableCore(
          tx,
          { tenantId: A.tenantId, timezone: TZ, membershipId: A.membershipId },
          { sourceBookingId: lonelyGuest.id, targetResourceId: A.tables[3], orderIds: [], coverCount: 1 },
        ),
      ),
    )
    check('splitting a table with fewer than 2 guests is refused', !notEnoughGuests.ok && notEnoughGuests.bookingError)
    await withUser(A.userId, (tx) => tx.update(schema.bookings).set({ status: 'completed' }).where(eq(schema.bookings.id, lonelyGuest.id)))

    await withUser(A.userId, (tx) => tx.update(schema.bookings).set({ status: 'completed' }).where(eq(schema.bookings.id, source.id)))
    await withUser(A.userId, (tx) => tx.update(schema.bookings).set({ status: 'completed' }).where(eq(schema.bookings.id, newBookingId)))
  }

  // ── 4. tenant isolation ───────────────────────────────────────────────────
  {
    const aSession = await seat(A, A.tables[0], 2)
    const bSession = await seat(B, B.tables[0], 2)

    const crossTransfer = await attempt(() =>
      withUser(B.userId, (tx) =>
        transferTableCore(tx, { tenantId: B.tenantId, membershipId: B.membershipId }, { bookingId: aSession.id, targetResourceId: B.tables[1] }),
      ),
    )
    check("tenant B cannot transfer tenant A's session (RLS ⇒ not found)", !crossTransfer.ok && crossTransfer.bookingError && /not found/i.test(crossTransfer.message))

    const crossMerge = await attempt(() =>
      withUser(B.userId, (tx) =>
        mergeTablesCore(tx, { tenantId: B.tenantId, membershipId: B.membershipId }, { intoBookingId: bSession.id, fromBookingId: aSession.id }),
      ),
    )
    check("tenant B cannot merge in tenant A's session (RLS ⇒ not found)", !crossMerge.ok && crossMerge.bookingError && /not found/i.test(crossMerge.message))

    await withUser(A.userId, (tx) => tx.update(schema.bookings).set({ status: 'completed' }).where(eq(schema.bookings.id, aSession.id)))
    await withUser(B.userId, (tx) => tx.update(schema.bookings).set({ status: 'completed' }).where(eq(schema.bookings.id, bSession.id)))
  }

  // ── cleanup ───────────────────────────────────────────────────────────────
  await ownerPool.query('delete from tenants where id = any($1)', [[A.tenantId, B.tenantId]])
  await ownerPool.query(`delete from users where email like '%@testtabxfer-%.test'`)
  await ownerPool.end()
  await appPool.end()

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
