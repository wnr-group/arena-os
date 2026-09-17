/**
 * M15 #5 — day-of check-in, end to end against a real database.
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs scripts/test-event-check-in.ts
 *
 * ── What is real ────────────────────────────────────────────────────────────
 *
 * The database, migration 0095, every RLS policy and grant, the real
 * checkInByTokenCore() / promoteEventWaitlistAsStaff() / count and seeding
 * readers, and the real promote_event_waitlist() the cancellation path already
 * uses. Registrations are created through the actual claimEventRegistration()
 * entry point, so the statuses under test are the ones the product produces.
 *
 * The server ACTIONS (requireManager) are not driven here — they need a request
 * context and this branch has no Next-runtime test hook. Authorization is
 * therefore proven at the layer below and beside it: the RLS policies are
 * exercised directly as a cashier and as another tenant's manager, which is
 * what would actually have to fail open for the guard to matter.
 */
import { Client, Pool } from 'pg'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { sql } from 'drizzle-orm'
import * as schema from '../db/schema'
import { loadEnv } from './env'

loadEnv()

type Db = NodePgDatabase<typeof schema>

let pass = 0,
  fail = 0
const check = (l: string, c: boolean, extra?: string) => {
  console.log(`${c ? '✓' : '✗ FAIL'}  ${l}${c ? '' : extra ? `  → ${extra}` : ''}`)
  if (c) pass++
  else fail++
}
const section = (s: string) => console.log(`\n── ${s} ──`)

