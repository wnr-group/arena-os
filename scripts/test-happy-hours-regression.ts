/**
 * Happy hours #4 (M23 #4) — QA & regression acceptance for #1–#3 (reserved
 * bookings honour happy hours, and the staff/public quotes match what's
 * charged). This file covers the gaps identified in a fresh audit of the
 * existing suites, rather than re-proving what they already cover:
 *
 *   - scripts/test-happy-hours-reserved-bookings.ts (#1) already proves the
 *     segment math, weekday/weekend × per-head composition, boundary
 *     straddling, snapshot freeze, and loadBookingLines -> priceBill
 *     reconciliation IN MEMORY — but never persists a real invoice.
 *   - scripts/test-weekend-pricing.ts's testWalkins() proves exactly ONE
 *     walk-in + happy-hour scenario (T13); scripts/test-elapsed-time-pricing.ts
 *     proves priceElapsedTime itself exhaustively. Neither regressed by #1–#3
 *     (priceElapsedTime's own behaviour is unchanged — it now calls the
 *     extracted priceTimeRangeSegments, but its external output is identical,
 *     which is exactly what that suite re-proves on every run).
 *   - scripts/test-modifiers.ts proves happy hours still discount a menu
 *     order's base price (lib/orders/service.ts, untouched by #1–#3).
 *
 * What was genuinely missing, and what this file adds:
 *
 *   1. All FOUR weekday/weekend × per-resource/per-head combinations, each
 *      with an active happy hour, asserted together in one place (ticket #1's
 *      suite covers three of the four incidentally; the weekday × per-head
 *      combination had no explicit coverage anywhere).
 *   2. A happy-hour-discounted reserved booking taken all the way through
 *      issueInvoiceForBooking to a PERSISTED invoices/invoice_items row, with
 *      a manual discount AND tax on top — proving the subtotal
 *      issueInvoiceForBooking bills from is the happy-hour-discounted figure,
 *      not the full rate, and that discount/tax reconcile to the paise
 *      against it.
 *   3. The same, plus a taxable service charge (M18 #3, restaurant-only) on
 *      top — proving the service charge (computed from the bill's own
 *      subtotal) inherits the happy-hour discount automatically, rather than
 *      being computed from some stale, undiscounted figure.
 *
 * Regression for the rest of this ticket's scope (walk-in unchanged, menu
 * orders unaffected, the broader pricing/booking/billing suite green) is
 * satisfied by re-running the EXISTING suites named above unchanged — see the
 * QA pass this ticket's PR records, not new code here.
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs scripts/test-happy-hours-regression.ts
 */
import { Pool } from 'pg'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { sql } from 'drizzle-orm'
import * as schema from '../db/schema'
import { createBookingCore } from '../lib/booking/service'
import { issueInvoiceForBooking } from '../lib/billing/invoice'
import { round2 } from '../lib/billing/pricing'
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
// Confirmed fixed calendar (same convention as test-happy-hours-reserved-bookings.ts
// and test-weekend-pricing.ts): 2046-03-16 Fri, -17 Sat, -20 Tue.
const tue = (hhmm: string) => new Date(`2046-03-20T${hhmm}:00+05:30`)
const sat = (hhmm: string) => new Date(`2046-03-17T${hhmm}:00+05:30`)

