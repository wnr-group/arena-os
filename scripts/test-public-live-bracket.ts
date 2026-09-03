/**
 * M15 #7 — the public live bracket: visibility, read-only-ness, isolation and
 * the staff→public update path.
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs scripts/test-public-live-bracket.ts
 *
 * Everything real: migration 0089, the public policies, the SECURITY DEFINER
 * name projection, the actual getPublicEventLive() reader, and the actual staff
 * recordMatchResult() — so "does a staff score appear publicly?" is answered by
 * writing one and then reading the public page's data, not by inspection.
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

async function refusal(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn()
    return null
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}

async function main() {
  const { getPublicEventLive, publicEventHasBracket } = await import('../lib/events/public-live')
  const { generateEventBracket, recordMatchResult } = await import('../lib/events/bracket-service')
  const { claimEventRegistration } = await import('../lib/events/registrations')
  const { checkInByTokenCore } = await import('../lib/events/check-in')

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
  /** An anonymous public visitor: only app.public_tenant_id is set. */
  async function asPublic<T>(tenantId: string, fn: (tx: Db) => Promise<T>): Promise<T> {
    return app.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.public_tenant_id', ${tenantId}, true)`)
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
    const u = await owner.query<{ id: string }>(
      `insert into users (email,password_hash) values ($1,'x')
       on conflict (email) do update set email=excluded.email returning id`,
      [`mgr@${slug}.test`],
    )
    const m = await owner.query<{ id: string }>(
      `insert into memberships (tenant_id,user_id,role,status) values ($1,$2,'manager','active')
       on conflict (tenant_id,user_id) do update set role='manager', status='active' returning id`,
      [tenantId, u.rows[0].id],
    )
    return { tenantId, branchId: b.rows[0].id, userId: u.rows[0].id, membershipId: m.rows[0].id }
  }

  const A = await makeTenant('plive-a')
  const B = await makeTenant('plive-b')
  const ctxFor = (t: typeof A) =>
    ({ user: { id: t.userId }, tenant: { id: t.tenantId }, membershipId: t.membershipId }) as never

  let seq = 0
  async function makeEvent(
    t: typeof A,
    title: string,
    format: string | null,
    status = 'in_progress',
  ) {
    const r = await owner.query<{ id: string }>(
      `insert into events (tenant_id,branch_id,title,type,tournament_format,starts_at,ends_at,capacity,entry_fee,status)
       values ($1,$2,$3,$4::event_type,$5::tournament_format,
               now() - interval '1 hour', now() + interval '3 hours', 16, '0', $6::event_status)
       returning id`,
      [t.tenantId, t.branchId, title, format ? 'tournament' : 'class', format, status],
    )
    return r.rows[0].id
  }

  /**
   * Register n customers, check them all in, and draw the bracket.
   *
   * Entry is only accepted while the event is `registration_open`, so the event
   * is put there for the duration and restored afterwards — the live page is
   * precisely about events that have MOVED ON from registration, which is the
   * state under test.
   */
  async function fillAndDraw(t: typeof A, eventId: string, n: number): Promise<string[]> {
    const original = (
      await owner.query<{ s: string }>('select status::text s from events where id=$1', [eventId])
    ).rows[0].s
    await owner.query(`update events set status='registration_open' where id=$1`, [eventId])

    const regs: string[] = []
    for (let i = 0; i < n; i++) {
      seq++
      const c = await owner.query<{ id: string }>(
        `insert into customers (tenant_id,phone,name) values ($1,$2,$3) returning id`,
        [t.tenantId, `+9196${String(10000000 + seq).slice(0, 8)}`, `Player ${i + 1}`],
      )
      const r = await claimEventRegistration(c.rows[0].id, eventId, null)
      if (!r.ok) throw new Error(`claim refused: ${r.refusal}`)
      regs.push(r.registrationId)
      const tok = (
        await owner.query<{ t: string }>('select check_in_token t from event_registrations where id=$1', [r.registrationId])
      ).rows[0].t
      await withUser(t.userId, (tx) => checkInByTokenCore(tx, { tenantId: t.tenantId }, tok))
      await owner.query(
        `update event_registrations set checked_in_at = now() + ($2 || ' seconds')::interval where id=$1`,
        [r.registrationId, String(i)],
      )
    }
    await withUser(t.userId, (tx) => generateEventBracket(tx, ctxFor(t), eventId))
    await owner.query(`update events set status=$2::event_status where id=$1`, [eventId, original])
    return regs
  }

  // ════════════════════════════════════════════════════════════════════════
  section('1. public visibility')
  {
    const live = await makeEvent(A, 'Live Cup', 'single_elim', 'in_progress')
    await fillAndDraw(A, live, 4)

    const view = await getPublicEventLive(A.tenantId, live)
    check('an in_progress event IS publicly readable', view !== null)
    check('…with its draw', (view?.matches.length ?? 0) === 3)
    check('…and its title', view?.event.title === 'Live Cup')

    for (const st of ['published', 'registration_open', 'full', 'completed']) {
      await owner.query(`update events set status=$2::event_status where id=$1`, [live, st])
      check(`…and so is a ${st} event`, (await getPublicEventLive(A.tenantId, live)) !== null)
    }

    // The two that must NEVER be public.
    await owner.query(`update events set status='cancelled' where id=$1`, [live])
    check('a CANCELLED event is not public', (await getPublicEventLive(A.tenantId, live)) === null)
    await owner.query(`update events set status='draft' where id=$1`, [live])
    check('a DRAFT event is not public', (await getPublicEventLive(A.tenantId, live)) === null)
    // …not even its matches, at the policy level.
    const hidden = await asPublic(A.tenantId, (tx) =>
      tx.execute(sql`select count(*)::int n from event_matches where event_id = ${live}::uuid`),
    )
    check('…nor are a draft event’s matches readable', Number((hidden.rows[0] as { n: number }).n) === 0)

    await owner.query(`update events set status='in_progress' where id=$1`, [live])
    check('an unknown id returns null (a 404, not an error)', (await getPublicEventLive(A.tenantId, '00000000-0000-4000-8000-000000000000')) === null)
    check('a malformed id returns null rather than raising', (await getPublicEventLive(A.tenantId, 'not-a-uuid')) === null)
  }

  // ════════════════════════════════════════════════════════════════════════
  section('2. tenant isolation')
  {
    const evA = await makeEvent(A, 'A Cup', 'single_elim')
    await fillAndDraw(A, evA, 4)

    // Tenant A's public host + tenant A's event id, but asked as tenant B.
    check("tenant B's public context cannot read tenant A's event", (await getPublicEventLive(B.tenantId, evA)) === null)
    check('…nor its bracket-exists flag', (await publicEventHasBracket(B.tenantId, evA)) === false)

    const cross = await asPublic(B.tenantId, (tx) =>
      tx.execute(sql`select count(*)::int n from event_matches where event_id = ${evA}::uuid`),
    )
    check("…nor its matches by raw query — RLS confines it", Number((cross.rows[0] as { n: number }).n) === 0)

    const crossNames = await asPublic(B.tenantId, (tx) =>
      tx.execute(sql`select count(*)::int n from public.public_event_participants(${evA}::uuid)`),
    )
    check('…nor participant names through the projection', Number((crossNames.rows[0] as { n: number }).n) === 0)
  }

  // ════════════════════════════════════════════════════════════════════════
  section('3. the public path is READ-ONLY')
  {
    const ev = await makeEvent(A, 'ReadOnly', 'single_elim')
    await fillAndDraw(A, ev, 4)
    const m = (
      await owner.query<{ id: string }>(`select id from event_matches where event_id=$1 and status='ready' limit 1`, [ev])
    ).rows[0]

    const upd = await asPublic(A.tenantId, (tx) =>
      tx.execute(sql`update event_matches set score_a = 99 where id = ${m.id}::uuid returning id`),
    )
    check('an anonymous visitor cannot change a score', upd.rows.length === 0)

    const win = await asPublic(A.tenantId, (tx) =>
      tx.execute(sql`update event_matches set winner = participant_a, status = 'completed' where id = ${m.id}::uuid returning id`),
    )
    check('…cannot declare a winner', win.rows.length === 0)

    const del = await asPublic(A.tenantId, (tx) =>
      tx.execute(sql`delete from event_matches where event_id = ${ev}::uuid returning id`),
    )
    check('…cannot delete the bracket', del.rows.length === 0)

    const ins = await refusal(() =>
      asPublic(A.tenantId, (tx) =>
        tx.execute(sql`insert into event_matches (tenant_id,event_id,side,round,position)
                       values (${A.tenantId}::uuid, ${ev}::uuid, 'winners', 9, 9)`),
      ),
    )
    check('…cannot insert a match', ins !== null)

    const reg = await asPublic(A.tenantId, (tx) =>
      tx.execute(sql`update event_registrations set status = 'checked_in' returning id`),
    )
    check('…cannot modify a registration', reg.rows.length === 0)

    check('…and the match is untouched', (
      await owner.query<{ score_a: number | null; status: string }>('select score_a, status::text from event_matches where id=$1', [m.id])
    ).rows[0].score_a === null)
  }

  // ════════════════════════════════════════════════════════════════════════
  section('4. no private data crosses the boundary')
  {
    const ev = await makeEvent(A, 'Privacy', 'single_elim')
    const regs = await fillAndDraw(A, ev, 4)
    // Give one registration a payment reference, so a leak would be visible.
    await owner.query(
      `update event_registrations set payment_reference='pay_SECRET123', paid_amount='500.00' where id=$1`,
      [regs[0]],
    )

    const view = await getPublicEventLive(A.tenantId, ev)
    const blob = JSON.stringify(view)
    check('the public payload carries no payment reference', !blob.includes('pay_SECRET123'))
    check('…no paid amount', !blob.includes('500.00'))
    check('…no check-in token', !(await (async () => {
      const tok = (await owner.query<{ t: string }>('select check_in_token t from event_registrations where id=$1', [regs[0]])).rows[0].t
      return blob.includes(tok)
    })()))
    check('…no customer phone number', !blob.includes('+9196'))

    const custId = (await owner.query<{ customer_id: string }>('select customer_id from event_registrations where id=$1', [regs[0]])).rows[0].customer_id
    check('…and no customer id', !blob.includes(custId))

    check('but participant display names ARE present (a bracket needs them)', blob.includes('Player 1'))

    // event_registrations must be unreadable on the public path entirely.
    const priv = await asPublic(A.tenantId, (tx) =>
      tx.execute(sql`select count(*)::int n from event_registrations where event_id = ${ev}::uuid`),
    )
    check('event_registrations is not publicly readable at all', Number((priv.rows[0] as { n: number }).n) === 0)
  }

  // ════════════════════════════════════════════════════════════════════════
  section('5. staff results appear publicly — the whole point')
  {
    const ev = await makeEvent(A, 'Update Path', 'single_elim')
    await fillAndDraw(A, ev, 4)

    let view = (await getPublicEventLive(A.tenantId, ev))!
    check('initially nothing is completed', view.matches.every((m) => m.status !== 'completed'))
    check('…and the final has nobody in it', view.matches.find((m) => m.round === 2)?.a === null)
    check('…so the tournament is not complete', view.isComplete === false)
    check('…and there is no champion', view.champion === null)

    // Staff enter a result — A 10 – 7 B, the ticket's own example.
    const r1 = (
      await owner.query<{ id: string; participant_a: string }>(
        `select id, participant_a from event_matches where event_id=$1 and round=1 order by position limit 1`,
        [ev],
      )
    ).rows[0]
    await withUser(A.userId, (tx) => recordMatchResult(tx, ctxFor(A), { matchId: r1.id, scoreA: 10, scoreB: 7 }))

    view = (await getPublicEventLive(A.tenantId, ev))!
    const shown = view.matches.find((m) => m.id === r1.id)!
    check('the public page now shows the match completed', shown.status === 'completed')
    check('…with the scores', shown.scoreA === 10 && shown.scoreB === 7)
    check('…and A as the winner', shown.winnerId === r1.participant_a)

    const final = view.matches.find((m) => m.round === 2)!
    check('…and A has appeared in the next match', final.a?.id === r1.participant_a)
    check('…named, not just an id', typeof final.a?.name === 'string' && final.a.name.length > 0)

    // Play it out; completion must be reported so the client stops polling.
    for (let guard = 0; guard < 8; guard++) {
      const next = (
        await owner.query<{ id: string }>(`select id from event_matches where event_id=$1 and status='ready' limit 1`, [ev])
      ).rows[0]
      if (!next) break
      await withUser(A.userId, (tx) => recordMatchResult(tx, ctxFor(A), { matchId: next.id, scoreA: 5, scoreB: 1 }))
    }
    view = (await getPublicEventLive(A.tenantId, ev))!
    check('once every match is played the view reports COMPLETE', view.isComplete === true)
    check('…and names the champion', typeof view.champion === 'string' && view.champion!.length > 0, String(view.champion))
  }

  // ════════════════════════════════════════════════════════════════════════
  section('6. formats render from persisted state')
  {
    // Double elimination — both brackets and the final must be present.
    const de = await makeEvent(A, 'DE Public', 'double_elim')
    await fillAndDraw(A, de, 4)
    const dv = (await getPublicEventLive(A.tenantId, de))!
    check('double elim exposes a winners bracket', dv.matches.some((m) => m.side === 'winners'))
    check('…a losers bracket', dv.matches.some((m) => m.side === 'losers'))
    check('…and a final', dv.matches.some((m) => m.side === 'final'))
    check('…but never the internal next-match pointers', !JSON.stringify(dv).includes('winnerNextMatchId') && !JSON.stringify(dv).includes('winner_next_match_id'))

    // Byes must be visible as byes, not as blank matches.
    const se = await makeEvent(A, 'Bye Public', 'single_elim')
    await fillAndDraw(A, se, 5)
    const sv = (await getPublicEventLive(A.tenantId, se))!
    check('a 5-player draw shows 3 byes publicly', sv.matches.filter((m) => m.status === 'bye').length === 3)

    // Round robin — standings from the SHARED calculation.
    const rr = await makeEvent(A, 'RR Public', 'round_robin')
    await fillAndDraw(A, rr, 4)
    const rrm = (await owner.query<{ id: string }>(`select id from event_matches where event_id=$1 order by round, position`, [rr])).rows
    await withUser(A.userId, (tx) => recordMatchResult(tx, ctxFor(A), { matchId: rrm[0].id, scoreA: 10, scoreB: 3 }))
    const rv = (await getPublicEventLive(A.tenantId, rr))!
    check('round robin exposes standings', rv.standings.length === 4)
    check('…ranked 1..n', rv.standings.map((s) => s.rank).join() === '1,2,3,4')
    check('…with names', rv.standings.every((s) => s.name.length > 0))
    check('…and the win counted', rv.standings[0].won === 1 && rv.standings[0].pointsFor === 10)

    // The SHARED-logic guarantee: the staff reader must agree exactly.
    const { getEventBracket } = await import('../lib/events/bracket-service')
    const staff = await getEventBracket(ctxFor(A), rr)
    check(
      'public and staff standings are identical (one shared calculation)',
      JSON.stringify(staff.standings.map((s) => [s.registrationId, s.rank, s.won, s.pointsFor])) ===
        JSON.stringify(rv.standings.map((s) => [s.registrationId, s.rank, s.won, s.pointsFor])),
    )

    // Points.
    const pt = await makeEvent(A, 'Points Public', 'points')
    await fillAndDraw(A, pt, 3)
    const pm = (await owner.query<{ id: string }>(`select id from event_matches where event_id=$1 order by position`, [pt])).rows
    await withUser(A.userId, (tx) => recordMatchResult(tx, ctxFor(A), { matchId: pm[0].id, scoreA: 4, scoreB: null }))
    await withUser(A.userId, (tx) => recordMatchResult(tx, ctxFor(A), { matchId: pm[1].id, scoreA: 11, scoreB: null }))
    await withUser(A.userId, (tx) => recordMatchResult(tx, ctxFor(A), { matchId: pm[2].id, scoreA: 7, scoreB: null }))
    const pv = (await getPublicEventLive(A.tenantId, pt))!
    check('points exposes a ranked leaderboard', pv.standings.map((s) => s.pointsFor).join() === '11,7,4')
    check('…deterministically ranked', pv.standings.map((s) => s.rank).join() === '1,2,3')
  }

  // ════════════════════════════════════════════════════════════════════════
  section('7. the bracket-exists flag')
  {
    const bare = await makeEvent(A, 'No Draw', 'single_elim')
    check('an event with no draw reports false', (await publicEventHasBracket(A.tenantId, bare)) === false)
    check('…and its live view is readable but empty', ((await getPublicEventLive(A.tenantId, bare))?.matches.length ?? -1) === 0)
    await fillAndDraw(A, bare, 4)
    check('once drawn it reports true', (await publicEventHasBracket(A.tenantId, bare)) === true)
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
