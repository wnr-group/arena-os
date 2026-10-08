/**
 * The bracket engine (M15 #6) — PURE unit tests. No database.
 *
 *   npx tsx scripts/test-event-bracket.ts
 *
 * Like scripts/test-pricing.ts and scripts/test-events.ts, this drives the real
 * functions in lib/events/bracket.ts directly. There is no db, no server-only
 * hook and no fixture: the engine takes participants and returns matches, which
 * is exactly why bracket maths was kept out of the actions and the components.
 *
 * The invariant checks matter more than the example checks here — bracket maths
 * breaks on edge cases (5 players, 3 players, the losers-bracket drop), so the
 * structural properties are asserted for EVERY size in a range rather than for
 * one hand-picked case.
 */
import {
  BracketError,
  bracketSize,
  computeStandings,
  decideWinner,
  generateBracket,
  generateDoubleElimination,
  generatePoints,
  generateRoundRobin,
  generateSingleElimination,
  seedParticipants,
  seedSlots,
  type BracketParticipant,
  type GeneratedMatch,
} from '../lib/events/bracket'

let pass = 0,
  fail = 0
const check = (l: string, c: boolean, extra?: string) => {
  console.log(`${c ? '✓' : '✗ FAIL'}  ${l}${c ? '' : extra ? `  → ${extra}` : ''}`)
  if (c) pass++
  else fail++
}
const section = (s: string) => console.log(`\n── ${s} ──`)

/** n participants, checked in one minute apart, so arrival order is unambiguous. */
function people(n: number, opts: { teams?: boolean } = {}): BracketParticipant[] {
  return Array.from({ length: n }, (_, i) => ({
    registrationId: `r${String(i + 1).padStart(2, '0')}`,
    teamId: opts.teams ? `t${String(i + 1).padStart(2, '0')}` : null,
    checkedInAt: new Date(Date.UTC(2031, 0, 1, 10, i)),
  }))
}

