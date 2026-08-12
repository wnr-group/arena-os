/**
 * Promo codes — integration tests against a real database.
 *
 * Drives validatePromo/consumePromoUse and the real billing core
 * (issueInvoiceForBooking) on RLS-scoped transactions through `arena_app`:
 *   - percentage and fixed discounts, capped at the subtotal
 *   - inactive / not-yet-started / expired / exhausted codes are refused
 *   - lookup is case-insensitive and whitespace-tolerant, and tenant-scoped
 *   - one invoice consumes exactly one use; a failed bill consumes none
 *   - the last use of a limited promo goes to exactly one of two racing tills
 *   - RLS: members read, only managers write
 *
 *   npx tsx scripts/test-promo.ts
 */
import { Pool } from 'pg'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { sql } from 'drizzle-orm'
import * as schema from '../db/schema'
import { BillingError, issueInvoiceForBooking } from '../lib/billing/invoice'
import { consumePromoUse, normalizePromoCode, validatePromo } from '../lib/billing/promo'
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
const DAY = 86_400_000

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

  /**
   * Run one statement as `userId`.
   *
   * Returns the row count as well as success, because RLS refuses the two in
   * DIFFERENT ways: an INSERT that violates WITH CHECK raises 42501, but an
   * UPDATE/DELETE whose USING clause hides the row simply touches 0 rows and
   * commits happily. Only checking "did it throw" would call that a pass.
   */
  async function tryAs(userId: string, q: string, params: unknown[] = []) {
    const client = await appPool.connect()
    try {
      await client.query('begin')
      await client.query(`select set_config('app.user_id',$1,true)`, [userId])
      const r = await client.query(q, params)
      await client.query('commit')
      return { ok: true as const, rowCount: r.rowCount ?? 0 }
    } catch {
      await client.query('rollback')
      return { ok: false as const, rowCount: 0 }
    } finally {
      client.release()
    }
  }

  type Actor = { userId: string; tenantId: string; branchId: string; resourceId: string }

  async function makeTenant(slug: string): Promise<Actor & { cashierId: string; managerId: string }> {
    const t = await ownerPool.query<{ id: string }>(
      `insert into tenants (slug,name,status,timezone) values ($1,$2,'active',$3)
       on conflict (slug) do update set name=excluded.name returning id`, [slug, `${slug} co`, TZ])
    const tenantId = t.rows[0].id
    const b = await ownerPool.query<{ id: string }>(
      `insert into branches (tenant_id,name,is_primary) values ($1,'Main',true)
       on conflict (tenant_id,name) do update set is_primary=true returning id`, [tenantId])
    const mkUser = async (email: string, role: string) => {
      const u = await ownerPool.query<{ id: string }>(
        `insert into users (email,password_hash) values ($1,'x')
         on conflict (email) do update set email=excluded.email returning id`, [email])
      await ownerPool.query(
        `insert into memberships (tenant_id,user_id,role,status) values ($1,$2,$3,'active')
         on conflict (tenant_id,user_id) do update set role=excluded.role, status='active'`,
        [tenantId, u.rows[0].id, role])
      return u.rows[0].id
    }
    const userId = await mkUser(`owner@${slug}.test`, 'owner')
    const cashierId = await mkUser(`cashier@${slug}.test`, 'cashier')
    const managerId = await mkUser(`manager@${slug}.test`, 'manager')
    const rt = await ownerPool.query<{ id: string }>(
      `insert into resource_types (tenant_id,name,hourly_rate) values ($1,'PS5','500.00')
       on conflict (tenant_id,name) do update set hourly_rate='500.00' returning id`, [tenantId])
    const res = await ownerPool.query<{ id: string }>(
      `insert into resources (tenant_id,branch_id,resource_type_id,name) values ($1,$2,$3,'S1')
       on conflict (tenant_id,name) do update set name='S1' returning id`, [tenantId, b.rows[0].id, rt.rows[0].id])
    return { userId, tenantId, branchId: b.rows[0].id, resourceId: res.rows[0].id, cashierId, managerId }
  }

  /** A promo row via the owner connection (fixtures bypass RLS). */
  async function makePromo(
    tenantId: string,
    code: string,
    o: { type?: 'percentage' | 'fixed'; value?: string; from?: Date; until?: Date; maxUses?: number | null; uses?: number; active?: boolean } = {},
  ) {
    const now = Date.now()
    const {
      type = 'percentage', value = '10.00',
      from = new Date(now - DAY), until = new Date(now + DAY),
      maxUses = null, uses = 0, active = true,
    } = o
    const r = await ownerPool.query<{ id: string }>(
      `insert into promo_codes (tenant_id,code,discount_type,discount_value,valid_from,valid_until,max_uses,uses,is_active)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
      [tenantId, code, type, value, from, until, maxUses, uses, active])
    return r.rows[0].id
  }

  const usesOf = async (id: string) =>
    Number((await ownerPool.query('select uses from promo_codes where id=$1', [id])).rows[0].uses)

  let seq = 0
  /** A confirmed booking worth `total` rupees (2h at total/2 per hour). */
  async function makeBooking(t: Actor, total = 1000) {
    const n = ++seq
    const bk = await ownerPool.query<{ id: string }>(
      `insert into bookings (tenant_id,branch_id,booking_number,status,subtotal,total)
       values ($1,$2,$3,'confirmed','0','0') returning id`, [t.tenantId, t.branchId, `PR-${n}`])
    const s = new Date(Date.UTC(2034, 0, n, 4, 0, 0))
    await ownerPool.query(
      `insert into booking_slots (tenant_id,booking_id,resource_id,starts_at,ends_at,rate_applied,slot_total,resource_name,resource_type_name,active)
       values ($1,$2,$3,$4,$5,$6,$7,'S1','PS5',true)`,
      [t.tenantId, bk.rows[0].id, t.resourceId, s, new Date(s.getTime() + 2 * 3600_000), (total / 2).toFixed(2), total.toFixed(2)])
    return bk.rows[0].id
  }

  async function bill(t: Actor, bookingId: string, promoCode?: string, discount?: number) {
    try {
      const r = await withUser(t.userId, (tx) =>
        issueInvoiceForBooking(tx, { id: t.tenantId, timezone: TZ }, { bookingId, promoCode, discount }))
      return { ok: true as const, ...r }
    } catch (e) {
      return { ok: false as const, billing: e instanceof BillingError, message: e instanceof Error ? e.message : String(e) }
    }
  }

  const A = await makeTenant('testpromoa')
  const B = await makeTenant('testpromob')
  for (const t of [A, B]) {
    await ownerPool.query('delete from invoices where tenant_id=$1', [t.tenantId])
    await ownerPool.query('delete from bookings where tenant_id=$1', [t.tenantId])
    await ownerPool.query('delete from promo_codes where tenant_id=$1', [t.tenantId])
    await ownerPool.query('delete from sequences where tenant_id=$1', [t.tenantId])
  }

  const validate = (t: Actor, code: string, subtotal: number) =>
    withUser(t.userId, (tx) => validatePromo(tx, t.tenantId, code, subtotal))

  // ── 0. normalisation ──────────────────────────────────────────────────────
  check("normalizePromoCode trims and upper-cases (' welcome10 ' → WELCOME10)", normalizePromoCode(' welcome10 ') === 'WELCOME10')
  check('normalizePromoCode returns null for blank input', normalizePromoCode('   ') === null && normalizePromoCode(null) === null)

  // ── 1. percentage ─────────────────────────────────────────────────────────
  {
    await makePromo(A.tenantId, 'WELCOME10', { type: 'percentage', value: '10.00' })
    const r = await validate(A, 'WELCOME10', 1000)
    check('₹1000 @ WELCOME10 (10%) → discount 100', r.ok && r.discount === 100)
    const odd = await validate(A, 'WELCOME10', 333.33)
    check('a percentage rounds to paise (10% of 333.33 → 33.33)', odd.ok && odd.discount === 33.33)
  }

  // ── 2. fixed ──────────────────────────────────────────────────────────────
  {
    await makePromo(A.tenantId, 'FLAT50', { type: 'fixed', value: '50.00' })
    const r = await validate(A, 'FLAT50', 1000)
    check('₹1000 @ FLAT50 → discount 50', r.ok && r.discount === 50)
  }

  // ── 3. capped at the subtotal ─────────────────────────────────────────────
  {
    await makePromo(A.tenantId, 'FLAT500', { type: 'fixed', value: '500.00' })
    const r = await validate(A, 'FLAT500', 100)
    check('₹100 @ FLAT500 → discount capped at 100, never 500', r.ok && r.discount === 100)
    const zero = await validate(A, 'FLAT500', 0)
    check('a ₹0 subtotal yields a ₹0 discount, never negative', zero.ok && zero.discount === 0)
    const full = await validate(A, 'FLAT500', 500)
    check('an exactly-equal fixed promo clears the bill to 0', full.ok && full.discount === 500)
  }

  // ── 4. case-insensitive + whitespace ──────────────────────────────────────
  {
    const forms = ['welcome10', 'WELCOME10', 'Welcome10', ' welcome10 ', '  WeLcOmE10']
    const ids = new Set<string>()
    for (const f of forms) {
      const r = await validate(A, f, 1000)
      if (r.ok) ids.add(r.promoId)
    }
    check(`all ${forms.length} spellings resolve to ONE promo`, ids.size === 1)

    // The DB must refuse a second casing of the same code in one tenant …
    let dupe = true
    try { await makePromo(A.tenantId, 'welcome10') } catch { dupe = false }
    check('a duplicate code in a different casing is REJECTED (unique on upper(code))', !dupe)
    // … but the same string in another tenant is a different promo.
    const bId = await makePromo(B.tenantId, 'WELCOME10', { type: 'fixed', value: '7.00' })
    check('the same code in another tenant is allowed', Boolean(bId))
    const bR = await validate(B, 'WELCOME10', 1000)
    check("…and resolves to that tenant's own promo (₹7, not 10%)", bR.ok && bR.discount === 7 && bR.promoId === bId)
  }

  // ── 5. rejection reasons ──────────────────────────────────────────────────
  {
    const missing = await validate(A, 'NOSUCHCODE', 1000)
    check('unknown code → "Promo code not found."', !missing.ok && missing.reason === 'Promo code not found.')

    await makePromo(A.tenantId, 'OFF', { active: false })
    const off = await validate(A, 'OFF', 1000)
    check('inactive → "Promo code is inactive."', !off.ok && off.reason === 'Promo code is inactive.')

    await makePromo(A.tenantId, 'FUTURE', { from: new Date(Date.now() + DAY), until: new Date(Date.now() + 2 * DAY) })
    const future = await validate(A, 'FUTURE', 1000)
    check('before valid_from → "Promo code is not active yet."', !future.ok && future.reason === 'Promo code is not active yet.')

    await makePromo(A.tenantId, 'PAST', { from: new Date(Date.now() - 2 * DAY), until: new Date(Date.now() - DAY) })
    const past = await validate(A, 'PAST', 1000)
    check('after valid_until → "Promo code has expired."', !past.ok && past.reason === 'Promo code has expired.')

    await makePromo(A.tenantId, 'SPENT', { maxUses: 100, uses: 100 })
    const spent = await validate(A, 'SPENT', 1000)
    check('uses >= max_uses → "Promo code usage limit reached."', !spent.ok && spent.reason === 'Promo code usage limit reached.')

    const blank = await validate(A, '   ', 1000)
    check('a blank code → "Enter a promo code."', !blank.ok && blank.reason === 'Enter a promo code.')
  }

  // ── 6. usage limits ───────────────────────────────────────────────────────
  {
    await makePromo(A.tenantId, 'UNLIMITED', { maxUses: null, uses: 9999 })
    const unl = await validate(A, 'UNLIMITED', 1000)
    check('max_uses null stays valid however many uses it has', unl.ok)

    await makePromo(A.tenantId, 'LASTONE', { maxUses: 10, uses: 9 })
    const last = await validate(A, 'LASTONE', 1000)
    check('max_uses 10 / uses 9 → still valid', last.ok)
  }

  // ── 7. boundaries of the validity window ──────────────────────────────────
  {
    // valid_from exactly now-ish and valid_until far ahead: inside the window.
    await makePromo(A.tenantId, 'EDGEIN', { from: new Date(Date.now() - 1000), until: new Date(Date.now() + DAY) })
    check('a promo whose window opened a second ago is valid', (await validate(A, 'EDGEIN', 100)).ok)
    await makePromo(A.tenantId, 'EDGEOUT', { from: new Date(Date.now() - 2 * DAY), until: new Date(Date.now() - 1000) })
    check('a promo whose window closed a second ago is expired', !(await validate(A, 'EDGEOUT', 100)).ok)
  }

  // ── 8. tenant isolation ───────────────────────────────────────────────────
  {
    const aOnly = await makePromo(A.tenantId, 'ATENANTONLY', { type: 'fixed', value: '99.00' })
    const crossValidate = await validate(B, 'ATENANTONLY', 1000)
    check("tenant B cannot validate tenant A's promo", !crossValidate.ok && crossValidate.reason === 'Promo code not found.')

    const crossConsume = await withUser(B.userId, (tx) => consumePromoUse(tx, B.tenantId, aOnly))
    check("tenant B cannot consume tenant A's promo (wrong tenant id)", crossConsume === false)
    const spoof = await withUser(B.userId, (tx) => consumePromoUse(tx, A.tenantId, aOnly))
    check("…nor by passing tenant A's tenant id (function filters on the caller)", spoof === false)
    check('…and tenant A’s usage is untouched', (await usesOf(aOnly)) === 0)

    const crossRead = await withUser(B.userId, (tx) =>
      tx.execute(sql`select id from promo_codes where id = ${aOnly}`))
    check("tenant B cannot even SELECT tenant A's promo row (RLS)", crossRead.rows.length === 0)
  }

  // ── 9. RLS write rules ────────────────────────────────────────────────────
  {
    const ins = `insert into promo_codes (tenant_id,code,discount_type,discount_value,valid_from,valid_until)
                 values ($1,$2,'fixed','5.00',now()-interval '1 day',now()+interval '1 day')`
    check('a MANAGER can insert a promo', (await tryAs(A.managerId, ins, [A.tenantId, 'MGRMADE'])).ok)
    check('a CASHIER cannot insert a promo', !(await tryAs(A.cashierId, ins, [A.tenantId, 'CASHIERMADE'])).ok)

    const target = await makePromo(A.tenantId, 'RLSTARGET', { type: 'fixed', value: '5.00' })
    const valueOf = async () =>
      (await ownerPool.query('select discount_value from promo_codes where id=$1', [target])).rows[0]?.discount_value

    const cashierUpdate = await tryAs(A.cashierId, `update promo_codes set discount_value='999.00' where id=$1`, [target])
    check('a cashier’s UPDATE touches 0 rows (promo_write is manager-only)', cashierUpdate.rowCount === 0)
    check('…and the promo is genuinely unchanged at 5.00', (await valueOf()) === '5.00')

    const cashierDelete = await tryAs(A.cashierId, 'delete from promo_codes where id=$1', [target])
    check('a cashier’s DELETE touches 0 rows', cashierDelete.rowCount === 0)
    check('…and the promo still exists', (await valueOf()) === '5.00')

    const managerUpdate = await tryAs(A.managerId, `update promo_codes set discount_value='6.00' where id=$1`, [target])
    check('a manager CAN update a promo', managerUpdate.ok && managerUpdate.rowCount === 1)
    check('…and the change landed', (await valueOf()) === '6.00')

    const cashierRead = await withUser(A.cashierId, (tx) =>
      tx.execute(sql`select id from promo_codes where id = ${target}`))
    check('a cashier CAN read promos (needed to quote a code at the till)', cashierRead.rows.length === 1)

    check("a manager cannot insert into ANOTHER tenant", !(await tryAs(A.managerId, ins, [B.tenantId, 'CROSSMADE'])).ok)

    // The cashier's ONLY legitimate write is one use, through the function.
    const consumable = await makePromo(A.tenantId, 'CASHIERUSE', { type: 'fixed', value: '5.00', maxUses: 3 })
    const consumed = await withUser(A.cashierId, (tx) => consumePromoUse(tx, A.tenantId, consumable))
    check('a cashier CAN record a use via consume_promo_use()', consumed === true)
    check('…and it incremented by exactly 1', (await usesOf(consumable)) === 1)
  }

  // ── 10. billing integration ───────────────────────────────────────────────
  {
    const promoId = await makePromo(A.tenantId, 'BILL10', { type: 'percentage', value: '10.00' })
    const r = await bill(A, await makeBooking(A, 1000), 'bill10')
    check('a bill with a valid promo succeeds (code typed in lower case)', r.ok)
    if (r.ok) {
      const inv = (await ownerPool.query('select subtotal,discount,total,promo_code_id from invoices where id=$1', [r.invoiceId])).rows[0]
      check('invoice subtotal is 1000.00', inv.subtotal === '1000.00')
      check('invoice discount is the promo discount (100.00)', inv.discount === '100.00')
      check('invoice total is 900.00 (discount before GST, via priceBill)', inv.total === '900.00')
      check('invoice.promo_code_id records WHICH promo was used', inv.promo_code_id === promoId)
      check('the promo recorded exactly one use', (await usesOf(promoId)) === 1)
    }

    // A second invoice consumes exactly one more.
    await bill(A, await makeBooking(A, 1000), 'BILL10')
    check('a second bill takes the count to exactly 2', (await usesOf(promoId)) === 2)

    // A bill with no promo touches nothing.
    const plain = await bill(A, await makeBooking(A, 1000))
    check('a bill with NO promo still works', plain.ok)
    if (plain.ok) {
      const inv = (await ownerPool.query('select discount,promo_code_id from invoices where id=$1', [plain.invoiceId])).rows[0]
      check('…with promo_code_id null and no discount', inv.promo_code_id === null && inv.discount === '0.00')
    }
    check('…and the promo count is unchanged at 2', (await usesOf(promoId)) === 2)

    // A fixed promo through the full billing path.
    const fixedId = await makePromo(A.tenantId, 'BILLFLAT', { type: 'fixed', value: '250.00' })
    const f = await bill(A, await makeBooking(A, 1000), 'BILLFLAT')
    check('a fixed promo bills at 1000 − 250 = 750', f.ok && (await ownerPool.query('select total from invoices where id=$1', [f.invoiceId])).rows[0].total === '750.00')
    check('…and consumed one use', (await usesOf(fixedId)) === 1)

    // A promo replaces a typed discount rather than stacking with it.
    const bothId = await makePromo(A.tenantId, 'BILLBOTH', { type: 'fixed', value: '100.00' })
    const both = await bill(A, await makeBooking(A, 1000), 'BILLBOTH', 400)
    check('a promo overrides a manually typed discount (100, not 500)', both.ok && (await ownerPool.query('select discount from invoices where id=$1', [both.invoiceId])).rows[0].discount === '100.00')
    check('…and still consumed exactly one use', (await usesOf(bothId)) === 1)
  }

  // ── 11. a failed bill must not consume a use ──────────────────────────────
  {
    // Invalid code → no invoice at all.
    const before = (await ownerPool.query('select count(*)::int n from invoices where tenant_id=$1', [A.tenantId])).rows[0].n
    const bad = await bill(A, await makeBooking(A, 1000), 'NOSUCHCODE')
    check('an invalid promo REFUSES the bill', !bad.ok && bad.billing && bad.message === 'Promo code not found.')
    const after = (await ownerPool.query('select count(*)::int n from invoices where tenant_id=$1', [A.tenantId])).rows[0].n
    check('…and creates no invoice', after === before)

    const expiredId = await makePromo(A.tenantId, 'BILLEXPIRED', { from: new Date(Date.now() - 2 * DAY), until: new Date(Date.now() - DAY) })
    const exp = await bill(A, await makeBooking(A, 1000), 'BILLEXPIRED')
    check('an expired promo refuses the bill', !exp.ok && exp.message === 'Promo code has expired.')
    check('…and consumes no use', (await usesOf(expiredId)) === 0)

    // Valid promo, but the BILL fails for an unrelated reason (already billed).
    const rollbackId = await makePromo(A.tenantId, 'ROLLBACK', { type: 'fixed', value: '10.00' })
    const booking = await makeBooking(A, 1000)
    const first = await bill(A, booking, 'ROLLBACK')
    check('first bill on the booking succeeds', first.ok)
    check('…consuming one use', (await usesOf(rollbackId)) === 1)
    const second = await bill(A, booking, 'ROLLBACK')
    check('re-billing the same booking is refused', !second.ok && /already been billed/i.test(second.message))
    check('…and the rollback returned the use (still 1, not 2)', (await usesOf(rollbackId)) === 1)
  }

  // ── 12. the last use, and the race for it ─────────────────────────────────
  {
    const lastId = await makePromo(A.tenantId, 'LASTUSE', { type: 'fixed', value: '10.00', maxUses: 10, uses: 9 })
    const ok = await bill(A, await makeBooking(A, 1000), 'LASTUSE')
    check('the 10th of 10 uses bills successfully', ok.ok)
    check('…taking uses to exactly 10', (await usesOf(lastId)) === 10)
    const over = await bill(A, await makeBooking(A, 1000), 'LASTUSE')
    check('the 11th attempt is refused', !over.ok && /usage limit reached/i.test(over.message))
    check('…and uses never exceeds max_uses', (await usesOf(lastId)) === 10)

    // Two tills racing for a single remaining use.
    const raceId = await makePromo(A.tenantId, 'RACE1', { type: 'fixed', value: '10.00', maxUses: 5, uses: 4 })
    const b1 = await makeBooking(A, 1000)
    const b2 = await makeBooking(A, 1000)
    const race = await Promise.all([bill(A, b1, 'RACE1'), bill(A, b2, 'RACE1')])
    check('two simultaneous bills on the LAST use → exactly one succeeds', race.filter((r) => r.ok).length === 1)
    check('…uses lands on exactly 5, never 6', (await usesOf(raceId)) === 5)
    check('…and the loser was told the limit was reached', race.some((r) => !r.ok && /usage limit reached/i.test(r.message)))

    // Five racers, three uses left.
    const manyId = await makePromo(A.tenantId, 'RACE2', { type: 'fixed', value: '10.00', maxUses: 3, uses: 0 })
    const bookings = await Promise.all(Array.from({ length: 5 }, () => makeBooking(A, 1000)))
    const results = await Promise.all(bookings.map((b) => bill(A, b, 'RACE2')))
    check('5 simultaneous bills with 3 uses available → exactly 3 succeed', results.filter((r) => r.ok).length === 3)
    check('…uses lands on exactly 3', (await usesOf(manyId)) === 3)

    // Global invariant.
    const breached = await ownerPool.query(
      'select id from promo_codes where max_uses is not null and uses > max_uses and tenant_id = any($1)',
      [[A.tenantId, B.tenantId]])
    check('NO promo anywhere has uses > max_uses', breached.rows.length === 0)
  }

  // ── 13. an invoice cannot cite another tenant's promo (composite FK) ──────
  {
    const aPromo = await makePromo(A.tenantId, 'FKCHECK', { type: 'fixed', value: '5.00' })
    let refused = false
    try {
      await ownerPool.query(
        `insert into invoices (tenant_id,branch_id,invoice_number,promo_code_id,total)
         values ($1,$2,'FK-SMUGGLE',$3,'1.00')`, [B.tenantId, B.branchId, aPromo])
    } catch { refused = true }
    check("an invoice CANNOT reference another tenant's promo (composite FK)", refused)
  }

  // ── cleanup ───────────────────────────────────────────────────────────────
  await ownerPool.query('delete from tenants where id = any($1)', [[A.tenantId, B.tenantId]])
  await ownerPool.query(`delete from users where email like '%@testpromo%.test'`)
  await ownerPool.end()
  await appPool.end()

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
