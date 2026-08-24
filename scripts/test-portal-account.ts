/**
 * Portal profile, preferences, wallet and loyalty, against a real database.
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs scripts/test-portal-account.ts
 *
 * Drives the real readers and writers inside real withCustomer() transactions.
 * scripts/verify-customer-portal-rls.ts proves the POLICIES in raw SQL; this
 * proves the code paths the pages actually call.
 *
 * The reconciliation assertions matter most: the portal must never compute a
 * balance of its own, so the numbers it returns are compared against the very
 * helpers the staff profile and the till use.
 */
import { Pool } from 'pg'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { sql } from 'drizzle-orm'
import * as schema from '../db/schema'
import { loadEnv } from './env'

loadEnv()

type Db = NodePgDatabase<typeof schema>

let pass = 0
let fail = 0
const check = (label: string, cond: boolean) => {
  console.log(`${cond ? '✓' : '✗ FAIL'}  ${label}`)
  if (cond) pass++
  else fail++
}

async function main() {
  const { readPortalWallet, LEDGER_LIMIT } = await import('../lib/portal/wallet')
  const { walletBalance, loyaltyPoints } = await import('../lib/customers/ledger')
  const { readOwnProfile, updateOwnProfile, ProfileError } = await import('../lib/portal/profile')

  const owner = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })
  const appPool = new Pool({ connectionString: process.env.DATABASE_URL })
  const app = drizzle(appPool, { schema })

  /** Same contract as db/index.ts:withCustomer. */
  async function withCustomer<T>(customerId: string, fn: (tx: Db) => Promise<T>): Promise<T> {
    return app.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.customer_id', ${customerId}, true)`)
      return fn(tx as unknown as Db)
    })
  }

  /** A staff transaction, for the reconciliation comparison. */
  async function withUser<T>(userId: string, fn: (tx: Db) => Promise<T>): Promise<T> {
    return app.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`)
      return fn(tx as unknown as Db)
    })
  }

  // ── fixtures: two tenants, two customers in the first ─────────────────────
  async function makeTenant(slug: string, email: string) {
    const t = await owner.query<{ id: string }>(
      `insert into tenants (slug, name, status) values ($1, $2, 'active')
       on conflict (slug) do update set status = 'active' returning id`,
      [slug, `${slug} co`],
    )
    const u = await owner.query<{ id: string }>(
      `insert into users (email, password_hash) values ($1, 'x')
       on conflict (email) do update set email = excluded.email returning id`,
      [email],
    )
    await owner.query(
      `insert into memberships (tenant_id, user_id, role, status)
       values ($1, $2, 'owner', 'active')
       on conflict (tenant_id, user_id) do update set status = 'active'`,
      [t.rows[0].id, u.rows[0].id],
    )
    return { tenantId: t.rows[0].id, userId: u.rows[0].id }
  }

  const tA = await makeTenant('pacct', 'owner@pacct.test')
  const tB = await makeTenant('pacctb', 'owner@pacctb.test')
  const tenantIds = [tA.tenantId, tB.tenantId]

  async function wipe() {
    await owner.query('delete from wallet_transactions where tenant_id = any($1)', [tenantIds])
    await owner.query('delete from loyalty_transactions where tenant_id = any($1)', [tenantIds])
    await owner.query('delete from customers where tenant_id = any($1)', [tenantIds])
  }
  await wipe()

  async function makeCustomer(tenantId: string, phone: string, name: string) {
    const c = await owner.query<{ id: string }>(
      `insert into customers (tenant_id, phone, name) values ($1,$2,$3) returning id`,
      [tenantId, phone, name],
    )
    return c.rows[0].id
  }

  const alice = await makeCustomer(tA.tenantId, '+919000008001', 'Alice')
  const bob = await makeCustomer(tA.tenantId, '+919000008002', 'Bob')
  const carol = await makeCustomer(tB.tenantId, '+919000008003', 'Carol')

  async function wallet(tenantId: string, customerId: string, amount: string, source: string, ago: string) {
    await owner.query(
      `insert into wallet_transactions (tenant_id, customer_id, amount, reason, source_type, created_at)
       values ($1,$2,$3,$4,$5, now() - $6::interval)`,
      [tenantId, customerId, amount, `${source} note`, source, ago],
    )
  }
  async function loyalty(tenantId: string, customerId: string, points: number, source: string, ago: string) {
    await owner.query(
      `insert into loyalty_transactions (tenant_id, customer_id, points, reason, source_type, created_at)
       values ($1,$2,$3,$4,$5, now() - $6::interval)`,
      [tenantId, customerId, points, `${source} note`, source, ago],
    )
  }

  // Alice: +1000 topup, −300 booking, +500 refund  → 1200.00
  await wallet(tA.tenantId, alice, '1000.00', 'topup', '3 days')
  await wallet(tA.tenantId, alice, '-300.00', 'booking', '2 days')
  await wallet(tA.tenantId, alice, '500.00', 'refund', '1 day')
  // Alice loyalty: +10, +40, −20 → 30
  await loyalty(tA.tenantId, alice, 10, 'invoice_earn', '3 days')
  await loyalty(tA.tenantId, alice, 40, 'invoice_earn', '2 days')
  await loyalty(tA.tenantId, alice, -20, 'invoice_redeem', '1 day')

  // Bob and Carol get very different, unmistakable numbers.
  await wallet(tA.tenantId, bob, '9999.00', 'topup', '1 day')
  await loyalty(tA.tenantId, bob, 4242, 'invoice_earn', '1 day')
  await wallet(tB.tenantId, carol, '7777.00', 'topup', '1 day')
  await loyalty(tB.tenantId, carol, 3131, 'invoice_earn', '1 day')

  // ══ 1. balances, and reconciliation with the POS ═══════════════════════════
  console.log('\n── balances ──')

  const data = await withCustomer(alice, (tx) => readPortalWallet(tx, tA.tenantId, alice))
  check('wallet balance is the signed sum of the ledger', data.walletBalance === 1200)
  check('loyalty points are the signed sum of the ledger', data.loyaltyPoints === 30)

  // The same helpers the staff profile and the till use, run from a STAFF
  // transaction. If the portal ever grew its own arithmetic this diverges.
  const posWallet = await withUser(tA.userId, (tx) => walletBalance(tx, tA.tenantId, alice))
  const posPoints = await withUser(tA.userId, (tx) => loyaltyPoints(tx, tA.tenantId, alice))
  check('portal wallet balance === walletBalance() as staff sees it', data.walletBalance === posWallet)
  check('portal loyalty points === loyaltyPoints() as staff sees it', data.loyaltyPoints === posPoints)

  // Independent arithmetic, straight from the table, as a third opinion.
  const raw = await owner.query<{ w: string; p: string }>(
    `select coalesce((select sum(amount) from wallet_transactions where customer_id=$1),0)::text w,
            coalesce((select sum(points) from loyalty_transactions where customer_id=$1),0)::text p`,
    [alice],
  )
  check('…and both match a raw SUM over the tables', Number(raw.rows[0].w) === 1200 && Number(raw.rows[0].p) === 30)

  // ══ 2. activity ════════════════════════════════════════════════════════════
  console.log('\n── activity ──')

  check('wallet activity returns every entry', data.wallet.length === 3)
  check(
    'wallet activity is newest first',
    data.wallet[0].createdAt.getTime() > data.wallet[1].createdAt.getTime() &&
      data.wallet[1].createdAt.getTime() > data.wallet[2].createdAt.getTime(),
  )
  check('the newest wallet entry is the refund', data.wallet[0].sourceType === 'refund')
  check('credits keep a positive sign', Number(data.wallet[0].amount) > 0)
  check('debits keep a negative sign', data.wallet.some((e) => Number(e.amount) === -300))
  check('createdAt is a real Date', data.wallet[0].createdAt instanceof Date)

  check('loyalty activity returns every entry', data.loyalty.length === 3)
  check(
    'loyalty activity is newest first',
    data.loyalty[0].createdAt.getTime() > data.loyalty[1].createdAt.getTime(),
  )
  check('the newest loyalty entry is the redemption', data.loyalty[0].sourceType === 'invoice_redeem')
  check('redemptions are negative', Number(data.loyalty[0].amount) === -20)
  check('earnings are positive', data.loyalty.some((e) => Number(e.amount) === 40))

  // The LIMIT is real, and the limit takes the NEWEST rows.
  for (let i = 0; i < LEDGER_LIMIT + 5; i++) {
    await wallet(tA.tenantId, alice, '1.00', 'adjustment', `${i + 10} minutes`)
  }
  const capped = await withCustomer(alice, (tx) => readPortalWallet(tx, tA.tenantId, alice))
  check(`wallet activity is capped at ${LEDGER_LIMIT} rows`, capped.wallet.length === LEDGER_LIMIT)
  check(
    '…and the balance still counts EVERY row, not just the listed ones',
    capped.walletBalance === 1200 + (LEDGER_LIMIT + 5),
  )
  check(
    '…and the rows kept are the newest',
    capped.wallet[0].createdAt.getTime() >= capped.wallet[LEDGER_LIMIT - 1].createdAt.getTime(),
  )

  // ══ 3. empty states ════════════════════════════════════════════════════════
  console.log('\n── empty ──')

  const fresh = await makeCustomer(tA.tenantId, '+919000008009', 'Newbie')
  const empty = await withCustomer(fresh, (tx) => readPortalWallet(tx, tA.tenantId, fresh))
  check('a customer with no ledger has a zero wallet balance', empty.walletBalance === 0)
  check('…and zero points', empty.loyaltyPoints === 0)
  check('…and empty activity lists, not an error', empty.wallet.length === 0 && empty.loyalty.length === 0)

  // ══ 4. isolation ═══════════════════════════════════════════════════════════
  console.log('\n── isolation ──')

  check("Alice's data contains none of Bob's amounts", !capped.wallet.some((e) => e.amount === '9999.00'))

  const bobData = await withCustomer(bob, (tx) => readPortalWallet(tx, tA.tenantId, bob))
  check('Bob sees his own balance', bobData.walletBalance === 9999)
  check('…and his own points', bobData.loyaltyPoints === 4242)
  check('…and only his own single wallet entry', bobData.wallet.length === 1)

  // Alice's session, Bob's id passed to the helper: RLS must still win.
  const spoof = await withCustomer(alice, (tx) => readPortalWallet(tx, tA.tenantId, bob))
  check(
    "Alice's context cannot read Bob's ledger even when handed Bob's id",
    spoof.walletBalance === 0 && spoof.loyaltyPoints === 0 && spoof.wallet.length === 0,
  )

  const crossTenant = await withCustomer(alice, (tx) => readPortalWallet(tx, tB.tenantId, carol))
  check(
    "…nor Carol's, in another tenant",
    crossTenant.walletBalance === 0 && crossTenant.loyalty.length === 0,
  )

  const carolData = await withCustomer(carol, (tx) => readPortalWallet(tx, tB.tenantId, carol))
  check('Carol still sees her own balance in her own tenant', carolData.walletBalance === 7777)

  // ══ 5. profile & preferences ═══════════════════════════════════════════════
  console.log('\n── profile ──')

  const p0 = await withCustomer(alice, (tx) => readOwnProfile(tx, alice))
  check('the profile reads back the name', p0.name === 'Alice')
  check('email starts empty', p0.email === '')
  check('phone is exposed for display', p0.phone === '+919000008001')
  check('sms opt-in defaults to true', p0.smsOptIn === true)
  check('email opt-in defaults to true', p0.emailOptIn === true)

  await withCustomer(alice, (tx) =>
    updateOwnProfile(tx, {
      name: '  Alice Smith  ',
      email: '  Alice@Example.COM ',
      smsOptIn: false,
      emailOptIn: true,
    }),
  )
  const p1 = await withCustomer(alice, (tx) => readOwnProfile(tx, alice))
  check('name is updated and trimmed', p1.name === 'Alice Smith')
  check('email is updated, trimmed and lower-cased', p1.email === 'alice@example.com')
  check('sms opt-out persists', p1.smsOptIn === false)
  check('email opt-in persists', p1.emailOptIn === true)
  check('PHONE IS UNCHANGED', p1.phone === '+919000008001')

  // Clearing is allowed — the columns are nullable.
  await withCustomer(alice, (tx) =>
    updateOwnProfile(tx, { name: '', email: '', smsOptIn: true, emailOptIn: false }),
  )
  const p2 = await withCustomer(alice, (tx) => readOwnProfile(tx, alice))
  check('an empty email clears the field', p2.email === '')
  check('an empty name clears the field', p2.name === '')
  check('preferences flip back', p2.smsOptIn === true && p2.emailOptIn === false)

  let rejected = false
  try {
    await withCustomer(alice, (tx) =>
      updateOwnProfile(tx, { name: 'x', email: 'not-an-email', smsOptIn: true, emailOptIn: true }),
    )
  } catch {
    rejected = true
  }
  check('an invalid email is rejected', rejected)
  const p3 = await withCustomer(alice, (tx) => readOwnProfile(tx, alice))
  check('…and nothing was written', p3.name === '' && p3.email === '')

  // ── the columns a customer must NOT be able to reach ──
  const before = await owner.query<{ phone: string; tags: string[]; membership_status: string | null }>(
    'select phone, tags, membership_status from customers where id = $1',
    [alice],
  )
  await owner.query('update customers set tags = $1, membership_status = $2 where id = $3', [
    ['vip'],
    'active',
    alice,
  ])
  await withCustomer(alice, (tx) =>
    updateOwnProfile(tx, { name: 'Alice', email: '', smsOptIn: true, emailOptIn: true }),
  )
  const after = await owner.query<{ phone: string; tags: string[]; membership_status: string | null }>(
    'select phone, tags, membership_status from customers where id = $1',
    [alice],
  )
  check('saving the profile leaves phone untouched', after.rows[0].phone === before.rows[0].phone)
  check('…leaves staff tags untouched', after.rows[0].tags[0] === 'vip')
  check('…and leaves membership_status untouched', after.rows[0].membership_status === 'active')

  // Direct UPDATE must be refused: there is no customer update policy at all.
  let directBlocked = false
  try {
    const r = await app.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.customer_id', ${alice}, true)`)
      return tx.execute(sql`update public.customers set phone = '+919999999999' where id = ${alice}::uuid`)
    })
    directBlocked = r.rowCount === 0
  } catch {
    directBlocked = true
  }
  check('a customer cannot UPDATE their own row directly (no policy exists)', directBlocked)

  // …and the function itself must refuse a cross-customer edit.
  const bobBefore = await owner.query<{ name: string }>('select name from customers where id=$1', [bob])
  await withCustomer(alice, (tx) =>
    updateOwnProfile(tx, { name: 'HACKED', email: '', smsOptIn: true, emailOptIn: true }),
  )
  const bobAfter = await owner.query<{ name: string }>('select name from customers where id=$1', [bob])
  check("editing as Alice never touches Bob's row", bobAfter.rows[0].name === bobBefore.rows[0].name)

  // With NO customer context the function must be inert.
  const noCtx = await app.execute(
    sql`select public.customer_update_profile('X', null, true, true) as ok`,
  )
  check(
    'customer_update_profile() is a no-op with no customer context',
    (noCtx.rows[0] as { ok: boolean }).ok === false,
  )

  let readerThrows = false
  try {
    await withCustomer(bob, (tx) => readOwnProfile(tx, alice))
  } catch (e) {
    readerThrows = e instanceof ProfileError
  }
  check("reading Alice's profile from Bob's context yields nothing", readerThrows)

  await wipe()
  await owner.end()
  await appPool.end()

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