const threw = (fn: () => unknown): string | null => {
  try {
    fn()
    return null
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}

const find = (ms: GeneratedMatch[], side: string, round: number, position: number) =>
  ms.find((m) => m.side === side && m.round === round && m.position === position)

// ══════════════════════════════════════════════════════════════════════════
section('1. seeding is deterministic and total')
{
  const shuffled = [people(4)[2], people(4)[0], people(4)[3], people(4)[1]]
  const seeded = seedParticipants(shuffled)
  check('input order is ignored — arrival order decides', seeded.map((p) => p.registrationId).join() === 'r01,r02,r03,r04')

  const again = seedParticipants([...shuffled].reverse())
  check('…so the same set always seeds identically', again.map((p) => p.registrationId).join() === seeded.map((p) => p.registrationId).join())

  // Identical timestamps must still produce a total order.
  const tied: BracketParticipant[] = [
    { registrationId: 'rB', teamId: null, checkedInAt: new Date(0) },
    { registrationId: 'rA', teamId: null, checkedInAt: new Date(0) },
  ]
  check('a timestamp tie breaks on registration id', seedParticipants(tied).map((p) => p.registrationId).join() === 'rA,rB')

  check('a duplicate participant is refused', threw(() => seedParticipants([...people(2), people(2)[0]])) !== null)
  const dupTeam: BracketParticipant[] = [
    { registrationId: 'r1', teamId: 'tX', checkedInAt: new Date(1) },
    { registrationId: 'r2', teamId: 'tX', checkedInAt: new Date(2) },
  ]
  check('a team entered twice is refused', threw(() => seedParticipants(dupTeam)) !== null)

  check('a team event seeds one participant per TEAM', seedParticipants(people(4, { teams: true })).length === 4)

  check('bracketSize rounds up to a power of two', [1, 2, 3, 5, 8, 9].map(bracketSize).join() === '1,2,4,8,8,16')
  // Asserted as PROPERTIES rather than a literal slot string. The pairings and
  // the half-assignments are what make a draw correct; the order in which the
  // bottom-half matches happen to be listed is presentation, and pinning it
  // would be a test of the implementation rather than of the bracket.
  const pairsOf = (size: number) => {
    const o = seedSlots(size)
    const out: [number, number][] = []
    for (let i = 0; i < size; i += 2) out.push([o[i], o[i + 1]])
    return out
  }
  check('seedSlots(4) draws 1v4 and 2v3', JSON.stringify(pairsOf(4).map((p) => p.sort((x, y) => x - y))) === JSON.stringify([[1, 4], [2, 3]]))
  check('seedSlots(8) draws 1v8, 4v5, 2v7, 3v6', (() => {
    const got = pairsOf(8).map((p) => p.slice().sort((x, y) => x - y).join('v')).sort()
    return got.join() === '1v8,2v7,3v6,4v5'
  })())
  check('every first-round pair sums to size+1 — the mirror draw', [4, 8, 16, 32].every((size) => pairsOf(size).every(([x, y]) => x + y === size + 1)))
  check('each seed appears exactly once', [4, 8, 16].every((size) => new Set(seedSlots(size)).size === size))
  check('…and seeds 1 and 2 can only meet in the final', [4, 8, 16, 32].every((size) => {
    const o = seedSlots(size)
    return Math.floor(o.indexOf(1) / (size / 2)) !== Math.floor(o.indexOf(2) / (size / 2))
  }))
  check('…and seeds 1 and 3 cannot meet before the semi-final', (() => {
    const o = seedSlots(16)
    return Math.floor(o.indexOf(1) / 4) !== Math.floor(o.indexOf(3) / 4)
  })())
}

// ══════════════════════════════════════════════════════════════════════════
section('2. single elimination — every size 2..16')
{
  check('1 participant is refused', threw(() => generateSingleElimination(people(1))) !== null)

  for (let n = 2; n <= 16; n++) {
    const ms = generateSingleElimination(people(n))
    const size = bracketSize(n)
    const r1 = ms.filter((m) => m.round === 1)

    const label = `n=${String(n).padStart(2)}`
    check(`${label}: first round has size/2 slots (power of two)`, r1.length === size / 2)
    check(`${label}: rounds = log2(size)`, Math.max(...ms.map((m) => m.round)) === Math.log2(size))
    check(`${label}: exactly ${size - n} byes`, r1.filter((m) => m.status === 'bye').length === size - n)

    // Every participant appears exactly once in round 1.
    const placed = r1.flatMap((m) => [m.a, m.b]).filter((x): x is string => x !== null)
    check(`${label}: every participant appears exactly once in round 1`, new Set(placed).size === n && placed.length === n)

    // Nobody plays themselves, anywhere.
    check(`${label}: no self-pairing`, ms.every((m) => m.a === null || m.b === null || m.a !== m.b))

    // Exactly one terminal match.
    check(`${label}: exactly one final`, ms.filter((m) => m.winnerTo === null).length === 1)

    // A bye's survivor is already sitting in the next round.
    const byes = r1.filter((m) => m.status === 'bye')
    check(
      `${label}: every bye survivor is pre-placed in round 2`,
      byes.every((m) => {
        const who = m.a ?? m.b
        const next = find(ms, 'winners', 2, m.winnerTo!.key.position)
        return next ? next[m.winnerTo!.slot] === who : false
      }),
    )

    // A bye is never scoreable and never has two participants.
    check(`${label}: a bye has exactly one participant`, byes.every((m) => (m.a === null) !== (m.b === null)))
  }
}

// ══════════════════════════════════════════════════════════════════════════
section('3. single elimination — the worked cases the ticket names')
{
  const two = generateSingleElimination(people(2))
  check('2 players: one match, no byes', two.length === 1 && two[0].status === 'ready')
  check('…and it is the final', two[0].winnerTo === null)

  const three = generateSingleElimination(people(3))
  check('3 players: 4-slot draw, 1 bye', three.filter((m) => m.round === 1).length === 2 && three.filter((m) => m.status === 'bye').length === 1)
  check('…the TOP seed gets the bye', (() => {
    const bye = three.find((m) => m.status === 'bye')!
    return (bye.a ?? bye.b) === 'r01'
  })())
  check('…and is already in the final', find(three, 'winners', 2, 0)!.a === 'r01')

  const five = generateSingleElimination(people(5))
  check('5 players: 8-slot draw with 3 byes, not a 5-slot tree', five.filter((m) => m.round === 1).length === 4 && five.filter((m) => m.status === 'bye').length === 3)
  check('…exactly one real first-round match', five.filter((m) => m.round === 1 && m.status === 'ready').length === 1)
  check('…which is seeds 4 v 5', (() => {
    const real = five.find((m) => m.round === 1 && m.status === 'ready')!
    return real.a === 'r04' && real.b === 'r05'
  })())
  check('…and no fake participant exists anywhere', five.every((m) => [m.a, m.b].every((x) => x === null || /^r\d\d$/.test(x))))

  const eight = generateSingleElimination(people(8))
  check('8 players: 7 matches, no byes', eight.length === 7 && eight.every((m) => m.status !== 'bye'))
  check('…4 + 2 + 1 by round', [1, 2, 3].map((r) => eight.filter((m) => m.round === r).length).join() === '4,2,1')
}

// ══════════════════════════════════════════════════════════════════════════
section('4. winner advancement wiring')
{
  const ms = generateSingleElimination(people(8))
  // Round-1 positions 0 and 1 feed round-2 position 0, slots a and b.
  check('R1 p0 winner → R2 p0 slot a', JSON.stringify(find(ms, 'winners', 1, 0)!.winnerTo) === JSON.stringify({ key: { side: 'winners', round: 2, position: 0 }, slot: 'a' }))
  check('R1 p1 winner → R2 p0 slot b', JSON.stringify(find(ms, 'winners', 1, 1)!.winnerTo) === JSON.stringify({ key: { side: 'winners', round: 2, position: 0 }, slot: 'b' }))
  check('R1 p2 winner → R2 p1 slot a', find(ms, 'winners', 1, 2)!.winnerTo!.key.position === 1 && find(ms, 'winners', 1, 2)!.winnerTo!.slot === 'a')

  // Every non-final match has exactly one destination, and it exists.
  const keys = new Set(ms.map((m) => `${m.side}:${m.round}:${m.position}`))
  check('every winner destination points at a real match', ms.every((m) => m.winnerTo === null || keys.has(`${m.winnerTo.key.side}:${m.winnerTo.key.round}:${m.winnerTo.key.position}`)))

  // No two matches feed the same slot — that would overwrite a participant.
  const slots = ms.filter((m) => m.winnerTo).map((m) => `${m.winnerTo!.key.side}:${m.winnerTo!.key.round}:${m.winnerTo!.key.position}:${m.winnerTo!.slot}`)
  check('no two matches feed the same next slot', new Set(slots).size === slots.length)
}

// ══════════════════════════════════════════════════════════════════════════
section('5. double elimination')
{
  check('1 participant is refused', threw(() => generateDoubleElimination(people(1))) !== null)

  for (const n of [2, 3, 4, 5, 6, 7, 8, 11, 16]) {
    const ms = generateDoubleElimination(people(n))
    const wb = ms.filter((m) => m.side === 'winners')
    const lb = ms.filter((m) => m.side === 'losers')
    const fin = ms.filter((m) => m.side === 'final')
    const keys = new Set(ms.map((m) => `${m.side}:${m.round}:${m.position}`))
    const label = `n=${String(n).padStart(2)}`

    check(`${label}: a grand final and a reset exist`, fin.length === 2)
    check(`${label}: the winners bracket is the single-elim draw`, wb.length === generateSingleElimination(people(n)).length)

    // EVERY loser has exactly one destination, except where elimination is the
    // point: losers-bracket matches and the reset.
    const wbNoRoute = wb.filter((m) => m.loserTo === null)
    check(`${label}: every winners-bracket loser has a destination`, wbNoRoute.length === 0, `${wbNoRoute.length} unrouted`)
    check(`${label}: losers-bracket losers are eliminated (no route)`, lb.every((m) => m.loserTo === null))

    // Every destination — winner or loser — names a match that exists.
    check(`${label}: every destination resolves`, ms.every((m) =>
      [m.winnerTo, m.loserTo].every((d) => d === null || keys.has(`${d.key.side}:${d.key.round}:${d.key.position}`)),
    ))

    // Nothing may be written into the same slot twice.
    const dests = ms.flatMap((m) => [m.winnerTo, m.loserTo]).filter((d): d is NonNullable<typeof d> => d !== null)
      .map((d) => `${d.key.side}:${d.key.round}:${d.key.position}:${d.slot}`)
    check(`${label}: no slot is fed by two matches`, new Set(dests).size === dests.length, `${dests.length - new Set(dests).size} collisions`)

    // The invariant that actually matters, and it holds at EVERY size: the
    // grand final's slot b is fed by exactly one match. Normally that is the
    // losers final's winner; at n === 2 there is no losers bracket, so it is
    // the winners final's loser. A draw where nothing feeds slot b can never
    // be finished — recordMatchResult refuses a match with an undecided
    // participant, so the event would sit unplayable forever.
    const feedsFinalB = ms.filter((m) =>
      [m.winnerTo, m.loserTo].some(
        (d) => d !== null && d.key.side === 'final' && d.key.round === 1 && d.slot === 'b',
      ),
    )
    check(`${label}: exactly one match feeds the grand final slot b`, feedsFinalB.length === 1, `${feedsFinalB.length} feeders`)

    // n === 2 is the degenerate shape: one winners match, no losers bracket.
    if (n === 2) {
      check(`${label}: with no losers bracket, the WB final's loser IS the grand finalist`, lb.length === 0 && feedsFinalB[0]?.side === 'winners')
    }

    check(`${label}: the losers final feeds the grand final slot b`, lb.length === 0 || (() => {
      const last = lb.filter((m) => m.round === Math.max(...lb.map((x) => x.round)))
      return last.every((m) => m.winnerTo!.key.side === 'final' && m.winnerTo!.slot === 'b')
    })())
  }

  // Routing detail, on a clean 8-player draw.
  const ms = generateDoubleElimination(people(8))
  check('8: WB R1 losers fill LB R1 (two per match)', (() => {
    const r1 = ms.filter((m) => m.side === 'winners' && m.round === 1)
    return r1.every((m) => m.loserTo!.key.side === 'losers' && m.loserTo!.key.round === 1)
      && new Set(r1.map((m) => `${m.loserTo!.key.position}${m.loserTo!.slot}`)).size === 4
  })())
  check('8: WB R2 losers enter LB R2 (a major round)', ms.filter((m) => m.side === 'winners' && m.round === 2).every((m) => m.loserTo!.key.round === 2 && m.loserTo!.slot === 'b'))
  check('8: the WB final loser drops to the LAST losers round', (() => {
    const wbFinal = ms.find((m) => m.side === 'winners' && m.round === 3)!
    const lastLb = Math.max(...ms.filter((m) => m.side === 'losers').map((m) => m.round))
    return wbFinal.loserTo!.key.round === lastLb && wbFinal.loserTo!.slot === 'b'
  })())
  check('8: the WB champion enters the grand final in slot a', ms.find((m) => m.side === 'winners' && m.round === 3)!.winnerTo!.slot === 'a')

  // The cross-placement rule: a WB R2 loser must not immediately re-meet the
  // player who just knocked them out.
  check('8: major-round drops are reversed, avoiding an instant rematch', (() => {
    const r2 = ms.filter((m) => m.side === 'winners' && m.round === 2).sort((a, b) => a.position - b.position)
    return r2[0].loserTo!.key.position !== 0 || r2[1].loserTo!.key.position !== 1
  })())

  check('grand final routes both players into the reset', (() => {
    const gf = ms.find((m) => m.side === 'final' && m.round === 1)!
    return gf.winnerTo!.key.round === 2 && gf.winnerTo!.slot === 'a' && gf.loserTo!.key.round === 2 && gf.loserTo!.slot === 'b'
  })())
  check('the reset is terminal', ms.find((m) => m.side === 'final' && m.round === 2)!.winnerTo === null)
}

// ══════════════════════════════════════════════════════════════════════════
section('6. round robin')
{
  check('1 participant is refused', threw(() => generateRoundRobin(people(1))) !== null)

  for (let n = 2; n <= 9; n++) {
    const ms = generateRoundRobin(people(n))
    const expected = (n * (n - 1)) / 2
    const label = `n=${n}`

    check(`${label}: exactly n(n-1)/2 = ${expected} pairings`, ms.length === expected, String(ms.length))
    check(`${label}: nobody plays themselves`, ms.every((m) => m.a !== m.b))

    const pairs = ms.map((m) => [m.a!, m.b!].sort().join('|'))
    check(`${label}: no duplicate pairing`, new Set(pairs).size === pairs.length)

    // Every expected pairing is present.
    const ids = people(n).map((p) => p.registrationId)
    const want: string[] = []
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) want.push([ids[i], ids[j]].sort().join('|'))
    check(`${label}: every expected pairing exists`, want.every((w) => pairs.includes(w)))

    // Nobody appears twice in one round — that is the bye handling working.
    const byRound = new Map<number, string[]>()
    for (const m of ms) byRound.set(m.round, [...(byRound.get(m.round) ?? []), m.a!, m.b!])
    check(`${label}: nobody plays twice in a round`, [...byRound.values()].every((v) => new Set(v).size === v.length))

    check(`${label}: every match is immediately playable`, ms.every((m) => m.status === 'ready'))
  }

  check('odd counts sit one player out per round, with no phantom match', (() => {
    const ms = generateRoundRobin(people(5))
    const byRound = new Map<number, number>()
    for (const m of ms) byRound.set(m.round, (byRound.get(m.round) ?? 0) + 1)
    return [...byRound.values()].every((c) => c === 2) && byRound.size === 5
  })())
}

