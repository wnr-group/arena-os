/**
 * Kitchen dashboard integration tests against a real database.
 *
 * Drives the same code the /kitchen screen drives — createOrderCore to seed
 * tickets, updateKotStatusCore for the status buttons — on an RLS-scoped
 * transaction through `arena_app`:
 *   - the legal flow: pending → preparing → ready → served
 *   - illegal jumps are rejected (pending → ready, served → pending, …)
 *   - cancelled is reachable from any active state
 *   - nothing is legal out of a terminal state (served, cancelled)
 *   - another tenant's ticket is invisible and cannot be updated (RLS)
 *   - only kitchen_staff/manager/owner may advance a ticket (RLS policy,
 *     mirrored by canManageKitchen — see lib/actions/kots.ts)
 *   - the active-tickets query (what the /kitchen screen reads — same shape
 *     as lib/kots/data.ts:listActiveKots, reproduced here because that file
 *     imports 'server-only' and cannot load outside Next.js, exactly like
 *     every other lib/*\/data.ts reader in this codebase) shows only active
 *     tickets, with their items, scoped to tenant + branch
 *
 *   npx tsx scripts/test-kitchen.ts
 */
import { Pool } from 'pg'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { and, asc, eq, notInArray, sql } from 'drizzle-orm'
import * as schema from '../db/schema'
import { createOrderCore } from '../lib/orders/service'
import { KotError, KOT_TRANSITIONS, updateKotStatusCore, type KotStatus } from '../lib/kots/service'
import { canManageKitchen } from '../lib/auth/roles'
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

  async function makeTenant(slug: string) {
    const t = await ownerPool.query<{ id: string }>(
      `insert into tenants (slug,name,status,timezone) values ($1,$2,'active',$3)
       on conflict (slug) do update set name=excluded.name returning id`,
      [slug, `${slug} co`, TZ],
    )
    const tenantId = t.rows[0].id
    const b = await ownerPool.query<{ id: string }>(
      `insert into branches (tenant_id,name,is_primary) values ($1,'Main',true)
       on conflict (tenant_id,name) do update set is_primary=true returning id`,
      [tenantId],
    )
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
    // menu_items has no unique constraint to target with ON CONFLICT, so a
    // rerun after a crash leaves orphaned rows behind — harmless: each
    // successful run's final cleanup deletes the tenant, cascading these away.
    const item = await ownerPool.query<{ id: string }>(
      `insert into menu_items (tenant_id,category_id,name,price) values ($1,$2,'Fries','80.00') returning id`,
      [tenantId, cat.rows[0].id],
    )
    return {
      tenantId,
      branchId: b.rows[0].id,
      userId: u.rows[0].id,
      membershipId: m.rows[0].id,
      itemId: item.rows[0].id,
    }
  }

  async function makeKot(t: { tenantId: string; branchId: string; userId: string; membershipId: string; itemId: string }) {
    const order = await withUser(t.userId, (tx) =>
      createOrderCore(
        tx,
        { tenantId: t.tenantId, timezone: TZ, membershipId: t.membershipId },
        { branchId: t.branchId, items: [{ menuItemId: t.itemId, qty: 1 }] },
      ),
    )
    const { rows } = await ownerPool.query<{ id: string }>('select id from kots where order_id=$1', [order.id])
    return { kotId: rows[0].id, orderId: order.id }
  }

  async function advance(t: { tenantId: string; userId: string }, kotId: string, status: KotStatus) {
    try {
      await withUser(t.userId, (tx) => updateKotStatusCore(tx, { tenantId: t.tenantId }, kotId, status))
      return { ok: true as const }
    } catch (e) {
      return { ok: false as const, kot: e instanceof KotError, message: e instanceof Error ? e.message : String(e) }
    }
  }

  async function statusOf(kotId: string) {
    return (await ownerPool.query('select status from kots where id=$1', [kotId])).rows[0].status
  }

  /** Same query as lib/kots/data.ts:listActiveKots, run through the RLS-scoped app connection. */
  async function listActive(t: { tenantId: string; userId: string }, branchId: string) {
    return withUser(t.userId, (tx) =>
      tx
        .select({
          kotId: schema.kots.id,
          kotNumber: schema.kots.kotNumber,
          status: schema.kots.status,
          createdAt: schema.kots.createdAt,
          orderId: schema.orders.id,
          orderNumber: schema.orders.orderNumber,
          itemId: schema.orderItems.id,
          itemName: schema.orderItems.itemName,
          qty: schema.orderItems.qty,
          specialInstructions: schema.orderItems.specialInstructions,
        })
        .from(schema.kots)
        .innerJoin(schema.orders, eq(schema.orders.id, schema.kots.orderId))
        .leftJoin(schema.orderItems, eq(schema.orderItems.orderId, schema.orders.id))
        .where(
          and(
            eq(schema.kots.tenantId, t.tenantId),
            eq(schema.kots.branchId, branchId),
            notInArray(schema.kots.status, ['served', 'cancelled']),
          ),
        )
        .orderBy(asc(schema.kots.createdAt), asc(schema.orderItems.id)),
    )
  }

  const A = await makeTenant('testkitchena')
  const B = await makeTenant('testkitchenb')

  const bothTenants = [[A.tenantId, B.tenantId]]
  await ownerPool.query('delete from kots where tenant_id = any($1)', bothTenants)
  await ownerPool.query('delete from order_items where tenant_id = any($1)', bothTenants)
  await ownerPool.query('delete from orders where tenant_id = any($1)', bothTenants)

  // ── 0. pure helpers ────────────────────────────────────────────────────────
  check(
    'canManageKitchen: kitchen staff and up, not floor/cashier/reception',
    canManageKitchen('owner') &&
      canManageKitchen('manager') &&
      canManageKitchen('kitchen_staff') &&
      !canManageKitchen('cashier') &&
      !canManageKitchen('floor_staff') &&
      !canManageKitchen('receptionist'),
  )
  check(
    'KOT_TRANSITIONS: served and cancelled are terminal — nothing is legal out of them',
    KOT_TRANSITIONS.served.length === 0 && KOT_TRANSITIONS.cancelled.length === 0,
  )
  check(
    'KOT_TRANSITIONS: cancelled is reachable from every active state',
    KOT_TRANSITIONS.pending.includes('cancelled') &&
      KOT_TRANSITIONS.preparing.includes('cancelled') &&
      KOT_TRANSITIONS.ready.includes('cancelled'),
  )

  // ── 1. the legal flow ──────────────────────────────────────────────────────
  const t1 = await makeKot(A)
  check("a fresh ticket starts 'pending'", (await statusOf(t1.kotId)) === 'pending')

  const s1 = await advance(A, t1.kotId, 'preparing')
  check('pending → preparing succeeds', s1.ok && (await statusOf(t1.kotId)) === 'preparing')

  const s2 = await advance(A, t1.kotId, 'ready')
  check('preparing → ready succeeds', s2.ok && (await statusOf(t1.kotId)) === 'ready')

  const s3 = await advance(A, t1.kotId, 'served')
  check('ready → served succeeds', s3.ok && (await statusOf(t1.kotId)) === 'served')

  // ── 2. illegal jumps are rejected ─────────────────────────────────────────
  const badJump = await advance(A, t1.kotId, 'pending')
  check('served → pending is REFUSED', !badJump.ok && badJump.kot && /cannot move/i.test(badJump.message))
  check('…and the ticket is still served, untouched', (await statusOf(t1.kotId)) === 'served')

  const t2 = await makeKot(A)
  const skip = await advance(A, t2.kotId, 'ready')
  check('pending → ready (skipping preparing) is REFUSED', !skip.ok && skip.kot)
  check('…still pending', (await statusOf(t2.kotId)) === 'pending')

  const t3 = await makeKot(A)
  await advance(A, t3.kotId, 'preparing')
  const backwards = await advance(A, t3.kotId, 'pending')
  check('preparing → pending is REFUSED', !backwards.ok && backwards.kot)

  // ── 3. cancelled is reachable from any active state ───────────────────────
  const t4 = await makeKot(A) // pending
  const c4 = await advance(A, t4.kotId, 'cancelled')
  check('pending → cancelled succeeds', c4.ok && (await statusOf(t4.kotId)) === 'cancelled')

  const t5 = await makeKot(A)
  await advance(A, t5.kotId, 'preparing')
  const c5 = await advance(A, t5.kotId, 'cancelled')
  check('preparing → cancelled succeeds', c5.ok && (await statusOf(t5.kotId)) === 'cancelled')

  const t6 = await makeKot(A)
  await advance(A, t6.kotId, 'preparing')
  await advance(A, t6.kotId, 'ready')
  const c6 = await advance(A, t6.kotId, 'cancelled')
  check('ready → cancelled succeeds', c6.ok && (await statusOf(t6.kotId)) === 'cancelled')

  // ── 4. nothing is legal out of cancelled ──────────────────────────────────
  const afterCancel = await advance(A, t4.kotId, 'preparing')
  check('cancelled → preparing is REFUSED — cancelled is terminal', !afterCancel.ok && afterCancel.kot)

  // ── 5. unknown ticket ──────────────────────────────────────────────────────
  const missing = await advance(A, '00000000-0000-0000-0000-000000000000', 'preparing')
  check('advancing a nonexistent ticket is refused', !missing.ok && missing.kot && /not found/i.test(missing.message))

  // ── 6. tenant isolation ───────────────────────────────────────────────────
  const aTicket = await makeKot(A)
  const cross = await advance(B, aTicket.kotId, 'preparing')
  check("tenant B cannot advance tenant A's ticket (RLS ⇒ not found)", !cross.ok && cross.kot && /not found/i.test(cross.message))
  check('…and it is untouched', (await statusOf(aTicket.kotId)) === 'pending')

  // ── 7. the active-tickets query: what the screen actually shows ──────────
  {
    const active = await makeKot(A) // pending
    const preparing = await makeKot(A)
    await advance(A, preparing.kotId, 'preparing')
    const servedTicket = await makeKot(A)
    await advance(A, servedTicket.kotId, 'preparing')
    await advance(A, servedTicket.kotId, 'ready')
    await advance(A, servedTicket.kotId, 'served')
    const cancelledTicket = await makeKot(A)
    await advance(A, cancelledTicket.kotId, 'cancelled')
    const bTicket = await makeKot(B)

    const rows = await listActive(A, A.branchId)
    const kotIds = new Set(rows.map((r) => r.kotId))
    check('pending and preparing tickets are in the active list', kotIds.has(active.kotId) && kotIds.has(preparing.kotId))
    check('a served ticket has left the queue', !kotIds.has(servedTicket.kotId))
    check('a cancelled ticket has left the queue', !kotIds.has(cancelledTicket.kotId))
    check("another tenant's ticket never appears (RLS)", !kotIds.has(bTicket.kotId))

    const activeRow = rows.find((r) => r.kotId === active.kotId)
    check('each row carries its order item (name + qty)', activeRow?.itemName === 'Fries' && activeRow?.qty === 1)
  }

  // ── cleanup ───────────────────────────────────────────────────────────────
  await ownerPool.query('delete from tenants where id = any($1)', [[A.tenantId, B.tenantId]])
  await ownerPool.query(`delete from users where email like '%@testkitchen%.test'`)
  await ownerPool.end()
  await appPool.end()

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
