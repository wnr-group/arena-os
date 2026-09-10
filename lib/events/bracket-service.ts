import 'server-only'
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { withUser, type DB } from '@/db'
import { auditLog, eventMatches, events } from '@/db/schema'
import type { ActiveContext } from '@/lib/tenant/context'
import { EventError } from './lifecycle'
import { listCheckedInParticipants } from './check-in'
import {
  BracketError,
  computeStandings,
  decideWinner,
  generateBracket,
  MIN_PARTICIPANTS,
  type BracketSide,
  type GeneratedMatch,
  type Slot,
  type TournamentFormat,
} from './bracket'

/**
 * BRACKET PERSISTENCE AND SCORE ENTRY (M15 #6).
 *
 * The counterpart to ./bracket.ts, which is pure. Nothing in this file does
 * bracket arithmetic: it fetches participants, calls the engine, writes what
 * the engine returned, and — on a result — follows a stored pointer. If a
 * bracket is wrong, it is wrong in the engine, where it can be tested without a
 * database.
 *
 *     checked-in participants → generateBracket() → rows
 *     score → decideWinner() → follow winner_next / loser_next pointers
 *
 * ══ WHY ADVANCEMENT FOLLOWS A POINTER ══════════════════════════════════════
 *
 * The topology is written ONCE, at generation, from the engine's output. Result
 * entry then reads `winner_next_match_id` / `winner_next_slot` and writes the
 * winner there. No round/position maths happens at result time, so a winner
 * cannot be placed in the wrong slot by a bracket-shape bug — there is no
 * bracket shape to get wrong on that path.
 */

/** A refusal a manager should see verbatim. */
export { EventError }

const FORMAT_VALUES: readonly TournamentFormat[] = [
  'single_elim',
  'double_elim',
  'round_robin',
  'points',
]

function isFormat(v: unknown): v is TournamentFormat {
  return typeof v === 'string' && (FORMAT_VALUES as readonly string[]).includes(v)
}

// ── generation ───────────────────────────────────────────────────────────────

export type GenerateResult = {
  format: TournamentFormat
  participants: number
  matches: number
}

/**
 * Build and persist the competition for one event.
 *
 * ── Everything happens in ONE transaction ───────────────────────────────────
 *
 * The event is locked, the existing draw is counted, the participants are read,
 * the engine runs, and every row is inserted — all inside the caller's single
 * transaction. A failure at any point rolls the whole thing back, so a
 * half-generated bracket cannot be left behind. That is the §15 requirement,
 * and it is satisfied by the transaction boundary rather than by cleanup code.
 *
 * ── Idempotent, and it refuses rather than overwrites ───────────────────────
 *
 * `for update` on the event serialises two managers clicking Generate. The
 * second one sees the first one's matches and is REFUSED — not silently
 * ignored, and certainly not allowed to regenerate. Regeneration is a separate,
 * explicit action (resetBracket) that itself refuses once any result exists.
 *
 * Even if both checks were bypassed, `event_matches_coordinate_key` would
 * reject the duplicate rows: the guarantee is in the database, not here.
 */
