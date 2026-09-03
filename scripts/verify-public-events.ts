/**
 * Proves the PUBLIC event surface (M15 #2) against a real database:
 *
 *   - exactly published + registration_open are visible; the other five are not
 *   - the events_public_select POLICY enforces that, not just the reader — the
 *     decisive test issues a query with NO status filter and shows the database
 *     still refuses to hand over a draft
 *   - tenant isolation: an event id from tenant A returns nothing under tenant
 *     B's public context, which is what the detail page and its metadata rely on
 *   - the readers agree with each other (listing / homepage / detail)
 *   - finished events fall out of the listing
 *   - spots-left reflects capacity honestly while M15 #3 does not exist
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs scripts/verify-public-events.ts
 */
import { Client, Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { sql } from 'drizzle-orm'
import * as schema from '../db/schema'
import { loadEnv } from './env'

loadEnv()

let passed = 0
let failed = 0
const check = (label: string, cond: boolean) => {
  console.log(`${cond ? '✓' : '✗ FAIL'}  ${label}`)
  if (cond) passed++
  else failed++
}

const ALL_STATUSES = [
  'draft',
  'published',
  'registration_open',
  'full',
  'in_progress',
  'completed',
  'cancelled',
] as const
/** What the LISTING shows — getPublicEvents() filters to these two itself. */
const PUBLIC = new Set(['published', 'registration_open'])

/**
 * What the POLICY admits, widened by migration 0087 for the live bracket
 * (M15 #7): everything except the two that must never be public. A finished or
 * running tournament has to stay reachable by link so spectators can watch it
 * and read the result; the listing still shows only the two above, because the
 * readers keep their own filter.
 */
const POLICY_PUBLIC = new Set(['published', 'registration_open', 'full', 'in_progress', 'completed'])
const NEVER_PUBLIC = ['draft', 'cancelled']

async function main() {
  const { getPublicEvents, getPublicEventById, getUpcomingPublicEvents } = await import('../lib/events/public')

  const owner = new Client({ connectionString: process.env.DATABASE_URL_OWNER })
  await owner.connect()
  const appPool = new Pool({ connectionString: process.env.DATABASE_URL })
  const app = drizzle(appPool, { schema })

  // ── policy shape ──────────────────────────────────────────────────────────
  console.log('\n── policy ──')
  const pol = await owner.query<{ policyname: string; qual: string }>(
    `select policyname, qual from pg_policies
      where schemaname='public' and tablename='events' and policyname='events_public_select'`,
  )
  check('events_public_select exists', pol.rowCount === 1)
  const qual = pol.rows[0]?.qual ?? ''
  check('…pins the tenant via current_public_tenant_id()', qual.includes('current_public_tenant_id'))
  check('…and filters status in the policy itself', /status/.test(qual))
  // The security property is the EXCLUSION, so that is what is asserted — not
  // the shape of the list, which 0087 legitimately widened.
  check('…and names draft as excluded', /draft/.test(qual))
  check('…and cancelled as excluded', /cancelled/.test(qual))

  const writePolicies = await owner.query<{ policyname: string; cmd: string }>(
    `select policyname, cmd from pg_policies where schemaname='public' and tablename='events'`,
  )
  check(
    'there is NO public write policy of any kind',
    !writePolicies.rows.some((r) => r.policyname.includes('public') && r.cmd !== 'SELECT'),
  )

  // ── two tenants, one event per status each ────────────────────────────────
  async function makeTenant(slug: string) {
    const t = await owner.query<{ id: string }>(
      `insert into tenants (slug, name, status) values ($1,$2,'active')
       on conflict (slug) do update set status='active' returning id`,
      [slug, `${slug} co`],
    )
    const tenantId = t.rows[0].id
    const b = await owner.query<{ id: string }>(
      `insert into branches (tenant_id, name, is_primary, status) values ($1,'Main',true,'active')
       on conflict (tenant_id, name) do update set status='active' returning id`,
      [tenantId],
    )
    return { tenantId, branchId: b.rows[0].id }
  }

  const A = await makeTenant('pevta')
  const B = await makeTenant('pevtb')
  await owner.query(`delete from events where tenant_id = any($1)`, [[A.tenantId, B.tenantId]])

  /** One future event per status, so visibility is the ONLY variable. */
  const idsByStatus: Record<string, string> = {}
  for (const status of ALL_STATUSES) {
    const r = await owner.query<{ id: string }>(
      `insert into events (tenant_id, branch_id, title, type, starts_at, ends_at, capacity, entry_fee, status)
       values ($1,$2,$3,'class', now() + interval '7 days', now() + interval '7 days 2 hours', 20, '300.00', $4::event_status)
       returning id`,
      [A.tenantId, A.branchId, `A ${status}`, status],
    )
    idsByStatus[status] = r.rows[0].id
  }
  const bPublished = (
    await owner.query<{ id: string }>(
      `insert into events (tenant_id, branch_id, title, type, starts_at, ends_at, entry_fee, status)
       values ($1,$2,'B published','class', now() + interval '7 days', now() + interval '7 days 2 hours', '0.00', 'published')
       returning id`,
      [B.tenantId, B.branchId],
    )
  ).rows[0].id

  // ── listing visibility ────────────────────────────────────────────────────
  console.log('\n── listing visibility ──')
  const listed = await getPublicEvents(A.tenantId)
  const listedIds = new Set(listed.map((e) => e.id))

  for (const status of ALL_STATUSES) {
    const shouldSee = PUBLIC.has(status)
    check(
      `${status.padEnd(17)} ${shouldSee ? 'IS' : 'is NOT'} listed`,
      listedIds.has(idsByStatus[status]) === shouldSee,
    )
  }
  check('the listing contains exactly the 2 public events', listed.length === 2)
  check("no other tenant's event leaks into the listing", !listedIds.has(bPublished))

  // ── THE decisive test: the policy, not the reader ─────────────────────────
  console.log('\n── the policy enforces it, not the query ──')
  const rawUnfiltered = await app.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.public_tenant_id', ${A.tenantId}, true)`)
    // Deliberately NO status predicate — this is what a future reader that
    // forgot the filter would issue.
    const r = await tx.execute(sql`select id, status from events`)
    return r.rows as { id: string; status: string }[]
  })
  check(
    'an unfiltered public query returns only policy-admitted rows',
    rawUnfiltered.every((r) => POLICY_PUBLIC.has(r.status)),
  )
  check(
    '…and NEVER a draft or a cancelled event',
    rawUnfiltered.every((r) => !NEVER_PUBLIC.includes(r.status)),
  )
  // The policy widened; the LISTING must not have. This is the assertion that
  // keeps 0087 from quietly putting finished tournaments back in "what's on".
  const announced = new Set([idsByStatus.published, idsByStatus.registration_open])
  check(
    '…while the LISTING reader still narrows to the announced two',
    listed.length === 2 && listed.every((e) => announced.has(e.id)),
  )
  check(
    '…so a completed event is reachable by link but absent from the listing',
    rawUnfiltered.some((r) => r.status === 'completed') &&
      !listed.some((e) => e.id === idsByStatus.completed),
  )
  check(
    '…a draft is unreachable even by direct id',
    !rawUnfiltered.some((r) => r.id === idsByStatus.draft),
  )

  const draftById = await app.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.public_tenant_id', ${A.tenantId}, true)`)
    const r = await tx.execute(sql`select id from events where id = ${idsByStatus.draft}`)
    return r.rows.length
  })
  check('selecting the draft by its exact id returns 0 rows', draftById === 0)

  // ── detail reader ─────────────────────────────────────────────────────────
  console.log('\n── detail reader ──')
  const pub = await getPublicEventById(A.tenantId, idsByStatus.published)
  check('a published event loads', pub?.id === idsByStatus.published)
  check('…with its title', pub?.title === 'A published')
  check('…entry fee as a string', pub?.entryFee === '300.00')
  check('…branch name joined', pub?.branchName === 'Main')
  check('…capacity and spots left', pub?.capacity === 20 && pub?.spotsLeft === 20)

  const regOpen = await getPublicEventById(A.tenantId, idsByStatus.registration_open)
  check('a registration_open event loads', regOpen?.id === idsByStatus.registration_open)

  for (const status of ['draft', 'full', 'in_progress', 'completed', 'cancelled'] as const) {
    check(`a ${status} event returns null (404s)`, (await getPublicEventById(A.tenantId, idsByStatus[status])) === null)
  }
  check('an unknown uuid returns null', (await getPublicEventById(A.tenantId, '00000000-0000-4000-8000-000000000000')) === null)
  check('a malformed id returns null rather than throwing', (await getPublicEventById(A.tenantId, 'not-a-uuid')) === null)

  // ── TENANT ISOLATION ──────────────────────────────────────────────────────
  console.log('\n── tenant isolation (two tenants) ──')
  check(
    "B's public context cannot load A's published event by id",
    (await getPublicEventById(B.tenantId, idsByStatus.published)) === null,
  )
  check(
    "A's public context cannot load B's published event by id",
    (await getPublicEventById(A.tenantId, bPublished)) === null,
  )
  const bList = await getPublicEvents(B.tenantId)
  check("B's listing shows only B's event", bList.length === 1 && bList[0].id === bPublished)

  const crossRaw = await app.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.public_tenant_id', ${B.tenantId}, true)`)
    // Ask for A's event id explicitly while pinned to B.
    const r = await tx.execute(sql`select id from events where id = ${idsByStatus.published}`)
    return r.rows.length
  })
  check("pinned to B, A's event id yields 0 rows at the database", crossRaw === 0)

  const noPinRaw = await app.transaction(async (tx) => {
    // No tenant pinned at all — the shape a bug that forgot withPublicTenant
    // would produce.
    const r = await tx.execute(sql`select id from events`)
    return r.rows.length
  })
  check('with NO tenant pinned, the public role sees 0 events', noPinRaw === 0)

  // ── homepage promotion uses the same rule ─────────────────────────────────
  console.log('\n── homepage promotion ──')
  const promo = await getUpcomingPublicEvents(A.tenantId, 3)
  check('promotion returns only public events', promo.every((e) => PUBLIC.has(e.status)))
  check('promotion respects its limit', (await getUpcomingPublicEvents(A.tenantId, 1)).length === 1)
  check(
    'promotion is a strict subset of the listing',
    promo.every((e) => listedIds.has(e.id)),
  )
  const emptyPromo = await getUpcomingPublicEvents(B.tenantId, 3)
  check('a tenant with one event promotes one', emptyPromo.length === 1)

  await owner.query(`delete from events where tenant_id=$1`, [B.tenantId])
  check('a tenant with no events promotes nothing (empty state)', (await getUpcomingPublicEvents(B.tenantId, 3)).length === 0)

  // ── upcoming-only ─────────────────────────────────────────────────────────
  console.log('\n── finished events drop out ──')
  const pastId = (
    await owner.query<{ id: string }>(
      `insert into events (tenant_id, branch_id, title, type, starts_at, ends_at, entry_fee, status)
       values ($1,$2,'A finished','class', now() - interval '2 days', now() - interval '1 day', '0.00', 'published')
       returning id`,
      [A.tenantId, A.branchId],
    )
  ).rows[0].id
  const afterPast = await getPublicEvents(A.tenantId)
  check('a published event that already ended is not listed', !afterPast.some((e) => e.id === pastId))
  check('…but is still readable by direct link (published)', (await getPublicEventById(A.tenantId, pastId)) !== null)

  // ── uncapped capacity ─────────────────────────────────────────────────────
  console.log('\n── capacity / spots left ──')
  const uncappedId = (
    await owner.query<{ id: string }>(
      `insert into events (tenant_id, branch_id, title, type, starts_at, ends_at, capacity, entry_fee, status)
       values ($1,$2,'A uncapped','meetup', now() + interval '3 days', now() + interval '3 days 1 hour', NULL, '0.00', 'published')
       returning id`,
      [A.tenantId, A.branchId],
    )
  ).rows[0].id
  const uncapped = await getPublicEventById(A.tenantId, uncappedId)
  check('an uncapped event reports spotsLeft null, not 0', uncapped?.capacity === null && uncapped?.spotsLeft === null)

  // ── cleanup ───────────────────────────────────────────────────────────────
  await owner.query(`delete from events where tenant_id = any($1)`, [[A.tenantId, B.tenantId]])
  await owner.end()
  await appPool.end()

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
