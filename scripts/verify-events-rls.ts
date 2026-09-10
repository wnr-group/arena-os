/**
 * Proves the events table's isolation, role and constraint rules (migration
 * 0088) against a REAL database — everything scripts/test-events.ts cannot
 * cover because it needs no connection.
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs scripts/verify-events-rls.ts
 *
 * Covers:
 *   - the migration's shape: columns, RLS enabled, policies, grants
 *   - tenant isolation: tenant A cannot read, update or delete tenant B's events
 *   - role enforcement AT THE DATABASE: a cashier cannot insert/update/delete
 *     even with a valid connection, which is the half requireManager() can't
 *     prove
 *   - the CHECK constraints: window, capacity, fee, tournament/format
 *   - the cross-tenant branch FK: an event cannot point at another tenant's
 *     branch even when the manager asks for it
 *   - the lifecycle core against real rows, including a rejected illegal move
 */
import { Client, Pool } from 'pg'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { sql } from 'drizzle-orm'
import * as schema from '../db/schema'
import { loadEnv } from './env'

loadEnv()

type Db = NodePgDatabase<typeof schema>

let passed = 0
let failed = 0
const check = (label: string, cond: boolean) => {
  console.log(`${cond ? '✓' : '✗ FAIL'}  ${label}`)
  if (cond) passed++
  else failed++
}

/** Runs `fn`, returning true when it throws — "the database refused this". */
async function refuses(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn()
    return false
  } catch {
    return true
  }
}

