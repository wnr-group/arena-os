/**
 * Promo preview — does what the till SHOWS match what the bill CHARGES?
 *
 * scripts/test-promo.ts already proves validatePromo() and the invoice core.
 * This suite covers the seam between them: previewPromoForBooking(), the reader
 * behind the "Apply" button on the POS bill screen. The property under test is
 * a single one, asserted for every discount shape —
 *
 *     previewed discount === the discount the invoice actually writes
 *
 * — because the bug it exists to prevent is a cashier confirming ₹1000 while
 * the customer is charged ₹900, or the reverse.
 *
 * It also pins the two things that make the preview safe to press repeatedly:
 * it consumes no use, and it refuses exactly what the bill would refuse, in the
 * same words.
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs scripts/test-promo-preview.ts
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
const DAY = 86_400_000
// Customers and membership plans outlive a run (bookings and invoices point at
// them), and both carry unique keys — a phone, and one ACTIVE plan per name.
// Stamping the run into each keeps a second run from colliding with the first.
const RUN = String(Date.now() % 1_000_000).padStart(6, '0')

async function main() {
  // Every app module is imported AFTER this line: db/index.ts builds its pools
  // at module load, so a static import would connect before DATABASE_URL exists
  // (the same reason the M16 suites import dynamically).
  loadEnv()
  const { previewPromoForBooking } = await import('../lib/billing/data')
  const { BillingError, issueInvoiceForBooking } = await import('../lib/billing/invoice')
  const { purchaseMembership } = await import('../lib/memberships/customer-memberships')
  const { withUser } = await import('../db')

  const ownerPool = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })

  let seq = 0

  /**
   * A tenant with an owner, plus the ActiveContext the reader takes. The
   * context is assembled by hand here rather than through getActiveContext(),
   * which needs a request and its headers — the fields below are the whole of
   * what previewPromoForBooking() reads.
   */
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
    const rt = await ownerPool.query<{ id: string }>(
      `insert into resource_types (tenant_id,name,hourly_rate) values ($1,'PS5','500.00')
       on conflict (tenant_id,name) do update set hourly_rate='500.00' returning id`,
      [tenantId],
    )
    const res = await ownerPool.query<{ id: string }>(
      `insert into resources (tenant_id,branch_id,resource_type_id,name) values ($1,$2,$3,'S1')
       on conflict (tenant_id,name) do update set name='S1' returning id`,
      [tenantId, b.rows[0].id, rt.rows[0].id],
    )

    const ctx: ActiveContext = {
      user: { id: u.rows[0].id, email: `owner@${slug}.test`, fullName: null, isPlatformAdmin: false },
      tenant: {
        id: tenantId,
        slug,
        name: `${slug} co`,
        industry: 'gaming',
        status: 'active',
        currency: 'INR',
        timezone: TZ,
      },
      role: 'owner',
      membershipId: m.rows[0].id,
      branchId: b.rows[0].id,
    }
    return { ctx, tenantId, branchId: b.rows[0].id, userId: u.rows[0].id, resourceId: res.rows[0].id }
  }

  type Actor = Awaited<ReturnType<typeof makeTenant>>

  async function makePromo(
    tenantId: string,
    code: string,
    o: {
      type?: 'percentage' | 'fixed'
      value?: string
      from?: Date
      until?: Date
      maxUses?: number | null
      uses?: number
      active?: boolean
    } = {},
  ) {
    const now = Date.now()
    const {
      type = 'percentage',
      value = '10.00',
      from = new Date(now - DAY),
      until = new Date(now + DAY),
      maxUses = null,
      uses = 0,
      active = true,
    } = o
    const r = await ownerPool.query<{ id: string }>(
      `insert into promo_codes (tenant_id,code,discount_type,discount_value,valid_from,valid_until,max_uses,uses,is_active)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
      [tenantId, code, type, value, from, until, maxUses, uses, active],
    )
    return r.rows[0].id
  }

  const usesOf = async (id: string) =>
    Number((await ownerPool.query('select uses from promo_codes where id=$1', [id])).rows[0].uses)

  async function makeCustomer(t: Actor) {
    seq++
    const r = await ownerPool.query<{ id: string }>(
      `insert into customers (tenant_id,phone,name) values ($1,$2,$3) returning id`,
      [t.tenantId, `+9177${RUN}${String(seq % 100).padStart(2, '0')}`, `Guest ${seq}`],
    )
    return r.rows[0].id
  }

  /** A confirmed booking worth `total` rupees (2h at total/2 an hour). */
  async function makeBooking(t: Actor, total = 1000, customerId: string | null = null) {
    const n = ++seq
    const bk = await ownerPool.query<{ id: string }>(
      `insert into bookings (tenant_id,branch_id,booking_number,customer_id,status,subtotal,total)
       values ($1,$2,$3,$4,'confirmed','0','0') returning id`,
      [t.tenantId, t.branchId, `PV-${n}`, customerId],
    )
    const s = new Date(Date.UTC(2035, 0, 1 + (n % 27), 4, 0, 0))
    await ownerPool.query(
      `insert into booking_slots (tenant_id,booking_id,resource_id,starts_at,ends_at,rate_applied,slot_total,resource_name,resource_type_name,active)
       values ($1,$2,$3,$4,$5,$6,$7,'S1','PS5',true)`,
      [
        t.tenantId,
        bk.rows[0].id,
        t.resourceId,
        s,
        new Date(s.getTime() + 2 * 3600_000),
        (total / 2).toFixed(2),
        total.toFixed(2),
      ],
    )
    return bk.rows[0].id
  }

  const preview = (t: Actor, bookingId: string, code: string) =>
    previewPromoForBooking(t.ctx, bookingId, code)

  async function bill(t: Actor, bookingId: string, promoCode?: string, discount?: number) {
    try {
      const r = await withUser(t.userId, (tx) =>
        issueInvoiceForBooking(tx, { id: t.tenantId, timezone: TZ }, { bookingId, promoCode, discount }),
      )
      return { ok: true as const, ...r }
    } catch (e) {
      return {
        ok: false as const,
        billing: e instanceof BillingError,
        message: e instanceof Error ? e.message : String(e),
      }
    }
  }

  const A = await makeTenant('testpvwa')
  const B = await makeTenant('testpvwb')
  for (const t of [A, B]) {
    await ownerPool.query('delete from invoices where tenant_id=$1', [t.tenantId])
    await ownerPool.query('delete from bookings where tenant_id=$1', [t.tenantId])
    await ownerPool.query('delete from promo_codes where tenant_id=$1', [t.tenantId])
    await ownerPool.query('delete from sequences where tenant_id=$1', [t.tenantId])
  }

  // ══ 1. the previewed figure is the charged figure ═════════════════════════
  console.log('\n── preview === charge ──')
  {
    await makePromo(A.tenantId, 'PCT10', { type: 'percentage', value: '10.00' })
    const bookingId = await makeBooking(A, 1000)
    const p = await preview(A, bookingId, 'PCT10')
    check('₹1000 @ PCT10 previews ₹100 off', p.ok && p.discount === 100)

    const inv = await bill(A, bookingId, 'PCT10')
    check('…and the invoice charges exactly that', inv.ok && inv.pricing.discount === 100)
    check('…so the grand total is ₹900, as previewed', inv.ok && inv.pricing.total === 900)
  }
  {
    await makePromo(A.tenantId, 'FLAT250', { type: 'fixed', value: '250.00' })
    const bookingId = await makeBooking(A, 1000)
    const p = await preview(A, bookingId, 'FLAT250')
    const inv = await bill(A, bookingId, 'FLAT250')
    check('a fixed ₹250 previews ₹250', p.ok && p.discount === 250)
    check('…and is charged as ₹250', inv.ok && inv.pricing.discount === 250)
  }
  {
    // The cap is the case a browser-side guess gets wrong most often.
    await makePromo(A.tenantId, 'FLAT5000', { type: 'fixed', value: '5000.00' })
    const bookingId = await makeBooking(A, 400)
    const p = await preview(A, bookingId, 'FLAT5000')
    const inv = await bill(A, bookingId, 'FLAT5000')
    check('a ₹5000 code on a ₹400 bill previews ₹400, not ₹5000', p.ok && p.discount === 400)
    check('…matching the charge, and the bill settles at ₹0', inv.ok && inv.pricing.discount === 400 && inv.pricing.total === 0)
  }
  {
    // Paise, where a percentage stops being a round number.
    await makePromo(A.tenantId, 'PCT7', { type: 'percentage', value: '7.00' })
    const bookingId = await makeBooking(A, 333.34)
    const p = await preview(A, bookingId, 'PCT7')
    const inv = await bill(A, bookingId, 'PCT7')
    check('7% of ₹333.34 previews ₹23.33 (rounded to paise)', p.ok && p.discount === 23.33)
    check('…and is charged to the same paisa', inv.ok && inv.pricing.discount === 23.33)
  }

  // ══ 2. against a membership benefit ═══════════════════════════════════════
  // The reason this reader exists on the server: the promo's base is what is
  // left AFTER the membership discount, and the browser cannot know either.
  console.log('\n── promo after a membership benefit ──')
  {
    const customerId = await makeCustomer(A)
    const plan = await ownerPool.query<{ id: string }>(
      `insert into membership_plans (tenant_id,name,price,duration_months,discount_percent,free_hours,wallet_credit)
       values ($1,$2,'1000.00',12,'20.00','0.00','0.00') returning id`,
      [A.tenantId, `Gold ${RUN}`],
    )
    await withUser(A.userId, (tx) =>
      purchaseMembership(
        tx,
        { tenantId: A.tenantId, membershipId: A.ctx.membershipId, timezone: TZ, branchId: A.branchId },
        { customerId, planId: plan.rows[0].id, paymentMethod: 'cash' },
      ),
    )

    await makePromo(A.tenantId, 'MEMB10', { type: 'percentage', value: '10.00' })
    const bookingId = await makeBooking(A, 1000, customerId)

    const p = await preview(A, bookingId, 'MEMB10')
    // ₹1000 − 20% membership = ₹800; 10% of ₹800 = ₹80. NOT ₹100.
    check('10% is taken off the post-membership ₹800, so ₹80', p.ok && p.discount === 80)

    const inv = await bill(A, bookingId, 'MEMB10')
    check('…and the invoice agrees: ₹200 + ₹80 = ₹280 off', inv.ok && inv.pricing.discount === 280)
    check('…leaving ₹720 to pay', inv.ok && inv.pricing.total === 720)
  }

  // ══ 3. previewing burns nothing ═══════════════════════════════════════════
  console.log('\n── a preview is not a use ──')
  {
    const promoId = await makePromo(A.tenantId, 'ONCE', { type: 'fixed', value: '50.00', maxUses: 1 })
    const bookingId = await makeBooking(A, 1000)

    for (let i = 0; i < 5; i++) await preview(A, bookingId, 'ONCE')
    check('five previews of a max_uses=1 code consume no uses', (await usesOf(promoId)) === 0)

    const stillValid = await preview(A, bookingId, 'ONCE')
    check('…so the code is still usable afterwards', stillValid.ok && stillValid.discount === 50)

    const inv = await bill(A, bookingId, 'ONCE')
    check('raising the bill consumes exactly one', inv.ok && (await usesOf(promoId)) === 1)

    const exhausted = await preview(A, await makeBooking(A, 1000), 'ONCE')
    check('…and the next preview reports the limit', !exhausted.ok && exhausted.reason === 'Promo code usage limit reached.')
  }

  // ══ 4. refusals, in the words the bill would use ══════════════════════════
  console.log('\n── refusals match the bill ──')
  {
    const now = Date.now()
    await makePromo(A.tenantId, 'DEAD', { from: new Date(now - 2 * DAY), until: new Date(now - DAY) })
    await makePromo(A.tenantId, 'OFF', { active: false })

    for (const [code, reason] of [
      ['NOSUCH', 'Promo code not found.'],
      ['DEAD', 'Promo code has expired.'],
      ['OFF', 'Promo code is inactive.'],
    ] as const) {
      const bookingId = await makeBooking(A, 1000)
      const p = await preview(A, bookingId, code)
      const inv = await bill(A, bookingId, code)
      check(`${code} previews "${reason}"`, !p.ok && p.reason === reason)
      check(`…and the bill fails with the same words`, !inv.ok && inv.billing && inv.message === reason)
    }
  }
  {
    // Whitespace and casing, exactly as validatePromo normalises them.
    const bookingId = await makeBooking(A, 1000)
    const p = await preview(A, bookingId, '  pct10  ')
    check("' pct10 ' previews the same ₹100 as PCT10", p.ok && p.discount === 100)
    const blank = await preview(A, bookingId, '   ')
    check('a blank code previews "Enter a promo code."', !blank.ok && blank.reason === 'Enter a promo code.')
  }

  // ══ 5. the preview refuses what cannot be billed ══════════════════════════
  console.log('\n── unbillable bookings ──')
  {
    const bookingId = await makeBooking(A, 1000)
    const inv = await bill(A, bookingId, 'PCT10')
    const after = await preview(A, bookingId, 'PCT10')
    check(
      'an already-billed booking previews its invoice number, not a discount',
      !after.ok && inv.ok && after.reason === `This booking has already been billed (${inv.invoiceNumber}).`,
    )
  }
  {
    const bookingId = await makeBooking(A, 1000)
    await ownerPool.query(`update bookings set status='cancelled' where id=$1`, [bookingId])
    const p = await preview(A, bookingId, 'PCT10')
    check(
      'a cancelled booking is refused',
      !p.ok && p.reason === 'This booking cannot be billed in its current status.',
    )
  }
  {
    const bookingId = await makeBooking(A, 1000)
    await ownerPool.query('delete from booking_slots where booking_id=$1', [bookingId])
    const p = await preview(A, bookingId, 'PCT10')
    check('a booking with no lines is refused', !p.ok && p.reason === 'This booking has nothing to bill.')
  }

  // ══ 6. tenant isolation ═══════════════════════════════════════════════════
  console.log('\n── isolation ──')
  {
    const bookingId = await makeBooking(A, 1000)
    const crossBooking = await preview(B, bookingId, 'PCT10')
    check("tenant B cannot preview against tenant A's booking", !crossBooking.ok && crossBooking.reason === 'Booking not found.')

    const bBooking = await makeBooking(B, 1000)
    const crossCode = await preview(B, bBooking, 'PCT10')
    check("…nor resolve tenant A's code on its own booking", !crossCode.ok && crossCode.reason === 'Promo code not found.')
  }

  await ownerPool.end()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
