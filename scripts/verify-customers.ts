import { Client } from 'pg'
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
  const owner = new Client({ connectionString: process.env.DATABASE_URL_OWNER })
  const app = new Client({ connectionString: process.env.DATABASE_URL })
  await owner.connect()
  await app.connect()

  // ── fixtures via owner (bypasses RLS) ─────────────────────────────────────
  async function makeTenant(slug: string, email: string) {
    const t = await owner.query<{ id: string }>(
      `insert into tenants (slug,name,status) values ($1,$2,'active')
       on conflict (slug) do update set name=excluded.name returning id`,
      [slug, `${slug} co`],
    )
    const u = await owner.query<{ id: string }>(
      `insert into users (email,password_hash) values ($1,'x')
       on conflict (email) do update set email=excluded.email returning id`,
      [email],
    )
    await owner.query(
      `insert into memberships (tenant_id,user_id,role,status) values ($1,$2,'owner','active')
       on conflict (tenant_id,user_id) do update set role='owner', status='active'`,
      [t.rows[0].id, u.rows[0].id],
    )
    return { tenantId: t.rows[0].id, userId: u.rows[0].id }
  }

  const a = await makeTenant('verifycusta', 'owner@verifycusta.test')
  const b = await makeTenant('verifycustb', 'owner@verifycustb.test')

  await owner.query('delete from customers where tenant_id = any($1)', [[a.tenantId, b.tenantId]])

  const PHONE = '+919876500001'

  async function asUser<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    await app.query('begin')
    await app.query(`select set_config('app.user_id',$1,true)`, [userId])
    try {
      return await fn()
    } finally {
      await app.query('commit')
    }
  }

  /** Run one statement as `userId`; true if it succeeded, false if refused. */
  async function tryAsUser(userId: string, q: string, params: unknown[] = []): Promise<boolean> {
    await app.query('begin')
    await app.query(`select set_config('app.user_id',$1,true)`, [userId])
    try {
      await app.query(q, params)
      await app.query('commit')
      return true
    } catch {
      await app.query('rollback')
      return false
    }
  }

  // ── 1. unique (tenant_id, phone) ──────────────────────────────────────────
  const created = await tryAsUser(
    a.userId,
    'insert into customers (tenant_id,phone,name) values ($1,$2,$3)',
    [a.tenantId, PHONE, 'Asha'],
  )
  check('tenant A can create a customer', created)

  const duplicate = await tryAsUser(a.userId, 'insert into customers (tenant_id,phone) values ($1,$2)', [
    a.tenantId,
    PHONE,
  ])
  check('a duplicate phone in the SAME tenant is REJECTED by unique(tenant_id,phone)', !duplicate)

  // ── 2. the same phone in another tenant is a different customer ───────────
  const inOtherTenant = await tryAsUser(b.userId, 'insert into customers (tenant_id,phone) values ($1,$2)', [
    b.tenantId,
    PHONE,
  ])
  check('the SAME phone in another tenant IS allowed', inOtherTenant)

  const distinct = await owner.query('select id from customers where phone=$1', [PHONE])
  check('…and produced two distinct customer rows', distinct.rows.length === 2)

  // ── 3. the E.164 CHECK rejects an un-normalised phone ─────────────────────
  const unnormalised = await tryAsUser(a.userId, 'insert into customers (tenant_id,phone) values ($1,$2)', [
    a.tenantId,
    '98765 43210',
  ])
  check('an un-normalised phone is REJECTED by the E.164 check constraint', !unnormalised)

  // ── 4. RLS: cross-tenant invisibility ─────────────────────────────────────
  const aCustomer = (
    await owner.query('select id from customers where tenant_id=$1 and phone=$2', [a.tenantId, PHONE])
  ).rows[0].id
  const bCustomer = (
    await owner.query('select id from customers where tenant_id=$1 and phone=$2', [b.tenantId, PHONE])
  ).rows[0].id

  // ledger + note rows on tenant A, to prove the child tables are scoped too
  await owner.query(
    `insert into wallet_transactions (tenant_id,customer_id,amount,reason) values ($1,$2,'500.00','topup')`,
    [a.tenantId, aCustomer],
  )
  await owner.query(
    `insert into wallet_transactions (tenant_id,customer_id,amount,reason) values ($1,$2,'-200.00','booking')`,
    [a.tenantId, aCustomer],
  )
  await owner.query(
    `insert into loyalty_transactions (tenant_id,customer_id,points,reason) values ($1,$2,120,'earned')`,
    [a.tenantId, aCustomer],
  )
  await owner.query(`insert into customer_notes (tenant_id,customer_id,body) values ($1,$2,'vip')`, [
    a.tenantId,
    aCustomer,
  ])

  await asUser(b.userId, async () => {
    const c = await app.query('select id from customers where id=$1', [aCustomer])
    check('tenant B cannot read tenant A’s customer (RLS)', c.rows.length === 0)

    const all = await app.query('select tenant_id from customers')
    check(
      'tenant B sees ONLY its own customers',
      all.rows.length > 0 && all.rows.every((r) => r.tenant_id === b.tenantId),
    )

    const n = await app.query('select id from customer_notes where customer_id=$1', [aCustomer])
    check('tenant B cannot read tenant A’s customer notes', n.rows.length === 0)

    const w = await app.query('select id from wallet_transactions where customer_id=$1', [aCustomer])
    check('tenant B cannot read tenant A’s wallet ledger', w.rows.length === 0)

    const l = await app.query('select id from loyalty_transactions where customer_id=$1', [aCustomer])
    check('tenant B cannot read tenant A’s loyalty ledger', l.rows.length === 0)
  })

  await asUser(a.userId, async () => {
    const c = await app.query('select id from customers where id=$1', [aCustomer])
    check('tenant A CAN read its own customer', c.rows.length === 1)
  })

  // ── 5. no identity set → sees nothing ─────────────────────────────────────
  await app.query('begin')
  {
    const r = await app.query('select id from customers')
    check('unauthenticated app connection sees 0 customers', r.rows.length === 0)
  }
  await app.query('commit')

  // ── 6. RLS WITH CHECK blocks cross-tenant writes ──────────────────────────
  const crossInsert = await tryAsUser(
    a.userId,
    'insert into customers (tenant_id,phone) values ($1,$2)',
    [b.tenantId, '+919876500999'],
  )
  check('tenant A CANNOT insert a customer into tenant B', !crossInsert)

  const crossLedger = await tryAsUser(
    a.userId,
    `insert into wallet_transactions (tenant_id,customer_id,amount) values ($1,$2,'999.00')`,
    [b.tenantId, bCustomer],
  )
  check('tenant A CANNOT write into tenant B’s wallet ledger', !crossLedger)

  const crossUpdate = await tryAsUser(a.userId, 'update customers set name=$1 where id=$2', [
    'hacked',
    bCustomer,
  ])
  const bName = (await owner.query('select name from customers where id=$1', [bCustomer])).rows[0].name
  check('tenant A cannot rename tenant B’s customer', crossUpdate === false || bName !== 'hacked')

  // ── 7. balances are DERIVED, never stored ─────────────────────────────────
  const cols = async (table: string) => {
    const r = await owner.query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema='public' and table_name=$1`,
      [table],
    )
    return r.rows.map((x) => x.column_name)
  }
  const walletCols = await cols('wallet_transactions')
  const loyaltyCols = await cols('loyalty_transactions')
  const customerCols = await cols('customers')

  check(
    'wallet_transactions stores NO balance column',
    !walletCols.some((c) => /balance/.test(c)),
  )
  check(
    'loyalty_transactions stores NO points-total column',
    !loyaltyCols.some((c) => /balance|total/.test(c)),
  )
  check(
    'customers stores NO wallet/loyalty balance column',
    !customerCols.some((c) => /balance|wallet|loyalty|points/.test(c)),
  )

  await asUser(a.userId, async () => {
    const w = await app.query<{ total: string }>(
      'select coalesce(sum(amount),0) total from wallet_transactions where customer_id=$1',
      [aCustomer],
    )
    check('wallet balance derives from sum(amount) = 300.00', Number(w.rows[0].total) === 300)

    const l = await app.query<{ total: string }>(
      'select coalesce(sum(points),0) total from loyalty_transactions where customer_id=$1',
      [aCustomer],
    )
    check('loyalty points derive from sum(points) = 120', Number(l.rows[0].total) === 120)
  })

  // ── 8. bookings ↔ customers link (migration 0007) ─────────────────────────
  // A customer leaving the directory must never take their bookings with them:
  // the FK is ON DELETE SET NULL, so the booking survives with its name/phone
  // snapshot and simply stops being attributed.
  const branch = (
    await owner.query(
      `insert into branches (tenant_id,name,is_primary) values ($1,'Main',true)
       on conflict (tenant_id,name) do update set is_primary=true returning id`,
      [a.tenantId],
    )
  ).rows[0].id
  const linked = (
    await owner.query(
      `insert into bookings (tenant_id,branch_id,booking_number,customer_id,customer_name,customer_phone,total)
       values ($1,$2,'VC-1',$3,'Asha',$4,'0') returning id`,
      [a.tenantId, branch, aCustomer, PHONE],
    )
  ).rows[0].id

  await asUser(a.userId, async () => {
    const r = await app.query('select id from bookings where customer_id=$1', [aCustomer])
    check('tenant A can list its customer’s bookings via customer_id', r.rows.length === 1)
  })
  await asUser(b.userId, async () => {
    const r = await app.query('select id from bookings where customer_id=$1', [aCustomer])
    check('tenant B cannot see tenant A’s customer bookings (RLS)', r.rows.length === 0)
  })

  await owner.query('delete from customers where id=$1', [aCustomer])
  const survivor = await owner.query<{ customer_id: string | null; customer_phone: string }>(
    'select customer_id, customer_phone from bookings where id=$1',
    [linked],
  )
  check('deleting a customer does NOT delete their bookings', survivor.rows.length === 1)
  check('…the booking’s customer_id is set to null', survivor.rows[0]?.customer_id === null)
  check('…and its phone snapshot is preserved', survivor.rows[0]?.customer_phone === PHONE)

  // ── 9. customer_notes are editable and cannot cross tenants (0009) ────────
  const noteCustomer = (
    await owner.query<{ id: string }>(
      `insert into customers (tenant_id,phone,name) values ($1,'+919876500123','Notes') returning id`,
      [a.tenantId],
    )
  ).rows[0].id

  const noteId = (
    await owner.query<{ id: string }>(
      `insert into customer_notes (tenant_id,customer_id,body) values ($1,$2,'first') returning id`,
      [a.tenantId, noteCustomer],
    )
  ).rows[0].id

  const fresh = await owner.query<{ same: boolean }>(
    'select created_at = updated_at as same from customer_notes where id=$1',
    [noteId],
  )
  check('a new note starts with updated_at equal to created_at', fresh.rows[0].same === true)

  await owner.query('update customer_notes set body=$1 where id=$2', ['edited', noteId])
  const touched = await owner.query<{ moved: boolean; created_by: string | null }>(
    'select updated_at > created_at as moved, created_by from customer_notes where id=$1',
    [noteId],
  )
  check('editing a note moves updated_at via the trigger', touched.rows[0].moved === true)
  check('…and leaves created_by alone', touched.rows[0].created_by === null)

  // RLS's WITH CHECK passes here (the tenant_id IS tenant B's); the composite FK
  // added in 0009 is what refuses a note pointing at another tenant's customer.
  const smuggledNote = await tryAsUser(
    b.userId,
    'insert into customer_notes (tenant_id,customer_id,body) values ($1,$2,$3)',
    [b.tenantId, noteCustomer, 'smuggled'],
  )
  check('a note in one tenant CANNOT reference another tenant’s customer', !smuggledNote)

  await owner.query('delete from customers where id=$1', [noteCustomer])
  const cascaded = await owner.query('select id from customer_notes where id=$1', [noteId])
  check('deleting a customer cascades their notes away', cascaded.rows.length === 0)

  // ── cleanup ───────────────────────────────────────────────────────────────
  await owner.query('delete from tenants where id = any($1)', [[a.tenantId, b.tenantId]])
  await owner.end()
  await app.end()

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
