/**
 * M35 #7 — setup photos (migration 0113), against a real database. Everything
 * except fixture seeding runs as `arena_app` (no BYPASSRLS):
 *
 *   cap        a 4th image / position 0 / duplicate position are rejected by the
 *              DATABASE, including two concurrent inserts racing for position 3
 *   cascade    deleting the setup, its resource, or the tenant removes the rows
 *   anon       reads images only of ACTIVE setups of the resolved tenant; never
 *              another tenant's; cannot write
 *   staff      every member reads; only owner/manager writes (cashier,
 *              receptionist, floor_staff refused by RLS)
 *   helpers    listResourceSetups + the three public fetchers return images in
 *              position order (cover first), [] for a setup without photos
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs --import ./scripts/next-runtime-hook.mjs scripts/test-setup-images.ts
 */
import { randomBytes } from 'node:crypto'
import { Pool } from 'pg'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { sql } from 'drizzle-orm'
import * as schema from '../db/schema'
import { loadEnv } from './env'

loadEnv()
type Db = NodePgDatabase<typeof schema>

let pass = 0
let fail = 0
const check = (label: string, cond: boolean, got?: unknown) => {
  console.log(`${cond ? '✓' : '✗ FAIL'}  ${label}${cond ? '' : `  (got: ${JSON.stringify(got)})`}`)
  if (cond) pass++
  else fail++
}

const pgCode = (e: unknown): string | undefined => {
  const err = e as { code?: string; cause?: { code?: string } }
  return err?.cause?.code ?? err?.code
}

