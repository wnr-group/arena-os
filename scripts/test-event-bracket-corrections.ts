/**
 * Tournaments: score correction, forfeit/void/reopen, result gating, field-size
 * cap with batched insert, and public bracket names (migration 0178).
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs scripts/test-event-bracket-corrections.ts
 *
 * Real everything: the actual bracket service on the restricted role, the
 * actual constraints and policies, and the SQL function the public page reads.
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
  const {
    generateEventBracket,
    recordMatchResult,
    getEventBracket,
    correctMatchResult,
    forfeitMatch,
    voidMatch,
    reopenMatch,
  } = await import('../lib/events/bracket-service')
  const { claimEventRegistration, setEventPublicName } = await import('../lib/events/registrations')
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
      const m = await owner.query<{ id: string }>(
        `insert into memberships (tenant_id,user_id,role,status) values ($1,$2,$3::member_role,'active')
         on conflict (tenant_id,user_id) do update set role=excluded.role, status='active' returning id`,
        [tenantId, u.rows[0].id, role],
      )
      return { userId: u.rows[0].id, membershipId: m.rows[0].id }
    }
    const mgr = await mk(`mgr@${slug}.test`, 'manager')
    const cash = await mk(`cash@${slug}.test`, 'cashier')
    return { tenantId, branchId: b.rows[0].id, mgr, cash }
  }

  const A = await makeTenant('brktc-a')
  const B = await makeTenant('brktc-b')
  const ctxFor = (t: typeof A, who: { userId: string; membershipId: string }) =>
    ({
      user: { id: who.userId },
      tenant: { id: t.tenantId },
      membershipId: who.membershipId,
    }) as unknown as Parameters<typeof getEventBracket>[0]

  let seq = 0
  async function makeCustomer(tenantId: string, name: string) {
    seq++
    const r = await owner.query<{ id: string }>(
      `insert into customers (tenant_id,phone,name) values ($1,$2,$3) returning id`,
      [tenantId, `+9197${String(10000000 + seq).slice(0, 8)}`, name],
    )
    return r.rows[0].id
  }

  async function makeEvent(
    t: { tenantId: string; branchId: string },
    title: string,
    format: string | null,
    o: { capacity?: number | null; fee?: string } = {},
  ) {
    const r = await owner.query<{ id: string }>(
      `insert into events (tenant_id,branch_id,title,type,tournament_format,starts_at,ends_at,capacity,entry_fee,status)
       values ($1,$2,$3,$4::event_type,$5::tournament_format,
               now() + interval '1 day', now() + interval '1 day 4 hours',
               $6,$7,'registration_open') returning id`,
      [
        t.tenantId,
        t.branchId,
        title,
        format ? 'tournament' : 'class',
        format,
        o.capacity === undefined ? null : o.capacity,
        o.fee ?? '0',
      ],
    )
    return r.rows[0].id
  }

  /** Register n customers and check them all in, in order. Returns registration ids. */
  async function fillAndCheckIn(t: typeof A, eventId: string, n: number): Promise<string[]> {
    const regs: string[] = []
    for (let i = 0; i < n; i++) {
      const c = await makeCustomer(t.tenantId, `P${i + 1}`)
      const r = await claimEventRegistration(c, eventId, null)
      if (!r.ok) throw new Error(`claim refused: ${r.refusal}`)
      regs.push(r.registrationId)
      const tok = (
        await owner.query<{ t: string }>(
          'select check_in_token t from event_registrations where id=$1',
          [r.registrationId],
        )
      ).rows[0].t
      // Distinct check-in times, so the seeding order is unambiguous.
      await withUser(t.mgr.userId, (tx) => checkInByTokenCore(tx, { tenantId: t.tenantId }, tok))
      await owner.query(
        `update event_registrations set checked_in_at = now() + ($2 || ' seconds')::interval where id=$1`,
        [r.registrationId, String(i)],
      )
    }
    return regs
  }

  const matchesOf = async (eventId: string) =>
    (
      await owner.query(
        `select id, side::text, round, position, status::text, participant_a, participant_b,
                winner, score_a, score_b, winner_next_match_id, winner_next_slot,
                loser_next_match_id, loser_next_slot
           from event_matches where event_id=$1 order by side, round, position`,
        [eventId],
      )
    ).rows as Array<Record<string, string | number | null>>

  const gen = (t: typeof A, eventId: string) =>
    withUser(t.mgr.userId, (tx) => generateEventBracket(tx, ctxFor(t, t.mgr), eventId))
  const score = (t: typeof A, matchId: string, a: number, b: number | null) =>
    withUser(t.mgr.userId, (tx) =>
      recordMatchResult(tx, ctxFor(t, t.mgr), { matchId, scoreA: a, scoreB: b }),
    )


  // ── helpers for this suite ─────────────────────────────────────────────────
  const fix = (t: typeof A, matchId: string, a: number, b: number | null, cascade = false) =>
    withUser(t.mgr.userId, (tx) =>
      correctMatchResult(tx, ctxFor(t, t.mgr), { matchId, scoreA: a, scoreB: b, cascade }),
    )
  const forfeit = (t: typeof A, matchId: string, side: 'a' | 'b', cascade = false) =>
    withUser(t.mgr.userId, (tx) =>
      forfeitMatch(tx, ctxFor(t, t.mgr), { matchId, forfeitingSide: side, cascade }),
    )
  const voidIt = (t: typeof A, matchId: string) =>
    withUser(t.mgr.userId, (tx) => voidMatch(tx, ctxFor(t, t.mgr), { matchId }))
  const reopen = (t: typeof A, matchId: string, cascade = false) =>
    withUser(t.mgr.userId, (tx) => reopenMatch(tx, ctxFor(t, t.mgr), { matchId, cascade }))

  type M = Record<string, string | number | null>
  const at = (ms: M[], side: string, round: number, position: number) =>
    ms.find((m) => m.side === side && m.round === round && m.position === position)!
  const row = async (id: string) =>
    (
      await owner.query(
        `select status::text, participant_a, participant_b, winner, score_a, score_b, result_kind, completed_at
           from event_matches where id=$1`,
        [id],
      )
    ).rows[0] as M

  /** Score every READY match except those on the excluded sides, A winning. */
  async function playOut(t: typeof A, ev: string, skipSides: string[] = []) {
    for (let guard = 0; guard < 500; guard++) {
      const ready = (await matchesOf(ev)).find((m) => m.status === 'ready' && !skipSides.includes(m.side as string))
      if (!ready) return
      await score(t, ready.id as string, 5, 1)
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  section('1. correcting a single-elimination result')
  {
    const ev = await makeEvent(A, 'Corr Single', 'single_elim', { capacity: 10 })
    await fillAndCheckIn(A, ev, 4)
    await gen(A, ev)
    const ms = await matchesOf(ev)
    const m0 = at(ms, 'winners', 1, 0)
    const m1 = at(ms, 'winners', 1, 1)
    const fin = at(ms, 'winners', 2, 0)

    await score(A, m0.id as string, 7, 2) // A (m0.a) wins
    const wasWinner = (await row(m0.id as string)).winner
    check('setup: A won the first semi', wasWinner === m0.participant_a)
    check('…and was placed in the final', (await row(fin.id as string)).participant_a === wasWinner)

    // 1a. same winner, new score: only the numbers change
    const same = await fix(A, m0.id as string, 9, 1)
    const r1 = await row(m0.id as string)
    check('a score typo (same winner) is corrected', r1.score_a === 9 && r1.score_b === 1 && r1.winner === wasWinner)
    check('…without touching the final', (await row(fin.id as string)).participant_a === wasWinner && same.unwound === 0)

    // 1b. different winner while the final has not been played
    const flip = await fix(A, m0.id as string, 1, 6)
    const r2 = await row(m0.id as string)
    check('a mis-keyed WINNER is corrected', r2.winner === m0.participant_b && r2.status === 'completed')
    check('…the final now has the right entrant in the slot', (await row(fin.id as string)).participant_a === m0.participant_b)
    check('…and the wrong one is gone from it', (await row(fin.id as string)).participant_a !== wasWinner)
    check('…nothing later needed resetting', flip.unwound === 0)

    // 1c. downstream already played
    await score(A, m1.id as string, 3, 0)
    await score(A, fin.id as string, 4, 2)
    check('setup: final played', (await row(fin.id as string)).status === 'completed')

    const refused = await refusal(() => fix(A, m0.id as string, 6, 1))
    check('flipping a result that fed a PLAYED match is refused', refused !== null && /already been played/.test(refused), String(refused))
    const keep = await row(m0.id as string)
    check('…and nothing changed', keep.winner === m0.participant_b && (await row(fin.id as string)).status === 'completed')

    // …but fixing only the scoreline of that same match still works
    await fix(A, m0.id as string, 2, 8)
    check('a pure score fix is fine even after the final was played', (await row(m0.id as string)).score_b === 8 && (await row(fin.id as string)).status === 'completed')

    // 1d. cascade
    const casc = await fix(A, m0.id as string, 6, 1, true)
    const finAfter = await row(fin.id as string)
    check('with cascade the flip succeeds and reports what it reset', casc.unwound === 1, String(casc.unwound))
    check('…the final is cleared of its result', finAfter.winner === null && finAfter.score_a === null && finAfter.completed_at === null)
    check('…and holds the corrected entrant', finAfter.participant_a === m0.participant_a)
    check('…and is playable again (both slots filled)', finAfter.status === 'ready')
    await score(A, fin.id as string, 1, 0)
    check('…the final can be re-scored', (await row(fin.id as string)).status === 'completed')

    const aud = await owner.query(`select action from audit_log where tenant_id=$1 and action='match_result_corrected'`, [A.tenantId])
    check('corrections are audited', (aud.rowCount ?? 0) >= 3)
  }

  // ════════════════════════════════════════════════════════════════════════
  section('2. forfeit and reopen')
  {
    const ev = await makeEvent(A, 'Corr Forfeit', 'single_elim', { capacity: 10 })
    await fillAndCheckIn(A, ev, 4)
    await gen(A, ev)
    const ms = await matchesOf(ev)
    const m0 = at(ms, 'winners', 1, 0)
    const fin = at(ms, 'winners', 2, 0)

    const f = await forfeit(A, m0.id as string, 'a')
    const r = await row(m0.id as string)
    check('a forfeit awards the match to the other side', r.winner === m0.participant_b && r.status === 'completed')
    check('…recorded 0-0 and marked as a forfeit', r.score_a === 0 && r.score_b === 0 && r.result_kind === 'forfeit')
    check('…and the winner advances', f.advancedTo === fin.id && (await row(fin.id as string)).participant_a === m0.participant_b)

    // forfeit a played match the other way round
    await forfeit(A, m0.id as string, 'b')
    check('a completed match can be re-awarded', (await row(m0.id as string)).winner === m0.participant_a)
    check('…moving the right entrant forward', (await row(fin.id as string)).participant_a === m0.participant_a)

    // reopen
    const ro = await reopen(A, m0.id as string)
    const rr = await row(m0.id as string)
    check('reopen clears the result', rr.status === 'ready' && rr.winner === null && rr.score_a === null && rr.result_kind === 'played')
    check('…and takes the entrant back out of the final', (await row(fin.id as string)).participant_a === null && ro.unwound === 0)
    check('…leaving the final waiting', (await row(fin.id as string)).status === 'pending')

    // not scoreable
    check('a knockout match cannot be voided', /round-robin/i.test((await refusal(() => voidIt(A, m0.id as string))) ?? ''))
    check('an unplayed match cannot be corrected', /no result to correct/i.test((await refusal(() => fix(A, fin.id as string, 1, 0))) ?? ''))
    check('a match with undecided players cannot be forfeited', (await refusal(() => forfeit(A, fin.id as string, 'a'))) !== null)
  }

  // ════════════════════════════════════════════════════════════════════════
  section('3. double elimination — the grand-final reset')
  {
    const ev = await makeEvent(A, 'Corr Double', 'double_elim', { capacity: 10 })
    await fillAndCheckIn(A, ev, 4)
    await gen(A, ev)
    await playOut(A, ev, ['final'])
    const ms = await matchesOf(ev)
    const f1 = at(ms, 'final', 1, 0)
    const f2 = at(ms, 'final', 2, 0)
    check('setup: grand final is ready', f1.status === 'ready')

    await score(A, f1.id as string, 5, 1) // winners champion (A) wins → reset voided
    check('the reset is voided when the winners champion wins', (await row(f2.id as string)).status === 'void')

    await fix(A, f1.id as string, 1, 5) // losers champion actually won
    const r2 = await row(f2.id as string)
    check('correcting it to the other finalist revives the reset', r2.status === 'ready', String(r2.status))
    check('…with both finalists in it', r2.participant_a !== null && r2.participant_b !== null)

    await fix(A, f1.id as string, 5, 1)
    check('correcting back voids the reset again', (await row(f2.id as string)).status === 'void')
  }

  // ════════════════════════════════════════════════════════════════════════
  section('4. round robin: void, restore, standings')
  {
    const ev = await makeEvent(A, 'Corr RR', 'round_robin', { capacity: 10 })
    await fillAndCheckIn(A, ev, 4)
    await gen(A, ev)
    await playOut(A, ev)
    const ms = await matchesOf(ev)
    check('setup: all six fixtures played', ms.filter((m) => m.status === 'completed').length === 6)

    const target = ms[0]
    const before = (await getEventBracket(ctxFor(A, A.mgr), ev)).standings
    const playedBefore = before.reduce((n, s) => n + s.played, 0)
    await voidIt(A, target.id as string)
    check('a fixture can be voided', (await row(target.id as string)).status === 'void')
    const after = (await getEventBracket(ctxFor(A, A.mgr), ev)).standings
    check('…and drops out of the standings', after.reduce((n, s) => n + s.played, 0) === playedBefore - 2)
    check('…it cannot be scored while void', (await refusal(() => score(A, target.id as string, 1, 0))) !== null)

    await reopen(A, target.id as string)
    check('a voided fixture can be restored', (await row(target.id as string)).status === 'ready')
    await score(A, target.id as string, 3, 4)
    check('…and then scored', (await row(target.id as string)).winner === target.participant_b)

    await fix(A, target.id as string, 4, 3)
    check('a round-robin result flip needs no cascade', (await row(target.id as string)).winner === target.participant_a)
    check('a draw is still refused (not scored in the table)', /draw/i.test((await refusal(() => fix(A, target.id as string, 2, 2))) ?? ''))
  }

  // ════════════════════════════════════════════════════════════════════════
  section('5. results only while the event is open or running')
  {
    for (const [status, expect] of [
      ['draft', /open for registration or in progress/],
      ['published', /open for registration or in progress/],
      ['completed', /completed/],
      ['cancelled', /cancelled/],
    ] as const) {
      const ev = await makeEvent(A, `Gate ${status}`, 'single_elim', { capacity: 10 })
      await fillAndCheckIn(A, ev, 2)
      await gen(A, ev)
      const m = (await matchesOf(ev))[0]
      await owner.query(`update events set status=$2::event_status where id=$1`, [ev, status])
      check(`recording on a ${status} event is refused`, expect.test((await refusal(() => score(A, m.id as string, 1, 0))) ?? ''))
      await owner.query(`update events set status='registration_open' where id=$1`, [ev])
      await score(A, m.id as string, 1, 0)
      await owner.query(`update events set status=$2::event_status where id=$1`, [ev, status])
      check(`correcting on a ${status} event is refused`, (await refusal(() => fix(A, m.id as string, 0, 1))) !== null)
      check(`forfeiting on a ${status} event is refused`, (await refusal(() => forfeit(A, m.id as string, 'a'))) !== null)
    }
    for (const status of ['registration_open', 'full', 'in_progress'] as const) {
      const ev = await makeEvent(A, `Gate ok ${status}`, 'single_elim', { capacity: 10 })
      await fillAndCheckIn(A, ev, 2)
      await gen(A, ev)
      const m = (await matchesOf(ev))[0]
      await owner.query(`update events set status=$2::event_status where id=$1`, [ev, status])
      check(`recording on a ${status} event works`, (await refusal(() => score(A, m.id as string, 1, 0))) === null)
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  section('6. isolation and concurrency')
  {
    const ev = await makeEvent(A, 'Corr Iso', 'single_elim', { capacity: 10 })
    await fillAndCheckIn(A, ev, 4)
    await gen(A, ev)
    const ms = await matchesOf(ev)
    const m0 = at(ms, 'winners', 1, 0)
    const fin = at(ms, 'winners', 2, 0)
    await score(A, m0.id as string, 5, 1)

    check("another venue's manager cannot correct this match", /not found/i.test((await refusal(() => fix(B, m0.id as string, 0, 5))) ?? ''))
    check("…cannot forfeit it", (await refusal(() => forfeit(B, m0.id as string, 'a'))) !== null)
    check("…cannot reopen it", (await refusal(() => reopen(B, m0.id as string))) !== null)
    check('…and nothing changed', (await row(m0.id as string)).winner === m0.participant_a)

    // two opposing corrections at once: serialised by the event lock
    const results = await Promise.allSettled([
      fix(A, m0.id as string, 0, 5),
      fix(A, m0.id as string, 5, 0),
    ])
    check('concurrent corrections both complete without error', results.every((r) => r.status === 'fulfilled'))
    const after = await row(m0.id as string)
    const finRow = await row(fin.id as string)
    check('…and the final agrees with the match that fed it', finRow.participant_a === after.winner)
    const slots = await owner.query(
      `select count(*)::int n from event_matches where event_id=$1 and (participant_a=$2 or participant_b=$2)`,
      [ev, after.winner === m0.participant_a ? m0.participant_b : m0.participant_a],
    )
    check('…the losing entrant is not also in the final', (await row(fin.id as string)).participant_b !== (after.winner === m0.participant_a ? m0.participant_b : m0.participant_a) && slots.rowCount === 1)
  }

  // ════════════════════════════════════════════════════════════════════════
  section('7. field size cap and batched insert')
  {
    /** n checked-in registrations created set-based, so a large field is cheap. */
    async function bulkField(ev: string, n: number) {
      await owner.query(
        `with c as (
           insert into customers (tenant_id, phone, name)
           select $1, '+9196' || lpad((900000 + g)::text, 8, '0'), 'Bulk ' || g from generate_series(1, $3::int) g
           on conflict do nothing returning id
         )
         insert into event_registrations (tenant_id,event_id,customer_id,status,registered_at,checked_in_at)
         select $1, $2, c.id, 'checked_in', now(), now() + (row_number() over ())::int * interval '1 second' from c`,
        [A.tenantId, ev, n],
      )
    }

    const big = await makeEvent(A, 'RR 129', 'round_robin', { capacity: null })
    await bulkField(big, 129)
    const msg = await refusal(() => gen(A, big))
    check('a 129-player round robin is refused with a clear message', msg !== null && /at most 128/.test(msg), String(msg))
    check('…and writes nothing', (await matchesOf(big)).length === 0)

    await owner.query('delete from event_registrations where event_id=$1', [big])
    await owner.query('delete from customers where tenant_id=$1 and name like $2', [A.tenantId, 'Bulk %'])
    const edge = await makeEvent(A, 'RR 128', 'round_robin', { capacity: null })
    await bulkField(edge, 128)
    const ok = await gen(A, edge)
    check('a 128-player round robin (8,128 matches) is generated across batched inserts', ok.matches === 8128, String(ok.matches))
    check('…every match is stored', (await matchesOf(edge)).length === 8128)

    await owner.query('delete from events where id = any($1)', [[big, edge]])
    await owner.query('delete from customers where tenant_id=$1 and name like $2', [A.tenantId, 'Bulk %'])
  }

  // ════════════════════════════════════════════════════════════════════════
  section('8. public names default to initials')
  {
    const ev = await makeEvent(A, 'Names', 'single_elim', { capacity: 10 })
    const regs = await fillAndCheckIn(A, ev, 2)
    await owner.query(`update customers set name='Priya Sharma Rao' where id=(select customer_id from event_registrations where id=$1)`, [regs[0]])
    await owner.query(`update customers set name='Madonna' where id=(select customer_id from event_registrations where id=$1)`, [regs[1]])
    await gen(A, ev)

    const names = async () => {
      const c = owner
      try {
        await c.query('begin')
        await c.query(`select set_config('app.public_tenant_id', $1, true)`, [A.tenantId])
        const r = await c.query(`select registration_id, display_name from public.public_event_participants($1::uuid)`, [ev])
        await c.query('rollback')
        return new Map(r.rows.map((x: { registration_id: string; display_name: string }) => [x.registration_id, x.display_name]))
      } finally {
        void 0
      }
    }
    let n = await names()
    check('a multi-word name is shown as initials only', n.get(regs[0]) === 'P. S. R.', String(n.get(regs[0])))
    check('a single name is shown as one initial', n.get(regs[1]) === 'M.', String(n.get(regs[1])))
    check('the full name appears nowhere', ![...n.values()].some((v) => /priya|sharma|madonna/i.test(v)))

    const custId = (await owner.query(`select customer_id c from event_registrations where id=$1`, [regs[0]])).rows[0].c
    check('the customer can opt in to a display name', (await setEventPublicName(custId, regs[0], '  PriyaS  ')) === 'saved')
    n = await names()
    check('…which then replaces the initials', n.get(regs[0]) === 'PriyaS', String(n.get(regs[0])))
    check("another customer cannot set it", (await setEventPublicName(
      (await owner.query(`select customer_id c from event_registrations where id=$1`, [regs[1]])).rows[0].c, regs[0], 'Hacked')) === 'not_found')
    check('…and it is unchanged', (await names()).get(regs[0]) === 'PriyaS')
    check('a name over 40 characters is refused', (await setEventPublicName(custId, regs[0], 'x'.repeat(41))) === 'too_long')
    await setEventPublicName(custId, regs[0], '')
    check('clearing it returns to initials', (await names()).get(regs[0]) === 'P. S. R.')

    // a team still shows its team name
    const tev = await makeEvent(A, 'Names Team', 'single_elim', { capacity: 10 })
    await owner.query(`update events set registration_mode='team', team_size=2 where id=$1`, [tev])
    const tc = await makeCustomer(A.tenantId, 'Real Person')
    const tr = await claimEventRegistration(tc, tev, 'Thunder')
    const tc2 = await makeCustomer(A.tenantId, 'Other Person')
    const tr2 = await claimEventRegistration(tc2, tev, 'Lightning')
    if (!tr.ok || !tr2.ok) throw new Error('team claims failed')
    for (const x of [tr, tr2]) {
      await owner.query(`update event_registrations set status='checked_in', checked_in_at=now() where id=$1`, [x.registrationId])
    }
    await gen(A, tev)
    const tn = await (async () => {
      const c = owner
      try {
        await c.query('begin')
        await c.query(`select set_config('app.public_tenant_id', $1, true)`, [A.tenantId])
        const r = await c.query(`select display_name from public.public_event_participants($1::uuid)`, [tev])
        await c.query('rollback')
        return r.rows.map((x: { display_name: string }) => x.display_name).sort()
      } finally {
        void 0
      }
    })()
    check('a team shows its team name, not its members', tn.join() === 'Lightning,Thunder', tn.join())
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
