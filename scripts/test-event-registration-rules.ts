/**
 * Event registration rules left over from the PR #18 review (migration 0177),
 * exercised against the real database and the real customer/staff RLS paths.
 *
 *   1. a withdrawn team no longer locks its members out
 *   2. a customer cannot self-cancel once the event has started / finished
 *   3. 'full' events still take entrants (waitlist) and still count taken places
 *   4. an event cannot be started over live payment holds
 *   5. refund_required lifecycle: flagged, reported, marked refunded, cleared
 *   6. raising capacity promotes the waitlist
 *
 * Fixtures live in their own tenants and are deleted at the end.
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs scripts/test-event-registration-rules.ts
 */
import { Pool } from 'pg'
import { loadEnv } from './env'

let pass = 0
let fail = 0
const check = (label: string, cond: boolean, detail?: unknown) => {
  console.log(`${cond ? '✓' : '✗ FAIL'}  ${label}`)
  if (cond) pass++
  else {
    fail++
    if (detail !== undefined) console.log('        got:', detail)
  }
}

async function main() {
  loadEnv()

  const { withUser } = await import('../db')
  const {
    claimEventRegistration,
    cancelOwnEventRegistration,
    cancelEventRegistrationAsStaff,
    joinEventTeam,
    markEventRegistrationRefunded,
  } = await import('../lib/events/registrations')
  const { updateEventStatusCore, EventError } = await import('../lib/events/service')
  const { getEventReport } = await import('../lib/reports/events')

  const owner = new Pool({ connectionString: process.env.DATABASE_URL_OWNER })

  async function makeTenant(slug: string) {
    const t = await owner.query<{ id: string }>(
      `insert into tenants (slug,name,status,timezone) values ($1,$2,'active','Asia/Kolkata')
       on conflict (slug) do update set status='active' returning id`,
      [slug, `${slug} co`],
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
        `insert into memberships (tenant_id,user_id,role,status) values ($1,$2,$3,'active')
         on conflict (tenant_id,user_id) do update set role=excluded.role, status='active'`,
        [tenantId, u.rows[0].id, role],
      )
      return u.rows[0].id
    }
    return {
      slug,
      tenantId,
      branchId: b.rows[0].id,
      managerId: await mk(`mgr@${slug}.test`, 'manager'),
    }
  }

  const A = await makeTenant('testevtrules-a')
  const B = await makeTenant('testevtrules-b')
  const ids = [A.tenantId, B.tenantId]
  const ctxFor = (t: typeof A) =>
    ({
      user: { id: t.managerId },
      role: 'manager',
      tenant: { id: t.tenantId, timezone: 'Asia/Kolkata' },
    }) as unknown as Parameters<typeof markEventRegistrationRefunded>[0]

  let phoneSeq = 0
  async function makeCustomer(tenantId: string, name: string) {
    phoneSeq++
    const r = await owner.query<{ id: string }>(
      `insert into customers (tenant_id,phone,name) values ($1,$2,$3) returning id`,
      [tenantId, `+9197${String(30000000 + phoneSeq).slice(0, 8)}`, name],
    )
    return r.rows[0].id
  }

  type EventOpts = {
    capacity?: number | null
    fee?: string
    mode?: 'solo' | 'team'
    teamSize?: number | null
    status?: string
    startsIn?: string
    endsIn?: string
  }
  async function makeEvent(t: typeof A, title: string, o: EventOpts = {}) {
    const r = await owner.query<{ id: string }>(
      `insert into events
         (tenant_id,branch_id,title,type,starts_at,ends_at,capacity,entry_fee,
          registration_mode,team_size,status)
       values ($1,$2,$3,'class', now() + $9::interval, now() + $10::interval,
               $4,$5,$6::event_registration_mode,$7,$8::event_status)
       returning id`,
      [
        t.tenantId,
        t.branchId,
        title,
        o.capacity === undefined ? null : o.capacity,
        o.fee ?? '0',
        o.mode ?? 'solo',
        o.teamSize ?? null,
        o.status ?? 'registration_open',
        o.startsIn ?? '7 days',
        o.endsIn ?? '7 days 3 hours',
      ],
    )
    return r.rows[0].id
  }
  const reg = (id: string) =>
    owner.query(`select * from event_registrations where id=$1`, [id]).then((r) => r.rows[0])
  const confirmPay = (regId: string, ref: string, amount: string) =>
    owner
      .query<{ r: string }>(`select public.confirm_event_registration_payment($1::uuid,$2,$3::numeric) as r`, [regId, ref, amount])
      .then((r) => r.rows[0].r)
  const claim = async (c: string, e: string, team: string | null = null) => {
    const r = await claimEventRegistration(c, e, team)
    if (!r.ok) throw new Error(`claim refused: ${r.refusal}`)
    return r
  }
  const refundDue = async (t: typeof A, eventId: string) => {
    const rep = await getEventReport(ctxFor(t), { start: '2000-01-01', end: '2100-01-01' })
    return rep.rows.find((r) => r.eventId === eventId)?.refundDue ?? 0
  }

  // ══ 1. WITHDRAWN TEAM ═════════════════════════════════════════════════════
  console.log('\n── withdrawn team ──')
  const teamEv = await makeEvent(A, 'Doubles', { mode: 'team', teamSize: 2, capacity: 4 })
  const capt = await makeCustomer(A.tenantId, 'Captain')
  const mate = await makeCustomer(A.tenantId, 'Mate')
  const other = await makeCustomer(A.tenantId, 'Other')
  const t1 = await claim(capt, teamEv, 'Alpha')
  check('member joins the active team', (await joinEventTeam(mate, t1.teamId!)) === 'joined')
  check('the member is locked in while the team is active', (await claimEventRegistration(mate, teamEv, 'Solo Try')).ok === false)

  check('captain cancels the team entry', (await cancelOwnEventRegistration(capt, t1.registrationId)) === 'cancelled')
  const members = await owner.query(`select 1 from event_team_members where team_id=$1`, [t1.teamId])
  check('…the withdrawn team keeps no member rows', members.rowCount === 0)

  const m2 = await claimEventRegistration(mate, teamEv, 'Bravo')
  check('the former member can start a new team', m2.ok, m2)
  const c2 = await claimEventRegistration(capt, teamEv, 'Charlie')
  check('the former captain can register again', c2.ok, c2)
  check('nobody can join the withdrawn team', (await joinEventTeam(other, t1.teamId!)) === 'team_withdrawn')

  // paid-after-cancel on a withdrawn team stays cancelled and owed back
  const paidTeam = await makeEvent(A, 'Paid Doubles', { mode: 'team', teamSize: 2, capacity: 4, fee: '100' })
  const pc = await makeCustomer(A.tenantId, 'PayCap')
  const pt = await claim(pc, paidTeam, 'Delta')
  await cancelOwnEventRegistration(pc, pt.registrationId)
  const late = await confirmPay(pt.registrationId, 'pay_late_team', '100')
  const lateRow = await reg(pt.registrationId)
  check('a payment after the team withdrew is unfulfillable', late === 'unfulfillable', late)
  check('…the entry stays cancelled and is flagged for refund', lateRow.status === 'cancelled' && lateRow.refund_required === true)
  check('…with the amount owed recorded', Number(lateRow.refund_due_amount) === 100, lateRow.refund_due_amount)

  // ══ 2. SELF-CANCEL CUTOFF ═════════════════════════════════════════════════
  console.log('\n── self-cancel cutoff ──')
  async function paidEntrant(t: typeof A, title: string, o: EventOpts) {
    const ev = await makeEvent(t, title, { fee: '100', capacity: 10, ...o })
    const c = await makeCustomer(t.tenantId, `${title} cust`)
    const r = await claim(c, ev)
    await confirmPay(r.registrationId, `pay_${title.replace(/\W/g, '')}_${Date.now()}`, '100')
    return { ev, c, regId: r.registrationId }
  }

  const ok = await paidEntrant(A, 'Future', {})
  check('a customer can cancel before the event', (await cancelOwnEventRegistration(ok.c, ok.regId)) === 'cancelled')
  check('…and the paid entry is flagged owed', (await reg(ok.regId)).refund_required === true)

  const started = await paidEntrant(A, 'Started', {})
  await owner.query(`update events set starts_at = now() - interval '1 hour', ends_at = now() + interval '2 hours' where id=$1`, [started.ev])
  check('after the start time a customer cannot cancel', (await cancelOwnEventRegistration(started.c, started.regId)) === 'too_late')
  const sRow = await reg(started.regId)
  check('…the entry is untouched and no refund is flagged', sRow.status === 'registered' && sRow.refund_required === false)

  const live = await paidEntrant(A, 'Live', {})
  await owner.query(`update events set status='in_progress' where id=$1`, [live.ev])
  check('on an in_progress event a customer cannot cancel', (await cancelOwnEventRegistration(live.c, live.regId)) === 'too_late')

  const done = await paidEntrant(A, 'Done', {})
  await owner.query(`update events set status='completed' where id=$1`, [done.ev])
  check('on a completed event a customer cannot cancel', (await cancelOwnEventRegistration(done.c, done.regId)) === 'too_late')

  check('staff can still cancel an in_progress event entry', (await cancelEventRegistrationAsStaff(A.managerId, live.regId)) === 'cancelled')
  check('…and it is flagged for refund', (await reg(live.regId)).refund_required === true)

  // ══ 3. FULL STATUS ═════════════════════════════════════════════════════════
  console.log('\n── full status ──')
  const fullEv = await makeEvent(A, 'Full House', { capacity: 1, status: 'full' })
  const f1 = await makeCustomer(A.tenantId, 'F1')
  const f2 = await makeCustomer(A.tenantId, 'F2')
  await owner.query(
    `insert into event_registrations (tenant_id,event_id,customer_id,status,registered_at) values ($1,$2,$3,'registered',now())`,
    [A.tenantId, fullEv, f1],
  )
  const fr = await claimEventRegistration(f2, fullEv, null)
  check("a 'full' event waitlists the next entrant instead of refusing", fr.ok && fr.status === 'waitlisted', fr)

  const fullTeam = await makeEvent(A, 'Full Team', { mode: 'team', teamSize: 2, capacity: 2 })
  const ftc = await makeCustomer(A.tenantId, 'FTC')
  const ftm = await makeCustomer(A.tenantId, 'FTM')
  const ftr = await claim(ftc, fullTeam, 'Echo')
  await owner.query(`update events set status='full' where id=$1`, [fullTeam])
  check("joining a team on a 'full' event still works (it takes no place)", (await joinEventTeam(ftm, ftr.teamId!)) === 'joined')

  const counts = await withUser(A.managerId, async (tx) => {
    const { sql } = await import('drizzle-orm')
    const r = await tx.execute<{ event_id: string; taken: number }>(
      sql`select * from public.public_event_taken_counts(${A.tenantId}::uuid)`,
    )
    return r.rows
  })
  check("taken counts include a 'full' event", counts.find((r) => r.event_id === fullEv)?.taken === 1, counts)

  // ══ 4. START OVER LIVE HOLDS ═══════════════════════════════════════════════
  console.log('\n── in_progress with live holds ──')
  const holdEv = await makeEvent(A, 'Held', { fee: '100', capacity: 5 })
  const hc = await makeCustomer(A.tenantId, 'Holder')
  const hr = await claim(hc, holdEv)
  check('the claim holds a place (pending_payment)', hr.status === 'pending_payment')

  let appMsg = ''
  try {
    await withUser(A.managerId, (tx) => updateEventStatusCore(tx, { tenantId: A.tenantId }, holdEv, 'in_progress'))
  } catch (e) {
    appMsg = e instanceof EventError ? e.message : `unexpected: ${(e as Error).message}`
  }
  check('the app refuses to start the event and says why', /part-way through paying/.test(appMsg), appMsg)
  const dbRefuse = await owner.query(`update events set status='in_progress' where id=$1`, [holdEv]).then(() => false).catch((e) => e.code === '23514')
  check('…and the database refuses it even bypassing the app', dbRefuse)
  check('…the event is still open', (await owner.query(`select status from events where id=$1`, [holdEv])).rows[0].status === 'registration_open')

  await owner.query(`update event_registrations set payment_hold_expires_at = now() - interval '1 minute' where id=$1`, [hr.registrationId])
  const started2 = await withUser(A.managerId, (tx) => updateEventStatusCore(tx, { tenantId: A.tenantId }, holdEv, 'in_progress')).then(() => true, () => false)
  check('an EXPIRED hold does not block starting', started2)

  // ══ 5. REFUND LIFECYCLE ════════════════════════════════════════════════════
  console.log('\n── refund lifecycle ──')
  const rf = await paidEntrant(A, 'Refunds', {})
  check('nothing is due while the entrant holds a place', (await refundDue(A, rf.ev)) === 0)
  await cancelEventRegistrationAsStaff(A.managerId, rf.regId)
  const rfRow = await reg(rf.regId)
  check('cancelling a paid entry flags the refund', rfRow.refund_required === true)
  check('…and records the amount owed', Number(rfRow.refund_due_amount) === 100)
  check('the report shows it as refund due', (await refundDue(A, rf.ev)) === 100)

  const ctx = ctxFor(A)
  check('a blank reference is refused', (await markEventRegistrationRefunded(ctx, rf.regId, 100, '  ')) === 'reference_required')
  check('a zero amount is refused', (await markEventRegistrationRefunded(ctx, rf.regId, 0, 'UPI-1')) === 'invalid_amount')
  check('more than is owed is refused', (await markEventRegistrationRefunded(ctx, rf.regId, 150, 'UPI-1')) === 'amount_exceeds_due')
  check('another venue manager cannot mark it', (await markEventRegistrationRefunded(ctxFor(B), rf.regId, 100, 'UPI-X')) === 'not_found')
  check('…and nothing changed', (await reg(rf.regId)).refund_required === true)

  const [first, second] = await Promise.all([
    markEventRegistrationRefunded(ctx, rf.regId, 100, 'UPI-123'),
    markEventRegistrationRefunded(ctx, rf.regId, 100, 'UPI-123'),
  ])
  check('marked refunded exactly once under concurrent clicks', [first, second].sort().join() === 'not_flagged,refunded', [first, second])
  const after = await reg(rf.regId)
  check('…the flag is cleared and the refund recorded',
    after.refund_required === false && Number(after.refunded_amount) === 100 && after.refund_reference === 'UPI-123' && after.refunded_at !== null)
  check('…the amount owed is zero', Number(after.refund_due_amount) === 0)
  check('…one audit row was written', (await owner.query(`select 1 from audit_log where entity_id=$1 and action='event_registration.refunded'`, [rf.regId])).rowCount === 1)
  check('a refunded registration disappears from the refund-due figure', (await refundDue(A, rf.ev)) === 0)
  check('…and cannot be marked twice', (await markEventRegistrationRefunded(ctx, rf.regId, 100, 'UPI-123')) === 'not_flagged')

  // already_paid: second capture on a registered row
  const dp = await paidEntrant(A, 'DoublePay', {})
  const second2 = await confirmPay(dp.regId, 'pay_second_capture', '100')
  const dpRow = await reg(dp.regId)
  check('a second capture is already_paid and the entrant keeps the place', second2 === 'already_paid' && dpRow.status === 'registered')
  check('…the second amount is what is owed', dpRow.refund_required === true && Number(dpRow.refund_due_amount) === 100, dpRow.refund_due_amount)
  check('…and the report counts it even though the row is not cancelled', (await refundDue(A, dp.ev)) === 100)
  check('…marking it refunded clears it', (await markEventRegistrationRefunded(ctx, dp.regId, 100, 'UPI-2nd')) === 'refunded' && (await refundDue(A, dp.ev)) === 0)

  // event cancelled by the venue: bulk path also gets the amount via the trigger
  const ce = await paidEntrant(A, 'CancelledEvt', {})
  const { cancelRegistrationsForCancelledEvent } = await import('../lib/events/registrations')
  await withUser(A.managerId, (tx) => cancelRegistrationsForCancelledEvent(tx, A.tenantId, ce.ev))
  check('cancelling the event records the amount owed per entrant', Number((await reg(ce.regId)).refund_due_amount) === 100)

  // ══ 6. CAPACITY RAISE PROMOTES ════════════════════════════════════════════
  console.log('\n── capacity raise promotes the waitlist ──')
  const capEv = await makeEvent(A, 'Grows', { capacity: 1 })
  const k = [] as string[]
  for (let i = 0; i < 4; i++) k.push(await makeCustomer(A.tenantId, `K${i}`))
  const kr = [] as Awaited<ReturnType<typeof claim>>[]
  for (const c of k) kr.push(await claim(c, capEv))
  check('setup: one registered, three waitlisted', kr[0].status === 'registered' && kr.slice(1).every((x) => x.status === 'waitlisted'))
  await owner.query(`update events set capacity=3 where id=$1`, [capEv])
  const st = async () => Promise.all(kr.map(async (x) => (await reg(x.registrationId)).status))
  check('raising 1 → 3 promotes the next two in FIFO order', (await st()).join() === 'registered,registered,registered,waitlisted', await st())
  await owner.query(`update events set capacity=null where id=$1`, [capEv])
  check('removing the limit promotes everyone', (await st()).every((s) => s === 'registered'))

  const lowerEv = await makeEvent(A, 'Shrinks', { capacity: 2 })
  const l1 = await makeCustomer(A.tenantId, 'L1')
  const l2 = await makeCustomer(A.tenantId, 'L2')
  const l3 = await makeCustomer(A.tenantId, 'L3')
  await claim(l1, lowerEv)
  await claim(l2, lowerEv)
  const l3r = await claim(l3, lowerEv)
  await owner.query(`update events set capacity=2, title='renamed' where id=$1`, [lowerEv])
  check('editing something other than capacity promotes nobody', (await reg(l3r.registrationId)).status === 'waitlisted')

  const paidCap = await makeEvent(A, 'Paid Grows', { capacity: 1, fee: '100' })
  const p1 = await makeCustomer(A.tenantId, 'P1')
  const p2 = await makeCustomer(A.tenantId, 'P2')
  await claim(p1, paidCap)
  const p2r = await claim(p2, paidCap)
  await owner.query(`update events set capacity=2 where id=$1`, [paidCap])
  const p2row = await reg(p2r.registrationId)
  check('on a paid event the promoted entrant gets a payment hold, not a free place', p2row.status === 'pending_payment' && p2row.payment_hold_expires_at !== null)

  const closed = await makeEvent(A, 'Closed Grows', { capacity: 1 })
  const z1 = await makeCustomer(A.tenantId, 'Z1')
  const z2 = await makeCustomer(A.tenantId, 'Z2')
  await claim(z1, closed)
  const z2r = await claim(z2, closed)
  await owner.query(`update events set status='completed' where id=$1`, [closed])
  await owner.query(`update events set capacity=5 where id=$1`, [closed])
  check('a completed event promotes nobody when capacity is raised', (await reg(z2r.registrationId)).status === 'waitlisted')

  // ── cleanup ──
  await owner.query(`delete from audit_log where tenant_id = any($1) and action like 'event_registration.%'`, [ids])
  await owner.query('delete from events where tenant_id = any($1)', [ids])
  await owner.query('delete from customers where tenant_id = any($1)', [ids])

  console.log(`\n${pass} passed, ${fail} failed`)
  await owner.end()
  process.exit(fail ? 1 : 0)
}
main().catch((e) => {
  console.error(e)
  process.exit(1)
})
