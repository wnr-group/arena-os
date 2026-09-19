/**
 * Combined billing for a walk-in (M21 #8 QA pass) — checkoutWalkin's own
 * invoice must fold the elapsed-time session AND any open food together,
 * apply the customer's membership discount, and compute resource GST
 * correctly, exactly as lib/billing/invoice.ts does for any other booking
 * (checkoutWalkin just reuses issueInvoiceForBooking — this proves the
 * reuse is real, not just claimed by its doc comment).
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs --import ./scripts/next-runtime-hook.mjs scripts/test-walkin-combined-billing.ts
 *
 * The worked numbers (no happy hours, so the pure elapsed-time price is
 * exact):
 *   booking: 2h @ ₹200/hr, 18% GST  → line 400.00
 *   food:    1 item,        ₹100,    5% GST → line 100.00
 *   subtotal 500.00
 *   membership 10% of subtotal      → discount 50.00 (pro-rata: 40 off
 *                                       booking, 10 off food)
 *   tax: booking (400-40)*18% = 64.80, food (100-10)*5% = 4.50 → 69.30
 *   total = 500.00 - 50.00 + 69.30 = 519.30
 */
import { createHash, randomBytes } from 'node:crypto'
import { Pool } from 'pg'
import { loadEnv } from './env'

let pass = 0,
  fail = 0
const check = (l: string, c: boolean) => {
  console.log(`${c ? '✓' : '✗ FAIL'}  ${l}`)
  if (c) pass++
  else fail++
}

