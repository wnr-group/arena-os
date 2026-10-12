/**
 * M35 #2 — public add-on catalog + live stock, against a real database (needs
 * migration 0110). Everything the public side does runs as `arena_app` (no
 * BYPASSRLS) with only app.public_tenant_id set; the owner pool only seeds.
 *
 *   catalog   active add-ons of the branch/types only, no stock exposed,
 *             other tenant / other branch / inactive never returned
 *   stock     available = stock - overlapping reservations, capped, 0 when
 *             sold out, cancelled bookings release, other windows unaffected
 *   rls       anon cannot INSERT/UPDATE/DELETE the catalog, cannot read
 *             booking_addons, cannot see another tenant's add-ons
 *   lock      the booking path's SELECT ... FOR UPDATE locks own-tenant
 *             active rows only
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs --import ./scripts/next-runtime-hook.mjs scripts/test-public-addons.ts
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
const check = (l: string, c: boolean, got?: unknown) => {
  console.log(`${c ? '✓' : '✗ FAIL'}  ${l}${c ? '' : `  (got: ${JSON.stringify(got)})`}`)
  if (c) pass++
  else fail++
}
const HOUR = 3_600_000
const TZ = 'Asia/Kolkata'

async function main() {
  loadEnv()
  const { getPublicTypeAddons, getPublicAddonAvailability } = await import('../lib/booking/public-availability')
  const ownerPool = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })
  const appPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 })
  const app = drizzle(appPool, { schema })
  const q = <T extends object>(text: string, params: unknown[] = []) => ownerPool.query<T>(text, params)
  const asPublic = <T>(tenantId: string, fn: (tx: Db) => Promise<T>) =>
    app.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.public_tenant_id', ${tenantId}, true)`)
      return fn(tx as unknown as Db)
    })

  const slug = 'testpublicaddons'
  await q(`delete from tenants where slug in ($1, $2)`, [slug, `${slug}x`])
  const mkTenant = async (s: string) => {
    const tenantId = (
      await q<{ id: string }>(
        `insert into tenants (slug,name,status,timezone,industry) values ($1,$2,'active',$3,'recording_studio') returning id`,
        [s, `${s} co`, TZ],
      )
    ).rows[0].id
    const branchId = (
      await q<{ id: string }>(`insert into branches (tenant_id,name,is_primary) values ($1,'Main',true) returning id`, [tenantId])
    ).rows[0].id
    const typeId = (
      await q<{ id: string }>(`insert into resource_types (tenant_id,name,hourly_rate) values ($1,'Studio','100.00') returning id`, [tenantId])
    ).rows[0].id
    return { tenantId, branchId, typeId }
  }
  const A = await mkTenant(slug)
  const B = await mkTenant(`${slug}x`)
  const otherBranch = (
    await q<{ id: string }>(`insert into branches (tenant_id,name,is_primary) values ($1,'Second',false) returning id`, [A.tenantId])
  ).rows[0].id
  const userId = (
    await q<{ id: string }>(
      `insert into users (email,password_hash) values ($1,'x') on conflict (email) do update set email=excluded.email returning id`,
      [`owner@${slug}.test`],
    )
  ).rows[0].id
  const membershipId = (
    await q<{ id: string }>(
      `insert into memberships (tenant_id,user_id,role,status) values ($1,$2,'owner','active') returning id`,
      [A.tenantId, userId],
    )
  ).rows[0].id
  await q(`insert into business_profiles (tenant_id) values ($1) on conflict (tenant_id) do nothing`, [A.tenantId])
  const mkRes = async (name: string) =>
    (
      await q<{ id: string }>(
        `insert into resources (tenant_id,branch_id,resource_type_id,name,status) values ($1,$2,$3,$4,'available') returning id`,
        [A.tenantId, A.branchId, A.typeId, name],
      )
    ).rows[0].id
  const r1 = await mkRes('Set A')
  const r2 = await mkRes('Set B')
  const mkAddon = async (
    t: { tenantId: string; branchId: string; typeId: string },
    name: string,
    stock: number,
    o: { active?: boolean; branch?: string } = {},
  ) =>
    (
      await q<{ id: string }>(
        `insert into resource_type_addons (tenant_id,branch_id,resource_type_id,name,rate,rate_unit,stock_quantity,is_active)
         values ($1,$2,$3,$4,'100.00','hour',$5,$6) returning id`,
        [t.tenantId, o.branch ?? t.branchId, t.typeId, name, stock, o.active ?? true],
      )
    ).rows[0].id
  const camera = await mkAddon(A, 'Camera', 2)
  const bulk = await mkAddon(A, 'Chairs', 15)
  await mkAddon(A, 'Retired', 5, { active: false })
  await mkAddon(A, 'Elsewhere', 5, { branch: otherBranch })
  const foreign = await mkAddon(B, 'Foreign', 5)

  // ── catalog ────────────────────────────────────────────────────────────────
  const cat = await getPublicTypeAddons(A.tenantId, A.branchId, [A.typeId])
  check('C1 catalog = active add-ons of this branch only', cat.map((c) => c.name).sort().join() === 'Camera,Chairs', cat.map((c) => c.name))
  check('C2 catalog rows expose no stock', cat.every((c) => !('stockQuantity' in c) && !('stock_quantity' in c)), cat[0])
  check('C3 empty type list -> []', (await getPublicTypeAddons(A.tenantId, A.branchId, [])).length === 0)

  // ── live stock ─────────────────────────────────────────────────────────────
  const t0 = new Date(Date.now() + 3 * 24 * HOUR)
  t0.setUTCMinutes(0, 0, 0)
  const win = (h0: number, h1: number) => [new Date(t0.getTime() + h0 * HOUR), new Date(t0.getTime() + h1 * HOUR)] as const
  const avail = async (h0: number, h1: number) => {
    const [s, e] = win(h0, h1)
    const rows = await getPublicAddonAvailability(A.tenantId, A.branchId, [A.typeId], s, e)
    return Object.fromEntries(rows.map((r) => [r.name, r.available]))
  }
  const before = await avail(0, 3)
  check('K1 nothing booked: Camera 2, Chairs capped at 10 (stock 15 not revealed)', before.Camera === 2 && before.Chairs === 10, before)

  const ctx = { tenantId: A.tenantId, timezone: TZ, membershipId }
  const book = (resourceId: string, h0: number, h1: number, addonId: string, quantity: number) => {
    const [s, e] = win(h0, h1)
    return app.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`)
      return createBookingCore(tx as unknown as Db, ctx, {
        branchId: A.branchId,
        customerName: 'T',
        customerPhone: '9876543210',
        source: 'staff',
        discount: 0,
        deposit: 0,
        slots: [{ resourceId, startsAt: s.toISOString(), endsAt: e.toISOString(), addons: [{ addonId, quantity }] }],
      })
    })
  }
  const b1 = await book(r1, 0, 3, camera, 2)
  check('K2 sold-out window reports available 0', (await avail(1, 2)).Camera === 0, await avail(1, 2))
  check('K3 non-overlapping window unaffected', (await avail(3, 4)).Camera === 2, await avail(3, 4))
  const partial = await book(r2, 5, 6, camera, 1)
  check('K4 partial hold subtracts (2-1=1)', (await avail(5, 6)).Camera === 1 && Boolean(partial.id))
  await q(`update bookings set status='cancelled' where id=$1`, [b1.id])
  check('K5 cancelled booking releases its units', (await avail(1, 2)).Camera === 2, await avail(1, 2))

  // ── anon RLS negatives ────────────────────────────────────────────────────
  const pubCatalog = await asPublic(
    A.tenantId,
    async (tx) => (await tx.execute(sql`select name from resource_type_addons`)).rows as { name: string }[],
  )
  check(
    'R1 anon sees only active add-ons of its tenant',
    pubCatalog.length === 3 && !pubCatalog.some((r) => r.name === 'Foreign' || r.name === 'Retired'),
    pubCatalog,
  )
  const pubBA = await asPublic(A.tenantId, async (tx) => (await tx.execute(sql`select 1 from booking_addons`)).rows.length)
  check('R2 anon cannot read booking_addons (rows exist)', pubBA === 0, pubBA)
  const denied = async (stmt: ReturnType<typeof sql>) => {
    try {
      const r = await asPublic(A.tenantId, (tx) => tx.execute(stmt))
      return (r.rowCount ?? 0) === 0
    } catch {
      return true
    }
  }
  check(
    'R3 anon INSERT into catalog refused',
    await denied(
      sql`insert into resource_type_addons (tenant_id,branch_id,resource_type_id,name,rate,rate_unit,stock_quantity) values (${A.tenantId},${A.branchId},${A.typeId},'Hax','1','hour',1)`,
    ),
  )
  check('R4 anon UPDATE of catalog refused', await denied(sql`update resource_type_addons set stock_quantity = 999 where id = ${camera}`))
  check('R5 anon DELETE from catalog refused', await denied(sql`delete from resource_type_addons where id = ${camera}`))
  check('R6 anon cannot write booking_addons', await denied(sql`delete from booking_addons`))
  const still = (await q<{ stock_quantity: number }>(`select stock_quantity from resource_type_addons where id=$1`, [camera])).rows[0]
  const hax = (await q<{ n: number }>(`select count(*)::int n from resource_type_addons where name = 'Hax'`)).rows[0].n
  const baLeft = (await q<{ n: number }>(`select count(*)::int n from booking_addons where tenant_id = $1`, [A.tenantId])).rows[0].n
  check('R7 catalog + booking_addons unchanged after the write attempts', still.stock_quantity === 2 && hax === 0 && baLeft === 2, { still, hax, baLeft })
  const crossLock = await asPublic(
    A.tenantId,
    async (tx) => (await tx.execute(sql`select id from resource_type_addons where id = ${foreign} for update`)).rows.length,
  )
  check("R8 anon cannot see/lock another tenant's add-on", crossLock === 0, crossLock)
  const fnForeign = await asPublic(
    A.tenantId,
    async (tx) =>
      (await tx.execute(sql`select * from public.public_addon_reserved_units(array[${foreign}]::uuid[], now(), now() + interval '1 hour')`))
        .rows.length,
  )
  check("R9 stock function ignores another tenant's add-on", fnForeign === 0, fnForeign)

  // ── lock path under the public role ───────────────────────────────────────
  const locked = await asPublic(
    A.tenantId,
    async (tx) =>
      (await tx.execute(sql`select id from resource_type_addons where tenant_id = ${A.tenantId} order by id for update`)).rows.length,
  )
  check('L1 FOR UPDATE locks own-tenant active rows only (3 of 4; retired excluded)', locked === 3, locked)
  const bulkLock = await asPublic(
    A.tenantId,
    async (tx) => (await tx.execute(sql`select id from resource_type_addons where id = ${bulk} for update`)).rows.length,
  )
  check('L2 a single add-on is lockable', bulkLock === 1, bulkLock)

  await q(`delete from tenants where slug in ($1, $2)`, [slug, `${slug}x`])
  await ownerPool.end()
  await appPool.end()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
