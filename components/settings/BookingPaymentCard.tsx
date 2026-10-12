'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { saveBookingPaymentSettings } from '@/lib/actions/payment-settings'

type Mode = 'optional_full' | 'venue' | 'advance' | 'full'
type AdvanceType = 'fixed' | 'percent'

const SAMPLE_TOTAL = 4000
const inr = (n: number) => `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`

/**
 * "Booking payments" — what the storefront collects when a customer books.
 * Server-side validation (zod + DB CHECKs) is the real gate; the disabled radios
 * and live helper text here are only guidance. This file imports no server-only
 * modules: it receives plain props and calls the manager-only action.
 */
export function BookingPaymentCard({
  mode: savedMode,
  advanceType: savedType,
  advanceValue: savedValue,
  credentialsReady,
}: {
  mode: Mode
  advanceType: AdvanceType | null
  advanceValue: number | null
  /** Razorpay key id, key secret and webhook secret are all stored. */
  credentialsReady: boolean
}) {
  const router = useRouter()
  const [mode, setMode] = useState<Mode>(savedMode)
  const [type, setType] = useState<AdvanceType>(savedType ?? 'percent')
  const [value, setValue] = useState(savedValue != null ? String(savedValue) : '')
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [pending, start] = useTransition()

  const num = Number(value)
  const valid = Number.isFinite(num) && num > 0 && (type === 'fixed' || num < 100)
  const advanceNow = valid ? (type === 'fixed' ? Math.min(num, SAMPLE_TOTAL) : Math.round(((SAMPLE_TOTAL * num) / 100) * 100) / 100) : null
  const dirty =
    mode !== savedMode ||
    (mode === 'advance' && (type !== (savedType ?? 'percent') || num !== (savedValue ?? NaN)))
  // The legacy mode is only an option while it is the current state.
  const canSave = !pending && dirty && mode !== 'optional_full' && (mode !== 'advance' || valid)

  function touch() {
    setSaved(false)
    setError(null)
  }

  function submit() {
    if (!canSave) return
    setError(null)
    start(async () => {
      const r = await saveBookingPaymentSettings({
        mode: mode as 'venue' | 'advance' | 'full',
        advanceType: mode === 'advance' ? type : null,
        advanceValue: mode === 'advance' ? num : null,
      })
      if (r.error) {
        setError(r.error)
        return
      }
      setSaved(true)
      router.refresh()
    })
  }

  const needsCreds = (m: Mode) => (m === 'advance' || m === 'full') && !credentialsReady

  const options: { id: Mode; label: string; help: string }[] = [
    { id: 'venue', label: 'Pay at venue', help: 'Nothing is collected online. Customers pay when they arrive.' },
    { id: 'advance', label: 'Collect advance', help: 'The booking is confirmed once the advance is paid; the rest is settled at the venue.' },
    { id: 'full', label: 'Collect full amount', help: 'The booking is confirmed once the full amount is paid online.' },
  ]
  if (savedMode === 'optional_full') {
    options.unshift({
      id: 'optional_full',
      label: 'Customer may choose to pay in full',
      help: 'Current setting: online payment is optional and always the full amount. Pick another mode to change it.',
    })
  }

  return (
    <section className="mt-10 border-t pt-6" aria-labelledby="booking-payments-h">
      <h2 id="booking-payments-h" className="text-lg font-semibold">
        Booking payments
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        What the online storefront collects when a customer books. Applies to the whole venue.
      </p>

      {!credentialsReady && (
        <p className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm text-amber-700">
          Collecting an advance or the full amount needs your Razorpay key ID, key secret and webhook secret.{' '}
          <a href="#razorpayKeyId" className="font-medium underline">
            Add them above
          </a>{' '}
          first.
        </p>
      )}

      <fieldset className="mt-4 space-y-2" disabled={pending}>
        <legend className="sr-only">Online payment mode</legend>
        {options.map((o) => {
          const blocked = needsCreds(o.id)
          return (
            <label
              key={o.id}
              className={`flex items-start gap-3 rounded-md border p-3 text-sm ${
                mode === o.id ? 'border-primary bg-primary/5' : ''
              } ${blocked ? 'opacity-60' : 'cursor-pointer'}`}
            >
              <input
                type="radio"
                name="online-payment-mode"
                className="mt-1"
                checked={mode === o.id}
                disabled={blocked || o.id === 'optional_full'}
                onChange={() => {
                  setMode(o.id)
                  touch()
                }}
              />
              <span>
                <span className="font-medium">{o.label}</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">{o.help}</span>
              </span>
            </label>
          )
        })}
      </fieldset>

      {mode === 'advance' && (
        <div className="mt-4 rounded-md border p-3">
          <div className="flex flex-wrap items-end gap-3">
            <div role="group" aria-label="Advance type" className="inline-flex overflow-hidden rounded-md border text-sm">
              {(['fixed', 'percent'] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  aria-pressed={type === t}
                  onClick={() => {
                    setType(t)
                    touch()
                  }}
                  className={`px-3 py-1.5 ${type === t ? 'bg-primary text-primary-foreground' : 'bg-background'}`}
                >
                  {t === 'fixed' ? '₹ fixed' : '% of total'}
                </button>
              ))}
            </div>
            <div>
              <label htmlFor="advanceValue" className="block text-sm font-medium">
                {type === 'fixed' ? 'Amount (₹)' : 'Percentage (%)'}
              </label>
              <input
                id="advanceValue"
                inputMode="decimal"
                value={value}
                onChange={(e) => {
                  setValue(e.target.value)
                  touch()
                }}
                className="mt-1 w-32 rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
          </div>
          <p className="mt-2 text-xs text-muted-foreground" aria-live="polite">
            {advanceNow != null
              ? `A ${inr(SAMPLE_TOTAL)} booking will collect ${inr(advanceNow)} now and ${inr(SAMPLE_TOTAL - advanceNow)} at the venue.`
              : type === 'percent'
                ? 'Enter a percentage above 0 and below 100.'
                : 'Enter an amount above 0. It is capped at the booking total.'}
          </p>
        </div>
      )}

      {error && (
        <p role="alert" className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      <div className="mt-4 flex items-center gap-3">
        <button
          onClick={submit}
          disabled={!canSave}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
        >
          {pending ? 'Saving…' : 'Save booking payments'}
        </button>
        {saved && !pending && <span className="text-sm text-muted-foreground">Saved.</span>}
      </div>
    </section>
  )
}
