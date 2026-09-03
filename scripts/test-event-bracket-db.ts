/**
 * M15 #6 — bracket persistence, advancement, concurrency and isolation.
 *
 *   npx tsx --import ./scripts/server-only-hook.mjs scripts/test-event-bracket-db.ts
 *
 * The PURE engine is tested without a database in scripts/test-event-bracket.ts
 * (305 assertions). This suite covers the half that needs one: writing a draw,
 * following the advancement pointers, the transaction boundaries, and RLS.
 *
 * Everything real: migration 0086, the constraints, the policies, the actual
 * generateEventBracket / recordMatchResult / resetEventBracket, and the actual
 * check-in path that produces the participants. Nothing is stubbed.
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
  const { generateEventBracket, recordMatchResult, resetEventBracket, getEventBracket } =
    await import('../lib/events/bracket-service')
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

  const A = await makeTenant('brkt-a')
  const B = await makeTenant('brkt-b')
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

  // ════════════════════════════════════════════════════════════════════════
  section('1. generation uses the CHECKED-IN list only')
  {
    const ev = await makeEvent(A, 'Only Checked In', 'single_elim', { capacity: 10 })
    const checkedIn = await fillAndCheckIn(A, ev, 4)

    // A cancelled entry, a waitlisted one, and a still-registered (arrived-not) one.
    const cx = await makeCustomer(A.tenantId, 'Cancelled')
    const cxr = await claimEventRegistration(cx, ev, null)
    if (cxr.ok) await owner.query(`update event_registrations set status='cancelled', cancelled_at=now() where id=$1`, [cxr.registrationId])
    const nx = await makeCustomer(A.tenantId, 'NoShow')
    await claimEventRegistration(nx, ev, null) // stays 'registered' — never arrived

    const r = await gen(A, ev)
    check('generation reports the format and counts', r.format === 'single_elim' && r.participants === 4)
    const ms = await matchesOf(ev)
    check('a 4-player single-elim draw is 3 matches', ms.length === 3, String(ms.length))

    const placed = new Set(ms.flatMap((m) => [m.participant_a, m.participant_b]).filter(Boolean))
    check('only checked-in participants are drawn', [...placed].every((p) => checkedIn.includes(p as string)))
    check('…the cancelled entry is absent', !placed.has(cxr.ok ? cxr.registrationId : ''))
    check('…and the registered-but-not-arrived entry is absent', placed.size === 4)
  }

  // ════════════════════════════════════════════════════════════════════════
  section('2. generation is idempotent and never destroys results')
  {
    const ev = await makeEvent(A, 'Idempotent', 'single_elim', { capacity: 10 })
    await fillAndCheckIn(A, ev, 4)
    await gen(A, ev)
    const before = (await matchesOf(ev)).length

    const second = await refusal(() => gen(A, ev))
    check('a second generation is REFUSED', second !== null)
    check('…saying a bracket already exists', (second ?? '').includes('already exists'))
    check('…and no rows were added', (await matchesOf(ev)).length === before)

    // Two managers racing.
    const ev2 = await makeEvent(A, 'Race Gen', 'single_elim', { capacity: 10 })
    await fillAndCheckIn(A, ev2, 4)
    const both = await Promise.allSettled([gen(A, ev2), gen(A, ev2)])
    check('two concurrent generations: exactly one succeeds', both.filter((x) => x.status === 'fulfilled').length === 1)
    check('…and the draw is not doubled', (await matchesOf(ev2)).length === 3, String((await matchesOf(ev2)).length))

    // Reset while untouched, then regenerate.
    const removed = await withUser(A.mgr.userId, (tx) => resetEventBracket(tx, ctxFor(A, A.mgr), ev2))
    check('an unplayed bracket can be reset', removed === 3)
    check('…leaving nothing behind', (await matchesOf(ev2)).length === 0)
    await gen(A, ev2)
    check('…and can then be redrawn', (await matchesOf(ev2)).length === 3)

    // Reset AFTER a result is refused.
    const ready = (await matchesOf(ev2)).find((m) => m.status === 'ready')!
    await score(A, ready.id as string, 5, 3)
    const blocked = await refusal(() => withUser(A.mgr.userId, (tx) => resetEventBracket(tx, ctxFor(A, A.mgr), ev2)))
    check('reset is REFUSED once a result exists', blocked !== null)
    check('…and the played match survives', (await matchesOf(ev2)).some((m) => m.status === 'completed'))
  }

  // ════════════════════════════════════════════════════════════════════════
  section('3. score entry and advancement')
  {
    const ev = await makeEvent(A, 'Advance', 'single_elim', { capacity: 10 })
    const regs = await fillAndCheckIn(A, ev, 4)
    await gen(A, ev)
    let ms = await matchesOf(ev)

    const r1 = ms.filter((m) => m.round === 1).sort((a, b) => (a.position as number) - (b.position as number))
    check('round 1 has two ready matches', r1.length === 2 && r1.every((m) => m.status === 'ready'))

    // A wins the first.
    const m0 = r1[0]
    const out0 = await score(A, m0.id as string, 10, 7)
    check('the server derives the winner from the scores', out0.winner === m0.participant_a)
    check('…and reports where they advanced', out0.advancedTo === m0.winner_next_match_id)

    ms = await matchesOf(ev)
    const next = ms.find((m) => m.id === m0.winner_next_match_id)!
    const slot = m0.winner_next_slot === 'a' ? 'participant_a' : 'participant_b'
    check('the winner lands in the STORED next slot', next[slot] === m0.participant_a)
    check('…and the other slot is still empty', next[slot === 'participant_a' ? 'participant_b' : 'participant_a'] === null)
    check('…so the final is still waiting', next.status === 'pending')

    // B wins the second — the other direction.
    const m1 = r1[1]
    const out1 = await score(A, m1.id as string, 2, 9)
    check('the lower score loses: B advances', out1.winner === m1.participant_b)

    ms = await matchesOf(ev)
    const fin = ms.find((m) => m.round === 2)!
    check('both winners are now in the final', fin.participant_a !== null && fin.participant_b !== null)
    check('…and it has opened for scoring', fin.status === 'ready')
    check('…with exactly the two match winners', [fin.participant_a, fin.participant_b].sort().join() === [m0.participant_a, m1.participant_b].sort().join())

    // The tournament resolves.
    await score(A, fin.id as string, 3, 1)
    ms = await matchesOf(ev)
    check('the final completes', ms.find((m) => m.id === fin.id)!.status === 'completed')
    check('…and every match is played', ms.filter((m) => m.status === 'completed').length === 3)
    check('…the champion is one of the checked-in four', regs.includes(ms.find((m) => m.id === fin.id)!.winner as string))
  }

  // ════════════════════════════════════════════════════════════════════════
  section('4. result validation')
  {
    const ev = await makeEvent(A, 'Validation', 'single_elim', { capacity: 10 })
    await fillAndCheckIn(A, ev, 4)
    await gen(A, ev)
    const ms = await matchesOf(ev)
    const ready = ms.filter((m) => m.status === 'ready')[0]
    const pending = ms.find((m) => m.status === 'pending')!

    check('a tie is refused', (await refusal(() => score(A, ready.id as string, 4, 4))) !== null)
    check('a negative score is refused', (await refusal(() => score(A, ready.id as string, -1, 4))) !== null)
    check('a fractional score is refused', (await refusal(() => score(A, ready.id as string, 1.5, 4))) !== null)
    check('a missing opponent score is refused', (await refusal(() => score(A, ready.id as string, 4, null))) !== null)
    check('a match with undetermined participants is refused', (await refusal(() => score(A, pending.id as string, 4, 1))) !== null)
    check('…and none of those wrote anything', (await matchesOf(ev)).every((m) => m.status !== 'completed'))

    await score(A, ready.id as string, 6, 1)
    const again = await refusal(() => score(A, ready.id as string, 1, 6))
    check('an already-completed match cannot be scored again', again !== null)
    check('…and the ORIGINAL result stands', (await matchesOf(ev)).find((m) => m.id === ready.id)!.winner === ready.participant_a)

    const unknown = await refusal(() => score(A, '00000000-0000-4000-8000-000000000000', 1, 0))
    check('an unknown match id is refused', unknown !== null)
  }

  // ════════════════════════════════════════════════════════════════════════
  section('5. byes advance without a score')
  {
    const ev = await makeEvent(A, 'Byes', 'single_elim', { capacity: 10 })
    await fillAndCheckIn(A, ev, 5)
    await gen(A, ev)
    const ms = await matchesOf(ev)

    const byes = ms.filter((m) => m.status === 'bye')
    check('5 players in an 8 draw produce 3 byes', byes.length === 3, String(byes.length))
    check('…each with exactly one participant', byes.every((m) => (m.participant_a === null) !== (m.participant_b === null)))
    check('…and no score', byes.every((m) => m.score_a === null && m.score_b === null))

    // Each bye survivor is already sitting in round 2.
    check('every bye survivor is already placed in the next round', byes.every((m) => {
      const next = ms.find((x) => x.id === m.winner_next_match_id)!
      const slot = m.winner_next_slot === 'a' ? 'participant_a' : 'participant_b'
      return next[slot] === (m.participant_a ?? m.participant_b)
    }))

    check('a bye cannot be scored', (await refusal(() => score(A, byes[0].id as string, 1, 0))) !== null)
    check('…with a message saying so', ((await refusal(() => score(A, byes[0].id as string, 1, 0))) ?? '').toLowerCase().includes('bye'))

    // No fake participants anywhere.
    const ids = new Set(ms.flatMap((m) => [m.participant_a, m.participant_b]).filter(Boolean))
    const real = (
      await owner.query<{ id: string }>('select id from event_registrations where event_id=$1', [ev])
    ).rows.map((r) => r.id)
    check('no invented participant exists', [...ids].every((i) => real.includes(i as string)))
  }

  // ════════════════════════════════════════════════════════════════════════
  section('6. double elimination — loser routing and the grand final')
  {
    const ev = await makeEvent(A, 'Double', 'double_elim', { capacity: 10 })
    await fillAndCheckIn(A, ev, 4)
    await gen(A, ev)
    let ms = await matchesOf(ev)

    check('a winners bracket exists', ms.some((m) => m.side === 'winners'))
    check('…a losers bracket too', ms.some((m) => m.side === 'losers'))
    check('…and a grand final plus its reset', ms.filter((m) => m.side === 'final').length === 2)
    check('every winners-bracket match routes its loser', ms.filter((m) => m.side === 'winners').every((m) => m.loser_next_match_id !== null))
    check('losers-bracket matches do not (they eliminate)', ms.filter((m) => m.side === 'losers').every((m) => m.loser_next_match_id === null))

    const wb1 = ms.filter((m) => m.side === 'winners' && m.round === 1).sort((a, b) => (a.position as number) - (b.position as number))
    const out = await score(A, wb1[0].id as string, 9, 4)
    check('the loser is routed exactly once', out.loserRoutedTo === wb1[0].loser_next_match_id)

    ms = await matchesOf(ev)
    const lbTarget = ms.find((m) => m.id === wb1[0].loser_next_match_id)!
    const lslot = wb1[0].loser_next_slot === 'a' ? 'participant_a' : 'participant_b'
    check('…into the losers-bracket slot the topology named', lbTarget[lslot] === wb1[0].participant_b)
    check('the winner still went to the winners bracket', ms.find((m) => m.id === wb1[0].winner_next_match_id)![wb1[0].winner_next_slot === 'a' ? 'participant_a' : 'participant_b'] === wb1[0].participant_a)

    // A participant must never sit in two live matches at once.
    const live = ms.filter((m) => m.status === 'ready' || m.status === 'pending')
    const occupants = live.flatMap((m) => [m.participant_a, m.participant_b]).filter(Boolean)
    check('nobody occupies two live matches at once', new Set(occupants).size === occupants.length, occupants.join(','))

    // Play it out far enough to reach the grand final.
    await score(A, wb1[1].id as string, 8, 2)
    ms = await matchesOf(ev)
    for (let guard = 0; guard < 12; guard++) {
      const next = (await matchesOf(ev)).find((m) => m.status === 'ready' && m.side !== 'final')
      if (!next) break
      await score(A, next.id as string, 5, 1) // slot A always wins
    }
    ms = await matchesOf(ev)
    const gf = ms.find((m) => m.side === 'final' && m.round === 1)!
    check('the grand final fills from both brackets', gf.participant_a !== null && gf.participant_b !== null, `${gf.participant_a},${gf.participant_b}`)

    // WB champion (slot a) wins → the reset must be VOIDED, not left waiting.
    await score(A, gf.id as string, 7, 3)
    ms = await matchesOf(ev)
    const reset = ms.find((m) => m.side === 'final' && m.round === 2)!
    check('the winners-bracket champion winning ENDS it — the reset is voided', reset.status === 'void')
    check('…and nobody is sitting in the voided reset', reset.participant_a === null && reset.participant_b === null)
  }

  {
    // The other branch of the documented rule: LB champion wins GF1 → reset is played.
    const ev = await makeEvent(A, 'Double Reset', 'double_elim', { capacity: 10 })
    await fillAndCheckIn(A, ev, 4)
    await gen(A, ev)
    for (let guard = 0; guard < 12; guard++) {
      const next = (await matchesOf(ev)).find((m) => m.status === 'ready' && m.side !== 'final')
      if (!next) break
      await score(A, next.id as string, 5, 1)
    }
    const gf = (await matchesOf(ev)).find((m) => m.side === 'final' && m.round === 1)!
    // Slot B — the losers-bracket champion — wins.
    await score(A, gf.id as string, 1, 9)
    const reset = (await matchesOf(ev)).find((m) => m.side === 'final' && m.round === 2)!
    check('the losers-bracket champion winning forces the RESET', reset.status !== 'void')
    check('…with both finalists in it', reset.participant_a !== null && reset.participant_b !== null)
    check('…the GF winner in slot a', reset.participant_a === gf.participant_b)
  }

  // ════════════════════════════════════════════════════════════════════════
  section('7. round robin and points')
  {
    const rr = await makeEvent(A, 'RR', 'round_robin', { capacity: 10 })
    await fillAndCheckIn(A, rr, 4)
    await gen(A, rr)
    const ms = await matchesOf(rr)
    check('4 players produce 6 round-robin pairings', ms.length === 6, String(ms.length))
    check('…all immediately playable', ms.every((m) => m.status === 'ready'))
    check('…none routes anywhere', ms.every((m) => m.winner_next_match_id === null))
    const pairs = ms.map((m) => [m.participant_a, m.participant_b].sort().join('|'))
    check('…with no duplicate pairing', new Set(pairs).size === 6)

    await score(A, ms[0].id as string, 10, 4)
    const view = await getEventBracket(ctxFor(A, A.mgr), rr)
    check('standings are produced for round robin', view.standings.length === 4)
    check('…and the winner leads', view.standings[0].registrationId === ms[0].participant_a)

    const pts = await makeEvent(A, 'Points', 'points', { capacity: 10 })
    await fillAndCheckIn(A, pts, 3)
    await gen(A, pts)
    const pm = await matchesOf(pts)
    check('points produces one card per participant', pm.length === 3)
    check('…each with no opponent', pm.every((m) => m.participant_b === null))

    await score(A, pm[0].id as string, 5, null)
    await score(A, pm[1].id as string, 12, null)
    await score(A, pm[2].id as string, 9, null)
    const pv = await getEventBracket(ctxFor(A, A.mgr), pts)
    check('points standings rank by points scored', pv.standings.map((s) => s.pointsFor).join() === '12,9,5')
    check('…and no card has a winner', (await matchesOf(pts)).every((m) => m.winner === null))
  }

  // ════════════════════════════════════════════════════════════════════════
  section('8. concurrency')
  {
    const ev = await makeEvent(A, 'Race Score', 'single_elim', { capacity: 10 })
    await fillAndCheckIn(A, ev, 4)
    await gen(A, ev)
    const ready = (await matchesOf(ev)).filter((m) => m.status === 'ready')[0]

    // Two staff submitting the SAME match, with OPPOSITE results.
    const both = await Promise.allSettled([
      score(A, ready.id as string, 10, 1),
      score(A, ready.id as string, 1, 10),
    ])
    check('exactly one submission succeeds', both.filter((x) => x.status === 'fulfilled').length === 1)

    const after = (await matchesOf(ev)).find((m) => m.id === ready.id)!
    check('…the match has exactly one winner', after.winner !== null && after.status === 'completed')
    check('…and it is one of the two participants', [after.participant_a, after.participant_b].includes(after.winner))

    // The winner must appear exactly once in the next match — not twice.
    const next = (await matchesOf(ev)).find((m) => m.id === ready.winner_next_match_id)!
    const occupants = [next.participant_a, next.participant_b].filter(Boolean)
    check('…and advanced exactly once', occupants.length === 1 && occupants[0] === after.winner)
  }

  // ════════════════════════════════════════════════════════════════════════
  section('9. authorization and tenant isolation')
  {
    const ev = await makeEvent(A, 'Isolation', 'single_elim', { capacity: 10 })
    await fillAndCheckIn(A, ev, 4)
    await gen(A, ev)
    const ready = (await matchesOf(ev)).filter((m) => m.status === 'ready')[0]

    // Tenant B cannot see A's matches at all.
    const seen = await withUser(B.mgr.userId, (tx) =>
      tx.execute(sql`select count(*)::int n from event_matches where event_id = ${ev}::uuid`),
    )
    check("tenant B cannot read tenant A's matches", Number((seen.rows[0] as { n: number }).n) === 0)

    const bView = await getEventBracket(ctxFor(B, B.mgr), ev)
    check("…nor through the reader", bView.matches.length === 0)

    // B cannot score A's match — the row is invisible under B's tenant predicate.
    const bScore = await refusal(() =>
      withUser(B.mgr.userId, (tx) =>
        recordMatchResult(tx, ctxFor(B, B.mgr), { matchId: ready.id as string, scoreA: 1, scoreB: 0 }),
      ),
    )
    check("tenant B cannot score tenant A's match", bScore !== null)
    check('…and the match is untouched', (await matchesOf(ev)).find((m) => m.id === ready.id)!.status === 'ready')

    // B cannot generate for A's event.
    const bGen = await refusal(() =>
      withUser(B.mgr.userId, (tx) => generateEventBracket(tx, ctxFor(B, B.mgr), ev)),
    )
    check("tenant B cannot generate for tenant A's event", bGen !== null)

    // A CASHIER may read but not write — event_matches_manager_write.
    const cashierRead = await withUser(A.cash.userId, (tx) =>
      tx.execute(sql`select count(*)::int n from event_matches where event_id = ${ev}::uuid`),
    )
    check('a cashier of the tenant CAN read the draw', Number((cashierRead.rows[0] as { n: number }).n) > 0)
    const cashierWrote = await withUser(A.cash.userId, (tx) =>
      tx.execute(sql`update event_matches set score_a = 99 where id = ${ready.id}::uuid returning id`),
    )
    check('…but cannot write a score', cashierWrote.rows.length === 0)

    // Cross-tenant participant ids are structurally impossible — proven with a
    // REAL tenant-B registration, on the OWNER connection (which bypasses RLS),
    // so the only thing that can refuse it is the composite foreign key.
    const bEvent = await makeEvent(B, 'B Event', 'single_elim', { capacity: 4 })
    const bRegs = await fillAndCheckIn(B, bEvent, 2)
    check('tenant B has a real registration to attempt with', bRegs.length === 2)

    const crossFk = await refusal(() =>
      owner.query(`update event_matches set participant_a=$2 where id=$1`, [ready.id, bRegs[0]]),
    )
    check("a cross-tenant participant id is refused by the composite FK", crossFk !== null)
    check('…even on the RLS-bypassing owner connection', (crossFk ?? '').includes('event_matches_a_fk') || (crossFk ?? '').toLowerCase().includes('foreign key'), String(crossFk))
    check("…and tenant A's match still holds its own participant", (await matchesOf(ev)).find((m) => m.id === ready.id)!.participant_a === ready.participant_a)
  }

  // ════════════════════════════════════════════════════════════════════════
  section('10. constraints and audit')
  {
    const ev = await makeEvent(A, 'Constraints', 'single_elim', { capacity: 10 })
    await fillAndCheckIn(A, ev, 4)
    await gen(A, ev)
    const ms = await matchesOf(ev)
    const m = ms.filter((x) => x.status === 'ready')[0]

    check('duplicate coordinates are refused', (await refusal(() =>
      owner.query(
        `insert into event_matches (tenant_id,event_id,side,round,position)
         values ($1,$2,'winners',1,$3)`,
        [A.tenantId, ev, m.position],
      ),
    )) !== null)

    check('a self-pairing is refused', (await refusal(() =>
      owner.query(`update event_matches set participant_b = participant_a where id=$1`, [m.id]),
    )) !== null)

    // Somebody from a DIFFERENT match in the same event — a real registration,
    // so only the winner-is-a-participant CHECK can be what refuses it.
    const outsider = ms.find((x) => x.id !== m.id && x.participant_a)!.participant_a
    check('a winner who is not a participant is refused', (await refusal(() =>
      owner.query(
        `update event_matches set status='completed', completed_at=now(), score_a=1, winner=$2 where id=$1`,
        [m.id, outsider],
      ),
    )) !== null)

    check('a negative score is refused by the CHECK', (await refusal(() =>
      owner.query(`update event_matches set score_a=-1 where id=$1`, [m.id]),
    )) !== null)

    await score(A, m.id as string, 7, 2)
    const audit = await owner.query<{ action: string; entity_type: string }>(
      `select action, entity_type from audit_log where tenant_id=$1 and entity_type='event_match' order by created_at`,
      [A.tenantId],
    )
    check('bracket generation is audited', audit.rows.some((r) => r.action === 'bracket_generated'))
    check('…and each result is audited', audit.rows.some((r) => r.action === 'match_result_recorded'))
    check('…into audit_log, not a second table', audit.rows.every((r) => r.entity_type === 'event_match'))
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
