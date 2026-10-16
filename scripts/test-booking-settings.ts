/**
 * Booking settings — the venue-wide advance-booking window (M37 #1),
 * integration tests against a real database, as NON-owner DB roles.
 *
 *   1. migrated shape  — pk, CHECK 1..365, RLS on, grants, policies
 *   2. defaults        — no row reads as 7; DB CHECK rejects 0 / 366 / 400 / -1
 *   3. write authority — owner + manager may save; cashier / receptionist /
 *                        floor_staff and another tenant's manager may not
 *                        (refused by RLS, value unchanged)
 *   4. presets only    — the write path rejects 0, 15, 400, -7 (DB would allow 15)
 *   5. audit           — old → new is logged once, with the actor; a no-op save
 *                        logs nothing
 *   6. anonymous       — a public-tenant context reads ITS tenant's value only,
 *                        and cannot write
 *   7. shrinking       — reducing 180 → 7 leaves an existing far-future booking
 *                        untouched
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs scripts/test-booking-settings.ts
 */
import { Pool } from 'pg'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { sql } from 'drizzle-orm'
import * as schema from '../db/schema'
import { loadEnv } from './env'

type Db = NodePgDatabase<typeof schema>

let pass = 0,
  fail = 0
const check = (l: string, c: boolean) => {
  console.log(`${c ? '✓' : '✗ FAIL'}  ${l}`)
  if (c) pass++
  else fail++
}

