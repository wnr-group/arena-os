'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { saveSlotStep } from '@/lib/actions/booking-settings'
import { SLOT_STEP_PRESETS } from '@/lib/booking/settings'

/** A few start times from 8:00 at the given interval, e.g. "8:00, 8:20, 8:40, 9:00, ...". */
function exampleTimes(step: number): string {
  const times = [0, 1, 2, 3].map((i) => {
    const t = 8 * 60 + i * step
    return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`
  })
  return `${times.join(', ')}, ...`
}

/**
 * "Booking time step" — venue-wide grid for start times and durations (e.g. 20
 * min offers 8:00, 8:20, 8:40). Manager-gated by the settings page and again by
 * the action. Existing bookings are never changed.
 */
export function SlotStepForm({ initialMinutes }: { initialMinutes: number }) {
  const router = useRouter()
  const [minutes, setMinutes] = useState(initialMinutes)
  const [savedMinutes, setSavedMinutes] = useState(initialMinutes)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [pending, start] = useTransition()

  function submit() {
    start(async () => {
      const r = await saveSlotStep(minutes)
      if (r.error) setError(r.error)
      else {
        setError(null)
        setSaved(true)
        setSavedMinutes(minutes)
        router.refresh()
      }
    })
  }

  return (
    <div className="mt-8 rounded-xl border border-border bg-card p-5 shadow-sm">
      <h2 className="text-base font-semibold">Booking time interval</h2>
      <p className="mt-0.5 text-sm text-muted-foreground">
        How often a booking can start, for customers and staff. A smaller interval gives more choice but can leave small
        gaps nobody can book. Existing bookings stay the same.
      </p>
      <fieldset className="mt-3" disabled={pending}>
        <legend className="sr-only">Booking time interval</legend>
        <div className="flex flex-wrap gap-2">
          {SLOT_STEP_PRESETS.map((p) => (
            <label
              key={p.minutes}
              className={`cursor-pointer rounded-md border px-3 py-1.5 text-sm font-medium transition ${
                minutes === p.minutes
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border bg-background hover:bg-muted'
              }`}
            >
              <input
                type="radio"
                name="slot-step-minutes"
                value={p.minutes}
                checked={minutes === p.minutes}
                onChange={() => {
                  setMinutes(p.minutes)
                  setSaved(false)
                  setError(null)
                }}
                className="sr-only"
              />
              {p.label}
            </label>
          ))}
        </div>
      </fieldset>
      <p className="mt-3 text-sm text-muted-foreground">
        Example start times: <span className="font-medium text-foreground">{exampleTimes(minutes)}</span>
      </p>
      {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
      <div className="mt-4 flex items-center gap-3">
        <button
          onClick={submit}
          disabled={pending || minutes === savedMinutes}
          className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
        >
          {pending ? 'Saving…' : 'Save interval'}
        </button>
        {saved && !pending && <span className="text-sm text-muted-foreground">Saved.</span>}
      </div>
    </div>
  )
}