async function withUserFor(app: ReturnType<typeof drizzle>) {
  return async function withUser<T>(userId: string, fn: (tx: Db) => Promise<T>): Promise<T> {
    return app.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`)
      return fn(tx as unknown as Db)
    })
  }
}

async function makeTenant(ownerPool: Pool, slug: string, industry: 'gaming_cafe' | 'restaurant') {
  const t = await ownerPool.query<{ id: string }>(
    `insert into tenants (slug,name,status,timezone,industry) values ($1,$2,'active',$3,$4)
     on conflict (slug) do update set name=excluded.name, industry=excluded.industry returning id`,
    [slug, `${slug} co`, TZ, industry],
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
  const userId = u.rows[0].id
  const m = await ownerPool.query<{ id: string }>(
    `insert into memberships (tenant_id,user_id,role,status) values ($1,$2,'owner','active')
     on conflict (tenant_id,user_id) do update set role='owner', status='active' returning id`,
    [tenantId, userId],
  )
  const membershipId = m.rows[0].id

  // Idempotent against a previous run that died mid-way — same reasoning as
  // every other DB-backed suite in this repo.
  await ownerPool.query(`delete from booking_slots where tenant_id = $1`, [tenantId])
  await ownerPool.query(`delete from invoice_items where tenant_id = $1`, [tenantId])
  await ownerPool.query(`delete from invoices where tenant_id = $1`, [tenantId])
  await ownerPool.query(`delete from bookings where tenant_id = $1`, [tenantId])
  await ownerPool.query(`delete from happy_hours where tenant_id = $1`, [tenantId])
  await ownerPool.query(`delete from tax_rates where tenant_id = $1`, [tenantId])
  await ownerPool.query(`delete from business_profiles where tenant_id = $1`, [tenantId])
  await ownerPool.query(`delete from sequences where tenant_id = $1`, [tenantId])

  await ownerPool.query(
    `insert into happy_hours (tenant_id,name,days_of_week,start_time,end_time,discount_type,discount_value,is_active)
     values ($1,'Evening 50% off','{0,1,2,3,4,5,6}','17:00','19:00','percentage',50,true)`,
    [tenantId],
  )

  return { tenantId, branchId, userId, membershipId }
}

// ── 1. all four weekday/weekend × per-resource/per-head combinations, each
// with an active happy hour — the weekday × per-head cell had no explicit
// coverage anywhere before this ticket. ───────────────────────────────────
async function testFourCombinations() {
  const ownerPool = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })
  const appPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 })
  const app = drizzle(appPool, { schema })
  const withUser = await withUserFor(app)

  const { tenantId, branchId, userId, membershipId } = await makeTenant(
    ownerPool,
    'testhappyhoursregression4combos',
    'gaming_cafe',
  )
  const ctx = { tenantId, timezone: TZ, membershipId }

  async function makeType(
    name: string,
    hourlyRate: string,
    weekendRate: string | null,
    pricingMode: 'per_resource' | 'per_head',
    minPlayers: number,
  ) {
    const rt = await ownerPool.query<{ id: string }>(
      `insert into resource_types (tenant_id,name,hourly_rate,weekend_rate,pricing_mode,min_players)
       values ($1,$2,$3,$4,$5,$6)
       on conflict (tenant_id,name) do update set hourly_rate=excluded.hourly_rate, weekend_rate=excluded.weekend_rate,
         pricing_mode=excluded.pricing_mode, min_players=excluded.min_players returning id`,
      [tenantId, name, hourlyRate, weekendRate, pricingMode, minPlayers],
    )
    const res = await ownerPool.query<{ id: string }>(
      `insert into resources (tenant_id,branch_id,resource_type_id,name,status) values ($1,$2,$3,$4,'available')
       on conflict (tenant_id,name) do update set status='available' returning id`,
      [tenantId, branchId, rt.rows[0].id, `${name}-A`],
    )
    return res.rows[0].id
  }

  async function bookAndLoad(resourceId: string, startsAt: Date, endsAt: Date, headCount?: number) {
    const booking = await withUser(userId, (tx) =>
      createBookingCore(tx, ctx, {
        branchId,
        source: 'staff',
        discount: 0,
        deposit: 0,
        headCount,
        slots: [{ resourceId, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() }],
      }),
    )
    const { rows } = await ownerPool.query(
      `select rate_applied, slot_total, happy_hour_applied from booking_slots where booking_id = $1`,
      [booking.id],
    )
    return {
      rateApplied: rows[0].rate_applied as string,
      slotTotal: rows[0].slot_total as string,
      happyHourApplied: rows[0].happy_hour_applied as boolean,
    }
  }

  // Cell 1: weekday-only (no weekend_rate) × per_resource. ₹100/hr, 50% off
  // inside the window → ₹50/hr.
  {
    const resourceId = await makeType('Weekday PerResource', '100.00', null, 'per_resource', 1)
    const r = await bookAndLoad(resourceId, tue('17:00'), tue('18:00'))
    check(
      'Combo 1/4 (weekday × per_resource + HH): slot_total = 50.00, happy_hour_applied = true',
      r.slotTotal === '50.00' && r.happyHourApplied === true,
    )
  }

  // Cell 2: weekday-only × per_head. ₹40/player/hr, 2 players, 50% off
  // inside the window → ₹20/player/hr × 2 = ₹40.00.
  {
    const resourceId = await makeType('Weekday PerHead', '40.00', null, 'per_head', 2)
    const r = await bookAndLoad(resourceId, tue('17:00'), tue('18:00'), 2)
    check(
      'Combo 2/4 (weekday × per_head + HH): slot_total = 40.00 (2 players × ₹20/hr), happy_hour_applied = true',
      r.slotTotal === '40.00' && r.happyHourApplied === true,
    )
  }

  // Cell 3: weekend-configured × per_resource. Weekend ₹200/hr, 50% off
  // inside the window → ₹100/hr.
  {
    const resourceId = await makeType('Weekend PerResource', '100.00', '200.00', 'per_resource', 1)
    const r = await bookAndLoad(resourceId, sat('17:00'), sat('18:00'))
    check(
      'Combo 3/4 (weekend × per_resource + HH): slot_total = 100.00 (₹200 weekend rate × 50% off), happy_hour_applied = true',
      r.slotTotal === '100.00' && r.happyHourApplied === true,
    )
  }

  // Cell 4: weekend-configured × per_head. Weekend ₹80/player/hr, 2 players,
  // 50% off inside the window → ₹40/player/hr × 2 = ₹80.00.
  {
    const resourceId = await makeType('Weekend PerHead', '40.00', '80.00', 'per_head', 2)
    const r = await bookAndLoad(resourceId, sat('17:00'), sat('18:00'), 2)
    check(
      'Combo 4/4 (weekend × per_head + HH): slot_total = 80.00 (2 players × ₹40/hr weekend), happy_hour_applied = true',
      r.slotTotal === '80.00' && r.happyHourApplied === true,
    )
  }

  await ownerPool.query('delete from tenants where id = $1', [tenantId])
  await ownerPool.query(`delete from users where email = $1`, ['owner@testhappyhoursregression4combos.test'])
  await ownerPool.end()
  await appPool.end()
}

// ── 2. a happy-hour-discounted booking through issueInvoiceForBooking to a
// PERSISTED invoice, with a discount AND tax on top. ────────────────────────
async function testFullInvoiceReconciliation() {
  const ownerPool = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })
  const appPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 })
  const app = drizzle(appPool, { schema })
  const withUser = await withUserFor(app)

  const { tenantId, branchId, userId, membershipId } = await makeTenant(
    ownerPool,
    'testhappyhoursregressioninvoice',
    'gaming_cafe',
  )
  const ctx = { tenantId, timezone: TZ, membershipId }

  // 18% GST on resources, tenant-wide (resolveScopeDefaultTaxPercent picks
  // this up automatically since the resource type sets no tax_rate_id).
  await ownerPool.query(
    `insert into tax_rates (tenant_id,name,percent,applies_to,is_active) values ($1,'GST 18%','18.00','resources',true)`,
    [tenantId],
  )

  const rt = await ownerPool.query<{ id: string }>(
    `insert into resource_types (tenant_id,name,hourly_rate,weekend_rate,pricing_mode,min_players)
     values ($1,'Snooker Invoice','50.00','80.00','per_head',3)
     on conflict (tenant_id,name) do update set hourly_rate=excluded.hourly_rate, weekend_rate=excluded.weekend_rate,
       pricing_mode=excluded.pricing_mode, min_players=excluded.min_players returning id`,
    [tenantId],
  )
  const res = await ownerPool.query<{ id: string }>(
    `insert into resources (tenant_id,branch_id,resource_type_id,name,status) values ($1,$2,$3,'Snooker-Invoice-A','available')
     on conflict (tenant_id,name) do update set status='available' returning id`,
    [tenantId, branchId, rt.rows[0].id],
  )
  const resourceId = res.rows[0].id

  // Sat 16:30–18:00 (1.5h), 3 players, straddling the 17:00 HH start:
  //   16:30–17:00 (0.5h) @ ₹80/player weekend rate     = 40/player
  //   17:00–18:00 (1h)   @ ₹40/player (50% off)         = 40/player
  //   rawTotal (per player) = 80 → × 3 players = 240.00 exactly.
  // Without the happy hour this would have billed 360.00 (1.5h × ₹80 × 3) —
  // the point of this test is that the invoice bills the discounted 240.00.
  const booking = await withUser(userId, (tx) =>
    createBookingCore(tx, ctx, {
      branchId,
      source: 'staff',
      discount: 0,
      deposit: 0,
      headCount: 3,
      slots: [{ resourceId, startsAt: sat('16:30').toISOString(), endsAt: sat('18:00').toISOString() }],
    }),
  )

  const { rows: bookingRows } = await ownerPool.query(
    `select subtotal, total from bookings where id = $1`,
    [booking.id],
  )
  check('booking.subtotal snapshots the happy-hour-discounted 240.00 (not the full-rate 360.00)', bookingRows[0].subtotal === '240.00')

  const { rows: slotRows } = await ownerPool.query(
    `select slot_total, happy_hour_applied from booking_slots where booking_id = $1`,
    [booking.id],
  )
  check('booking_slots.slot_total = 240.00, happy_hour_applied = true', slotRows[0].slot_total === '240.00' && slotRows[0].happy_hour_applied === true)

  const issued = await withUser(userId, (tx) =>
    issueInvoiceForBooking(tx, { id: tenantId, timezone: TZ }, { bookingId: booking.id, discount: 40 }),
  )

  // gross subtotal 240.00, discount 40.00 → taxable 200.00, 18% GST = 36.00,
  // total = 236.00. Hand-computed (no rounding ambiguity: every intermediate
  // figure is exact to the paisa) rather than re-derived through priceBill,
  // so this is an independent check on the actual persisted numbers.
  check('issued invoice pricing.subtotal = 240.00', issued.pricing.subtotal === 240)
  check('issued invoice pricing.discount = 40.00', issued.pricing.discount === 40)
  check('issued invoice pricing.taxTotal = 36.00 (18% of the 200.00 taxable value)', issued.pricing.taxTotal === 36)
  check('issued invoice pricing.total = 236.00', issued.pricing.total === 236)
  check(
    'reconciles: subtotal − discount + tax = total',
    round2(issued.pricing.subtotal - issued.pricing.discount + issued.pricing.taxTotal) === issued.pricing.total,
  )

  const { rows: invRows } = await ownerPool.query(
    `select subtotal, discount, tax_total, total, status from invoices where id = $1`,
    [issued.invoiceId],
  )
  check(
    'persisted invoices row: subtotal=240.00, discount=40.00, tax_total=36.00, total=236.00, status=issued',
    invRows[0].subtotal === '240.00' &&
      invRows[0].discount === '40.00' &&
      invRows[0].tax_total === '36.00' &&
      invRows[0].total === '236.00' &&
      invRows[0].status === 'issued',
  )

  const { rows: itemRows } = await ownerPool.query(
    `select kind, qty, unit_price, tax_rate, line_total from invoice_items where invoice_id = $1`,
    [issued.invoiceId],
  )
  check('exactly one invoice_item, kind=booking', itemRows.length === 1 && itemRows[0].kind === 'booking')
  check(
    'invoice_item is qty=1.00 / unit_price=240.00 (the exact happy-hour total, not hours × a blended rate)',
    itemRows[0].qty === '1.00' && itemRows[0].unit_price === '240.00',
  )
  check('invoice_item tax_rate=18.00, line_total=240.00', itemRows[0].tax_rate === '18.00' && itemRows[0].line_total === '240.00')

  await ownerPool.query('delete from tenants where id = $1', [tenantId])
  await ownerPool.query(`delete from users where email = $1`, ['owner@testhappyhoursregressioninvoice.test'])
  await ownerPool.end()
  await appPool.end()
}

// ── 3. the same, plus a taxable service charge (M18 #3, restaurant-only) on
// top — proving the service charge derives from the ALREADY-discounted
// subtotal, not some stale full-rate figure. ────────────────────────────────
async function testServiceChargeComposition() {
  const ownerPool = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })
  const appPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 })
  const app = drizzle(appPool, { schema })
  const withUser = await withUserFor(app)

  const { tenantId, branchId, userId, membershipId } = await makeTenant(
    ownerPool,
    'testhappyhoursregressionservicecharge',
    'restaurant',
  )
  const ctx = { tenantId, timezone: TZ, membershipId }

  await ownerPool.query(
    `insert into tax_rates (tenant_id,name,percent,applies_to,is_active) values ($1,'GST 18%','18.00','resources',true)`,
    [tenantId],
  )
  // appliesTo='food', deliberately NOT 'resources' or 'both': the service
  // charge tax rate is resolved by its exact FK id (loadServiceChargeConfig
  // joins on serviceChargeTaxRateId directly, ignoring appliesTo), but a
  // 'both'/'resources' row here would ALSO count as a second eligible
  // 'resources'-scope rate for resolveScopeDefaultTaxPercent — making the
  // GST 18% row above ambiguous (2 eligible rows -> null -> silently falls
  // back to 0% on the booking line). Keeping it food-scoped avoids that
  // collision while still being independently referenceable by id.
  const scTax = await ownerPool.query<{ id: string }>(
    `insert into tax_rates (tenant_id,name,percent,applies_to,is_active) values ($1,'GST 5%','5.00','food',true) returning id`,
    [tenantId],
  )
  await ownerPool.query(
    `insert into business_profiles (tenant_id, invoice_prefix, service_charge_percent, service_charge_tax_rate_id)
     values ($1, 'INV', '10.00', $2)
     on conflict (tenant_id) do update set service_charge_percent = excluded.service_charge_percent,
       service_charge_tax_rate_id = excluded.service_charge_tax_rate_id`,
    [tenantId, scTax.rows[0].id],
  )

  const rt = await ownerPool.query<{ id: string }>(
    `insert into resource_types (tenant_id,name,hourly_rate,weekend_rate,pricing_mode,min_players)
     values ($1,'Snooker ServiceCharge','50.00','80.00','per_head',3)
     on conflict (tenant_id,name) do update set hourly_rate=excluded.hourly_rate, weekend_rate=excluded.weekend_rate,
       pricing_mode=excluded.pricing_mode, min_players=excluded.min_players returning id`,
    [tenantId],
  )
  const res = await ownerPool.query<{ id: string }>(
    `insert into resources (tenant_id,branch_id,resource_type_id,name,status) values ($1,$2,$3,'Snooker-SC-A','available')
     on conflict (tenant_id,name) do update set status='available' returning id`,
    [tenantId, branchId, rt.rows[0].id],
  )
  const resourceId = res.rows[0].id

  // Same shape as testFullInvoiceReconciliation: sat 16:30–18:00, 3 players,
  // straddling the HH start → slot_total = 240.00.
  const booking = await withUser(userId, (tx) =>
    createBookingCore(tx, ctx, {
      branchId,
      source: 'staff',
      discount: 0,
      deposit: 0,
      headCount: 3,
      slots: [{ resourceId, startsAt: sat('16:30').toISOString(), endsAt: sat('18:00').toISOString() }],
    }),
  )

  const issued = await withUser(userId, (tx) =>
    issueInvoiceForBooking(tx, { id: tenantId, timezone: TZ }, { bookingId: booking.id }),
  )

  // subtotal 240.00 (the happy-hour-discounted figure), no discount, 18% GST
  // = 43.20. Service charge: 10% of 240.00 = 24.00, taxed at 5% = 1.20.
  //   taxTotal = 43.20 + 1.20 = 44.40
  //   total    = 240.00 (taxableValue, no discount) + 24.00 + 44.40 = 308.40
  check('gross subtotal is the happy-hour-discounted 240.00, not the full-rate 360.00', issued.pricing.subtotal === 240)

  const { rows: invRows } = await ownerPool.query(
    `select subtotal, discount, tax_total, total, service_charge_percent, service_charge_amount, service_charge_tax_percent
       from invoices where id = $1`,
    [issued.invoiceId],
  )
  const inv = invRows[0]
  check('service_charge_amount = 24.00 (10% of the discounted 240.00, not of 360.00)', inv.service_charge_amount === '24.00')
  check('tax_total = 44.40 (43.20 resource GST + 1.20 service-charge GST)', inv.tax_total === '44.40')
  check('total = 308.40', inv.total === '308.40')
  check(
    'reconciles: subtotal − discount + service_charge_amount + tax_total = total',
    round2(Number(inv.subtotal) - Number(inv.discount) + Number(inv.service_charge_amount) + Number(inv.tax_total)) ===
      Number(inv.total),
  )

  const { rows: itemRows } = await ownerPool.query(
    `select kind, unit_price from invoice_items where invoice_id = $1 order by kind`,
    [issued.invoiceId],
  )
  check(
    'invoice_items: one booking line (240.00) + one synthetic service_charge line (24.00)',
    itemRows.length === 2 &&
      itemRows.some((r) => r.kind === 'booking' && r.unit_price === '240.00') &&
      itemRows.some((r) => r.kind === 'service_charge' && r.unit_price === '24.00'),
  )

  await ownerPool.query('delete from tenants where id = $1', [tenantId])
  await ownerPool.query(`delete from users where email = $1`, ['owner@testhappyhoursregressionservicecharge.test'])
  await ownerPool.end()
  await appPool.end()
}

async function main() {
  loadEnv()
  await testFourCombinations()
  await testFullInvoiceReconciliation()
  await testServiceChargeComposition()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
