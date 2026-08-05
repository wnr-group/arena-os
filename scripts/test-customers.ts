import { Pool } from 'pg'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { sql } from 'drizzle-orm'
import * as schema from '../db/schema'
import { findOrCreateCustomer, CustomerError } from '../lib/customers/service'
import { normalizePhone } from '../lib/customers/phone'
import { loadEnv } from './env'

type Db = NodePgDatabase<typeof schema>

let pass = 0,
  fail = 0
const check = (l: string, c: boolean) => {
  console.log(`${c ? '✓' : '✗ FAIL'}  ${l}`)
  if (c) pass++
  else fail++
}

async function main() {
  loadEnv()

  const ownerPool = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })
  const appPool = new Pool({ connectionString: process.env.DATABASE_URL })
  // Fixtures go through raw SQL on the owner pool (as in verify-rls.ts); the
  // assertions all run through Drizzle on the RLS-scoped app pool.
  const app = drizzle(appPool, { schema })

  /** Same contract as db/index.ts:withUser — RLS-scoped transaction. */
  async function withUser<T>(userId: string, fn: (tx: Db) => Promise<T>): Promise<T> {
    return app.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`)
      return fn(tx as unknown as Db)
    })
  }

  // ── fixtures (owner connection, bypasses RLS) ─────────────────────────────
  async function makeTenant(slug: string, email: string) {
    const t = await ownerPool.query<{ id: string }>(
      `insert into tenants (slug, name, status) values ($1, $2, 'active')
       on conflict (slug) do update set name = excluded.name returning id`,
      [slug, `${slug} co`],
    )
    const u = await ownerPool.query<{ id: string }>(
      `insert into users (email, password_hash) values ($1, 'x')
       on conflict (email) do update set email = excluded.email returning id`,
      [email],
    )
    await ownerPool.query(
      `insert into memberships (tenant_id, user_id, role, status)
       values ($1, $2, 'owner', 'active')
       on conflict (tenant_id, user_id) do update set role = 'owner', status = 'active'`,
      [t.rows[0].id, u.rows[0].id],
    )
    return { tenantId: t.rows[0].id, userId: u.rows[0].id }
  }

  const a = await makeTenant('testcusta', 'owner@testcusta.test')
  const b = await makeTenant('testcustb', 'owner@testcustb.test')

  // start from a clean directory in both tenants
  await ownerPool.query('delete from customers where tenant_id = any($1)', [[a.tenantId, b.tenantId]])

  const countIn = async (tenantId: string, phone: string) => {
    const r = await ownerPool.query<{ n: string }>(
      'select count(*) n from customers where tenant_id = $1 and phone = $2',
      [tenantId, phone],
    )
    return Number(r.rows[0].n)
  }

  // ── 1. create, then call again with the same phone ────────────────────────
  const first = await withUser(a.userId, (tx) =>
    findOrCreateCustomer(tx, a.tenantId, { phone: '9876543210', name: 'Asha' }),
  )
  const second = await withUser(a.userId, (tx) =>
    findOrCreateCustomer(tx, a.tenantId, { phone: '9876543210' }),
  )
  check('same phone returns the same customer id', first.id === second.id)
  check('phone is stored normalised as E.164', first.phone === '+919876543210')
  check('a second call does not blank the name already on file', second.name === 'Asha')

  // ── 2. phone normalisation ────────────────────────────────────────────────
  const FORMATS = ['9876543210', '98765 43210', '+91 9876543210', '+91-9876543210', '09876543210']
  const ids = new Set<string>()
  for (const f of FORMATS) {
    const c = await withUser(a.userId, (tx) => findOrCreateCustomer(tx, a.tenantId, { phone: f }))
    ids.add(c.id)
  }
  check(`all ${FORMATS.length} phone formats resolve to one customer`, ids.size === 1)
  check('that customer is the one created in test 1', ids.has(first.id))
  check(
    'normalizePhone maps every format to +919876543210',
    FORMATS.every((f) => normalizePhone(f) === '+919876543210'),
  )

  // ── 3. the same phone in a different tenant is a different customer ───────
  const inB = await withUser(b.userId, (tx) =>
    findOrCreateCustomer(tx, b.tenantId, { phone: '9876543210', name: 'Different Asha' }),
  )
  check('same phone in another tenant creates a separate customer', inB.id !== first.id)
  check('…and it belongs to that tenant', inB.tenantId === b.tenantId)

  // ── 4. name and email are optional ────────────────────────────────────────
  const bare = await withUser(a.userId, (tx) =>
    findOrCreateCustomer(tx, a.tenantId, { phone: '9000000001' }),
  )
  check('a customer is created with phone alone', Boolean(bare.id))
  check('missing name stays null', bare.name === null)
  check('missing email stays null', bare.email === null)

  const blanks = await withUser(a.userId, (tx) =>
    findOrCreateCustomer(tx, a.tenantId, { phone: '9000000002', name: '   ', email: '' }),
  )
  check('blank name/email are stored as null, not empty strings', blanks.name === null && blanks.email === null)

  // ── 5. idempotency: repeated AND concurrent calls yield exactly one row ───
  for (let i = 0; i < 5; i++) {
    await withUser(a.userId, (tx) => findOrCreateCustomer(tx, a.tenantId, { phone: '9876543210' }))
  }
  check('after 5 more calls there is still exactly one row', (await countIn(a.tenantId, '+919876543210')) === 1)

  const racers = await Promise.all(
    Array.from({ length: 8 }, () =>
      withUser(a.userId, (tx) => findOrCreateCustomer(tx, a.tenantId, { phone: '+91 90000 00003' })),
    ),
  )
  check('8 concurrent calls all return the same id', new Set(racers.map((r) => r.id)).size === 1)
  check('…and created exactly one row', (await countIn(a.tenantId, '+919000000003')) === 1)

  // ── 6. tenant isolation through arena_app ─────────────────────────────────
  await withUser(b.userId, async (tx) => {
    const rows = await tx.select().from(schema.customers)
    check(
      'tenant B cannot see any of tenant A’s customers (RLS)',
      rows.every((r) => r.tenantId === b.tenantId),
    )
    const direct = await tx.execute(sql`select id from customers where id = ${first.id}`)
    check('tenant B cannot read tenant A’s customer even by id', direct.rows.length === 0)
  })

  await withUser(a.userId, async (tx) => {
    const rows = await tx.select().from(schema.customers)
    check('tenant A CAN see its own customers', rows.some((r) => r.id === first.id))
  })

  // a write aimed at another tenant is refused by the RLS WITH CHECK
  let blocked = false
  try {
    await withUser(a.userId, (tx) =>
      tx.execute(
        sql`insert into customers (tenant_id, phone) values (${b.tenantId}, '+919111111111')`,
      ),
    )
  } catch {
    blocked = true
  }
  check('tenant A CANNOT insert a customer into tenant B', blocked)

  // ── invalid input ─────────────────────────────────────────────────────────
  let rejected = false
  try {
    await withUser(a.userId, (tx) => findOrCreateCustomer(tx, a.tenantId, { phone: '123' }))
  } catch (e) {
    rejected = e instanceof CustomerError
  }
  check('an implausible phone number is rejected with CustomerError', rejected)

  // ── cleanup ───────────────────────────────────────────────────────────────
  await ownerPool.query('delete from tenants where id = any($1)', [[a.tenantId, b.tenantId]])
  await ownerPool.end()
  await appPool.end()

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