async function main() {
  const { checkInByTokenCore, getEventCheckInCounts, listCheckedInParticipants, promoteEventWaitlistAsStaff } =
    await import('../lib/events/check-in')
  const { claimEventRegistration } = await import('../lib/events/registrations')

  const owner = new Client({ connectionString: process.env.DATABASE_URL_OWNER })
  await owner.connect()
  const appPool = new Pool({ connectionString: process.env.DATABASE_URL })
  const app = drizzle(appPool, { schema })

  async function withUser<T>(userId: string, fn: (tx: Db) => Promise<T>): Promise<T> {
    return app.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`)
      return fn(tx as unknown as Db)
    })
  }

  async function makeTenant(slug: string) {
    const t = await owner.query<{ id: string }>(
      `insert into tenants (slug,name,status,timezone) values ($1,$1,'active','Asia/Kolkata')
       on conflict (slug) do update set status='active' returning id`,
      [slug],
    )
    const tenantId = t.rows[0].id
    await owner.query('delete from events where tenant_id=$1', [tenantId])
    await owner.query('delete from customers where tenant_id=$1', [tenantId])
    await owner.query('delete from branches where tenant_id=$1', [tenantId])
    const b = await owner.query<{ id: string }>(
      `insert into branches (tenant_id,name,is_primary,status) values ($1,'Main',true,'active') returning id`,
      [tenantId],
    )
    const mk = async (email: string, role: string) => {
      const u = await owner.query<{ id: string }>(
        `insert into users (email,password_hash) values ($1,'x')
         on conflict (email) do update set email=excluded.email returning id`,
        [email],
      )
      await owner.query(
        `insert into memberships (tenant_id,user_id,role,status) values ($1,$2,$3::member_role,'active')
         on conflict (tenant_id,user_id) do update set role=excluded.role, status='active'`,
        [tenantId, u.rows[0].id, role],
      )
      return u.rows[0].id
    }
    return {
      tenantId,
      branchId: b.rows[0].id,
      managerId: await mk(`mgr@${slug}.test`, 'manager'),
      cashierId: await mk(`cash@${slug}.test`, 'cashier'),
    }
  }

  const A = await makeTenant('evtci-a')
  const B = await makeTenant('evtci-b')
  const ctxFor = (t: typeof A, userId: string) =>
    ({ user: { id: userId }, tenant: { id: t.tenantId } }) as unknown as Parameters<
      typeof getEventCheckInCounts
    >[0]

  let phoneSeq = 0
  async function makeCustomer(tenantId: string, name: string) {
    phoneSeq++
    const r = await owner.query<{ id: string }>(
      `insert into customers (tenant_id,phone,name) values ($1,$2,$3) returning id`,
      [tenantId, `+9199${String(10000000 + phoneSeq).slice(0, 8)}`, name],
    )
    return r.rows[0].id
  }

  async function makeEvent(
    t: { tenantId: string; branchId: string },
    title: string,
    o: { capacity?: number | null; fee?: string; status?: string } = {},
  ) {
    const r = await owner.query<{ id: string }>(
      `insert into events (tenant_id,branch_id,title,type,starts_at,ends_at,capacity,entry_fee,status)
       values ($1,$2,$3,'class', now() + interval '2 days', now() + interval '2 days 3 hours',
               $4,$5,$6::event_status) returning id`,
      [t.tenantId, t.branchId, title, o.capacity === undefined ? null : o.capacity, o.fee ?? '0', o.status ?? 'registration_open'],
    )
    return r.rows[0].id
  }

  /**
   * Register a customer through the REAL entry point, narrowing the outcome.
   * A refusal is thrown rather than silently producing undefined — a fixture
   * that failed to register would make every later assertion meaningless.
   */
  async function register(customerId: string, eventId: string): Promise<string> {
    const r = await claimEventRegistration(customerId, eventId, null)
    if (!r.ok) throw new Error(`claim refused: ` + r.refusal)
    return r.registrationId
  }

  const tokenOf = async (regId: string) =>
    (await owner.query<{ t: string }>('select check_in_token t from event_registrations where id=$1', [regId]))
      .rows[0].t
  const statusOf = async (regId: string) =>
    (await owner.query<{ s: string }>('select status s from event_registrations where id=$1', [regId]))
      .rows[0].s
  const scan = (t: typeof A, token: string) =>
    withUser(t.managerId, (tx) => checkInByTokenCore(tx, { tenantId: t.tenantId }, token))

  // ════════════════════════════════════════════════════════════════════════
  section('1. the token itself')
  {
    const ev = await makeEvent(A, 'Token Shape')
    const c = await makeCustomer(A.tenantId, 'Tok')
    const reg = await register(c, ev)
    const token = await tokenOf(reg)

    check('every registration gets a token automatically', /^[0-9a-f-]{36}$/.test(token))
    check('…which is not the registration id', token !== reg)
    check('…nor the customer id', token !== c)
    check('…nor the event id', token !== ev)

    const dupes = await owner.query<{ n: string }>(
      `select count(*) n from (select check_in_token from event_registrations
        group by check_in_token having count(*) > 1) x`,
    )
    check('tokens are unique across the whole table', dupes.rows[0].n === '0')

    // v4: 122 random bits. Two rows must not share a prefix by construction.
    const c2 = await makeCustomer(A.tenantId, 'Tok2')
    const reg2 = await register(c2, ev)
    check('two registrations get unrelated tokens', (await tokenOf(reg2)) !== token)
  }

  // ════════════════════════════════════════════════════════════════════════
  section('2. QR check-in — the happy path and its idempotency')
  {
    const ev = await makeEvent(A, 'Free Scan')
    const c = await makeCustomer(A.tenantId, 'Asha')
    const reg = await register(c, ev)
    const token = await tokenOf(reg)

    const first = await scan(A, token)
    check('a valid token checks the entrant in', first.ok === true)
    check('…reporting it as a NEW check-in', first.ok && first.alreadyCheckedIn === false)
    check('…naming the customer for the counter', first.ok && first.entrant.customerName === 'Asha')
    check('…and the event', first.ok && first.entrant.eventTitle === 'Free Scan')
    check('the status is now checked_in', (await statusOf(reg)) === 'checked_in')

    const stamp = (
      await owner.query<{ t: Date }>('select checked_in_at t from event_registrations where id=$1', [reg])
    ).rows[0].t
    check('…and checked_in_at is recorded', stamp instanceof Date)

    // Replay.
    const second = await scan(A, token)
    check('re-scanning is accepted, not an error', second.ok === true)
    check('…and reported as ALREADY checked in', second.ok && second.alreadyCheckedIn === true)
    const stamp2 = (
      await owner.query<{ t: Date }>('select checked_in_at t from event_registrations where id=$1', [reg])
    ).rows[0].t
    check(
      '…and the FIRST arrival time is preserved, not overwritten',
      stamp2.getTime() === stamp.getTime(),
    )
  }

  // ════════════════════════════════════════════════════════════════════════
  section('3. QR security — invalid, foreign, cancelled, waitlisted, unpaid')
  {
    const bad = await scan(A, '00000000-0000-4000-8000-000000000000')
    check('an unknown token is refused', bad.ok === false && bad.reason === 'not_found')

    // Cross-tenant: B's real token, scanned by A's manager.
    const evB = await makeEvent(B, 'B Event')
    const cB = await makeCustomer(B.tenantId, 'Bee')
    const regB = await register(cB, evB)
    const tokenB = await tokenOf(regB)

    const cross = await scan(A, tokenB)
    check("tenant A scanning tenant B's REAL token is refused", cross.ok === false)
    check(
      '…as not_found — the refusal does not confirm the row exists elsewhere',
      cross.ok === false && cross.reason === 'not_found',
    )
    check("…and tenant B's registration is untouched", (await statusOf(regB)) === 'registered')

    // Cancelled.
    const ev = await makeEvent(A, 'Cancel Scan')
    const cc = await makeCustomer(A.tenantId, 'Cancelled Carl')
    const regC = await register(cc, ev)
    await owner.query(
      `update event_registrations set status='cancelled', cancelled_at=now() where id=$1`,
      [regC],
    )
    const cancelled = await scan(A, await tokenOf(regC))
    check('a cancelled registration cannot check in', cancelled.ok === false && cancelled.reason === 'cancelled')

    // Waitlisted — the capacity bypass the ticket is most worried about.
    const small = await makeEvent(A, 'One Place', { capacity: 1 })
    const w1 = await makeCustomer(A.tenantId, 'In')
    const w2 = await makeCustomer(A.tenantId, 'Queued')
    await register(w1, small)
    const wReg = await register(w2, small)
    check('the second entrant is waitlisted', (await statusOf(wReg)) === 'waitlisted')
    const wl = await scan(A, await tokenOf(wReg))
    check('a WAITLISTED entrant cannot scan their way in', wl.ok === false && wl.reason === 'waitlisted')
    check('…and stays waitlisted', (await statusOf(wReg)) === 'waitlisted')

    // Paid event, money not arrived.
    const paid = await makeEvent(A, 'Paid Cup', { capacity: 5, fee: '500.00' })
    const pc = await makeCustomer(A.tenantId, 'Unpaid Uma')
    const pReg = await register(pc, paid)
    check('a paid-event entry starts as pending_payment', (await statusOf(pReg)) === 'pending_payment')
    const unpaid = await scan(A, await tokenOf(pReg))
    check(
      'an UNPAID entrant cannot check in',
      unpaid.ok === false && unpaid.reason === 'awaiting_payment',
    )
    check('…and is not silently marked paid', (await statusOf(pReg)) === 'pending_payment')

    // Once the verified-webhook path confirms it, the same token works.
    await owner.query(
      `select public.confirm_event_registration_payment($1::uuid, $2, $3::numeric)`,
      [pReg, `pay_ci_${Date.now()}`, '500.00'],
    )
    check('…until a verified payment confirms it', (await statusOf(pReg)) === 'registered')
    const nowPaid = await scan(A, await tokenOf(pReg))
    check('…after which the same token checks them in', nowPaid.ok === true)

    // Cancelled EVENT.
    const dead = await makeEvent(A, 'Called Off')
    const dc = await makeCustomer(A.tenantId, 'Dee')
    const dReg = await register(dc, dead)
    await owner.query(`update events set status='cancelled' where id=$1`, [dead])
    const evCancelled = await scan(A, await tokenOf(dReg))
    check(
      'nobody checks in to a cancelled event',
      evCancelled.ok === false && evCancelled.reason === 'event_cancelled',
    )
  }

  // ════════════════════════════════════════════════════════════════════════
  section('4. concurrency')
  {
    const ev = await makeEvent(A, 'Race Scan')
    const c = await makeCustomer(A.tenantId, 'Racer')
    const reg = await register(c, ev)
    const token = await tokenOf(reg)

    // Two staff scanning the same QR at the same instant.
    const both = await Promise.all([scan(A, token), scan(A, token)])
    check('both concurrent scans succeed (neither errors)', both.every((r) => r.ok))
    const fresh = both.filter((r) => r.ok && !r.alreadyCheckedIn).length
    check('…but exactly ONE is a new check-in', fresh === 1, `fresh=${fresh}`)
    check('…and the row is checked_in exactly once', (await statusOf(reg)) === 'checked_in')

    // Two staff promoting into ONE free place.
    const small = await makeEvent(A, 'Promote Race', { capacity: 1 })
    const held = await makeCustomer(A.tenantId, 'Holder')
    const q1 = await makeCustomer(A.tenantId, 'Q1')
    const q2 = await makeCustomer(A.tenantId, 'Q2')
    const heldReg = await register(held, small)
    await register(q1, small)
    await register(q2, small)

    // The holder is a no-show: cancel frees exactly one place.
    await owner.query(
      `update event_registrations set status='cancelled', cancelled_at=now() where id=$1`,
      [heldReg],
    )
    const promotions = await Promise.all([
      promoteEventWaitlistAsStaff(ctxFor(A, A.managerId), small),
      promoteEventWaitlistAsStaff(ctxFor(A, A.managerId), small),
    ])
    const total = promotions.reduce((a, b) => a + b, 0)
    check('two concurrent promotions consume ONE place between them', total === 1, `total=${total}`)
    const occupancy = (
      await owner.query<{ n: string }>(
        `select count(*) n from event_registrations
          where event_id=$1 and status in ('registered','checked_in','pending_payment')`,
        [small],
      )
    ).rows[0].n
    check('…so occupancy never exceeds capacity', occupancy === '1', occupancy)
  }

  // ════════════════════════════════════════════════════════════════════════
  section('5. waitlist promotion → check-in')
  {
    const ev = await makeEvent(A, 'Promote Then Scan', { capacity: 1 })
    const a1 = await makeCustomer(A.tenantId, 'First')
    const a2 = await makeCustomer(A.tenantId, 'Second')
    const r1 = await register(a1, ev)
    const r2 = await register(a2, ev)
    check('second entrant is queued', (await statusOf(r2)) === 'waitlisted')

    const noRoom = await promoteEventWaitlistAsStaff(ctxFor(A, A.managerId), ev)
    check('promotion with a full event promotes nobody', noRoom === 0)
    check('…and is therefore safe to call twice', (await statusOf(r2)) === 'waitlisted')

    await owner.query(`update event_registrations set status='cancelled', cancelled_at=now() where id=$1`, [r1])
    const n = await promoteEventWaitlistAsStaff(ctxFor(A, A.managerId), ev)
    check('once a place frees, the next in line is promoted', n === 1)
    check('…to registered on a FREE event', (await statusOf(r2)) === 'registered')

    const after = await scan(A, await tokenOf(r2))
    check('…and the promoted entrant can now check in', after.ok === true)

    // A PAID event promotes to pending_payment, never straight to registered.
    const paid = await makeEvent(A, 'Paid Promote', { capacity: 1, fee: '250.00' })
    const p1 = await makeCustomer(A.tenantId, 'PaidFirst')
    const p2 = await makeCustomer(A.tenantId, 'PaidQueued')
    const pr1 = await register(p1, paid)
    await owner.query(`select public.confirm_event_registration_payment($1::uuid,$2,$3::numeric)`, [
      pr1, `pay_pp_${Date.now()}`, '250.00',
    ])
    const pr2 = await register(p2, paid)
    check('the paid event is full, so the second is waitlisted', (await statusOf(pr2)) === 'waitlisted')
    await owner.query(`update event_registrations set status='cancelled', cancelled_at=now() where id=$1`, [pr1])
    await promoteEventWaitlistAsStaff(ctxFor(A, A.managerId), paid)
    check(
      'a promoted PAID entrant lands on pending_payment, not registered',
      (await statusOf(pr2)) === 'pending_payment',
    )
    const stillUnpaid = await scan(A, await tokenOf(pr2))
    check(
      '…so they still cannot check in until they pay',
      stillUnpaid.ok === false && stillUnpaid.reason === 'awaiting_payment',
    )
  }

  // ════════════════════════════════════════════════════════════════════════
  section('6. live counts')
  {
    const ev = await makeEvent(A, 'Counting', { capacity: 2 })
    const cs = []
    for (let i = 0; i < 4; i++) cs.push(await makeCustomer(A.tenantId, `Count ${i}`))
    const regs = []
    for (const c of cs) regs.push(await register(c, ev))

    let counts = await getEventCheckInCounts(ctxFor(A, A.managerId), ev)
    check('two confirmed, two queued', counts.registered === 2 && counts.waitlisted === 2)
    check('…nobody checked in yet', counts.checkedIn === 0)
    check('…confirmed = registered + checkedIn', counts.confirmed === 2)

    await scan(A, await tokenOf(regs[0]))
    counts = await getEventCheckInCounts(ctxFor(A, A.managerId), ev)
    check('after a check-in, registered drops and checkedIn rises', counts.registered === 1 && counts.checkedIn === 1)
    check('…while confirmed is unchanged — the place is still spent', counts.confirmed === 2)

    await owner.query(`update event_registrations set status='cancelled', cancelled_at=now() where id=$1`, [regs[1]])
    counts = await getEventCheckInCounts(ctxFor(A, A.managerId), ev)
    check('a cancellation leaves the active counts', counts.registered === 0 && counts.checkedIn === 1)
    check('…and is reported separately', counts.cancelled === 1)
    check('…and is in NONE of the active numbers', counts.confirmed === 1)

    await promoteEventWaitlistAsStaff(ctxFor(A, A.managerId), ev)
    counts = await getEventCheckInCounts(ctxFor(A, A.managerId), ev)
    check('promotion moves one from waitlisted to registered', counts.registered === 1 && counts.waitlisted === 1)
  }

  // ════════════════════════════════════════════════════════════════════════
  section('7. the checked-in list (bracket seeding input)')
  {
    const ev = await makeEvent(A, 'Seeding Source')
    const names = ['Zara', 'Yash', 'Xena']
    const regs: string[] = []
    for (const n of names) {
      const c = await makeCustomer(A.tenantId, n)
      regs.push(await register(c, ev))
    }
    // Check in out of registration order, to prove the list is ARRIVAL order.
    await scan(A, await tokenOf(regs[2]))
    await scan(A, await tokenOf(regs[0]))

    const list = await listCheckedInParticipants(ctxFor(A, A.managerId), ev)
    check('only checked-in participants appear', list.length === 2)
    check(
      '…in arrival order, not registration order',
      list[0].customerName === 'Xena' && list[1].customerName === 'Zara',
      list.map((p) => p.customerName).join(','),
    )
    check('…each carrying the ids a bracket will seed from',
      list.every((p) => p.registrationId && p.customerId && p.eventId === ev))
    check('…and an arrival timestamp', list.every((p) => p.checkedInAt instanceof Date))
    check('…with team fields present (null for a solo event)',
      list.every((p) => p.teamId === null && p.teamName === null))
  }

  // ════════════════════════════════════════════════════════════════════════
  section('8. authorization and tenant isolation, at the RLS layer')
  {
    const ev = await makeEvent(A, 'Isolation')
    const c = await makeCustomer(A.tenantId, 'Iso')
    const reg = await register(c, ev)

    // A CASHIER may read (any member can) but must not write the status —
    // event_registrations_manager_write is the database half of requireManager().
    const cashierWrote = await withUser(A.cashierId, (tx) =>
      tx.execute(sql`update event_registrations set status='checked_in'
                      where id = ${reg}::uuid returning id`),
    )
    check('a CASHIER cannot mark a registration checked in', cashierWrote.rows.length === 0)
    check('…and the row is unchanged', (await statusOf(reg)) === 'registered')

    // Tenant B's manager can see nothing of A's.
    const seen = await withUser(B.managerId, (tx) =>
      tx.execute(sql`select count(*)::int n from event_registrations where event_id = ${ev}::uuid`),
    )
    check("tenant B cannot read tenant A's registrations", Number((seen.rows[0] as { n: number }).n) === 0)

    const bCounts = await getEventCheckInCounts(ctxFor(B, B.managerId), ev)
    check("…nor A's counts through the reader", bCounts.confirmed === 0 && bCounts.waitlisted === 0)

    const bList = await listCheckedInParticipants(ctxFor(B, B.managerId), ev)
    check("…nor A's checked-in list", bList.length === 0)

    const bPromote = await promoteEventWaitlistAsStaff(ctxFor(B, B.managerId), ev)
    check("…nor promote A's waitlist", bPromote === 0)

    // A customer connection has no route at all: the token column is theirs to
    // read for their own QR, but nothing lets them write a status.
    const custWrote = await app.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.customer_id', ${c}, true)`)
      return tx.execute(sql`update event_registrations set status='checked_in'
                             where id = ${reg}::uuid returning id`)
    })
    check('a CUSTOMER cannot check themselves in', custWrote.rows.length === 0)
    check('…and the row is still registered', (await statusOf(reg)) === 'registered')
  }

  // ── cleanup ───────────────────────────────────────────────────────────────
  for (const t of [A, B]) {
    await owner.query('delete from events where tenant_id=$1', [t.tenantId])
    await owner.query('delete from customers where tenant_id=$1', [t.tenantId])
  }

  console.log(`\n${pass} passed, ${fail} failed`)
  await owner.end()
  await appPool.end()
  if (fail > 0) process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
