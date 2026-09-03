'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Loader2, Pause, Play, Plus, Repeat, Trash2, X } from 'lucide-react'
import {
  deleteEventSeries,
  setEventSeriesActive,
  upsertEventSeries,
} from '@/lib/actions/event-series'
import { EVENT_TYPES, EVENT_TYPE_LABELS, type EventType } from '@/lib/events/types'
import { useConfirm } from '@/components/ui/ConfirmDialog'

/**
 * Recurring series management (M15 #8) — the smallest UI the ticket asks for.
 *
 * Configure a weekly or monthly series, pause it, or delete it. Occurrences are
 * created by the scheduled job, never from here: the "Generate now" button that
 * would be convenient is deliberately absent, because a second code path that
 * creates occurrences is a second place for the idempotency rule to be got
 * wrong. A manager who needs one today creates a one-off event.
 *
 * Pausing is the ticket's "stop future generation without deleting history":
 * one boolean the job reads. Deleting is also non-destructive — the FK is
 * ON DELETE SET NULL (0090), so past occurrences survive and merely lose their
 * provenance, which the confirm dialog says in as many words.
 */

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

type Series = {
  id: string
  branchId: string
  branchName: string | null
  title: string
  type: EventType
  cadence: 'weekly' | 'monthly'
  weekday: number | null
  dayOfMonth: number | null
  startTime: string
  durationMinutes: number
  nextRun: string
  untilDate: string | null
  isActive: boolean
  capacity: number | null
  entryFee: string
  occurrences: number
}

type Branch = { id: string; name: string }

const input =
  'w-full rounded-lg border border-border bg-background px-3 py-2.5 text-base shadow-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-ring/30'
const label = 'text-sm font-medium text-muted-foreground'
const btn = 'rounded-lg px-3.5 py-2.5 text-sm font-medium transition disabled:opacity-50'

/** "Tuesdays at 19:00" / "The 15th at 19:00" — the schedule in words. */
function describe(s: Series): string {
  const when =
    s.cadence === 'weekly'
      ? `${WEEKDAYS[s.weekday ?? 0]}s`
      : `Day ${s.dayOfMonth} of each month`
  return `${when} at ${s.startTime.slice(0, 5)} · ${s.durationMinutes} min`
}

