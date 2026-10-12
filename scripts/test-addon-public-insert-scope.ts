/**
 * Migration 0118 - the anonymous role may attach add-ons only to a booking it
 * created in the SAME transaction. Real public connection (arena_app, pinned
 * to the tenant); the owner pool only seeds.
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs scripts/test-addon-public-insert-scope.ts
 */
import { randomBytes } from 'node:crypto'
import { Pool } from 'pg'
import { sql } from 'drizzle-orm'
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
  const { withPublicTenant } = await import('../db')
  const owner = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })
  const q = <T extends object>(text: string, params: unknown[] = []) => owner.query<T>(text, params)
  const tag = randomBytes(3).toString('hex')
  const tenantId = (await q<{ id: string }>(`insert into tenants (slug,name,status,timezone,industry) values ($1,'Scope QA','active','Asia/Kolkata','recording_studio') returning id`, [`addon-scope-${tag}`])).rows[0].id
  const branchId = (await q<{ id: string }>(`insert into branches (tenant_id,name,is_primary) values ($1,'Main',true) returning id`, [tenantId])).rows[0].id
  const typeId = (await q<{ id: string }>(`insert into resource_types (tenant_id,name,hourly_rate) values ($1,'Studio','500.00') returning id`, [tenantId])).rows[0].id
  const resourceId = (await q<{ id: string }>(`insert into resources (tenant_id,branch_id,resource_type_id,name) values ($1,$2,$3,'Set A') returning id`, [tenantId, branchId, typeId])).rows[0].id
  const addonId = (await q<{ id: string }>(`insert into resource_type_addons (tenant_id,branch_id,resource_type_id,name,rate,rate_unit,stock_quantity,is_active) values ($1,$2,$3,'Cam','100.00','hour',5,true) returning id`, [tenantId, branchId, typeId])).rows[0].id
  const existing = (await q<{ id: string }>(`insert into bookings (tenant_id,branch_id,booking_number,status,source,subtotal,total) values ($1,$2,$3,'confirmed','online',1,1) returning id`, [tenantId, branchId, `BK-SC-${tag}`])).rows[0].id
  const start = new Date(Date.now() + 5 * 86_400_000)
  const end = new Date(start.getTime() + 3_600_000)
  const slotOf = async (bookingId: string, res: string) =>
    (await q<{ id: string }>(`insert into booking_slots (tenant_id,booking_id,resource_id,starts_at,ends_at,resource_name,resource_type_name) values ($1,$2,$3,$4,$5,'Set A','Studio') returning id`, [tenantId, bookingId, res, start, end])).rows[0].id
  const existingSlot = await slotOf(existing, resourceId)

  const insertAddon = (bookingId: string, slotId: string) =>
    sql`insert into booking_addons (tenant_id,branch_id,booking_id,booking_slot_id,addon_id,addon_name,rate_unit,rate_applied,quantity,line_total,starts_at,ends_at)
        values (${tenantId},${branchId},${bookingId},${slotId},${addonId},'Cam','hour',100,1,100,${start.toISOString()},${end.toISOString()})`

  // 1. an EXISTING online booking of the tenant: refused
  const code = await withPublicTenant(tenantId, async (tx) => {
    try {
      await tx.execute(insertAddon(existing, existingSlot))
      return 'inserted'
    } catch (e) {
      let cur: unknown = e
      for (let d = 0; d < 5 && cur && typeof cur === 'object'; d++) {
        const o = cur as { code?: string; cause?: unknown }
        if (o.code) return o.code
        cur = o.cause
      }
      return 'error'
    }
  })
  check('anonymous insert onto a booking created in an EARLIER transaction is refused (42501)', code === '42501', code)

  // 2. a booking created in the same transaction: allowed
  const ok = await withPublicTenant(tenantId, async (tx) => {
    const b = await tx.execute(sql`insert into bookings (tenant_id,branch_id,booking_number,status,source,subtotal,total) values (${tenantId},${branchId},${'BK-SC2-' + tag},'confirmed','online',1,1) returning id`)
    const bid = (b.rows[0] as { id: string }).id
    const s = await tx.execute(sql`insert into booking_slots (tenant_id,booking_id,resource_id,starts_at,ends_at,resource_name,resource_type_name) values (${tenantId},${bid},${resourceId},${new Date(start.getTime() + 86_400_000).toISOString()},${new Date(end.getTime() + 86_400_000).toISOString()},'Set A','Studio') returning id`)
    await tx.execute(insertAddon(bid, (s.rows[0] as { id: string }).id))
    return true
  }).catch((e) => String(e))
  check('…but attaching add-ons to the booking it just created in the same transaction works', ok === true, ok)

  const rows = Number((await q<{ n: string }>(`select count(*) n from booking_addons where booking_id=$1`, [existing])).rows[0].n)
  check('…and the earlier booking gained no add-on rows', rows === 0, rows)

  await q('delete from tenants where id=$1', [tenantId])
  await owner.end()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
