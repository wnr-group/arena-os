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
 *   - 5 customers with tags and a few staff notes
 *
 * All demo passwords are "demo1234"; the platform admin is "admin1234".
 *
 * Connects as the OWNER role (bypasses RLS) — correct for platform provisioning.
 * Uses raw SQL + argon2 directly to avoid importing server-only app modules.
 */
import { Client } from 'pg'
import { hash } from '@node-rs/argon2'
import { loadEnv } from './env'
import { DEFAULT_EXPENSE_CATEGORIES } from '../lib/expenses/defaults'
import { DEFAULT_PLANS } from '../lib/platform/plans/defaults'

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
    const ownerMembership = await client.query<{ id: string }>(
      `insert into public.memberships (tenant_id, user_id, branch_id, role, status, full_name, email)
       values ($1, $2, $3, 'owner', 'active', 'Demo Owner', $4)
       on conflict (tenant_id, user_id)
       do update set role = 'owner', status = 'active', email = excluded.email
       returning id`,
      [tenantId, userId, branchId, EMAIL],
    )
    const ownerMembershipId = ownerMembership.rows[0].id
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

    // 8. Customers — a small directory to click through, with tags and notes.
    // Phones are already E.164 because that is what the CHECK on customers.phone
    // (migration 0014) accepts; the app normalises to this shape on the way in.
    type SeedCustomer = {
      phone: string
      name: string
      email: string | null
      tags: string[]
      membershipStatus: string | null
      notes: string[]
    }

    const demoCustomers: SeedCustomer[] = [
      {
        phone: '+919876543210',
        name: 'Asha Iyer',
        email: 'asha@example.test',
        tags: ['VIP', 'Regular'],
        membershipStatus: 'gold',
        notes: [
          'Prefers PS5 #1 by the window. Books most Friday evenings.',
          'Allergic to peanuts — keep the snack platter away from her table.',
        ],
      },
      {
        phone: '+919812345678',
        name: 'Rohit Menon',
        email: 'rohit@example.test',
        tags: ['Regular'],
        membershipStatus: null,
        notes: ['Usually brings a group of four for snooker.'],
      },
      {
        phone: '+919900112233',
        name: 'Fatima Sheikh',
        email: null,
        tags: ['Student', 'Weekday'],
        membershipStatus: null,
        notes: [],
      },
      {
        phone: '+919845001122',
        name: 'Vikram Nair',
        email: 'vikram@example.test',
        tags: [],
        membershipStatus: 'silver',
        notes: ['Paid a ₹500 advance in cash on his last visit — adjust on the next bill.'],
      },
      {
        phone: '+919701234567',
        name: 'Meera Krishnan',
        email: 'meera@example.test',
        tags: ['Birthday party'],
        membershipStatus: null,
        notes: [],
      },
    ]

    for (const c of demoCustomers) {
      const row = await client.query<{ id: string }>(
        `insert into public.customers (tenant_id, phone, name, email, tags, membership_status)
         values ($1,$2,$3,$4,$5,$6)
         on conflict (tenant_id, phone)
         do update set name = excluded.name, email = excluded.email,
                       tags = excluded.tags, membership_status = excluded.membership_status
         returning id`,
        [tenantId, c.phone, c.name, c.email, c.tags, c.membershipStatus],
      )
      const customerId = row.rows[0].id

      // Notes have no natural key, so clear this customer's notes before
      // re-inserting — otherwise re-running the seed would stack duplicates.
      await client.query('delete from public.customer_notes where customer_id = $1', [customerId])
      for (const body of c.notes) {
        await client.query(
          `insert into public.customer_notes (tenant_id, customer_id, body, created_by)
           values ($1,$2,$3,$4)`,
          [tenantId, customerId, body, ownerMembershipId],
        )
      }
    }
    console.log(`✓ ${demoCustomers.length} customers (with tags + notes)`)

    // 9. Starter expense categories (AROS-107/108). Ordinary rows a manager can
    //    rename or retire — seeded because an expense requires a category, so
    //    the Expenses page would otherwise open onto an unsubmittable form.
    //    `on conflict do nothing` (untargeted) makes the re-run idempotent
    //    against the partial unique index on (tenant_id, lower(btrim(name))).
    await client.query(
      `insert into public.expense_categories (tenant_id, name)
       select $1, unnest($2::text[])
       on conflict do nothing`,
      [tenantId, DEFAULT_EXPENSE_CATEGORIES as unknown as string[]],
    )
    console.log(`✓ ${DEFAULT_EXPENSE_CATEGORIES.length} expense categories`)
    // 9. Platform admin (operates Arena OS itself; not a tenant member)
    const adminHash = await hash('admin1234', ARGON)
    await client.query(
      `insert into public.users (email, password_hash, full_name, is_platform_admin)
       values ('admin@arenaos.test', $1, 'Platform Admin', true)
       on conflict (email) do update set is_platform_admin = true, password_hash = excluded.password_hash`,
      [adminHash],
    )
    console.log('✓ platform admin (admin@arenaos.test / admin1234)')

    // 10. Platform plan catalogue + entitlements (M16).
    //
    //     PLATFORM-level, not tenant-level: unlike everything above, these rows
    //     carry no tenant_id — one catalogue for the whole install, which is why
    //     they sit next to the platform admin rather than inside the demo
    //     tenant's block.
    //
    //     Idempotent the same way the rest of this file is: plans key on the
    //     unique lower(btrim(name)) index and entitlements on (plan_id, key), so
    //     a re-run REPRICES and re-points rather than duplicating. Editing a
    //     plan in the admin UI and then re-seeding will therefore reset it —
    //     the same trade every `do update` in this script already makes.
    for (const plan of DEFAULT_PLANS) {
      const p = await client.query<{ id: string }>(
        `insert into public.plans (name, monthly_price, annual_price)
         values ($1, $2, $3)
         on conflict (lower(btrim(name)))
           do update set monthly_price = excluded.monthly_price,
                         annual_price  = excluded.annual_price
         returning id`,
        [plan.name, plan.monthlyPrice, plan.annualPrice],
      )
      const planId = p.rows[0].id

      const keys = Object.keys(plan.entitlements)
      // JSON.stringify is what turns 3 → '3', true → 'true' and null → 'null',
      // each of which ::jsonb parses back to the right scalar type. Passing the
      // raw JS value would send null as SQL NULL and break the not-null column.
      const values = keys.map((k) => JSON.stringify(plan.entitlements[k]))
      await client.query(
        `insert into public.plan_entitlements (plan_id, key, value)
         select $1, k, v::jsonb
           from unnest($2::text[], $3::text[]) as t(k, v)
         on conflict (plan_id, key) do update set value = excluded.value`,
        [planId, keys, values],
      )
    }
    console.log(
      `✓ ${DEFAULT_PLANS.length} platform plans (${DEFAULT_PLANS.map((p) => p.name).join(', ')})`,
    )

    // 11. Put the demo tenant on Pro so getEntitlements() has a real answer
    //     from the first run. `where not exists` rather than `on conflict`:
    //     idx_tenant_subscriptions_one_live is a PARTIAL unique index and this
    //     keeps an operator's later hand-assignment from being overwritten by a
    //     re-seed.
    await client.query(
      `insert into public.tenant_subscriptions
         (tenant_id, plan_id, billing_period, status, current_period_start, current_period_end)
       select $1, p.id, 'monthly', 'active', now(), now() + interval '1 month'
         from public.plans p
        where lower(btrim(p.name)) = 'pro'
          and not exists (
            select 1 from public.tenant_subscriptions s
             where s.tenant_id = $1
               and s.status in ('trialing','active','past_due')
          )`,
      [tenantId],
    )
    console.log('✓ demo tenant subscribed to Pro (monthly)')

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
