/**
 * M33 #6 — the post-creation "Edit add-ons" correction tool (needs migration
 * 0108): setSlotAddonsCore / the setBookingSlotAddons action.
 *
 *   add / remove / qty   all work on an unbilled booking; booking totals follow
 *   delta stock          raising qty needs only the DELTA free; lowering always
 *                        succeeds, even for a since-deactivated add-on
 *   live window          the check runs against the slot's CURRENT end — a
 *                        booking extended after creation holds stock for the
 *                        longer window, and an edit sees that
 *   billed               refused once a live invoice exists; allowed again after
 *   history              a line whose catalog entry was deleted (addon_id NULL)
 *                        is never dropped by an edit
 *   audit                booking.addon_edited, attributed, one entry per real
 *                        change with the add-on name and qty delta; a no-op
 *                        edit writes nothing
 *   role                 the action refuses a role outside canManageWalkins
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs --import ./scripts/next-runtime-hook.mjs scripts/test-addon-edit-tool.ts
 */
import { Pool } from 'pg'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { sql } from 'drizzle-orm'
import * as schema from '../db/schema'
import { createBookingCore, BookingError } from '../lib/booking/service'
import { setSlotAddonsCore } from '../lib/booking/addons'
import { issueInvoiceForBooking } from '../lib/billing/invoice'
import { canManageWalkins } from '../lib/auth/roles'
import { loadEnv } from './env'

type Db = NodePgDatabase<typeof schema>

let pass = 0,
  fail = 0
const check = (l: string, c: boolean) => {
  console.log(`${c ? '✓' : '✗ FAIL'}  ${l}`)
  if (c) pass++
  else fail++
}
async function expectReject(l: string, fn: () => Promise<unknown>, includes?: string) {
  try {
    await fn()
    check(l, false)
  } catch (e) {
    const ok = e instanceof BookingError && (!includes || e.message.includes(includes))
    check(l, ok)
    if (!ok) console.log('   (unexpected)', e)
  }
}

const TZ = 'Asia/Kolkata'
const HOUR = 3_600_000
const at = (days: number, hour: number) => {
  const d = new Date(Date.now() + days * 24 * HOUR)
  d.setUTCMinutes(0, 0, 0)
  d.setUTCHours(hour)
  return d
}

