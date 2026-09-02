/**
 * Proves the customer portal's isolation guarantee end-to-end (AROS-88).
 *
 *   npx tsx scripts/verify-customer-portal-rls.ts
 *
 * Connects as the restricted `arena_app` role — raw SQL, no application code —
 * and asserts that a customer context (`app.customer_id`, set by
 * withCustomer()) confines every read to that one customer's rows across
 * customers, bookings, wallet_transactions, loyalty_transactions and
 * customer_memberships.
 *
 * Fixtures: two tenants, two customers in tenant A and one in tenant B, each
 * with a booking, a wallet entry, a loyalty entry and a membership. That shape
 * covers both axes at once — same-tenant customer isolation AND cross-tenant
 * isolation — and lets every "cannot see" assertion be checked against a row
 * that demonstrably exists.
 *
 * Same shape and intent as scripts/verify-rls.ts (staff) and
 * scripts/verify-customer-auth-rls.ts (login).
 */
import { Client } from 'pg'
import { loadEnv } from './env'

let passed = 0
let failed = 0
function check(label: string, cond: boolean) {
  console.log(`${cond ? '✓' : '✗ FAIL'}  ${label}`)
  if (cond) passed++
  else failed++
}

type Fixture = {
  tenantId: string
  userId: string
  customerId: string
  bookingId: string
  slotId: string
  walletId: string
  loyaltyId: string
  membershipId: string
}

