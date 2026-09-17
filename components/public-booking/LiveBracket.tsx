'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'

/**
 * The public live bracket / leaderboard (M15 #7).
 *
 * ── It renders. It does not compute ─────────────────────────────────────────
 *
 * No bracket maths, no advancement, no ranking. Every match and every standings
 * row arrives already decided by the server — the pure engine from M15 #6
 * produced the draw, staff wrote the results, and lib/events/public-live.ts
 * computed the table with the SAME computeStandings() the staff board uses.
 * This file's entire job is layout plus a refresh timer.
 *
 * ── Polling, done once and cleanly ──────────────────────────────────────────
 *
 * One interval, the same `setInterval(() => router.refresh())` idiom
 * KitchenQueue and IncomingOrdersQueue already use — a server refetch of the
 * one consistent snapshot, not a bespoke fetch that could disagree with the
 * page it is updating. On top of that idiom this adds three things a venue
 * screen needs:
 *
 *   * it PAUSES when the tab is hidden (`visibilitychange`), so a phone in a
 *     pocket is not polling all afternoon;
 *   * it REFRESHES IMMEDIATELY on becoming visible again, so a spectator who
 *     looks back at their phone sees the current state rather than waiting out
 *     the interval;
 *   * it STOPS for good once the tournament is complete — there is nothing left
 *     to learn, and a finished bracket should not keep a screen awake.
 *
 * The effect returns a teardown for both the interval and the listener, so
 * navigating away leaves no timer behind. There is exactly one timer: the
 * interval id lives in a ref and is always cleared before a new one is set.
 *
 * ── The realtime upgrade path (M10) ─────────────────────────────────────────
 *
 * M10 does not exist yet — there is no websocket, no subscription client and no
 * realtime table anywhere in this codebase — so polling is the implementation,
 * as the ticket directs. It is contained in the single effect below: when M10
 * lands, that effect is replaced by a subscription that calls the same
 * `router.refresh()`, and no bracket markup changes. Nothing else in this file
 * knows how the data arrives.
 */

type Person = { id: string; name: string } | null

type Match = {
  id: string
  side: 'winners' | 'losers' | 'final' | 'round_robin' | 'points'
  round: number
  position: number
  status: 'pending' | 'ready' | 'completed' | 'bye' | 'void'
  a: Person
  b: Person
  scoreA: number | null
  scoreB: number | null
  winnerId: string | null
}

type Standing = {
  registrationId: string
  name: string
  played: number
  won: number
  lost: number
  pointsFor: number
  pointsAgainst: number
  rank: number
}

const POLL_MS = 8000

const SIDE_LABEL: Record<Match['side'], string> = {
  winners: 'Winners bracket',
  losers: 'Losers bracket',
  final: 'Final',
  round_robin: 'Fixtures',
  points: 'Score cards',
}

