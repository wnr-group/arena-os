/**
 * Rich fixture data for local development — a fully "lived-in" demo tenant so
 * every screen has something real to show.
 *
 *   npm run seed:fixtures     (idempotent — safe to re-run)
 *
 * This runs AFTER scripts/seed-demo.ts (the npm script chains them): seed-demo
 * lays the base (tenant, branch, owner/manager/cashier, resources, customers,
 * expense categories, platform admin); this script layers operational data on
 * top of that base for the "demo" tenant:
 *
 *   Catalogue   tax rates, menu (categories + items), happy hour, promo codes,
 *               membership plans, vendors, business profile, loyalty settings
 *   Customers   memberships sold, wallet ledger, loyalty ledger
 *   Operations  bookings (past / live / upcoming / cancelled) + slots,
 *               food orders + items + kitchen tickets, invoices + line items +
 *               payments (incl. a wallet split and a membership discount)
 *   Staff       salary structures, an advance + recovery, last month's payslips,
 *               attendance, a weekly roster + shifts, tasks
 *   Money out   expenses + a recurring rent template
 *
 * Idempotency: every row this script owns is scoped to the demo tenant and
 * deleted (FK-safe order) before re-insert, so a re-run resets the demo
 * tenant's operational data to this known state. It never touches the base
 * rows seed-demo owns, other tenants, or payment_settings.
 *
 * Connects as the OWNER role (bypasses RLS), same as seed-demo. Raw SQL only —
 * no server-only app modules imported.
 */
import { Client } from 'pg'
import { hash } from '@node-rs/argon2'
import { loadEnv } from './env'

const money = (n: number) => n.toFixed(2)
const ARGON = { memoryCost: 19456, timeCost: 2, outputLen: 32, parallelism: 1 } as const