export async function generateEventBracket(
  tx: DB,
  ctx: ActiveContext,
  eventId: string,
): Promise<GenerateResult> {
  const [event] = await tx
    .select({
      id: events.id,
      type: events.type,
      status: events.status,
      format: events.tournamentFormat,
    })
    .from(events)
    .where(and(eq(events.id, eventId), eq(events.tenantId, ctx.tenant.id)))
    .for('update')
    .limit(1)

  if (!event) throw new EventError('Event not found.')
  if (event.status === 'cancelled') throw new EventError('This event has been cancelled.')
  if (!isFormat(event.format)) {
    throw new EventError(
      'This event has no tournament format. Only tournaments have a bracket — set a format on the event first.',
    )
  }

  const [{ existing }] = await tx
    .select({ existing: sql<number>`count(*)`.mapWith(Number) })
    .from(eventMatches)
    .where(and(eq(eventMatches.tenantId, ctx.tenant.id), eq(eventMatches.eventId, eventId)))

  if (existing > 0) {
    throw new EventError(
      'A bracket already exists for this event. Reset it first if you need to draw again.',
    )
  }

  // §4 — the CHECKED-IN list and nothing else. This reader returns only
  // status = 'checked_in' rows, which by M15 #5's ladder excludes cancelled,
  // waitlisted, no-show and unpaid entries: a paid event only reaches
  // `registered` through a verified payment webhook, and only `registered` can
  // be checked in. So "verified payment" needs no separate test here — it is
  // upstream of check-in.
  const checkedIn = await listCheckedInParticipants(ctx, eventId)

  if (checkedIn.length < MIN_PARTICIPANTS[event.format]) {
    throw new EventError(
      `${checkedIn.length} participant${checkedIn.length === 1 ? '' : 's'} checked in. ` +
        `This format needs at least ${MIN_PARTICIPANTS[event.format]}.`,
    )
  }

  let generated: GeneratedMatch[]
  try {
    generated = generateBracket(
      event.format,
      checkedIn.map((p) => ({
        registrationId: p.registrationId,
        teamId: p.teamId,
        checkedInAt: p.checkedInAt,
      })),
    )
  } catch (e) {
    // The engine's refusals are already manager-readable sentences.
    if (e instanceof BracketError) throw new EventError(e.message)
    throw e
  }

  // ── two passes: insert, then wire the pointers ────────────────────────────
  //
  // The engine names destinations by coordinate because ids do not exist until
  // the rows do. So every row is inserted first, then a single UPDATE per match
  // resolves its coordinates to ids. Both passes are in this transaction, so no
  // caller can ever observe a draw with unwired pointers.
  const inserted = await tx
    .insert(eventMatches)
    .values(
      generated.map((m) => ({
        tenantId: ctx.tenant.id,
        eventId,
        side: m.side,
        round: m.round,
        position: m.position,
        participantA: m.a,
        participantB: m.b,
        status: m.status,
      })),
    )
    .returning({
      id: eventMatches.id,
      side: eventMatches.side,
      round: eventMatches.round,
      position: eventMatches.position,
    })

  const idByKey = new Map(inserted.map((r) => [`${r.side}:${r.round}:${r.position}`, r.id]))
  const keyOf = (m: GeneratedMatch) => `${m.side}:${m.round}:${m.position}`

  for (const m of generated) {
    if (!m.winnerTo && !m.loserTo) continue
    const id = idByKey.get(keyOf(m))
    if (!id) throw new Error(`bracket: generated match ${keyOf(m)} was not inserted`)

    const w = m.winnerTo
      ? idByKey.get(`${m.winnerTo.key.side}:${m.winnerTo.key.round}:${m.winnerTo.key.position}`)
      : null
    const l = m.loserTo
      ? idByKey.get(`${m.loserTo.key.side}:${m.loserTo.key.round}:${m.loserTo.key.position}`)
      : null

    // A destination the engine named must exist. If it does not, the engine and
    // the writer disagree about the topology and the whole generation is
    // abandoned rather than committed half-wired.
    if (m.winnerTo && !w) throw new Error(`bracket: winner destination missing for ${keyOf(m)}`)
    if (m.loserTo && !l) throw new Error(`bracket: loser destination missing for ${keyOf(m)}`)

    await tx
      .update(eventMatches)
      .set({
        winnerNextMatchId: w ?? null,
        winnerNextSlot: m.winnerTo?.slot ?? null,
        loserNextMatchId: l ?? null,
        loserNextSlot: m.loserTo?.slot ?? null,
      })
      .where(eq(eventMatches.id, id))
  }

  await writeAudit(tx, ctx, {
    action: 'bracket_generated',
    entityId: eventId,
    before: {},
    after: {
      format: event.format,
      participants: checkedIn.length,
      matches: generated.length,
    },
  })

  return { format: event.format, participants: checkedIn.length, matches: generated.length }
}

/**
 * Discard an event's draw so it can be redrawn.
 *
 * Refuses once ANY result has been recorded. Losing a played result is not
 * recoverable — nobody remembers the score of the third match on a Saturday
 * afternoon — so redrawing is only offered while the draw is still untouched
 * (a manager generated it before the last entrant checked in, say). Beyond that
 * point the answer is to correct the individual match, not to destroy the
 * tournament.
 */
