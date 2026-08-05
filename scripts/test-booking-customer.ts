import { Pool } from 'pg'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { sql } from 'drizzle-orm'
import * as schema from '../db/schema'
import { resolveBookingCustomer } from '../lib/booking/customer'
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
  const app = drizzle(appPool, { schema })

  /** Same contract as db/index.ts:withUser — RLS-scoped transaction. */
  async function withUser<T>(userId: string, fn: (tx: Db) => Promise<T>): Promise<T> {
    return app.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`)
      return fn(tx as unknown as Db)
    })
  }

  // ── fixtures ──────────────────────────────────────────────────────────────
  async function makeTenant(slug: string, email: string) {
    const t = (
      await ownerPool.query<{ id: string }>(
        `insert into tenants (slug,name,status) values ($1,$1,'active')
         on conflict (slug) do update set name=excluded.name returning id`,
        [slug],
      )
    ).rows[0].id
    const u = (
      await ownerPool.query<{ id: string }>(
        `insert into users (email,password_hash) values ($1,'x')
         on conflict (email) do update set email=excluded.email returning id`,
        [email],
      )
    ).rows[0].id
    await ownerPool.query(
      `insert into memberships (tenant_id,user_id,role,status) values ($1,$2,'owner','active')
       on conflict (tenant_id,user_id) do update set role='owner', status='active'`,
      [t, u],
    )
    const b = (
      await ownerPool.query<{ id: string }>(
        `insert into branches (tenant_id,name,is_primary) values ($1,'Main',true)
         on conflict (tenant_id,name) do update set is_primary=true returning id`,
        [t],
      )
    ).rows[0].id
    return { tenantId: t, userId: u, branchId: b }
  }

  const A = await makeTenant('bclinka', 'owner@bclinka.test')
  const B = await makeTenant('bclinkb', 'owner@bclinkb.test')
  await ownerPool.query('delete from customers where tenant_id = any($1)', [[A.tenantId, B.tenantId]])

  let seq = 0
  /**
   * Mirrors createBooking's transaction body: resolve the customer through the
   * shared helper, then insert with the snapshots exactly as typed.
   */
  async function makeBooking(
    t: { tenantId: string; userId: string; branchId: string },
    contact: { phone?: string | null; name?: string | null; email?: string | null },
  ) {
    return withUser(t.userId, async (tx) => {
      const customerId = await resolveBookingCustomer(tx, t.tenantId, contact)
      const num = `BC-${String(++seq).padStart(3, '0')}`
      const r = await tx.execute(sql`
        insert into bookings (tenant_id, branch_id, booking_number, customer_id,
                              customer_name, customer_phone, total)
        values (${t.tenantId}, ${t.branchId}, ${num}, ${customerId},
                ${contact.name ?? null}, ${contact.phone ?? null}, '0')
        returning id, customer_id, customer_name, customer_phone
      `)
      return r.rows[0] as {
        id: string
        customer_id: string | null
        customer_name: string | null
        customer_phone: string | null
      }
    })
  }

  const countCustomers = async (tenantId: string, phone: string) =>
    Number(
      (
        await ownerPool.query<{ n: string }>(
          'select count(*) n from customers where tenant_id=$1 and phone=$2',
          [tenantId, phone],
        )
      ).rows[0].n,
    )

  // ── 1. a new booking creates the customer and populates customer_id ───────
  const b1 = await makeBooking(A, { phone: '98765 43210', name: 'Asha Iyer', email: 'asha@x.test' })
  check('new booking populates customer_id', b1.customer_id !== null)
  check('…and created the customer', (await countCustomers(A.tenantId, '+919876543210')) === 1)

  // ── 2. an existing phone reuses the customer, in any format ───────────────
  const b2 = await makeBooking(A, { phone: '+91-9876543210', name: 'Asha I.' })
  check('second booking reuses the SAME customer', b2.customer_id === b1.customer_id)
  check('…and created no duplicate', (await countCustomers(A.tenantId, '+919876543210')) === 1)

  // ── 3 & 4. snapshots keep what was typed, not the normalised/stored value ─
  check('customer_name snapshot retained', b1.customer_name === 'Asha Iyer')
  check('customer_phone snapshot retained verbatim', b1.customer_phone === '98765 43210')
  check('a differing later snapshot is kept as typed', b2.customer_name === 'Asha I.')
  check('…including its own phone formatting', b2.customer_phone === '+91-9876543210')

  // ── 5. editing the customer must not rewrite history ──────────────────────
  await withUser(A.userId, (tx) =>
    tx.execute(sql`
      update customers set name = 'Asha Iyer-Menon', email = 'new@x.test'
      where id = ${b1.customer_id}
    `),
  )
  const after = (
    await ownerPool.query<{ customer_name: string; customer_phone: string; customer_id: string }>(
      'select customer_name, customer_phone, customer_id from bookings where id=$1',
      [b1.id],
    )
  ).rows[0]
  check('customer rename leaves the booking snapshot untouched', after.customer_name === 'Asha Iyer')
  check('…and the phone snapshot untouched', after.customer_phone === '98765 43210')
  check('…while the link still points at the customer', after.customer_id === b1.customer_id)

  // ── 6. the profile's history query returns exactly this customer's bookings
  await withUser(A.userId, async (tx) => {
    const r = await tx.execute(sql`
      select id from bookings
      where tenant_id = ${A.tenantId} and customer_id = ${b1.customer_id}
    `)
    check('profile history query returns both linked bookings', r.rows.length === 2)
  })

  // ── 7. historical bookings with NULL customer_id still work ───────────────
  const legacy = await makeBooking(A, { phone: null, name: 'Walk-in Guest' })
  check('a booking with no phone is still created', Boolean(legacy.id))
  check('…with customer_id null', legacy.customer_id === null)
  check('…and its name snapshot intact', legacy.customer_name === 'Walk-in Guest')

  const unparseable = await makeBooking(A, { phone: '123', name: 'Typo Phone' })
  check('an unparseable phone does not block the booking', Boolean(unparseable.id))
  check('…and leaves it unlinked rather than failing', unparseable.customer_id === null)

  await withUser(A.userId, async (tx) => {
    const r = await tx.execute(sql`
      select id, customer_name from bookings
      where tenant_id = ${A.tenantId} and customer_id is null
    `)
    check('unlinked bookings still load for the board', r.rows.length === 2)
  })

  // ── 8. cross-tenant linking is impossible ─────────────────────────────────
  const bCustomer = await makeBooking(B, { phone: '9000011122', name: 'B Guest' })
  check('tenant B booking linked its own customer', bCustomer.customer_id !== null)

  // The same phone in tenant A must resolve to a DIFFERENT customer.
  const aSamePhone = await makeBooking(A, { phone: '9000011122', name: 'A Guest' })
  check(
    'the same phone in another tenant resolves to a different customer',
    aSamePhone.customer_id !== bCustomer.customer_id,
  )

  // And a hand-crafted booking pointing across the boundary must be refused by
  // the composite FK added in 0008.
  let blocked = false
  try {
    await withUser(A.userId, (tx) =>
      tx.execute(sql`
        insert into bookings (tenant_id, branch_id, booking_number, customer_id, total)
        values (${A.tenantId}, ${A.branchId}, 'BC-XT', ${bCustomer.customer_id}, '0')
      `),
    )
  } catch {
    blocked = true
  }
  check('tenant A CANNOT link a booking to tenant B’s customer', blocked)

  await withUser(B.userId, async (tx) => {
    const r = await tx.execute(sql`
      select id from bookings where customer_id = ${b1.customer_id}
    `)
    check('tenant B cannot see bookings linked to tenant A’s customer (RLS)', r.rows.length === 0)
  })

  // ── cleanup ───────────────────────────────────────────────────────────────
  await ownerPool.query('delete from tenants where id = any($1)', [[A.tenantId, B.tenantId]])
  await ownerPool.query('delete from users where email = any($1)', [
    ['owner@bclinka.test', 'owner@bclinkb.test'],
  ])
  await ownerPool.end()
  await appPool.end()

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
