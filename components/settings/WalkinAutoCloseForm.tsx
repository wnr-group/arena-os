'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { saveWalkinAutoClose } from '@/lib/actions/booking-settings'
import { WALKIN_AUTO_CLOSE_PRESETS } from '@/lib/booking/settings'

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
    <div className="mt-8 rounded-xl border border-border bg-card p-5 shadow-sm">
      <h2 className="text-base font-semibold">Auto-close forgotten walk-ins</h2>
      <p className="mt-0.5 text-sm text-muted-foreground">
        A walk-in with no end time keeps running until staff check it out. Turn on a rule below to close a forgotten one
        automatically. It is billed up to the moment it closes and left unpaid for staff to settle, and you can still
        correct the end time afterwards. If both rules are on, whichever comes first applies.
      </p>

      <fieldset className="mt-3 space-y-3" disabled={pending}>
        <legend className="sr-only">Auto-close rules</legend>

        <div>
          <label className="flex items-center gap-2 text-sm font-medium">
            <input
              type="checkbox"
              checked={minutes !== null}
              onChange={(e) => {
                touch()
                setMinutes(e.target.checked ? lastMinutes : null)
              }}
            />
            Close after a set time
          </label>
          {minutes !== null && (
            <div className="mt-2 flex flex-wrap gap-2 pl-6">
              {WALKIN_AUTO_CLOSE_PRESETS.map((p) => (
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
                    name="walkin-auto-close-minutes"
                    value={p.minutes}
                    checked={minutes === p.minutes}
                    onChange={() => {
                      touch()
                      setMinutes(p.minutes)
                      setLastMinutes(p.minutes)
                    }}
                    className="sr-only"
                  />
                  {p.label}
                </label>
              ))}
            </div>
          )}
        </div>

        <div>
          <label className="flex items-center gap-2 text-sm font-medium">
            <input
              type="checkbox"
              checked={atClosing}
              onChange={(e) => {
                touch()
                setAtClosing(e.target.checked)
              }}
            />
            Close at closing time
          </label>
          <p className="mt-1 pl-6 text-xs text-muted-foreground">
            Uses the working hours above. A walk-in started on a 24-hour day has no closing time, so only the set time
            applies to it.
          </p>
        </div>
      </fieldset>

      {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
      <div className="mt-4 flex items-center gap-3">
        <button
          onClick={submit}
          disabled={pending || !dirty}
          className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
        >
          {pending ? 'Saving…' : 'Save'}
        </button>
        {justSaved && !pending && <span className="text-sm text-muted-foreground">Saved.</span>}
      </div>
    </div>
  )
}