export function LiveBracket({
  format,
  matches,
  standings,
  isComplete,
  tv,
}: {
  format: string | null
  matches: Match[]
  standings: Standing[]
  isComplete: boolean
  tv: boolean
}) {
  const router = useRouter()
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)
  const [updatedAt, setUpdatedAt] = useState<number>(() => Date.now())

  useEffect(() => {
    // Nothing further can happen — stop, and never restart.
    if (isComplete) return

    const stop = () => {
      if (timer.current !== null) {
        clearInterval(timer.current)
        timer.current = null
      }
    }
    const start = () => {
      stop() // never leave a second timer running
      timer.current = setInterval(() => {
        router.refresh()
        setUpdatedAt(Date.now())
      }, POLL_MS)
    }

    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        router.refresh() // catch up immediately, then resume
        setUpdatedAt(Date.now())
        start()
      } else {
        stop()
      }
    }

    if (document.visibilityState === 'visible') start()
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [router, isComplete])

  const isTable = format === 'round_robin' || format === 'points'

  if (matches.length === 0) {
    return (
      <p className={`mt-8 text-center ${tv ? 'text-3xl' : 'text-base'} text-muted-foreground`}>
        The draw has not been made yet. This page updates on its own.
      </p>
    )
  }

  const bySide = new Map<Match['side'], Match[]>()
  for (const m of matches) bySide.set(m.side, [...(bySide.get(m.side) ?? []), m])

  return (
    <div className={tv ? 'space-y-10' : 'space-y-8'}>
      {isTable && standings.length > 0 && (
        <Leaderboard rows={standings} format={format} tv={tv} />
      )}

      {(['winners', 'losers', 'final', 'round_robin', 'points'] as const).map((side) => {
        const group = bySide.get(side)
        if (!group?.length) return null
        const rounds = [...new Set(group.map((m) => m.round))].sort((a, b) => a - b)
        return (
          <section key={side}>
            <h2
              className={`font-semibold ${tv ? 'text-4xl' : 'text-lg'}`}
              // Winners/losers must be unmistakable on a venue screen at 10m.
            >
              {SIDE_LABEL[side]}
            </h2>

            {/* Large elimination draws scroll HORIZONTALLY rather than shrinking
                until nothing is readable — the round columns keep their width
                and the viewer swipes. On a phone that is the only layout that
                stays legible; on a TV it simply never overflows. */}
            <div className="mt-3 overflow-x-auto pb-2">
              <div className={`flex gap-4 ${side === 'round_robin' || side === 'points' ? 'flex-col' : 'min-w-max'}`}>
                {rounds.map((round) => (
                  <div
                    key={round}
                    className={
                      side === 'round_robin' || side === 'points'
                        ? ''
                        : tv
                          ? 'w-[26rem] shrink-0'
                          : 'w-64 shrink-0'
                    }
                  >
                    <p
                      className={`uppercase tracking-wide text-muted-foreground ${tv ? 'text-xl' : 'text-xs'}`}
                    >
                      {side === 'final'
                        ? round === 1
                          ? 'Grand final'
                          : 'Reset'
                        : side === 'round_robin'
                          ? `Round ${round}`
                          : `Round ${round}`}
                    </p>
                    <ul className={`mt-2 ${tv ? 'space-y-4' : 'space-y-2'}`}>
                      {group
                        .filter((m) => m.round === round)
                        .sort((a, b) => a.position - b.position)
                        .map((m) => (
                          <MatchCard key={m.id} match={m} tv={tv} />
                        ))}
                    </ul>
                  </div>
                ))}
              </div>
            </div>
          </section>
        )
      })}

      <p className={`text-center text-muted-foreground ${tv ? 'text-xl' : 'text-xs'}`}>
        {isComplete ? (
          'Final result'
        ) : (
          <>
            Updates automatically
            <span className="sr-only"> — last refreshed {new Date(updatedAt).toISOString()}</span>
          </>
        )}
      </p>
    </div>
  )
}

/**
 * One match card.
 *
 * Status is carried by BOTH colour and a word, never colour alone: a venue
 * screen is often viewed at an angle, and a spectator who is colour-blind gets
 * the same information either way.
 */
function MatchCard({ match, tv }: { match: Match; tv: boolean }) {
  const live = match.status === 'ready'
  const done = match.status === 'completed'

  return (
    <li
      className={[
        'rounded-xl border px-3 py-2.5',
        tv ? 'px-5 py-4' : '',
        // The ACTIVE match is the one a spectator is looking for. A ring plus a
        // label, and deliberately no animation — a venue screen that pulses is
        // harder to read, not easier.
        live
          ? 'border-primary bg-primary/5 ring-2 ring-primary/40'
          : done
            ? 'border-border bg-card'
            : 'border-dashed border-border bg-card/50',
      ].join(' ')}
    >
      <div className="flex items-center justify-between gap-2">
        <span className={`uppercase tracking-wide text-muted-foreground ${tv ? 'text-base' : 'text-[10px]'}`}>
          {match.status === 'bye'
            ? 'Bye'
            : match.status === 'void'
              ? 'Not played'
              : live
                ? 'Up now'
                : done
                  ? 'Final'
                  : 'To come'}
        </span>
      </div>

      <Row person={match.a} score={match.scoreA} won={done && match.winnerId === match.a?.id} tv={tv} />
      {match.side !== 'points' && (
        <Row person={match.b} score={match.scoreB} won={done && match.winnerId === match.b?.id} tv={tv} />
      )}
    </li>
  )
}

