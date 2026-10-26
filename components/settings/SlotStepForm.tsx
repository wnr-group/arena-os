'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { saveSlotStep } from '@/lib/actions/booking-settings'
import { SLOT_STEP_PRESETS } from '@/lib/booking/settings'

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
      <h2 className="text-base font-semibold">Booking time step</h2>
      <p className="mt-0.5 text-sm text-muted-foreground">
        How finely start times and durations can be chosen, for customers and staff. A smaller step lets people start
        at 8:20 instead of only 8:00 or 8:30, but can leave short gaps between bookings that nobody can fill.
        Existing bookings are not changed.
      </p>
      <fieldset className="mt-3" disabled={pending}>
        <legend className="sr-only">Booking time step</legend>
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
      {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
      <div className="mt-4 flex items-center gap-3">
        <button
          onClick={submit}
          disabled={pending || minutes === savedMinutes}
          className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
        >
          {pending ? 'Saving…' : 'Save time step'}
        </button>
        {saved && !pending && <span className="text-sm text-muted-foreground">Saved.</span>}
      </div>
    </div>
  )
}
