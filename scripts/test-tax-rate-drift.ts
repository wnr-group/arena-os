/**
 * Tax-rate drift — the warning the till sees when an order was taken before a
 * rate changed.
 *
 * An order SNAPSHOTS the item's tax rate when it is taken, and the bill copies
 * that snapshot onto the invoice. That is correct for a tax document: reading
 * the live rate would retroactively re-tax food already served and move the GST
 * on bills already issued. The cost is a discrepancy nobody can see — an order
 * left open across a rate change bills at the old rate while the menu shows the
 * new one.
 *
 * getBillableForBooking()/getRunningTab() therefore report it rather than
 * resolving it, and this suite pins both halves of that contract:
 *
 *   - the snapshot still decides what is charged, drift or no drift
 *   - the warning appears exactly when the stored rate and the menu disagree,
 *     and says nothing when they agree
 *   - it goes quiet once a bill exists, when nobody can act on it any more
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs scripts/test-tax-rate-drift.ts
 *
 * (The server-only hook is required: lib/billing/data.ts is `server-only`.)
 */
import { Pool } from 'pg'
import type { ActiveContext } from '../lib/tenant/context'
import { loadEnv } from './env'

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
  const { getBillableForBooking, getRunningTab } = await import('../lib/billing/data')
  const { issueInvoiceForBooking } = await import('../lib/billing/invoice')
  const { withUser } = await import('../db')

  const owner = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })

  const slug = 'testtaxdrift'
  const t = await owner.query<{ id: string }>(
    `insert into tenants (slug,name,status,timezone) values ($1,$2,'active',$3)
     on conflict (slug) do update set name=excluded.name returning id`, [slug, `${slug} co`, TZ])
  const tenantId = t.rows[0].id
  const b = await owner.query<{ id: string }>(
    `insert into branches (tenant_id,name,is_primary) values ($1,'Main',true)
     on conflict (tenant_id,name) do update set is_primary=true returning id`, [tenantId])
  const branchId = b.rows[0].id
  const u = await owner.query<{ id: string }>(
    `insert into users (email,password_hash) values ($1,'x')
     on conflict (email) do update set email=excluded.email returning id`, [`owner@${slug}.test`])
  const userId = u.rows[0].id
  const m = await owner.query<{ id: string }>(
    `insert into memberships (tenant_id,user_id,role,status) values ($1,$2,'owner','active')
     on conflict (tenant_id,user_id) do update set role='owner', status='active' returning id`,
    [tenantId, userId])
  const rt = await owner.query<{ id: string }>(
    `insert into resource_types (tenant_id,name,hourly_rate) values ($1,'PS5','400.00')
     on conflict (tenant_id,name) do update set hourly_rate='400.00' returning id`, [tenantId])
  const resourceId = (await owner.query<{ id: string }>(
    `insert into resources (tenant_id,branch_id,resource_type_id,name) values ($1,$2,$3,'S1')
     on conflict (tenant_id,name) do update set name='S1' returning id`,
    [tenantId, branchId, rt.rows[0].id])).rows[0].id

  const ctx: ActiveContext = {
    user: { id: userId, email: `owner@${slug}.test`, fullName: null, isPlatformAdmin: false },
    tenant: { id: tenantId, slug, name: `${slug} co`, industry: 'gaming', status: 'active',
      currency: 'INR', timezone: TZ },
    role: 'owner',
    membershipId: m.rows[0].id,
    branchId,
  }

  // Order matters: order_items point at menu_items, menu_items at tax_rates.
  await owner.query('delete from invoices where tenant_id=$1', [tenantId])
  await owner.query('delete from orders where tenant_id=$1', [tenantId])
  await owner.query('delete from bookings where tenant_id=$1', [tenantId])
  await owner.query('delete from menu_items where tenant_id=$1', [tenantId])
  await owner.query('delete from menu_categories where tenant_id=$1', [tenantId])
  await owner.query('delete from tax_rates where tenant_id=$1', [tenantId])
  await owner.query('delete from sequences where tenant_id=$1', [tenantId])

  const cat = await owner.query<{ id: string }>(
    `insert into menu_categories (tenant_id,name) values ($1,'Drinks') returning id`, [tenantId])
  const rate5 = await owner.query<{ id: string }>(
    `insert into tax_rates (tenant_id,name,percent) values ($1,'GST 5%','5.00') returning id`,
    [tenantId])
  const coffee = await owner.query<{ id: string }>(
    `insert into menu_items (tenant_id,category_id,name,price,tax_rate_id)
     values ($1,$2,'Coffee','40.00',$3) returning id`,
    [tenantId, cat.rows[0].id, rate5.rows[0].id])
  const coffeeId = coffee.rows[0].id

  let seq = 0
  /** A confirmed booking with one Coffee ordered at `snapshotRate`. */
  async function bookingWithCoffee(snapshotRate: string) {
    const n = ++seq
    const bk = await owner.query<{ id: string }>(
      `insert into bookings (tenant_id,branch_id,booking_number,status,subtotal,total)
       values ($1,$2,$3,'confirmed','0','0') returning id`, [tenantId, branchId, `TD-${n}`])
    const bookingId = bk.rows[0].id
    const start = new Date(Date.UTC(2038, 0, n, 4, 0, 0))
    await owner.query(
      `insert into booking_slots (tenant_id,booking_id,resource_id,starts_at,ends_at,
         rate_applied,slot_total,resource_name,resource_type_name,active)
       values ($1,$2,$3,$4,$5,'400.00','400.00','S1','PS5',true)`,
      [tenantId, bookingId, resourceId, start, new Date(start.getTime() + 3600_000)])
    const ord = await owner.query<{ id: string }>(
      `insert into orders (tenant_id,branch_id,booking_id,order_number,status,acceptance_status)
       values ($1,$2,$3,$4,'open','accepted') returning id`,
      [tenantId, branchId, bookingId, `ORD-TD-${n}`])
    await owner.query(
      `insert into order_items (tenant_id,order_id,menu_item_id,item_name,qty,unit_price,
         tax_rate,line_total,void_status)
       values ($1,$2,$3,'Coffee',1,'40.00',$4,'40.00','active')`,
      [tenantId, ord.rows[0].id, coffeeId, snapshotRate])
    return bookingId
  }

  const driftOf = async (bookingId: string) =>
    (await getBillableForBooking(ctx, bookingId))!.taxDrift

  // ══ 1. rates agree → silence ═════════════════════════════════════════════
  console.log('\n── the menu and the order agree ──')
  {
    const bookingId = await bookingWithCoffee('5.00')
    check('no warning when the stored rate matches the menu', (await driftOf(bookingId)).length === 0)
    check('…and the running tab is quiet too',
      (await getRunningTab(ctx, bookingId))!.taxDrift.length === 0)
  }

  // ══ 2. the rate changed after the order was taken ════════════════════════
  console.log('\n── the rate was raised after the order ──')
  {
    // Ordered at 5%, then the owner edits GST 5% to 12% (what upsertTaxRate does).
    const bookingId = await bookingWithCoffee('5.00')
    await owner.query(`update tax_rates set percent='12.00', name='GST 12%' where id=$1`,
      [rate5.rows[0].id])

    const drift = await driftOf(bookingId)
    check('the discrepancy is reported', drift.length === 1)
    check('…naming the item as the order named it', drift[0]?.description === 'Coffee')
    check('…the rate that will be CHARGED is the stored 5%', drift[0]?.chargedPercent === 5)
    check('…and the menu rate today is 12%', drift[0]?.currentPercent === 12)
    check('the running tab reports the same', (await getRunningTab(ctx, bookingId))!.taxDrift.length === 1)

    // The whole point: the warning is advisory. The bill still charges 5%.
    const issued = await withUser(userId, (tx) =>
      issueInvoiceForBooking(tx, { id: tenantId, timezone: TZ }, { bookingId }))
    const coffeeLine = issued.pricing.items.find((i) => i.kind === 'food')
    check('the bill still charges the SNAPSHOT, not the new menu rate',
      coffeeLine?.taxPercent === 5)
    check('…so GST on the ₹40 line is ₹2.00, not ₹4.80',
      issued.pricing.taxTotal === 2)

    check('and the warning goes quiet once the bill exists — nothing left to decide',
      (await driftOf(bookingId)).length === 0)

    await owner.query(`update tax_rates set percent='5.00', name='GST 5%' where id=$1`,
      [rate5.rows[0].id])
  }

  // ══ 3. the rate was deleted out from under the item ══════════════════════
  // menu_items.tax_rate_id is ON DELETE SET NULL, so deleting a rate silently
  // takes every item using it to 0% — the quietest way to change a bill there is.
  console.log('\n── the rate was deleted ──')
  {
    const gone = await owner.query<{ id: string }>(
      `insert into tax_rates (tenant_id,name,percent) values ($1,'GST 18%','18.00') returning id`,
      [tenantId])
    const snack = await owner.query<{ id: string }>(
      `insert into menu_items (tenant_id,category_id,name,price,tax_rate_id)
       values ($1,$2,'Nachos','100.00',$3) returning id`,
      [tenantId, cat.rows[0].id, gone.rows[0].id])

    const n = ++seq
    const bk = await owner.query<{ id: string }>(
      `insert into bookings (tenant_id,branch_id,booking_number,status,subtotal,total)
       values ($1,$2,$3,'confirmed','0','0') returning id`, [tenantId, branchId, `TD-${n}`])
    const bookingId = bk.rows[0].id
    const start = new Date(Date.UTC(2038, 0, n, 4, 0, 0))
    await owner.query(
      `insert into booking_slots (tenant_id,booking_id,resource_id,starts_at,ends_at,
         rate_applied,slot_total,resource_name,resource_type_name,active)
       values ($1,$2,$3,$4,$5,'400.00','400.00','S1','PS5',true)`,
      [tenantId, bookingId, resourceId, start, new Date(start.getTime() + 3600_000)])
    const ord = await owner.query<{ id: string }>(
      `insert into orders (tenant_id,branch_id,booking_id,order_number,status,acceptance_status)
       values ($1,$2,$3,$4,'open','accepted') returning id`,
      [tenantId, branchId, bookingId, `ORD-TD-${n}`])
    await owner.query(
      `insert into order_items (tenant_id,order_id,menu_item_id,item_name,qty,unit_price,
         tax_rate,line_total,void_status)
       values ($1,$2,$3,'Nachos',1,'100.00','18.00','100.00','active')`,
      [tenantId, ord.rows[0].id, snack.rows[0].id])

    check('no warning while the rate still exists', (await driftOf(bookingId)).length === 0)

    await owner.query('delete from tax_rates where id=$1', [gone.rows[0].id])
    const drift = await driftOf(bookingId)
    check('deleting the rate is reported as a drop to 0%',
      drift.length === 1 && drift[0].chargedPercent === 18 && drift[0].currentPercent === 0)
  }

  // ══ 4. a line whose menu item is gone ════════════════════════════════════
  // Nothing to compare against, so nothing to say.
  console.log('\n── the menu item was deleted ──')
  {
    const bookingId = await bookingWithCoffee('5.00')
    await owner.query(`update order_items set menu_item_id=null
       where tenant_id=$1 and item_name='Coffee' and order_id in
       (select id from orders where booking_id=$2)`, [tenantId, bookingId])
    check('a line with no menu item raises no warning', (await driftOf(bookingId)).length === 0)
  }

  // ══ 5. voided lines are not warned about ════════════════════════════════
  console.log('\n── a voided line ──')
  {
    const bookingId = await bookingWithCoffee('5.00')
    await owner.query(`update tax_rates set percent='12.00' where id=$1`, [rate5.rows[0].id])
    check('the live line is reported', (await driftOf(bookingId)).length === 1)

    await owner.query(`update order_items set void_status='voided'
       where tenant_id=$1 and order_id in (select id from orders where booking_id=$2)`,
      [tenantId, bookingId])
    check('…and goes quiet once voided — it will not be billed',
      (await driftOf(bookingId)).length === 0)
    await owner.query(`update tax_rates set percent='5.00' where id=$1`, [rate5.rows[0].id])
  }

  await owner.end()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
