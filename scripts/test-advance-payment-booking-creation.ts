/**
 * M26 #4 — staff UI plumbing: recording a gaming-cafe cash advance at
 * booking creation (New Booking wizard + walk-in start). Drives
 * createBookingCore (lib/booking/service.ts) and startWalkinCore
 * (lib/booking/walkin.ts) directly against a real database, same shape as
 * scripts/test-per-head-pricing.ts — this is specifically the "don't trust
 * the client" bar: a forged advancePaid must be refused at the CORE
 * function itself, not just by a hidden UI field or the action's zod schema.
 *
 * Covers:
 *   - a gaming_cafe booking/walk-in with an advance lands correctly in
 *     bookings.advance_paid
 *   - a non-zero advancePaid is refused server-side for EVERY other
 *     industry (not just restaurant — the gate is `!== 'gaming_cafe'`,
 *     checked generically), even calling the core directly with no action
 *     layer in between at all
 *   - advancePaid omitted or 0 is byte-identical to today, for every
 *     industry
 *   - a negative advancePaid is refused, independent of industry
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs scripts/test-advance-payment-booking-creation.ts
 */
import { Pool } from 'pg'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { sql } from 'drizzle-orm'
import * as schema from '../db/schema'

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
  const { loadEnv } = await import('./env')
  loadEnv()
  const { createBookingCore, BookingError } = await import('../lib/booking/service')
  const { startWalkinCore } = await import('../lib/booking/walkin')

  const ownerPool = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })
  const appPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 })
  const app = drizzle(appPool, { schema })

  async function withUser<T>(userId: string, fn: (tx: Db) => Promise<T>): Promise<T> {
    return app.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`)
      return fn(tx as unknown as Db)
    })
  }

  async function makeTenant(slug: string, industry: string) {
    const t = await ownerPool.query<{ id: string }>(
      `insert into tenants (slug,name,status,timezone,industry) values ($1,$2,'active',$3,$4)
       on conflict (slug) do update set name=excluded.name, industry=excluded.industry returning id`,
      [slug, `${slug} co`, TZ, industry],
    )
    const tenantId = t.rows[0].id
    const b = await ownerPool.query<{ id: string }>(
      `insert into branches (tenant_id,name,is_primary) values ($1,'Main',true)
       on conflict (tenant_id,name) do update set is_primary=true returning id`,
      [tenantId],
    )
    const branchId = b.rows[0].id
    const u = await ownerPool.query<{ id: string }>(
      `insert into users (email,password_hash) values ($1,'x')
       on conflict (email) do update set email=excluded.email returning id`,
      [`owner@${slug}.test`],
    )
    const userId = u.rows[0].id
    const m = await ownerPool.query<{ id: string }>(
      `insert into memberships (tenant_id,user_id,role,status) values ($1,$2,'owner','active')
       on conflict (tenant_id,user_id) do update set role='owner', status='active' returning id`,
      [tenantId, userId],
    )
    const membershipId = m.rows[0].id

    const rt = await ownerPool.query<{ id: string }>(
      `insert into resource_types (tenant_id,name,hourly_rate) values ($1,'PS5','200.00')
       on conflict (tenant_id,name) do update set hourly_rate='200.00' returning id`,
      [tenantId],
    )
    const res = await ownerPool.query<{ id: string }>(
      `insert into resources (tenant_id,branch_id,resource_type_id,name,status) values ($1,$2,$3,'S1','available')
       on conflict (tenant_id,name) do update set status='available' returning id`,
      [tenantId, branchId, rt.rows[0].id],
    )
    const resourceId = res.rows[0].id
    let extraResSeq = 0
    // A FRESH unit on demand — createBookingCore's own tests put FUTURE
    // reserved slots on `resourceId`, and an open-tab walk-in occupies its
    // resource indefinitely once started (never checked out here), so each
    // walk-in test below needs its own unit rather than tripping
    // startWalkinCore's genuine "has a booking scheduled later"/overlap
    // guards for a reason that has nothing to do with this ticket.
    const mintResource = async () => {
      const name = `W${++extraResSeq}`
      const r = await ownerPool.query<{ id: string }>(
        `insert into resources (tenant_id,branch_id,resource_type_id,name,status) values ($1,$2,$3,$4,'available')
         on conflict (tenant_id,name) do update set status='available' returning id`,
        [tenantId, branchId, rt.rows[0].id, name],
      )
      return r.rows[0].id
    }

    return { tenantId, branchId, userId, membershipId, resourceId, mintResource, ctx: { tenantId, timezone: TZ, membershipId } }
  }

  const A = await makeTenant('testadvcreatea', 'gaming_cafe')
  const REST = await makeTenant('testadvcreater', 'restaurant')
  const STUDIO = await makeTenant('testadvcreates', 'recording_studio')
  for (const t of [A, REST, STUDIO]) {
    await ownerPool.query('delete from bookings where tenant_id=$1', [t.tenantId])
    await ownerPool.query('delete from sequences where tenant_id=$1', [t.tenantId])
  }

  const bookingRow = async (id: string) =>
    (await ownerPool.query(`select (select coalesce(sum(amount),0)::numeric(10,2)::text from advance_payments where booking_id=bookings.id) advance_paid, channel from bookings where id=$1`, [id])).rows[0]

  const expectReject = async (label: string, fn: () => Promise<unknown>, messageIncludes?: string) => {
    try {
      await fn()
      check(label, false)
    } catch (e) {
      const ok = e instanceof BookingError && (!messageIncludes || e.message.includes(messageIncludes))
      check(label, ok)
      if (!ok) console.log('   (unexpected)', e)
    }
  }

  let seq = 0
  const day = () => new Date(Date.UTC(2047, 2, 1 + (++seq % 27), 10, 0, 0))

  // ══ 1. createBookingCore — gaming_cafe, a real advance ══════════════════
  console.log('\n── createBookingCore: gaming_cafe with an advance ──')
  {
    const start = day()
    const end = new Date(start.getTime() + 2 * 3600_000)
    const b = await withUser(A.userId, (tx) =>
      createBookingCore(tx, A.ctx, {
        branchId: A.branchId,
        source: 'staff',
        discount: 0,
        deposit: 0,
        advanceTenders: [{ method: 'cash', amount: 250 }],
        slots: [{ resourceId: A.resourceId, startsAt: start.toISOString(), endsAt: end.toISOString() }],
      }),
    )
    const row = await bookingRow(b.id)
    check('booking created', typeof b.id === 'string')
    check('advance_paid lands correctly on the new row', row.advance_paid === '250.00')
  }

  // ══ 2. createBookingCore — omitted/0 is byte-identical to today ═════════
  console.log('\n── createBookingCore: advancePaid omitted ──')
  {
    const start = day()
    const end = new Date(start.getTime() + 2 * 3600_000)
    const b = await withUser(A.userId, (tx) =>
      createBookingCore(tx, A.ctx, {
        branchId: A.branchId,
        source: 'staff',
        discount: 0,
        deposit: 0,
        slots: [{ resourceId: A.resourceId, startsAt: start.toISOString(), endsAt: end.toISOString() }],
      }),
    )
    const row = await bookingRow(b.id)
    check('leaving it out defaults advance_paid to 0.00', row.advance_paid === '0.00')
  }

  // ══ 3. createBookingCore — negative advance is refused ══════════════════
  console.log('\n── createBookingCore: a negative advance ──')
  {
    const start = day()
    const end = new Date(start.getTime() + 2 * 3600_000)
    await expectReject(
      'a negative advance tender is refused, independent of industry',
      () =>
        withUser(A.userId, (tx) =>
          createBookingCore(tx, A.ctx, {
            branchId: A.branchId,
            source: 'staff',
            discount: 0,
            deposit: 0,
            advanceTenders: [{ method: 'cash', amount: -50 }],
            slots: [{ resourceId: A.resourceId, startsAt: start.toISOString(), endsAt: end.toISOString() }],
          }),
        ),
      'greater than zero',
    )
  }

  // ══ 4. createBookingCore — refused server-side for every other industry ═
  console.log('\n── createBookingCore: refused for non-gaming_cafe tenants ──')
  for (const T of [REST, STUDIO]) {
    const start = day()
    const end = new Date(start.getTime() + 2 * 3600_000)
    const beforeCount = (await ownerPool.query('select count(*)::int n from bookings where tenant_id=$1', [T.tenantId])).rows[0].n
    await expectReject(
      `a forged advancePaid=500 is refused for a ${(await ownerPool.query('select industry from tenants where id=$1', [T.tenantId])).rows[0].industry} tenant — called DIRECTLY, no action layer, no UI in the way`,
      () =>
        withUser(T.userId, (tx) =>
          createBookingCore(tx, T.ctx, {
            branchId: T.branchId,
            source: 'staff',
            discount: 0,
            deposit: 0,
            advanceTenders: [{ method: 'cash', amount: 500 }],
            slots: [{ resourceId: T.resourceId, startsAt: start.toISOString(), endsAt: end.toISOString() }],
          }),
        ),
      'gaming-cafe',
    )
    const afterCount = (await ownerPool.query('select count(*)::int n from bookings where tenant_id=$1', [T.tenantId])).rows[0].n
    check('…and no booking was created at all — refused before anything was written', afterCount === beforeCount)
  }

  // ══ 5. createBookingCore — 0/omitted is fine for every other industry ═══
  console.log('\n── createBookingCore: advancePaid=0 is fine everywhere ──')
  for (const T of [REST, STUDIO]) {
    const start = day()
    const end = new Date(start.getTime() + 2 * 3600_000)
    const b = await withUser(T.userId, (tx) =>
      createBookingCore(tx, T.ctx, {
        branchId: T.branchId,
        source: 'staff',
        discount: 0,
        deposit: 0,
        slots: [{ resourceId: T.resourceId, startsAt: start.toISOString(), endsAt: end.toISOString() }],
      }),
    )
    const row = await bookingRow(b.id)
    check('a non-gaming_cafe booking with no advance is completely unaffected', row.advance_paid === '0.00')
  }

  // ══ 6. startWalkinCore — gaming_cafe, a real advance ═════════════════════
  console.log('\n── startWalkinCore: gaming_cafe with an advance ──')
  {
    const walkinResourceId = await A.mintResource()
    const w = await withUser(A.userId, (tx) =>
      startWalkinCore(tx, A.ctx, {
        branchId: A.branchId,
        resourceId: walkinResourceId,
        phone: '9876500001',
        startAt: new Date().toISOString(),
        mode: 'open_tab',
        advanceTenders: [{ method: 'cash', amount: 300 }],
      }),
    )
    const row = await bookingRow(w.id)
    check('walk-in created', typeof w.id === 'string')
    check('…as a walk-in', row.channel === 'walkin')
    check('advance_paid lands correctly on the walk-in row', row.advance_paid === '300.00')
  }

  // ══ 7. startWalkinCore — omitted is byte-identical ══════════════════════
  console.log('\n── startWalkinCore: advancePaid omitted ──')
  {
    const walkinResourceId = await A.mintResource()
    const w = await withUser(A.userId, (tx) =>
      startWalkinCore(tx, A.ctx, {
        branchId: A.branchId,
        resourceId: walkinResourceId,
        phone: '9876500002',
        startAt: new Date().toISOString(),
        mode: 'open_tab',
      }),
    )
    const row = await bookingRow(w.id)
    check('leaving it out defaults advance_paid to 0.00', row.advance_paid === '0.00')
  }

  // ══ 8. startWalkinCore — refused server-side for every other industry ═══
  console.log('\n── startWalkinCore: refused for non-gaming_cafe tenants ──')
  let phoneSeq = 0
  for (const T of [REST, STUDIO]) {
    const beforeCount = (await ownerPool.query('select count(*)::int n from bookings where tenant_id=$1', [T.tenantId])).rows[0].n
    await expectReject(
      'a forged advancePaid=500 is refused — called DIRECTLY, no action layer, no UI in the way',
      () =>
        withUser(T.userId, (tx) =>
          startWalkinCore(tx, T.ctx, {
            branchId: T.branchId,
            resourceId: T.resourceId,
            phone: `987660${String(1000 + phoneSeq++).padStart(4, '0')}`,
            startAt: new Date().toISOString(),
            mode: 'open_tab',
            advanceTenders: [{ method: 'cash', amount: 500 }],
          }),
        ),
      'gaming-cafe',
    )
    const afterCount = (await ownerPool.query('select count(*)::int n from bookings where tenant_id=$1', [T.tenantId])).rows[0].n
    check('…and no walk-in was created at all — refused before anything was written', afterCount === beforeCount)
  }

  // ══ 9. startWalkinCore — negative advance is refused ═════════════════════
  console.log('\n── startWalkinCore: a negative advance ──')
  {
    await expectReject(
      'a negative advance tender is refused, independent of industry',
      () =>
        withUser(A.userId, (tx) =>
          startWalkinCore(tx, A.ctx, {
            branchId: A.branchId,
            resourceId: A.resourceId,
            phone: `987670${String(1000 + phoneSeq++).padStart(4, '0')}`,
            startAt: new Date().toISOString(),
            mode: 'open_tab',
            advanceTenders: [{ method: 'cash', amount: -1 }],
          }),
        ),
      'greater than zero',
    )
  }

  await ownerPool.end()
  await appPool.end()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
