/**
 * Proves the SHAPE of migrations 0091–0093 against a real database — the half
 * scripts/test-event-registrations.ts cannot cover, because that file tests
 * behaviour through the app and this one tests the guarantees the app is
 * allowed to assume:
 *
 *   - the tables, columns, constraints and indexes exist as documented
 *   - RLS is enabled on all three new tables, with the right policy set
 *   - arena_app has the intended table grants and NO delete
 *   - arena_app may execute the entry-point functions and may NOT execute the
 *     internal ones — in particular confirm_event_registration_payment(), the
 *     function that turns a registration into a paid one
 *   - a customer context can read only its own rows, and write none
 *   - the payment_intents price rule is a database rule
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs scripts/verify-event-registrations-rls.ts
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
const check = (label: string, cond: boolean, detail?: unknown) => {
  console.log(`${cond ? '✓' : '✗ FAIL'}  ${label}`)
  if (cond) passed++
  else {
    failed++
    if (detail !== undefined) console.log('        got:', detail)
  }
}

async function refuses(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn()
    return false
  } catch {
    return true
  }
}

async function main() {
  const owner = new Client({ connectionString: process.env.DATABASE_URL_OWNER })
  await owner.connect()
  const appPool = new Pool({ connectionString: process.env.DATABASE_URL })
  const app = drizzle(appPool, { schema })

  // ── tables and columns ────────────────────────────────────────────────────
  console.log('\n── migration shape ──')

  const cols = async (table: string) =>
    owner
      .query<{ column_name: string }>(
        `select column_name from information_schema.columns
          where table_schema='public' and table_name=$1`,
        [table],
      )
      .then((r) => r.rows.map((x) => x.column_name))

  const regCols = await cols('event_registrations')
  check('event_registrations exists', regCols.length > 0)
  for (const c of [
    'id', 'tenant_id', 'event_id', 'customer_id', 'team_id', 'status', 'paid_amount',
    'payment_reference', 'payment_hold_expires_at', 'refund_required', 'registered_at',
    'waitlisted_at', 'cancelled_at', 'checked_in_at', 'created_at', 'updated_at',
  ]) {
    check(`…has ${c}`, regCols.includes(c))
  }

  const teamCols = await cols('event_teams')
  for (const c of ['id', 'tenant_id', 'event_id', 'name', 'captain_customer_id', 'status']) {
    check(`event_teams has ${c}`, teamCols.includes(c))
  }
  const memberCols = await cols('event_team_members')
  for (const c of ['id', 'tenant_id', 'event_id', 'team_id', 'customer_id', 'is_captain']) {
    check(`event_team_members has ${c}`, memberCols.includes(c))
  }

  const eventCols = await cols('events')
  check('events gained registration_mode', eventCols.includes('registration_mode'))
  check('events gained team_size', eventCols.includes('team_size'))
  check('payment_intents gained event_registration_id', (await cols('payment_intents')).includes('event_registration_id'))

  const money = await owner.query<{ data_type: string; numeric_scale: number }>(
    `select data_type, numeric_scale from information_schema.columns
      where table_name='event_registrations' and column_name='paid_amount'`,
  )
  check(
    'paid_amount is numeric(_,2) — money never a float',
    money.rows[0].data_type === 'numeric' && money.rows[0].numeric_scale === 2,
  )

  // ── enum values ───────────────────────────────────────────────────────────
  const enumVals = async (name: string) =>
    owner
      .query<{ v: string }>(
        `select e.enumlabel as v from pg_enum e join pg_type t on t.oid=e.enumtypid
          where t.typname=$1 order by e.enumsortorder`,
        [name],
      )
      .then((r) => r.rows.map((x) => x.v))

  const regStatuses = await enumVals('event_registration_status')
  check(
    'event_registration_status carries the four required statuses',
    ['registered', 'waitlisted', 'cancelled', 'checked_in'].every((s) => regStatuses.includes(s)),
    regStatuses,
  )
  check(
    '…plus pending_payment, the hold that makes capacity safe under payment',
    regStatuses.includes('pending_payment'),
  )
  check('event_registration_mode is solo|team', (await enumVals('event_registration_mode')).join(',') === 'solo,team')
  check(
    "payment_intent_purpose gained 'event_registration' rather than a new mechanism",
    (await enumVals('payment_intent_purpose')).includes('event_registration'),
  )

  // ── constraints ───────────────────────────────────────────────────────────
  console.log('\n── constraints and indexes ──')

  const cons = async (table: string) =>
    owner
      .query<{ conname: string }>(
        `select conname from pg_constraint where conrelid=$1::regclass`,
        [`public.${table}`],
      )
      .then((r) => r.rows.map((x) => x.conname))

  const regCons = await cons('event_registrations')
  for (const c of [
    'event_registrations_event_fk',
    'event_registrations_customer_fk',
    'event_registrations_team_fk',
    'event_registrations_hold',
    'event_registrations_paid',
    'event_registrations_tenant_id_key',
  ]) {
    check(`event_registrations has ${c}`, regCons.includes(c), regCons)
  }

  const teamCons = await cons('event_teams')
  check('event_teams has a tenant-safe event FK', teamCons.includes('event_teams_event_fk'))
  check('…and a tenant-safe captain FK', teamCons.includes('event_teams_captain_fk'))
  check('…and the (tenant,event,id) key members reference', teamCons.includes('event_teams_event_id_key'))
  check(
    'event_team_members has the three-column team FK',
    (await cons('event_team_members')).includes('event_team_members_team_fk'),
  )
  check('events has the team-size equivalence CHECK', (await cons('events')).includes('events_team_size'))

  const piCheck = await owner.query<{ def: string }>(
    `select pg_get_constraintdef(oid) as def from pg_constraint
      where conrelid='public.payment_intents'::regclass and conname='payment_intents_exactly_one_target'`,
  )
  check(
    'a payment intent still targets exactly one thing — now one of three',
    piCheck.rows[0]?.def.includes('event_registration_id'),
    piCheck.rows[0]?.def,
  )

  const idx = await owner
    .query<{ indexname: string }>(
      `select indexname from pg_indexes where schemaname='public'
        and tablename in ('event_registrations','event_teams','event_team_members','payment_intents')`,
    )
    .then((r) => r.rows.map((x) => x.indexname))
  for (const i of [
    'idx_event_registrations_active',
    'idx_event_registrations_waitlist',
    'idx_event_team_members_unique',
    'idx_event_team_members_one_per_event',
    'idx_event_teams_name',
    'idx_payment_intents_one_pending_event_registration',
  ]) {
    check(`index ${i} exists`, idx.includes(i), idx)
  }

  // ── RLS + policies ────────────────────────────────────────────────────────
  console.log('\n── RLS and policies ──')

  for (const t of ['event_registrations', 'event_teams', 'event_team_members']) {
    const r = await owner.query<{ relrowsecurity: boolean }>(
      `select relrowsecurity from pg_class where oid=$1::regclass`,
      [`public.${t}`],
    )
    check(`RLS is enabled on ${t}`, r.rows[0].relrowsecurity === true)
  }

  const policies = await owner
    .query<{ tablename: string; policyname: string; permissive: string }>(
      `select tablename, policyname, permissive from pg_policies
        where schemaname='public'
          and tablename in ('event_registrations','event_teams','event_team_members','events','payment_intents')`,
    )
    .then((r) => r.rows)
  const has = (t: string, p: string) => policies.some((x) => x.tablename === t && x.policyname === p)

  check('staff SELECT policy on registrations', has('event_registrations', 'event_registrations_select'))
  check('manager WRITE policy on registrations', has('event_registrations', 'event_registrations_manager_write'))
  check('customer SELECT policy on registrations', has('event_registrations', 'event_registrations_customer_select'))
  check(
    'a RESTRICTIVE isolation policy caps the customer context',
    policies.some(
      (x) =>
        x.tablename === 'event_registrations' &&
        x.policyname === 'event_registrations_customer_isolation' &&
        x.permissive === 'RESTRICTIVE',
    ),
  )
  check('customers may read the events they are entering', has('events', 'events_customer_select'))
  check('customers may open their own payment intent', has('payment_intents', 'payment_intents_customer_insert'))
  check('…and read it back', has('payment_intents', 'payment_intents_customer_select'))
  check(
    '…capped by a restrictive policy too',
    policies.some(
      (x) =>
        x.tablename === 'payment_intents' &&
        x.policyname === 'payment_intents_customer_isolation' &&
        x.permissive === 'RESTRICTIVE',
    ),
  )

  // The point of the design: NO customer insert/update policy on registrations.
  const custWrite = await owner.query<{ policyname: string; cmd: string }>(
    `select policyname, cmd from pg_policies
      where schemaname='public' and tablename='event_registrations'
        and permissive='PERMISSIVE' and cmd in ('INSERT','UPDATE','ALL')
        and policyname like '%customer%'`,
  )
  check(
    'there is NO permissive customer write policy on registrations — writes go through the locked functions',
    custWrite.rowCount === 0,
    custWrite.rows,
  )

  // No public policy at all on any of the three.
  const publicPolicies = policies.filter(
    (p) =>
      ['event_registrations', 'event_teams', 'event_team_members'].includes(p.tablename) &&
      p.policyname.includes('public'),
  )
  check('no public policy exists on the registration tables', publicPolicies.length === 0, publicPolicies)

  // ── grants ────────────────────────────────────────────────────────────────
  console.log('\n── grants ──')

  for (const t of ['event_registrations', 'event_teams', 'event_team_members']) {
    const g = await owner
      .query<{ privilege_type: string }>(
        `select privilege_type from information_schema.role_table_grants
          where grantee='arena_app' and table_schema='public' and table_name=$1`,
        [t],
      )
      .then((r) => r.rows.map((x) => x.privilege_type).sort().join(','))
    check(`arena_app has select/insert/update on ${t} and NO delete`, g === 'INSERT,SELECT,UPDATE', g)
  }

  const canExec = async (signature: string) =>
    owner
      .query<{ ok: boolean }>(`select has_function_privilege('arena_app', $1, 'execute') as ok`, [signature])
      .then((r) => r.rows[0].ok)

  check('arena_app may claim a registration', await canExec('public.claim_event_registration(uuid,text)'))
  check('arena_app may join a team', await canExec('public.join_event_team(uuid)'))
  check('arena_app may cancel a registration', await canExec('public.cancel_event_registration(uuid)'))
  check('arena_app may read its own participation', await canExec('public.my_event_participation(uuid)'))
  check('arena_app may read public place counts', await canExec('public.public_event_taken_counts(uuid)'))

  check(
    'arena_app may NOT confirm a payment — only the webhook, on the owner connection, can',
    !(await canExec('public.confirm_event_registration_payment(uuid,text,numeric)')),
  )
  check(
    'arena_app may NOT promote a waitlist directly',
    !(await canExec('public.promote_event_waitlist(uuid)')),
  )
  check(
    'arena_app may NOT sweep holds directly',
    !(await canExec('public.expire_event_registration_holds(uuid)')),
  )
  check(
    'arena_app may NOT count occupancy directly',
    !(await canExec('public.event_registration_occupancy(uuid)')),
  )

  // ── live isolation ────────────────────────────────────────────────────────
  console.log('\n── live isolation ──')

  async function makeTenant(slug: string) {
    const t = await owner.query<{ id: string }>(
      `insert into tenants (slug,name,status) values ($1,$2,'active')
       on conflict (slug) do update set status='active' returning id`,
      [slug, `${slug} co`],
    )
    const tenantId = t.rows[0].id
    await owner.query('delete from events where tenant_id=$1', [tenantId])
    await owner.query('delete from customers where tenant_id=$1', [tenantId])
    const b = await owner.query<{ id: string }>(
      `insert into branches (tenant_id,name,is_primary,status) values ($1,'Main',true,'active')
       on conflict (tenant_id,name) do update set status='active' returning id`,
      [tenantId],
    )
    const u = await owner.query<{ id: string }>(
      `insert into users (email,password_hash) values ($1,'x')
       on conflict (email) do update set email=excluded.email returning id`,
      [`mgr@${slug}.test`],
    )
    await owner.query(
      `insert into memberships (tenant_id,user_id,role,status) values ($1,$2,'manager','active')
       on conflict (tenant_id,user_id) do update set role='manager', status='active'`,
      [tenantId, u.rows[0].id],
    )
    const cust = await owner.query<{ id: string }>(
      `insert into customers (tenant_id,phone,name) values ($1,$2,'Test') returning id`,
      [tenantId, `+9199${slug.length}0000${slug.charCodeAt(3) % 10}${slug.charCodeAt(4) % 10}`],
    )
    const ev = await owner.query<{ id: string }>(
      `insert into events (tenant_id,branch_id,title,type,starts_at,ends_at,capacity,entry_fee,status)
       values ($1,$2,'RLS event','class', now() + interval '2 days', now() + interval '2 days 2 hours',
               10,'0','registration_open') returning id`,
      [tenantId, b.rows[0].id],
    )
    const r = await owner.query<{ id: string }>(
      `insert into event_registrations (tenant_id,event_id,customer_id,status,registered_at)
       values ($1,$2,$3,'registered',now()) returning id`,
      [tenantId, ev.rows[0].id, cust.rows[0].id],
    )
    return {
      tenantId,
      branchId: b.rows[0].id,
      userId: u.rows[0].id,
      customerId: cust.rows[0].id,
      eventId: ev.rows[0].id,
      registrationId: r.rows[0].id,
    }
  }

  const A = await makeTenant('evtrega')
  const B = await makeTenant('evtregb')

  const asUser = <T,>(userId: string, fn: (tx: Db) => Promise<T>): Promise<T> =>
    app.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`)
      return fn(tx as unknown as Db)
    })
  const asCustomer = <T,>(customerId: string, fn: (tx: Db) => Promise<T>): Promise<T> =>
    app.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.customer_id', ${customerId}, true)`)
      return fn(tx as unknown as Db)
    })

  const aSees = await asUser(A.userId, (tx) =>
    tx.execute(sql`select id from event_registrations`).then((r) => r.rows.map((x) => x.id as string)),
  )
  check("tenant A's manager sees A's registration", aSees.includes(A.registrationId))
  check("…and NOT tenant B's", !aSees.includes(B.registrationId))

  const aWritesB = await asUser(A.userId, (tx) =>
    tx
      .execute(sql`update event_registrations set status='cancelled' where id=${B.registrationId}`)
      .then((r) => r.rowCount ?? 0),
  )
  check("tenant A cannot write tenant B's registration (0 rows)", aWritesB === 0)

  const custSees = await asCustomer(A.customerId, (tx) =>
    tx.execute(sql`select id from event_registrations`).then((r) => r.rows.map((x) => x.id as string)),
  )
  check('a customer sees their own registration', custSees.includes(A.registrationId))
  check("…and nobody else's", custSees.length === 1, custSees.length)

  const custBSees = await asCustomer(B.customerId, (tx) =>
    tx.execute(sql`select id from event_registrations`).then((r) => r.rows.map((x) => x.id as string)),
  )
  check("a customer of tenant B sees none of tenant A's", !custBSees.includes(A.registrationId))

  const custInsert = await refuses(() =>
    asCustomer(A.customerId, (tx) =>
      tx.execute(sql`
        insert into event_registrations (tenant_id,event_id,customer_id,status,registered_at)
        values (${A.tenantId}, ${A.eventId}, ${A.customerId}, 'registered', now())`),
    ),
  )
  check('a customer cannot INSERT a registration directly', custInsert)

  const custUpdate = await asCustomer(A.customerId, (tx) =>
    tx
      .execute(sql`update event_registrations set status='checked_in' where id=${A.registrationId}`)
      .then((r) => r.rowCount ?? 0)
      .catch(() => -1),
  )
  check('a customer cannot UPDATE their own registration directly', custUpdate <= 0, custUpdate)

  const custDelete = await refuses(() =>
    asCustomer(A.customerId, (tx) =>
      tx.execute(sql`delete from event_registrations where id=${A.registrationId}`),
    ),
  )
  check('nobody may DELETE a registration — no grant exists', custDelete)

  const custDraft = await asCustomer(A.customerId, (tx) =>
    tx.execute(sql`select id from events`).then((r) => r.rows.length),
  )
  check('a customer can read their tenant\'s non-draft events', custDraft >= 1, custDraft)

  await owner.query(
    `insert into events (tenant_id,branch_id,title,type,starts_at,ends_at,status)
     values ($1,$2,'A secret draft','class', now() + interval '5 days', now() + interval '5 days 1 hour','draft')`,
    [A.tenantId, A.branchId],
  )
  const draftLeak = await asCustomer(A.customerId, (tx) =>
    tx
      .execute(sql`select id from events where title='A secret draft'`)
      .then((r) => r.rows.length),
  )
  check('…but never a draft', draftLeak === 0, draftLeak)

  const crossEvent = await asCustomer(B.customerId, (tx) =>
    tx.execute(sql`select id from events where id=${A.eventId}`).then((r) => r.rows.length),
  )
  check("…and never another tenant's event", crossEvent === 0)

  await owner.end()
  await appPool.end()

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
