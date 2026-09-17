import 'server-only'
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { cache } from 'react'
import { withPublicTenant } from '@/db'
import { branches, eventMatches, events } from '@/db/schema'
import {
  computeStandings,
  type BracketSide,
  type StandingRow,
  type TournamentFormat,
} from './bracket'
import type { EventStatus, EventType, TournamentFormat as EventFormat } from './types'

/**
 * THE PUBLIC LIVE READER (M15 #7).
 *
 * One read, for spectators. It resolves the pinned public tenant, checks the
 * event is publicly visible, fetches the draw, resolves display names through a
 * narrow SECURITY DEFINER projection, and computes standings with the SAME pure
 * function the staff board uses.
 *
 * ══ NO SECOND BRACKET ENGINE, AND NO SECOND STANDINGS RULE ══════════════════
 *
 * `computeStandings()` is imported from lib/events/bracket.ts — the pure engine
 * from M15 #6, tested without a database. The staff board calls it through
 * getEventBracket(); this calls the same function on the same rows. That is
 * what makes it impossible for the public leaderboard and the staff leaderboard
 * to disagree: there is one calculation, not two that happen to match today.
 *
 * Advancement is likewise not recomputed. The public page renders
 * `event_matches` exactly as staff wrote it, so who is in the next match is
 * whatever the persisted row says.
 *
 * ══ WHAT CROSSES THE BOUNDARY ══════════════════════════════════════════════
 *
 * A deliberate DTO, not a database row. Out go: match coordinates, statuses,
 * scores, winner, and a participant's DISPLAY NAME. That last one is the point
 * of a bracket — a draw with anonymous cells is not a spectator feature — and
 * it is the only participant attribute exposed.
 *
 * Never crossing: customer ids, phone numbers, emails, `paid_amount`,
 * `payment_reference`, `payment_hold_expires_at`, `refund_required`,
 * `check_in_token`, audit rows, or the next-match POINTERS (internal topology a
 * spectator has no use for). `event_registrations` is not readable on the
 * public path at all — see migration 0099.
 *
 * Registration ids DO appear, because a bracket has to say that the winner of
 * match 1 is the same competitor as the player in match 5. They are opaque
 * uuids that grant nothing: every public policy is SELECT-only and every
 * mutation requires a manager session.
 */

/** Statuses a spectator may reach. The outer bound migration 0099 enforces. */
export const PUBLIC_LIVE_STATUSES = [
  'published',
  'registration_open',
  'full',
  'in_progress',
  'completed',
] as const satisfies readonly EventStatus[]

export function isLivePubliclyVisible(status: EventStatus): boolean {
  return (PUBLIC_LIVE_STATUSES as readonly EventStatus[]).includes(status)
}

/** One match, as a spectator sees it. */
export type PublicMatch = {
  /** Opaque; used only to key React rows. */
  id: string
  side: BracketSide
  round: number
  position: number
  status: 'pending' | 'ready' | 'completed' | 'bye' | 'void'
  a: { id: string; name: string } | null
  b: { id: string; name: string } | null
  scoreA: number | null
  scoreB: number | null
  winnerId: string | null
}

export type PublicStanding = StandingRow & { name: string }

export type PublicLiveEvent = {
  id: string
  title: string
  description: string | null
  bannerUrl: string | null
  type: EventType
  format: EventFormat | null
  status: EventStatus
  startsAt: Date
  endsAt: Date
  branchName: string | null
  /** How many competitors are actually in the draw. */
  participantCount: number
}

export type PublicLiveView = {
  event: PublicLiveEvent
  matches: PublicMatch[]
  standings: PublicStanding[]
  /**
   * True when nothing further can be played — every match is completed, a bye
   * or void. The client stops polling on this, so it is computed on the SERVER
   * from the same snapshot the matches came from rather than inferred in the
   * browser.
   */
  isComplete: boolean
  /** The champion's display name once the tournament has resolved, else null. */
  champion: string | null
}