export async function resetEventBracket(
  tx: DB,
  ctx: ActiveContext,
  eventId: string,
): Promise<number> {
  const [event] = await tx
    .select({ id: events.id })
    .from(events)
    .where(and(eq(events.id, eventId), eq(events.tenantId, ctx.tenant.id)))
    .for('update')
    .limit(1)
  if (!event) throw new EventError('Event not found.')

  const [{ played }] = await tx
    .select({ played: sql<number>`count(*)`.mapWith(Number) })
    .from(eventMatches)
    .where(
      and(
        eq(eventMatches.tenantId, ctx.tenant.id),
        eq(eventMatches.eventId, eventId),
        eq(eventMatches.status, 'completed'),
      ),
    )

  if (played > 0) {
    throw new EventError(
      `${played} result${played === 1 ? ' has' : 's have'} already been entered. ` +
        'Correct the individual matches instead — resetting would discard them.',
    )
  }

  // Pointers are self-referential, so clear them before deleting the rows.
  await tx
    .update(eventMatches)
    .set({ winnerNextMatchId: null, winnerNextSlot: null, loserNextMatchId: null, loserNextSlot: null })
    .where(and(eq(eventMatches.tenantId, ctx.tenant.id), eq(eventMatches.eventId, eventId)))

  const deleted = await tx
    .delete(eventMatches)
    .where(and(eq(eventMatches.tenantId, ctx.tenant.id), eq(eventMatches.eventId, eventId)))
    .returning({ id: eventMatches.id })

  await writeAudit(tx, ctx, {
    action: 'bracket_reset',
    entityId: eventId,
    before: { matches: deleted.length },
    after: {},
  })

  return deleted.length
}

// ── score entry and advancement ──────────────────────────────────────────────

export type RecordResultInput = { matchId: string; scoreA: number; scoreB: number | null }

export type RecordResultOutcome = {
  matchId: string
  winner: string | null
  advancedTo: string | null
  loserRoutedTo: string | null
}

/**
 * Record a result and advance the bracket. ONE transaction, in this order:
 *
 *   1. lock the match (`for update`)
 *   2. verify it is still scoreable
 *   3. verify both participants are present
 *   4. validate the score and DERIVE the winner — the client never sends one
 *   5. mark it completed
 *   6. write the winner into the next match's stored slot
 *   7. route the loser, if this bracket routes losers
 *   8. commit
 *
 * Anything that throws rolls all of it back, so a match can never be completed
 * without its advancement, nor advanced without being completed.
 *
 * ── Concurrency ─────────────────────────────────────────────────────────────
 *
 * The `for update` on step 1 is what makes two staff submitting the same match
 * safe: the second waits, then re-reads the row inside its own transaction,
 * sees `completed`, and is refused. It cannot produce a second winner and
 * cannot advance anybody twice.
 */
