/**
 * Request-triggered walk-in auto-close (lib/booking/walkin-auto-close.ts
 * sweepOverdueWalkinsForTenant, called from listActiveWalkins). No scheduler:
 * an overdue open-tab is closed by the next read of the live walk-in list.
 *
 * Proves:
 *   - an overdue open-tab is closed on read, billed to its DEADLINE (not "now")
 *   - a tab still inside its limit stays open
 *   - a cancelled booking and a timed walk-in are left alone
 *   - a venue with the rule off is left alone
 *   - one tenant's request never closes another tenant's tab
 *   - the sweep is throttled per tenant, and the throttle can be reset
 *   - concurrent sweeps close a booking once and write one audit row
 *   - the alarm poll's response shape is unchanged
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs --import ./scripts/next-runtime-hook.mjs scripts/test-walkin-auto-close-request.ts
 */
import { createHash, randomBytes } from 'node:crypto'
import { Pool } from 'pg'
import { loadEnv } from './env'

let pass = 0,
  fail = 0
const check = (l: string, c: boolean) => {
  console.log(`${c ? '✓' : '✗ FAIL'}  ${l}`)
  if (c) pass++
  else fail++
}

async function main() {
  loadEnv()
  const { startWalkin, listActiveWalkinsForAlarm } = await import('../lib/actions/bookings')
  const { autoCloseOverdueWalkins, resetWalkinSweepThrottle } = await import('../lib/booking/walkin-auto-close')
  const owner = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })
  const MIN = 60_000

  async function setup(slug: string, limit: number | null) {
    const t = await owner.query<{ id: string }>(
      `insert into tenants (slug,name,status,timezone,industry) values ($1,$2,'active','Asia/Kolkata','gaming_cafe')
       on conflict (slug) do update set name=excluded.name, industry='gaming_cafe' returning id`,
      [slug, `${slug} co`],
    )
    const tenantId = t.rows[0].id
    const b = await owner.query<{ id: string }>(
      `insert into branches (tenant_id,name,is_primary) values ($1,'Main',true)
       on conflict (tenant_id,name) do update set is_primary=true returning id`,
      [tenantId],
    )
    const u = await owner.query<{ id: string }>(
      `insert into users (email,password_hash) values ($1,'x') on conflict (email) do update set email=excluded.email returning id`,
      [`owner@${slug}.test`],
    )
    await owner.query(
      `insert into memberships (tenant_id,user_id,role,status) values ($1,$2,'owner','active')
       on conflict (tenant_id,user_id) do update set role='owner', status='active'`,
      [tenantId, u.rows[0].id],
    )
    await owner.query(
      `insert into booking_settings (tenant_id, walkin_auto_close_minutes) values ($1,$2)
       on conflict (tenant_id) do update set walkin_auto_close_minutes = excluded.walkin_auto_close_minutes, walkin_auto_close_at_closing = false`,
      [tenantId, limit],
    )
    const rt = await owner.query<{ id: string }>(
      `insert into resource_types (tenant_id,name,hourly_rate) values ($1,'PS5','200.00')
       on conflict (tenant_id,name) do update set hourly_rate=excluded.hourly_rate returning id`,
      [tenantId],
    )
    const resources: string[] = []
    for (let i = 1; i <= 8; i++) {
      resources.push(
        (
          await owner.query<{ id: string }>(
            `insert into resources (tenant_id,branch_id,resource_type_id,name,status) values ($1,$2,$3,$4,'available')
             on conflict (tenant_id,name) do update set status='available' returning id`,
            [tenantId, b.rows[0].id, rt.rows[0].id, `S${i}`],
          )
        ).rows[0].id,
      )
    }
    return { tenantId, branchId: b.rows[0].id, userId: u.rows[0].id, slug, resources }
  }

  const g = globalThis as { __ARENA_TEST_SESSION?: string; __ARENA_TEST_HEADERS?: Record<string, string> }
  async function signInAs(userId: string, slug: string) {
    const token = randomBytes(32).toString('hex')
    await owner.query(`insert into sessions (id, user_id, expires_at) values ($1,$2, now() + interval '1 day') on conflict (id) do nothing`, [
      createHash('sha256').update(token).digest('hex'),
      userId,
    ])
    g.__ARENA_TEST_SESSION = token
    g.__ARENA_TEST_HEADERS = { 'x-tenant-slug': slug }
  }

  const A = await setup('testwalkinsweep-a', 60)
  const B = await setup('testwalkinsweep-b', 60)
  const C = await setup('testwalkinsweep-c', null)
  const ids = [A, B, C].map((t) => t.tenantId)
  const wipe = async () => {
    await owner.query(`delete from audit_log where tenant_id = any($1) and action='walkin.auto_closed'`, [ids])
    await owner.query('delete from booking_slots where tenant_id = any($1)', [ids])
    await owner.query('delete from bookings where tenant_id = any($1)', [ids])
    await owner.query('delete from customers where tenant_id = any($1)', [ids])
    await owner.query('delete from sequences where tenant_id = any($1)', [ids])
  }
  await wipe()

  let ph = 0
  const phone = () => `98765${String(50000 + ph++).padStart(5, '0')}`
  async function openTab(t: typeof A, resourceIdx: number, minutesAgo: number) {
    await signInAs(t.userId, t.slug)
    const r = await startWalkin({ branchId: t.branchId, resourceId: t.resources[resourceIdx], phone: phone(), startAt: new Date().toISOString(), mode: 'open_tab' })
    if (!r.bookingId) throw new Error(`startWalkin failed: ${r.error}`)
    const startsAt = new Date(Date.now() - minutesAgo * MIN)
    await owner.query(`update booking_slots set starts_at=$2 where booking_id=$1`, [r.bookingId, startsAt])
    return { id: r.bookingId, startsAt }
  }
  const endsAt = async (id: string) => {
    const r = await owner.query<{ e: Date | null }>(`select ends_at e from booking_slots where booking_id=$1`, [id])
    return r.rows[0].e ? new Date(r.rows[0].e).getTime() : null
  }
  const audits = async (id: string) => (await owner.query(`select 1 from audit_log where entity_id=$1 and action='walkin.auto_closed'`, [id])).rowCount ?? 0

  // ── fixtures ──
  const overdue = await openTab(A, 0, 150) // limit 60 → deadline start+60, long past
  const fresh = await openTab(A, 1, 10)
  const cancelled = await openTab(A, 2, 150)
  await owner.query(`update bookings set status='cancelled' where id=$1`, [cancelled.id])
  await signInAs(A.userId, A.slug)
  const tr = await startWalkin({ branchId: A.branchId, resourceId: A.resources[3], phone: phone(), startAt: new Date().toISOString(), mode: 'timed', durationMin: 30 })
  if (!tr.bookingId) throw new Error(`startWalkin failed: ${tr.error}`)
  const timed = tr.bookingId
  const timedEnd = await endsAt(timed)
  const otherTenantOverdue = await openTab(B, 0, 150)
  const ruleOff = await openTab(C, 0, 150)

  // ── 1. a read by tenant A ──
  console.log('\n── a read closes overdue tabs ──')
  resetWalkinSweepThrottle()
  await signInAs(A.userId, A.slug)
  const res = await listActiveWalkinsForAlarm(A.branchId)
  const row = res.sessions.find((s) => s.bookingId === overdue.id)
  const closedEnd = await endsAt(overdue.id)
  check('the overdue open-tab now has an end time', closedEnd !== null)
  check('...stamped at the DEADLINE (start + 60min), not at "now"', closedEnd === overdue.startsAt.getTime() + 60 * MIN)
  check('...and billed for that hour: slot total 200.00', Number((await owner.query(`select slot_total t from booking_slots where booking_id=$1`, [overdue.id])).rows[0].t) === 200)
  check('...with one audit row', (await audits(overdue.id)) === 1)
  check('the list response carries the new end time', row?.endsAt === new Date(closedEnd!).toISOString())
  check('a tab inside its limit stays open', (await endsAt(fresh.id)) === null && (await audits(fresh.id)) === 0)
  check('a cancelled booking is unchanged', (await endsAt(cancelled.id)) === null && (await audits(cancelled.id)) === 0)
  check('a timed walk-in is unchanged', (await endsAt(timed)) === timedEnd)
  check("another tenant's overdue tab is NOT closed by this request", (await endsAt(otherTenantOverdue.id)) === null)
  check('a venue with the rule off is not closed', (await endsAt(ruleOff.id)) === null)
  check('response shape unchanged', Object.keys(res.sessions[0]).sort().join() === 'billingMode,bookingId,customerName,customerPhone,endsAt,resourceName,slotTotal,warningMinutes')

  // ── 2. throttle ──
  console.log('\n── throttle ──')
  const late = await openTab(A, 4, 150)
  await listActiveWalkinsForAlarm(A.branchId)
  check('a second read inside the throttle window does not sweep again', (await endsAt(late.id)) === null)
  resetWalkinSweepThrottle()
  await listActiveWalkinsForAlarm(A.branchId)
  check('after the window it does', (await endsAt(late.id)) !== null)

  // ── 3. concurrency ──
  console.log('\n── concurrent sweeps ──')
  const racy = await openTab(A, 5, 150)
  const results = await Promise.all(Array.from({ length: 5 }, () => autoCloseOverdueWalkins({ tenantId: A.tenantId })))
  check('five concurrent sweeps close the booking once', (await endsAt(racy.id)) === racy.startsAt.getTime() + 60 * MIN)
  check('...exactly one audit row', (await audits(racy.id)) === 1)
  check('...and the sum of closed counts is 1', results.reduce((n, r) => n + r.closed, 0) === 1)

  // ── 4. tenant B closes only its own ──
  console.log('\n── isolation ──')
  resetWalkinSweepThrottle()
  await signInAs(B.userId, B.slug)
  await listActiveWalkinsForAlarm(B.branchId)
  check("tenant B's own read closes B's tab", (await endsAt(otherTenantOverdue.id)) !== null)
  check('...and still leaves the rule-off venue alone', (await endsAt(ruleOff.id)) === null)

  await wipe()
  console.log(`\n${pass} passed, ${fail} failed`)
  await owner.end()
  process.exit(fail ? 1 : 0)
}
main().catch((e) => {
  console.error(e)
  process.exit(1)
})