async function main() {
  loadEnv()
  const ownerPool = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })
  const appPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 })
  const app = drizzle(appPool, { schema })
  const withUser = <T>(userId: string, fn: (tx: Db) => Promise<T>): Promise<T> =>
    app.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`)
      return fn(tx as unknown as Db)
    })
  const q = <T extends object>(text: string, params: unknown[] = []) => ownerPool.query<T>(text, params)

  const slug = 'testaddonedit'
  await q(`delete from tenants where slug=$1`, [slug])
  const tenantId = (
    await q<{ id: string }>(
      `insert into tenants (slug,name,status,timezone,industry) values ($1,$2,'active',$3,'gaming_cafe') returning id`,
      [slug, `${slug} co`, TZ],
    )
  ).rows[0].id
  const branchId = (
    await q<{ id: string }>(`insert into branches (tenant_id,name,is_primary) values ($1,'Main',true) returning id`, [tenantId])
  ).rows[0].id
  const userId = (
    await q<{ id: string }>(
      `insert into users (email,password_hash) values ($1,'x') on conflict (email) do update set email=excluded.email returning id`,
      [`owner@${slug}.test`],
    )
  ).rows[0].id
  const membershipId = (
    await q<{ id: string }>(`insert into memberships (tenant_id,user_id,role,status) values ($1,$2,'owner','active') returning id`, [tenantId, userId])
  ).rows[0].id
  await q(`insert into business_profiles (tenant_id) values ($1) on conflict (tenant_id) do nothing`, [tenantId])
  const typeId = (
    await q<{ id: string }>(`insert into resource_types (tenant_id,name,hourly_rate) values ($1,'Studio','100.00') returning id`, [tenantId])
  ).rows[0].id
  const mkResource = async (name: string) =>
    (
      await q<{ id: string }>(
        `insert into resources (tenant_id,branch_id,resource_type_id,name,status) values ($1,$2,$3,$4,'available') returning id`,
        [tenantId, branchId, typeId, name],
      )
    ).rows[0].id
  const mkAddon = async (name: string, stock: number) =>
    (
      await q<{ id: string }>(
        `insert into resource_type_addons (tenant_id,branch_id,resource_type_id,name,rate,rate_unit,stock_quantity)
         values ($1,$2,$3,$4,'100.00','hour',$5) returning id`,
        [tenantId, branchId, typeId, name, stock],
      )
    ).rows[0].id

  const ctx = { tenantId, timezone: TZ, membershipId }
  const r1 = await mkResource('Set 1')
  const r2 = await mkResource('Set 2')
  const camera = await mkAddon('Camera', 3)
  const lens = await mkAddon('Lens', 5)

  const create = async (resourceId: string, start: Date, hours: number) =>
    withUser(userId, (tx) =>
      createBookingCore(tx, ctx, {
        branchId,
        customerName: 'T',
        customerPhone: '9876543210',
        source: 'staff',
        discount: 0,
        deposit: 0,
        slots: [{ resourceId, startsAt: start.toISOString(), endsAt: new Date(+start + hours * HOUR).toISOString() }],
      }),
    )
  const slotOf = async (bookingId: string) => (await q<{ id: string }>(`select id from booking_slots where booking_id=$1`, [bookingId])).rows[0].id
  const edit = (bookingId: string, slotId: string, addons: { addonId: string; quantity: number }[], membership = membershipId) =>
    withUser(userId, (tx) => setSlotAddonsCore(tx, { tenantId, membershipId: membership }, { bookingId, bookingSlotId: slotId, addons }))
  const subtotal = async (id: string) => (await q<{ subtotal: string }>(`select subtotal from bookings where id=$1`, [id])).rows[0].subtotal
  const audits = async (id: string) =>
    (await q<{ action: string; actor_membership_id: string; after: { changes: Record<string, unknown>[] } }>(
      `select action,actor_membership_id,after from audit_log where entity_id=$1 and action='booking.addon_edited' order by created_at`,
      [id],
    )).rows

  // ── add / change / remove ─────────────────────────────────────────────────
  const start = at(5, 4)
  const b = await create(r1, start, 2)
  const slot = await slotOf(b.id)
  check('A0 baseline: room only (200)', (await subtotal(b.id)) === '200.00')
  await edit(b.id, slot, [{ addonId: camera, quantity: 1 }])
  check('A1 add 1 camera → 200 + 1×100×2 = 400', (await subtotal(b.id)) === '400.00')
  await edit(b.id, slot, [{ addonId: camera, quantity: 3 }, { addonId: lens, quantity: 1 }])
  check('A2 camera→3 and add a lens → 200 + 600 + 200 = 1000', (await subtotal(b.id)) === '1000.00')
  await edit(b.id, slot, [{ addonId: camera, quantity: 1 }])
  check('A3 lens removed, camera back to 1 → 400', (await subtotal(b.id)) === '400.00')
  await edit(b.id, slot, [])
  check('A4 all removed → room only (200)', (await subtotal(b.id)) === '200.00')

  // ── delta-only stock check ────────────────────────────────────────────────
  const other = await create(r2, start, 2)
  await edit(other.id, await slotOf(other.id), [{ addonId: camera, quantity: 2 }]) // 2 of 3 held by someone else
  await edit(b.id, slot, [{ addonId: camera, quantity: 1 }]) // 1 free → ok
  await expectReject('S1 raising past the headroom (3 wanted, only 1 free besides its own) → refused', () => edit(b.id, slot, [{ addonId: camera, quantity: 3 }]), 'left')
  check('S2 …and the refused edit changed nothing (still 400)', (await subtotal(b.id)) === '400.00')
  await edit(b.id, slot, [{ addonId: camera, quantity: 1 }])
  check('S3 re-saving the same quantity is a no-op', (await subtotal(b.id)) === '400.00')

  // Lowering always works, even when the catalog row has been deactivated.
  await q(`update resource_type_addons set is_active=false where id=$1`, [camera])
  await edit(b.id, slot, [])
  check('S4 removing a since-deactivated add-on succeeds', (await subtotal(b.id)) === '200.00')
  await q(`update resource_type_addons set is_active=true where id=$1`, [camera])

  // ── live window, not the creation-time one ────────────────────────────────
  const rWin = await mkResource('Set W')
  const longStart = at(9, 4)
  const bw = await create(rWin, longStart, 1)
  const slotW = await slotOf(bw.id)
  await edit(bw.id, slotW, [{ addonId: lens, quantity: 5 }]) // all 5 lenses, 1h
  // Someone else books all lenses in the hour AFTER bw ends.
  const rAfter = await mkResource('Set After')
  const bAfter = await create(rAfter, new Date(+longStart + HOUR), 1)
  await edit(bAfter.id, await slotOf(bAfter.id), [{ addonId: lens, quantity: 5 }])
  // Now bw is "extended" to 2h (as an extend / correction would): window grows into bAfter's.
  await q(`update booking_slots set ends_at=$2 where id=$1`, [slotW, new Date(+longStart + 2 * HOUR)])
  await q(`update booking_addons set ends_at=$2 where booking_slot_id=$1`, [slotW, new Date(+longStart + 2 * HOUR)])
  await expectReject('W1 edit is checked against the CURRENT (extended) window → refused', () => edit(bw.id, slotW, [{ addonId: lens, quantity: 5 }, { addonId: camera, quantity: 4 }]), 'left')
  // A different, free add-on within the same live window is fine.
  await edit(bw.id, slotW, [{ addonId: lens, quantity: 5 }, { addonId: camera, quantity: 1 }])
  const camLine = (await q<{ line_total: string; ends_at: Date }>(
    `select line_total,ends_at from booking_addons where booking_slot_id=$1 and addon_id=$2`,
    [slotW, camera],
  )).rows[0]
  check('W2 a new add-on prices over the live 2h window (1×100×2 = 200)', camLine.line_total === '200.00')

  // ── billed / history / audit ──────────────────────────────────────────────
  const bb = await create(r1, at(12, 4), 2)
  const slotB = await slotOf(bb.id)
  await edit(bb.id, slotB, [{ addonId: camera, quantity: 1 }])
  const invoice = await withUser(userId, (tx) => issueInvoiceForBooking(tx, { id: tenantId, timezone: TZ }, { bookingId: bb.id }))
  await expectReject('B1 edit refused once the booking is billed', () => edit(bb.id, slotB, [{ addonId: camera, quantity: 2 }]), 'already been billed')
  await expectReject('B2 removal refused once billed', () => edit(bb.id, slotB, []), 'already been billed')
  const items = (await q<{ kind: string; line_total: string }>(`select kind,line_total from invoice_items where invoice_id=$1 order by kind`, [invoice.invoiceId])).rows
  check('B3 the invoice carries the add-on line (kind addon, 200.00)', items.some((i) => i.kind === 'addon' && i.line_total === '200.00'))

  // history: a line whose catalog entry was deleted survives an edit
  const gone = await mkAddon('Gone', 2)
  const bh = await create(r2, at(15, 4), 1)
  const slotH = await slotOf(bh.id)
  await edit(bh.id, slotH, [{ addonId: gone, quantity: 1 }, { addonId: camera, quantity: 1 }])
  await q(`delete from resource_type_addons where id=$1`, [gone])
  await edit(bh.id, slotH, [{ addonId: camera, quantity: 2 }])
  const orphans = (await q<{ addon_name: string }>(`select addon_name from booking_addons where booking_id=$1 and addon_id is null`, [bh.id])).rows
  check('H1 a line whose catalog entry was deleted is kept through an edit', orphans.length === 1 && orphans[0].addon_name === 'Gone')

  // audit
  const log = await audits(bh.id)
  check('U1 audit entries exist, attributed to the editing membership', log.length === 2 && log.every((l) => l.actor_membership_id === membershipId))
  const first = JSON.stringify(log[0].after.changes)
  check('U2 first edit lists both additions by name', first.includes('"added"') && first.includes('Gone') && first.includes('Camera'))
  const second = JSON.stringify(log[1].after.changes)
  check('U3 second edit records the qty delta 1→2 and no spurious removals', second.includes('"quantity"') && second.includes('"from":1') && second.includes('"to":2') && !second.includes('removed'))
  const before = (await audits(bh.id)).length
  await edit(bh.id, slotH, [{ addonId: camera, quantity: 2 }])
  check('U4 a no-op edit writes no audit entry', (await audits(bh.id)).length === before)

  // role
  check('R1 canManageWalkins admits owner/manager/cashier/receptionist/floor_staff', ['owner', 'manager', 'cashier', 'receptionist', 'floor_staff'].every((r) => canManageWalkins(r as never)))
  check('R2 …and refuses other roles / none', !canManageWalkins('kitchen_staff' as never) && !canManageWalkins(null))

  // ── cleanup ───────────────────────────────────────────────────────────────
  await q(`delete from tenants where id=$1`, [tenantId])
  await q(`delete from users where email=$1`, [`owner@${slug}.test`])
  await ownerPool.end()
  await appPool.end()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
