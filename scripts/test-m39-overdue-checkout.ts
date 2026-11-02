/**
 * M39 #3 — QA: closing out an OVERDUE timed walk-in at an entered actual end.
 *
 *   shorter / equal / longer   billed off the entered end (equal or omitted = today's bill)
 *   7-day boundary             just inside accepted, just outside refused
 *   future                     refused (that is Extend's job)
 *   not overdue                provably unchanged: endAt ignored, no discount for leaving early
 *   reopen after late closeout restore-to-committed + overlap re-check, for all 3 durations
 *   add-on stock               released at the ENTERED end, not the committed end (M33)
 *   audit                      one walkin.late_checkout row only when the entered end differs
 *
 * Needs the database. Run with:
 *   npx tsx --import ./scripts/server-only-hook.mjs --import ./scripts/next-runtime-hook.mjs scripts/test-m39-overdue-checkout.ts
 */
import { Pool } from 'pg'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { sql } from 'drizzle-orm'
import * as schema from '../db/schema'
import { startWalkinCore, checkoutWalkinCore, reopenWalkinCore } from '../lib/booking/walkin'
import { addonHeadroom, lockAddonCatalog } from '../lib/booking/addons'
import { loadEnv } from './env'

type Db = NodePgDatabase<typeof schema>

let pass = 0,
  fail = 0
const check = (l: string, c: boolean) => {
  console.log(`${c ? '✓' : '✗ FAIL'}  ${l}`)
  if (c) pass++
  else fail++
}

const TZ = 'Asia/Kolkata'
const MIN = 60_000
const DAY = 24 * 60 * MIN

