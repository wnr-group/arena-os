/**
 * M35 #8 — setup photo server actions (uploadSetupImage / removeSetupImage /
 * reorderSetupImages, plus the storage cleanup in deleteResourceSetup and
 * deleteResource). Drives the REAL actions behind the REAL requireManager()
 * guard (only next/headers + next/cache are faked, see next-runtime-stub.cjs).
 *
 * Storage: the real lib/storage/s3.ts code runs (validateUpload, key building,
 * objectKeyFromUrl guard) but its S3 client is replaced by a recording fake
 * through the module's own client cache, so no bucket or credentials are
 * needed and every PutObject/DeleteObject is observable.
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs --import ./scripts/next-runtime-hook.mjs scripts/test-setup-photo-actions.ts
 */
import { createHash, randomBytes } from 'node:crypto'
import { Pool } from 'pg'
import { loadEnv } from './env'

loadEnv()

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

  // ── recording fake S3 ─────────────────────────────────────────────────────
  // Optional barrier: while > 0, a PutObject waits until that many puts have
  // STARTED (or 15s), so two uploads can be forced to both pass the app-level
  // cap pre-check before either one reaches the database.
  let barrier = 0
  let startedPuts = 0
  const puts: string[] = []
  const deletes: string[] = []
  const live = () => puts.filter((k) => !deletes.includes(k))
  ;(globalThis as { __s3Client?: unknown }).__s3Client = {
    async send(cmd: { constructor: { name: string }; input: { Key: string } }) {
      if (cmd.constructor.name === 'PutObjectCommand') {
        startedPuts++
        if (barrier > 0) {
          const t0 = Date.now()
          while (startedPuts < barrier && Date.now() - t0 < 15_000) await new Promise((r) => setTimeout(r, 25))
        }
        puts.push(cmd.input.Key)
      } else if (cmd.constructor.name === 'DeleteObjectCommand') {
        deletes.push(cmd.input.Key)
      }
      return {}
    },
  }
  const keyOf = (url: string) => url.replace('https://cdn.example.test/arena/', '')

  const { uploadSetupImage, removeSetupImage, reorderSetupImages, deleteResourceSetup, deleteResource } = await import(
    '../lib/actions/resources'
  )

  const owner = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })
  const tag = randomBytes(3).toString('hex')
  const q = <T extends object>(text: string, params: unknown[] = []) => owner.query<T>(text, params)

  async function makeUser(label: string) {
    const u = await q<{ id: string }>(`insert into users (email, password_hash, full_name) values ($1,'x',$2) returning id`, [`photos-${label}-${tag}@example.test`, label])
    const token = randomBytes(32).toString('hex')
    await q(`insert into sessions (id, user_id, expires_at) values ($1,$2, now() + interval '1 day')`, [createHash('sha256').update(token).digest('hex'), u.rows[0].id])
    return { id: u.rows[0].id, token }
  }
  async function makeTenant(slug: string, industry: string) {
    const tenantId = (await q<{ id: string }>(`insert into tenants (slug,name,status,timezone,industry) values ($1,$1,'active','Asia/Kolkata',$2) returning id`, [slug, industry])).rows[0].id
    const branchId = (await q<{ id: string }>(`insert into branches (tenant_id,name,is_primary) values ($1,'Main',true) returning id`, [tenantId])).rows[0].id
    const typeId = (await q<{ id: string }>(`insert into resource_types (tenant_id,name,hourly_rate) values ($1,'Studio','500.00') returning id`, [tenantId])).rows[0].id
    const resourceId = (await q<{ id: string }>(`insert into resources (tenant_id,branch_id,resource_type_id,name,status) values ($1,$2,$3,'Set A','available') returning id`, [tenantId, branchId, typeId])).rows[0].id
    return { tenantId, branchId, resourceId }
  }
  const join = (t: { tenantId: string; branchId: string }, u: { id: string }, role: string) =>
    q(`insert into memberships (tenant_id,user_id,branch_id,role,status,full_name) values ($1,$2,$3,$4::member_role,'active',$4)`, [t.tenantId, u.id, t.branchId, role])
  const mkSetup = async (t: { tenantId: string; resourceId: string }, name: string) =>
    (await q<{ id: string }>(`insert into resource_setups (tenant_id,resource_id,name,rate,rate_unit) values ($1,$2,$3,'800.00','hour') returning id`, [t.tenantId, t.resourceId, name])).rows[0].id

  const A = await makeTenant(`photos-a-${tag}`, 'recording_studio')
  const B = await makeTenant(`photos-b-${tag}`, 'recording_studio')
  const G = await makeTenant(`photos-g-${tag}`, 'gaming_cafe')
  const users = {
    manager: await makeUser('manager'),
    cashier: await makeUser('cashier'),
    receptionist: await makeUser('receptionist'),
    floor_staff: await makeUser('floor_staff'),
    otherManager: await makeUser('othermanager'),
    gameManager: await makeUser('gamemanager'),
  }
  await join(A, users.manager, 'manager')
  await join(A, users.cashier, 'cashier')
  await join(A, users.receptionist, 'receptionist')
  await join(A, users.floor_staff, 'floor_staff')
  await join(B, users.otherManager, 'manager')
  await join(G, users.gameManager, 'manager')

  const g = globalThis as { __ARENA_TEST_SESSION?: string; __ARENA_TEST_HEADERS?: Record<string, string> }
  const as = (u: { token: string }, slug: string) => {
    g.__ARENA_TEST_SESSION = u.token
    g.__ARENA_TEST_HEADERS = { 'x-tenant-slug': slug }
  }
  const slugA = `photos-a-${tag}`
  // A file whose first bytes really are the declared image type (the action
  // verifies content, not just the declared MIME).
  const MAGIC: Record<string, number[]> = {
    'image/jpeg': [0xff, 0xd8, 0xff, 0xe0],
    'image/png': [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    'image/gif': [0x47, 0x49, 0x46, 0x38, 0x39, 0x61],
    'image/webp': [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50],
  }
  const jpeg = (name = 'photo.jpg', size = 2048, type = 'image/jpeg') => {
    const bytes = new Uint8Array(size).fill(7)
    const magic = MAGIC[type] ?? []
    bytes.set(magic.slice(0, size))
    const fd = new FormData()
    fd.set('file', new File([bytes], name, { type }))
    return fd
  }
  const rowsOf = async (setupId: string) =>
    (await q<{ id: string; url: string; position: number }>(`select id,url,position from resource_setup_images where setup_id=$1 order by position`, [setupId])).rows

  const setup = await mkSetup(A, 'Podcast')
  const otherSetup = await mkSetup(B, 'Theirs')
  const gameSetup = await mkSetup(G, 'Nope')

  // ══ role gate ═════════════════════════════════════════════════════════════
  console.log('\n── role gate ──')
  for (const role of ['cashier', 'receptionist', 'floor_staff'] as const) {
    as(users[role], slugA)
    const up = await uploadSetupImage(setup, jpeg())
    const rm = await removeSetupImage('00000000-0000-4000-8000-000000000000')
    const ro = await reorderSetupImages(setup, ['00000000-0000-4000-8000-000000000000'])
    check(`${role}: upload / remove / reorder all refused`, [up, rm, ro].every((r) => /owners and managers/i.test(r.error ?? '')), [up, rm, ro])
  }
  check('…nothing was stored or written', puts.length === 0 && (await rowsOf(setup)).length === 0)

  as(users.otherManager, `photos-b-${tag}`)
  const crossUp = await uploadSetupImage(setup, jpeg())
  check("another tenant's manager cannot upload to this setup", /not found/i.test(crossUp.error ?? '') && puts.length === 0, crossUp)
  as(users.gameManager, `photos-g-${tag}`)
  const gameUp = await uploadSetupImage(gameSetup, jpeg())
  check('non-studio industry is refused', /not available/i.test(gameUp.error ?? '') && puts.length === 0, gameUp)

  // ══ validation ════════════════════════════════════════════════════════════
  console.log('\n── validation ──')
  as(users.manager, slugA)
  const wrongType = await uploadSetupImage(setup, jpeg('x.jpg', 100, 'text/plain'))
  const empty = await uploadSetupImage(setup, jpeg('x.jpg', 0))
  const huge = await uploadSetupImage(setup, jpeg('x.jpg', 5 * 1024 * 1024 + 1))
  const noFile = await uploadSetupImage(setup, new FormData())
  check('wrong type rejected', /only .* are allowed/i.test(wrongType.error ?? ''), wrongType)
  check('empty file rejected', /empty/i.test(empty.error ?? ''), empty)
  check('oversize file rejected', /smaller than 5MB/i.test(huge.error ?? ''), huge)
  check('missing file rejected', /choose an image/i.test(noFile.error ?? ''), noFile)
  check('…none of them reached storage or the database', puts.length === 0 && (await rowsOf(setup)).length === 0)

  // ══ upload, cap, cover ════════════════════════════════════════════════════
  console.log('\n── upload + cap ──')
  const u1 = await uploadSetupImage(setup, jpeg('evil.php.exe'))
  const u2 = await uploadSetupImage(setup, jpeg('b.png', 500, 'image/png'))
  check('first two uploads succeed at positions 1, 2', u1.position === 1 && u2.position === 2, [u1, u2])
  check(
    'key is tenants/{tenant}/resource-setups/{setup}/{uuid}.{ext}, extension from the MIME map not the filename',
    puts.every((k) => k.startsWith(`tenants/${A.tenantId}/resource-setups/${setup}/`)) && puts[0].endsWith('.jpg') && puts[1].endsWith('.png') && !puts[0].includes('evil'),
    puts,
  )

  // two simultaneous uploads with 2 images already present: exactly 3 total
  const putsBefore = puts.length
  startedPuts = 0
  barrier = 2 // both uploads must pass the pre-check before either may finish
  const [r1, r2] = await Promise.all([uploadSetupImage(setup, jpeg('c1.jpg')), uploadSetupImage(setup, jpeg('c2.jpg'))])
  const okCount = [r1, r2].filter((r) => r.id).length
  const loser = [r1, r2].find((r) => r.error)
  check('2 concurrent uploads at 2 existing images: exactly one wins', okCount === 1 && /at most 3/i.test(loser?.error ?? ''), [r1, r2])
  check('…exactly 3 image rows', (await rowsOf(setup)).length === 3)
  check('…the loser left no orphan object (every live object has a row)', live().length === 3 && puts.length - putsBefore === 2 && deletes.length === 1, { puts, deletes })

  barrier = 0
  const before4 = puts.length
  const fourth = await uploadSetupImage(setup, jpeg('d.jpg'))
  check('4th upload rejected with a clear message and writes nothing to storage', /at most 3/i.test(fourth.error ?? '') && puts.length === before4, fourth)

  // ══ reorder ═══════════════════════════════════════════════════════════════
  console.log('\n── reorder ──')
  let rows = await rowsOf(setup)
  const [i1, i2, i3] = rows.map((r) => r.id)
  const reordered = await reorderSetupImages(setup, [i3, i1, i2])
  rows = await rowsOf(setup)
  check('valid reorder: positions follow the list, cover changes', !reordered.error && rows.map((r) => r.id).join() === [i3, i1, i2].join() && rows.map((r) => r.position).join() === '1,2,3', rows)

  const foreignImg = (await q<{ id: string }>(`insert into resource_setup_images (tenant_id,setup_id,url,position) values ($1,$2,'https://cdn.example.test/arena/x/y.jpg',1) returning id`, [B.tenantId, otherSetup])).rows[0].id
  const bad = [
    ['incomplete list', [i3, i1]],
    ['foreign image id', [i3, i1, foreignImg]],
    ['duplicate ids', [i3, i3, i1]],
    ['extra unknown id', [i3, i1, i2, '00000000-0000-4000-8000-000000000000']],
  ] as const
  for (const [label, list] of bad) {
    const r = await reorderSetupImages(setup, [...list])
    check(`reorder with ${label} rejected`, Boolean(r.error), r)
  }
  check('…order unchanged after the bad attempts', (await rowsOf(setup)).map((r) => r.id).join() === [i3, i1, i2].join())
  as(users.otherManager, `photos-b-${tag}`)
  const crossReorder = await reorderSetupImages(setup, [i3, i1, i2])
  const crossRemove = await removeSetupImage(i1)
  check("another tenant's manager cannot reorder or remove", Boolean(crossReorder.error) && Boolean(crossRemove.error) && (await rowsOf(setup)).length === 3, [crossReorder, crossRemove])
  as(users.manager, slugA)

  // ══ remove + repack ═══════════════════════════════════════════════════════
  console.log('\n── remove ──')
  const coverBefore = (await rowsOf(setup))[0]
  const deletesBefore = deletes.length
  const rem = await removeSetupImage(coverBefore.id)
  rows = await rowsOf(setup)
  check('remove cover: 2 rows left, re-packed to positions 1,2', !rem.error && rows.length === 2 && rows.map((r) => r.position).join() === '1,2', rows)
  check('…the old second image is now the cover', rows[0].id === i1, rows)
  check('…its storage object was deleted', deletes.length === deletesBefore + 1 && deletes.includes(keyOf(coverBefore.url)), deletes)
  const upAgain = await uploadSetupImage(setup, jpeg('again.jpg'))
  check('a freed slot can be filled again (position 3)', upAgain.position === 3, upAgain)

  // deletion guard: a row whose URL is not under our base must never trigger a delete
  const guardSetup = await mkSetup(A, 'Guard')
  const foreignUrls = ['https://evil.example.com/bucket/steal.jpg', 'https://cdn.example.test/arena/../../other.jpg']
  const guardIds: string[] = []
  for (const [i, url] of foreignUrls.entries()) {
    guardIds.push((await q<{ id: string }>(`insert into resource_setup_images (tenant_id,setup_id,url,position) values ($1,$2,$3,$4) returning id`, [A.tenantId, guardSetup, url, i + 1])).rows[0].id)
  }
  const dBefore = deletes.length
  for (const id of guardIds) await removeSetupImage(id)
  check('foreign / traversal URLs are removed from the DB but never sent to storage', deletes.length === dBefore && (await rowsOf(guardSetup)).length === 0, deletes.slice(dBefore))

  // ══ delete-setup / delete-resource cleanup ═══════════════════════════════
  console.log('\n── lifecycle cleanup ──')
  const setupKeys = (await rowsOf(setup)).map((r) => keyOf(r.url))
  const d1 = deletes.length
  const delSetup = await deleteResourceSetup(setup)
  check('deleteResourceSetup removes every photo object', !delSetup.error && setupKeys.every((k) => deletes.includes(k)) && deletes.length === d1 + setupKeys.length, { setupKeys, deletes: deletes.slice(d1) })
  check('…and the rows are gone', (await rowsOf(setup)).length === 0)

  const delRes = await q<{ id: string }>(`insert into resources (tenant_id,branch_id,resource_type_id,name,status) select tenant_id,branch_id,resource_type_id,'Set Z','available' from resources where id=$1 returning id`, [A.resourceId])
  const zId = delRes.rows[0].id
  const z1 = await mkSetup({ tenantId: A.tenantId, resourceId: zId }, 'Z1')
  const z2 = await mkSetup({ tenantId: A.tenantId, resourceId: zId }, 'Z2')
  const zu1 = await uploadSetupImage(z1, jpeg('z1.jpg'))
  const zu2 = await uploadSetupImage(z2, jpeg('z2.jpg'))
  const zu3 = await uploadSetupImage(z2, jpeg('z3.jpg'))
  const zKeys = [zu1.url!, zu2.url!, zu3.url!].map(keyOf)
  const d2 = deletes.length
  const delResource = await deleteResource(zId)
  check('deleteResource removes the photo objects of ALL its setups', !delResource.error && zKeys.every((k) => deletes.includes(k)) && deletes.length === d2 + 3, { zKeys, deletes: deletes.slice(d2) })

  for (const t of [A, B, G]) await q('delete from tenants where id=$1', [t.tenantId])
  await q(`delete from users where email like $1`, [`photos-%-${tag}@example.test`])
  await owner.end()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
