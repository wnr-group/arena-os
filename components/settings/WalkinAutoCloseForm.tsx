'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { AlarmClockOff } from 'lucide-react'
import { saveWalkinAutoClose } from '@/lib/actions/booking-settings'
import { WALKIN_AUTO_CLOSE_PRESETS } from '@/lib/booking/settings'
import { ChoiceChips, SaveBar, SettingsCard, Switch } from '@/components/settings/SettingsCard'

const DEFAULT_MINUTES = 240

/**
 * "Auto-close forgotten walk-ins" — an open-tab walk-in has no end time until
 * staff check it out. Two independent rules close a forgotten one: after it has
 * run for a chosen time, and/or at the branch's closing time. If both are on,
 * whichever comes first wins. The session is billed up to that moment and left
 * unpaid for staff to settle. Manager-gated by the settings page and the action.
 */
export function WalkinAutoCloseForm({
  initialMinutes,
  initialAtClosing,
}: {
  initialMinutes: number | null
  initialAtClosing: boolean
}) {
  const router = useRouter()
  const [minutes, setMinutes] = useState<number | null>(initialMinutes)
  const [atClosing, setAtClosing] = useState(initialAtClosing)
  const [saved, setSaved] = useState({ minutes: initialMinutes, atClosing: initialAtClosing })
  const [lastMinutes, setLastMinutes] = useState(initialMinutes ?? DEFAULT_MINUTES)
  const [error, setError] = useState<string | null>(null)
  const [justSaved, setJustSaved] = useState(false)
  const [pending, start] = useTransition()

  const dirty = minutes !== saved.minutes || atClosing !== saved.atClosing

  function submit() {
    start(async () => {
      const r = await saveWalkinAutoClose({ minutes, atClosing })
      if (r.error) setError(r.error)
      else {
        setError(null)
        setJustSaved(true)
        setSaved({ minutes, atClosing })
        router.refresh()
      }
    })
  }

  function touch() {
    setJustSaved(false)
    setError(null)
  }

  return (
    <SettingsCard
      icon={AlarmClockOff}
      title="Auto-close forgotten walk-ins"
      description="A walk-in with no end time keeps running until staff check it out. Turn on a rule to close a forgotten one automatically. It is billed up to the moment it closes and left unpaid for staff to settle, and you can still correct the end time afterwards."
      footer={
        <SaveBar onSave={submit} disabled={!dirty} pending={pending} saved={justSaved} error={error} label="Save rules" />
      }
    >
      <div className="space-y-5">
        <div>
          <Switch
            checked={minutes !== null}
            disabled={pending}
            onChange={(on) => {
              touch()
              setMinutes(on ? lastMinutes : null)
            }}
            label="Close after a set time"
            description="Closes a walk-in once it has been running this long."
          />
          {minutes !== null && (
            <div className="mt-3 pl-14">
              <ChoiceChips
                name="walkin-auto-close-minutes"
                legend="Close after"
                options={WALKIN_AUTO_CLOSE_PRESETS.map((p) => ({ value: p.minutes, label: p.label }))}
                value={minutes}
                disabled={pending}
                onChange={(v) => {
                  touch()
                  setMinutes(v)
                  setLastMinutes(v)
                }}
              />
            </div>
          )}
        </div>

        <Switch
          checked={atClosing}
          disabled={pending}
          onChange={(on) => {
            touch()
            setAtClosing(on)
          }}
          label="Close at closing time"
          description="Uses the opening hours above. A walk-in started on a 24-hour day has no closing time, so only the set time applies to it."
        />

        {minutes !== null && atClosing && (
          <p className="rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">
            With both on, a walk-in is closed at whichever comes first.
          </p>
        )}
      </div>
    </SettingsCard>
  )
}