// ══════════════════════════════════════════════════════════════════════════
section('7. points')
{
  const ms = generatePoints(people(5))
  check('one score card per participant', ms.length === 5)
  check('…each with a participant and NO opponent', ms.every((m) => m.a !== null && m.b === null))
  check('…all immediately enterable', ms.every((m) => m.status === 'ready'))
  check('…and none routes anywhere (a leaderboard, not a tree)', ms.every((m) => m.winnerTo === null && m.loserTo === null))
  check('…in seeded order', ms.map((m) => m.a).join() === 'r01,r02,r03,r04,r05')
  check('points allows a single participant', generatePoints(people(1)).length === 1)
}

// ══════════════════════════════════════════════════════════════════════════
section('8. score validation — the server decides the winner')
{
  const ok = (v: ReturnType<typeof decideWinner>) => (v.ok ? v.winner : `ERR:${v.error}`)

  check('A 10 – B 7 → A wins', ok(decideWinner('winners', { scoreA: 10, scoreB: 7 }, true)) === 'a')
  check('A 7 – B 10 → B wins', ok(decideWinner('winners', { scoreA: 7, scoreB: 10 }, true)) === 'b')
  check('a knockout draw is refused', decideWinner('winners', { scoreA: 5, scoreB: 5 }, true).ok === false)
  check('a round-robin draw is refused too, with its own message', (() => {
    const v = decideWinner('round_robin', { scoreA: 2, scoreB: 2 }, true)
    return !v.ok && v.error.includes('draw')
  })())
  check('a negative score is refused', decideWinner('winners', { scoreA: -1, scoreB: 3 }, true).ok === false)
  check('a fractional score is refused', decideWinner('winners', { scoreA: 1.5, scoreB: 3 }, true).ok === false)
  check('a missing opponent score is refused', decideWinner('winners', { scoreA: 3, scoreB: null }, true).ok === false)
  check('an absurd score is refused', decideWinner('winners', { scoreA: 1e9, scoreB: 0 }, true).ok === false)
  check('zero is a legal score', decideWinner('winners', { scoreA: 0, scoreB: 3 }, true).ok === true)

  check('a points card needs no opponent and has no winner', ok(decideWinner('points', { scoreA: 42, scoreB: null }, false)) === null)
  check('…and refuses an opponent score', decideWinner('points', { scoreA: 42, scoreB: 3 }, false).ok === false)
}

