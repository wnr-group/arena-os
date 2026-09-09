/**
 * THE BRACKET ENGINE — pure, deterministic, and free of everything (M15 #6).
 *
 * Deliberately no `server-only`, no drizzle, no db/schema import, no React, no
 * tenant context — the same discipline lib/billing/pricing.ts and
 * lib/events/lifecycle.ts follow. It takes a list of participants and returns
 * match data; it never reads or writes a row. That is what makes it testable
 * without a database (scripts/test-event-bracket.ts drives every function here
 * directly) and what stops bracket maths leaking into a component or an action.
 *
 * Persistence lives in ./bracket-service.ts. Everything below is arithmetic.
 *
 * ══ THE SHAPE OF THE OUTPUT ═════════════════════════════════════════════════
 *
 * A generated match names its destinations by COORDINATE — (bracket, round,
 * position) — never by id, because ids do not exist until the rows are written.
 * The service resolves coordinates to ids in one pass after inserting. That
 * indirection is what keeps this module pure without making the caller
 * reconstruct the topology itself.
 *
 * ══ DETERMINISM ════════════════════════════════════════════════════════════
 *
 * No Math.random, no Date.now, no iteration over an unordered structure, no
 * dependence on input order beyond the documented seeding rule. The same
 * participants in the same order always produce byte-identical output.
 */

/** The four formats M15 already defines on `events.tournament_format`. */
export type TournamentFormat = 'single_elim' | 'double_elim' | 'round_robin' | 'points'

/**
 * Which half of a double-elimination draw a match belongs to.
 *
 *   winners       the main draw. Single elimination uses this too, so a
 *                 single-elim bracket is a double-elim winners bracket with no
 *                 losers side — one concept, not two.
 *   losers        the repechage. Double elimination only.
 *   final         the grand final, and its reset if one is needed.
 *   round_robin   every pairing of a round-robin schedule.
 *   points        a per-participant score card. See generatePoints().
 */
export type BracketSide = 'winners' | 'losers' | 'final' | 'round_robin' | 'points'

/** Where a coordinate lives. Unique within one event. */
export type MatchKey = { side: BracketSide; round: number; position: number }

/** Which of a match's two slots a participant lands in. */
export type Slot = 'a' | 'b'

export type MatchDestination = { key: MatchKey; slot: Slot }

/**
 * A match as the engine produces it.
 *
 *   pending  at least one participant is still unknown (an earlier match feeds
 *            it). Not scoreable.
 *   ready    both participants are known. Scoreable.
 *   bye      exactly one participant, and no opponent will ever arrive. The
 *            engine has ALREADY placed that participant in the next match, so
 *            nothing has to be scored for them to advance. Kept as a row so the
 *            draw reads correctly, and refused by score entry.
 */
export type GeneratedMatchStatus = 'pending' | 'ready' | 'bye'

export type GeneratedMatch = {
  side: BracketSide
  round: number
  position: number
  /** Participant ids (registration ids). Null = not yet determined, or none. */
  a: string | null
  b: string | null
  status: GeneratedMatchStatus
  /** Where the winner goes. Null for a terminal match. */
  winnerTo: MatchDestination | null
  /** Where the loser goes. Non-null only in double elimination. */
  loserTo: MatchDestination | null
}

/** A participant, reduced to what the engine actually needs. */
export type BracketParticipant = {
  /** The event_registrations id. THE participant identity throughout. */
  registrationId: string
  /** Null for a solo entry. A team enters as ONE participant — see seedParticipants. */
  teamId: string | null
  /** Only used by the documented seeding tiebreak. */
  checkedInAt: Date
}

export class BracketError extends Error {}

// ── seeding ──────────────────────────────────────────────────────────────────

