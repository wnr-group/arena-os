'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { saveBookingSettings } from '@/lib/actions/booking-settings'
import { ADVANCE_WINDOW_PRESETS } from '@/lib/booking/settings'

/**
 * "How far ahead can bookings be made" (M37 #1) — venue-wide, applies to the
 * public storefront and the admin future-booking wizard. Manager-gated by the
 * settings page and again by the action.
 */
export function BookingWindowForm({ initialDays }: { initialDays: number }) {
  const router = useRouter()
  const [days, setDays] = useState(initialDays)
  const [savedDays, setSavedDays] = useState(initialDays)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [pending, start] = useTransition()

  const reducing = days < savedDays

  function submit() {
    start(async () => {
      const r = await saveBookingSettings(days)
      if (r.error) setError(r.error)
      else {
        setError(null)
        setSaved(true)
        setSavedDays(days)
        router.refresh()
      }
    })
  }

  return (
    <div className="mt-8 rounded-xl border border-border bg-card p-5 shadow-sm">
      <h2 className="text-base font-semibold">Advance booking window</h2>
      <p className="mt-0.5 text-sm text-muted-foreground">
        Customers and staff can book up to this far ahead. Working hours and holiday prices are applied as currently
        configured, so a booking made months ahead won&apos;t reflect later schedule changes.
      </p>
      <fieldset className="mt-3" disabled={pending}>
        <legend className="sr-only">How far ahead can bookings be made</legend>
        <div className="flex flex-wrap gap-2">
          {ADVANCE_WINDOW_PRESETS.map((p) => (
            <label
              key={p.days}
              className={`cursor-pointer rounded-md border px-3 py-1.5 text-sm font-medium transition ${
                days === p.days
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border bg-background hover:bg-muted'
              }`}
            >
              <input
                type="radio"
                name="max-advance-days"
                value={p.days}
                checked={days === p.days}
                onChange={() => {
                  setDays(p.days)
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
      {reducing && (
        <p className="mt-2 text-xs text-muted-foreground">
          Bookings already made further ahead than this are kept; only new bookings are limited.
        </p>
      )}
      {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
      <div className="mt-4 flex items-center gap-3">
        <button
          onClick={submit}
          disabled={pending || days === savedDays}
          className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
        >
          {pending ? 'Saving…' : 'Save booking window'}
        </button>
        {saved && !pending && <span className="text-sm text-muted-foreground">Saved.</span>}
      </div>
    </div>
  )
}
