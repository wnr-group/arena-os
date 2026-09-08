/**
 * Regression test for 0078_public_booking_sequences.sql (commit "fix: allow
 * public bookings to mint sequence numbers (RLS)").
 *
 * Before that migration, nextBookingNumber's atomic upsert into `sequences`
 * ran fine for staff (withUser, sequences_rw / auth_tenant_ids()) but a
 * PUBLIC session (withPublicTenant, app.public_tenant_id) had no matching
 * policy for kind = 'booking' — sequences_public_* only recognised
 * ('order','kot') from 0064. Every public booking (pay-at-venue or
 * pay-online) failed outright with "new row violates row-level security
 * policy for table sequences". The fix was migration-only, so nothing
 * exercised the actual public path — this is that test:
 *
 *   - a public (logged-out) session can create a booking and gets back a
 *     real BK-YYYYMMDD-NNN number
 *   - a public session still cannot mint an 'invoice' sequence number —
 *     0078 widened booking/order/kot only, invoice stays staff-only
 *   - a public session pinned to tenant A cannot bump tenant B's sequence
 *     counter (tenant_id is part of the WITH CHECK, not just kind)
 *
 *   npx tsx scripts/test-public-booking-sequences.ts
 */
import { Pool } from 'pg'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { sql } from 'drizzle-orm'
import * as schema from '../db/schema'
import { createBookingCore } from '../lib/booking/service'
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

async function main() {
  loadEnv()

  const ownerPool = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })
  const appPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 })
  const app = drizzle(appPool, { schema })

  // Mirrors db/index.ts's real withPublicTenant: no app.user_id is ever set,
  // only app.public_tenant_id — an unauthenticated visitor's session.
  async function withPublicTenant<T>(tenantId: string, fn: (tx: Db) => Promise<T>): Promise<T> {
    return app.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.public_tenant_id', ${tenantId}, true)`)
      return fn(tx as unknown as Db)
    })
  }

  async function attempt<T>(fn: () => Promise<T>) {
    try {
      return { ok: true as const, value: await fn() }
    } catch (e) {
      return { ok: false as const, message: e instanceof Error ? e.message : String(e) }
    }
  }

  type Tenant = { tenantId: string; branchId: string; resourceId: string }

  async function makeTenant(slug: string): Promise<Tenant> {
    const t = await ownerPool.query<{ id: string }>(
      `insert into tenants (slug,name,status,timezone,industry) values ($1,$2,'active',$3,'gaming_cafe')
       on conflict (slug) do update set name=excluded.name returning id`,
      [slug, `${slug} co`, TZ],
    )
    const tenantId = t.rows[0].id
    const b = await ownerPool.query<{ id: string }>(
      `insert into branches (tenant_id,name,is_primary) values ($1,'Main',true)
       on conflict (tenant_id,name) do update set is_primary=true returning id`,
      [tenantId],
    )
    const branchId = b.rows[0].id
    const rt = await ownerPool.query<{ id: string }>(
      `insert into resource_types (tenant_id,name,hourly_rate) values ($1,'Station','100')
       on conflict (tenant_id,name) do update set hourly_rate=excluded.hourly_rate returning id`,
      [tenantId],
    )
    const r = await ownerPool.query<{ id: string }>(
      `insert into resources (tenant_id,branch_id,resource_type_id,name) values ($1,$2,$3,'R1') returning id`,
      [tenantId, branchId, rt.rows[0].id],
    )
    return { tenantId, branchId, resourceId: r.rows[0].id }
  }

  const A = await makeTenant('testpubbook-a')
  const B = await makeTenant('testpubbook-b')

  // ── 1. a public session can create a booking and gets a real BK- number ────
  {
    const now = new Date()
    const starts = new Date(now.getTime() + 60 * 60_000)
    const ends = new Date(now.getTime() + 120 * 60_000)

    const result = await attempt(() =>
      withPublicTenant(A.tenantId, (tx) =>
        createBookingCore(
          tx,
          { tenantId: A.tenantId, timezone: TZ, membershipId: null },
          {
            branchId: A.branchId,
            source: 'online',
            discount: 0,
            deposit: 0,
            customerName: 'Public Guest',
            customerPhone: '+919876500001',
            slots: [{ resourceId: A.resourceId, startsAt: starts.toISOString(), endsAt: ends.toISOString() }],
          },
        ),
      ),
    )
    check('a public (logged-out) session can create a booking', result.ok)
    if (result.ok) {
      check('the booking gets a real BK-YYYYMMDD-NNN number', /^BK-\d{8}-\d{3}$/.test(result.value.bookingNumber))
    }

    const { rows } = await ownerPool.query(`select kind, value from sequences where tenant_id=$1 and kind='booking'`, [
      A.tenantId,
    ])
    check("the tenant's 'booking' sequence row was actually bumped", rows.length === 1 && rows[0].value >= 1)
  }

  // ── 2. a public session still cannot mint an 'invoice' number — 0078
  //      widened booking/order/kot only, invoice stays staff-only ────────────
  {
    const period = new Date().toISOString().slice(0, 10).replace(/-/g, '')
    const blocked = await attempt(() =>
      withPublicTenant(A.tenantId, (tx) =>
        tx.execute(sql`
          insert into sequences (tenant_id, kind, period, value)
          values (${A.tenantId}, 'invoice', ${period}, 1)
          on conflict (tenant_id, kind, period) do update set value = sequences.value + 1
          returning value
        `),
      ),
    )
    check("a public session is still refused an 'invoice' sequence number (RLS)", !blocked.ok)
  }

  // ── 3. a public session pinned to tenant A cannot bump tenant B's counter ──
  {
    const period = new Date().toISOString().slice(0, 10).replace(/-/g, '')
    const crossTenant = await attempt(() =>
      withPublicTenant(A.tenantId, (tx) =>
        tx.execute(sql`
          insert into sequences (tenant_id, kind, period, value)
          values (${B.tenantId}, 'booking', ${period}, 1)
          on conflict (tenant_id, kind, period) do update set value = sequences.value + 1
          returning value
        `),
      ),
    )
    check("tenant A's public session cannot bump tenant B's 'booking' sequence", !crossTenant.ok)
  }

  // ── cleanup ───────────────────────────────────────────────────────────────
  await ownerPool.query('delete from tenants where id = any($1)', [[A.tenantId, B.tenantId]])
  await ownerPool.end()
  await appPool.end()

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