/**
 * THE SEEDING RULE, stated once.
 *
 * M15 defines no explicit seed column — there is no ranking, no ladder and no
 * prior-results table to seed from — so this ticket needs the smallest rule
 * that is stable and explainable, and this is it:
 *
 *     ARRIVAL ORDER. Earliest `checked_in_at` is seed 1, then next, and so on.
 *     Ties (two rows in the same millisecond, or a restored backup) break on
 *     `registrationId` ascending, which is a total order because it is unique.
 *
 * Why arrival rather than registration time: this is a DAY-OF bracket built
 * from the checked-in list (M15 #5). Who actually turned up, and when, is the
 * only fact the event itself has produced. Registration order would seed people
 * who booked early but arrived late, and neither is more "correct" — but only
 * one of them is visible to the players standing in the room, which makes it
 * the one that can be explained at the desk.
 *
 * The rule is total and deterministic: the same checked-in list always produces
 * the same seed 1, the same seed 2, and therefore the same bracket. Nothing
 * here calls Math.random or depends on the order the database returned rows in
 * — the input is re-sorted here rather than trusted.
 *
 * TEAM EVENTS: a team enters as ONE participant. listCheckedInParticipants
 * returns one registration per team (the captain holds it — see M15 #3/#5), so
 * this needs no special case; it is asserted below rather than assumed.
 */
export function seedParticipants(participants: BracketParticipant[]): BracketParticipant[] {
  const seen = new Set<string>()
  for (const p of participants) {
    if (seen.has(p.registrationId)) {
      throw new BracketError(`Duplicate participant in the checked-in list: ${p.registrationId}`)
    }
    seen.add(p.registrationId)
  }

  // A team must not appear twice — that would mean two registrations for one
  // team, which M15 #3's unique index already forbids. Checked rather than
  // trusted, because a bracket built on it would be silently wrong.
  const teams = new Set<string>()
  for (const p of participants) {
    if (p.teamId === null) continue
    if (teams.has(p.teamId)) {
      throw new BracketError(`Team ${p.teamId} appears more than once in the checked-in list.`)
    }
    teams.add(p.teamId)
  }

  return [...participants].sort((x, y) => {
    const t = x.checkedInAt.getTime() - y.checkedInAt.getTime()
    if (t !== 0) return t
    return x.registrationId < y.registrationId ? -1 : x.registrationId > y.registrationId ? 1 : 0
  })
}

/** The smallest power of two that is ≥ n. `bracketSize(5) === 8`. */
export function bracketSize(n: number): number {
  if (n <= 1) return 1
  let size = 1
  while (size < n) size *= 2
  return size
}

/**
 * The classic seeding order for a bracket of `size` slots.
 *
 * Returns SEED NUMBERS (1-based) in slot order, so slot pairs (0,1), (2,3), …
 * are the first-round matches. For 8 it produces
 *
 *     [1, 8, 4, 5, 3, 6, 2, 7]  →  1v8, 4v5, 3v6, 2v7
 *
 * which is the standard draw: the top seed meets the bottom seed, and seeds 1
 * and 2 can only meet in the final. Built by repeated mirroring rather than
 * hard-coded per size, so it is correct for every power of two.
 *
 * This is also what makes BYES land correctly. With 5 players in an 8 draw,
 * seeds 6, 7 and 8 do not exist, so the players facing them — seeds 3, 2 and 1 —
 * receive the byes. Byes going to the top seeds is the property that makes a
 * non-power-of-two draw fair, and it falls out of this ordering rather than
 * being arranged separately.
 */
export function seedSlots(size: number): number[] {
  if (size < 1 || (size & (size - 1)) !== 0) {
    throw new BracketError(`Bracket size must be a power of two, got ${size}`)
  }
  let order = [1]
  while (order.length < size) {
    const sum = order.length * 2 + 1
    const next: number[] = []
    for (const s of order) next.push(s, sum - s)
    order = next
  }
  return order
}

// ── single elimination ───────────────────────────────────────────────────────