export async function recordMatchResult(
  tx: DB,
  ctx: ActiveContext,
  input: RecordResultInput,
): Promise<RecordResultOutcome> {
  const [match] = await tx
    .select({
      id: eventMatches.id,
      eventId: eventMatches.eventId,
      side: eventMatches.side,
      round: eventMatches.round,
      position: eventMatches.position,
      status: eventMatches.status,
      a: eventMatches.participantA,
      b: eventMatches.participantB,
      winnerNextMatchId: eventMatches.winnerNextMatchId,
      winnerNextSlot: eventMatches.winnerNextSlot,
      loserNextMatchId: eventMatches.loserNextMatchId,
      loserNextSlot: eventMatches.loserNextSlot,
    })
    .from(eventMatches)
    .where(and(eq(eventMatches.id, input.matchId), eq(eventMatches.tenantId, ctx.tenant.id)))
    .for('update')
    .limit(1)

  if (!match) throw new EventError('Match not found.')

  // The EVENT's own state, which this path never consulted: it read
  // event_matches and nothing else, so a cancelled tournament's bracket stayed
  // fully scoreable. generateEventBracket() and resetEventBracket() both refuse
  // on the event, and score entry is the third door into the same bracket.
  //
  // Read after the match lock, so the id is already known to be this tenant's.
  const [parent] = await tx
    .select({ status: events.status })
    .from(events)
    .where(and(eq(events.id, match.eventId), eq(events.tenantId, ctx.tenant.id)))
    .limit(1)
  if (!parent) throw new EventError('Event not found.')
  if (parent.status === 'cancelled') {
    throw new EventError('This event has been cancelled, so its results can no longer be changed.')
  }

  if (match.status === 'completed') {
    throw new EventError('This match already has a result. Nothing has been changed.')
  }
  if (match.status === 'bye') {
    throw new EventError('This is a bye — there is nothing to play, and the entrant has advanced.')
  }
  if (match.status === 'void') {
    throw new EventError('This match will not be played.')
  }

  const isPoints = match.side === 'points'
  if (!match.a || (!isPoints && !match.b)) {
    throw new EventError('Both participants must be decided before a result can be entered.')
  }

  const verdict = decideWinner(
    match.side as BracketSide,
    { scoreA: input.scoreA, scoreB: input.scoreB },
    !isPoints,
  )
  if (!verdict.ok) throw new EventError(verdict.error)

  const winner =
    verdict.winner === 'a' ? match.a : verdict.winner === 'b' ? (match.b as string) : null
  const loser =
    verdict.winner === 'a' ? (match.b as string) : verdict.winner === 'b' ? match.a : null

  const now = new Date()
  const updated = await tx
    .update(eventMatches)
    .set({
      scoreA: input.scoreA,
      scoreB: isPoints ? null : input.scoreB,
      winner,
      status: 'completed',
      completedAt: now,
    })
    .where(
      and(
        eq(eventMatches.id, match.id),
        eq(eventMatches.tenantId, ctx.tenant.id),
        // Re-assert the pre-state inside the write. Belt and braces beside the
        // row lock: if anything moved, this updates nothing and the throw below
        // rolls the transaction back rather than double-advancing.
        inArray(eventMatches.status, ['pending', 'ready']),
      ),
    )
    .returning({ id: eventMatches.id })

  if (updated.length === 0) {
    throw new EventError('This match was just scored by someone else. Nothing has been changed.')
  }

  // ── advancement, by POINTER ───────────────────────────────────────────────
  let advancedTo: string | null = null
  let loserRoutedTo: string | null = null

  if (winner && match.winnerNextMatchId && match.winnerNextSlot) {
    await placeParticipant(tx, ctx, match.winnerNextMatchId, match.winnerNextSlot as Slot, winner)
    advancedTo = match.winnerNextMatchId
  }

  if (loser && match.loserNextMatchId && match.loserNextSlot) {
    await placeParticipant(tx, ctx, match.loserNextMatchId, match.loserNextSlot as Slot, loser)
    loserRoutedTo = match.loserNextMatchId
  }

  // ── the grand-final reset ────────────────────────────────────────────────
  //
  // The documented rule (see generateDoubleElimination): the reset is played
  // ONLY when the losers-bracket champion wins the first grand final. If the
  // winners-bracket champion wins it, they have never lost and the tournament
  // is over — so the reset row, which exists in the draw from the start, is
  // voided rather than left sitting there implying another match.
  if (match.side === 'final' && match.round === 1 && winner === match.a) {
    await tx
      .update(eventMatches)
      .set({ status: 'void', participantA: null, participantB: null })
      .where(
        and(
          eq(eventMatches.tenantId, ctx.tenant.id),
          eq(eventMatches.eventId, match.eventId),
          eq(eventMatches.side, 'final'),
          eq(eventMatches.round, 2),
          // Only if untouched — never void a match somebody already scored.
          inArray(eventMatches.status, ['pending', 'ready']),
        ),
      )
    advancedTo = null
  }

  await writeAudit(tx, ctx, {
    action: 'match_result_recorded',
    entityId: match.id,
    before: { status: match.status, a: match.a, b: match.b },
    after: {
      eventId: match.eventId,
      side: match.side,
      round: match.round,
      position: match.position,
      scoreA: input.scoreA,
      scoreB: isPoints ? null : input.scoreB,
      winner,
      advancedTo,
      loserRoutedTo,
    },
  })

  return { matchId: match.id, winner, advancedTo, loserRoutedTo }
}

/**
 * Write one participant into one slot of a later match.
 *
 * Only fills an EMPTY slot: the `is null` predicate means a second attempt to
 * route the same person — a replayed request, a redelivered action — changes
 * nothing rather than overwriting whoever is already there. That is what makes
 * "loser is routed exactly once" true under concurrency.
 *
 * Promotes the match to `ready` once both slots are filled, so score entry can
 * open exactly when it becomes playable and not before.
 */