// ══════════════════════════════════════════════════════════════════════════
section('9. standings')
{
  const ids = ['r01', 'r02', 'r03']
  const rr = computeStandings('round_robin', ids, [
    { side: 'round_robin', a: 'r01', b: 'r02', scoreA: 10, scoreB: 4, winner: 'r01' },
    { side: 'round_robin', a: 'r01', b: 'r03', scoreA: 9, scoreB: 8, winner: 'r01' },
    { side: 'round_robin', a: 'r02', b: 'r03', scoreA: 7, scoreB: 3, winner: 'r02' },
  ])
  check('round robin ranks by wins', rr.map((r) => r.registrationId).join() === 'r01,r02,r03')
  check('…counting played, won and lost', rr[0].played === 2 && rr[0].won === 2 && rr[0].lost === 0)
  check('…and points for/against', rr[0].pointsFor === 19 && rr[0].pointsAgainst === 12)
  check('…ranks are 1-based and unique', rr.map((r) => r.rank).join() === '1,2,3')

  const pts = computeStandings('points', ids, [
    { side: 'points', a: 'r01', b: null, scoreA: 5, scoreB: null, winner: null },
    { side: 'points', a: 'r02', b: null, scoreA: 12, scoreB: null, winner: null },
    { side: 'points', a: 'r03', b: null, scoreA: 9, scoreB: null, winner: null },
  ])
  check('points ranks by points scored', pts.map((r) => r.registrationId).join() === 'r02,r03,r01')

  // A dead tie must still be a total order — seeded order decides.
  const tie = computeStandings('points', ids, [
    { side: 'points', a: 'r01', b: null, scoreA: 5, scoreB: null, winner: null },
    { side: 'points', a: 'r02', b: null, scoreA: 5, scoreB: null, winner: null },
    { side: 'points', a: 'r03', b: null, scoreA: 5, scoreB: null, winner: null },
  ])
  check('an exact tie falls back to seed order, deterministically', tie.map((r) => r.registrationId).join() === 'r01,r02,r03')

  check('an unplayed participant still appears, at the bottom', computeStandings('points', ids, []).length === 3)
}

