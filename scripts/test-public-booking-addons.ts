/**
 * M35 #4/#5 — add-ons through the real PUBLIC server actions (getPublicBookingQuote,
 * createPublicBooking), running as arena_app: the quote includes add-ons, the
 * pay-now deposit equals the quote equals bookings.total, booking_addons rows
 * are written (online RLS insert policy, 0111), stock is enforced, and invalid
 * add-ons are refused.
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs --import ./scripts/next-runtime-hook.mjs scripts/test-public-booking-addons.ts
 */
import { randomBytes, randomInt } from 'node:crypto'
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

async function main() {
  const { getPublicBookingQuote, createPublicBooking } = await import('../lib/actions/public-booking')
  const owner = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })
  const tag = randomBytes(3).toString('hex')
  const digits = String(randomInt(0, 1_000_000_000)).padStart(9, '0')
  const q = <T extends object>(text: string, params: unknown[] = []) => owner.query<T>(text, params)

  const tenantId = (
    await q<{ id: string }>(
      `insert into tenants (slug,name,status,timezone,industry) values ($1,'Pub Addons QA','active','Asia/Kolkata','recording_studio') returning id`,
      [`pub-addons-qa-${tag}`],
    )
  ).rows[0].id
  const branchId = (await q<{ id: string }>(`insert into branches (tenant_id,name,is_primary,status) values ($1,'Main',true,'active') returning id`, [tenantId])).rows[0].id
  const typeId = (await q<{ id: string }>(`insert into resource_types (tenant_id,name,hourly_rate) values ($1,'Studio Set','500.00') returning id`, [tenantId])).rows[0].id
  const otherTypeId = (await q<{ id: string }>(`insert into resource_types (tenant_id,name,hourly_rate) values ($1,'Booth','100.00') returning id`, [tenantId])).rows[0].id
  const resourceId = (await q<{ id: string }>(`insert into resources (tenant_id,branch_id,resource_type_id,name,status) values ($1,$2,$3,'Set A','available') returning id`, [tenantId, branchId, typeId])).rows[0].id
  const mkAddon = async (name: string, rate: string, unit: string, stock: number, opts: { type?: string; active?: boolean } = {}) =>
    (
      await q<{ id: string }>(
        `insert into resource_type_addons (tenant_id,branch_id,resource_type_id,name,rate,rate_unit,stock_quantity,is_active)
         values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
        [tenantId, branchId, opts.type ?? typeId, name, rate, unit, stock, opts.active ?? true],
      )
    ).rows[0].id
  const camera = await mkAddon('Camera', '300.00', 'hour', 2)
  const lens = await mkAddon('Lens', '150.00', 'day', 5)
  const retired = await mkAddon('Retired', '10.00', 'hour', 5, { active: false })
  const wrongType = await mkAddon('Booth mic', '10.00', 'hour', 5, { type: otherTypeId })
  for (let dow = 0; dow <= 6; dow++) {
    await q(`insert into working_hours (tenant_id,branch_id,day_of_week,open_time,close_time,is_closed) values ($1,$2,$3,'09:00','22:00',false)`, [tenantId, branchId, dow])
  }
  ;(globalThis as { __ARENA_TEST_HEADERS?: Record<string, string> }).__ARENA_TEST_HEADERS = { 'x-tenant-slug': `pub-addons-qa-${tag}` }

  const startsAt = new Date()
  startsAt.setUTCDate(startsAt.getUTCDate() + 3)
  startsAt.setUTCHours(10, 0, 0, 0)
  const endsAt = new Date(startsAt.getTime() + 2 * 3_600_000)
  const win = { resourceId, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() }

  // ── quote ─────────────────────────────────────────────────────────────────
  const base = await getPublicBookingQuote(win)
  check('no add-ons: quote = room only (2h x 500 = 1000)', base.total === 1000 && base.addons?.length === 0, base)
  const withAddons = await getPublicBookingQuote({ ...win, addons: [{ addonId: camera, quantity: 2 }, { addonId: lens, quantity: 1 }] })
  check('quote = room 1000 + camera 2x300x2h 1200 + lens 1x150x1d 150 = 2350', withAddons.total === 2350 && withAddons.slotTotal === 1000, withAddons)
  const lensLine = withAddons.addons?.find((a) => a.name === 'Lens')
  check('daily add-on bills max(1, ceil(h/24)) = 1 unit', lensLine?.units === 1 && lensLine.lineTotal === 150, lensLine)
  for (const [label, id] of [['retired', retired], ['wrong-type', wrongType], ['unknown', '00000000-0000-4000-8000-000000000000']] as const) {
    const r = await getPublicBookingQuote({ ...win, addons: [{ addonId: id, quantity: 1 }] })
    check(`${label} add-on is refused`, /no longer available/i.test(r.error ?? ''), r)
  }

  // ── booking + pay-now deposit ────────────────────────────────────────────
  const created = await createPublicBooking({
    ...win,
    customerName: 'Addon Customer',
    customerPhone: `9${digits}`,
    addons: [{ addonId: camera, quantity: 2 }, { addonId: lens, quantity: 1 }],
    payNow: true,
    website: '',
  })
  check('booking with add-ons created', !created.error && Boolean(created.bookingId), created)
  const bk = created.bookingId
    ? (await q<{ subtotal: string; total: string; deposit: string }>(`select subtotal,total,deposit from bookings where id=$1`, [created.bookingId])).rows[0]
    : undefined
  check('bookings.subtotal = total = deposit = quote (2350.00)', bk?.subtotal === '2350.00' && bk?.total === '2350.00' && bk?.deposit === '2350.00', bk)
  const lines = created.bookingId
    ? (await q<{ addon_name: string; quantity: number; line_total: string }>(`select addon_name, quantity, line_total from booking_addons where booking_id=$1 order by addon_name`, [created.bookingId])).rows
    : []
  check('booking_addons rows written with line totals', lines.length === 2 && lines[0].line_total === '1200.00' && lines[1].line_total === '150.00', lines)

  // ── stock enforced under the lock, as the public role ───────────────────
  const over = await createPublicBooking({
    resourceId,
    startsAt: new Date(startsAt.getTime() + 3_600_000).toISOString(),
    endsAt: new Date(startsAt.getTime() + 4 * 3_600_000).toISOString(),
    customerName: 'Second',
    customerPhone: `8${digits}`,
    addons: [{ addonId: camera, quantity: 1 }],
    website: '',
  })
  check('overlapping booking cannot take cameras that are all held (or the set is taken)', Boolean(over.error), over)
  const free = await createPublicBooking({
    resourceId,
    startsAt: new Date(startsAt.getTime() + 24 * 3_600_000).toISOString(),
    endsAt: new Date(startsAt.getTime() + 26 * 3_600_000).toISOString(),
    customerName: 'Third',
    customerPhone: `7${digits}`,
    addons: [{ addonId: camera, quantity: 3 }],
    website: '',
  })
  check('asking for more than the total stock is refused cleanly', /only|stock/i.test(free.error ?? ''), free)

  // ── a plain booking is unchanged ─────────────────────────────────────────
  const plain = await createPublicBooking({
    resourceId,
    startsAt: new Date(startsAt.getTime() + 48 * 3_600_000).toISOString(),
    endsAt: new Date(startsAt.getTime() + 50 * 3_600_000).toISOString(),
    customerName: 'Plain',
    customerPhone: `6${digits}`,
    website: '',
  })
  const plainRow = plain.bookingId ? (await q<{ total: string }>(`select total from bookings where id=$1`, [plain.bookingId])).rows[0] : undefined
  check('booking without add-ons still totals the room only', plainRow?.total === '1000.00', plainRow)

  await q('delete from tenants where id = $1', [tenantId])
  await owner.end()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
