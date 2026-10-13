/**
 * M35 #11 — QA for setup photos, end to end through the REAL actions (behind the
 * real requireManager guard) and the REAL public/staff readers, with a recording
 * fake S3 client. Complements test-setup-photo-actions.ts (caps, roles, cleanup)
 * and test-setup-images.ts (DB constraints, RLS) with the cross-cutting cases:
 *
 *   files        accepted: jpeg/png/webp/gif, exactly 5 MB. Rejected: svg, pdf, an
 *                HTML file renamed .jpg (declared image/jpeg), a PNG declared as
 *                JPEG, 0 bytes, 5 MB + 1. Filename/extension spoofing is ignored.
 *   visibility   deactivating a setup hides its photos publicly (fetchers AND a
 *                direct anon query); a set in maintenance is not listed; another
 *                tenant's anon session sees nothing
 *   order        a reorder changes the cover in EVERY reader: the storefront
 *                fetcher, the booking-page fetcher, the legacy set picker
 *                fetcher and the staff editor's reader; removing the cover
 *                promotes the next photo everywhere
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs --import ./scripts/next-runtime-hook.mjs scripts/test-setup-photos-qa.ts
 */
import { createHash, randomBytes } from 'node:crypto'
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

async function main() {
  process.env.S3_PUBLIC_URL_BASE = 'https://cdn.example.test/arena'
  process.env.S3_BUCKET = 'test-bucket'
  const puts: string[] = []
  const deletes: string[] = []
  ;(globalThis as { __s3Client?: unknown }).__s3Client = {
    async send(cmd: { constructor: { name: string }; input: { Key: string } }) {
      if (cmd.constructor.name === 'PutObjectCommand') puts.push(cmd.input.Key)
      else if (cmd.constructor.name === 'DeleteObjectCommand') deletes.push(cmd.input.Key)
      return {}
    },
  }

  const { uploadSetupImage, reorderSetupImages, removeSetupImage, upsertResourceSetup } = await import('../lib/actions/resources')
  const { getPublicStorefrontSetups, getPublicResourceSetups, getPublicTypeUnitsWithSetups } = await import('../lib/booking/public-availability')
  const { listResourceSetups } = await import('../lib/booking/data')

  const owner = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })
  const appPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 })
  const app = drizzle(appPool, { schema })
  const tag = randomBytes(3).toString('hex')
  const q = <T extends object>(text: string, params: unknown[] = []) => owner.query<T>(text, params)
  const asPublic = <T>(tenantId: string, fn: (tx: Db) => Promise<T>) =>
    app.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.public_tenant_id', ${tenantId}, true)`)
      return fn(tx as unknown as Db)
    })

  async function makeUser(label: string) {
    const u = await q<{ id: string }>(`insert into users (email, password_hash, full_name) values ($1,'x',$2) returning id`, [`qa-${label}-${tag}@example.test`, label])
    const token = randomBytes(32).toString('hex')
    await q(`insert into sessions (id, user_id, expires_at) values ($1,$2, now() + interval '1 day')`, [createHash('sha256').update(token).digest('hex'), u.rows[0].id])
    return { id: u.rows[0].id, token }
  }
  async function makeTenant(slug: string) {
    const tenantId = (await q<{ id: string }>(`insert into tenants (slug,name,status,timezone,industry) values ($1,$1,'active','Asia/Kolkata','recording_studio') returning id`, [slug])).rows[0].id
    const branchId = (await q<{ id: string }>(`insert into branches (tenant_id,name,is_primary) values ($1,'Main',true) returning id`, [tenantId])).rows[0].id
    const typeId = (await q<{ id: string }>(`insert into resource_types (tenant_id,name,hourly_rate) values ($1,'Studio','500.00') returning id`, [tenantId])).rows[0].id
    const resourceId = (await q<{ id: string }>(`insert into resources (tenant_id,branch_id,resource_type_id,name,status) values ($1,$2,$3,'Set A','available') returning id`, [tenantId, branchId, typeId])).rows[0].id
    return { tenantId, branchId, typeId, resourceId }
  }
  const A = await makeTenant(`photos-qa-a-${tag}`)
  const B = await makeTenant(`photos-qa-b-${tag}`)
  const manager = await makeUser('manager')
  await q(`insert into memberships (tenant_id,user_id,branch_id,role,status,full_name) values ($1,$2,$3,'manager','active','m')`, [A.tenantId, manager.id, A.branchId])
  const g = globalThis as { __ARENA_TEST_SESSION?: string; __ARENA_TEST_HEADERS?: Record<string, string> }
  g.__ARENA_TEST_SESSION = manager.token
  g.__ARENA_TEST_HEADERS = { 'x-tenant-slug': `photos-qa-a-${tag}` }
  const mkSetup = async (name: string) =>
    (await q<{ id: string }>(`insert into resource_setups (tenant_id,resource_id,name,rate,rate_unit) values ($1,$2,$3,'800.00','hour') returning id`, [A.tenantId, A.resourceId, name])).rows[0].id

  // ── file builders: real signatures, or deliberately fake ones ───────────────
  const SIG: Record<string, number[]> = {
    'image/jpeg': [0xff, 0xd8, 0xff, 0xe0],
    'image/png': [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    'image/gif': [0x47, 0x49, 0x46, 0x38, 0x39, 0x61],
    'image/webp': [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50],
  }
  const real = (type: string, size = 1024, name = 'photo.bin') => {
    const bytes = new Uint8Array(size).fill(9)
    bytes.set((SIG[type] ?? []).slice(0, size))
    return file(bytes, name, type)
  }
  const text = (content: string, name: string, type: string) => file(new TextEncoder().encode(content), name, type)
  const file = (bytes: Uint8Array, name: string, type: string) => {
    const fd = new FormData()
    fd.set('file', new File([bytes], name, { type }))
    return fd
  }
  const imgRows = async (setupId: string) => (await q<{ id: string; url: string }>(`select id,url from resource_setup_images where setup_id=$1 order by position`, [setupId])).rows

  // ══ files ═════════════════════════════════════════════════════════════════
  console.log('\n── file types ──')
  for (const [type, ext] of [['image/jpeg', 'jpg'], ['image/png', 'png'], ['image/webp', 'webp'], ['image/gif', 'gif']] as const) {
    const sid = await mkSetup(`ok-${ext}`)
    const r = await uploadSetupImage(sid, real(type, 2048, `holiday.${ext === 'jpg' ? 'jpeg' : ext}`))
    check(`${type} accepted, stored with .${ext}`, !r.error && Boolean(r.url?.endsWith(`.${ext}`)), r)
  }
  const spoof = await mkSetup('spoof')
  const spoofed = await uploadSetupImage(spoof, real('image/png', 512, 'totally-safe.php.html'))
  check('filename/extension spoofing is ignored: key suffix comes from the MIME map', !spoofed.error && Boolean(spoofed.url?.endsWith('.png')) && !spoofed.url!.includes('php') && !spoofed.url!.includes('html'), spoofed)
  const exact = await mkSetup('five-mb')
  const five = await uploadSetupImage(exact, real('image/jpeg', 5 * 1024 * 1024))
  check('exactly 5 MB is accepted', !five.error, five)

  const putsBefore = puts.length
  const bad = await mkSetup('bad-files')
  const cases: [string, FormData, RegExp][] = [
    ['svg (image/svg+xml)', text('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', 'x.svg', 'image/svg+xml'), /only .* are allowed/i],
    ['pdf', text('%PDF-1.7 fake', 'x.pdf', 'application/pdf'), /only .* are allowed/i],
    ['html declared as text/html', text('<html></html>', 'x.jpg', 'text/html'), /only .* are allowed/i],
    ['HTML renamed .jpg (declared image/jpeg)', text('<html><script>alert(1)</script></html>', 'photo.jpg', 'image/jpeg'), /not a valid .* image/i],
    ['PNG bytes declared as image/jpeg', file(new Uint8Array([...SIG['image/png'], 1, 2, 3, 4, 5, 6, 7, 8]), 'x.jpg', 'image/jpeg'), /not a valid .* image/i],
    ['0-byte file', file(new Uint8Array(0), 'x.png', 'image/png'), /empty/i],
    ['5 MB + 1 byte', real('image/png', 5 * 1024 * 1024 + 1), /smaller than 5MB/i],
  ]
  for (const [label, fd, expected] of cases) {
    const r = await uploadSetupImage(bad, fd)
    check(`${label} rejected`, expected.test(r.error ?? ''), r)
  }
  check('…none of the rejected files reached storage or the database', puts.length === putsBefore && (await imgRows(bad)).length === 0)

  // ══ public visibility ═════════════════════════════════════════════════════
  console.log('\n── public visibility ──')
  const vis = await mkSetup('Visible')
  const v1 = await uploadSetupImage(vis, real('image/jpeg'))
  const v2 = await uploadSetupImage(vis, real('image/png'))
  const flat = () => getPublicStorefrontSetups(A.tenantId, A.branchId, 'recording_studio')
  const visRow = async () => (await flat()).find((s) => s.setupId === vis)
  check('active setup: photos are publicly visible, cover first', JSON.stringify((await visRow())?.images) === JSON.stringify([v1.url, v2.url]), await visRow())
  const directAnon = () => asPublic(A.tenantId, async (tx) => (await tx.execute(sql`select 1 from resource_setup_images where setup_id = ${vis}`)).rows.length)
  check('…and readable by an anonymous session directly', (await directAnon()) === 2)

  const crossTenant = await asPublic(B.tenantId, async (tx) => (await tx.execute(sql`select 1 from resource_setup_images where setup_id = ${vis}`)).rows.length)
  check("another tenant's anonymous session sees none of them", crossTenant === 0, crossTenant)

  const deactivate = await upsertResourceSetup({ id: vis, resourceId: A.resourceId, name: 'Visible', rate: 800, rateUnit: 'hour', isActive: false })
  check('manager deactivates the setup', !deactivate.error, deactivate)
  check('deactivated: gone from the storefront fetcher', !(await visRow()))
  check('deactivated: gone from the booking-page fetcher', !(await getPublicResourceSetups(A.tenantId, A.resourceId)).some((s) => s.id === vis))
  check('deactivated: a direct anonymous image query returns nothing', (await directAnon()) === 0)
  check('deactivated: the photos are still there for the owner (nothing was deleted)', (await imgRows(vis)).length === 2)
  await upsertResourceSetup({ id: vis, resourceId: A.resourceId, name: 'Visible', rate: 800, rateUnit: 'hour', isActive: true })
  check('reactivating brings the photos back', (await visRow())?.images.length === 2)

  await q(`update resources set status = 'maintenance' where id = $1`, [A.resourceId])
  check('set in maintenance: none of its setups are listed on the storefront', (await flat()).length === 0)
  check('set in maintenance: none on the booking page either', (await getPublicResourceSetups(A.tenantId, A.resourceId)).length === 0)
  check('set in maintenance: not in the legacy set picker', (await getPublicTypeUnitsWithSetups(A.tenantId, A.branchId, A.typeId)).length === 0)
  await q(`update resources set status = 'available' where id = $1`, [A.resourceId])

  // ══ order: the cover changes everywhere ══════════════════════════════════
  console.log('\n── order ──')
  const ord = await mkSetup('Ordered')
  const o1 = await uploadSetupImage(ord, real('image/jpeg'))
  const o2 = await uploadSetupImage(ord, real('image/png'))
  const o3 = await uploadSetupImage(ord, real('image/webp'))
  const covers = async () => {
    const staff = await listResourceSetups({ user: { id: manager.id }, tenant: { id: A.tenantId } } as never, A.branchId)
    const units = await getPublicTypeUnitsWithSetups(A.tenantId, A.branchId, A.typeId)
    return {
      storefront: (await flat()).find((s) => s.setupId === ord)?.images[0],
      booking: (await getPublicResourceSetups(A.tenantId, A.resourceId)).find((s) => s.id === ord)?.images[0],
      picker: units[0]?.setups.find((s) => s.id === ord)?.images[0],
      staff: staff.find((s) => s.id === ord)?.images[0],
      staffPhotos: staff.find((s) => s.id === ord)?.photos.map((p) => p.id).join(),
    }
  }
  const before = await covers()
  check('initially every reader shows photo 1 as the cover', [before.storefront, before.booking, before.picker, before.staff].every((c) => c === o1.url), before)
  const re = await reorderSetupImages(ord, [o3.id!, o1.id!, o2.id!])
  const after = await covers()
  check('after reorder every reader shows the new cover', !re.error && [after.storefront, after.booking, after.picker, after.staff].every((c) => c === o3.url), after)
  check('the staff editor sees the new order too', after.staffPhotos === [o3.id, o1.id, o2.id].join(), after.staffPhotos)
  const rm = await removeSetupImage(o3.id!)
  const afterRemove = await covers()
  check('removing the cover promotes the next photo in every reader', !rm.error && [afterRemove.storefront, afterRemove.booking, afterRemove.picker, afterRemove.staff].every((c) => c === o1.url), afterRemove)
  check('…and its storage object was deleted', deletes.some((k) => o3.url!.endsWith(k)))

  for (const t of [A, B]) await q('delete from tenants where id=$1', [t.tenantId])
  await q(`delete from users where email like $1`, [`qa-%-${tag}@example.test`])
  await owner.end()
  await appPool.end()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