const isFormat = (v: unknown): v is TournamentFormat =>
  v === 'single_elim' || v === 'double_elim' || v === 'round_robin' || v === 'points'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Everything the public live page renders, from ONE consistent snapshot.
 *
 * ── Why it is one transaction, and what that does NOT buy ───────────────────
 *
 * The event, the matches and the names are read inside a single
 * withPublicTenant() transaction: one round trip instead of three, and one
 * pinned tenant GUC for every statement in it, so the tenant cannot be
 * re-resolved halfway through a read.
 *
 * It is NOT a snapshot. withPublicTenant() opens the connection's default
 * isolation level — READ COMMITTED — so each statement below sees its own
 * snapshot and a commit landing between them is visible to the later ones.
 * Raising this transaction to REPEATABLE READ is deliberately not done:
 * withPublicTenant() also carries the public WRITE paths (booking creation,
 * order placement), and a stricter level would buy them 40001 serialisation
 * retries for a guarantee only this reader wants.
 *
 * So the reader TOLERATES the disagreement instead of forbidding it. Standings
 * are derived in memory from the very `matchRows` array that gets rendered,
 * never re-queried, so the table can never contradict the draw beside it; and
 * the seed order below takes those same rows as the authority on who is in the
 * bracket, so a draw reset committed mid-read degrades to unnamed entrants
 * rather than to a leaderboard with competitors missing from it.
 *
 * `cache()` dedupes within a single render pass, so the page body and
 * generateMetadata() share one read instead of issuing two.
 */
