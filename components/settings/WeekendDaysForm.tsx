'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { saveWeekendDays } from '@/lib/actions/resources'

const DOW_SHORT = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']
const DOW_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/**
 * Which weekdays count as "weekend" (M22 #3) — tenant-wide, in
 * business_profiles.weekend_days, not per resource type. A resource type's
 * own Weekend rate (set in the Resource Types form below) only ever applies
 * on the days selected here; a type left with no weekend rate is unaffected
 * either way. Manager-gated, same authority level as a resource type's own
 * rates (see saveWeekendDays' doc comment for why this isn't owner-only like
 * the rest of business_profiles).
 */
export function WeekendDaysForm({ initialDays }: { initialDays: number[] }) {
  const router = useRouter()
  const [days, setDays] = useState<number[]>(initialDays)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [pending, start] = useTransition()

  function toggleDay(dow: number) {
    setDays((ds) => (ds.includes(dow) ? ds.filter((d) => d !== dow) : [...ds, dow].sort((a, b) => a - b)))
    setSaved(false)
    setError(null)
  }

  function submit() {
    start(async () => {
      const r = await saveWeekendDays(days)
      if (r.error) setError(r.error)
      else {
        setSaved(true)
        router.refresh()
      }
    })
  }

  return (
    <div className="rounded-xl border border-border bg-card p-5 shadow-sm">
      <h2 className="text-base font-semibold">Weekend days</h2>
      <p className="mt-0.5 text-sm text-muted-foreground">
        Which days a type&apos;s Weekend rate (below) applies to. Applies tenant-wide, not per type.
      </p>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {DOW_SHORT.map((d, i) => (
          <button
            key={i}
            type="button"
            title={DOW_FULL[i]}
            onClick={() => toggleDay(i)}
            disabled={pending}
            className={`flex size-9 items-center justify-center rounded-full border text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 ${
              days.includes(i)
                ? 'border-primary bg-primary text-primary-foreground shadow-sm'
                : 'border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground'
            }`}
          >
            {d}
          </button>
        ))}
      </div>
      {days.length === 0 && (
        <p className="mt-2 text-xs text-muted-foreground">
          No days selected — every type&apos;s Weekend rate is currently unused; every booking bills the weekday rate.
        </p>
      )}
      {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
      <div className="mt-4 flex items-center gap-3">
        <button
          onClick={submit}
          disabled={pending}
          className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
        >
          {pending ? 'Saving…' : 'Save weekend days'}
        </button>
        {saved && !pending && <span className="text-sm text-muted-foreground">Saved.</span>}
      </div>
    </div>
  )
}
