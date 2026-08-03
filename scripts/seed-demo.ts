/**
 * Seeds local demo data so a new dev can log in and click around immediately.
 *
 *   npm run seed:demo   (idempotent — safe to re-run)
 *
 * Creates:
 *   - Platform admin        admin@arenaos.test  / admin1234   → http://lvh.me:3000/login
 *   - "Demo Gaming Cafe" tenant (subdomain: demo) with a primary branch
 *   - Company owner         owner@demo.test     / demo1234    → http://demo.lvh.me:3000/login
 *   - Company manager       manager@demo.test   / demo1234
 *   - Company cashier       cashier@demo.test   / demo1234
 *   - Resource types (PS5 Station, Snooker Table), 5 resources, 10:00–23:00 hours
 *
 * All demo passwords are "demo1234"; the platform admin is "admin1234".
 *
 * Connects as the OWNER role (bypasses RLS) — correct for platform provisioning.
 * Uses raw SQL + argon2 directly to avoid importing server-only app modules.
 */
import { Client } from 'pg'
import { hash } from '@node-rs/argon2'
import { loadEnv } from './env'

const ARGON = { memoryCost: 19456, timeCost: 2, outputLen: 32, parallelism: 1 } as const

async function main() {
  loadEnv()

  const url = process.env.DATABASE_URL_OWNER
  if (!url) throw new Error('DATABASE_URL_OWNER is not set in .env.local')

  const EMAIL = 'owner@demo.test'
  const PASSWORD = 'demo1234'

  const client = new Client({ connectionString: url })
  await client.connect()

  try {
    await client.query('begin')

    // 1. Tenant
    const tenant = await client.query<{ id: string }>(
      `insert into public.tenants (slug, name, industry, status)
       values ('demo', 'Demo Gaming Cafe', 'gaming_cafe', 'active')
       on conflict (slug) do update set name = excluded.name
       returning id`,
    )
    const tenantId = tenant.rows[0].id
    console.log('✓ tenant demo', tenantId)

    // 2. Branch
    const branch = await client.query<{ id: string }>(
      `insert into public.branches (tenant_id, name, is_primary)
       values ($1, 'Main Branch', true)
       on conflict (tenant_id, name) do update set is_primary = excluded.is_primary
       returning id`,
      [tenantId],
    )
    const branchId = branch.rows[0].id
    console.log('✓ branch Main Branch')

    // 3. Owner user
    const passwordHash = await hash(PASSWORD, ARGON)
    const user = await client.query<{ id: string }>(
      `insert into public.users (email, password_hash, full_name)
       values ($1, $2, 'Demo Owner')
       on conflict (email) do update set password_hash = excluded.password_hash
       returning id`,
      [EMAIL, passwordHash],
    )
    const userId = user.rows[0].id
    console.log('✓ owner user', userId)

    // 4. Membership
    await client.query(
      `insert into public.memberships (tenant_id, user_id, branch_id, role, status, full_name, email)
       values ($1, $2, $3, 'owner', 'active', 'Demo Owner', $4)
       on conflict (tenant_id, user_id)
       do update set role = 'owner', status = 'active', email = excluded.email`,
      [tenantId, userId, branchId, EMAIL],
    )
    console.log('✓ membership owner')

    // 4b. Staff members (so new devs can test non-owner roles). Password: demo1234
    async function staffMember(email: string, name: string, role: string) {
      const h = await hash(PASSWORD, ARGON)
      const u = await client.query<{ id: string }>(
        `insert into public.users (email, password_hash, full_name)
         values ($1, $2, $3)
         on conflict (email) do update set password_hash = excluded.password_hash
         returning id`,
        [email, h, name],
      )
      await client.query(
        `insert into public.memberships (tenant_id, user_id, branch_id, role, status, full_name, email)
         values ($1, $2, $3, $4, 'active', $5, $6)
         on conflict (tenant_id, user_id)
         do update set role = excluded.role, status = 'active', full_name = excluded.full_name, email = excluded.email`,
        [tenantId, u.rows[0].id, branchId, role, name, email],
      )
      console.log(`✓ ${role} ${email}`)
    }
    await staffMember('manager@demo.test', 'Demo Manager', 'manager')
    await staffMember('cashier@demo.test', 'Demo Cashier', 'cashier')

    // 5. Resource types
    async function resourceType(name: string, rate: string, buffer: number, capacity: number | null, color: string) {
      const r = await client.query<{ id: string }>(
        `insert into public.resource_types (tenant_id, name, hourly_rate, buffer_minutes, capacity, color)
         values ($1,$2,$3,$4,$5,$6)
         on conflict (tenant_id, name) do update set hourly_rate = excluded.hourly_rate
         returning id`,
        [tenantId, name, rate, buffer, capacity, color],
      )
      return r.rows[0].id
    }
    const ps5Type = await resourceType('PS5 Station', '150.00', 0, 4, '#6366f1')
    const snookerType = await resourceType('Snooker Table', '250.00', 10, 4, '#10b981')
    console.log('✓ resource types')

    // 6. Resources
    async function resource(typeId: string, name: string, sort: number) {
      await client.query(
        `insert into public.resources (tenant_id, branch_id, resource_type_id, name, sort_order)
         values ($1,$2,$3,$4,$5)
         on conflict (tenant_id, name) do nothing`,
        [tenantId, branchId, typeId, name, sort],
      )
    }
    await resource(ps5Type, 'PS5 #1', 1)
    await resource(ps5Type, 'PS5 #2', 2)
    await resource(ps5Type, 'PS5 #3', 3)
    await resource(snookerType, 'Snooker #1', 4)
    await resource(snookerType, 'Snooker #2', 5)
    console.log('✓ resources')

    // 7. Working hours — open 10:00–23:00 every day
    for (let dow = 0; dow < 7; dow++) {
      await client.query(
        `insert into public.working_hours (tenant_id, branch_id, day_of_week, open_time, close_time, is_closed)
         values ($1,$2,$3,'10:00','23:00',false)
         on conflict (branch_id, day_of_week) do update set open_time = excluded.open_time, close_time = excluded.close_time`,
        [tenantId, branchId, dow],
      )
    }
    console.log('✓ working hours (10:00–23:00 daily)')

    // 8. Platform admin (operates Arena OS itself; not a tenant member)
    const adminHash = await hash('admin1234', ARGON)
    await client.query(
      `insert into public.users (email, password_hash, full_name, is_platform_admin)
       values ('admin@arenaos.test', $1, 'Platform Admin', true)
       on conflict (email) do update set is_platform_admin = true, password_hash = excluded.password_hash`,
      [adminHash],
    )
    console.log('✓ platform admin (admin@arenaos.test / admin1234)')

    await client.query('commit')
  } catch (e) {
    await client.query('rollback')
    throw e
  } finally {
    await client.end()
  }

  console.log('\nDone. Seeded logins:')
  console.log('  Platform admin  → http://lvh.me:3000/login        admin@arenaos.test / admin1234')
  console.log(`  Company owner   → http://demo.lvh.me:3000/login   ${EMAIL} / ${PASSWORD}`)
  console.log('  Company manager → http://demo.lvh.me:3000/login   manager@demo.test / demo1234')
  console.log('  Company cashier → http://demo.lvh.me:3000/login   cashier@demo.test / demo1234')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