/**
 * A single-elimination draw.
 *
 * Round 1 has `bracketSize(n) / 2` matches; every later round halves it, so the
 * last round is the single final. Total matches is always n − 1 real contests
 * plus however many byes the draw needed.
 *
 * ── Byes are resolved HERE, at generation ───────────────────────────────────
 *
 * A first-round slot whose seed does not exist is a bye. The engine marks that
 * match `bye` and writes the surviving participant STRAIGHT INTO the round-2
 * slot it would have advanced to. No fake opponent is invented, no placeholder
 * participant exists, and no score is ever entered for it — score entry refuses
 * a `bye` match outright. The row is kept so the draw sheet reads correctly and
 * so "who did seed 1 not have to play?" has an answer.
 *
 * A round-2 match fed by two byes is therefore `ready` immediately, which is
 * correct: both players are known and neither has played.
 */
export function generateSingleElimination(seeds: BracketParticipant[]): GeneratedMatch[] {
  const n = seeds.length
  if (n < 2) throw new BracketError('A knockout bracket needs at least 2 participants.')

  const size = bracketSize(n)
  const rounds = Math.log2(size)
  const order = seedSlots(size)

  // slotFor[i] = the participant in slot i, or null when that seed does not exist.
  const slotFor = order.map((seed) => (seed <= n ? seeds[seed - 1].registrationId : null))

  const matches: GeneratedMatch[] = []
  // Participants already placed into a later round by a bye, keyed "round:position:slot".
  const preplaced = new Map<string, string>()

  for (let round = 1; round <= rounds; round++) {
    const count = size / 2 ** round
    for (let position = 0; position < count; position++) {
      const isFinal = round === rounds
      const winnerTo: MatchDestination | null = isFinal
        ? null
        : {
            key: { side: 'winners', round: round + 1, position: Math.floor(position / 2) },
            slot: position % 2 === 0 ? 'a' : 'b',
          }

      let a: string | null = null
      let b: string | null = null
      if (round === 1) {
        a = slotFor[position * 2]
        b = slotFor[position * 2 + 1]
      } else {
        a = preplaced.get(`${round}:${position}:a`) ?? null
        b = preplaced.get(`${round}:${position}:b`) ?? null
      }

      // A round-1 pairing with exactly one participant is a bye: advance them
      // now rather than asking anybody to score it.
      const isBye = round === 1 && (a === null) !== (b === null)
      if (isBye && winnerTo) {
        const survivor = (a ?? b) as string
        preplaced.set(`${winnerTo.key.round}:${winnerTo.key.position}:${winnerTo.slot}`, survivor)
      }

      matches.push({
        side: 'winners',
        round,
        position,
        a,
        b,
        status: isBye ? 'bye' : a !== null && b !== null ? 'ready' : 'pending',
        winnerTo,
        loserTo: null,
      })
    }
  }

  return matches
}

// ── double elimination ───────────────────────────────────────────────────────

/**
 * A double-elimination draw: winners bracket, losers bracket, grand final.
 *
 * ══ THE TOPOLOGY ═══════════════════════════════════════════════════════════
 *
 * The winners bracket is the single-elimination draw above, unchanged, and its
 * losers drop into a losers bracket built of alternating rounds:
 *
 *   LB round 1   (minor) WB round-1 losers play each other.
 *   LB round 2   (major) the LB round-1 winners meet the WB round-2 losers.
 *   LB round 3   (minor) LB round-2 winners play each other.
 *   LB round 4   (major) those winners meet the WB round-3 losers.
 *   …and so on, ending with one survivor.
 *
 * So a WB round `r` loser (for r ≥ 2) enters LB round `2r − 2`, and WB round-1
 * losers fill LB round 1. That alternation is what makes the losers bracket
 * exactly half the field per major round and is the standard structure — not a
 * simplification of it.
 *
 * ══ THE CROSS-PLACEMENT RULE, and why it is not the identity ════════════════
 *
 * When WB round-`r` losers drop in, their POSITIONS are reversed on alternate
 * major rounds. Dropping loser `i` into LB slot `i` every time would send two
 * players who just met in the winners bracket straight back into each other in
 * the losers bracket — the rematch every real tournament format exists to
 * avoid. Reversing on alternating rounds is the conventional fix, it is
 * deterministic, and it is asserted in the tests rather than left as folklore.
 *
 * ══ GRAND FINAL — the documented choice: RESET ═════════════════════════════
 *
 * The winners-bracket champion has not lost; the losers-bracket champion has
 * lost once. If the LB champion wins the grand final, both have one loss and a
 * SECOND grand final (the "reset") decides it. If the WB champion wins, the
 * tournament is over and the reset is never played.
 *
 * So the engine always emits the reset match as `final` round 2, and the
 * service marks it `void` the moment the first grand final is won by the WB
 * champion. Emitting it up front keeps the topology static — advancement never
 * has to create a row — and voiding it keeps the bracket honest about whether
 * it will be played.
 *
 * ══ n === 2 — no losers bracket, and none needed ═══════════════════════════
 *
 * With two entrants the winners bracket is a single match, so there is no
 * losers bracket to build (lbRoundCount is 0) and nothing for its champion to
 * emerge from. The WB final's loser therefore enters the grand final's slot
 * 'b' directly. The result is exactly what double elimination means at this
 * size — first to two losses, in two or three games — and every rule above
 * still holds: slot 'a' is the unbeaten player, slot 'b' carries one loss, and
 * the reset is played only if slot 'b' levels the score.
 */
