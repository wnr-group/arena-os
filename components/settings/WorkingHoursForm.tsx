'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { CalendarClock } from 'lucide-react'
import { saveWorkingHours } from '@/lib/actions/resources'
import { SaveBar, SettingsCard } from '@/components/settings/SettingsCard'

type Day = { dayOfWeek: number; openTime: string; closeTime: string; isClosed: boolean; open24h: boolean }
type Mode = 'open' | '24h' | 'closed'

const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
// Shown Monday-first; dayOfWeek values (0 = Sunday) are unchanged.
const ORDER = [1, 2, 3, 4, 5, 6, 0]
const MODES: { mode: Mode; label: string }[] = [
  { mode: 'open', label: 'Open' },
  { mode: '24h', label: '24 hours' },
  { mode: 'closed', label: 'Closed' },
]
const timeInput =
  'w-[7.5rem] rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm tabular-nums outline-none transition focus:border-primary focus:ring-2 focus:ring-ring'

function modeOf(d: Day): Mode {
  return d.isClosed ? 'closed' : d.open24h ? '24h' : 'open'
}

function minutes(t: string): number {
  const [h, m] = t.split(':').map(Number)
  return h * 60 + m
}

/** "12h", "9h 30m" for an open/close pair; null if the pair isn't a valid span. */
function duration(d: Day): string | null {
  const span = minutes(d.closeTime) - minutes(d.openTime)
  if (!Number.isFinite(span) || span <= 0) return null
  const h = Math.floor(span / 60)
  const m = span % 60
  return m ? `${h}h ${m}m` : `${h}h`
}

function sameHours(a: Day, b: Day): boolean {
  return a.openTime === b.openTime && a.closeTime === b.closeTime && a.isClosed === b.isClosed && a.open24h === b.open24h
}

export function WorkingHoursForm({ branchId, initialDays }: { branchId: string; initialDays: Day[] }) {
  const router = useRouter()
  const [days, setDays] = useState<Day[]>(initialDays)
  const [savedDays, setSavedDays] = useState<Day[]>(initialDays)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [pending, start] = useTransition()

  const byDow = useMemo(() => new Map(days.map((d) => [d.dayOfWeek, d])), [days])
  const dirty = useMemo(() => {
    const s = new Map(savedDays.map((d) => [d.dayOfWeek, d]))
    return days.some((d) => !sameHours(d, s.get(d.dayOfWeek) as Day))
  }, [days, savedDays])
  const openCount = days.filter((d) => !d.isClosed).length

  function update(dow: number, patch: Partial<Day>) {
    setDays((ds) => ds.map((d) => (d.dayOfWeek === dow ? { ...d, ...patch } : d)))
    setSaved(false)
    setError(null)
  }

  function setMode(dow: number, mode: Mode) {
    update(dow, { isClosed: mode === 'closed', open24h: mode === '24h' })
  }

  function submit() {
    setError(null)
    start(async () => {
      const r = await saveWorkingHours({ branchId, days })
      if (r.error) setError(r.error)
      else {
        setSaved(true)
        setSavedDays(days)
        router.refresh()
      }
    })
  }

  return (
    <SettingsCard
      icon={CalendarClock}
      title="Opening hours"
      description={
        <>
          Set when you take bookings, day by day. Open on {openCount} of 7 days.
        </>
      }
      footer={
        <SaveBar
          onSave={submit}
          disabled={!dirty}
          pending={pending}
          saved={saved}
          error={error}
          label="Save hours"
        />
      }
    >
      <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border">
        {ORDER.map((dow) => {
          const d = byDow.get(dow)
          if (!d) return null
          const mode = modeOf(d)
          const span = mode === 'open' ? duration(d) : null
          return (
            <li
              key={dow}
              className={`flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:gap-4 ${
                mode === 'closed' ? 'bg-muted/40' : 'bg-background'
              }`}
            >
              <div className="flex items-center justify-between sm:w-32 sm:flex-col sm:items-start sm:gap-0.5">
                <span className={`text-sm font-semibold ${mode === 'closed' ? 'text-muted-foreground' : ''}`}>
                  {DOW[dow]}
                </span>
                <span className="text-xs text-muted-foreground">
                  {mode === 'closed' ? 'Closed' : mode === '24h' ? 'Open all day' : span ? `${span} open` : 'Check times'}
                </span>
              </div>

              <div
                role="radiogroup"
                aria-label={`${DOW[dow]} availability`}
                className="inline-flex shrink-0 rounded-lg bg-muted p-0.5"
              >
                {MODES.map((m) => {
                  const active = mode === m.mode
                  return (
                    <button
                      key={m.mode}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      onClick={() => setMode(dow, m.mode)}
                      className={`rounded-md px-3 py-1 text-xs font-medium transition ${
                        active
                          ? m.mode === 'closed'
                            ? 'bg-background text-destructive shadow-sm'
                            : 'bg-background text-foreground shadow-sm'
                          : 'text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      {m.label}
                    </button>
                  )
                })}
              </div>

              <div className="flex flex-1 items-center gap-2 sm:justify-end">
                {mode === 'open' && (
                  <>
                    <input
                      type="time"
                      aria-label={`${DOW[dow]} opening time`}
                      className={timeInput}
                      value={d.openTime}
                      onChange={(e) => update(dow, { openTime: e.target.value })}
                    />
                    <span className="text-muted-foreground" aria-hidden>
                      to
                    </span>
                    <input
                      type="time"
                      aria-label={`${DOW[dow]} closing time`}
                      className={timeInput}
                      value={d.closeTime}
                      onChange={(e) => update(dow, { closeTime: e.target.value })}
                    />
                  </>
                )}
              </div>
            </li>
          )
        })}
      </ul>
    </SettingsCard>
  )
}
