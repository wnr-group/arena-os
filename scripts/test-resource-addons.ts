/**
 * M33 — resource add-ons, end to end against a real database (needs
 * migration 0108 + 0109 applied):
 *
 *   rls      a non-manager (cashier/receptionist/floor_staff) can lock the
 *            catalog FOR UPDATE to attach/edit add-ons, but cannot write the
 *            catalog directly — 0109's WITH CHECK stays manager-only, so RLS
 *            backstops requireManager() rather than deferring to it alone
 *   schema   booking_addons.addon_id is ON DELETE SET NULL (deleting a catalog
 *            entry keeps the booking line); the public-SELECT policy exists
 *            and shows only active rows of the public tenant
 *   booking  an add-on prices at creation (hourly + daily), folds into
 *            bookings.subtotal/total, and bills as an 'addon' invoice line
 *   stock    pooled per branch over overlapping windows; a CANCELLED booking
 *            releases its units; a non-overlapping window is unaffected
 *   guards   foreign / inactive / wrong-type / wrong-branch add-ons refused
 *   snapshot a catalog price edit never reprices a live booking
 *   edit     add / change / remove on an unbilled booking; refused once billed
 *   walk-in  stock held from start; extend + end-time correction keep
 *            booking_addons.ends_at in lockstep with booking_slots.ends_at;
 *            checkout prices the line over the same window as the room
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs --import ./scripts/next-runtime-hook.mjs scripts/test-resource-addons.ts
 */
import { Pool } from 'pg'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { sql } from 'drizzle-orm'
import * as schema from '../db/schema'
import { createBookingCore, BookingError } from '../lib/booking/service'
import { startWalkinCore, extendWalkinCore, correctWalkinEndTimeCore, checkoutWalkinCore } from '../lib/booking/walkin'
import { setSlotAddonsCore } from '../lib/booking/addons'
import { loadBillLines } from '../lib/billing/invoice'
import { loadEnv } from './env'

type Db = NodePgDatabase<typeof schema>

let pass = 0,
  fail = 0
const check = (l: string, c: boolean) => {
  console.log(`${c ? '✓' : '✗ FAIL'}  ${l}`)
  if (c) pass++
  else fail++
}
async function expectReject(l: string, fn: () => Promise<unknown>, includes?: string) {
  try {
    await fn()
    check(l, false)
  } catch (e) {
    const ok = e instanceof BookingError && (!includes || e.message.includes(includes))
    check(l, ok)
    if (!ok) console.log('   (unexpected)', e)
  }
}

const TZ = 'Asia/Kolkata'
const HOUR = 3_600_000
/** A whole-hour start safely in the future, `days` days out. */
const future = (days: number, hour: number) => {
  const d = new Date(Date.now() + days * 24 * HOUR)
  d.setUTCMinutes(0, 0, 0)
  d.setUTCHours(hour)
  return d
}