export function generateDoubleElimination(seeds: BracketParticipant[]): GeneratedMatch[] {
  const n = seeds.length
  if (n < 2) throw new BracketError('A double-elimination bracket needs at least 2 participants.')

  const size = bracketSize(n)
  const wbRounds = Math.log2(size)

  // The winners bracket is exactly the single-elimination draw.
  const wb = generateSingleElimination(seeds)

  // ── losers bracket shape ────────────────────────────────────────────────
  // LB round r holds `lbSize(r)` matches. Minor rounds halve the survivors;
  // major rounds keep the count and add the incoming WB losers.
  const lbRoundCount = wbRounds === 1 ? 0 : (wbRounds - 1) * 2
  const lbMatches: GeneratedMatch[] = []
  const lbCounts: number[] = []
  for (let r = 1; r <= lbRoundCount; r++) {
    // r=1: size/4 ; r=2: size/4 ; r=3: size/8 ; r=4: size/8 ; …
    const pairIndex = Math.ceil(r / 2)
    lbCounts[r] = size / 2 ** (pairIndex + 1)
  }

  for (let r = 1; r <= lbRoundCount; r++) {
    const count = lbCounts[r]
    for (let position = 0; position < count; position++) {
      const isLast = r === lbRoundCount
      const winnerTo: MatchDestination = isLast
        ? { key: { side: 'final', round: 1, position: 0 }, slot: 'b' }
        : {
            key: {
              side: 'losers',
              round: r + 1,
              // A minor round (odd) halves into the next; a major round (even)
              // maps one-to-one into the next minor round.
              position: r % 2 === 1 ? position : Math.floor(position / 2),
            },
            // Entering a major round, the LB survivor always takes slot 'a' and
            // the incoming WB loser takes 'b', so the sides are predictable on
            // the draw sheet. Entering a minor round it pairs off normally.
            slot: r % 2 === 1 ? 'a' : position % 2 === 0 ? 'a' : 'b',
          }

      lbMatches.push({
        side: 'losers',
        round: r,
        position,
        a: null,
        b: null,
        status: 'pending',
        winnerTo,
        loserTo: null,
      })
    }
  }

  // ── route every winners-bracket loser into the losers bracket ───────────
  const withLoserRoutes = wb.map((m) => {
    if (m.round === wbRounds) {
      // The WB final's loser goes to the last LB round, slot 'b' — except at
      // n === 2, where there is no losers bracket to drop into (one WB match
      // IS the final, so lbRoundCount is 0). Routing the loser straight to the
      // grand final's slot 'b' is not a special case in disguise: it is what
      // double elimination already means with two entrants — first to two
      // losses. Game 1 is the WB final, the grand final is the rematch, and
      // the reset decides it if the game-1 loser levels the score.
      //
      // Without this the loser was dropped with no destination, slot 'b' was
      // never filled, and recordMatchResult refused the grand final forever —
      // an unplayable draw for a size MIN_PARTICIPANTS.double_elim allows.
      return {
        ...m,
        loserTo:
          lbRoundCount === 0
            ? { key: { side: 'final' as const, round: 1, position: 0 }, slot: 'b' as Slot }
            : {
                key: { side: 'losers' as const, round: lbRoundCount, position: 0 },
                slot: 'b' as Slot,
              },
      }
    }
    const targetRound = m.round === 1 ? 1 : (m.round - 1) * 2
    const targetCount = lbCounts[targetRound]
    if (!targetCount) return m

    let position: number
    let slot: Slot
    if (m.round === 1) {
      // Two WB losers per LB round-1 match.
      position = Math.floor(m.position / 2)
      slot = m.position % 2 === 0 ? 'a' : 'b'
    } else {
      // A major round: one incoming loser per match, in slot 'b'. Reversed on
      // alternating rounds — see the cross-placement note above.
      const reverse = m.round % 2 === 0
      position = reverse ? targetCount - 1 - m.position : m.position
      slot = 'b'
    }
    return { ...m, loserTo: { key: { side: 'losers' as const, round: targetRound, position }, slot } }
  })

  // ── the grand final, and its reset ──────────────────────────────────────
  const finals: GeneratedMatch[] = [
    {
      side: 'final',
      round: 1,
      position: 0,
      a: null, // the winners-bracket champion
      b: null, // the losers-bracket champion — or, at n === 2, the WB final's
      //          loser, who is the same thing with no rounds in between
      status: 'pending',
      // If the LB champion wins, both sides carry one loss and the reset decides
      // it. The service voids this row when the WB champion wins instead.
      winnerTo: { key: { side: 'final', round: 2, position: 0 }, slot: 'a' },
      loserTo: { key: { side: 'final', round: 2, position: 0 }, slot: 'b' },
    },
    {
      side: 'final',
      round: 2,
      position: 0,
      a: null,
      b: null,
      status: 'pending',
      winnerTo: null,
      loserTo: null,
    },
  ]

  // The WB final's winner enters the grand final in slot 'a'.
  const routed = withLoserRoutes.map((m) =>
    m.side === 'winners' && m.round === wbRounds
      ? { ...m, winnerTo: { key: { side: 'final' as const, round: 1, position: 0 }, slot: 'a' as Slot } }
      : m,
  )

  return [...routed, ...lbMatches, ...finals]
}