// ══════════════════════════════════════════════════════════════════════════
section('10. the format entry point')
{
  check('single_elim dispatches', generateBracket('single_elim', people(4)).length === 3)
  check('double_elim dispatches', generateBracket('double_elim', people(4)).some((m) => m.side === 'losers'))
  check('round_robin dispatches', generateBracket('round_robin', people(4)).length === 6)
  check('points dispatches', generateBracket('points', people(4)).length === 4)

  check('a knockout with 1 participant is refused', threw(() => generateBracket('single_elim', people(1))) !== null)
  check('…with a message naming the minimum', (threw(() => generateBracket('single_elim', people(1))) ?? '').includes('at least 2'))
  check('an empty field is refused for every format', (['single_elim', 'double_elim', 'round_robin', 'points'] as const).every((f) => threw(() => generateBracket(f, [])) !== null))

  check('the engine seeds its own input', (() => {
    const shuffled = [...people(4)].reverse()
    return JSON.stringify(generateBracket('single_elim', shuffled)) === JSON.stringify(generateBracket('single_elim', people(4)))
  })())

  check('generation is byte-identical across runs', (() => {
    const a = JSON.stringify(generateBracket('double_elim', people(11)))
    const b = JSON.stringify(generateBracket('double_elim', people(11)))
    return a === b
  })())

  check('BracketError is the thrown type', (() => {
    try {
      generateBracket('single_elim', people(1))
      return false
    } catch (e) {
      return e instanceof BracketError
    }
  })())
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
