'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { saveReservationSettings } from '@/lib/actions/reservations'
import { RESERVATION_LIMITS, type ReservationSettings } from '@/lib/reservations/rules'

const input = 'w-28 rounded-md border bg-background px-3 py-2 text-base outline-none focus:ring-2 focus:ring-ring'

function Toggle({ checked, onChange, label, hint, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint: string; disabled?: boolean }) {
  return (
    <label className={`flex items-start gap-3 ${disabled ? 'opacity-50' : 'cursor-pointer'}`}>
      <input type="checkbox" className="mt-1 size-4" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>
        <span className="block text-sm font-medium">{label}</span>
        <span className="block text-sm text-muted-foreground">{hint}</span>
      </span>
    </label>
  )
}

function NumberField({ label, hint, value, onChange, min, max, unit }: { label: string; hint: string; value: number; onChange: (n: number) => void; min: number; max: number; unit: string }) {
  return (
    <div>
      <label className="text-sm font-medium">{label}</label>
      <div className="mt-1 flex items-center gap-2">
        <input className={input} type="number" min={min} max={max} value={Number.isNaN(value) ? '' : value} onChange={(e) => onChange(e.target.value === '' ? NaN : Number(e.target.value))} />
        <span className="text-sm text-muted-foreground">{unit}</span>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">{hint}</p>
    </div>
  )
}

/** Owner/manager settings for table reservations (M20). Off until switched on. */
export function ReservationSettingsForm({ initial }: { initial: ReservationSettings }) {
  const router = useRouter()
  const [s, setS] = useState(initial)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [pending, start] = useTransition()
  const L = RESERVATION_LIMITS

  function patch(p: Partial<ReservationSettings>) {
    setS((cur) => {
      const next = { ...cur, ...p }
      // The storefront can't be open while reservations are off.
      if (!next.enabled) next.publicEnabled = false
      return next
    })
    setSaved(false)
  }

  function submit() {
    start(async () => {
      const r = await saveReservationSettings(s)
      if (r.error) {
        setError(r.error)
        setSaved(false)
      } else {
        setError(null)
        setSaved(true)
        router.refresh()
      }
    })
  }

  return (
    <div className="mt-6 space-y-6 rounded-xl border border-border bg-card p-5 shadow-sm">
      <Toggle
        checked={s.enabled}
        onChange={(v) => patch({ enabled: v })}
        label="Take table reservations"
        hint="Adds the Reservations screen. Walk-ins can't take a table that's about to be needed."
      />
      <Toggle
        checked={s.publicEnabled}
        disabled={!s.enabled}
        onChange={(v) => patch({ publicEnabled: v })}
        label="Let guests book online"
        hint="Shows “Book a table” on your public site. Guests are assigned the first free table."
      />

      <Toggle
        checked={s.waitlistEnabled}
        onChange={(v) => setS((cur) => ({ ...cur, waitlistEnabled: v }))}
        label="Run a walk-in waitlist"
        hint="Adds the Waitlist screen so the host can queue walk-ins and tell them when a table is ready."
      />

      <div className="grid gap-5 sm:grid-cols-2">
        <NumberField label="Reservation length" unit="minutes" min={L.defaultDurationMinutes.min} max={L.defaultDurationMinutes.max} value={s.defaultDurationMinutes} onChange={(n) => patch({ defaultDurationMinutes: n })} hint="How long a table is held for each booking." />
        <NumberField label="No-show grace" unit="minutes" min={L.noShowGraceMinutes.min} max={L.noShowGraceMinutes.max} value={s.noShowGraceMinutes} onChange={(n) => patch({ noShowGraceMinutes: n })} hint="After this long past the booked time, the table is released." />
        <NumberField label="Walk-in buffer" unit="minutes" min={L.walkinBufferMinutes.min} max={L.walkinBufferMinutes.max} value={s.walkinBufferMinutes} onChange={(n) => patch({ walkinBufferMinutes: n })} hint="Warn before seating a walk-in if a reservation starts within this time." />
        <NumberField label="Largest online party" unit="guests" min={L.maxPartySize.min} max={L.maxPartySize.max} value={s.maxPartySize} onChange={(n) => patch({ maxPartySize: n })} hint="Bigger groups are asked to call." />
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}
      {saved && <p className="text-sm text-emerald-600">Saved.</p>}
      <button
        onClick={submit}
        disabled={pending}
        className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
      >
        {pending ? 'Saving…' : 'Save settings'}
      </button>
    </div>
  )
}
