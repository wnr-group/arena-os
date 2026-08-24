/**
 * Proves the tenant boundary around customer authentication (AROS-87).
 *
 *   npx tsx scripts/verify-customer-auth-rls.ts
 *
 * Connects as the restricted `arena_app` role — no Drizzle, no application code
 * — and asserts directly against the database that:
 *
 *   * an OTP challenge is invisible and unwritable outside its own tenant;
 *   * a STAFF context (app.user_id) sees no challenges at all;
 *   * an unidentified connection sees nothing;
 *   * customer_sessions is not reachable by the app role in any way.
 *
 * Same shape and intent as scripts/verify-rls.ts, which does this for the staff
 * surface. Application-level assertions (expiry, attempts, single use) live in
 * scripts/test-customer-otp.ts; this file is only about isolation.
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

const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)
const PHONE = '+919876511001'

async function main() {
  loadEnv()

  const owner = new Client({ connectionString: process.env.DATABASE_URL_OWNER })
  await owner.connect()

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
    return { tenantId: t.rows[0].id, userId: u.rows[0].id }
  }

  const a = await makeTenant('otprlsa', 'owner@otprlsa.test')
  const b = await makeTenant('otprlsb', 'owner@otprlsb.test')

  await owner.query('delete from customer_otp_challenges where tenant_id = any($1)', [
    [a.tenantId, b.tenantId],
  ])
  await owner.query('delete from customer_sessions where tenant_id = any($1)', [
    [a.tenantId, b.tenantId],
  ])
  await owner.query('delete from customers where tenant_id = any($1)', [[a.tenantId, b.tenantId]])

  // One live challenge in each tenant, for the same phone number.
  const chA = await owner.query<{ id: string }>(
    `insert into customer_otp_challenges (tenant_id, phone, code_hash, expires_at)
     values ($1,$2,$3, now() + interval '5 minutes') returning id`,
    [a.tenantId, PHONE, HASH_A],
  )
  const chB = await owner.query<{ id: string }>(
    `insert into customer_otp_challenges (tenant_id, phone, code_hash, expires_at)
     values ($1,$2,$3, now() + interval '5 minutes') returning id`,
    [b.tenantId, PHONE, HASH_B],
  )

  // A customer in tenant A, so the session assertions have a target.
  const custA = await owner.query<{ id: string }>(
    `insert into customers (tenant_id, phone, name) values ($1,$2,'A Customer') returning id`,
    [a.tenantId, PHONE],
  )

  // ── as the restricted app role ────────────────────────────────────────────
  const app = new Client({ connectionString: process.env.DATABASE_URL })
  await app.connect()

  /** One transaction with a public tenant pinned — db/index.ts:withPublicTenant. */
  async function asPublicTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    await app.query('begin')
    try {
      await app.query("select set_config('app.public_tenant_id', $1, true)", [tenantId])
      return await fn()
    } finally {
      await app.query('rollback')
    }
  }

  /** One transaction as a signed-in staff member — db/index.ts:withUser. */
  async function asUser<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    await app.query('begin')
    try {
      await app.query("select set_config('app.user_id', $1, true)", [userId])
      return await fn()
    } finally {
      await app.query('rollback')
    }
  }

  console.log('\n── customer_otp_challenges ──')

  await asPublicTenant(a.tenantId, async () => {
    const r = await app.query<{ id: string; code_hash: string }>(
      'select id, code_hash from customer_otp_challenges',
    )
    check('tenant A sees exactly its own one challenge', r.rowCount === 1)
    check('…and it is A’s row', r.rows[0]?.id === chA.rows[0].id)
    check("…never B's hash", r.rows.every((row) => row.code_hash !== HASH_B))
  })

  await asPublicTenant(b.tenantId, async () => {
    const r = await app.query('select id from customer_otp_challenges where id = $1', [
      chA.rows[0].id,
    ])
    check("tenant B cannot read A's challenge even by id", r.rowCount === 0)
  })

  await asPublicTenant(a.tenantId, async () => {
    let blocked = false
    try {
      await app.query(
        `insert into customer_otp_challenges (tenant_id, phone, code_hash, expires_at)
         values ($1,$2,$3, now() + interval '5 minutes')`,
        [b.tenantId, PHONE, HASH_A],
      )
    } catch {
      blocked = true
    }
    check('tenant A CANNOT insert a challenge into tenant B', blocked)
  })

  await asPublicTenant(b.tenantId, async () => {
    const r = await app.query('update customer_otp_challenges set attempts = 99 where id = $1', [
      chA.rows[0].id,
    ])
    check("tenant B's update of A's challenge affects zero rows", r.rowCount === 0)
  })

  const untouched = await owner.query<{ attempts: number }>(
    'select attempts from customer_otp_challenges where id = $1',
    [chA.rows[0].id],
  )
  check('…and A’s challenge is genuinely untouched', Number(untouched.rows[0].attempts) === 0)

  await asPublicTenant(b.tenantId, async () => {
    const r = await app.query('delete from customer_otp_challenges where id = $1', [
      chA.rows[0].id,
    ])
    check("tenant B cannot delete A's challenge", r.rowCount === 0)
  })

  await asUser(a.userId, async () => {
    const r = await app.query('select id from customer_otp_challenges')
    check(
      'a signed-in STAFF member sees no OTP challenges at all (no staff policy)',
      r.rowCount === 0,
    )
  })

  {
    // No identity of any kind: the unauthenticated app connection.
    const r = await app.query('select id from customer_otp_challenges')
    check('an unidentified connection sees no challenges', r.rowCount === 0)
  }

  console.log('\n── customer_sessions ──')

  const sessionChecks: Array<[string, string, unknown[]]> = [
    ['select', 'select id from customer_sessions', []],
    [
      'insert',
      `insert into customer_sessions (id, tenant_id, customer_id, expires_at)
       values ('deadbeef', $1, $2, now() + interval '1 day')`,
      [a.tenantId, custA.rows[0].id],
    ],
    ['update', 'update customer_sessions set revoked_at = now()', []],
    ['delete', 'delete from customer_sessions', []],
  ]

  for (const [verb, text, values] of sessionChecks) {
    let blocked = false
    try {
      await app.query(text, values as never[])
    } catch {
      blocked = true
    }
    check(`the app role cannot ${verb} customer_sessions (never granted)`, blocked)
  }

  await asPublicTenant(a.tenantId, async () => {
    let blocked = false
    try {
      await app.query('select id from customer_sessions')
    } catch {
      blocked = true
    }
    check('…not even inside a pinned public-tenant transaction', blocked)
  })

  // ── cleanup ───────────────────────────────────────────────────────────────
  await app.end()
  await owner.query('delete from customer_otp_challenges where id = any($1)', [
    [chA.rows[0].id, chB.rows[0].id],
  ])
  await owner.query('delete from customers where tenant_id = any($1)', [[a.tenantId, b.tenantId]])
  await owner.end()

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