// ── round robin ──────────────────────────────────────────────────────────────

/**
 * A round-robin schedule by the circle method: every participant meets every
 * other exactly once.
 *
 * For an ODD count a bye marker is added so the field is even; the participant
 * drawn against it simply does not play that round, and NO match row is emitted
 * for that pairing — a bye is an absence of a match here, not a match with one
 * player. That gives `n` rounds of `(n−1)/2` matches for odd `n`, and `n−1`
 * rounds of `n/2` for even `n`; either way exactly `n(n−1)/2` pairings, which
 * is what the tests assert.
 *
 * The rotation is fixed (participant 0 is the pivot, the rest rotate), so the
 * schedule is a deterministic function of the seeded order.
 */
export function generateRoundRobin(seeds: BracketParticipant[]): GeneratedMatch[] {
  const n = seeds.length
  if (n < 2) throw new BracketError('A round robin needs at least 2 participants.')

  const ids: (string | null)[] = seeds.map((s) => s.registrationId)
  if (ids.length % 2 === 1) ids.push(null) // the bye marker

  const size = ids.length
  const rounds = size - 1
  const half = size / 2
  const matches: GeneratedMatch[] = []

  // The circle: index 0 is fixed, indices 1..size-1 rotate by one each round.
  let circle = ids.slice(1)

  for (let round = 1; round <= rounds; round++) {
    const lineup = [ids[0], ...circle]
    let position = 0
    for (let i = 0; i < half; i++) {
      const a = lineup[i]
      const b = lineup[size - 1 - i]
      // A pairing against the bye marker produces no match at all.
      if (a === null || b === null) continue
      matches.push({
        side: 'round_robin',
        round,
        position: position++,
        a,
        b,
        status: 'ready',
        winnerTo: null,
        loserTo: null,
      })
    }
    circle = [circle[circle.length - 1], ...circle.slice(0, -1)]
  }

  return matches
}

