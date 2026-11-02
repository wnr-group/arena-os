'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { CalendarRange } from 'lucide-react'
import { saveBookingSettings } from '@/lib/actions/booking-settings'
import { ADVANCE_WINDOW_PRESETS } from '@/lib/booking/settings'
import { ChoiceChips, SaveBar, SettingsCard } from '@/components/settings/SettingsCard'

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
    <SettingsCard
      icon={CalendarRange}
      title="Advance booking window"
      description="Customers and staff can book up to this far ahead. Working hours and holiday prices are applied as currently configured, so a booking made months ahead won't reflect later schedule changes."
      footer={
        <SaveBar
          onSave={submit}
          disabled={days === savedDays}
          pending={pending}
          saved={saved}
          error={error}
          label="Save window"
        />
      }
    >
      <ChoiceChips
        name="max-advance-days"
        legend="How far ahead can bookings be made"
        options={ADVANCE_WINDOW_PRESETS.map((p) => ({ value: p.days, label: p.label }))}
        value={days}
        disabled={pending}
        onChange={(v) => {
          setDays(v)
          setSaved(false)
          setError(null)
        }}
      />
      {reducing && (
        <p className="mt-3 text-xs text-muted-foreground">
          Bookings already made further ahead than this are kept; only new bookings are limited.
        </p>
      )}
    </SettingsCard>
  )
}
