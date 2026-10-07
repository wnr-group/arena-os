/**
 * M33 #8 — QA: the adversarial cases the prod-data-safety review named, run
 * against a real database (needs migration 0108). Each finding maps to a test:
 *
 *   finding                         covered by
 *   ──────────────────────────────  ───────────────────────────────────────────
 *   stock race (last unit)          test-addon-stock-concurrency R1-R3, and X2
 *                                   below for BOTH industries
 *   multi-add-on deadlock (ABBA)    test-addon-stock-concurrency D1-D3
 *   cancelled-booking stock release test-resource-addons K3,
 *                                   test-addon-stock-concurrency C1-C5
 *   ends_at drift (extend/correct/  test-walkin-addon-lockstep T*, O*, R*
 *   checkout/open tab)
 *   late checkout up to 7 days      L1-L5 there (48h/49h) + the 7-DAY BOUNDARY
 *                                   below (accepted just inside, refused outside)
 *   day-rate midnight edge          pure: test-resource-addons-pricing;
 *                                   HERE end-to-end through booking + invoice
 *   cross-industry                  X1-X4 below: gaming cafe AND recording studio
 *                                   (studio-setup slot) — same catalog, same rules
 *   public RLS                      P1-P8 below: a TRUE anonymous session
 *                                   (no app.user_id), not a staff session
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs --import ./scripts/next-runtime-hook.mjs scripts/test-addon-qa-adversarial.ts
 */
import { Pool } from 'pg'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { sql } from 'drizzle-orm'
import * as schema from '../db/schema'
import { createBookingCore } from '../lib/booking/service'
import { startWalkinCore, checkoutWalkinCore, WALKIN_LATE_CHECKOUT_MAX_DAYS } from '../lib/booking/walkin'
import { issueInvoiceForBooking } from '../lib/billing/invoice'
import { loadEnv } from './env'

type Db = NodePgDatabase<typeof schema>

let pass = 0,
  fail = 0
const check = (l: string, c: boolean) => {
  console.log(`${c ? '✓' : '✗ FAIL'}  ${l}`)
  if (c) pass++
  else fail++
}
const errCode = (e: unknown) =>
  (e as { cause?: { code?: string } })?.cause?.code ?? (e as { code?: string })?.code

const TZ = 'Asia/Kolkata'
const HOUR = 3_600_000
const DAY = 24 * HOUR
/** IST wall-clock constructor. */
const ist = (y: number, m: number, d: number, hh: number, mm = 0) =>
  new Date(Date.UTC(y, m - 1, d, hh, mm) - (5 * 60 + 30) * 60_000)
/** The IST calendar date `days` from now, as [y, m, d]. */
const istDate = (days: number): [number, number, number] => {
  const d = new Date(Date.now() + days * DAY + (5 * 60 + 30) * 60_000)
  return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()]
}

