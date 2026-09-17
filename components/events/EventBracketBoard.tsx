'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Loader2, Shuffle, Trophy, X } from 'lucide-react'
import {
  generateBracketAction,
  recordMatchResultAction,
  resetBracketAction,
} from '@/lib/actions/event-matches'
import { useConfirm } from '@/components/ui/ConfirmDialog'

/**
 * The staff bracket board (M15 #6 §18).
 *
 * ── There is no bracket logic in this file ──────────────────────────────────
 *
 * Not the draw, not the seeding, not the advancement, not who won. It renders
 * rows the server produced and posts two numbers back. Everything that decides
 * anything lives in lib/events/bracket.ts (pure) and lib/events/bracket-service.ts
 * (transactional) — which is the whole point of keeping the engine out of the
 * component.
 *
 * ── Why round robin and points are not drawn as a tree ─────────────────────
 *
 * Because they are not one. A round robin is a schedule and a table; a points
 * event is a leaderboard. Forcing either into a bracket shape would be a
 * picture of something that is not happening, so they render as their own
 * layouts and share only the score dialog.
 */

type Match = {
  id: string
  side: 'winners' | 'losers' | 'final' | 'round_robin' | 'points'
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

type Standing = {
  registrationId: string
  played: number
  won: number
  lost: number
  pointsFor: number
  pointsAgainst: number
  rank: number
}

const SIDE_LABEL: Record<Match['side'], string> = {
  winners: 'Winners bracket',
  losers: 'Losers bracket',
  final: 'Grand final',
  round_robin: 'Schedule',
  points: 'Score cards',
}

const STATUS_CLASS: Record<string, string> = {
  pending: 'bg-muted text-muted-foreground',
  ready: 'bg-sky-500/10 text-sky-600',
  completed: 'bg-emerald-500/10 text-emerald-600',
  bye: 'bg-amber-500/10 text-amber-700',
  void: 'bg-muted text-muted-foreground line-through',
}

const STATUS_LABEL: Record<string, string> = {
  pending: 'Waiting',
  ready: 'Ready',
  completed: 'Done',
  bye: 'Bye',
  void: 'Not played',
}

export function EventBracketBoard({
  eventId,
  format,
  matches,
  standings,
  participantNames,
  checkedInCount,
}: {
  eventId: string
  format: string | null
  matches: Match[]
  standings: Standing[]
  participantNames: Record<string, string>
  checkedInCount: number
}) {
  const router = useRouter()
  const confirm = useConfirm()
  const [pending, startTransition] = useTransition()
  const [scoring, setScoring] = useState<Match | null>(null)

  const hasBracket = matches.length > 0
  const played = matches.filter((m) => m.status === 'completed').length

  function run(fn: () => Promise<{ error?: string }>, ok: string) {
    startTransition(async () => {
      const r = await fn()
      if (r.error) toast.error(r.error)
      else {
        toast.success(ok)
        setScoring(null)
        router.refresh()
      }
    })
  }

  if (!format) {
    return (
      <p className="mt-6 rounded-lg bg-muted px-4 py-3 text-sm text-muted-foreground">
        This event has no tournament format, so it has no bracket. Only tournaments are drawn.
      </p>
    )
  }

  if (!hasBracket) {
    return (
      <div className="mt-6 rounded-xl border border-border bg-card p-5 text-center shadow-sm">
        <Trophy size={22} className="mx-auto text-muted-foreground" aria-hidden />
        <p className="mt-2 text-sm font-medium">No bracket yet</p>
        <p className="mt-1 text-sm text-muted-foreground">
          {checkedInCount} participant{checkedInCount === 1 ? '' : 's'} checked in. The draw is
          built from the checked-in list, so check everyone in first.
        </p>
        <button
          type="button"
          disabled={pending}
          onClick={() => run(() => generateBracketAction(eventId), 'Bracket generated.')}
          className="mt-4 rounded-lg bg-primary px-3.5 py-2.5 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
        >
          {pending ? (
            <Loader2 size={16} className="animate-spin" aria-hidden />
          ) : (
            <span className="flex items-center gap-1.5">
              <Shuffle size={16} aria-hidden /> Generate bracket
            </span>
          )}
        </button>
      </div>
    )
  }

  const bySide = new Map<Match['side'], Match[]>()
  for (const m of matches) bySide.set(m.side, [...(bySide.get(m.side) ?? []), m])

  const isTable = format === 'round_robin' || format === 'points'

  return (
    <div className="mt-6 space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {played} of {matches.filter((m) => m.status !== 'bye' && m.status !== 'void').length}{' '}
          matches played
        </p>
        {played === 0 && (
          <button
            type="button"
            disabled={pending}
            onClick={async () => {
              const yes = await confirm({
                title: 'Reset the bracket?',
                description:
                  'The draw will be discarded so it can be generated again. Only possible while no results have been entered.',
                confirmText: 'Reset',
              })
              if (yes) run(() => resetBracketAction(eventId), 'Bracket reset.')
            }}
            className="rounded-lg border border-border px-3 py-2 text-sm transition hover:bg-muted disabled:opacity-50"
          >
            Reset bracket
          </button>
        )}
      </div>

      {isTable && standings.length > 0 && (
        <section className="rounded-xl border border-border bg-card shadow-sm">
          <h2 className="border-b px-4 py-2.5 text-sm font-semibold">Standings</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-medium">#</th>
                  <th className="px-4 py-2 font-medium">Participant</th>
                  <th className="px-4 py-2 text-right font-medium">P</th>
                  {format === 'round_robin' && (
                    <>
                      <th className="px-4 py-2 text-right font-medium">W</th>
                      <th className="px-4 py-2 text-right font-medium">L</th>
                    </>
                  )}
                  <th className="px-4 py-2 text-right font-medium">Points</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {standings.map((s) => (
                  <tr key={s.registrationId}>
                    <td className="px-4 py-2 tabular-nums">{s.rank}</td>
                    <td className="px-4 py-2 font-medium">
                      {participantNames[s.registrationId] ?? 'Entrant'}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">{s.played}</td>
                    {format === 'round_robin' && (
                      <>
                        <td className="px-4 py-2 text-right tabular-nums">{s.won}</td>
                        <td className="px-4 py-2 text-right tabular-nums">{s.lost}</td>
                      </>
                    )}
                    <td className="px-4 py-2 text-right font-semibold tabular-nums">{s.pointsFor}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {(['winners', 'losers', 'final', 'round_robin', 'points'] as const).map((side) => {
        const group = bySide.get(side)
        if (!group || group.length === 0) return null
        const rounds = [...new Set(group.map((m) => m.round))].sort((a, b) => a - b)
        return (
          <section key={side} className="rounded-xl border border-border bg-card shadow-sm">
            <h2 className="border-b px-4 py-2.5 text-sm font-semibold">{SIDE_LABEL[side]}</h2>
            <div className="divide-y">
              {rounds.map((round) => (
                <div key={round} className="px-4 py-3">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">
                    {side === 'final' ? (round === 1 ? 'Grand final' : 'Reset') : `Round ${round}`}
                  </p>
                  <ul className="mt-2 space-y-1.5">
                    {group
                      .filter((m) => m.round === round)
                      .sort((a, b) => a.position - b.position)
                      .map((m) => (
                        <li
                          key={m.id}
                          className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/70 px-3 py-2"
                        >
                          <span className="min-w-0 text-sm">
                            <Side name={m.nameA} isWinner={m.winner !== null && m.winner === m.participantA} score={m.scoreA} />
                            {m.side === 'points' ? null : (
                              <>
                                <span className="mx-1.5 text-muted-foreground">v</span>
                                <Side name={m.nameB} isWinner={m.winner !== null && m.winner === m.participantB} score={m.scoreB} />
                              </>
                            )}
                          </span>
                          <span className="flex items-center gap-2">
                            <span
                              className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_CLASS[m.status] ?? ''}`}
                            >
                              {STATUS_LABEL[m.status] ?? m.status}
                            </span>
                            {(m.status === 'ready' || m.status === 'completed') && (
                              <button
                                type="button"
                                onClick={() => setScoring(m)}
                                disabled={pending || m.status === 'completed'}
                                className="rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                              >
                                {m.status === 'completed' ? 'Recorded' : 'Enter result'}
                              </button>
                            )}
                          </span>
                        </li>
                      ))}
                  </ul>
                </div>
              ))}
            </div>
          </section>
        )
      })}

      {scoring && (
        <ScoreDialog
          match={scoring}
          eventId={eventId}
          pending={pending}
          onClose={() => setScoring(null)}
          onSave={(scoreA, scoreB) =>
            run(
              () =>
                recordMatchResultAction({ matchId: scoring.id, eventId, scoreA, scoreB }),
              'Result recorded.',
            )
          }
        />
      )}
    </div>
  )
}

function Side({
  name,
  isWinner,
  score,
}: {
  name: string | null
  isWinner: boolean
  score: number | null
}) {
  return (
    <span className={isWinner ? 'font-semibold text-foreground' : 'text-muted-foreground'}>
      {name ?? <span className="italic">TBD</span>}
      {score !== null && <span className="ml-1 tabular-nums">({score})</span>}
    </span>
  )
}

/**
 * Two number fields and nothing else.
 *
 * There is deliberately no "winner" control: the server derives the winner from
 * the scores (decideWinner in the pure engine), so offering one here would let
 * the screen imply a choice the server does not accept.
 */
function ScoreDialog({
  match,
  pending,
  onClose,
  onSave,
}: {
  match: Match
  eventId: string
  pending: boolean
  onClose: () => void
  onSave: (scoreA: number, scoreB: number | null) => void
}) {
  const isPoints = match.side === 'points'
  const [a, setA] = useState('')
  const [b, setB] = useState('')

  const invalid =
    a.trim() === '' || (!isPoints && b.trim() === '') || (!isPoints && a.trim() === b.trim())

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4">
      <div className="mt-16 w-full max-w-sm rounded-xl border border-border bg-card p-5 shadow-xl">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">{isPoints ? 'Enter points' : 'Enter result'}</h2>
          <button type="button" aria-label="Close" onClick={onClose} className="rounded-lg p-1.5 hover:bg-muted">
            <X size={18} />
          </button>
        </div>

        <div className="mt-4 space-y-3">
          <Field label={match.nameA ?? 'A'} value={a} onChange={setA} />
          {!isPoints && <Field label={match.nameB ?? 'B'} value={b} onChange={setB} />}
        </div>

        {!isPoints && a.trim() !== '' && a.trim() === b.trim() && (
          <p className="mt-2 text-sm text-destructive">
            Scores are level — this match needs a decisive result.
          </p>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-lg border border-border px-3.5 py-2.5 text-sm font-medium hover:bg-muted">
            Cancel
          </button>
          <button
            type="button"
            disabled={pending || invalid}
            onClick={() => onSave(Number(a), isPoints ? null : Number(b))}
            className="rounded-lg bg-primary px-3.5 py-2.5 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {pending ? <Loader2 size={16} className="animate-spin" /> : 'Save result'}
          </button>
        </div>
      </div>
    </div>
  )
}

function Field({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (v: string) => void
}) {
  return (
    <div>
      <label className="text-sm font-medium text-muted-foreground">{label}</label>
      <input
        type="number"
        min={0}
        step={1}
        inputMode="numeric"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2.5 text-base shadow-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-ring/30"
      />
    </div>
  )
}
