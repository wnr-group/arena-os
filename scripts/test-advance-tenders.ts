/**
 * M30 #2 — advance tenders accepted at booking/walk-in creation: N tenders in,
 * N advance_payments rows out, each with its own method, all in the booking's
 * own transaction.
 *
 * Calls createBookingCore/startWalkinCore DIRECTLY (no action layer, no UI) so
 * every refusal below is proven server-side. Needs migration 0107 applied.
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs scripts/test-advance-tenders.ts
 */
import { Pool } from 'pg'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { sql } from 'drizzle-orm'
import * as schema from '../db/schema'

type Db = NodePgDatabase<typeof schema>
type Tender = { method: 'cash' | 'card' | 'upi'; amount: number }

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
    let seq = 0
    // A fresh unit on demand: an open-tab walk-in occupies its resource
    // indefinitely, so each walk-in needs its own.
    const mintResource = async () => {
      const r = await ownerPool.query<{ id: string }>(
        `insert into resources (tenant_id,branch_id,resource_type_id,name,status) values ($1,$2,$3,$4,'available')
         on conflict (tenant_id,name) do update set status='available' returning id`,
        [tenantId, branchId, rt.rows[0].id, `W${++seq}`],
      )
      return r.rows[0].id
    }
    return { tenantId, branchId, userId, membershipId, resourceId: res.rows[0].id, mintResource, ctx: { tenantId, timezone: TZ, membershipId } }
  }
  type T = Awaited<ReturnType<typeof makeTenant>>

  const A = await makeTenant('testadvtendersa', 'gaming_cafe')
  const REST = await makeTenant('testadvtendersr', 'restaurant')
  const STUDIO = await makeTenant('testadvtenderss', 'recording_studio')
  for (const t of [A, REST, STUDIO]) {
    await ownerPool.query(`delete from audit_log where tenant_id=$1 and action='booking.advance_collected'`, [t.tenantId])
    await ownerPool.query('delete from bookings where tenant_id=$1', [t.tenantId]) // cascades advance_payments
    await ownerPool.query('delete from sequences where tenant_id=$1', [t.tenantId])
  }

  const ledger = async (bookingId: string) =>
    (
      await ownerPool.query(
        `select method, amount::text amount, collected_by, invoice_id, branch_id from advance_payments where booking_id=$1 order by amount`,
        [bookingId],
      )
    ).rows as { method: string; amount: string; collected_by: string | null; invoice_id: string | null; branch_id: string }[]
  const countRows = async (tenantId: string) =>
    (await ownerPool.query('select count(*)::int n from advance_payments where tenant_id=$1', [tenantId])).rows[0].n as number
  const bookingCount = async (tenantId: string) =>
    (await ownerPool.query('select count(*)::int n from bookings where tenant_id=$1', [tenantId])).rows[0].n as number
  const auditFor = async (bookingId: string) =>
    (await ownerPool.query(`select after from audit_log where entity_id=$1 and action='booking.advance_collected'`, [bookingId])).rows

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
  const day = () => new Date(Date.UTC(2048, 2, 1 + (++seq % 27), 10, 0, 0))
  const book = (t: T, start: Date, advanceTenders?: Tender[]) =>
    withUser(t.userId, (tx) =>
      createBookingCore(tx, t.ctx, {
        branchId: t.branchId,
        source: 'staff',
        discount: 0,
        deposit: 0,
        advanceTenders,
        slots: [
          { resourceId: t.resourceId, startsAt: start.toISOString(), endsAt: new Date(start.getTime() + 2 * 3600_000).toISOString() },
        ],
      } as never),
    )
  const walk = async (t: T, advanceTenders?: Tender[]) =>
    withUser(t.userId, async (tx) =>
      startWalkinCore(tx, t.ctx, {
        branchId: t.branchId,
        resourceId: await t.mintResource(),
        phone: `90000${String(Math.floor(Math.random() * 100000)).padStart(5, '0')}`,
        startAt: new Date().toISOString(),
        mode: 'open_tab',
        advanceTenders,
      } as never),
    )

  // ══ 1. createBookingCore — 0 / 1 / several tenders ═════════════════════
  console.log('\n── createBookingCore: 0 / 1 / several tenders ──')
  {
    const b0 = await book(A, day())
    check('no tenders → no ledger rows', (await ledger(b0.id)).length === 0)
    const bEmpty = await book(A, day(), [])
    check('empty list → no ledger rows', (await ledger(bEmpty.id)).length === 0)
    check('no tenders → no audit entry', (await auditFor(b0.id)).length === 0)

    const b1 = await book(A, day(), [{ method: 'upi', amount: 250 }])
    const r1 = await ledger(b1.id)
    check('one tender → one row, correct method + amount', r1.length === 1 && r1[0].method === 'upi' && r1[0].amount === '250.00')
    check(
      '…stamped with the collecting membership and branch, unconsumed',
      r1[0].collected_by === A.membershipId && r1[0].branch_id === A.branchId && r1[0].invoice_id === null,
    )

    const b3 = await book(A, day(), [
      { method: 'cash', amount: 300 },
      { method: 'upi', amount: 200 },
      { method: 'card', amount: 50.5 },
    ])
    const r3 = await ledger(b3.id)
    check('three tenders → three rows', r3.length === 3)
    check('…each keeps its own method', ['cash', 'upi', 'card'].every((m) => r3.some((r) => r.method === m)))
    check(
      '…each keeps its own amount',
      r3.map((r) => r.amount).sort().join() === ['200.00', '300.00', '50.50'].sort().join(),
    )
    const audit = await auditFor(b3.id)
    check(
      'one audit entry lists every tender (method + amount) and the total',
      audit.length === 1 && audit[0].after.tenders.length === 3 && audit[0].after.total === '550.50',
    )
  }

  // ══ 2. invalid tenders ═════════════════════════════════════════════════
  console.log('\n── createBookingCore: invalid tenders refused, nothing written ──')
  {
    const before = { rows: await countRows(A.tenantId), bookings: await bookingCount(A.tenantId) }
    await expectReject('a zero-amount tender is refused', () => book(A, day(), [{ method: 'cash', amount: 0 }]), 'greater than zero')
    await expectReject('a negative tender is refused', () => book(A, day(), [{ method: 'cash', amount: -10 }]), 'greater than zero')
    await expectReject('NaN is refused', () => book(A, day(), [{ method: 'cash', amount: Number.NaN }]), 'greater than zero')
    await expectReject(
      'one bad tender among good ones refuses the whole booking',
      () => book(A, day(), [{ method: 'cash', amount: 100 }, { method: 'upi', amount: 0 }]),
      'greater than zero',
    )
    await expectReject('method "online" is refused', () => book(A, day(), [{ method: 'online' as never, amount: 100 }]), 'cash, card or UPI')
    await expectReject('method "wallet" is refused', () => book(A, day(), [{ method: 'wallet' as never, amount: 100 }]), 'cash, card or UPI')
    check(
      '…no ledger rows and no bookings were left behind',
      (await countRows(A.tenantId)) === before.rows && (await bookingCount(A.tenantId)) === before.bookings,
    )
  }

  // ══ 3. industry gate ═══════════════════════════════════════════════════
  console.log('\n── any tender on a non-gaming_cafe tenant refused ──')
  for (const [name, t] of [['restaurant', REST], ['recording_studio', STUDIO]] as const) {
    await expectReject(`createBookingCore: a tender is refused for ${name}`, () => book(t, day(), [{ method: 'cash', amount: 100 }]), 'gaming-cafe')
    await expectReject(`startWalkinCore: a tender is refused for ${name}`, () => walk(t, [{ method: 'cash', amount: 100 }]), 'gaming-cafe')
    check('…no booking, no ledger rows', (await bookingCount(t.tenantId)) === 0 && (await countRows(t.tenantId)) === 0)
    const ok = await book(t, day())
    check('…while omitting tenders still works', typeof ok.id === 'string')
  }

  // ══ 4. atomicity ═══════════════════════════════════════════════════════
  console.log('\n── atomic with the booking ──')
  {
    const start = day()
    await book(A, start)
    const before = { rows: await countRows(A.tenantId), bookings: await bookingCount(A.tenantId) }
    let refused = false
    try {
      await book(A, start, [{ method: 'cash', amount: 111 }, { method: 'upi', amount: 112 }])
    } catch {
      refused = true
    }
    check('an overlapping booking carrying tenders is refused', refused)
    check(
      '…zero advance_payments rows left behind, and no booking',
      (await countRows(A.tenantId)) === before.rows && (await bookingCount(A.tenantId)) === before.bookings,
    )
    const audits = await ownerPool.query(
      `select 1 from audit_log where tenant_id=$1 and action='booking.advance_collected' and (after->>'total')='223.00'`,
      [A.tenantId],
    )
    check('…and no audit entry for it', audits.rowCount === 0)
  }

  // ══ 5. startWalkinCore ═════════════════════════════════════════════════
  console.log('\n── startWalkinCore ──')
  {
    const w0 = await walk(A)
    check('walk-in with no tenders → no ledger rows', (await ledger(w0.id)).length === 0)
    const w2 = await walk(A, [
      { method: 'cash', amount: 300 },
      { method: 'upi', amount: 200 },
    ])
    const r = await ledger(w2.id)
    check('two tenders → two rows with their own methods', r.length === 2 && r.some((x) => x.method === 'cash' && x.amount === '300.00') && r.some((x) => x.method === 'upi' && x.amount === '200.00'))
    check('…one audit entry, total 500.00', (await auditFor(w2.id)).length === 1 && (await auditFor(w2.id))[0].after.total === '500.00')

    const before = await countRows(A.tenantId)
    await expectReject('a zero tender is refused', () => walk(A, [{ method: 'cash', amount: 0 }]), 'greater than zero')
    await expectReject('an invalid method is refused', () => walk(A, [{ method: 'online' as never, amount: 50 }]), 'cash, card or UPI')
    check('…nothing written', (await countRows(A.tenantId)) === before)
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