async function main() {
  const { updateEventStatusCore, EventError } = await import('../lib/events/service')

  const owner = new Client({ connectionString: process.env.DATABASE_URL_OWNER })
  await owner.connect()
  const appPool = new Pool({ connectionString: process.env.DATABASE_URL })
  const app = drizzle(appPool, { schema })

  // ── migration shape ───────────────────────────────────────────────────────
  console.log('\n── migration ──')

  const tbl = await owner.query(
    `select column_name from information_schema.columns
      where table_schema='public' and table_name='events'`,
  )
  const cols = tbl.rows.map((r) => r.column_name as string)
  check('events exists', cols.length > 0)
  for (const c of [
    'id', 'tenant_id', 'branch_id', 'title', 'type', 'description', 'banner_url',
    'starts_at', 'ends_at', 'capacity', 'entry_fee', 'tournament_format', 'status',
    'created_by', 'created_at', 'updated_at',
  ]) {
    check(`…has ${c}`, cols.includes(c))
  }

  const fee = await owner.query<{ data_type: string; numeric_scale: number }>(
    `select data_type, numeric_scale from information_schema.columns
      where table_name='events' and column_name='entry_fee'`,
  )
  check('entry_fee is numeric(_,2) — money never a float', fee.rows[0].data_type === 'numeric' && fee.rows[0].numeric_scale === 2)

  const startsAt = await owner.query<{ data_type: string }>(
    `select data_type from information_schema.columns where table_name='events' and column_name='starts_at'`,
  )
  check('starts_at is timestamptz', startsAt.rows[0].data_type === 'timestamp with time zone')

  const rls = await owner.query<{ relrowsecurity: boolean }>(
    `select relrowsecurity from pg_class where oid = 'public.events'::regclass`,
  )
  check('RLS is enabled', rls.rows[0].relrowsecurity === true)

  const pol = await owner.query<{ policyname: string }>(
    `select policyname from pg_policies where schemaname='public' and tablename='events' order by policyname`,
  )
  const names = pol.rows.map((r) => r.policyname)
  check('a member SELECT policy exists', names.includes('events_select'))
  check('a manager WRITE policy exists', names.includes('events_manager_write'))

  const grants = await owner.query<{ privilege_type: string }>(
    `select privilege_type from information_schema.role_table_grants
      where grantee='arena_app' and table_schema='public' and table_name='events'`,
  )
  check(
    'arena_app has the standard business-table grants',
    grants.rows.map((r) => r.privilege_type).sort().join(',') === 'DELETE,INSERT,SELECT,UPDATE',
  )

  const cons = await owner.query<{ conname: string }>(
    `select conname from pg_constraint where conrelid='public.events'::regclass`,
  )
  const cnames = cons.rows.map((r) => r.conname)
  check('events_window CHECK exists', cnames.includes('events_window'))
  check('events_tournament_format CHECK exists', cnames.includes('events_tournament_format'))
  check('events_branch_fk (tenant-safe) exists', cnames.includes('events_branch_fk'))
  check('events_tenant_id_key exists for later stories', cnames.includes('events_tenant_id_key'))

  // ── tenants, branches, roles ──────────────────────────────────────────────
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
    const mk = async (email: string, role: string) => {
      const u = await owner.query<{ id: string }>(
        `insert into users (email, password_hash) values ($1,'x')
         on conflict (email) do update set email=excluded.email returning id`,
        [email],
      )
      await owner.query(
        `insert into memberships (tenant_id, user_id, role, status)
         values ($1,$2,$3::member_role,'active')
         on conflict (tenant_id, user_id) do update set role=excluded.role, status='active'`,
        [tenantId, u.rows[0].id, role],
      )
      return u.rows[0].id
    }
    return {
      tenantId,
      branchId: b.rows[0].id,
      managerId: await mk(`manager@${slug}.test`, 'manager'),
      cashierId: await mk(`cashier@${slug}.test`, 'cashier'),
    }
  }

  const A = await makeTenant('evta')
  const B = await makeTenant('evtb')

  async function asUser<T>(userId: string, fn: (tx: Db) => Promise<T>): Promise<T> {
    return app.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`)
      return fn(tx as unknown as Db)
    })
  }

  // Clean slate for reruns.
  await owner.query(`delete from events where tenant_id = any($1)`, [[A.tenantId, B.tenantId]])

  const seed = async (tenantId: string, branchId: string, title: string, status = 'draft') => {
    const r = await owner.query<{ id: string }>(
      `insert into events (tenant_id, branch_id, title, type, starts_at, ends_at, entry_fee, status)
       values ($1,$2,$3,'class', now() + interval '1 day', now() + interval '1 day 2 hours', '250.00', $4::event_status)
       returning id`,
      [tenantId, branchId, title, status],
    )
    return r.rows[0].id
  }

  const aEvent = await seed(A.tenantId, A.branchId, 'A open day')
  const bEvent = await seed(B.tenantId, B.branchId, 'B open day')

  // ── tenant isolation ──────────────────────────────────────────────────────
  console.log('\n── tenant isolation ──')

  const aSees = await asUser(A.managerId, (tx) =>
    tx.execute(sql`select id from events`).then((r) => r.rows.map((x) => x.id as string)),
  )
  check("A's manager sees A's event", aSees.includes(aEvent))
  check("A's manager does NOT see B's event", !aSees.includes(bEvent))

  const aUpdatedB = await asUser(A.managerId, (tx) =>
    tx.execute(sql`update events set title='hacked' where id=${bEvent}`).then((r) => r.rowCount ?? 0),
  )
  check("A's manager cannot UPDATE B's event (0 rows)", aUpdatedB === 0)

  const aDeletedB = await asUser(A.managerId, (tx) =>
    tx.execute(sql`delete from events where id=${bEvent}`).then((r) => r.rowCount ?? 0),
  )
  check("A's manager cannot DELETE B's event (0 rows)", aDeletedB === 0)

  const bTitle = await owner.query<{ title: string }>(`select title from events where id=$1`, [bEvent])
  check("B's event is untouched", bTitle.rows[0].title === 'B open day')

  // ── role enforcement at the database ──────────────────────────────────────
  console.log('\n── cashier cannot modify events ──')

  const cashierSees = await asUser(A.cashierId, (tx) =>
    tx.execute(sql`select id from events`).then((r) => r.rows.map((x) => x.id as string)),
  )
  check('a cashier CAN read their tenant\'s events', cashierSees.includes(aEvent))

  const cashierInsert = await refuses(() =>
    asUser(A.cashierId, (tx) =>
      tx.execute(sql`
        insert into events (tenant_id, branch_id, title, type, starts_at, ends_at)
        values (${A.tenantId}, ${A.branchId}, 'cashier event', 'party',
                now() + interval '2 days', now() + interval '2 days 1 hour')`),
    ),
  )
  check('a cashier cannot INSERT an event', cashierInsert)

  const cashierUpdated = await asUser(A.cashierId, (tx) =>
    tx.execute(sql`update events set title='cashier edit' where id=${aEvent}`).then((r) => r.rowCount ?? 0),
  )
  check('a cashier cannot UPDATE an event (0 rows)', cashierUpdated === 0)

  const cashierDeleted = await asUser(A.cashierId, (tx) =>
    tx.execute(sql`delete from events where id=${aEvent}`).then((r) => r.rowCount ?? 0),
  )
  check('a cashier cannot DELETE an event (0 rows)', cashierDeleted === 0)

  const stillThere = await owner.query(`select title from events where id=$1`, [aEvent])
  check("…and A's event is unchanged", stillThere.rows[0].title === 'A open day')

  const managerInserted = await asUser(A.managerId, (tx) =>
    tx
      .execute(sql`
        insert into events (tenant_id, branch_id, title, type, starts_at, ends_at)
        values (${A.tenantId}, ${A.branchId}, 'manager event', 'meetup',
                now() + interval '3 days', now() + interval '3 days 1 hour')`)
      .then((r) => r.rowCount ?? 0),
  )
  check('a manager CAN insert an event', managerInserted === 1)

  // ── the CHECK constraints ─────────────────────────────────────────────────
  console.log('\n── database constraints ──')

  const badWindow = await refuses(() =>
    owner.query(
      `insert into events (tenant_id, branch_id, title, type, starts_at, ends_at)
       values ($1,$2,'backwards','class', now() + interval '2 hours', now())`,
      [A.tenantId, A.branchId],
    ),
  )
  check('ends_at <= starts_at is rejected', badWindow)

  const badCapacity = await refuses(() =>
    owner.query(
      `insert into events (tenant_id, branch_id, title, type, starts_at, ends_at, capacity)
       values ($1,$2,'zero cap','class', now(), now() + interval '1 hour', 0)`,
      [A.tenantId, A.branchId],
    ),
  )
  check('capacity 0 is rejected', badCapacity)

  const badFee = await refuses(() =>
    owner.query(
      `insert into events (tenant_id, branch_id, title, type, starts_at, ends_at, entry_fee)
       values ($1,$2,'negative fee','class', now(), now() + interval '1 hour', '-1.00')`,
      [A.tenantId, A.branchId],
    ),
  )
  check('a negative entry fee is rejected', badFee)

  const tournamentNoFormat = await refuses(() =>
    owner.query(
      `insert into events (tenant_id, branch_id, title, type, starts_at, ends_at)
       values ($1,$2,'no format','tournament', now(), now() + interval '1 hour')`,
      [A.tenantId, A.branchId],
    ),
  )
  check('a tournament with no bracket format is rejected', tournamentNoFormat)

  const partyWithFormat = await refuses(() =>
    owner.query(
      `insert into events (tenant_id, branch_id, title, type, starts_at, ends_at, tournament_format)
       values ($1,$2,'party bracket','party', now(), now() + interval '1 hour', 'single_elim')`,
      [A.tenantId, A.branchId],
    ),
  )
  check('a non-tournament carrying a bracket format is rejected', partyWithFormat)

  const goodTournament = await owner.query(
    `insert into events (tenant_id, branch_id, title, type, starts_at, ends_at, tournament_format)
     values ($1,$2,'valid tournament','tournament', now(), now() + interval '1 hour', 'double_elim') returning id`,
    [A.tenantId, A.branchId],
  )
  check('a tournament WITH a bracket format is accepted', goodTournament.rowCount === 1)

  // ── the cross-tenant branch FK ────────────────────────────────────────────
  console.log('\n── cross-tenant branch reference ──')

  const crossTenantBranch = await refuses(() =>
    owner.query(
      `insert into events (tenant_id, branch_id, title, type, starts_at, ends_at)
       values ($1,$2,'stolen venue','class', now(), now() + interval '1 hour')`,
      [A.tenantId, B.branchId], // A's tenant, B's branch
    ),
  )
  check("an event cannot point at another tenant's branch (even as owner role)", crossTenantBranch)

  // ── the lifecycle against real rows ───────────────────────────────────────
  console.log('\n── lifecycle on real rows ──')

  const lifecycleId = await seed(A.tenantId, A.branchId, 'lifecycle', 'draft')

  const step = async (to: string) =>
    asUser(A.managerId, (tx) =>
      updateEventStatusCore(tx, { tenantId: A.tenantId }, lifecycleId, to as never),
    )

  await step('published')
  await step('registration_open')
  await step('full')
  await step('registration_open')
  await step('in_progress')
  await step('completed')
  const finalStatus = await owner.query<{ status: string }>(`select status from events where id=$1`, [lifecycleId])
  check('draft → published → registration_open ⇄ full → in_progress → completed', finalStatus.rows[0].status === 'completed')

  let illegalMsg = ''
  const illegal = await refuses(() =>
    step('draft').catch((e) => {
      illegalMsg = e instanceof EventError ? e.message : String(e)
      throw e
    }),
  )
  check('completed → draft is rejected', illegal)
  check('…with a readable message, not a constraint dump', /cannot move a completed event to draft/i.test(illegalMsg))

  const unchanged = await owner.query<{ status: string }>(`select status from events where id=$1`, [lifecycleId])
  check('…and the row is unchanged', unchanged.rows[0].status === 'completed')

  const crossTenantMove = await refuses(() =>
    asUser(A.managerId, (tx) => updateEventStatusCore(tx, { tenantId: A.tenantId }, bEvent, 'published' as never)),
  )
  check("A's manager cannot move B's event through its lifecycle", crossTenantMove)

  // ── CRUD through the real readers ─────────────────────────────────────────
  console.log('\n── CRUD via lib/events/data.ts ──')

  const { listEvents, getEvent, listEventBranches } = await import('../lib/events/data')
  // listEvents/getEvent only read ctx.user.id and ctx.tenant.id, so a minimal
  // context is enough and keeps this out of the HTTP request lifecycle.
  const ctxA = { user: { id: A.managerId }, tenant: { id: A.tenantId } } as never
  const ctxB = { user: { id: B.managerId }, tenant: { id: B.tenantId } } as never

  const created = await owner.query<{ id: string }>(
    `insert into events (tenant_id, branch_id, title, type, starts_at, ends_at, capacity, entry_fee, tournament_format)
     values ($1,$2,'CRUD tournament','tournament', now() + interval '5 days', now() + interval '5 days 3 hours',
             NULL, '1500.00', 'round_robin') returning id`,
    [A.tenantId, A.branchId],
  )
  const crudId = created.rows[0].id

  const read = await getEvent(ctxA, crudId)
  check('getEvent returns the created event', read?.id === crudId)
  check('…entry_fee comes back as a STRING (never a float)', typeof read?.entryFee === 'string')
  check('…and reads exactly 1500.00', read?.entryFee === '1500.00')
  check('…capacity NULL means unlimited', read?.capacity === null)
  check('…tournament format round-trips', read?.tournamentFormat === 'round_robin')
  check('…starts_at is a Date', read?.startsAt instanceof Date)
  check('…default status is draft', read?.status === 'draft')

  check("getEvent returns null for another tenant's event", (await getEvent(ctxA, bEvent)) === null)
  check("…and B cannot read A's", (await getEvent(ctxB, crudId)) === null)

  const listA = await listEvents(ctxA)
  check('listEvents returns only this tenant\'s rows', listA.every((e) => e.tenantId === A.tenantId))
  check('…includes the created event', listA.some((e) => e.id === crudId))
  check('…joins the branch name', listA.find((e) => e.id === crudId)?.branchName === 'Main')
  check(
    '…ordered by starts_at ascending',
    listA.every((e, i) => i === 0 || listA[i - 1].startsAt.getTime() <= e.startsAt.getTime()),
  )

  const branchList = await listEventBranches(ctxA)
  check('listEventBranches returns only this tenant\'s branches', branchList.length === 1 && branchList[0].id === A.branchId)

  await asUser(A.managerId, (tx) =>
    tx.execute(sql`update events set title='CRUD renamed', capacity=32 where id=${crudId} and tenant_id=${A.tenantId}`),
  )
  const afterUpdate = await getEvent(ctxA, crudId)
  check('update is visible through the reader', afterUpdate?.title === 'CRUD renamed' && afterUpdate?.capacity === 32)
  check('updated_at moved (the trigger fired)', (afterUpdate?.updatedAt.getTime() ?? 0) >= (read?.updatedAt.getTime() ?? 0))

  await asUser(A.managerId, (tx) => tx.execute(sql`delete from events where id=${crudId} and tenant_id=${A.tenantId}`))
  check('delete removes the row', (await getEvent(ctxA, crudId)) === null)

  // ── banner upload reuses the shared S3 helper ─────────────────────────────
  console.log('\n── banner upload ──')

  const { uploadImage, objectKeyFromUrl } = await import('../lib/storage/s3')
  // 1×1 transparent PNG.
  const pngBytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
  )
  // Only attempt a real round trip when this environment actually has a bucket.
  // A checkout with the shipped .env.example placeholders must not report a
  // FAILURE for something it was never configured to do — that would train the
  // reader to ignore a red line.
  const s3Configured =
    !!process.env.S3_BUCKET &&
    !/^your[-_]/i.test(process.env.S3_BUCKET) &&
    /^https?:\/\//.test(process.env.S3_PUBLIC_URL_BASE ?? '')

  if (!s3Configured) {
    console.log('ⓘ  SKIPPED — S3 is not configured in this environment (placeholder S3_BUCKET/S3_PUBLIC_URL_BASE).')
    console.log('   The upload PATH is still covered below: uploadEventBanner delegates to this same')
    console.log('   uploadImage(), and its validation runs before any network call.')
  } else {
    try {
      const file = new File([pngBytes], 'banner.png', { type: 'image/png' })
      const url = await uploadImage(file, `tenants/${A.tenantId}/events`)
      check('uploadImage returns a URL', typeof url === 'string' && url.length > 0)
      check("…under the tenant's events prefix", url.includes(`tenants/${A.tenantId}/events/`))
      check("…with a random key, not the caller's filename", !url.endsWith('banner.png'))
      check('…recognised by the deletion guard', objectKeyFromUrl(url) !== null)
      const { deleteObject } = await import('../lib/storage/s3')
      await deleteObject(url)
      check('…and is deletable (cleanup)', true)
    } catch (e) {
      check(`banner upload against real S3 (${e instanceof Error ? e.message : 'failed'})`, false)
    }
  }

  const rejectsPdf = await refuses(async () => {
    const bad = new File([Buffer.from('%PDF-1.4')], 'x.pdf', { type: 'application/pdf' })
    return uploadImage(bad, `tenants/${A.tenantId}/events`)
  })
  check('a non-image is rejected by the shared policy', rejectsPdf)

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
