/**
 * M24 #7 — studio setups for WALK-INS (lib/booking/walkin.ts): a walk-in on a
 * studio-industry tenant may start on a named per-hour setup and bills at that
 * setup's flat hourly rate.
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs \
 *           --import ./scripts/next-runtime-hook.mjs \
 *           scripts/test-walkin-setups.ts
 *
 * Covers:
 *   - start on a per-hour setup snapshots setup_id/setup_name/rate_applied and
 *     checkout bills elapsed × the setup rate
 *   - a setup prices INSTEAD OF happy hour, holiday and weekend rates (an
 *     all-day 50% rule, a holiday row and a weekend config are all ignored)
 *   - a per-day setup, another station's setup, an inactive setup, another
 *     tenant's setup and a setup on a NON-studio tenant are all refused
 *   - a setup on a per_head station is flat (no Players needed, no multiplier)
 *   - a timed setup session extended then checked out bills the whole window
 *   - a base-rate walk-in on the same station is unchanged (happy hour applies)
 *   - the setup survives deleting the setup row (name snapshot keeps it flat)
 *   - listWalkinResources offers only ACTIVE PER-HOUR setups, and only for
 *     studio tenants
 *   - the bill reconciles (one line at the setup total)
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
const TZ = 'Asia/Kolkata'

async function main() {
  const { startWalkinCore, extendWalkinCore, previewWalkinCheckout, checkoutWalkinCore, listWalkinResources } =
    await import('../lib/booking/walkin')
  const { loadBookingLines } = await import('../lib/billing/invoice')
  const { priceBill, round2 } = await import('../lib/billing/pricing')
  const { todayInZone, weekdayInZone } = await import('../lib/booking/time')
  const { getActiveContext } = await import('../lib/tenant/context')
  const { withUser } = await import('../db')

  const owner = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })
  const tag = randomBytes(3).toString('hex')
  const g = globalThis as { __ARENA_TEST_SESSION?: string; __ARENA_TEST_HEADERS?: Record<string, string> }

  async function makeTenant(slugBase: string, industry: string) {
    const slug = `${slugBase}${tag}`
    const tenantId = (
      await owner.query<{ id: string }>(
        `insert into tenants (slug,name,status,timezone,industry) values ($1,$2,'active',$3,$4) returning id`,
        [slug, `${slugBase} co`, TZ, industry],
      )
    ).rows[0].id
    const branchId = (
      await owner.query<{ id: string }>(`insert into branches (tenant_id,name,is_primary) values ($1,'Main',true) returning id`, [tenantId])
    ).rows[0].id
    const userId = (
      await owner.query<{ id: string }>(`insert into users (email,password_hash,full_name) values ($1,'x','Owner') returning id`, [
        `${slugBase}-${tag}@example.test`,
      ])
    ).rows[0].id
    const token = randomBytes(32).toString('hex')
    await owner.query(`insert into sessions (id, user_id, expires_at) values ($1,$2, now() + interval '1 day')`, [
      createHash('sha256').update(token).digest('hex'),
      userId,
    ])
    const membershipId = (
      await owner.query<{ id: string }>(
        `insert into memberships (tenant_id,user_id,branch_id,role,status,full_name) values ($1,$2,$3,'owner','active','Owner') returning id`,
        [tenantId, userId, branchId],
      )
    ).rows[0].id
    return { slug, tenantId, branchId, userId, token, ctx: { tenantId, timezone: TZ, membershipId } }
  }
  const studio = await makeTenant('wsetstudio', 'recording_studio')
  const cafe = await makeTenant('wsetcafe', 'gaming_cafe')

  const mk = async (t: typeof studio, typeName: string, cols: string, vals: unknown[]) => {
    const typeId = (
      await owner.query<{ id: string }>(
        `insert into resource_types (tenant_id,name,${cols}) values ($1,$2,${vals.map((_, i) => `$${i + 3}`).join(',')}) returning id`,
        [t.tenantId, typeName, ...vals],
      )
    ).rows[0].id
    return typeId
  }
  let n = 0
  const unit = async (t: typeof studio, typeId: string) =>
    (
      await owner.query<{ id: string }>(
        `insert into resources (tenant_id,branch_id,resource_type_id,name,status) values ($1,$2,$3,$4,'available') returning id`,
        [t.tenantId, t.branchId, typeId, `R-${++n}`],
      )
    ).rows[0].id
  const addSetup = async (t: typeof studio, resourceId: string, name: string, rate: string, unitKind = 'hour', active = true) =>
    (
      await owner.query<{ id: string }>(
        `insert into resource_setups (tenant_id,resource_id,name,rate,rate_unit,is_active) values ($1,$2,$3,$4,$5,$6) returning id`,
        [t.tenantId, resourceId, name, rate, unitKind, active],
      )
    ).rows[0].id

  // Studio station: base ₹200/hr (weekend ₹300).
  const studioType = await mk(studio, 'Set A', 'hourly_rate,weekend_rate', ['200.00', '300.00'])
  const headType = await mk(studio, 'Booth', 'hourly_rate,pricing_mode,min_players', ['80.00', 'per_head', 2])

  const today = todayInZone(TZ)
  const dow = weekdayInZone(today, TZ)
  // Today is a WEEKEND day and a HOLIDAY, with an all-day 50% happy hour — a
  // setup must ignore all three.
  await owner.query(
    `insert into business_profiles (tenant_id, weekend_days) values ($1, $2::smallint[])
     on conflict (tenant_id) do update set weekend_days = excluded.weekend_days`,
    [studio.tenantId, `{${dow}}`],
  )
  await owner.query(`insert into holiday_rates (tenant_id,resource_type_id,date,rate) values ($1,$2,$3,'900.00')`, [
    studio.tenantId,
    studioType,
    today,
  ])
  await owner.query(
    `insert into happy_hours (tenant_id,name,days_of_week,start_time,end_time,discount_type,discount_value,is_active)
     values ($1,'All-day 50% off','{0,1,2,3,4,5,6}','00:00','23:59','percentage',50,true)`,
    [studio.tenantId],
  )

  let phone = 9876501000
  async function start(t: typeof studio, resourceId: string, opts: { setupId?: string; headCount?: number; mode?: 'open_tab' | 'timed' } = {}) {
    const b = await withUser(t.userId, (tx) =>
      startWalkinCore(tx, t.ctx, {
        branchId: t.branchId,
        resourceId,
        phone: String(phone++),
        startAt: new Date().toISOString(),
        mode: opts.mode ?? 'open_tab',
        durationMin: opts.mode === 'timed' ? 60 : undefined,
        headCount: opts.headCount,
        setupId: opts.setupId,
      }),
    )
    if ((opts.mode ?? 'open_tab') === 'open_tab') {
      await owner.query(`update booking_slots set starts_at = now() - interval '10 minutes' where booking_id = $1`, [b.id])
    }
    return b.id
  }
  const slotOf = async (id: string) =>
    (
      await owner.query(
        `select rate_applied, slot_total, setup_id, setup_name, rate_unit, holiday_rate_applied as hol, head_count, pricing_mode
           from booking_slots where booking_id = $1`,
        [id],
      )
    ).rows[0]
  async function refused(fn: () => Promise<unknown>) {
    try {
      await fn()
      return null
    } catch (e) {
      return (e as Error).message
    }
  }
  const checkout = (t: typeof studio, id: string, headCount?: number) =>
    withUser(t.userId, (tx) => checkoutWalkinCore(tx, t.ctx, { bookingId: id, headCount }))

  // ══ 1. a per-hour setup bills flat, ignoring weekend / holiday / happy hour ═
  console.log('\n── walk-in on a per-hour setup ──')
  const r1 = await unit(studio, studioType)
  const kitchen = await addSetup(studio, r1, 'Kitchen', '500.00')
  {
    const id = await start(studio, r1, { setupId: kitchen })
    const s = await slotOf(id)
    check('snapshot: setup_id, setup_name "Kitchen", rate_applied 500.00, hourly', s.setup_id === kitchen && s.setup_name === 'Kitchen' && s.rate_applied === '500.00' && s.rate_unit === 'hour', s)
    check('holiday flag false (today has a ₹900 holiday row that must be ignored)', s.hol === false, s)
    const p = await withUser(studio.userId, (tx) => previewWalkinCheckout(tx, studio.ctx, { bookingId: id }))
    check('preview: 0.5h × 500 = 250.00 — not the weekend 300, holiday 900 or 50%-off', p.total === 250, p)
    const closed = await checkout(studio, id)
    check('checkout: 250.00 (matches the preview)', closed.total === 250, closed)
    check('slot_total 250.00', (await slotOf(id)).slot_total === '250.00')
    const lines = await withUser(studio.userId, (tx) => loadBookingLines(tx, studio.tenantId, id, TZ))
    const bill = priceBill({ lines, discount: 25 })
    check('bill: one line of 250.00, reconciles to the paise', lines.length === 1 && bill.subtotal === 250 && round2(bill.subtotal - bill.discount + bill.taxTotal) === bill.total, bill)
  }

  // ══ 2. base-rate walk-in on the same station is unchanged ════════════════
  console.log('\n── base-rate walk-in unchanged ──')
  {
    const id = await start(studio, await unit(studio, studioType))
    const s = await slotOf(id)
    check('no setup snapshot', s.setup_id === null && s.setup_name === null, s)
    // holiday 900 × 0.5h = 450, flat (holiday beats the happy hour)
    check('bills the holiday rate flat: 0.5h × 900 = 450.00', (await checkout(studio, id)).total === 450)
  }

  // ══ 3. refusals ══════════════════════════════════════════════════════════
  console.log('\n── refusals ──')
  {
    const r = await unit(studio, studioType)
    const daySetup = await addSetup(studio, r, 'Whole day', '3000.00', 'day')
    const msg = await refused(() => start(studio, r, { setupId: daySetup }))
    check('a per-day setup is refused with a clear message', /per-day setup/i.test(msg ?? ''), msg)
    const other = await unit(studio, studioType)
    const msg2 = await refused(() => start(studio, other, { setupId: kitchen }))
    check("another station's setup is refused", /no longer available/i.test(msg2 ?? ''), msg2)
    const inactive = await addSetup(studio, r, 'Retired', '100.00', 'hour', false)
    const msg3 = await refused(() => start(studio, r, { setupId: inactive }))
    check('an inactive setup is refused', /no longer available/i.test(msg3 ?? ''), msg3)
    const msg4 = await refused(() => start(studio, r, { setupId: '00000000-0000-0000-0000-000000000000' }))
    check('an unknown setup id is refused', /no longer available/i.test(msg4 ?? ''), msg4)
    const { rows } = await owner.query(`select 1 from bookings where tenant_id = $1 and channel = 'walkin'`, [studio.tenantId])
    check('…and none of the refusals left a booking behind (only the 2 earlier walk-ins exist)', rows.length === 2, rows.length)
  }
  {
    // Another tenant's setup id, and any setup on a NON-studio tenant.
    const cafeType = await mk(cafe, 'PS5', 'hourly_rate', ['100.00'])
    const cafeRes = await unit(cafe, cafeType)
    const cafeSetup = await addSetup(cafe, cafeRes, 'Sneaky', '50.00')
    const msg = await refused(() => start(cafe, cafeRes, { setupId: cafeSetup }))
    check('a non-studio tenant (gaming_cafe) cannot use a setup', /studio businesses/i.test(msg ?? ''), msg)
    const cross = await refused(() => start(studio, r1, { setupId: cafeSetup }))
    check("another tenant's setup id is refused", /no longer available/i.test(cross ?? ''), cross)
    const plain = await start(cafe, cafeRes)
    check('a plain gaming_cafe walk-in is unaffected', (await slotOf(plain)).setup_id === null)
  }

  // ══ 4. per_head station + setup is flat ══════════════════════════════════
  console.log('\n── per_head station on a setup ──')
  {
    const r = await unit(studio, headType)
    const su = await addSetup(studio, r, 'Podcast pack', '400.00')
    const noHeads = await refused(() => start(studio, r))
    check('without a setup a per_head station still needs a player count', /priced per player/i.test(noHeads ?? ''), noHeads)
    const id = await start(studio, r, { setupId: su })
    const s = await slotOf(id)
    check('with a setup: no player count needed, stored flat (per_resource, no head_count)', s.head_count === null && s.pricing_mode === 'per_resource', s)
    check('bills 0.5h × 400 = 200.00 — no per-head multiplier', (await checkout(studio, id)).total === 200)
  }

  // ══ 5. timed setup session, extended ═════════════════════════════════════
  console.log('\n── timed setup walk-in, extended ──')
  {
    const r = await unit(studio, studioType)
    const su = await addSetup(studio, r, 'Royal', '600.00')
    const id = await start(studio, r, { setupId: su, mode: 'timed' })
    await withUser(studio.userId, (tx) => extendWalkinCore(tx, { tenantId: studio.tenantId }, { bookingId: id, addMinutes: 30 }))
    const closed = await checkout(studio, id)
    check('60 min + 30 extended = 1.5h × 600 = 900.00, not discounted by the happy hour', closed.total === 900, closed)
  }

  // ══ 6. survives deleting the setup ═══════════════════════════════════════
  console.log('\n── deleting the setup row later ──')
  {
    const r = await unit(studio, studioType)
    const su = await addSetup(studio, r, 'Temp', '700.00')
    const id = await start(studio, r, { setupId: su })
    await owner.query(`delete from resource_setups where id = $1`, [su])
    const s = await slotOf(id)
    check('setup_id is nulled by the FK, the name snapshot remains', s.setup_id === null && s.setup_name === 'Temp', s)
    check('checkout is still flat at the snapshotted 700: 0.5h × 700 = 350.00 (no happy hour)', (await checkout(studio, id)).total === 350)
  }

  // ══ 7. what the wizard is offered ════════════════════════════════════════
  console.log('\n── listWalkinResources offers only active per-hour setups, studio only ──')
  {
    g.__ARENA_TEST_SESSION = studio.token
    g.__ARENA_TEST_HEADERS = { 'x-tenant-slug': studio.slug }
    const ctx = await getActiveContext()
    if (!ctx) throw new Error('expected a studio context')
    const r = await unit(studio, studioType)
    await addSetup(studio, r, 'Hourly A', '111.00')
    await addSetup(studio, r, 'Daily', '999.00', 'day')
    await addSetup(studio, r, 'Retired2', '222.00', 'hour', false)
    const list = await listWalkinResources(ctx, studio.branchId)
    const row = list.find((x) => x.id === r)
    check('only the active per-hour setup is offered', row?.setups.length === 1 && row.setups[0].name === 'Hourly A' && row.setups[0].rate === '111.00', row?.setups)
    g.__ARENA_TEST_SESSION = cafe.token
    g.__ARENA_TEST_HEADERS = { 'x-tenant-slug': cafe.slug }
    const cctx = await getActiveContext()
    if (!cctx) throw new Error('expected a cafe context')
    const cl = await listWalkinResources(cctx, cafe.branchId)
    check('a gaming_cafe tenant is offered none (even with a setup row present)', cl.length > 0 && cl.every((x) => x.setups.length === 0), cl.map((x) => x.setups))
  }

  for (const t of [studio, cafe]) {
    await owner.query('delete from tenants where id = $1', [t.tenantId])
    await owner.query('delete from users where id = $1', [t.userId])
  }
  await owner.end()

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