async function main() {
  loadEnv()
  const { applyBookingWindow } = await import('../lib/booking/settings-write')
  const { getBookingSettingsCore } = await import('../lib/booking/settings')

  const ownerPool = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })
  const appPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 })
  const app = drizzle(appPool, { schema })

  const asUser = <T>(userId: string, fn: (tx: Db) => Promise<T>) =>
    app.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`)
      return fn(tx as unknown as Db)
    })
  const asPublic = <T>(tenantId: string, fn: (tx: Db) => Promise<T>) =>
    app.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.public_tenant_id', ${tenantId}, true)`)
      return fn(tx as unknown as Db)
    })

  const rows = async (q: string, v: unknown[] = []) => (await ownerPool.query(q, v)).rows
  const stored = async (tenantId: string) =>
    (await rows('select max_advance_days from booking_settings where tenant_id=$1', [tenantId]))[0]?.max_advance_days as
      | number
      | undefined
  const auditRows = async (tenantId: string) =>
    rows(
      `select actor_membership_id, before, after from audit_log
        where tenant_id=$1 and action='booking_settings.max_advance_days_changed' order by created_at`,
      [tenantId],
    )

  type Person = { userId: string; membershipId: string }
  async function makeTenant(slug: string) {
    const t = await ownerPool.query<{ id: string }>(
      `insert into tenants (slug,name,status,timezone) values ($1,$2,'active','Asia/Kolkata')
       on conflict (slug) do update set name=excluded.name returning id`,
      [slug, `${slug} co`],
    )
    const tenantId = t.rows[0].id
    const mk = async (role: string): Promise<Person> => {
      const u = await ownerPool.query<{ id: string }>(
        `insert into users (email,password_hash) values ($1,'x')
         on conflict (email) do update set email=excluded.email returning id`,
        [`${role}@${slug}.test`],
      )
      const m = await ownerPool.query<{ id: string }>(
        `insert into memberships (tenant_id,user_id,role,status) values ($1,$2,$3,'active')
         on conflict (tenant_id,user_id) do update set role=excluded.role, status='active' returning id`,
        [tenantId, u.rows[0].id, role],
      )
      return { userId: u.rows[0].id, membershipId: m.rows[0].id }
    }
    const people = {
      owner: await mk('owner'),
      manager: await mk('manager'),
      cashier: await mk('cashier'),
      receptionist: await mk('receptionist'),
      floor_staff: await mk('floor_staff'),
    }
    return { tenantId, ...people }
  }

  const A = await makeTenant('testbkset-a')
  const B = await makeTenant('testbkset-b')
  const reset = async () => {
    for (const t of [A, B]) {
      await ownerPool.query('delete from booking_settings where tenant_id=$1', [t.tenantId])
      await ownerPool.query(`delete from audit_log where tenant_id=$1 and entity_type='booking_settings'`, [t.tenantId])
    }
  }
  await reset()

  /** Save as `who` in tenant `tenantId`; resolves to whether it went through. */
  const saveAs = async (who: Person, tenantId: string, days: number) => {
    try {
      await asUser(who.userId, (tx) =>
        applyBookingWindow(tx as never, { tenantId, membershipId: who.membershipId }, days),
      )
      return true
    } catch {
      return false
    }
  }

  // ── 1. shape ──────────────────────────────────────────────────────────────
  console.log('\n── migrated shape ──')
  {
    const pk = await rows(
      `select a.attname from pg_index i join pg_attribute a on a.attrelid=i.indrelid and a.attnum=any(i.indkey)
        where i.indrelid='public.booking_settings'::regclass and i.indisprimary`,
    )
    check('tenant_id is the primary key (one row per tenant)', pk.length === 1 && pk[0].attname === 'tenant_id')
    const rls = await rows(`select relrowsecurity from pg_class where oid='public.booking_settings'::regclass`)
    check('row level security is enabled', rls[0].relrowsecurity === true)
    const pols = await rows(`select policyname, cmd from pg_policies where tablename='booking_settings'`)
    check(
      'policies: member select, manager insert/update/delete, public select',
      ['booking_settings_select', 'booking_settings_manager_insert', 'booking_settings_manager_update',
        'booking_settings_manager_delete', 'booking_settings_public_select'].every((n) =>
        pols.some((p) => p.policyname === n),
      ),
    )
    const wc = await rows(
      `select policyname, with_check from pg_policies where tablename='booking_settings' and cmd in ('INSERT','UPDATE')`,
    )
    check('every write policy has an explicit WITH CHECK', wc.length === 2 && wc.every((p) => !!p.with_check))
    const gr = await rows(
      `select privilege_type from information_schema.role_table_grants
        where table_name='booking_settings' and grantee='arena_app'`,
    )
    const g = gr.map((r) => r.privilege_type)
    check('arena_app: select/insert/update/delete', ['SELECT', 'INSERT', 'UPDATE', 'DELETE'].every((p) => g.includes(p)))
  }

  // ── 2. defaults + DB check ────────────────────────────────────────────────
  console.log('\n── defaults and CHECK ──')
  {
    const s = await asUser(A.owner.userId, (tx) => getBookingSettingsCore(tx as never, A.tenantId))
    check('a venue with no row reads as 7', s.maxAdvanceDays === 7)
    for (const bad of [0, -1, 366, 400]) {
      let blocked = false
      try {
        await ownerPool.query('insert into booking_settings (tenant_id,max_advance_days) values ($1,$2)', [B.tenantId, bad])
      } catch {
        blocked = true
      }
      check(`DB CHECK refuses ${bad}`, blocked)
    }
    check('…and nothing was stored', (await stored(B.tenantId)) === undefined)
  }

  // ── 3. who may write ──────────────────────────────────────────────────────
  console.log('\n── write authority (real non-owner DB role) ──')
  {
    check('manager can save 30', (await saveAs(A.manager, A.tenantId, 30)) && (await stored(A.tenantId)) === 30)
    check('owner can save 90', (await saveAs(A.owner, A.tenantId, 90)) && (await stored(A.tenantId)) === 90)
    for (const role of ['cashier', 'receptionist', 'floor_staff'] as const) {
      const ok = await saveAs(A[role], A.tenantId, 180)
      check(`${role} is refused; value unchanged`, !ok && (await stored(A.tenantId)) === 90)
    }
    // Another tenant's manager: WITH CHECK / USING must refuse A's row.
    const cross = await saveAs(B.manager, A.tenantId, 180)
    check("tenant B's manager cannot write tenant A's row", !cross && (await stored(A.tenantId)) === 90)
    // And a manager still cannot seed a row for a tenant that has none.
    const fresh = await saveAs(A.manager, B.tenantId, 30)
    check("tenant A's manager cannot create tenant B's row", !fresh && (await stored(B.tenantId)) === undefined)
    // Staff read their own tenant's value but not another's.
    const seen = await asUser(A.cashier.userId, (tx) => getBookingSettingsCore(tx as never, A.tenantId))
    check('a cashier can still READ the window', seen.maxAdvanceDays === 90)
    const other = await asUser(B.cashier.userId, (tx) => getBookingSettingsCore(tx as never, A.tenantId))
    check("…but tenant B's staff read the default, not A's value", other.maxAdvanceDays === 7)
  }

  // ── 4. presets only ───────────────────────────────────────────────────────
  console.log('\n── presets only ──')
  {
    for (const bad of [0, 15, 400, -7, 1, 365, 7.5]) {
      const ok = await saveAs(A.manager, A.tenantId, bad)
      check(`${bad} rejected; value unchanged`, !ok && (await stored(A.tenantId)) === 90)
    }
    for (const good of [7, 30, 90, 180]) {
      check(`preset ${good} accepted`, (await saveAs(A.manager, A.tenantId, good)) && (await stored(A.tenantId)) === good)
    }
  }

  // ── 5. audit ──────────────────────────────────────────────────────────────
  console.log('\n── audit ──')
  {
    await reset()
    await saveAs(A.manager, A.tenantId, 30) // default 7 → 30
    await saveAs(A.owner, A.tenantId, 30) // no-op
    await saveAs(A.owner, A.tenantId, 90) // 30 → 90
    const a = await auditRows(A.tenantId)
    check('two changes logged, the no-op save is not', a.length === 2)
    check(
      'first entry: 7 → 30 by the manager',
      a[0]?.before?.maxAdvanceDays === 7 && a[0]?.after?.maxAdvanceDays === 30 && a[0]?.actor_membership_id === A.manager.membershipId,
    )
    check(
      'second entry: 30 → 90 by the owner',
      a[1]?.before?.maxAdvanceDays === 30 && a[1]?.after?.maxAdvanceDays === 90 && a[1]?.actor_membership_id === A.owner.membershipId,
    )
    const upd = await rows('select updated_by from booking_settings where tenant_id=$1', [A.tenantId])
    check('updated_by records the last editor', upd[0]?.updated_by === A.owner.membershipId)
  }

  // ── 6. anonymous ──────────────────────────────────────────────────────────
  console.log('\n── anonymous storefront ──')
  {
    const s = await asPublic(A.tenantId, (tx) => getBookingSettingsCore(tx as never, A.tenantId))
    check('anon reads the visited tenant’s window (90)', s.maxAdvanceDays === 90)
    const leak = await asPublic(B.tenantId, (tx) => getBookingSettingsCore(tx as never, A.tenantId))
    check('anon at tenant B cannot read tenant A’s value (reads default)', leak.maxAdvanceDays === 7)
    let wrote = false
    try {
      await asPublic(A.tenantId, async (tx) => {
        const r = await tx.execute(sql`update booking_settings set max_advance_days = 180 where tenant_id = ${A.tenantId}`)
        wrote = (r.rowCount ?? 0) > 0
      })
    } catch {
      wrote = false
    }
    check('anon cannot update', !wrote && (await stored(A.tenantId)) === 90)
    let inserted = false
    try {
      await asPublic(B.tenantId, async (tx) => {
        await tx.execute(sql`insert into booking_settings (tenant_id, max_advance_days) values (${B.tenantId}, 180)`)
        inserted = true
      })
    } catch {
      inserted = false
    }
    check('anon cannot insert', !inserted && (await stored(B.tenantId)) === undefined)
    let deleted = false
    try {
      await asPublic(A.tenantId, async (tx) => {
        const r = await tx.execute(sql`delete from booking_settings where tenant_id = ${A.tenantId}`)
        deleted = (r.rowCount ?? 0) > 0
      })
    } catch {
      deleted = false
    }
    check('anon cannot delete', !deleted && (await stored(A.tenantId)) === 90)
  }

  // ── 7. shrinking leaves far-future bookings alone ─────────────────────────
  console.log('\n── shrinking the window ──')
  {
    await saveAs(A.manager, A.tenantId, 180)
    const branch = await ownerPool.query<{ id: string }>(
      `insert into branches (tenant_id,name,is_primary) values ($1,'Main',true)
       on conflict (tenant_id,name) do update set is_primary=true returning id`,
      [A.tenantId],
    )
    await ownerPool.query(`delete from bookings where tenant_id=$1 and booking_number='BS-FAR'`, [A.tenantId])
    const bk = await ownerPool.query<{ id: string }>(
      `insert into bookings (tenant_id,branch_id,booking_number,status,customer_name,subtotal,total)
       values ($1,$2,'BS-FAR','confirmed','far','0','0') returning id`,
      [A.tenantId, branch.rows[0].id],
    )
    await saveAs(A.manager, A.tenantId, 7) // 180 → 7
    const after = await rows('select status from bookings where id=$1', [bk.rows[0].id])
    check('window is now 7', (await stored(A.tenantId)) === 7)
    check('the existing far-future booking is untouched', after.length === 1 && after[0].status === 'confirmed')
    await ownerPool.query('delete from bookings where id=$1', [bk.rows[0].id])
  }

  await reset()
  await appPool.end()
  await ownerPool.end()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