export function EventSeriesManager({
  series,
  branches,
}: {
  series: Series[]
  branches: Branch[]
}) {
  const router = useRouter()
  const confirm = useConfirm()
  const [pending, startTransition] = useTransition()
  const [open, setOpen] = useState(false)

  function run(fn: () => Promise<{ error?: string }>, ok: string) {
    startTransition(async () => {
      const r = await fn()
      if (r.error) toast.error(r.error)
      else {
        toast.success(ok)
        setOpen(false)
        router.refresh()
      }
    })
  }

  return (
    <section className="mt-8">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="flex items-center gap-1.5 text-lg font-semibold">
            <Repeat size={17} aria-hidden /> Recurring series
          </h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Classes that repeat. Each occurrence is created automatically as an ordinary event.
          </p>
        </div>
        <button
          type="button"
          className={`${btn} bg-primary text-primary-foreground hover:opacity-90`}
          onClick={() => setOpen(true)}
          disabled={branches.length === 0}
        >
          <span className="flex items-center gap-1.5">
            <Plus size={16} aria-hidden /> New series
          </span>
        </button>
      </div>

      {series.length === 0 ? (
        <p className="mt-4 rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
          No recurring series yet.
        </p>
      ) : (
        <ul className="mt-4 space-y-2">
          {series.map((s) => (
            <li
              key={s.id}
              className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-border bg-card p-4 shadow-sm"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">{s.title}</span>
                  <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                    {EVENT_TYPE_LABELS[s.type]}
                  </span>
                  {!s.isActive && (
                    <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-700">
                      Paused
                    </span>
                  )}
                </div>
                <p className="mt-1 text-sm text-muted-foreground">{describe(s)}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {s.branchName ?? '—'} · next {s.nextRun}
                  {s.untilDate ? ` · until ${s.untilDate}` : ''} · {s.occurrences} generated
                </p>
              </div>

              <div className="flex shrink-0 items-center gap-1.5">
                <button
                  type="button"
                  disabled={pending}
                  onClick={() =>
                    run(
                      () => setEventSeriesActive(s.id, !s.isActive),
                      s.isActive ? 'Series paused.' : 'Series resumed.',
                    )
                  }
                  className={`${btn} border border-border hover:bg-muted`}
                  title={
                    s.isActive
                      ? 'Stop generating future occurrences. Past ones are kept.'
                      : 'Resume generating future occurrences.'
                  }
                >
                  <span className="flex items-center gap-1.5">
                    {s.isActive ? <Pause size={15} aria-hidden /> : <Play size={15} aria-hidden />}
                    {s.isActive ? 'Pause' : 'Resume'}
                  </span>
                </button>
                <button
                  type="button"
                  disabled={pending}
                  aria-label={`Delete ${s.title}`}
                  onClick={async () => {
                    const yes = await confirm({
                      title: `Delete “${s.title}”?`,
                      description:
                        'Future occurrences stop being created. The events already generated are kept, along with their registrations — they simply stop being linked to this series.',
                      confirmText: 'Delete series',
                    })
                    if (yes) run(() => deleteEventSeries(s.id), 'Series deleted.')
                  }}
                  className={`${btn} border border-border text-destructive hover:bg-destructive/10`}
                >
                  <Trash2 size={15} aria-hidden />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {open && (
        <SeriesForm
          branches={branches}
          pending={pending}
          onClose={() => setOpen(false)}
          onSave={(v) => run(() => upsertEventSeries(v), 'Series created.')}
        />
      )}
    </section>
  )
}

function SeriesForm({
  branches,
  pending,
  onClose,
  onSave,
}: {
  branches: Branch[]
  pending: boolean
  onClose: () => void
  onSave: (v: Parameters<typeof upsertEventSeries>[0]) => void
}) {
  const [branchId, setBranchId] = useState(branches[0]?.id ?? '')
  const [title, setTitle] = useState('')
  const [type, setType] = useState<EventType>('class')
  const [cadence, setCadence] = useState<'weekly' | 'monthly'>('weekly')
  const [weekday, setWeekday] = useState('2')
  const [dayOfMonth, setDayOfMonth] = useState('1')
  const [startTime, setStartTime] = useState('19:00')
  const [durationMinutes, setDurationMinutes] = useState('60')
  const [nextRun, setNextRun] = useState('')
  const [untilDate, setUntilDate] = useState('')
  const [capacity, setCapacity] = useState('')
  const [entryFee, setEntryFee] = useState('0')

  const invalid = !branchId || !title.trim() || !nextRun

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4">
      <div className="mt-8 w-full max-w-lg rounded-xl border border-border bg-card p-5 shadow-xl">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">New recurring series</h2>
          <button type="button" aria-label="Close" onClick={onClose} className="rounded-lg p-1.5 hover:bg-muted">
            <X size={18} />
          </button>
        </div>

        <div className="mt-4 space-y-3">
          <div>
            <label className={label} htmlFor="sr-title">Title</label>
            <input id="sr-title" className={input} value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className={label} htmlFor="sr-branch">Venue</label>
              <select id="sr-branch" className={input} value={branchId} onChange={(e) => setBranchId(e.target.value)}>
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>{b.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={label} htmlFor="sr-type">Type</label>
              <select id="sr-type" className={input} value={type} onChange={(e) => setType(e.target.value as EventType)}>
                {EVENT_TYPES.filter((t) => t !== 'tournament').map((t) => (
                  <option key={t} value={t}>{EVENT_TYPE_LABELS[t]}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className={label} htmlFor="sr-cadence">Repeats</label>
              <select
                id="sr-cadence"
                className={input}
                value={cadence}
                onChange={(e) => setCadence(e.target.value as 'weekly' | 'monthly')}
              >
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
              </select>
            </div>
            {cadence === 'weekly' ? (
              <div>
                <label className={label} htmlFor="sr-weekday">On</label>
                <select id="sr-weekday" className={input} value={weekday} onChange={(e) => setWeekday(e.target.value)}>
                  {WEEKDAYS.map((d, i) => (
                    <option key={d} value={String(i)}>{d}</option>
                  ))}
                </select>
              </div>
            ) : (
              <div>
                <label className={label} htmlFor="sr-dom">Day of month</label>
                <input
                  id="sr-dom" type="number" min={1} max={31} className={input}
                  value={dayOfMonth} onChange={(e) => setDayOfMonth(e.target.value)}
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  Short months use their last day.
                </p>
              </div>
            )}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className={label} htmlFor="sr-time">Start time</label>
              <input id="sr-time" type="time" className={input} value={startTime} onChange={(e) => setStartTime(e.target.value)} />
            </div>
            <div>
              <label className={label} htmlFor="sr-dur">Duration (minutes)</label>
              <input
                id="sr-dur" type="number" min={15} max={1440} className={input}
                value={durationMinutes} onChange={(e) => setDurationMinutes(e.target.value)}
              />
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className={label} htmlFor="sr-next">First occurrence</label>
              <input id="sr-next" type="date" className={input} value={nextRun} onChange={(e) => setNextRun(e.target.value)} />
            </div>
            <div>
              <label className={label} htmlFor="sr-until">Until (optional)</label>
              <input id="sr-until" type="date" className={input} value={untilDate} onChange={(e) => setUntilDate(e.target.value)} />
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className={label} htmlFor="sr-cap">Capacity (optional)</label>
              <input id="sr-cap" type="number" min={1} className={input} value={capacity} onChange={(e) => setCapacity(e.target.value)} />
            </div>
            <div>
              <label className={label} htmlFor="sr-fee">Entry fee</label>
              <input id="sr-fee" type="number" min={0} step="0.01" className={input} value={entryFee} onChange={(e) => setEntryFee(e.target.value)} />
            </div>
          </div>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className={`${btn} border border-border hover:bg-muted`}>
            Cancel
          </button>
          <button
            type="button"
            disabled={pending || invalid}
            className={`${btn} bg-primary text-primary-foreground hover:opacity-90`}
            onClick={() =>
              onSave({
                branchId,
                title,
                type,
                cadence,
                weekday: cadence === 'weekly' ? Number(weekday) : null,
                dayOfMonth: cadence === 'monthly' ? Number(dayOfMonth) : null,
                startTime,
                durationMinutes: Number(durationMinutes),
                nextRun,
                untilDate: untilDate || '',
                capacity: capacity === '' ? null : Number(capacity),
                entryFee: Number(entryFee),
                registrationMode: 'solo',
              })
            }
          >
            {pending ? <Loader2 size={16} className="animate-spin" /> : 'Create series'}
          </button>
        </div>
      </div>
    </div>
  )
}
