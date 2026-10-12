/**
 * Migration 0120 - addon_reserved_units() fails CLOSED. Before it, a caller who
 * was neither a tenant member nor on a public tenant got NOT (NULL OR false) =
 * NULL, which plpgsql reads as false, so the guard never fired and a real count
 * came back for any tenant id.
 *
 * Calls the function on a real arena_app connection (rolled-back transactions,
 * GUCs set by hand), then proves the owner-connection fallback that the webhook's
 * late-payment stock re-check relies on still counts real reservations.
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs --import ./scripts/next-runtime-hook.mjs scripts/test-addon-reserved-units-guard.ts
 */
import { randomBytes } from 'node:crypto'
import { Pool } from 'pg'
import { loadEnv } from './env'

loadEnv()
let pass = 0
let fail = 0
const check = (label: string, cond: boolean, got?: unknown) => {
  console.log(`${cond ? '✓' : '✗ FAIL'}  ${label}${cond ? '' : `  (got: ${JSON.stringify(got)})`}`)
  if (cond) pass++
  else fail++
}

async function main() {
  const { ownerDb } = await import('../db')
  const { reservedAddonUnits } = await import('../lib/booking/addons')
  const { handleLatePayment, HOLD_RELEASE_REASON } = await import('../lib/booking/payment-hold')
  const owner = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })
  const app = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 })
  const q = <T extends object>(text: string, params: unknown[] = []) => owner.query<T>(text, params)
  const tag = randomBytes(3).toString('hex')

  const start = new Date(Date.now() + 9 * 86_400_000)
  const end = new Date(start.getTime() + 3_600_000)

  async function seedTenant(label: string) {
    const tenantId = (await q<{ id: string }>(`insert into tenants (slug,name,status,timezone,industry) values ($1,$2,'active','Asia/Kolkata','recording_studio') returning id`, [`addon-guard-${label}-${tag}`, `Guard ${label}`])).rows[0].id
    const branchId = (await q<{ id: string }>(`insert into branches (tenant_id,name,is_primary) values ($1,'Main',true) returning id`, [tenantId])).rows[0].id
    const typeId = (await q<{ id: string }>(`insert into resource_types (tenant_id,name,hourly_rate) values ($1,'Studio','500.00') returning id`, [tenantId])).rows[0].id
    const resA = (await q<{ id: string }>(`insert into resources (tenant_id,branch_id,resource_type_id,name) values ($1,$2,$3,'Set A') returning id`, [tenantId, branchId, typeId])).rows[0].id
    const resB = (await q<{ id: string }>(`insert into resources (tenant_id,branch_id,resource_type_id,name) values ($1,$2,$3,'Set B') returning id`, [tenantId, branchId, typeId])).rows[0].id
    const addonId = (await q<{ id: string }>(`insert into resource_type_addons (tenant_id,branch_id,resource_type_id,name,rate,rate_unit,stock_quantity,is_active) values ($1,$2,$3,'Cam','100.00','hour',1,true) returning id`, [tenantId, branchId, typeId])).rows[0].id
    const userId = (await q<{ id: string }>(`insert into users (email,password_hash,full_name) values ($1,'x','Owner') returning id`, [`guard-${label}-${tag}@example.test`])).rows[0].id
    await q(`insert into memberships (tenant_id,user_id,branch_id,role,status,full_name) values ($1,$2,$3,'owner','active','Owner')`, [tenantId, userId, branchId])
    return { tenantId, branchId, resA, resB, addonId, userId }
  }
  const A = await seedTenant('a')
  const B = await seedTenant('b')

  /** A booking holding `qty` of the tenant's add-on over [start, end). */
  async function holdAddon(t: typeof A, resourceId: string, status: string, qty: number, n: string) {
    const b = (await q<{ id: string }>(`insert into bookings (tenant_id,branch_id,booking_number,status,source,subtotal,total) values ($1,$2,$3,'confirmed','online',1,1) returning id`, [t.tenantId, t.branchId, `BK-G-${n}-${tag}`])).rows[0].id
    const s = (await q<{ id: string }>(`insert into booking_slots (tenant_id,booking_id,resource_id,starts_at,ends_at,resource_name,resource_type_name) values ($1,$2,$3,$4,$5,'Set','Studio') returning id`, [t.tenantId, b, resourceId, start, end])).rows[0].id
    await q(`insert into booking_addons (tenant_id,branch_id,booking_id,booking_slot_id,addon_id,addon_name,rate_unit,rate_applied,quantity,line_total,starts_at,ends_at) values ($1,$2,$3,$4,$5,'Cam','hour',100,$6,100,$7,$8)`, [t.tenantId, t.branchId, b, s, t.addonId, qty, start, end])
    if (status !== 'confirmed') {
      await q(`update bookings set status=$2, cancelled_at=now(), cancellation_reason=$3 where id=$1`, [b, status, HOLD_RELEASE_REASON])
    }
    return b
  }

  /** Run addon_reserved_units as arena_app in a rolled-back txn with the given GUCs. */
  async function callAs(gucs: Record<string, string>, tenantId: string | null, addonId: string) {
    const c = await app.connect()
    try {
      await c.query('begin')
      for (const [k, v] of Object.entries(gucs)) await c.query(`select set_config($1, $2, true)`, [k, v])
      const r = await c.query<{ r: number | null }>(
        `select public.addon_reserved_units($1::uuid,$2::uuid,$3::timestamptz,$4::timestamptz,null) as r`,
        [tenantId, addonId, start.toISOString(), end.toISOString()],
      )
      return r.rows[0].r
    } finally {
      await c.query('rollback')
      c.release()
    }
  }

  // A has one confirmed booking holding the only unit; B holds one too.
  await holdAddon(A, A.resA, 'confirmed', 1, 'a1')
  await holdAddon(B, B.resA, 'confirmed', 1, 'b1')

  console.log('\n── arena_app, no membership, no public tenant ──')
  check('foreign tenant id, no app.user_id and no app.public_tenant_id => NULL', (await callAs({}, A.tenantId, A.addonId)) === null)

  console.log('\n── public tenant GUC ──')
  check('public GUC = A, asking for B => NULL', (await callAs({ 'app.public_tenant_id': A.tenantId }, B.tenantId, B.addonId)) === null)
  check('public GUC = A, asking for A => the real count (1)', (await callAs({ 'app.public_tenant_id': A.tenantId }, A.tenantId, A.addonId)) === 1)

  console.log('\n── member of tenant A ──')
  check('member of A, asking for A => the real count (1)', (await callAs({ 'app.user_id': A.userId }, A.tenantId, A.addonId)) === 1)
  check('member of A, asking for B => NULL', (await callAs({ 'app.user_id': A.userId }, B.tenantId, B.addonId)) === null)

  console.log('\n── NULL tenant ──')
  check('NULL tenant id => NULL (even for a member)', (await callAs({ 'app.user_id': A.userId }, null, A.addonId)) === null)
  check('NULL tenant id with a public GUC => NULL', (await callAs({ 'app.public_tenant_id': A.tenantId }, null, A.addonId)) === null)

  console.log('\n── owner connection: the NULL contract falls back to a real count ──')
  const counted = await ownerDb.transaction((tx) => reservedAddonUnits(tx, A.tenantId, A.addonId, start, end))
  check('reservedAddonUnits on the owner connection counts the booking via the plain-sum fallback (1)', counted === 1, counted)
  const none = await ownerDb.transaction((tx) => reservedAddonUnits(tx, A.tenantId, A.addonId, new Date(end.getTime() + 86_400_000), new Date(end.getTime() + 90_000_000)))
  check('…and counts 0 for a window with no reservation', none === 0, none)

  // Late payment: a released hold wanting the last unit while another booking holds it.
  const lost = await holdAddon(A, A.resB, 'cancelled', 1, 'a-lost')
  const refused = await ownerDb.transaction((tx) => handleLatePayment(tx, { id: lost, tenantId: A.tenantId, cancellationReason: HOLD_RELEASE_REASON }, '100.00'))
  const lostRow = (await q<{ status: string; r: boolean }>(`select status, deposit_review_required r from bookings where id=$1`, [lost])).rows[0]
  check('late payment while another booking holds the last unit => NOT reinstated, flagged for refund', refused === 'paid_after_release' && lostRow.status === 'cancelled' && lostRow.r === true, { refused, lostRow })

  // Tenant B: free its unit first (cancel the holder), then the same reinstate works.
  await q(`update bookings set status='cancelled', cancelled_at=now() where tenant_id=$1 and booking_number like 'BK-G-b1-%'`, [B.tenantId])
  const won = await holdAddon(B, B.resB, 'cancelled', 1, 'b-won')
  const ok = await ownerDb.transaction((tx) => handleLatePayment(tx, { id: won, tenantId: B.tenantId, cancellationReason: HOLD_RELEASE_REASON }, '100.00'))
  const wonRow = (await q<{ status: string }>(`select status from bookings where id=$1`, [won])).rows[0]
  check('late payment with the unit free => reinstated as confirmed', ok === 'reinstated' && wonRow.status === 'confirmed', { ok, wonRow })

  await q('delete from tenants where id = any($1)', [[A.tenantId, B.tenantId]])
  await q('delete from users where id = any($1)', [[A.userId, B.userId]])
  await owner.end()
  await app.end()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