// ── points ───────────────────────────────────────────────────────────────────

/**
 * A points competition.
 *
 * ══ THE ASSUMPTION, stated plainly ═════════════════════════════════════════
 *
 * M15 defines `points` as a `tournament_format` value and nothing else — there
 * is no scoring table, no rounds-per-event field, and no rule anywhere in the
 * product about how points are earned. The ticket says not to invent a
 * complicated system, so this implements the smallest deterministic model that
 * fits the existing schema:
 *
 *     ONE SCORE CARD PER PARTICIPANT. Each participant gets a single row with
 *     themselves in slot A and no opponent. Staff enter that participant's
 *     points. Standings rank by points descending.
 *
 * It is not round robin, and deliberately not: nobody is paired against anybody.
 * A points event is a leaderboard — a time trial, a high-score session, a
 * shooting round — where each competitor produces a number independently.
 *
 * There is no winner on a points row (`winnerTo`/`loserTo` are null and score
 * entry never sets a winner), because "who won this card" is not a question:
 * the competition is won by whoever tops the standings, which
 * `computeStandings()` derives. If a future ticket defines multi-round points
 * scoring, this becomes rounds 2..n of the same shape and nothing else changes.
 */
export function generatePoints(seeds: BracketParticipant[]): GeneratedMatch[] {
  if (seeds.length < 1) throw new BracketError('A points competition needs at least 1 participant.')
  return seeds.map((p, i) => ({
    side: 'points' as const,
    round: 1,
    position: i,
    a: p.registrationId,
    b: null,
    status: 'ready' as const,
    winnerTo: null,
    loserTo: null,
  }))
}

// ── the entry point ──────────────────────────────────────────────────────────

/** The minimum checked-in participants each format can build a draw from. */
export const MIN_PARTICIPANTS: Record<TournamentFormat, number> = {
  single_elim: 2,
  double_elim: 2,
  round_robin: 2,
  points: 1,
}

/**
 * Generate the whole competition for one format.
 *
 * Seeds the input itself rather than trusting the caller's order, so the
 * seeding rule holds no matter which reader produced the list.
 */
export function generateBracket(
  format: TournamentFormat,
  participants: BracketParticipant[],
): GeneratedMatch[] {
  const seeds = seedParticipants(participants)
  if (seeds.length < MIN_PARTICIPANTS[format]) {
    throw new BracketError(
      `This format needs at least ${MIN_PARTICIPANTS[format]} checked-in participants; ${seeds.length} checked in.`,
    )
  }
  switch (format) {
    case 'single_elim':
      return generateSingleElimination(seeds)
    case 'double_elim':
      return generateDoubleElimination(seeds)
    case 'round_robin':
      return generateRoundRobin(seeds)
    case 'points':
      return generatePoints(seeds)
  }
}

// ── scoring ──────────────────────────────────────────────────────────────────

export type ScoreInput = { scoreA: number; scoreB: number | null }

export type ScoreVerdict =
  | { ok: true; winner: 'a' | 'b' | null }
  | { ok: false; error: string }

/**
 * Decide a match from its scores. THE server's rule — the client never says who
 * won, it only reports two numbers, and this decides.
 *
 * A head-to-head match needs a strict winner: a draw cannot be advanced, because
 * there is exactly one next slot and no rule anywhere in M15 for breaking a tie.
 * A points card has no opponent and therefore no winner at all.
 *
 * Scores must be non-negative integers. Negative is rejected outright rather
 * than interpreted — no format in this product scores below zero, and silently
 * accepting −3 would put a nonsense number on a result sheet nobody can correct.
 */