async function main() {
  loadEnv()
  const ownerPool = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })
  const appPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 })
  const app = drizzle(appPool, { schema })
  async function withUser<T>(userId: string, fn: (tx: Db) => Promise<T>): Promise<T> {
    return app.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`)
      return fn(tx as unknown as Db)
    })
  }

  const slug = 'testresourceaddons'
  const q = <T extends object>(text: string, params: unknown[] = []) => ownerPool.query<T>(text, params)
  // Clean any previous run first so the test is re-runnable.
  await q(`delete from tenants where slug in ($1, $2)`, [slug, `${slug}x`])

  const tenantId = (
    await q<{ id: string }>(
      `insert into tenants (slug,name,status,timezone,industry) values ($1,$2,'active',$3,'gaming_cafe') returning id`,
      [slug, `${slug} co`, TZ],
    )
  ).rows[0].id
  const branchId = (
    await q<{ id: string }>(`insert into branches (tenant_id,name,is_primary) values ($1,'Main',true) returning id`, [tenantId])
  ).rows[0].id
  const otherBranchId = (
    await q<{ id: string }>(`insert into branches (tenant_id,name,is_primary) values ($1,'Second',false) returning id`, [tenantId])
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
    await q<{ id: string }>(`insert into resource_types (tenant_id,name,hourly_rate) values ($1,'Studio','100.00') returning id`, [tenantId])
  ).rows[0].id
  const otherTypeId = (
    await q<{ id: string }>(`insert into resource_types (tenant_id,name,hourly_rate) values ($1,'Booth','100.00') returning id`, [tenantId])
  ).rows[0].id
  const mkResource = async (name: string, type = typeId) =>
    (
      await q<{ id: string }>(
        `insert into resources (tenant_id,branch_id,resource_type_id,name,status) values ($1,$2,$3,$4,'available') returning id`,
        [tenantId, branchId, type, name],
      )
    ).rows[0].id
  const r1 = await mkResource('Set A')
  const r2 = await mkResource('Set B')
  const r3 = await mkResource('Set C')

  const mkAddon = async (name: string, rate: string, unit: 'hour' | 'day', stock: number, opts: { type?: string; branch?: string; active?: boolean } = {}) =>
    (
      await q<{ id: string }>(
        `insert into resource_type_addons (tenant_id,branch_id,resource_type_id,name,rate,rate_unit,stock_quantity,is_active)
         values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
        [tenantId, opts.branch ?? branchId, opts.type ?? typeId, name, rate, unit, stock, opts.active ?? true],
      )
    ).rows[0].id
  const camera = await mkAddon('Camera', '100.00', 'hour', 2)
  const lens = await mkAddon('Lens', '500.00', 'day', 1)
  const retired = await mkAddon('Retired', '10.00', 'hour', 5, { active: false })
  const wrongType = await mkAddon('Booth mic', '10.00', 'hour', 5, { type: otherTypeId })
  const wrongBranch = await mkAddon('Elsewhere tripod', '10.00', 'hour', 5, { branch: otherBranchId })

  const ctx = { tenantId, timezone: TZ, membershipId }
  const iso = (d: Date) => d.toISOString()
  const book = (resourceId: string, start: Date, hours: number, addons: { addonId: string; quantity: number }[]) =>
    withUser(userId, (tx) =>
      createBookingCore(tx, ctx, {
        branchId,
        customerName: 'T',
        customerPhone: '9876543210',
        source: 'staff',
        discount: 0,
        deposit: 0,
        slots: [{ resourceId, startsAt: iso(start), endsAt: iso(new Date(start.getTime() + hours * HOUR)), addons }],
      }),
    )
  const bookingRow = async (id: string) =>
    (await q<{ subtotal: string; total: string }>(`select subtotal,total from bookings where id=$1`, [id])).rows[0]

  // ── schema ────────────────────────────────────────────────────────────────
  const fk = await q<{ confdeltype: string }>(
    `select confdeltype from pg_constraint where conrelid='public.booking_addons'::regclass and contype='f'
       and confrelid='public.resource_type_addons'::regclass`,
  )
  check('S1 booking_addons.addon_id FK is ON DELETE SET NULL', fk.rows.length === 1 && fk.rows[0].confdeltype === 'n')
  const pol = await q<{ policyname: string }>(
    `select policyname from pg_policies where tablename='resource_type_addons'`,
  )
  const names = pol.rows.map((r) => r.policyname)
  check(
    'S2 staff select + write + public select policies all shipped',
    ['resource_type_addons_select', 'resource_type_addons_write', 'resource_type_addons_lock', 'resource_type_addons_public_select'].every((n) => names.includes(n)),
  )
  const kindCheck = await q<{ def: string }>(
    `select pg_get_constraintdef(oid) as def from pg_constraint where conname='invoice_items_kind_check'`,
  )
  check("S3 invoice_items.kind allows 'addon'", kindCheck.rows[0]?.def.includes("'addon'") === true)

  const pub = await withUser(userId, async (tx) => {
    await tx.execute(sql`select set_config('app.public_tenant_id', ${tenantId}, true)`)
    await tx.execute(sql`set local role arena_app`)
    return (await tx.execute(sql`select count(*)::int as n from resource_type_addons where is_active`)).rows[0] as { n: number }
  }).catch(() => null)
  if (pub) check('S4 public session reads active catalog rows (not zero)', Number(pub.n) > 0)

  // ── creation + pricing ────────────────────────────────────────────────────
  const t0 = future(3, 4) // 09:30 IST-ish; exact wall time is irrelevant
  const b1 = await book(r1, t0, 3, [{ addonId: camera, quantity: 2 }])
  const row1 = await bookingRow(b1.id)
  check('B1 room 3h×100=300 + camera 2×100×3=600 → subtotal 900.00', row1.subtotal === '900.00' && row1.total === '900.00')
  const lines1 = await withUser(userId, (tx) => loadBillLines(tx, tenantId, b1.id, TZ))
  const addonLine = lines1.find((l) => l.kind === 'addon')
  check("B2 bills as a kind='addon' line of 600.00", addonLine?.unitPrice === 600 && addonLine.qty === 1)

  // stock: camera has 2, both held over [t0, t0+3h)
  await expectReject('K1 third camera over the same window refused', () => book(r2, t0, 2, [{ addonId: camera, quantity: 1 }]), 'out of stock')
  const after = new Date(t0.getTime() + 3 * HOUR)
  const bAfter = await book(r2, after, 1, [{ addonId: camera, quantity: 2 }])
  check('K2 a non-overlapping window is unaffected', Boolean(bAfter.id))

  // cancelled booking releases its stock
  await withUser(userId, (tx) => tx.execute(sql`update bookings set status='cancelled' where id=${b1.id}`))
  const bAgain = await book(r3, t0, 2, [{ addonId: camera, quantity: 2 }])
  check('K3 cancelling a booking frees its add-on units', Boolean(bAgain.id))

  // daily rate: lens 500/day, 5h booking = 1 block even across midnight
  const bLens = await book(r1, future(10, 20), 5, [{ addonId: lens, quantity: 1 }])
  check('D1 5h booking of a daily add-on bills 1 day-block (500.00)', (await bookingRow(bLens.id)).subtotal === '1000.00') // 500 room + 500 lens
  await expectReject('K4 only 1 lens: a second over the same window is refused', () => book(r2, future(10, 20), 2, [{ addonId: lens, quantity: 1 }]))

  // ── guards ────────────────────────────────────────────────────────────────
  const tG = future(20, 4)
  await expectReject('G1 inactive add-on refused', () => book(r1, tG, 1, [{ addonId: retired, quantity: 1 }]), 'no longer available')
  await expectReject('G2 add-on of another resource type refused', () => book(r1, tG, 1, [{ addonId: wrongType, quantity: 1 }]), 'no longer available')
  await expectReject('G3 add-on of another branch refused', () => book(r1, tG, 1, [{ addonId: wrongBranch, quantity: 1 }]), 'no longer available')
  await expectReject('G4 quantity 0 refused', () => book(r1, tG, 1, [{ addonId: camera, quantity: 0 }]), 'quantity')
  await expectReject('G5 a refused add-on rolls the whole booking back', async () => {
    const before = (await q<{ n: string }>(`select count(*) as n from bookings where tenant_id=$1`, [tenantId])).rows[0].n
    try {
      await book(r1, tG, 1, [{ addonId: retired, quantity: 1 }])
    } finally {
      const afterN = (await q<{ n: string }>(`select count(*) as n from bookings where tenant_id=$1`, [tenantId])).rows[0].n
      check('G5b …and left no orphan booking behind', before === afterN)
    }
  })

  // ── snapshot + catalog delete ─────────────────────────────────────────────
  const tS = future(30, 4)
  const bSnap = await book(r1, tS, 2, [{ addonId: camera, quantity: 1 }])
  await q(`update resource_type_addons set rate='999.00', name='Renamed' where id=$1`, [camera])
  const snap = (await q<{ addon_name: string; rate_applied: string; line_total: string }>(
    `select addon_name,rate_applied,line_total from booking_addons where booking_id=$1`,
    [bSnap.id],
  )).rows[0]
  check('P1 catalog edit leaves the booking snapshot (name/rate/total) untouched', snap.addon_name === 'Camera' && snap.rate_applied === '100.00' && snap.line_total === '200.00')
  await q(`update resource_type_addons set rate='100.00', name='Camera' where id=$1`, [camera])

  const tmp = await mkAddon('Temp', '10.00', 'hour', 1)
  const bTmp = await book(r2, future(40, 4), 1, [{ addonId: tmp, quantity: 1 }])
  await q(`delete from resource_type_addons where id=$1`, [tmp])
  const kept = (await q<{ addon_id: string | null; addon_name: string }>(`select addon_id,addon_name from booking_addons where booking_id=$1`, [bTmp.id])).rows
  check('P2 deleting a catalog entry keeps the booking line (addon_id NULL, name kept)', kept.length === 1 && kept[0].addon_id === null && kept[0].addon_name === 'Temp')

  // ── edit tool ─────────────────────────────────────────────────────────────
  const tE = future(50, 4)
  const bEdit = await book(r1, tE, 2, [])
  const slotId = (await q<{ id: string }>(`select id from booking_slots where booking_id=$1`, [bEdit.id])).rows[0].id
  const edit = (addons: { addonId: string; quantity: number }[]) =>
    withUser(userId, (tx) => setSlotAddonsCore(tx, { tenantId, membershipId }, { bookingId: bEdit.id, bookingSlotId: slotId, addons }))
  await edit([{ addonId: camera, quantity: 1 }])
  check('E1 add on an unbilled booking → subtotal 200 room + 200 camera', (await bookingRow(bEdit.id)).subtotal === '400.00')
  await edit([{ addonId: camera, quantity: 2 }])
  check('E2 change qty → camera 2×100×2=400 → subtotal 600', (await bookingRow(bEdit.id)).subtotal === '600.00')
  await edit([])
  check('E3 remove → back to the room only (200)', (await bookingRow(bEdit.id)).subtotal === '200.00')
  await expectReject('E4 edit refused past stock', () => edit([{ addonId: camera, quantity: 3 }]), 'left')
  await withUser(userId, (tx) => tx.execute(sql`update bookings set status='cancelled' where id=${bEdit.id}`))
  await expectReject('E5 edit refused on a cancelled booking', () => edit([{ addonId: camera, quantity: 1 }]), 'still open')

  // ── non-manager roles: the FOR UPDATE catalog lock must work under RLS ────
  const staffRoles = ['cashier', 'receptionist', 'floor_staff']
  for (const [i, role] of staffRoles.entries()) {
    const uid = (
      await q<{ id: string }>(
        `insert into users (email,password_hash) values ($1,'x') on conflict (email) do update set email=excluded.email returning id`,
        [`${role}@${slug}.test`],
      )
    ).rows[0].id
    const mid = (
      await q<{ id: string }>(
        `insert into memberships (tenant_id,user_id,role,status) values ($1,$2,$3,'active') returning id`,
        [tenantId, uid, role],
      )
    ).rows[0].id
    const tR = future(60 + i, 4)
    let bId: string | null = null
    try {
      const b = await withUser(uid, (tx) =>
        createBookingCore(tx, { tenantId, timezone: TZ, membershipId: mid }, {
          branchId,
          customerName: 'T',
          customerPhone: '9876543210',
          source: 'staff',
          discount: 0,
          deposit: 0,
          slots: [{ resourceId: r1, startsAt: iso(tR), endsAt: iso(new Date(tR.getTime() + 2 * HOUR)), addons: [{ addonId: camera, quantity: 1 }] }],
        }),
      )
      bId = b.id
      check(`R1 ${role} can attach an add-on at booking creation`, (await bookingRow(b.id)).subtotal === '400.00')
      const sId = (await q<{ id: string }>(`select id from booking_slots where booking_id=$1`, [b.id])).rows[0].id
      await withUser(uid, (tx) =>
        setSlotAddonsCore(tx, { tenantId, membershipId: mid }, { bookingId: b.id, bookingSlotId: sId, addons: [{ addonId: camera, quantity: 2 }] }),
      )
      check(`R2 ${role} can edit add-ons via the correction tool`, (await bookingRow(b.id)).subtotal === '600.00')
    } catch (e) {
      console.log('   (unexpected)', e)
      check(`R1/R2 ${role} add-on attach/edit`, false)
    }
    if (bId) await withUser(uid, (tx) => tx.execute(sql`update bookings set status='cancelled' where id=${bId}`))

    // The lock widening above must NOT also widen real catalog writes: USING
    // is broad (any tenant member can lock) but WITH CHECK stays manager-only,
    // so a non-manager's raw UPDATE on the catalog itself is refused by RLS —
    // requireManager() in lib/actions/addons.ts is not the only thing standing
    // between a cashier and the catalog's rate/stock.
    try {
      await withUser(uid, (tx) => tx.execute(sql`update resource_type_addons set rate = '9999.00' where id = ${camera}`))
      check(`R3 ${role} cannot write the catalog directly (RLS, not just the app gate)`, false)
    } catch (e) {
      // Drizzle wraps the raw pg error as DrizzleQueryError.cause — the RLS
      // violation code (42501) lives there, not on the thrown error itself.
      const pgCode = (e as { cause?: { code?: string } })?.cause?.code
      check(`R3 ${role} cannot write the catalog directly (RLS, not just the app gate)`, pgCode === '42501')
      if (pgCode !== '42501') console.log('   (unexpected)', e)
    }
    const stillOriginal = await q<{ rate: string }>(`select rate from resource_type_addons where id=$1`, [camera])
    check(`R4 ${role}'s blocked write left the catalog rate untouched`, stillOriginal.rows[0].rate === '100.00')
  }

  // ── walk-in: hold, ends_at lockstep, checkout pricing ─────────────────────
  const wr = await mkResource('Walk Set')
  const startAt = new Date()
  const w = await withUser(userId, (tx) =>
    startWalkinCore(tx, ctx, {
      branchId,
      resourceId: wr,
      phone: '9876543211',
      startAt: iso(startAt),
      mode: 'timed',
      durationMin: 60,
      addons: [{ addonId: camera, quantity: 2 }],
    }),
  )
  const walkAddon = async () =>
    (await q<{ ends_at: Date | null; line_total: string }>(`select ends_at,line_total from booking_addons where booking_id=$1`, [w.id])).rows[0]
  const walkSlotEnd = async () => (await q<{ ends_at: Date }>(`select ends_at from booking_slots where booking_id=$1`, [w.id])).rows[0].ends_at
  check('W1 walk-in add-on is unpriced (0.00) until checkout', (await walkAddon()).line_total === '0.00')
  await expectReject('W2 walk-in holds stock: an overlapping booking is refused', () => book(r2, startAt, 1, [{ addonId: camera, quantity: 1 }]), 'out of stock')

  await withUser(userId, (tx) => extendWalkinCore(tx, { tenantId }, { bookingId: w.id, addMinutes: 30 }))
  check('W3 extend: add-on ends_at moves with the slot', +(await walkAddon()).ends_at! === +(await walkSlotEnd()))
  const corrected = new Date(startAt.getTime() + 2 * HOUR)
  await withUser(userId, (tx) => correctWalkinEndTimeCore(tx, ctx, { bookingId: w.id, newEndAt: iso(corrected) }))
  check('W4 end-time correction: add-on ends_at moves with the slot', +(await walkAddon()).ends_at! === +corrected && +(await walkSlotEnd()) === +corrected)
  check('W5 …and still no repricing (extend/correct are not pricing events)', (await walkAddon()).line_total === '0.00')

  await withUser(userId, (tx) => checkoutWalkinCore(tx, ctx, { bookingId: w.id }))
  const done = await walkAddon()
  check('W6 checkout prices the add-on over the slot window (2×100×2h = 400)', done.line_total === '400.00')
  check('W7 …and its ends_at still equals the slot ends_at', +done.ends_at! === +(await walkSlotEnd()))

  // ── cleanup ───────────────────────────────────────────────────────────────
  await q(`delete from tenants where id=$1`, [tenantId])
  await q(`delete from users where email = any($1)`, [['owner', 'cashier', 'receptionist', 'floor_staff'].map((r) => `${r}@${slug}.test`)])
  await ownerPool.end()
  await appPool.end()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