async function placeParticipant(
  tx: DB,
  ctx: ActiveContext,
  matchId: string,
  slot: Slot,
  registrationId: string,
): Promise<void> {
  const column = slot === 'a' ? eventMatches.participantA : eventMatches.participantB

  await tx
    .update(eventMatches)
    .set(slot === 'a' ? { participantA: registrationId } : { participantB: registrationId })
    .where(
      and(
        eq(eventMatches.id, matchId),
        eq(eventMatches.tenantId, ctx.tenant.id),
        isNull(column),
      ),
    )

  // Re-read and open it for scoring if it is now complete. A points card has no
  // opponent, but points matches are never a destination, so both slots apply.
  const [row] = await tx
    .select({ a: eventMatches.participantA, b: eventMatches.participantB, status: eventMatches.status })
    .from(eventMatches)
    .where(and(eq(eventMatches.id, matchId), eq(eventMatches.tenantId, ctx.tenant.id)))
    .limit(1)

  if (row && row.a && row.b && row.status === 'pending') {
    await tx
      .update(eventMatches)
      .set({ status: 'ready' })
      .where(
        and(
          eq(eventMatches.id, matchId),
          eq(eventMatches.tenantId, ctx.tenant.id),
          eq(eventMatches.status, 'pending'),
        ),
      )
  }
}

/**
 * Audit, into `audit_log` — the table the venue's own refunds and cancellations
 * already write to (lib/billing/refunds.ts, lib/portal/cancel.ts). No second
 * history framework, and no new table: a bracket action is a staff action on a
 * tenant's data, which is exactly what that trail is for.
 *
 * Written in the SAME transaction as the change, so a result cannot exist
 * without the record of who entered it.
 */
async function writeAudit(
  tx: DB,
  ctx: ActiveContext,
  entry: {
    action: string
    entityId: string
    before: Record<string, unknown>
    after: Record<string, unknown>
  },
): Promise<void> {
  await tx.insert(auditLog).values({
    tenantId: ctx.tenant.id,
    actorMembershipId: ctx.membershipId ?? null,
    action: entry.action,
    entityType: 'event_match',
    entityId: entry.entityId,
    before: entry.before,
    after: entry.after,
  })
}

// ── readers ──────────────────────────────────────────────────────────────────

export type BracketMatchRow = {
  id: string
  side: BracketSide
  round: number
  position: number
  status: string
  participantA: string | null
  participantB: string | null
  nameA: string | null
  nameB: string | null
  scoreA: number | null
  scoreB: number | null
  winner: string | null
}

export type EventBracketView = {
  format: TournamentFormat | null
  matches: BracketMatchRow[]
  standings: ReturnType<typeof computeStandings>
  /** Seeded participant order, for the standings tiebreak and the UI. */
  participants: { registrationId: string; name: string }[]
}

/**
 * The whole draw for one event, with participant names resolved.
 *
 * Names come from the registration's customer or its team, joined here rather
 * than stored on the match — the match holds ids only, so a renamed team shows
 * its new name everywhere at once and nothing can drift.
 */
