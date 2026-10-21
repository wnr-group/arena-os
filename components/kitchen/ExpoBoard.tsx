'use client'

import { useEffect, useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Check, CheckCircle2, Hourglass, Loader2, Pause } from 'lucide-react'
import { updateKotStatus } from '@/lib/actions/kots'
import type { KdsBoard, KdsItem, KdsTicket } from '@/lib/kots/kds-data'
import { usePolling } from './usePolling'

const POLL_MS = 4000

type CourseBlock = {
  key: string
  name: string | null
  stations: { name: string; done: number; total: number; pending: string[] }[]
  complete: boolean
}

/** Per course: how far each station is. A course is ready to run when every
 *  fired line in it, at every station, has been bumped. */
function courseBlocks(items: KdsItem[]): CourseBlock[] {
  const byCourse = new Map<number, KdsItem[]>()
  for (const i of items) byCourse.set(i.courseNo, [...(byCourse.get(i.courseNo) ?? []), i])
  return [...byCourse.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([no, lines]) => {
      const st = new Map<string, { name: string; done: number; total: number; pending: string[] }>()
      for (const l of lines) {
        const name = l.stationName ?? 'No station'
        const s = st.get(name) ?? { name, done: 0, total: 0, pending: [] }
        s.total += 1
        if (l.bumped) s.done += 1
        else s.pending.push(`${l.qty}× ${l.name}`)
        st.set(name, s)
      }
      return {
        key: String(no),
        name: lines[0].courseName,
        stations: [...st.values()],
        complete: lines.every((l) => l.bumped),
      }
    })
}

/**
 * Expo / pass view (M19 #3): every table with food in the kitchen, and per
 * course which stations are done vs still cooking, so the expediter can run a
 * course out together the moment its last station bumps.
 */
export function ExpoBoard({ board, canServe }: { board: KdsBoard; canServe: boolean }) {
  const router = useRouter()
  usePolling(POLL_MS)
  const offset = useMemo(() => new Date(board.serverNow).getTime() - Date.now(), [board.serverNow])
  const [now, setNow] = useState(() => Date.now())
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [, start] = useTransition()

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  function served(t: KdsTicket) {
    setError(null)
    setBusy(t.kotId)
    start(async () => {
      const r = await updateKotStatus(t.kotId, 'served')
      if (r.error) setError(r.error)
      router.refresh()
      setBusy(null)
    })
  }

  // Tables with something to run first (any course complete), then by age.
  const tickets = [...board.tickets].sort((a, b) => {
    const ra = courseBlocks(a.items).some((c) => c.complete) ? 0 : 1
    const rb = courseBlocks(b.items).some((c) => c.complete) ? 0 : 1
    return ra - rb || a.startedAt.localeCompare(b.startedAt)
  })

  return (
    <div className="mt-4 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">{tickets.length} tables in the kitchen · live</p>
        <Link href="/kitchen" className="text-sm font-medium text-primary hover:underline">
          ← Station screens
        </Link>
      </div>
      {error && (
        <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}
      {tickets.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border p-12 text-center text-base text-muted-foreground">
          Nothing in the kitchen right now.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 2xl:grid-cols-3">
          {tickets.map((t) => {
            const mins = Math.max(0, Math.floor((now + offset - new Date(t.startedAt).getTime()) / 60000))
            return (
              <div key={t.kotId} className="rounded-xl border-2 border-border bg-card p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-lg font-bold">
                    {t.tableName ?? t.orderNumber} <span className="text-sm font-medium text-muted-foreground">{t.kotNumber}</span>
                  </span>
                  <span className="rounded-md bg-muted px-2 py-0.5 text-sm font-bold tabular-nums">{mins}m</span>
                </div>
                <div className="mt-2 space-y-2">
                  {courseBlocks(t.items).map((c) => (
                    <div
                      key={c.key}
                      className={`rounded-lg border p-2 ${c.complete ? 'border-emerald-500 bg-emerald-500/10' : 'border-border'}`}
                    >
                      <p className="flex items-center gap-1.5 text-sm font-bold">
                        {c.complete ? <CheckCircle2 size={16} className="text-emerald-600" /> : <Hourglass size={16} className="text-amber-600" />}
                        {c.name ?? 'Order'} — {c.complete ? 'READY TO RUN' : 'waiting'}
                      </p>
                      <ul className="mt-1 space-y-0.5 text-sm">
                        {c.stations.map((s) => (
                          <li key={s.name} className="flex items-baseline justify-between gap-2">
                            <span className={s.done === s.total ? 'text-emerald-700' : ''}>
                              {s.done === s.total ? '✓ ' : ''}
                              {s.name}
                              {s.pending.length > 0 && <span className="text-muted-foreground"> · {s.pending.join(', ')}</span>}
                            </span>
                            <span className="shrink-0 tabular-nums text-muted-foreground">
                              {s.done}/{s.total}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                  {t.held.map((g) => (
                    <p key={g.course} className="flex items-center gap-1 text-xs font-semibold uppercase text-amber-600">
                      <Pause size={12} /> Held · {g.name}
                    </p>
                  ))}
                </div>
                {canServe && t.status === 'ready' && (
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => served(t)}
                    className="mt-3 inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-lg bg-emerald-600 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
                  >
                    {busy === t.kotId ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />}
                    Served
                  </button>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
