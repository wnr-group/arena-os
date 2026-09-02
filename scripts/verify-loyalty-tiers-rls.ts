/**
 * Proves the loyalty_tiers table's isolation and role rules (migration 0049),
 * and that the LIFETIME points basis behaves against a real ledger.
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs scripts/verify-loyalty-tiers-rls.ts
 *
 * The pure computation is covered by scripts/test-loyalty-tiers.ts, which needs
 * no database. This file covers everything that one cannot: the migration's
 * shape, the policies, the grants, the seeded defaults, and — the assertion
 * that matters most — that redeeming points does NOT lower a customer's tier.
 */
import { Client } from 'pg'
import { Pool } from 'pg'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { sql } from 'drizzle-orm'
import * as schema from '../db/schema'
import { loadEnv } from './env'

loadEnv()

type Db = NodePgDatabase<typeof schema>

let passed = 0
let failed = 0
const check = (label: string, cond: boolean) => {
  console.log(`${cond ? '✓' : '✗ FAIL'}  ${label}`)
  if (cond) passed++
  else failed++
}

async function main() {
  const { loadLoyaltyTiers, lifetimeLoyaltyPoints } = await import('../lib/loyalty/data')
  const { loyaltyPoints } = await import('../lib/customers/ledger')
  const { computeTierStanding, DEFAULT_TIERS } = await import('../lib/loyalty/tiers')

  const owner = new Client({ connectionString: process.env.DATABASE_URL_OWNER })
  await owner.connect()
  const appPool = new Pool({ connectionString: process.env.DATABASE_URL })
  const app = drizzle(appPool, { schema })

  // ── migration shape ───────────────────────────────────────────────────────
  console.log('\n── migration ──')

  const tbl = await owner.query(
    `select column_name from information_schema.columns
      where table_schema='public' and table_name='loyalty_tiers'`,
  )
  const cols = tbl.rows.map((r) => r.column_name as string)
  check('loyalty_tiers exists', cols.length > 0)
  for (const c of ['id', 'tenant_id', 'name', 'threshold', 'perk', 'sort_order', 'created_at', 'updated_at']) {
    check(`…has ${c}`, cols.includes(c))
  }

  const rls = await owner.query<{ relrowsecurity: boolean }>(
    `select relrowsecurity from pg_class where oid = 'public.loyalty_tiers'::regclass`,
  )
  check('RLS is enabled', rls.rows[0].relrowsecurity === true)

  const pol = await owner.query<{ policyname: string; cmd: string }>(
    `select policyname, cmd from pg_policies
      where schemaname='public' and tablename='loyalty_tiers' order by policyname`,
  )
  const names = pol.rows.map((r) => r.policyname)
  check('a member SELECT policy exists', names.includes('loyalty_tiers_select'))
  check('a manager WRITE policy exists', names.includes('loyalty_tiers_manager_write'))
  check('a customer SELECT policy exists', names.includes('loyalty_tiers_customer_select'))
  check('there is NO customer write policy', !names.some((n) => n.includes('customer') && n.includes('write')))

  const grants = await owner.query<{ privilege_type: string }>(
    `select privilege_type from information_schema.role_table_grants
      where grantee='arena_app' and table_schema='public' and table_name='loyalty_tiers'`,
  )
  const privs = grants.rows.map((r) => r.privilege_type).sort().join(',')
  check('arena_app has the standard business-table grants', privs === 'DELETE,INSERT,SELECT,UPDATE')

  // ── tenants + roles ───────────────────────────────────────────────────────
  async function makeTenant(slug: string, ownerEmail: string, cashierEmail: string) {
    const t = await owner.query<{ id: string }>(
      `insert into tenants (slug, name, status) values ($1,$2,'active')
       on conflict (slug) do update set status='active' returning id`,
      [slug, `${slug} co`],
    )
    const mk = async (email: string, role: string) => {
      const u = await owner.query<{ id: string }>(
        `insert into users (email, password_hash) values ($1,'x')
         on conflict (email) do update set email=excluded.email returning id`,
        [email],
      )
      await owner.query(
        `insert into memberships (tenant_id, user_id, role, status)
         values ($1,$2,$3::member_role,'active')
         on conflict (tenant_id, user_id) do update set role=excluded.role, status='active'`,
        [t.rows[0].id, u.rows[0].id, role],
      )
      return u.rows[0].id
    }
    return {
      tenantId: t.rows[0].id,
      ownerId: await mk(ownerEmail, 'owner'),
      cashierId: await mk(cashierEmail, 'cashier'),
    }
  }

  const tA = await makeTenant('ltiera', 'owner@ltiera.test', 'cashier@ltiera.test')
  const tB = await makeTenant('ltierb', 'owner@ltierb.test', 'cashier@ltierb.test')

  // The migration seeds tenants existing when it ran; these were created after,
  // so give them an explicit ladder to assert against.
  for (const t of [tA, tB]) {
    await owner.query(
      `insert into loyalty_tiers (tenant_id, name, threshold, perk, sort_order) values
         ($1,'Bronze',0,'w',0), ($1,'Silver',500,'p',1), ($1,'Gold',1000,'g',2)
       on conflict on constraint loyalty_tiers_tenant_threshold_key do nothing`,
      [t.tenantId],
    )
  }

  async function asUser<T>(userId: string, fn: (tx: Db) => Promise<T>): Promise<T> {
    return app.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`)
      return fn(tx as unknown as Db)
    })
  }
  async function asCustomer<T>(customerId: string, fn: (tx: Db) => Promise<T>): Promise<T> {
    return app.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.customer_id', ${customerId}, true)`)
      return fn(tx as unknown as Db)
    })
  }

  // ── seeded defaults ───────────────────────────────────────────────────────
  console.log('\n── default tiers ──')

  // Migration 0049 seeds only tenants that EXISTED when it ran, so whether the
  // demo tenant has rows depends on whether it was created before or after the
  // migration — and the README's own quickstart runs `db:migrate` BEFORE
  // `seed:demo`, which produces no rows at all. Asserting "it has three rows"
  // unconditionally would therefore fail on a clean install for a reason that
  // says nothing about the code, exactly the order-dependence the comment below
  // warns against.
  //
  // What is actually invariant is: IF the seed applied, it applied exactly the
  // documented ladder. The "no rows" case is the fallback case, and it is
  // asserted directly further down against DEFAULT_TIERS.
  const demo = await owner.query<{ id: string }>("select id from tenants where slug='demo'")
  if (demo.rowCount) {
    const seeded = await owner.query<{ name: string; threshold: number }>(
      'select name, threshold from loyalty_tiers where tenant_id=$1 order by threshold',
      [demo.rows[0].id],
    )
    if (seeded.rowCount) {
      check(
        'the migration seeded Bronze/Silver/Gold for a tenant that predates it',
        seeded.rows.map((r) => `${r.name}:${r.threshold}`).join(',') ===
          'Bronze:0,Silver:500,Gold:1000',
      )
    } else {
      console.log(
        'ⓘ  demo tenant was created after migration 0049 — no seeded rows, code defaults apply (asserted below)',
      )
    }
  }

  // Re-running the seed must add nothing.
  //
  // Scoped to THIS script's two tenants, not the whole table. A global count
  // makes the assertion order-dependent: any other verification script that
  // creates a tenant before this one runs would legitimately gain three rows
  // from the cross join, and the check would fail for a reason that has nothing
  // to do with idempotency. A test whose result depends on what ran before it
  // is worse than no test.
  const scope = [tA.tenantId, tB.tenantId]
  const countScoped = async () =>
    (await owner.query<{ n: string }>('select count(*) n from loyalty_tiers where tenant_id = any($1)', [scope]))
      .rows[0].n

  const before = await countScoped()
  await owner.query(
    `insert into loyalty_tiers (tenant_id, name, threshold, perk, sort_order)
     select t.id, v.name, v.threshold, v.perk, v.sort_order from tenants t
     cross join (values ('Bronze',0,'w',0),('Silver',500,'p',1),('Gold',1000,'g',2))
       as v(name, threshold, perk, sort_order)
     where t.id = any($1)
     on conflict on constraint loyalty_tiers_tenant_threshold_key do nothing`,
    [scope],
  )
  check('re-running the seed is idempotent', before === (await countScoped()))

  let dupBlocked = false
  try {
    await owner.query(
      `insert into loyalty_tiers (tenant_id, name, threshold) values ($1,'Duplicate',500)`,
      [tA.tenantId],
    )
  } catch {
    dupBlocked = true
  }
  check('two tiers cannot share a threshold within a tenant', dupBlocked)

  // ── tenant isolation ──────────────────────────────────────────────────────
  console.log('\n── tenant isolation ──')

  const aTiers = await asUser(tA.ownerId, (tx) => loadLoyaltyTiers(tx, tA.tenantId))
  check('tenant A sees its own three tiers', aTiers.length === 3)
  check('…lowest threshold first', aTiers[0].name === 'Bronze' && aTiers[2].name === 'Gold')

  const crossRead = await asUser(tA.ownerId, async (tx) => {
    const r = await tx.execute<{ n: string }>(
      sql`select count(*)::text n from public.loyalty_tiers where tenant_id = ${tB.tenantId}::uuid`,
    )
    return Number(r.rows[0].n)
  })
  check("tenant A CANNOT read tenant B's tiers", crossRead === 0)

  // loadLoyaltyTiers falls back to the code defaults when RLS hides everything,
  // which is the "never configured" path — it must not leak B's rows.
  const fallback = await asUser(tA.ownerId, (tx) => loadLoyaltyTiers(tx, tB.tenantId))
  check(
    "…and asking for B's ladder yields the code defaults, not B's rows",
    fallback.length === DEFAULT_TIERS.length && fallback[0].id.startsWith('default-'),
  )

  let crossWrite = false
  try {
    const r = await asUser(tA.ownerId, (tx) =>
      tx.execute(sql`update public.loyalty_tiers set threshold = 1 where tenant_id = ${tB.tenantId}::uuid`),
    )
    crossWrite = r.rowCount === 0
  } catch {
    crossWrite = true
  }
  check("tenant A cannot modify tenant B's tiers", crossWrite)

  // ── role isolation ────────────────────────────────────────────────────────
  console.log('\n── role isolation ──')

  const cashierRead = await asUser(tA.cashierId, (tx) => loadLoyaltyTiers(tx, tA.tenantId))
  check('a cashier CAN read the ladder (the till shows a tier)', cashierRead.length === 3)

  async function writeBlocked(label: string, userId: string, statement: ReturnType<typeof sql>) {
    let blocked = false
    try {
      const r = await asUser(userId, (tx) => tx.execute(statement))
      blocked = r.rowCount === 0
    } catch {
      blocked = true
    }
    check(label, blocked)
  }
  await writeBlocked(
    'a cashier CANNOT change a threshold',
    tA.cashierId,
    sql`update public.loyalty_tiers set threshold = 9999 where tenant_id = ${tA.tenantId}::uuid`,
  )
  await writeBlocked(
    'a cashier CANNOT delete a tier',
    tA.cashierId,
    sql`delete from public.loyalty_tiers where tenant_id = ${tA.tenantId}::uuid`,
  )
  await writeBlocked(
    'a cashier CANNOT insert a tier',
    tA.cashierId,
    sql`insert into public.loyalty_tiers (tenant_id, name, threshold) values (${tA.tenantId}::uuid, 'Platinum', 5000)`,
  )

  const ownerWrite = await asUser(tA.ownerId, (tx) =>
    tx.execute(sql`update public.loyalty_tiers set perk = 'updated' where tenant_id = ${tA.tenantId}::uuid and threshold = 500`),
  )
  check('an owner CAN change the ladder', ownerWrite.rowCount === 1)

  const intact = await owner.query<{ threshold: number }>(
    'select threshold from loyalty_tiers where tenant_id=$1 order by threshold',
    [tA.tenantId],
  )
  check('…and no cashier attempt changed anything', intact.rows.map((r) => r.threshold).join(',') === '0,500,1000')

  // ── customer access ───────────────────────────────────────────────────────
  console.log('\n── customer access ──')

  await owner.query('delete from loyalty_transactions where tenant_id = any($1)', [[tA.tenantId, tB.tenantId]])
  await owner.query('delete from customers where tenant_id = any($1)', [[tA.tenantId, tB.tenantId]])
  const cust = await owner.query<{ id: string }>(
    `insert into customers (tenant_id, phone, name) values ($1,'+919000007001','Tiery') returning id`,
    [tA.tenantId],
  )
  const custB = await owner.query<{ id: string }>(
    `insert into customers (tenant_id, phone, name) values ($1,'+919000007002','Other') returning id`,
    [tB.tenantId],
  )

  const custTiers = await asCustomer(cust.rows[0].id, (tx) => loadLoyaltyTiers(tx, tA.tenantId))
  check('a customer CAN read their venue ladder', custTiers.length === 3)

  const custCross = await asCustomer(cust.rows[0].id, async (tx) => {
    const r = await tx.execute<{ n: string }>(
      sql`select count(*)::text n from public.loyalty_tiers where tenant_id = ${tB.tenantId}::uuid`,
    )
    return Number(r.rows[0].n)
  })
  check("…and CANNOT read another venue's ladder", custCross === 0)

  await writeBlockedCustomer(
    'a customer CANNOT modify the ladder',
    cust.rows[0].id,
    sql`update public.loyalty_tiers set threshold = 0 where tenant_id = ${tA.tenantId}::uuid`,
  )
  async function writeBlockedCustomer(label: string, customerId: string, statement: ReturnType<typeof sql>) {
    let blocked = false
    try {
      const r = await asCustomer(customerId, (tx) => tx.execute(statement))
      blocked = r.rowCount === 0
    } catch {
      blocked = true
    }
    check(label, blocked)
  }

  // ── THE points basis, against a real ledger ───────────────────────────────
  console.log('\n── lifetime vs spendable ──')

  const ledger = async (customerId: string, tenantId: string, points: number, source: string) => {
    await owner.query(
      `insert into loyalty_transactions (tenant_id, customer_id, points, source_type, source_id)
       values ($1,$2,$3,$4, gen_random_uuid())`,
      [tenantId, customerId, points, source],
    )
  }

  const c = cust.rows[0].id
  await ledger(c, tA.tenantId, 400, 'invoice_earn')
  await ledger(c, tA.tenantId, 200, 'invoice_earn')

  let lifetime = await asCustomer(c, (tx) => lifetimeLoyaltyPoints(tx, tA.tenantId, c))
  let spendable = await asCustomer(c, (tx) => loyaltyPoints(tx, tA.tenantId, c))
  check('after earning 600: lifetime 600', lifetime === 600)
  check('…spendable 600', spendable === 600)
  let standing = computeTierStanding(lifetime, custTiers)
  check('…tier is Silver', standing.currentTier?.name === 'Silver')

  // THE assertion: spending points must not demote.
  await ledger(c, tA.tenantId, -300, 'invoice_redeem')
  lifetime = await asCustomer(c, (tx) => lifetimeLoyaltyPoints(tx, tA.tenantId, c))
  spendable = await asCustomer(c, (tx) => loyaltyPoints(tx, tA.tenantId, c))
  check('after redeeming 300: spendable drops to 300', spendable === 300)
  check('…but LIFETIME stays 600', lifetime === 600)
  standing = computeTierStanding(lifetime, custTiers)
  check('…so the tier is STILL Silver — redeeming never demotes', standing.currentTier?.name === 'Silver')
  check(
    '…whereas keying off the spendable balance would have demoted to Bronze',
    computeTierStanding(spendable, custTiers).currentTier?.name === 'Bronze',
  )

  // A reversed earn SHOULD lower lifetime — that is the one thing that may.
  await ledger(c, tA.tenantId, -200, 'earn_reversal')
  lifetime = await asCustomer(c, (tx) => lifetimeLoyaltyPoints(tx, tA.tenantId, c))
  check('a reversed earn DOES lower lifetime (600 → 400)', lifetime === 400)
  check(
    '…demoting to Bronze, which is correct',
    computeTierStanding(lifetime, custTiers).currentTier?.name === 'Bronze',
  )

  // A returned redemption must not inflate lifetime.
  await ledger(c, tA.tenantId, 300, 'redeem_reversal')
  lifetime = await asCustomer(c, (tx) => lifetimeLoyaltyPoints(tx, tA.tenantId, c))
  check('a returned redemption does NOT inflate lifetime', lifetime === 400)

  // Cross-customer.
  const otherLifetime = await asCustomer(c, (tx) => lifetimeLoyaltyPoints(tx, tB.tenantId, custB.rows[0].id))
  check("a customer cannot read another customer's lifetime points", otherLifetime === 0)

  // ── cleanup ───────────────────────────────────────────────────────────────
  await appPool.end()
  await owner.query('delete from loyalty_transactions where tenant_id = any($1)', [[tA.tenantId, tB.tenantId]])
  await owner.query('delete from customers where tenant_id = any($1)', [[tA.tenantId, tB.tenantId]])
  await owner.query('delete from loyalty_tiers where tenant_id = any($1)', [[tA.tenantId, tB.tenantId]])
  await owner.end()

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