async function main() {
  loadEnv()
  const { startWalkin, checkoutWalkin } = await import('../lib/actions/bookings')
  const { purchaseCustomerMembership } = await import('../lib/actions/customer-memberships')

  const owner = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })

  const slug = 'testwalkincombined'
  const t = await owner.query<{ id: string }>(
    `insert into tenants (slug,name,status,timezone,industry) values ($1,$2,'active','Asia/Kolkata','gaming_cafe')
     on conflict (slug) do update set name=excluded.name, industry='gaming_cafe' returning id`,
    [slug, `${slug} co`],
  )
  const tenantId = t.rows[0].id
  const b = await owner.query<{ id: string }>(
    `insert into branches (tenant_id,name,is_primary) values ($1,'Main',true)
     on conflict (tenant_id,name) do update set is_primary=true returning id`,
    [tenantId],
  )
  const branchId = b.rows[0].id
  const u = await owner.query<{ id: string }>(
    `insert into users (email,password_hash) values ($1,'x')
     on conflict (email) do update set email=excluded.email returning id`,
    [`owner@${slug}.test`],
  )
  const ownerUserId = u.rows[0].id
  await owner.query(
    `insert into memberships (tenant_id,user_id,role,status) values ($1,$2,'owner','active')
     on conflict (tenant_id,user_id) do update set role='owner', status='active'`,
    [tenantId, ownerUserId],
  )

  const wipe = async () => {
    await owner.query('delete from invoice_items where tenant_id=$1', [tenantId])
    await owner.query('delete from invoices where tenant_id=$1', [tenantId])
    await owner.query('delete from order_items where tenant_id=$1', [tenantId])
    await owner.query('delete from orders where tenant_id=$1', [tenantId])
    await owner.query('delete from booking_slots where tenant_id=$1', [tenantId])
    await owner.query('delete from bookings where tenant_id=$1', [tenantId])
    await owner.query('delete from customer_memberships where tenant_id=$1', [tenantId])
    await owner.query('delete from customers where tenant_id=$1', [tenantId])
    await owner.query('delete from membership_plans where tenant_id=$1', [tenantId])
    await owner.query('delete from sequences where tenant_id=$1', [tenantId])
  }
  await wipe()

  // 18% GST on the resource, via a real tax_rates row — not the "0% because
  // nothing's configured" shape every other walk-in test deliberately uses.
  const taxRate = await owner.query<{ id: string }>(
    `insert into tax_rates (tenant_id,name,percent,applies_to) values ($1,'GST 18%',18.00,'resources')
     on conflict (tenant_id,name) do update set percent=18.00 returning id`,
    [tenantId],
  )
  const hourlyType = await owner.query<{ id: string }>(
    `insert into resource_types (tenant_id,name,hourly_rate,tax_rate_id) values ($1,'PS5',200.00,$2)
     on conflict (tenant_id,name) do update set hourly_rate=200.00, tax_rate_id=$2 returning id`,
    [tenantId, taxRate.rows[0].id],
  )
  const station = (
    await owner.query<{ id: string }>(
      `insert into resources (tenant_id,branch_id,resource_type_id,name,status)
       values ($1,$2,$3,'Station 1','available')
       on conflict (tenant_id,name) do update set status='available' returning id`,
      [tenantId, branchId, hourlyType.rows[0].id],
    )
  ).rows[0].id

  const plan = await owner.query<{ id: string }>(
    `insert into membership_plans (tenant_id,name,price,duration_months,discount_percent)
     values ($1,'Gold',1000.00,12,10.00) returning id`,
    [tenantId],
  )

  // The bare digits are what a human (and startWalkin, below) types; the
  // stored row needs the E.164 form normalizePhone() would produce, or the
  // check constraint rejects it AND the phone-first lookup would never find
  // this row as the "existing customer" for that typed number.
  const phoneTyped = '9876512345'
  const phoneStored = '+919876512345'
  const customer = await owner.query<{ id: string }>(
    `insert into customers (tenant_id,phone,name) values ($1,$2,'Combined Test Customer')
     on conflict do nothing returning id`,
    [tenantId, phoneStored],
  )
  const customerId =
    customer.rows[0]?.id ??
    (
      await owner.query<{ id: string }>(`select id from customers where tenant_id=$1 and phone=$2`, [
        tenantId,
        phoneStored,
      ])
    ).rows[0].id

  const g = globalThis as { __ARENA_TEST_SESSION?: string; __ARENA_TEST_HEADERS?: Record<string, string> }
  async function signInAs(userId: string, tenantSlug: string) {
    const token = randomBytes(32).toString('hex')
    await owner.query(
      `insert into sessions (id, user_id, expires_at) values ($1,$2, now() + interval '1 day')
       on conflict (id) do nothing`,
      [createHash('sha256').update(token).digest('hex'), userId],
    )
    g.__ARENA_TEST_SESSION = token
    g.__ARENA_TEST_HEADERS = { 'x-tenant-slug': tenantSlug }
  }

  await signInAs(ownerUserId, slug)

  console.log('\n── walk-in + food + membership discount + resource GST, one invoice ──')

  const sold = await purchaseCustomerMembership({ customerId, planId: plan.rows[0].id, paymentMethod: 'cash' })
  check('the membership sells cleanly', Boolean(sold.success))

  const started = await startWalkin({
    branchId,
    resourceId: station,
    phone: phoneTyped,
    startAt: new Date().toISOString(),
    mode: 'open_tab',
  })
  check('the walk-in starts, resolved to the SAME customer the membership was sold to', !started.error && Boolean(started.bookingId))
  const bookingId = started.bookingId!
  const bookingRow = await owner.query<{ customer_id: string }>(`select customer_id from bookings where id=$1`, [
    bookingId,
  ])
  check('…booking.customer_id matches — phone-first resolution found the existing customer', bookingRow.rows[0]?.customer_id === customerId)

  // Backdate to 1h55 (115min), NOT exactly 2h: priceElapsedTime rounds UP to
  // the next 15-min step (ceilToStep), so landing exactly ON a 15-min
  // boundary is a timing trap — the few seconds of real execution time
  // between this backdate and the checkout call below could push elapsed
  // just past 120min and round to 135 instead. 115min still rounds up to
  // the same clean 120min (2h) bucket with real margin to spare, so the
  // hand-computed ₹400.00 booking line stays exact regardless of jitter.
  await owner.query(`update booking_slots set starts_at = now() - interval '115 minutes' where booking_id = $1`, [
    bookingId,
  ])

  const order = await owner.query<{ id: string }>(
    `insert into orders (tenant_id, branch_id, booking_id, order_number, status)
     values ($1, $2, $3, 'CB-ORD-1', 'open') returning id`,
    [tenantId, branchId, bookingId],
  )
  await owner.query(
    `insert into order_items (tenant_id, order_id, item_name, unit_price, tax_rate, qty, line_total)
     values ($1, $2, 'Nachos', 100.00, 5.00, 1, 100.00)`,
    [tenantId, order.rows[0].id],
  )

  const result = await checkoutWalkin({ bookingId })
  check('checkout succeeds', !result.error)
  // checkoutWalkin's own `total` field is checkoutWalkinCore's session-only
  // price (₹400) — NOT the invoice's combined total once food/discount/tax
  // are folded in. The UI never surfaces this field (it only reads
  // invoiceId/invoiceNumber and routes to /pos, where the real invoice total
  // below is what's actually shown/charged), so this isn't user-facing, but
  // worth pinning explicitly so the distinction can't quietly go misread.
  check('checkout result.total is the session-ONLY price (₹400), not the combined invoice total', result.total === 400)
  check('checkout returns exactly one invoice', Boolean(result.invoiceId) && Boolean(result.invoiceNumber))

  const invCount = await owner.query<{ n: string }>(`select count(*)::text as n from invoices where booking_id=$1`, [
    bookingId,
  ])
  check('…and only one invoice row exists for this booking', invCount.rows[0].n === '1')

  const inv = await owner.query<{
    subtotal: string
    discount: string
    tax_total: string
    total: string
    customer_membership_id: string | null
    membership_discount: string
    membership_discount_percent: string
  }>(`select subtotal, discount, tax_total, total, customer_membership_id, membership_discount, membership_discount_percent from invoices where id=$1`, [
    result.invoiceId,
  ])
  const row = inv.rows[0]
  check('subtotal is ₹500.00 (400 booking + 100 food)', Number(row.subtotal) === 500)
  check('discount is ₹50.00 (10% membership)', Number(row.discount) === 50)
  check('…and it is tagged as this exact membership', row.customer_membership_id === sold.membership?.id)
  check('…at 10%, ₹50 off', row.membership_discount_percent === '10.00' && Number(row.membership_discount) === 50)
  check('tax_total is ₹69.30 (64.80 booking GST + 4.50 food GST)', Number(row.tax_total) === 69.3)
  check('total is ₹519.30', Number(row.total) === 519.3)
  check('the bill reconciles: subtotal − discount + tax = total', round2(Number(row.subtotal) - Number(row.discount) + Number(row.tax_total)) === Number(row.total))

  const items = await owner.query<{ kind: string; description: string; unit_price: string; tax_rate: string }>(
    `select kind, description, unit_price, tax_rate from invoice_items where invoice_id=$1 order by kind`,
    [result.invoiceId],
  )
  check('two invoice lines: one booking, one food', items.rows.length === 2)
  const bookingLine = items.rows.find((r) => r.kind === 'booking')
  const foodLine = items.rows.find((r) => r.kind === 'food')
  check('the booking line is ₹400.00 at 18% GST — the resource type\'s own rate', Boolean(bookingLine) && Number(bookingLine!.unit_price) === 400 && Number(bookingLine!.tax_rate) === 18)
  check('the food line is ₹100.00 at 5% GST — the order item\'s own rate, untouched by the resource\'s', Boolean(foodLine) && Number(foodLine!.unit_price) === 100 && Number(foodLine!.tax_rate) === 5)

  await wipe()
  await owner.query('delete from sessions where user_id=$1', [ownerUserId])
  await owner.end()

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