async function main() {
  const { getPublicResourceSetups, getPublicTypeUnitsWithSetups, getPublicStorefrontSetups } = await import(
    '../lib/booking/public-availability'
  )
  const { listResourceSetups } = await import('../lib/booking/data')
  const owner = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })
  const appPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 })
  const app = drizzle(appPool, { schema })
  const q = <T extends object>(text: string, params: unknown[] = []) => owner.query<T>(text, params)
  const tag = randomBytes(3).toString('hex')

  const asPublic = <T>(tenantId: string, fn: (tx: Db) => Promise<T>) =>
    app.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.public_tenant_id', ${tenantId}, true)`)
      return fn(tx as unknown as Db)
    })
  const asUser = <T>(userId: string, fn: (tx: Db) => Promise<T>) =>
    app.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`)
      return fn(tx as unknown as Db)
    })

  async function mkTenant(slug: string) {
    const tenantId = (await q<{ id: string }>(`insert into tenants (slug,name,status,timezone,industry) values ($1,$2,'active','Asia/Kolkata','recording_studio') returning id`, [slug, slug])).rows[0].id
    const branchId = (await q<{ id: string }>(`insert into branches (tenant_id,name,is_primary,status) values ($1,'Main',true,'active') returning id`, [tenantId])).rows[0].id
    const typeId = (await q<{ id: string }>(`insert into resource_types (tenant_id,name,hourly_rate) values ($1,'Studio','500.00') returning id`, [tenantId])).rows[0].id
    const resourceId = (await q<{ id: string }>(`insert into resources (tenant_id,branch_id,resource_type_id,name,status) values ($1,$2,$3,'Set A','available') returning id`, [tenantId, branchId, typeId])).rows[0].id
    return { tenantId, branchId, typeId, resourceId }
  }
  const mkSetup = async (t: { tenantId: string; resourceId: string }, name: string, active = true) =>
    (await q<{ id: string }>(`insert into resource_setups (tenant_id,resource_id,name,rate,rate_unit,is_active) values ($1,$2,$3,'800.00','hour',$4) returning id`, [t.tenantId, t.resourceId, name, active])).rows[0].id
  const addImg = (tenantId: string, setupId: string, position: number, url = `https://img.test/${tag}/${setupId}-${position}.jpg`) =>
    q(`insert into resource_setup_images (tenant_id,setup_id,url,position) values ($1,$2,$3,$4)`, [tenantId, setupId, url, position])
  const imgCount = async (setupId: string) => Number((await q<{ n: string }>(`select count(*) n from resource_setup_images where setup_id=$1`, [setupId])).rows[0].n)

  const A = await mkTenant(`setup-img-a-${tag}`)
  const B = await mkTenant(`setup-img-b-${tag}`)
  const cover = await mkSetup(A, 'Cover')
  const plain = await mkSetup(A, 'No Photos')
  const retired = await mkSetup(A, 'Retired', false)
  const foreign = await mkSetup(B, 'Foreign')

  // ── the cap, in the database ──────────────────────────────────────────────
  // inserted out of order on purpose: position order, not insert order, must win
  await addImg(A.tenantId, cover, 3)
  await addImg(A.tenantId, cover, 1)
  await addImg(A.tenantId, cover, 2)
  check('3 images fit', (await imgCount(cover)) === 3)
  const rejects = async (p: Promise<unknown>) => {
    try {
      await p
      return undefined
    } catch (e) {
      return pgCode(e)
    }
  }
  check('4th image (position 4) rejected by CHECK', (await rejects(addImg(A.tenantId, cover, 4))) === '23514')
  check('position 0 rejected by CHECK', (await rejects(addImg(A.tenantId, cover, 0))) === '23514')
  check('duplicate position rejected by UNIQUE', (await rejects(addImg(A.tenantId, cover, 2))) === '23505')
  check('still exactly 3 rows after the rejected inserts', (await imgCount(cover)) === 3)

  const race = await mkSetup(A, 'Race')
  await addImg(A.tenantId, race, 1)
  await addImg(A.tenantId, race, 2)
  const settled = await Promise.allSettled([addImg(A.tenantId, race, 3, 'https://img.test/r1.jpg'), addImg(A.tenantId, race, 3, 'https://img.test/r2.jpg')])
  const won = settled.filter((s) => s.status === 'fulfilled').length
  const lostCode = settled.map((s) => (s.status === 'rejected' ? pgCode(s.reason) : null)).find(Boolean)
  check('two concurrent inserts racing for position 3: exactly one wins, the other gets 23505', won === 1 && lostCode === '23505', { won, lostCode })
  check('racing setup holds exactly 3 images', (await imgCount(race)) === 3)

  // ── helpers return photos in position order ──────────────────────────────
  const expected = [1, 2, 3].map((p) => `https://img.test/${tag}/${cover}-${p}.jpg`)
  const sameList = (a: unknown) => JSON.stringify(a) === JSON.stringify(expected)
  const pubSetups = await getPublicResourceSetups(A.tenantId, A.resourceId)
  check('getPublicResourceSetups: images in position order', sameList(pubSetups.find((s) => s.id === cover)?.images), pubSetups)
  check('getPublicResourceSetups: setup without photos -> []', pubSetups.find((s) => s.id === plain)?.images.length === 0)
  const units = await getPublicTypeUnitsWithSetups(A.tenantId, A.branchId, A.typeId)
  check('getPublicTypeUnitsWithSetups: images in position order', sameList(units[0]?.setups.find((s) => s.id === cover)?.images), units[0]?.setups)
  const flat = await getPublicStorefrontSetups(A.tenantId, A.branchId, 'recording_studio')
  check('getPublicStorefrontSetups: images in position order', sameList(flat.find((s) => s.setupId === cover)?.images), flat.map((f) => f.images))
  check('storefront fetcher still hides the inactive setup', !flat.some((s) => s.setupId === retired))

  // ── anon RLS (real public role) ──────────────────────────────────────────
  await addImg(A.tenantId, retired, 1)
  await addImg(B.tenantId, foreign, 1)
  const anonRows = await asPublic(A.tenantId, async (tx) => (await tx.execute(sql`select setup_id from resource_setup_images`)).rows as { setup_id: string }[])
  const anonIds = new Set(anonRows.map((r) => r.setup_id))
  check('anon sees images of the active setups of its tenant', anonIds.has(cover) && anonIds.has(race))
  check('anon cannot see an INACTIVE setup\'s images', !anonIds.has(retired), [...anonIds])
  check("anon cannot see another tenant's images", !anonIds.has(foreign))
  const denied = async (stmt: ReturnType<typeof sql>) => {
    try {
      const r = await asPublic(A.tenantId, (tx) => tx.execute(stmt))
      return (r.rowCount ?? 0) === 0
    } catch {
      return true
    }
  }
  check('anon INSERT refused', await denied(sql`insert into resource_setup_images (tenant_id,setup_id,url,position) values (${A.tenantId},${plain},'https://x.test/h.jpg',1)`))
  check('anon UPDATE refused', await denied(sql`update resource_setup_images set url = 'https://x.test/h.jpg' where setup_id = ${cover}`))
  check('anon DELETE refused', await denied(sql`delete from resource_setup_images where setup_id = ${cover}`))
  check('rows untouched after the anon write attempts', (await imgCount(cover)) === 3 && (await imgCount(plain)) === 0)

  // ── staff roles (real member sessions) ───────────────────────────────────
  const staff: Record<string, string> = {}
  for (const role of ['owner', 'manager', 'cashier', 'receptionist', 'floor_staff']) {
    const uid = (await q<{ id: string }>(`insert into users (email,password_hash) values ($1,'x') on conflict (email) do update set email=excluded.email returning id`, [`${role}-${tag}@setup-img.test`])).rows[0].id
    await q(`insert into memberships (tenant_id,user_id,role,status) values ($1,$2,$3,'active')`, [A.tenantId, uid, role])
    staff[role] = uid
  }
  for (const role of ['cashier', 'receptionist', 'floor_staff']) {
    const readN = await asUser(staff[role], async (tx) => (await tx.execute(sql`select 1 from resource_setup_images where setup_id = ${cover}`)).rows.length)
    check(`${role} can read the images`, readN === 3, readN)
    let code: string | undefined
    try {
      await asUser(staff[role], (tx) => tx.execute(sql`insert into resource_setup_images (tenant_id,setup_id,url,position) values (${A.tenantId},${plain},'https://x.test/s.jpg',1)`))
    } catch (e) {
      code = pgCode(e)
    }
    check(`${role} INSERT refused by RLS (42501)`, code === '42501', code)
    const upd = await asUser(staff[role], (tx) => tx.execute(sql`update resource_setup_images set url = 'https://x.test/s.jpg' where setup_id = ${cover}`))
    const del = await asUser(staff[role], (tx) => tx.execute(sql`delete from resource_setup_images where setup_id = ${cover}`))
    check(`${role} UPDATE/DELETE touch no rows`, (upd.rowCount ?? 0) === 0 && (del.rowCount ?? 0) === 0)
  }
  check('rows intact after the non-manager attempts', (await imgCount(cover)) === 3)
  for (const role of ['owner', 'manager']) {
    let ok = true
    try {
      await asUser(staff[role], (tx) => tx.execute(sql`insert into resource_setup_images (tenant_id,setup_id,url,position) values (${A.tenantId},${plain},${`https://x.test/${role}.jpg`},${role === 'owner' ? 1 : 2})`))
    } catch {
      ok = false
    }
    check(`${role} can write`, ok)
  }
  const adminSetups = await listResourceSetups(
    { user: { id: staff.owner }, tenant: { id: A.tenantId } } as never,
    A.branchId,
  )
  const row = adminSetups.find((s) => s.id === cover)
  check('listResourceSetups (staff): images in position order', sameList(row?.images), row)
  check('listResourceSetups (staff): includes the inactive setup\'s photos for the owner', (adminSetups.find((s) => s.id === retired)?.images.length ?? 0) === 1)

  // ── cascades ─────────────────────────────────────────────────────────────
  await q(`delete from resource_setups where id=$1`, [race])
  check('deleting a setup removes its images', (await imgCount(race)) === 0)
  const fresh = await mkTenant(`setup-img-c-${tag}`)
  const s1 = await mkSetup(fresh, 'One')
  await addImg(fresh.tenantId, s1, 1)
  await q(`delete from resources where id=$1`, [fresh.resourceId])
  check('deleting the resource cascades through its setup to the images', (await imgCount(s1)) === 0)
  const s2 = await mkSetup(A, 'Two')
  await addImg(A.tenantId, s2, 1)
  await q('delete from tenants where id in ($1,$2,$3)', [A.tenantId, B.tenantId, fresh.tenantId])
  const left = Number((await q<{ n: string }>(`select count(*) n from resource_setup_images where tenant_id in ($1,$2,$3)`, [A.tenantId, B.tenantId, fresh.tenantId])).rows[0].n)
  check('deleting the tenant removes every image row', left === 0, left)

  await q(`delete from users where email like $1`, [`%-${tag}@setup-img.test`])
  await owner.end()
  await appPool.end()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