async function main() {
  loadEnv()
  const ownerPool = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })
  const appPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 })
  const app = drizzle(appPool, { schema })
  const withUser = <T>(userId: string, fn: (tx: Db) => Promise<T>): Promise<T> =>
    app.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`)
      return fn(tx as unknown as Db)
    })
  const q = <T extends object>(text: string, params: unknown[] = []) => ownerPool.query<T>(text, params)

  const slug = 'testm39overdue'
  await q(`delete from tenants where slug=$1`, [slug])
  const tenantId = (
    await q<{ id: string }>(
      `insert into tenants (slug,name,status,timezone,industry) values ($1,$2,'active',$3,'gaming_cafe') returning id`,
      [slug, `${slug} co`, TZ],
    )
  ).rows[0].id
  const branchId = (
    await q<{ id: string }>(`insert into branches (tenant_id,name,is_primary) values ($1,'Main',true) returning id`, [tenantId])
  ).rows[0].id
  const userId = (
    await q<{ id: string }>(
      `insert into users (email,password_hash) values ($1,'x') on conflict (email) do update set email=excluded.email returning id`,
      [`owner@${slug}.test`],
    )
  ).rows[0].id
  const membershipId = (
    await q<{ id: string }>(`insert into memberships (tenant_id,user_id,role,status) values ($1,$2,'owner','active') returning id`, [tenantId, userId])
  ).rows[0].id
  await q(`insert into business_profiles (tenant_id) values ($1) on conflict (tenant_id) do nothing`, [tenantId])
  const typeId = (
    await q<{ id: string }>(`insert into resource_types (tenant_id,name,hourly_rate) values ($1,'Station','100.00') returning id`, [tenantId])
  ).rows[0].id
  let stationSeq = 0
  const mkResource = async () =>
    (
      await q<{ id: string }>(
        `insert into resources (tenant_id,branch_id,resource_type_id,name,status) values ($1,$2,$3,$4,'available') returning id`,
        [tenantId, branchId, typeId, `S${++stationSeq}`],
      )
    ).rows[0].id
  const addonId = (
    await q<{ id: string }>(
      `insert into resource_type_addons (tenant_id,branch_id,resource_type_id,name,rate,rate_unit,stock_quantity)
       values ($1,$2,$3,'Controller','60.00','hour',5) returning id`,
      [tenantId, branchId, typeId],
    )
  ).rows[0].id

  const ctx = { tenantId, timezone: TZ, membershipId }
  let phoneSeq = 0

  /** A 30-min timed walk-in that started `startedMinAgo` minutes ago (so it is overdue by
   *  startedMinAgo - 30). Both the slot, the committed end and any add-on are shifted together. */
  async function overdue(startedMinAgo: number, withAddon = false) {
    const resourceId = await mkResource()
    const w = await withUser(userId, (tx) =>
      startWalkinCore(tx, ctx, {
        branchId,
        resourceId,
        phone: `98765${String(70000 + phoneSeq++).padStart(5, '0')}`,
        startAt: new Date().toISOString(),
        mode: 'timed',
        durationMin: 30,
        ...(withAddon ? { addons: [{ addonId, quantity: 1 }] } : {}),
      }),
    )
    const shift = `${startedMinAgo} minutes`
    await q(`update bookings set committed_end_at = committed_end_at - $2::interval where id=$1`, [w.id, shift])
    await q(`update booking_slots set starts_at = starts_at - $2::interval, ends_at = ends_at - $2::interval where booking_id=$1`, [w.id, shift])
    await q(`update booking_addons set starts_at = starts_at - $2::interval, ends_at = ends_at - $2::interval where booking_id=$1`, [w.id, shift])
    const r = await q<{ starts_at: Date; committed_end_at: Date }>(
      `select sl.starts_at, b.committed_end_at from bookings b join booking_slots sl on sl.booking_id=b.id where b.id=$1`,
      [w.id],
    )
    return { id: w.id, resourceId, start: new Date(r.rows[0].starts_at), committed: new Date(r.rows[0].committed_end_at) }
  }
  const checkout = (id: string, endAt?: Date) =>
    withUser(userId, (tx) => checkoutWalkinCore(tx, ctx, { bookingId: id, endAt: endAt?.toISOString() }))
  const refused = async (id: string, endAt: Date) => {
    try {
      await checkout(id, endAt)
      return null
    } catch (e) {
      return e instanceof Error ? e.message : String(e)
    }
  }
  const state = async (id: string) =>
    (
      await q<{ ends_at: Date | null; slot_total: string; total: string; committed_end_at: Date }>(
        `select sl.ends_at, sl.slot_total, b.total, b.committed_end_at from bookings b join booking_slots sl on sl.booking_id=b.id where b.id=$1`,
        [id],
      )
    ).rows[0]
  const audits = async (id: string) =>
    (await q<{ after: Record<string, string> }>(`select after from audit_log where entity_id=$1 and action='walkin.late_checkout'`, [id])).rows
  const addonRow = async (id: string) =>
    (await q<{ ends_at: Date | null; line_total: string }>(`select ends_at, line_total from booking_addons where booking_id=$1`, [id])).rows[0]
  const headroom = (from: Date, to: Date) =>
    withUser(userId, async (tx) => {
      const row = (await lockAddonCatalog(tx, tenantId, [addonId])).get(addonId)!
      return addonHeadroom(tx, tenantId, row, from, to)
    })

  // ── baseline: overdue, no endAt (today's bill, just unblocked) ──
  console.log('\n── equal to committed end / omitted ──')
  const base = await overdue(120)
  await checkout(base.id)
  const baseS = await state(base.id)
  const baseTotal = Number(baseS.total)
  check('E1 omitting endAt on an overdue walk-in checks out (no longer blocked)', baseTotal > 0)
  check('E2 ...billed for the full committed window (slot ends where it was committed)', +new Date(baseS.ends_at!) === +base.committed)
  check('E3 ...and writes no audit row', (await audits(base.id)).length === 0)

  const equal = await overdue(120)
  await checkout(equal.id, equal.committed)
  check('E4 entering exactly the committed end bills the same as omitting it', Number((await state(equal.id)).total) === baseTotal)
  check('E5 ...and writes no audit row (nothing differs)', (await audits(equal.id)).length === 0)

  // ── shorter ──
  console.log('\n── shorter than committed ──')
  const shorter = await overdue(120)
  const shortEnd = new Date(+shorter.start + 15 * MIN)
  await checkout(shorter.id, shortEnd)
  const sS = await state(shorter.id)
  check('S1 an entered end BEFORE the committed end bills the shorter real duration', Number(sS.total) < baseTotal && Number(sS.total) > 0)
  check('S2 ...the slot ends at the entered end', +new Date(sS.ends_at!) === +shortEnd)
  check('S3 ...committed_end_at is untouched (the record of what was promised)', +new Date(sS.committed_end_at) === +shorter.committed)
  const sA = await audits(shorter.id)
  check('S4 one audit row with committed end, entered end, checkout time and total', sA.length === 1 && sA[0].after.committedEndAt === shorter.committed.toISOString() && sA[0].after.enteredEndAt === shortEnd.toISOString() && Boolean(sA[0].after.checkedOutAt) && Number(sA[0].after.total) === Number(sS.total))

  // ── longer ──
  console.log('\n── longer than committed, still before now ──')
  const longer = await overdue(120)
  const longEnd = new Date(+longer.start + 75 * MIN)
  await checkout(longer.id, longEnd)
  const lS = await state(longer.id)
  check('L1 an entered end AFTER the committed end (but before now) bills the longer duration', Number(lS.total) > baseTotal)
  check('L2 ...the slot ends at the entered end', +new Date(lS.ends_at!) === +longEnd)
  check('L3 ...committed_end_at is untouched', +new Date(lS.committed_end_at) === +longer.committed)
  check('L4 ...one audit row', (await audits(longer.id)).length === 1)

  // ── 7-day boundary & future ──
  console.log('\n── bounds ──')
  const edge = await overdue(8 * 24 * 60 + 60) // started 8 days + 1 h ago
  const inside = new Date(Date.now() - 7 * DAY + 2 * MIN)
  check('B1 an end just inside 7 days back is accepted', (await refused(edge.id, inside)) === null)
  const beyond = await overdue(9 * 24 * 60)
  const outside = new Date(Date.now() - 7 * DAY - 2 * MIN)
  const bErr = await refused(beyond.id, outside)
  check('B2 an end just past 7 days back is refused', bErr !== null && bErr.includes('7 days'))
  const eight = await overdue(9 * 24 * 60)
  check('B3 8 days back is refused', (await refused(eight.id, new Date(Date.now() - 8 * DAY))) !== null)
  const fut = await overdue(120)
  const fErr = await refused(fut.id, new Date(Date.now() + 10 * MIN))
  check('F1 an entered end after now is refused', fErr !== null && fErr.toLowerCase().includes('future'))
  check('F2 ...before the start is refused too', (await refused(fut.id, new Date(+fut.start - MIN))) !== null)
  check('F3 ...and a refused attempt leaves the walk-in open', Number((await state(fut.id)).slot_total) === 0)

  // ── not overdue: unchanged ──
  console.log('\n── NOT overdue: provably unchanged ──')
  const live = await overdue(10) // started 10 min ago, committed end 20 min ahead
  const liveStart = live.start
  await checkout(live.id, new Date(Date.now() - 5 * MIN)) // an endAt that, if honoured, would discount it
  const liveS = await state(live.id)
  const fullPrice = Number(liveS.total)
  const control = await overdue(10) // same shape, checked out with no endAt at all
  await checkout(control.id)
  const expectedFull = Number((await state(control.id)).total)
  check('N1 an endAt on a not-yet-overdue walk-in is ignored: no discount for leaving early', fullPrice === expectedFull)
  check('N2 ...the slot is trimmed to checkout time (early-checkout behaviour), not to the entered end', +new Date(liveS.ends_at!) > +liveStart && +new Date(liveS.ends_at!) <= Date.now() + MIN)
  check('N3 ...committed_end_at untouched, and no late-checkout audit', +new Date(liveS.committed_end_at) === +live.committed && (await audits(live.id)).length === 0)

  // ── reopen after a late closeout ──
  console.log('\n── reopen after a late closeout ──')
  for (const [label, w, end] of [
    ['shorter', shorter, shortEnd],
    ['longer', longer, longEnd],
    ['equal', equal, equal.committed],
  ] as const) {
    await withUser(userId, (tx) => reopenWalkinCore(tx, { tenantId, membershipId }, w.id))
    const r = await state(w.id)
    check(`R1 (${label}) reopen restores the slot to the committed end and unprices it`, +new Date(r.ends_at!) === +w.committed && Number(r.slot_total) === 0 && Number(r.total) === 0)
    check(`R2 (${label}) ...committed_end_at unchanged`, +new Date(r.committed_end_at) === +w.committed)
    await checkout(w.id)
    check(`R3 (${label}) ...and it can be checked out again at the committed time`, Number((await state(w.id)).total) === baseTotal)
    void end
  }
  // overlap re-check: something booked into the time freed by a SHORTER closeout blocks the reopen
  const blocked = await overdue(120)
  const blockedEnd = new Date(+blocked.start + 10 * MIN)
  await checkout(blocked.id, blockedEnd)
  const rb = (
    await q<{ id: string }>(
      `insert into bookings (tenant_id, branch_id, booking_number, status) values ($1,$2,'BK-M39-OVERLAP','confirmed') returning id`,
      [tenantId, branchId],
    )
  ).rows[0].id
  await q(
    `insert into booking_slots (tenant_id, booking_id, resource_id, starts_at, ends_at, resource_name, resource_type_name)
     values ($1,$2,$3,$4,$5,'S','Station')`,
    [tenantId, rb, blocked.resourceId, new Date(+blockedEnd + 2 * MIN).toISOString(), new Date(+blockedEnd + 8 * MIN).toISOString()],
  )
  let reopenErr = ''
  try {
    await withUser(userId, (tx) => reopenWalkinCore(tx, { tenantId, membershipId }, blocked.id))
  } catch (e) {
    reopenErr = e instanceof Error ? e.message : String(e)
  }
  check('R4 reopening a shorter closeout is refused when the freed time has since been booked', reopenErr.toLowerCase().includes('booked'))
  check('R5 ...and the walk-in stays closed at the entered end', +new Date((await state(blocked.id)).ends_at!) === +blockedEnd)

  // ── add-on stock ──
  console.log('\n── add-on stock release ──')
  const holdDefault = await overdue(120, true)
  const holdShort = await overdue(120, true)
  const holdEnd = new Date(+holdShort.start + 10 * MIN)
  const gapFrom = new Date(+holdEnd + MIN)
  const gapTo = new Date(+holdShort.committed - MIN)
  const freeBefore = await headroom(gapFrom, gapTo)
  check('A1 while open, both walk-ins hold a unit across the committed window (5 - 2)', freeBefore === 3)
  await checkout(holdDefault.id)
  await checkout(holdShort.id, holdEnd)
  const aS = await addonRow(holdShort.id)
  const aD = await addonRow(holdDefault.id)
  check('A2 the add-on window ends at the ENTERED end, not the committed end', +new Date(aS.ends_at!) === +holdEnd)
  check('A3 ...and is priced over the shorter window', Number(aS.line_total) < Number(aD.line_total))
  check('A4 ...the committed-end checkout still ends the add-on at the committed end', +new Date(aD.ends_at!) === +holdDefault.committed)
  check('A5 the entered-end walk-in released its unit between the entered end and the committed end', (await headroom(gapFrom, gapTo)) === freeBefore + 1)

  // ── audit summary ──
  console.log('\n── audit ──')
  const rows = (await q<{ n: string }>(`select count(*)::text n from audit_log where tenant_id=$1 and action='walkin.late_checkout'`, [tenantId])).rows[0].n
  check('U1 only entered-end closeouts that differ were audited; the routine, omitted and equal ones were not', Number(rows) > 0 && (await audits(base.id)).length === 0 && (await audits(equal.id)).length === 0 && (await audits(live.id)).length === 0)

  await q(`delete from tenants where slug=$1`, [slug])
  await ownerPool.end()
  await appPool.end()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