async function main() {
  loadEnv()
  const url = process.env.DATABASE_URL_OWNER
  if (!url) throw new Error('DATABASE_URL_OWNER is not set in .env.local')

  const client = new Client({ connectionString: url })
  await client.connect()

  // Date helpers — this is a normal node script, so real Dates are fine.
  const now = new Date()
  const at = (addDays: number, h = 0, m = 0) => {
    const d = new Date(now)
    d.setDate(d.getDate() + addDays)
    d.setHours(h, m, 0, 0)
    return d
  }
  const dateStr = (d: Date) => d.toISOString().slice(0, 10)
  // 'YYYY-MM' for a month N months before this one (0 = current).
  const periodOf = (monthsAgo: number) => {
    const d = new Date(now.getFullYear(), now.getMonth() - monthsAgo, 1)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
  }
  // Monday of the current week (roster week_start).
  const weekStart = (() => {
    const d = new Date(now)
    const dow = d.getDay() // 0 = Sun
    d.setDate(d.getDate() - ((dow + 6) % 7))
    return dateStr(d)
  })()

  try {
    await client.query('begin')

    // ── look up the base seed-demo created ────────────────────────────────────
    const t = await client.query<{ id: string }>(
      `select id from public.tenants where slug = 'demo'`,
    )
    if (t.rowCount === 0) throw new Error('demo tenant missing — run `npm run seed:demo` first')
    const tenantId = t.rows[0].id

    const b = await client.query<{ id: string }>(
      `select id from public.branches where tenant_id = $1 and is_primary = true limit 1`,
      [tenantId],
    )
    const branchId = b.rows[0].id

    const mem = await client.query<{ id: string; user_id: string; email: string }>(
      `select id, user_id, email from public.memberships where tenant_id = $1`,
      [tenantId],
    )
    const byEmail = (e: string) => mem.rows.find((r) => r.email === e)!
    const owner = byEmail('owner@demo.test')
    const manager = byEmail('manager@demo.test')
    const cashier = byEmail('cashier@demo.test')

    // Two more staff (kitchen + floor) so the team and the reports look real.
    // Idempotent: users keyed by email, memberships by (tenant, user). Password
    // is the same demo1234 as the rest.
    async function ensureStaff(email: string, name: string, role: string) {
      const h = await hash('demo1234', ARGON)
      const u = await client.query<{ id: string }>(
        `insert into public.users (email, password_hash, full_name)
         values ($1,$2,$3)
         on conflict (email) do update set password_hash = excluded.password_hash, full_name = excluded.full_name
         returning id`,
        [email, h, name],
      )
      const m = await client.query<{ id: string }>(
        `insert into public.memberships (tenant_id, user_id, branch_id, role, status, full_name, email)
         values ($1,$2,$3,$4,'active',$5,$6)
         on conflict (tenant_id, user_id)
         do update set role = excluded.role, status = 'active', full_name = excluded.full_name, email = excluded.email
         returning id`,
        [tenantId, u.rows[0].id, branchId, role, name, email],
      )
      return { id: m.rows[0].id, user_id: u.rows[0].id, email }
    }
    const kitchen = await ensureStaff('kitchen@demo.test', 'Kiran Kumar', 'kitchen_staff')
    const floor = await ensureStaff('floor@demo.test', 'Faisal Rahman', 'floor_staff')

    // Defensive: satisfy any audit/RLS trigger that reads app.user_id. The owner
    // role bypasses RLS, but a trigger casting the setting to uuid still needs a
    // real value present.
    await client.query(`select set_config('app.user_id', $1, true)`, [owner.user_id])

    const custRows = await client.query<{ id: string; phone: string }>(
      `select id, phone from public.customers where tenant_id = $1`,
      [tenantId],
    )
    const cust = (phone: string) => custRows.rows.find((r) => r.phone === phone)!.id
    const asha = cust('+919876543210')
    const rohit = cust('+919812345678')
    const fatima = cust('+919900112233')
    const vikram = cust('+919845001122')
    const meera = cust('+919701234567')

    const resRows = await client.query<{ id: string; name: string; type_name: string; rate: string }>(
      `select r.id, r.name, rt.name as type_name, rt.hourly_rate as rate
         from public.resources r
         join public.resource_types rt on rt.id = r.resource_type_id
        where r.tenant_id = $1`,
      [tenantId],
    )
    const res = (name: string) => resRows.rows.find((r) => r.name === name)!

    const catRows = await client.query<{ id: string; name: string }>(
      `select id, name from public.expense_categories where tenant_id = $1`,
      [tenantId],
    )
    const expCat = (name: string) => catRows.rows.find((r) => r.name === name)!.id

    // ── idempotency: clear this script's rows for the demo tenant (FK-safe) ────
    // Break the invoices <-> customer_memberships cycle before deleting either.
    await client.query(`update public.invoices set customer_membership_id = null where tenant_id = $1`, [tenantId])
    for (const sql of [
      `delete from public.refunds where tenant_id = $1`,
      `delete from public.payments where tenant_id = $1`,
      `delete from public.invoice_items where tenant_id = $1`,
      `delete from public.invoices where tenant_id = $1`,
      `delete from public.kots where tenant_id = $1`,
      `delete from public.order_items where tenant_id = $1`,
      `delete from public.orders where tenant_id = $1`,
      `delete from public.booking_slots where tenant_id = $1`,
      `delete from public.bookings where tenant_id = $1`,
      `delete from public.customer_memberships where tenant_id = $1`,
      `delete from public.wallet_transactions where tenant_id = $1`,
      `delete from public.loyalty_transactions where tenant_id = $1`,
      `delete from public.payslips where tenant_id = $1`,
      `delete from public.employee_advance_recoveries where tenant_id = $1`,
      `delete from public.employee_advances where tenant_id = $1`,
      `delete from public.salary_structures where tenant_id = $1`,
      `delete from public.attendance where tenant_id = $1`,
      `delete from public.shifts where tenant_id = $1`,
      `delete from public.rosters where tenant_id = $1`,
      `delete from public.tasks where tenant_id = $1`,
      `delete from public.expenses where tenant_id = $1`,
      `delete from public.recurring_expenses where tenant_id = $1`,
      `delete from public.vendors where tenant_id = $1`,
      `delete from public.menu_items where tenant_id = $1`,
      `delete from public.menu_categories where tenant_id = $1`,
      `delete from public.happy_hours where tenant_id = $1`,
      `delete from public.promo_codes where tenant_id = $1`,
      `delete from public.tax_rates where tenant_id = $1`,
      `delete from public.membership_plans where tenant_id = $1`,
    ]) {
      await client.query(sql, [tenantId])
    }

    // ── business profile (GST header on invoices) ─────────────────────────────
    await client.query(
      `insert into public.business_profiles (tenant_id, legal_name, gstin, address, invoice_prefix, place_of_supply)
       values ($1,'Demo Gaming Cafe Pvt Ltd','29ABCDE1234F1Z5','No. 1, MG Road, Bengaluru 560001','INV','29-Karnataka')
       on conflict (tenant_id) do update set legal_name = excluded.legal_name, gstin = excluded.gstin,
         address = excluded.address, place_of_supply = excluded.place_of_supply`,
      [tenantId],
    )

    // ── tax rates (GST) ───────────────────────────────────────────────────────
    const taxId: Record<string, string> = {}
    for (const [name, pct] of [['GST 5%', '5'], ['GST 12%', '12'], ['GST 18%', '18']] as const) {
      const r = await client.query<{ id: string }>(
        `insert into public.tax_rates (tenant_id, name, percent) values ($1,$2,$3) returning id`,
        [tenantId, name, pct],
      )
      taxId[pct] = r.rows[0].id
    }

    // ── menu ──────────────────────────────────────────────────────────────────
    const catId: Record<string, string> = {}
    for (const [name, sort] of [['Beverages', 1], ['Snacks', 2], ['Combos', 3]] as const) {
      const r = await client.query<{ id: string }>(
        `insert into public.menu_categories (tenant_id, name, sort_order) values ($1,$2,$3) returning id`,
        [tenantId, name, sort],
      )
      catId[name] = r.rows[0].id
    }
    const menu: Record<string, { id: string; price: string; taxPct: string }> = {}
    const menuSeed: [string, string, string, string, boolean][] = [
      // name, category, price, gst%, happy_hour_eligible
      ['Cold Coffee', 'Beverages', '120.00', '5', true],
      ['Masala Chai', 'Beverages', '40.00', '5', false],
      ['Fresh Lime Soda', 'Beverages', '60.00', '5', false],
      ['French Fries', 'Snacks', '150.00', '5', true],
      ['Paneer Popcorn', 'Snacks', '180.00', '12', false],
      ['Veg Sandwich', 'Snacks', '110.00', '5', false],
      ['Gamer Combo', 'Combos', '320.00', '5', true],
    ]
    for (const [name, cat, price, pct, hh] of menuSeed) {
      const r = await client.query<{ id: string }>(
        `insert into public.menu_items (tenant_id, category_id, name, price, tax_rate_id, happy_hour_eligible)
         values ($1,$2,$3,$4,$5,$6) returning id`,
        [tenantId, catId[cat], name, price, taxId[pct], hh],
      )
      menu[name] = { id: r.rows[0].id, price, taxPct: pct }
    }

    // ── happy hour (Mon–Fri 17:00–20:00, 20% off eligible items) ──────────────
    const hh = await client.query<{ id: string }>(
      `insert into public.happy_hours (tenant_id, name, days_of_week, start_time, end_time, discount_type, discount_value)
       values ($1,'Weekday Evening Special',$2,'17:00','20:00','percentage','20') returning id`,
      [tenantId, [1, 2, 3, 4, 5]],
    )
    const happyHourId = hh.rows[0].id

    // ── promo codes ───────────────────────────────────────────────────────────
    await client.query(
      `insert into public.promo_codes (tenant_id, code, discount_type, discount_value, valid_from, valid_until, max_uses, uses)
       values ($1,'WELCOME10','percentage','10',$2,$3,100,3)`,
      [tenantId, at(-30), at(60)],
    )
    await client.query(
      `insert into public.promo_codes (tenant_id, code, discount_type, discount_value, valid_from, valid_until, max_uses, uses)
       values ($1,'FLAT50','fixed','50',$2,$3,null,1)`,
      [tenantId, at(-10), at(30)],
    )

    // ── membership plans + sold memberships ───────────────────────────────────
    const planId: Record<string, string> = {}
    for (const [name, price, months, disc, freeHrs, wallet] of [
      ['Silver', '999.00', 3, '10', '5', '200.00'],
      ['Gold', '2499.00', 6, '20', '15', '500.00'],
    ] as const) {
      const r = await client.query<{ id: string }>(
        `insert into public.membership_plans (tenant_id, name, price, duration_months, discount_percent, free_hours, wallet_credit)
         values ($1,$2,$3,$4,$5,$6,$7) returning id`,
        [tenantId, name, price, months, disc, freeHrs, wallet],
      )
      planId[name] = r.rows[0].id
    }
    const goldCm = await client.query<{ id: string }>(
      `insert into public.customer_memberships
         (tenant_id, customer_id, plan_id, plan_name, price_paid, duration_months, discount_percent, free_hours, wallet_credit, status, starts_at, expires_at, sold_by)
       values ($1,$2,$3,'Gold','2499.00',6,'20','15','500.00','active',$4,$5,$6) returning id`,
      [tenantId, asha, planId['Gold'], at(-40), at(140), owner.id],
    )
    const ashaGoldCmId = goldCm.rows[0].id
    await client.query(
      `insert into public.customer_memberships
         (tenant_id, customer_id, plan_id, plan_name, price_paid, duration_months, discount_percent, free_hours, wallet_credit, status, starts_at, expires_at, sold_by)
       values ($1,$2,$3,'Silver','999.00',3,'10','5','200.00','active',$4,$5,$6)`,
      [tenantId, vikram, planId['Silver'], at(-20), at(70), owner.id],
    )

    // ── wallet ledger (balance = sum) ─────────────────────────────────────────
    const wallet: [string, string, string][] = [
      [asha, '500.00', 'Gold membership wallet credit'],
      [asha, '1000.00', 'Wallet top-up (cash)'],
      [asha, '-350.00', 'Paid via wallet at POS'],
      [vikram, '200.00', 'Silver membership wallet credit'],
    ]
    for (const [customerId, amount, reason] of wallet) {
      await client.query(
        `insert into public.wallet_transactions (tenant_id, customer_id, amount, reason, source_type, created_by)
         values ($1,$2,$3,$4,'fixture',$5)`,
        [tenantId, customerId, amount, reason, owner.id],
      )
    }

    // ── loyalty settings + ledger ─────────────────────────────────────────────
    await client.query(
      `insert into public.loyalty_settings (tenant_id, points_per_unit, unit_amount, point_value, min_redeem_points, is_active)
       values ($1,1,'100.00','1.00',50,true)
       on conflict (tenant_id) do update set is_active = true, min_redeem_points = 50`,
      [tenantId],
    )
    for (const [customerId, points, reason] of [
      [asha, 120, 'Earned on spend'],
      [asha, -50, 'Redeemed on bill'],
      [rohit, 30, 'Earned on spend'],
    ] as const) {
      await client.query(
        `insert into public.loyalty_transactions (tenant_id, customer_id, points, reason, source_type)
         values ($1,$2,$3,$4,'fixture')`,
        [tenantId, customerId, points, reason],
      )
    }

    // ── bookings + slots ──────────────────────────────────────────────────────
    // helper: create a booking and its single resource slot.
    let bkSeq = 0
    async function booking(opts: {
      customerId: string
      customerName: string
      customerPhone: string
      resourceName: string
      startDay: number
      startHour: number
      hours: number
      status: string
      source?: string
      deposit?: string
      slotActive: boolean
      checkedIn?: Date | null
      completed?: Date | null
      cancelled?: Date | null
    }): Promise<string> {
      bkSeq += 1
      const r = res(opts.resourceName)
      const rate = Number(r.rate)
      const slotTotal = rate * opts.hours
      const starts = at(opts.startDay, opts.startHour)
      const ends = at(opts.startDay, opts.startHour + opts.hours)
      const number = `FIX-BK-${String(bkSeq).padStart(4, '0')}`
      const bk = await client.query<{ id: string }>(
        `insert into public.bookings
           (tenant_id, branch_id, booking_number, customer_id, customer_name, customer_phone,
            status, source, subtotal, total, deposit, created_by, checked_in_at, completed_at, cancelled_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10,$11,$12,$13,$14) returning id`,
        [
          tenantId, branchId, number, opts.customerId, opts.customerName, opts.customerPhone,
          opts.status, opts.source ?? 'staff', money(slotTotal), opts.deposit ?? '0.00',
          owner.id, opts.checkedIn ?? null, opts.completed ?? null, opts.cancelled ?? null,
        ],
      )
      const bookingId = bk.rows[0].id
      await client.query(
        `insert into public.booking_slots
           (tenant_id, booking_id, resource_id, starts_at, ends_at, rate_applied, slot_total, resource_name, resource_type_name, active)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [tenantId, bookingId, r.id, starts, ends, money(rate), money(slotTotal), r.name, r.type_name, opts.slotActive],
      )
      return bookingId
    }

    const bkCompleted = await booking({
      customerId: asha, customerName: 'Asha Iyer', customerPhone: '+919876543210',
      resourceName: 'PS5 #1', startDay: -1, startHour: 18, hours: 2, status: 'completed',
      slotActive: false, checkedIn: at(-1, 18), completed: at(-1, 20),
    })
    const bkLive = await booking({
      customerId: rohit, customerName: 'Rohit Menon', customerPhone: '+919812345678',
      resourceName: 'Snooker #1', startDay: 0, startHour: Math.max(0, now.getHours() - 1), hours: 2,
      status: 'checked_in', slotActive: true, checkedIn: at(0, Math.max(0, now.getHours() - 1)),
    })
    await booking({
      customerId: fatima, customerName: 'Fatima Sheikh', customerPhone: '+919900112233',
      resourceName: 'PS5 #2', startDay: 1, startHour: 19, hours: 1, status: 'confirmed', slotActive: true,
    })
    await booking({
      customerId: meera, customerName: 'Meera Krishnan', customerPhone: '+919701234567',
      resourceName: 'Snooker #2', startDay: 2, startHour: 20, hours: 2, status: 'confirmed',
      source: 'online', deposit: '250.00', slotActive: true,
    })
    await booking({
      customerId: vikram, customerName: 'Vikram Nair', customerPhone: '+919845001122',
      resourceName: 'PS5 #3', startDay: -2, startHour: 21, hours: 1, status: 'cancelled',
      slotActive: false, cancelled: at(-2, 12),
    })

    // ── orders + items + kitchen tickets ──────────────────────────────────────
    let ordSeq = 0
    let kotSeq = 0
    async function order(
      bookingId: string | null,
      status: string,
      items: { name: string; qty: number; happyHour?: boolean }[],
      kotStatus: string,
    ) {
      ordSeq += 1
      const o = await client.query<{ id: string }>(
        `insert into public.orders (tenant_id, branch_id, booking_id, order_number, status, created_by)
         values ($1,$2,$3,$4,$5,$6) returning id`,
        [tenantId, branchId, bookingId, `FIX-ORD-${String(ordSeq).padStart(4, '0')}`, status, cashier.id],
      )
      const orderId = o.rows[0].id
      for (const it of items) {
        const m = menu[it.name]
        const listed = Number(m.price)
        const applied = it.happyHour ? listed * 0.8 : listed
        await client.query(
          `insert into public.order_items
             (tenant_id, order_id, menu_item_id, item_name, unit_price, tax_rate, qty, line_total,
              happy_hour_id, happy_hour_name, original_unit_price, happy_hour_discount_type, happy_hour_discount_value)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [
            tenantId, orderId, m.id, it.name, money(applied), m.taxPct, it.qty, money(applied * it.qty),
            it.happyHour ? happyHourId : null, it.happyHour ? 'Weekday Evening Special' : null,
            it.happyHour ? money(listed) : null, it.happyHour ? 'percentage' : null, it.happyHour ? '20' : null,
          ],
        )
      }
      kotSeq += 1
      await client.query(
        `insert into public.kots (tenant_id, branch_id, order_id, kot_number, status)
         values ($1,$2,$3,$4,$5)`,
        [tenantId, branchId, orderId, `FIX-KOT-${String(kotSeq).padStart(4, '0')}`, kotStatus],
      )
      return orderId
    }

    // Completed booking → billed order (folded into the invoice below).
    await order(bkCompleted, 'billed', [
      { name: 'Cold Coffee', qty: 2 },
      { name: 'French Fries', qty: 1 },
    ], 'served')
    // Live booking → OPEN order with a ticket the kitchen screen shows now.
    await order(bkLive, 'open', [
      { name: 'Paneer Popcorn', qty: 1 },
      { name: 'French Fries', qty: 2, happyHour: true },
    ], 'preparing')
    // A standalone counter order waiting in the kitchen queue.
    await order(null, 'open', [{ name: 'Gamer Combo', qty: 1 }], 'pending')

    // ── invoice for the completed booking (booking + food, membership discount) ─
    // Lines: 2h @ ₹150 = 300 (booking) + Cold Coffee ×2 @120 = 240 + Fries ×1 @150.
    // subtotal 690 · Gold 20% membership discount 138 · taxable 552 · GST5 27.60.
    const invSub = 690
    const memDisc = 138 // 20% of 690
    const taxable = invSub - memDisc // 552
    const taxTotal = +(taxable * 0.05).toFixed(2) // 27.60
    const cgst = +(taxTotal / 2).toFixed(2)
    const invTotal = +(taxable + taxTotal).toFixed(2) // 579.60
    const inv = await client.query<{ id: string }>(
      `insert into public.invoices
         (tenant_id, branch_id, invoice_number, booking_id, customer_id, subtotal, discount,
          tax_total, tax_breakup, total, status, place_of_supply, issued_at,
          customer_membership_id, membership_discount, membership_discount_percent, membership_plan_name,
          loyalty_points_earned)
       values ($1,$2,'FIX-INV-0001',$3,$4,$5,$11,$6,$7,$8,'paid','29-Karnataka',$9,$10,$11,'20','Gold',5)
       returning id`,
      [
        tenantId, branchId, bkCompleted, asha, money(invSub), money(taxTotal),
        JSON.stringify([{ rate: 5, cgst: money(cgst), sgst: money(cgst) }]),
        money(invTotal), at(-1, 20), ashaGoldCmId, money(memDisc),
      ],
    )
    const invoiceId = inv.rows[0].id
    const invItems: [string, string, number, string, string][] = [
      // kind, description, qty, unit_price, gst%
      ['booking', 'PS5 #1 · 2 hrs @ ₹150', 2, '150.00', '5'],
      ['food', 'Cold Coffee × 2', 2, '120.00', '5'],
      ['food', 'French Fries × 1', 1, '150.00', '5'],
    ]
    for (const [kind, desc, qty, unit, pct] of invItems) {
      await client.query(
        `insert into public.invoice_items (tenant_id, invoice_id, kind, description, qty, unit_price, tax_rate, line_total)
         values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [tenantId, invoiceId, kind, desc, qty, unit, pct, money(Number(unit) * qty)],
      )
    }
    // Split payment: ₹350 from wallet + ₹229.60 cash (sums to the invoice total).
    await client.query(
      `insert into public.payments (tenant_id, branch_id, invoice_id, method, amount, status, collected_by)
       values ($1,$2,$3,'wallet','350.00','captured',$4)`,
      [tenantId, branchId, invoiceId, cashier.id],
    )
    await client.query(
      `insert into public.payments (tenant_id, branch_id, invoice_id, method, amount, status, collected_by)
       values ($1,$2,$3,'cash',$4,'captured',$5)`,
      [tenantId, branchId, invoiceId, money(+(invTotal - 350).toFixed(2)), cashier.id],
    )

    // ── vendors ───────────────────────────────────────────────────────────────
    const vendorId: Record<string, string> = {}
    for (const [name, phone, email] of [
      ['Metro Cash & Carry', '+918040001111', 'orders@metro.test'],
      ['BESCOM', null, null],
      ['CleanPro Services', '+918040002222', 'hello@cleanpro.test'],
    ] as const) {
      const r = await client.query<{ id: string }>(
        `insert into public.vendors (tenant_id, name, phone, email) values ($1,$2,$3,$4) returning id`,
        [tenantId, name, phone, email],
      )
      vendorId[name] = r.rows[0].id
    }

    // ── expenses + a recurring rent template ──────────────────────────────────
    const firstOfMonth = dateStr(new Date(now.getFullYear(), now.getMonth(), 1))
    const expenses: [string, string, string | null, string, string][] = [
      // category, amount, vendor, spent_on, note
      ['Rent', '40000.00', null, firstOfMonth, 'Monthly shop rent'],
      ['Utilities', '8500.00', 'BESCOM', dateStr(at(-5)), 'Electricity bill'],
      ['Supplies', '12000.00', 'Metro Cash & Carry', dateStr(at(-8)), 'Snacks & beverages restock'],
      ['Maintenance', '3000.00', 'CleanPro Services', dateStr(at(-3)), 'Weekly deep clean'],
    ]
    for (const [cat, amount, vendor, spentOn, note] of expenses) {
      await client.query(
        `insert into public.expenses (tenant_id, category_id, vendor_id, amount, spent_on, note)
         values ($1,$2,$3,$4,$5,$6)`,
        [tenantId, expCat(cat), vendor ? vendorId[vendor] : null, amount, spentOn, note],
      )
    }
    const nextFirst = dateStr(new Date(now.getFullYear(), now.getMonth() + 1, 1))
    await client.query(
      `insert into public.recurring_expenses (tenant_id, category_id, amount, cadence, day_of_month, next_run, note)
       values ($1,$2,'40000.00','monthly',1,$3,'Shop rent — auto every month')`,
      [tenantId, expCat('Rent'), nextFirst],
    )

    // ── payroll: salary structures + 2 months of payslips for every employee ──
    // The four non-owner staff are the "employees" for pay purposes. Each gets a
    // salary structure and a payslip for the last two completed months, so the
    // payroll cost report (which sums payslips over a 6-month window) is full.
    type Emp = { m: { id: string }; base: number; allow: { name: string; amount: string }[]; ded: number }
    const employees: Emp[] = [
      { m: manager, base: 35000, allow: [{ name: 'HRA', amount: '8000.00' }, { name: 'Transport', amount: '2000.00' }], ded: 1800 },
      { m: cashier, base: 22000, allow: [{ name: 'HRA', amount: '5000.00' }], ded: 1200 },
      { m: kitchen, base: 20000, allow: [{ name: 'HRA', amount: '4000.00' }], ded: 1000 },
      { m: floor, base: 18000, allow: [{ name: 'HRA', amount: '3500.00' }], ded: 900 },
    ]
    const allowTotal = (e: Emp) => e.allow.reduce((s, a) => s + Number(a.amount), 0)

    for (const e of employees) {
      await client.query(
        `insert into public.salary_structures (tenant_id, membership_id, base, allowances, deductions, effective_from, created_by)
         values ($1,$2,$3,$4,$5,$6,$7)`,
        [tenantId, e.m.id, money(e.base), JSON.stringify(e.allow),
         JSON.stringify([{ name: 'PF', amount: money(e.ded) }]), dateStr(at(-120)), owner.id],
      )
    }

    // The cashier took a festival advance; ₹2,000 is recovered on last month's slip.
    const adv = await client.query<{ id: string }>(
      `insert into public.employee_advances (tenant_id, membership_id, amount, instalment_amount, note, given_at, created_by)
       values ($1,$2,'6000.00','2000.00','Festival advance',$3,$4) returning id`,
      [tenantId, cashier.id, dateStr(at(-30)), owner.id],
    )
    await client.query(
      `insert into public.employee_advance_recoveries (tenant_id, advance_id, amount, source_type, created_by)
       values ($1,$2,'2000.00','payslip',$3)`,
      [tenantId, adv.rows[0].id, owner.id],
    )

    for (const e of employees) {
      for (const monthsAgo of [2, 1]) {
        const gross = e.base + allowTotal(e)
        // Recover the cashier's advance instalment on the most recent slip only.
        const advInst = e.m === cashier && monthsAgo === 1 ? 2000 : 0
        const net = +(gross - e.ded - advInst).toFixed(2)
        await client.query(
          `insert into public.payslips
             (tenant_id, membership_id, period, base, allowances, deductions, days_in_period, days_present,
              gross, deductions_total, advance_instalment, net_pay, created_by)
           values ($1,$2,$3,$4,$5,$6,30,30,$7,$8,$9,$10,$11)`,
          [
            tenantId, e.m.id, periodOf(monthsAgo), money(e.base), JSON.stringify(e.allow),
            JSON.stringify([{ name: 'PF', amount: money(e.ded) }]),
            money(gross), money(e.ded), money(advInst), money(net), owner.id,
          ],
        )
      }
    }

    // ── attendance (last 6 days for every employee) ───────────────────────────
    for (let d = 1; d <= 6; d++) {
      for (const e of employees) {
        await client.query(
          `insert into public.attendance (tenant_id, branch_id, membership_id, work_date, clock_in, clock_out)
           values ($1,$2,$3,$4,$5,$6)`,
          [tenantId, branchId, e.m.id, dateStr(at(-d)), at(-d, 10, 0), at(-d, 19, 30)],
        )
      }
    }

    // ── roster + shifts (this week) ───────────────────────────────────────────
    const roster = await client.query<{ id: string }>(
      `insert into public.rosters (tenant_id, branch_id, week_start, note) values ($1,$2,$3,'Auto-seeded week') returning id`,
      [tenantId, branchId, weekStart],
    )
    const rosterId = roster.rows[0].id
    // Morning crew (manager + kitchen) and evening crew (cashier + floor).
    const shiftPlan: [{ id: string }, string, string, string][] = [
      [manager, 'morning', '10:00', '18:00'],
      [kitchen, 'morning', '10:00', '18:00'],
      [cashier, 'evening', '15:00', '23:00'],
      [floor, 'evening', '15:00', '23:00'],
    ]
    for (let d = 0; d < 6; d++) {
      const shiftDate = dateStr((() => { const x = new Date(weekStart); x.setDate(x.getDate() + d); return x })())
      for (const [m, type, starts, ends] of shiftPlan) {
        await client.query(
          `insert into public.shifts (tenant_id, branch_id, membership_id, roster_id, shift_date, type, starts, ends)
           values ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [tenantId, branchId, m.id, rosterId, shiftDate, type, starts, ends],
        )
      }
    }

    // ── tasks ─────────────────────────────────────────────────────────────────
    // Due dates mostly within the last 30 days so the Performance report (which
    // buckets tasks by due_date) shows assigned/completed counts for everyone.
    const tasks: [string, string | null, string, string, string | null][] = [
      // title, assigned_to, status, description, due_date
      ['Restock cold drinks fridge', cashier.id, 'open', 'Beverages running low before the weekend rush.', dateStr(at(0))],
      ['Update happy-hour signage', cashier.id, 'done', 'Put up the new 5–8pm weekday board.', dateStr(at(-4))],
      ['Deep clean PS5 controllers', manager.id, 'done', 'Sanitise all controllers and check thumbsticks.', dateStr(at(-3))],
      ['Order new controller batteries', manager.id, 'in_progress', 'Stock is down to the last two sets.', dateStr(at(0))],
      ['Prep kitchen mise en place', kitchen.id, 'done', 'Portion snacks and prep the fryer before open.', dateStr(at(-1))],
      ['Label allergen info on combos', kitchen.id, 'open', 'Add peanut/dairy tags to the combo menu.', dateStr(at(-2))],
      ['Reset snooker tables & score sheets', floor.id, 'done', 'Brush the cloth and re-rack every table.', dateStr(at(-2))],
      ['Call vendor for cue repair', floor.id, 'open', 'Two cues need re-tipping.', dateStr(at(2))],
      ['Reconcile last week cash', owner.id, 'done', 'Match POS totals against the cash drawer.', dateStr(at(-2))],
    ]
    for (const [title, assignedTo, status, description, due] of tasks) {
      await client.query(
        `insert into public.tasks (tenant_id, branch_id, title, description, assigned_to, status, due_date, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [tenantId, branchId, title, description, assignedTo, status, due, owner.id],
      )
    }

    await client.query('commit')
  } catch (e) {
    await client.query('rollback')
    throw e
  } finally {
    await client.end()
  }

  console.log('\n✓ Fixtures loaded for the "demo" tenant. Highlights:')
  console.log('  • Menu (3 categories, 7 items), GST rates, happy hour, 2 promo codes')
  console.log('  • 2 membership plans + 2 sold memberships, wallet & loyalty ledgers')
  console.log('  • 5 bookings (completed / live / upcoming / online-deposit / cancelled)')
  console.log('  • Food orders + kitchen tickets (one served, one preparing, one pending)')
  console.log('  • A paid invoice (booking + food, membership discount, wallet+cash split)')
  console.log('  • 2 extra staff (kitchen + floor) — team of 5, all logins are demo1234')
  console.log('  • Payroll: salary structures, an advance + recovery, 2 months of payslips ×4')
  console.log('  • Expenses + recurring rent, vendors, attendance, roster + shifts, tasks')
  console.log('\n  Reports now show data:')
  console.log('    Payroll cost  → http://demo.lvh.me:3000/reports/payroll')
  console.log('    Employees     → http://demo.lvh.me:3000/reports/employees')
  console.log('    Performance   → http://demo.lvh.me:3000/performance')
  console.log('    Live kitchen  → http://demo.lvh.me:3000/kitchen')
  console.log('\n  Explore at http://demo.lvh.me:3000  (owner@demo.test / demo1234)')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