export function decideWinner(
  side: BracketSide,
  input: ScoreInput,
  hasOpponent: boolean,
): ScoreVerdict {
  const { scoreA, scoreB } = input

  const bad = (v: number | null, label: string): string | null => {
    if (v === null) return `${label} is required.`
    if (!Number.isFinite(v) || !Number.isInteger(v)) return `${label} must be a whole number.`
    if (v < 0) return `${label} cannot be negative.`
    if (v > 100_000) return `${label} is implausibly large.`
    return null
  }

  const aErr = bad(scoreA, 'Score A')
  if (aErr) return { ok: false, error: aErr }

  if (side === 'points' || !hasOpponent) {
    // A score card. No opponent, no winner — the standings decide the event.
    if (scoreB !== null && scoreB !== 0) {
      return { ok: false, error: 'A points card has no opponent score.' }
    }
    return { ok: true, winner: null }
  }

  const bErr = bad(scoreB, 'Score B')
  if (bErr) return { ok: false, error: bErr }

  if (scoreA === (scoreB as number)) {
    return {
      ok: false,
      error:
        side === 'round_robin'
          ? 'This match is a draw. Round-robin standings do not yet score draws — enter a decisive result.'
          : 'A knockout match cannot end level — somebody has to advance.',
    }
  }

  return { ok: true, winner: scoreA > (scoreB as number) ? 'a' : 'b' }
}

// ── standings ────────────────────────────────────────────────────────────────

export type StandingRow = {
  registrationId: string
  played: number
  won: number
  lost: number
  /** Points scored BY this participant, summed across their matches. */
  pointsFor: number
  pointsAgainst: number
  /** Rank, 1-based. Equal records share nothing — the tiebreak below is total. */
  rank: number
}

export type CompletedMatch = {
  side: BracketSide
  a: string | null
  b: string | null
  scoreA: number | null
  scoreB: number | null
  winner: string | null
}

/**
 * Standings for the formats that have a table rather than a tree.
 *
 * ── The ordering rule ───────────────────────────────────────────────────────
 *
 *   round_robin   wins desc, then point difference desc, then points-for desc.
 *   points        points-for desc.
 *
 * then, for BOTH, the seeded order as the final tiebreak — which is what makes
 * the table a total order rather than one with arbitrary ties. `seedOrder` is
 * the participant list in seeded sequence, so an unbroken tie resolves to
 * whoever checked in first. That is a rule somebody can explain, and it is
 * deterministic, which "leave them equal and let the UI sort" is not.
 */
export function computeStandings(
  side: 'round_robin' | 'points',
  seedOrder: string[],
  matches: CompletedMatch[],
): StandingRow[] {
  const index = new Map(seedOrder.map((id, i) => [id, i]))
  const rows = new Map<string, Omit<StandingRow, 'rank'>>()
  for (const id of seedOrder) {
    rows.set(id, { registrationId: id, played: 0, won: 0, lost: 0, pointsFor: 0, pointsAgainst: 0 })
  }

  for (const m of matches) {
    if (m.scoreA === null) continue
    const rowA = m.a ? rows.get(m.a) : undefined
    const rowB = m.b ? rows.get(m.b) : undefined

    if (rowA) {
      rowA.played += 1
      rowA.pointsFor += m.scoreA
      rowA.pointsAgainst += m.scoreB ?? 0
      if (m.winner === m.a) rowA.won += 1
      else if (m.winner !== null) rowA.lost += 1
    }
    if (rowB && m.scoreB !== null) {
      rowB.played += 1
      rowB.pointsFor += m.scoreB
      rowB.pointsAgainst += m.scoreA
      if (m.winner === m.b) rowB.won += 1
      else if (m.winner !== null) rowB.lost += 1
    }
  }

  const sorted = [...rows.values()].sort((x, y) => {
    if (side === 'round_robin') {
      if (y.won !== x.won) return y.won - x.won
      const dx = x.pointsFor - x.pointsAgainst
      const dy = y.pointsFor - y.pointsAgainst
      if (dy !== dx) return dy - dx
    }
    if (y.pointsFor !== x.pointsFor) return y.pointsFor - x.pointsFor
    return (index.get(x.registrationId) ?? 0) - (index.get(y.registrationId) ?? 0)
  })

  return sorted.map((r, i) => ({ ...r, rank: i + 1 }))
}
