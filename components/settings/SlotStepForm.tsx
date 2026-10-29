'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Timer } from 'lucide-react'
import { saveSlotStep } from '@/lib/actions/booking-settings'
import { SLOT_STEP_PRESETS } from '@/lib/booking/settings'
import { ChoiceChips, SaveBar, SettingsCard } from '@/components/settings/SettingsCard'

/** A few start times from 8:00 at the given interval, e.g. "8:00, 8:20, 8:40, 9:00, ...". */
function exampleTimes(step: number): string[] {
  return [0, 1, 2, 3].map((i) => {
    const t = 8 * 60 + i * step
    return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`
  })
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
    <SettingsCard
      icon={Timer}
      title="Booking time interval"
      description="How often a booking can start, for customers and staff. A smaller interval gives more choice but can leave small gaps nobody can book. Existing bookings stay the same."
      footer={
        <SaveBar
          onSave={submit}
          disabled={minutes === savedMinutes}
          pending={pending}
          saved={saved}
          error={error}
          label="Save interval"
        />
      }
    >
      <ChoiceChips
        name="slot-step-minutes"
        legend="Booking time interval"
        options={SLOT_STEP_PRESETS.map((p) => ({ value: p.minutes, label: p.label }))}
        value={minutes}
        disabled={pending}
        onChange={(v) => {
          setMinutes(v)
          setSaved(false)
          setError(null)
        }}
      />
      <div className="mt-4 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        <span>Start times will look like</span>
        {exampleTimes(minutes).map((t) => (
          <span key={t} className="rounded-md bg-muted px-2 py-0.5 font-medium tabular-nums text-foreground">
            {t}
          </span>
        ))}
        <span>…</span>
      </div>
    </SettingsCard>
  )
}