export async function getEventBracket(
  ctx: ActiveContext,
  eventId: string,
): Promise<EventBracketView> {
  return withUser(ctx.user.id, async (tx) => {
    const [event] = await tx
      .select({ format: events.tournamentFormat })
      .from(events)
      .where(and(eq(events.id, eventId), eq(events.tenantId, ctx.tenant.id)))
      .limit(1)

    const rows = await tx
      .select({
        id: eventMatches.id,
        side: eventMatches.side,
        round: eventMatches.round,
        position: eventMatches.position,
        status: eventMatches.status,
        participantA: eventMatches.participantA,
        participantB: eventMatches.participantB,
        scoreA: eventMatches.scoreA,
        scoreB: eventMatches.scoreB,
        winner: eventMatches.winner,
      })
      .from(eventMatches)
      .where(and(eq(eventMatches.tenantId, ctx.tenant.id), eq(eventMatches.eventId, eventId)))
      .orderBy(
        asc(eventMatches.side),
        asc(eventMatches.round),
        asc(eventMatches.position),
      )

    const { names, seeded } = await participantNames(tx, ctx.tenant.id, eventId)
    const nameOf = (id: string | null) => (id ? (names.get(id) ?? 'Entrant') : null)

    const matches: BracketMatchRow[] = rows.map((r) => ({
      ...r,
      side: r.side as BracketSide,
      nameA: nameOf(r.participantA),
      nameB: nameOf(r.participantB),
    }))

    const format = isFormat(event?.format) ? event.format : null

    // Standings only mean something for the table formats.
    let standings: EventBracketView['standings'] = []

    // Everyone actually drawn into this bracket, in seeded (arrival) order.
    //
    // THE SPLIT THAT MATTERS: `drawn` — the ids the match rows name — decides
    // MEMBERSHIP; `seeded` only decides ORDER. computeStandings() builds its
    // table solely from the list handed to it, so an id missing from that list
    // is not merely unnamed, it is absent from the leaderboard and every rank
    // below it silently shifts up. Membership therefore has to come from the
    // same rows the board renders, never from a second query that might not
    // agree with them.
    //
    // Two queries CAN disagree. `seeded` comes from participantNames(), which
    // filters `r.event_id = eventId`, while nothing at the schema level pinned
    // a match's participant to a registration of the same event until 0102 —
    // event_matches_a_fk carried (tenant_id, participant_a) only. So the
    // append below is what a drawn-but-unnamed id degrades to: an 'Entrant'
    // row that ranks, rather than a competitor deleted from the table.
    //
    // It is sorted by registration id — the seeding rule's own secondary key —
    // so the result stays a total order instead of depending on the order the
    // match rows happened to come back in.
    //
    // Narrowing to `drawn` is also what keeps a LATE check-in out: they are on
    // the event, so `seeded` has them, but the bracket was built without them.
    const drawn = new Set(
      rows.flatMap((r) => [r.participantA, r.participantB]).filter((x): x is string => x !== null),
    )
    const named = new Set(seeded)
    const seedOrder = [
      ...seeded.filter((id) => drawn.has(id)),
      ...[...drawn].filter((id) => !named.has(id)).sort(),
    ]

    if (format === 'round_robin' || format === 'points') {
      standings = computeStandings(
        format,
        seedOrder,
        rows.map((r) => ({
          side: r.side as BracketSide,
          a: r.participantA,
          b: r.participantB,
          scoreA: r.scoreA,
          scoreB: r.scoreB,
          winner: r.winner,
        })),
      )
    }

    return {
      format,
      matches,
      standings,
      participants: seedOrder.map((id) => ({ registrationId: id, name: names.get(id) ?? 'Entrant' })),
    }
  })
}

/**
 * Display names, plus the registration ids IN SEEDED ORDER.
 *
 * The order is the one thing here that is not cosmetic. `computeStandings`
 * takes seedOrder as its final total-order tiebreak and documents it as
 * "whoever checked in first", so the sequence has to be the SAME rule
 * seedParticipants() applied when the draw was built: `checked_in_at`
 * ascending, ties broken on the registration id — see THE SEEDING RULE in
 * lib/events/bracket.ts, and listCheckedInParticipants(), which orders
 * identically.
 *
 * It is ordered here rather than reconstructed from the match rows because
 * the draw does not preserve arrival order: generateRoundRobin's circle method
 * pairs seed 0 against the LAST seed, seed 1 against the second-last, and so
 * on, so walking the rows yields 0, last, 1, last-1, … Deriving the tiebreak
 * from that ranked tied competitors in an order nobody could explain, and one
 * that contradicted the documented rule.
 *
 * Name lookup is a Map; order is a separate array, because a Map keyed by id
 * cannot express "and this is the sequence" for callers that need both.
 */
async function participantNames(
  tx: DB,
  tenantId: string,
  eventId: string,
): Promise<{ names: Map<string, string>; seeded: string[] }> {
  const rows = await tx.execute<{ id: string; label: string }>(sql`
    select r.id,
           coalesce(t.name, c.name, 'Entrant') as label
      from public.event_registrations r
      join public.customers c on c.id = r.customer_id
      left join public.event_teams t on t.id = r.team_id
     where r.tenant_id = ${tenantId} and r.event_id = ${eventId}
       -- Only the participants the draw actually names. Without this the
       -- reader fetched and sorted EVERY registration on the event —
       -- cancelled, waitlisted, unpaid — to label a few dozen, and it
       -- answered "who is a participant" with different SQL from
       -- public_event_participants() (0099/0101), which is the asymmetry
       -- that let the two readers' seed order diverge in the first place.
       and exists (
         select 1 from public.event_matches m
          where m.tenant_id = r.tenant_id
            and m.event_id = r.event_id
            and (m.participant_a = r.id or m.participant_b = r.id)
       )
     order by r.checked_in_at asc nulls last, r.id asc
  `)
  return {
    names: new Map(rows.rows.map((r) => [r.id, r.label])),
    seeded: rows.rows.map((r) => r.id),
  }
}