function Row({
  person,
  score,
  won,
  tv,
}: {
  person: Person
  score: number | null
  won: boolean
  tv: boolean
}) {
  return (
    <div className={`mt-1 flex items-baseline justify-between gap-3 ${tv ? 'text-3xl' : 'text-sm'}`}>
      <span
        className={[
          'min-w-0 truncate',
          won ? 'font-bold text-foreground' : person ? 'text-foreground/90' : 'italic text-muted-foreground',
        ].join(' ')}
      >
        {person?.name ?? 'To be decided'}
        {/* The winner is marked with a word as well as weight, for the same
            reason the status is: weight alone does not survive a glance. */}
        {won && <span className={`ml-2 font-medium text-emerald-600 ${tv ? 'text-2xl' : 'text-xs'}`}>won</span>}
      </span>
      {score !== null && (
        <span className={`shrink-0 font-semibold tabular-nums ${tv ? 'text-3xl' : 'text-sm'}`}>
          {score}
        </span>
      )}
    </div>
  )
}

function Leaderboard({
  rows,
  format,
  tv,
}: {
  rows: Standing[]
  format: string | null
  tv: boolean
}) {
  const showWl = format === 'round_robin'
  return (
    <section>
      <h2 className={`font-semibold ${tv ? 'text-4xl' : 'text-lg'}`}>Standings</h2>
      <div className="mt-3 overflow-x-auto rounded-xl border border-border">
        <table className={`w-full ${tv ? 'text-2xl' : 'text-sm'}`}>
          <thead className="bg-muted/50 text-left uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className={tv ? 'px-5 py-3' : 'px-3 py-2'}>#</th>
              <th className={tv ? 'px-5 py-3' : 'px-3 py-2'}>Competitor</th>
              <th className={`text-right ${tv ? 'px-5 py-3' : 'px-3 py-2'}`}>P</th>
              {showWl && (
                <>
                  <th className={`text-right ${tv ? 'px-5 py-3' : 'px-3 py-2'}`}>W</th>
                  <th className={`text-right ${tv ? 'px-5 py-3' : 'px-3 py-2'}`}>L</th>
                </>
              )}
              <th className={`text-right ${tv ? 'px-5 py-3' : 'px-3 py-2'}`}>Pts</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((r) => (
              <tr key={r.registrationId} className={r.rank === 1 ? 'bg-primary/5 font-semibold' : ''}>
                <td className={`tabular-nums ${tv ? 'px-5 py-3' : 'px-3 py-2'}`}>{r.rank}</td>
                <td className={`${tv ? 'px-5 py-3' : 'px-3 py-2'}`}>{r.name}</td>
                <td className={`text-right tabular-nums ${tv ? 'px-5 py-3' : 'px-3 py-2'}`}>{r.played}</td>
                {showWl && (
                  <>
                    <td className={`text-right tabular-nums ${tv ? 'px-5 py-3' : 'px-3 py-2'}`}>{r.won}</td>
                    <td className={`text-right tabular-nums ${tv ? 'px-5 py-3' : 'px-3 py-2'}`}>{r.lost}</td>
                  </>
                )}
                <td className={`text-right font-semibold tabular-nums ${tv ? 'px-5 py-3' : 'px-3 py-2'}`}>
                  {r.pointsFor}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