async function main() {
  loadEnv()
  const ownerPool = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })
  const appPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 })
  const app = drizzle(appPool, { schema })
  const q = <T extends object>(text: string, params: unknown[] = []) => ownerPool.query<T>(text, params)

  // ── fixtures: one tenant per industry ─────────────────────────────────────
  async function mkTenant(slug: string, industry: 'gaming_cafe' | 'recording_studio') {
    await q(`delete from tenants where slug=$1`, [slug])
    const tenantId = (
      await q<{ id: string }>(
        `insert into tenants (slug,name,status,timezone,industry) values ($1,$2,'active',$3,$4) returning id`,
        [slug, `${slug} co`, TZ, industry],
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
      await q<{ id: string }>(
        `insert into memberships (tenant_id,user_id,role,status) values ($1,$2,'owner','active') returning id`,
        [tenantId, userId],
      )
    ).rows[0].id
    await q(`insert into business_profiles (tenant_id) values ($1) on conflict (tenant_id) do nothing`, [tenantId])
    const typeId = (
      await q<{ id: string }>(
        `insert into resource_types (tenant_id,name,hourly_rate) values ($1,'Room','100.00') returning id`,
        [tenantId],
      )
    ).rows[0].id
    const mkResource = async (name: string) =>
      (
        await q<{ id: string }>(
          `insert into resources (tenant_id,branch_id,resource_type_id,name,status) values ($1,$2,$3,$4,'available') returning id`,
          [tenantId, branchId, typeId, name],
        )
      ).rows[0].id
    const mkAddon = async (name: string, rate: string, unit: 'hour' | 'day', stock: number, active = true) =>
      (
        await q<{ id: string }>(
          `insert into resource_type_addons (tenant_id,branch_id,resource_type_id,name,rate,rate_unit,stock_quantity,is_active)
           values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
          [tenantId, branchId, typeId, name, rate, unit, stock, active],
        )
      ).rows[0].id
    const withUser = <T>(fn: (tx: Db) => Promise<T>): Promise<T> =>
      app.transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`)
        return fn(tx as unknown as Db)
      })
    const ctx = { tenantId, timezone: TZ, membershipId }
    const book = (
      resourceId: string,
      start: Date,
      end: Date,
      addons: { addonId: string; quantity: number }[],
      setupId?: string,
    ) =>
      withUser((tx) =>
        createBookingCore(tx, ctx, {
          branchId,
          customerName: 'T',
          customerPhone: '9876543210',
          source: 'staff',
          discount: 0,
          deposit: 0,
          slots: [{ resourceId, startsAt: start.toISOString(), endsAt: end.toISOString(), addons, setupId }],
        }),
      )
    return { slug, tenantId, branchId, userId, membershipId, typeId, mkResource, mkAddon, withUser, ctx, book }
  }

  const gaming = await mkTenant('testaddonqagaming', 'gaming_cafe')
  const studio = await mkTenant('testaddonqastudio', 'recording_studio')

  // ── X: cross-industry — identical catalog mechanism, nothing gated ────────
  for (const t of [gaming, studio]) {
    const tag = t === gaming ? 'gaming' : 'studio'
    const camera = await t.mkAddon('Camera', '100.00', 'hour', 1)
    const rA = await t.mkResource('A')
    const rB = await t.mkResource('B')
    const [y, m, d] = istDate(40)

    // A studio books through a SETUP (a day/hour-rated package) — the add-on
    // must layer on top of it exactly as on a plain per-hour slot.
    let setupId: string | undefined
    if (t === studio) {
      setupId = (
        await q<{ id: string }>(
          `insert into resource_setups (tenant_id,resource_id,name,rate,rate_unit,is_active) values ($1,$2,'Kitchen','800.00','hour',true) returning id`,
          [t.tenantId, rA],
        )
      ).rows[0].id
    }
    const roomRate = setupId ? 800 : 100
    const b1 = await t.book(rA, ist(y, m, d, 12), ist(y, m, d, 14), [{ addonId: camera, quantity: 1 }], setupId)
    const sub = (await q<{ subtotal: string }>(`select subtotal from bookings where id=$1`, [b1.id])).rows[0].subtotal
    check(`X1 ${tag}: add-on prices on top of the room (2h×${roomRate} + 2h×100)`, sub === (roomRate * 2 + 200).toFixed(2))

    // The last unit is taken — a second booking in the same window is refused,
    // identically for both industries.
    let refused = false
    try {
      await t.book(rB, ist(y, m, d, 13), ist(y, m, d, 15), [{ addonId: camera, quantity: 1 }])
    } catch {
      refused = true
    }
    check(`X2 ${tag}: stock enforced identically (last unit gone → second booking refused)`, refused)

    // And the refusal is atomic: no orphan booking left behind.
    const n = (
      await q<{ n: string }>(`select count(*)::int as n from bookings where tenant_id=$1 and status <> 'cancelled'`, [t.tenantId])
    ).rows[0].n
    check(`X3 ${tag}: refused attach left no orphan booking`, Number(n) === 1)

    // Race for the last unit, in a window nobody holds: exactly one wins.
    const [y2, m2, d2] = istDate(41)
    const res = await Promise.allSettled([
      t.book(rA, ist(y2, m2, d2, 12), ist(y2, m2, d2, 14), [{ addonId: camera, quantity: 1 }], setupId),
      t.book(rB, ist(y2, m2, d2, 12), ist(y2, m2, d2, 14), [{ addonId: camera, quantity: 1 }]),
    ])
    const won = res.filter((r) => r.status === 'fulfilled').length
    const lost = res.filter((r) => r.status === 'rejected')
    check(`X4 ${tag}: concurrent race for the last unit → exactly one winner`, won === 1 && lost.length === 1)
    check(`X4b ${tag}: the loser failed cleanly (not a deadlock / serialization error)`, lost.every((r) => !['40P01', '40001'].includes(errCode((r as PromiseRejectedResult).reason) ?? '')))
  }

  // ── D: day-rate midnight edge, end to end through booking + invoice ───────
  {
    const t = gaming
    const lens = await t.mkAddon('Lens', '500.00', 'day', 5)
    const [y, m, d] = istDate(60)
    // 11pm → 1am: 2 elapsed hours, 2 calendar dates touched. Elapsed rule: 1 block.
    const cases: { label: string; start: Date; end: Date; blocks: number }[] = [
      { label: '11pm-1am (2h, crosses midnight)', start: ist(y, m, d, 23), end: ist(y, m, d + 1, 1), blocks: 1 },
      { label: '6pm-5pm next day (23h, 2 dates touched)', start: ist(y, m, d + 3, 18), end: ist(y, m, d + 4, 17), blocks: 1 },
      { label: '11pm to 12am two days on (25h)', start: ist(y, m, d + 6, 23), end: ist(y, m, d + 7, 24), blocks: 2 },
    ]
    for (const c of cases) {
      const r = await t.mkResource(`Mid ${c.blocks}-${+c.start}`)
      const b = await t.book(r, c.start, c.end, [{ addonId: lens, quantity: 1 }])
      const line = (
        await q<{ line_total: string }>(`select line_total from booking_addons where booking_id=$1`, [b.id])
      ).rows[0].line_total
      check(`D1 ${c.label}: add-on bills ${c.blocks} day-block(s) = ${(500 * c.blocks).toFixed(2)}`, line === (500 * c.blocks).toFixed(2))
      const inv = await t.withUser((tx) => issueInvoiceForBooking(tx, { id: t.tenantId, timezone: TZ }, { bookingId: b.id }))
      const items = (
        await q<{ kind: string; line_total: string }>(
          `select kind,line_total from invoice_items where invoice_id=$1 and kind='addon'`,
          [inv.invoiceId],
        )
      ).rows
      check(`D2 ${c.label}: invoice carries one kind='addon' item at the same figure`, items.length === 1 && items[0].line_total === (500 * c.blocks).toFixed(2))
    }
  }

  // ── L: M32 late-checkout 7-day boundary, stock frees from the entered end ─
  {
    const t = gaming
    const lens = await t.mkAddon('Late lens', '500.00', 'day', 1)
    const startWalkin = (resourceId: string) =>
      t.withUser((tx) =>
        startWalkinCore(tx, t.ctx, {
          branchId: t.branchId,
          resourceId,
          phone: '9876543299',
          startAt: new Date().toISOString(),
          mode: 'open_tab',
          addons: [{ addonId: lens, quantity: 1 }],
        }),
      )
    const rewind = async (bookingId: string, by: number) => {
      const from = new Date(Date.now() - by)
      await q(`update booking_slots set starts_at=$2 where booking_id=$1`, [bookingId, from])
      await q(`update booking_addons set starts_at=$2 where booking_id=$1`, [bookingId, from])
      return from
    }
    const days = WALKIN_LATE_CHECKOUT_MAX_DAYS

    // Forgotten tab: started 8 days ago, checked out with an end just INSIDE
    // the window (days − 1h ago) → accepted, add-on ends_at = the entered end.
    const rIn = await t.mkResource('Late in')
    const wIn = await startWalkin(rIn.toString())
    await rewind(wIn.id, (days + 1) * DAY)
    const endIn = new Date(Date.now() - (days * DAY - HOUR))
    await t.withUser((tx) => checkoutWalkinCore(tx, t.ctx, { bookingId: wIn.id, endAt: endIn.toISOString() }))
    const row = (
      await q<{ ends_at: Date; line_total: string }>(`select ends_at,line_total from booking_addons where booking_id=$1`, [wIn.id])
    ).rows[0]
    check('L6 checkout just inside 7 days is accepted; add-on window stamped at the ENTERED end', +row.ends_at === +endIn)
    // 8d start → end 6d23h ago = 25h elapsed = 2 day-blocks.
    check('L7 …and the daily add-on bills ceil(25h/24) = 2 blocks (1000.00)', row.line_total === '1000.00')

    // Just OUTSIDE the window → refused, and nothing was stamped.
    const rOut = await t.mkResource('Late out')
    const wOut = await startWalkin(rOut.toString())
    await rewind(wOut.id, (days + 2) * DAY)
    let refused = false
    try {
      await t.withUser((tx) =>
        checkoutWalkinCore(tx, t.ctx, { bookingId: wOut.id, endAt: new Date(Date.now() - (days * DAY + HOUR)).toISOString() }),
      )
    } catch {
      refused = true
    }
    const after = (await q<{ ends_at: Date | null }>(`select ends_at from booking_addons where booking_id=$1`, [wOut.id])).rows[0]
    check('L8 checkout just OUTSIDE 7 days is refused', refused)
    check('L9 …and the add-on is still an open window (ends_at NULL, still holding stock)', after.ends_at === null)
  }

  // ── P: public RLS — a TRUE anonymous session ──────────────────────────────
  {
    const t = gaming
    const active = await q<{ n: string }>(`select count(*)::int as n from resource_type_addons where tenant_id=$1 and is_active`, [t.tenantId])
    await t.mkAddon('Hidden retired', '10.00', 'hour', 3, false)
    const inactiveN = Number(
      (await q<{ n: string }>(`select count(*)::int as n from resource_type_addons where tenant_id=$1 and not is_active`, [t.tenantId])).rows[0].n,
    )
    const activeN = Number(active.rows[0].n)
    const anon = <T>(publicTenantId: string | null, fn: (tx: Db) => Promise<T>): Promise<T> =>
      app.transaction(async (tx) => {
        // Deliberately NO app.user_id — this is the public-booking connection.
        if (publicTenantId) await tx.execute(sql`select set_config('app.public_tenant_id', ${publicTenantId}, true)`)
        return fn(tx as unknown as Db)
      })
    const count = (tx: Db, where: string) =>
      tx.execute(sql.raw(`select count(*)::int as n from resource_type_addons where ${where}`)).then((r) => Number((r.rows[0] as { n: number }).n))

    check('P1 fixture: tenant has active and inactive catalog rows', activeN > 0 && inactiveN > 0)
    check('P2 anon sees exactly the ACTIVE add-ons of the public tenant', (await anon(t.tenantId, (tx) => count(tx, 'true'))) === activeN)
    check('P3 anon sees ZERO inactive add-ons', (await anon(t.tenantId, (tx) => count(tx, 'not is_active'))) === 0)
    check('P4 anon pinned to tenant A sees none of tenant B\'s add-ons', (await anon(t.tenantId, (tx) => count(tx, `tenant_id='${studio.tenantId}'`))) === 0)
    check('P5 anon with NO public tenant set sees nothing', (await anon(null, (tx) => count(tx, 'true'))) === 0)

    // Writes: insert is refused by RLS; update/delete touch zero rows.
    let insertCode: string | undefined
    try {
      await anon(t.tenantId, (tx) =>
        tx.execute(sql`insert into resource_type_addons (tenant_id,branch_id,resource_type_id,name,rate,rate_unit,stock_quantity)
                       values (${t.tenantId},${t.branchId},${t.typeId},'Evil','1.00','hour',1)`),
      )
    } catch (e) {
      insertCode = errCode(e)
    }
    check('P6 anon INSERT into the catalog is refused (RLS 42501)', insertCode === '42501')
    const upd = await anon(t.tenantId, (tx) => tx.execute(sql`update resource_type_addons set rate='0.00' where tenant_id=${t.tenantId}`))
    const del = await anon(t.tenantId, (tx) => tx.execute(sql`delete from resource_type_addons where tenant_id=${t.tenantId}`))
    check('P7 anon UPDATE / DELETE affect zero catalog rows', (upd.rowCount ?? 0) === 0 && (del.rowCount ?? 0) === 0)
    const intact = (await q<{ n: string }>(`select count(*)::int as n from resource_type_addons where tenant_id=$1`, [t.tenantId])).rows[0].n
    check('P7b …and the catalog is untouched', Number(intact) === activeN + inactiveN && !(await q(`select 1 from resource_type_addons where rate='0.00' and tenant_id=$1`, [t.tenantId])).rowCount)

    // booking_addons carries other customers' bookings — never public.
    const bookingAddonsTotal = Number((await q<{ n: string }>(`select count(*)::int as n from booking_addons where tenant_id=$1`, [t.tenantId])).rows[0].n)
    const seen = await anon(t.tenantId, (tx) =>
      tx.execute(sql`select count(*)::int as n from booking_addons`).then((r) => Number((r.rows[0] as { n: number }).n)),
    )
    check('P8 anon cannot read booking_addons (rows exist, none visible)', bookingAddonsTotal > 0 && seen === 0)
  }

  for (const t of [gaming, studio]) await q(`delete from tenants where slug=$1`, [t.slug])
  await ownerPool.end()
  await appPool.end()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