async function main() {
  loadEnv()

  const owner = new Client({ connectionString: process.env.DATABASE_URL_OWNER })
  await owner.connect()

  // ── fixtures, as owner (RLS-exempt) ───────────────────────────────────────
  async function makeTenant(slug: string, email: string) {
    const t = await owner.query<{ id: string }>(
      `insert into tenants (slug, name, status) values ($1, $2, 'active')
       on conflict (slug) do update set name = excluded.name, status = 'active' returning id`,
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
       on conflict (tenant_id, user_id) do update set role = 'owner', status = 'active'`,
      [t.rows[0].id, u.rows[0].id],
    )
    const br = await owner.query<{ id: string }>(
      `insert into branches (tenant_id, name, is_primary) values ($1, 'Main', true)
       on conflict (tenant_id, name) do update set is_primary = true returning id`,
      [t.rows[0].id],
    )
    return { tenantId: t.rows[0].id, userId: u.rows[0].id, branchId: br.rows[0].id }
  }

  const tA = await makeTenant('portala', 'owner@portala.test')
  const tB = await makeTenant('portalb', 'owner@portalb.test')
  const tenantIds = [tA.tenantId, tB.tenantId]

  // Clean slate, children first.
  await owner.query('delete from customer_memberships where tenant_id = any($1)', [tenantIds])
  await owner.query('delete from membership_plans where tenant_id = any($1)', [tenantIds])
  await owner.query('delete from wallet_transactions where tenant_id = any($1)', [tenantIds])
  await owner.query('delete from loyalty_transactions where tenant_id = any($1)', [tenantIds])
  await owner.query('delete from booking_slots where tenant_id = any($1)', [tenantIds])
  await owner.query('delete from bookings where tenant_id = any($1)', [tenantIds])
  await owner.query('delete from customer_sessions where tenant_id = any($1)', [tenantIds])
  await owner.query('delete from customers where tenant_id = any($1)', [tenantIds])

  async function makeCustomer(
    t: { tenantId: string; userId: string; branchId: string },
    phone: string,
    name: string,
  ): Promise<Fixture> {
    const c = await owner.query<{ id: string }>(
      `insert into customers (tenant_id, phone, name) values ($1,$2,$3) returning id`,
      [t.tenantId, phone, name],
    )
    const customerId = c.rows[0].id

    const b = await owner.query<{ id: string }>(
      `insert into bookings
         (tenant_id, branch_id, customer_id, booking_number, customer_name, status, source, total)
       values ($1,$2,$3,$4,$5,'confirmed','online', 100) returning id`,
      [t.tenantId, t.branchId, customerId, `BK-${name}-001`, name],
    )
    const bookingId = b.rows[0].id

    // A slot for that booking (AROS-89). booking_slots has no customer_id, so
    // its policy reaches through `bookings` — which is exactly the path worth
    // testing. The resource is per-customer so the assertions below can tell
    // whose slot they are looking at by name alone.
    const rt = await owner.query<{ id: string }>(
      `insert into resource_types (tenant_id, name, hourly_rate) values ($1,$2,'100.00')
       on conflict (tenant_id, name) do update set name = excluded.name returning id`,
      [t.tenantId, `${name} type`],
    )
    const res = await owner.query<{ id: string }>(
      `insert into resources (tenant_id, branch_id, resource_type_id, name) values ($1,$2,$3,$4)
       on conflict (tenant_id, name) do update set name = excluded.name returning id`,
      [t.tenantId, t.branchId, rt.rows[0].id, `${name} bay`],
    )
    const slot = await owner.query<{ id: string }>(
      `insert into booking_slots
         (tenant_id, booking_id, resource_id, starts_at, ends_at,
          resource_name, resource_type_name)
       values ($1,$2,$3, now() + interval '1 day', now() + interval '1 day 2 hours', $4, $5)
       returning id`,
      [t.tenantId, bookingId, res.rows[0].id, `${name} bay`, `${name} type`],
    )

    const w = await owner.query<{ id: string }>(
      `insert into wallet_transactions (tenant_id, customer_id, amount, reason)
       values ($1,$2,'500.00',$3) returning id`,
      [t.tenantId, customerId, `${name} topup`],
    )
    const l = await owner.query<{ id: string }>(
      `insert into loyalty_transactions (tenant_id, customer_id, points, reason)
       values ($1,$2,50,$3) returning id`,
      [t.tenantId, customerId, `${name} points`],
    )
    const p = await owner.query<{ id: string }>(
      `insert into membership_plans (tenant_id, name, price, duration_months)
       values ($1,$2,'999.00',1) returning id`,
      [t.tenantId, `${name} plan`],
    )
    const m = await owner.query<{ id: string }>(
      `insert into customer_memberships
         (tenant_id, customer_id, plan_id, plan_name, price_paid, duration_months, expires_at)
       values ($1,$2,$3,$4,'999.00',1, now() + interval '1 month') returning id`,
      [t.tenantId, customerId, p.rows[0].id, `${name} plan`],
    )

    return {
      tenantId: t.tenantId,
      userId: t.userId,
      customerId,
      bookingId,
      slotId: slot.rows[0].id,
      walletId: w.rows[0].id,
      loyaltyId: l.rows[0].id,
      membershipId: m.rows[0].id,
    }
  }

  // Alice and Bob share tenant A; Carol is the whole of tenant B.
  const alice = await makeCustomer(tA, '+919000000101', 'Alice')
  const bob = await makeCustomer(tA, '+919000000102', 'Bob')
  const carol = await makeCustomer(tB, '+919000000103', 'Carol')

  // ── as the restricted app role ────────────────────────────────────────────
  const app = new Client({ connectionString: process.env.DATABASE_URL })
  await app.connect()

  /** db/index.ts:withCustomer — sets app.customer_id and nothing else. */
  async function asCustomer<T>(customerId: string, fn: () => Promise<T>): Promise<T> {
    await app.query('begin')
    try {
      await app.query("select set_config('app.customer_id', $1, true)", [customerId])
      return await fn()
    } finally {
      await app.query('rollback')
    }
  }

  /** The dangerous variant: a customer context that ALSO pins a public tenant. */
  async function asCustomerWithPublicTenant<T>(
    customerId: string,
    tenantId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    await app.query('begin')
    try {
      await app.query("select set_config('app.customer_id', $1, true)", [customerId])
      await app.query("select set_config('app.public_tenant_id', $1, true)", [tenantId])
      return await fn()
    } finally {
      await app.query('rollback')
    }
  }

  async function asUser<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    await app.query('begin')
    try {
      await app.query("select set_config('app.user_id', $1, true)", [userId])
      return await fn()
    } finally {
      await app.query('rollback')
    }
  }

  async function asPublicTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    await app.query('begin')
    try {
      await app.query("select set_config('app.public_tenant_id', $1, true)", [tenantId])
      return await fn()
    } finally {
      await app.query('rollback')
    }
  }

  const TABLES = [
    ['customers', 'id', (f: Fixture) => f.customerId],
    ['bookings', 'id', (f: Fixture) => f.bookingId],
    ['booking_slots', 'id', (f: Fixture) => f.slotId],
    ['wallet_transactions', 'id', (f: Fixture) => f.walletId],
    ['loyalty_transactions', 'id', (f: Fixture) => f.loyaltyId],
    ['customer_memberships', 'id', (f: Fixture) => f.membershipId],
  ] as const

  // ══ 1. a customer sees their own rows ══════════════════════════════════════
  console.log('\n── Alice reads her own data ──')

  await asCustomer(alice.customerId, async () => {
    for (const [table, , idOf] of TABLES) {
      const r = await app.query(`select id from ${table} where id = $1`, [idOf(alice)])
      check(`Alice sees her own ${table} row`, r.rowCount === 1)
    }
  })

  await asCustomer(alice.customerId, async () => {
    for (const [table] of TABLES) {
      const r = await app.query(`select id from ${table}`)
      check(`…and an unfiltered select on ${table} returns EXACTLY one row`, r.rowCount === 1)
    }
  })

  // ══ 2. same tenant, another customer ═══════════════════════════════════════
  console.log('\n── Alice cannot read Bob (same tenant) ──')

  await asCustomer(alice.customerId, async () => {
    for (const [table, , idOf] of TABLES) {
      // Explicitly BY UUID: knowing the id must buy nothing.
      const r = await app.query(`select id from ${table} where id = $1`, [idOf(bob)])
      check(`Alice cannot read Bob's ${table} row even by its UUID`, r.rowCount === 0)
    }
    const byCustomer = await app.query('select id from bookings where customer_id = $1', [
      bob.customerId,
    ])
    check("…nor by filtering bookings on Bob's customer_id", byCustomer.rowCount === 0)
  })

  // ══ 3. cross-tenant ════════════════════════════════════════════════════════
  console.log('\n── Alice cannot read Carol (other tenant) ──')

  await asCustomer(alice.customerId, async () => {
    for (const [table, , idOf] of TABLES) {
      const r = await app.query(`select id from ${table} where id = $1`, [idOf(carol)])
      check(`Alice cannot read Carol's ${table} row`, r.rowCount === 0)
    }
  })

  // ══ 4. THE trap: a customer context that also pins a public tenant ═════════
  // Permissive policies OR together, so customers_public_select /
  // bookings_public_select would expose the whole tenant here if the
  // restrictive policies from 0045 were missing or wrong.
  console.log('\n── customer context + a stray public-tenant pin ──')

  await asCustomerWithPublicTenant(alice.customerId, tA.tenantId, async () => {
    const c = await app.query('select id from customers')
    check('customers still returns ONLY Alice, not the tenant directory', c.rowCount === 1)

    const b = await app.query('select id from bookings')
    check("bookings still returns ONLY Alice's, not the tenant's", b.rowCount === 1)

    const bob2 = await app.query('select id from customers where id = $1', [bob.customerId])
    check("…and Bob's row is still invisible by UUID", bob2.rowCount === 0)
  })

  // The same pin WITHOUT a customer context must keep working as before —
  // the restrictive policy must not have broken the public booking site.
  await asPublicTenant(tA.tenantId, async () => {
    const c = await app.query('select id from customers')
    check(
      'the anonymous public booking path still sees the tenant directory (unbroken)',
      c.rowCount === 2,
    )
  })

  // ══ 5. no customer context ═════════════════════════════════════════════════
  console.log('\n── no identity at all ──')

  // Sequential, not Promise.all: this is a single pg Client, and overlapping
  // queries on one connection are deprecated (and would serialise anyway).
  for (const [table] of TABLES) {
    const r = await app.query(`select id from ${table}`)
    check(`an unidentified connection sees no ${table} rows`, r.rowCount === 0)
  }

  // ══ 6. the portal is read-only ═════════════════════════════════════════════
  console.log('\n── a customer context cannot write ──')

  await asCustomer(alice.customerId, async () => {
    let blocked = false
    try {
      const r = await app.query('update customers set name = $1 where id = $2', [
        'Hacked',
        alice.customerId,
      ])
      blocked = r.rowCount === 0
    } catch {
      blocked = true
    }
    check('Alice cannot UPDATE even her own customer row', blocked)

    let walletBlocked = false
    try {
      const r = await app.query(
        `insert into wallet_transactions (tenant_id, customer_id, amount, reason)
         values ($1,$2,'99999.00','free money')`,
        [alice.tenantId, alice.customerId],
      )
      walletBlocked = (r.rowCount ?? 0) === 0
    } catch {
      walletBlocked = true
    }
    check('Alice cannot credit her own wallet', walletBlocked)

    let deleteBlocked = false
    try {
      const r = await app.query('delete from bookings where id = $1', [alice.bookingId])
      deleteBlocked = r.rowCount === 0
    } catch {
      deleteBlocked = true
    }
    check('Alice cannot DELETE her own booking', deleteBlocked)

    let bobBlocked = false
    try {
      const r = await app.query('update customers set name = $1 where id = $2', [
        'Hacked',
        bob.customerId,
      ])
      bobBlocked = r.rowCount === 0
    } catch {
      bobBlocked = true
    }
    check("Alice cannot UPDATE Bob's customer row", bobBlocked)
  })

  const aliceIntact = await owner.query<{ name: string }>(
    'select name from customers where id = $1',
    [alice.customerId],
  )
  check('…and Alice’s row is genuinely unchanged', aliceIntact.rows[0].name === 'Alice')
  const bobIntact = await owner.query<{ name: string }>('select name from customers where id = $1', [
    bob.customerId,
  ])
  check('…and Bob’s row is genuinely unchanged', bobIntact.rows[0].name === 'Bob')

  // ══ 7. staff are unaffected ════════════════════════════════════════════════
  console.log('\n── staff and tenant isolation are unchanged ──')

  await asUser(tA.userId, async () => {
    const c = await app.query('select id from customers')
    check('tenant A staff still see both of their customers', c.rowCount === 2)

    const b = await app.query('select id from bookings')
    check('tenant A staff still see both bookings', b.rowCount === 2)

    const carolRow = await app.query('select id from customers where id = $1', [carol.customerId])
    check("tenant A staff still cannot see tenant B's customer", carolRow.rowCount === 0)

    const upd = await app.query('update customers set name = $1 where id = $2', [
      'Alice',
      alice.customerId,
    ])
    check('tenant A staff can still WRITE their own tenant’s customer', upd.rowCount === 1)
  })

  await asUser(tB.userId, async () => {
    const c = await app.query('select id from customers')
    check('tenant B staff see only their own customer', c.rowCount === 1)
    const aliceRow = await app.query('select id from customers where id = $1', [alice.customerId])
    check("tenant B staff cannot see tenant A's customer", aliceRow.rowCount === 0)
  })

  // ══ 8. a customer of one tenant cannot borrow another tenant's context ═════
  console.log('\n── cross-tenant customer context ──')

  await asCustomerWithPublicTenant(carol.customerId, tA.tenantId, async () => {
    const c = await app.query('select id from customers')
    check(
      "Carol (tenant B) pinned to tenant A sees only herself, not tenant A's directory",
      c.rowCount === 1,
    )
    const own = await app.query('select id from customers where id = $1', [carol.customerId])
    check('…and that one row is her own', own.rowCount === 1)
  })

  // ══ 9. AROS-89: the bookings page and its detail route ════════════════════
  console.log('\n── portal bookings (AROS-89) ──')

  // The exact shape lib/portal/bookings.ts issues: aggregate over booking_slots
  // with no customer id anywhere in the SQL. If RLS were wrong, this returns
  // other people's bookings.
  const LIST_SQL = `
    select b.id,
           b.booking_number,
           coalesce(array_agg(distinct s.resource_name)
                    filter (where s.id is not null), '{}') as resource_names
      from bookings b
      left join booking_slots s on s.booking_id = b.id
     group by b.id`

  await asCustomer(alice.customerId, async () => {
    const r = await app.query<{ booking_number: string; resource_names: string[] }>(LIST_SQL)
    check('the bookings listing returns exactly one booking for Alice', r.rowCount === 1)
    check('…and it is hers', r.rows[0]?.booking_number === 'BK-Alice-001')
    check('…carrying HER resource name from booking_slots', r.rows[0]?.resource_names[0] === 'Alice bay')
    check(
      "…and never Bob's resource name",
      !r.rows.some((row) => row.resource_names.includes('Bob bay')),
    )
  })

  // booking_slots directly: its policy reaches through `bookings`, so this is
  // the assertion that the indirection actually holds.
  await asCustomer(alice.customerId, async () => {
    const mine = await app.query('select id from booking_slots')
    check('Alice sees exactly her own booking_slots row', mine.rowCount === 1)

    const bobSlot = await app.query('select id from booking_slots where id = $1', [bob.slotId])
    check("Alice cannot read Bob's slot even by its UUID", bobSlot.rowCount === 0)

    const byBooking = await app.query('select id from booking_slots where booking_id = $1', [
      bob.bookingId,
    ])
    check("…nor by filtering slots on Bob's booking_id", byBooking.rowCount === 0)

    const carolSlot = await app.query('select id from booking_slots where id = $1', [carol.slotId])
    check("Alice cannot read Carol's slot (other tenant)", carolSlot.rowCount === 0)
  })

  // THE detail-route attack: Alice's session, Bob's booking id in the URL.
  await asCustomer(alice.customerId, async () => {
    const detail = await app.query('select id, booking_number from bookings where id = $1', [
      bob.bookingId,
    ])
    check(
      "Alice's context returns NO ROWS for Bob's booking id → the page 404s",
      detail.rowCount === 0,
    )

    const carolDetail = await app.query('select id from bookings where id = $1', [carol.bookingId])
    check("…and none for Carol's booking id either", carolDetail.rowCount === 0)

    const own = await app.query('select id from bookings where id = $1', [alice.bookingId])
    check('…while her own booking id still resolves', own.rowCount === 1)
  })

  // The upcoming/past split, evaluated by the database clock. The fixture slot
  // is tomorrow, so every booking here is upcoming; a past one is added to
  // prove the boundary rather than assuming it.
  const pastBooking = await owner.query<{ id: string }>(
    `insert into bookings
       (tenant_id, branch_id, customer_id, booking_number, customer_name, status, source, total)
     values ($1,$2,$3,'BK-Alice-OLD','Alice','completed','online', 50) returning id`,
    [tA.tenantId, tA.branchId, alice.customerId],
  )
  await owner.query(
    `insert into booking_slots
       (tenant_id, booking_id, resource_id, starts_at, ends_at, resource_name, resource_type_name, active)
     select $1, $2, resource_id, now() - interval '8 days', now() - interval '8 days' + interval '2 hours',
            resource_name, resource_type_name, false
       from booking_slots where id = $3`,
    [tA.tenantId, pastBooking.rows[0].id, alice.slotId],
  )

  await asCustomer(alice.customerId, async () => {
    const upcoming = await app.query(`
      select b.id from bookings b
        left join booking_slots s on s.booking_id = b.id
       where b.status in ('confirmed','checked_in')
       group by b.id
      having coalesce(max(s.ends_at), b.created_at) > now()`)
    check('the upcoming query returns only the future confirmed booking', upcoming.rowCount === 1)

    const past = await app.query(`
      select b.id from bookings b
        left join booking_slots s on s.booking_id = b.id
       group by b.id
      having b.status not in ('confirmed','checked_in')
          or coalesce(max(s.ends_at), b.created_at) <= now()`)
    check('the past query returns only the completed one', past.rowCount === 1)
    check('…and it is the old booking', past.rows[0].id === pastBooking.rows[0].id)

    // Exhaustiveness: the two sections must partition the customer's bookings,
    // so nothing can silently vanish from their history.
    const all = await app.query('select id from bookings')
    check(
      'upcoming + past together account for EVERY booking the customer has',
      (upcoming.rowCount ?? 0) + (past.rowCount ?? 0) === all.rowCount,
    )
  })

  // A cancelled booking keeps its slot (active flips to false) — the customer
  // must still be able to see when it WAS.
  await owner.query('update bookings set status = $1 where id = $2', [
    'cancelled',
    alice.bookingId,
  ])
  await asCustomer(alice.customerId, async () => {
    const slot = await app.query('select id, active from booking_slots where booking_id = $1', [
      alice.bookingId,
    ])
    check('a cancelled booking still shows its slot (active = false is readable)', slot.rowCount === 1)
    check('…and the slot really is inactive', slot.rows[0].active === false)
  })
  // The anonymous availability path must still hide that released time.
  await asPublicTenant(tA.tenantId, async () => {
    const slot = await app.query('select id from booking_slots where booking_id = $1', [
      alice.bookingId,
    ])
    check("…while the public availability view still cannot see it (active-only)", slot.rowCount === 0)
  })
  await owner.query('update bookings set status = $1 where id = $2', ['confirmed', alice.bookingId])

  await owner.query('delete from bookings where id = $1', [pastBooking.rows[0].id])

  // ── cleanup ───────────────────────────────────────────────────────────────
  await app.end()
  await owner.query('delete from customer_memberships where tenant_id = any($1)', [tenantIds])
  await owner.query('delete from membership_plans where tenant_id = any($1)', [tenantIds])
  await owner.query('delete from wallet_transactions where tenant_id = any($1)', [tenantIds])
  await owner.query('delete from loyalty_transactions where tenant_id = any($1)', [tenantIds])
  await owner.query('delete from booking_slots where tenant_id = any($1)', [tenantIds])
  await owner.query('delete from bookings where tenant_id = any($1)', [tenantIds])
  await owner.query('delete from resources where tenant_id = any($1)', [tenantIds])
  await owner.query('delete from resource_types where tenant_id = any($1)', [tenantIds])
  await owner.query('delete from customers where tenant_id = any($1)', [tenantIds])
  await owner.end()

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