export const getPublicEventLive = cache(async function getPublicEventLive(
  tenantId: string,
  eventId: string,
): Promise<PublicLiveView | null> {
  // A malformed id would make Postgres raise 22P02 and surface as a 500 on a
  // URL somebody simply mistyped. Same guard getPublicEventById uses.
  if (!UUID_RE.test(eventId)) return null

  return withPublicTenant(tenantId, async (tx) => {
    const [row] = await tx
      .select({
        id: events.id,
        title: events.title,
        description: events.description,
        bannerUrl: events.bannerUrl,
        type: events.type,
        format: events.tournamentFormat,
        status: events.status,
        startsAt: events.startsAt,
        endsAt: events.endsAt,
        branchName: branches.name,
      })
      .from(events)
      .leftJoin(branches, eq(branches.id, events.branchId))
      .where(
        and(
          eq(events.id, eventId),
          // Belt-and-braces on top of events_public_select: even if that policy
          // were ever loosened, this cannot cross a tenant boundary.
          eq(events.tenantId, tenantId),
          inArray(events.status, [...PUBLIC_LIVE_STATUSES]),
        ),
      )
      .limit(1)

    // Null covers every non-public case identically — unknown id, another
    // tenant's event, a draft, a cancelled one. The caller 404s, so a visitor
    // cannot tell a hidden event from one that does not exist.
    if (!row) return null

    const matchRows = await tx
      .select({
        id: eventMatches.id,
        side: eventMatches.side,
        round: eventMatches.round,
        position: eventMatches.position,
        status: eventMatches.status,
        a: eventMatches.participantA,
        b: eventMatches.participantB,
        scoreA: eventMatches.scoreA,
        scoreB: eventMatches.scoreB,
        winner: eventMatches.winner,
        // NOTE: the next-match pointers are deliberately NOT selected. They are
        // internal topology; the public page renders the draw as persisted.
      })
      .from(eventMatches)
      .where(and(eq(eventMatches.tenantId, tenantId), eq(eventMatches.eventId, eventId)))
      .orderBy(asc(eventMatches.side), asc(eventMatches.round), asc(eventMatches.position))

    // Display names only, through the narrow projection. event_registrations is
    // never readable here.
    const nameRows = await tx.execute<{ registration_id: string; display_name: string; seed: number }>(
      sql`select registration_id, display_name, seed
            from public.public_event_participants(${eventId}::uuid)
           order by seed asc`,
    )
    const nameOf = new Map(nameRows.rows.map((r) => [r.registration_id, r.display_name]))
    const person = (id: string | null) =>
      id ? { id, name: nameOf.get(id) ?? 'Entrant' } : null

    const matches: PublicMatch[] = matchRows.map((m) => ({
      id: m.id,
      side: m.side as BracketSide,
      round: m.round,
      position: m.position,
      status: m.status as PublicMatch['status'],
      a: person(m.a),
      b: person(m.b),
      scoreA: m.scoreA,
      scoreB: m.scoreB,
      winnerId: m.winner,
    }))

    const format = isFormat(row.format) ? row.format : null

    // Everyone the DRAW names. The one definition of "who is in this
    // bracket", used by the standings below and by participantCount — which
    // used to count the name projection instead, so the two disagreed
    // whenever the projection returned fewer rows than the draw. Hoisted
    // above the format branch because knockout formats need the count too.
    const drawn = new Set(
      matchRows.flatMap((m) => [m.a, m.b]).filter((x): x is string => x !== null),
    )

    // ── standings, via the SHARED pure function ────────────────────────────
    let standings: PublicStanding[] = []
    if (format === 'round_robin' || format === 'points') {
      // ORDER comes from the projection's own `seed` column (0101), which is
      // arrival order — checked_in_at, ties on registration id — the same rule
      // seedParticipants() applied when the draw was built. That is what makes
      // the public tiebreak identical to the staff one AND to the rule
      // computeStandings documents.
      //
      // It is NOT derived from the match rows. A round_robin draw does not
      // preserve arrival order: generateRoundRobin pairs seed 0 with the last
      // seed, seed 1 with the second-last, and so on, so walking the rows
      // yields 0, last, 1, last-1, … — which ranked tied competitors
      // arbitrarily. (A `points` draw is one card per participant in seed
      // order, so walking THAT happened to come out right; the defect was
      // round-robin's alone. Both are read the one way regardless, because a
      // single rule is easier to keep true than two that agree by luck.)
      //
      // MEMBERSHIP, though, comes from the match rows — exactly as on the staff
      // side. computeStandings() builds its table only from the list it is
      // given, so an id missing here is gone from the leaderboard and every
      // rank below it shifts up. The projection and the match read are two
      // statements under READ COMMITTED (see the header), so a draw reset
      // between them can empty one and not the other. Ordering by seed and then
      // appending any drawn id the projection did not name — sorted by
      // registration id, the seeding rule's own secondary key — keeps that case
      // as stable 'Entrant' rows instead of a silently shortened table.
      const named = nameRows.rows.map((r) => r.registration_id)
      const namedSet = new Set(named)
      const seedOrder = [
        ...named.filter((id) => drawn.has(id)),
        ...[...drawn].filter((id) => !namedSet.has(id)).sort(),
      ]
      standings = computeStandings(
        format,
        seedOrder,
        matchRows.map((m) => ({
          side: m.side as BracketSide,
          a: m.a,
          b: m.b,
          scoreA: m.scoreA,
          scoreB: m.scoreB,
          winner: m.winner,
        })),
      ).map((s) => ({ ...s, name: nameOf.get(s.registrationId) ?? 'Entrant' }))
    }

    const playable = matches.filter((m) => m.status === 'pending' || m.status === 'ready')
    const isComplete = matches.length > 0 && playable.length === 0

    // The champion is the winner of the last decisive match: the grand final
    // (or its reset) in double elimination, the last winners round otherwise.
    // Read from the persisted winner — never recomputed.
    let champion: string | null = null
    if (isComplete && (format === 'single_elim' || format === 'double_elim')) {
      const decisive = matches
        .filter((m) => m.status === 'completed' && (m.side === 'final' || m.side === 'winners'))
        .sort((x, y) =>
          x.side === y.side ? y.round - x.round : x.side === 'final' ? -1 : 1,
        )[0]
      champion = decisive?.winnerId ? (nameOf.get(decisive.winnerId) ?? null) : null
    } else if (isComplete && standings.length > 0) {
      champion = standings[0].name
    }

    return {
      event: {
        id: row.id,
        title: row.title,
        description: row.description,
        bannerUrl: row.bannerUrl,
        type: row.type,
        format,
        status: row.status,
        startsAt: row.startsAt,
        endsAt: row.endsAt,
        branchName: row.branchName,
        participantCount: drawn.size,
      },
      matches,
      standings,
      isComplete,
      champion,
    }
  })
})

/**
 * Does this event have a draw yet?
 *
 * A `count` on the already-indexed (event_id, side, round, position) key, so
 * the event detail page can decide whether to offer the live link without
 * loading the bracket it is not going to render. Same public visibility rules
 * as the reader above: a draft or another tenant's event answers false.
 */
export const publicEventHasBracket = cache(async function publicEventHasBracket(
  tenantId: string,
  eventId: string,
): Promise<boolean> {
  if (!UUID_RE.test(eventId)) return false
  return withPublicTenant(tenantId, async (tx) => {
    const [row] = await tx
      .select({ n: sql<number>`count(*)`.mapWith(Number) })
      .from(eventMatches)
      .where(and(eq(eventMatches.tenantId, tenantId), eq(eventMatches.eventId, eventId)))
    return (row?.n ?? 0) > 0
  })
})
