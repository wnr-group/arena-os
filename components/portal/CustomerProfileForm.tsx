'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Lock } from 'lucide-react'
import { saveCustomerProfile } from '@/lib/actions/customer-profile'
import type { PortalProfile } from '@/lib/portal/profile'

/**
 * Profile & preferences form.
 *
 * Same shape as the staff forms (BusinessProfileForm, WorkingHoursForm): local
 * state, useTransition, one server action, then router.refresh(). Nothing here
 * decides authorisation — the action re-derives the customer from the session
 * and the database function can only ever write that customer's four editable
 * columns.
 *
 * Phone is rendered as a disabled input rather than plain text so it reads as a
 * field that exists and is locked, not one that is missing.
 */

const inputClass =
  'w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring disabled:opacity-60'

type Fields = Pick<PortalProfile, 'name' | 'email' | 'smsOptIn' | 'emailOptIn'>

export function CustomerProfileForm({ initial }: { initial: PortalProfile }) {
  const router = useRouter()
  const [fields, setFields] = useState<Fields>({
    name: initial.name,
    email: initial.email,
    smsOptIn: initial.smsOptIn,
    emailOptIn: initial.emailOptIn,
  })
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [pending, start] = useTransition()

  function set(patch: Partial<Fields>) {
    setFields((f) => ({ ...f, ...patch }))
    setSaved(false)
    setError(null)
  }

  // Mirrors the server's Zod rule so the obvious mistake is caught before a
  // round trip. The action validates again regardless — this is convenience,
  // not a check anything relies on.
  const email = fields.email.trim()
  const emailError = email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    ? 'Enter a valid email address.'
    : null

  function submit(e: React.FormEvent) {
    e.preventDefault()
    if (emailError) return
    setError(null)
    start(async () => {
      const result = await saveCustomerProfile(fields)
      if (result.error) {
        setError(result.error)
        return
      }
      setSaved(true)
      // The portal header renders the customer's name, so re-render the shell.
      router.refresh()
    })
  }

  return (
    <form onSubmit={submit} className="space-y-6">
      <section className="rounded-xl border border-border bg-card">
        <h2 className="border-b border-border px-4 py-3 text-sm font-semibold">Your details</h2>

        <div className="space-y-4 p-4">
          <div className="space-y-1.5">
            <label htmlFor="name" className="text-sm font-medium">
              Name
            </label>
            <input
              id="name"
              name="name"
              type="text"
              autoComplete="name"
              maxLength={100}
              value={fields.name}
              onChange={(e) => set({ name: e.target.value })}
              className={inputClass}
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="email" className="text-sm font-medium">
              Email <span className="text-muted-foreground">(optional)</span>
            </label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              maxLength={255}
              value={fields.email}
              onChange={(e) => set({ email: e.target.value })}
              aria-invalid={Boolean(emailError)}
              aria-describedby={emailError ? 'email-error' : undefined}
              className={inputClass}
            />
            {emailError && (
              <p id="email-error" className="text-sm text-destructive">
                {emailError}
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <label htmlFor="phone" className="text-sm font-medium">
              Phone number
            </label>
            <input
              id="phone"
              name="phone"
              type="tel"
              value={initial.phone}
              disabled
              readOnly
              className={inputClass}
            />
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Lock size={12} aria-hidden />
              Phone number is used for login and cannot be changed here.
            </p>
          </div>
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card">
        <h2 className="border-b border-border px-4 py-3 text-sm font-semibold">
          Communication preferences
        </h2>

        <div className="space-y-3 p-4">
          <p className="text-sm text-muted-foreground">
            How this venue may contact you about your bookings.
          </p>

          <Toggle
            id="smsOptIn"
            label="Receive SMS notifications"
            hint="Booking confirmations and reminders by text."
            checked={fields.smsOptIn}
            onChange={(smsOptIn) => set({ smsOptIn })}
          />

          <Toggle
            id="emailOptIn"
            label="Receive email notifications"
            hint={
              fields.email.trim()
                ? 'Booking confirmations and receipts by email.'
                : 'Add an email address above to receive these.'
            }
            checked={fields.emailOptIn}
            onChange={(emailOptIn) => set({ emailOptIn })}
          />
        </div>
      </section>

      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending || Boolean(emailError)}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
        >
          {pending ? 'Saving…' : 'Save changes'}
        </button>
        {saved && !pending && (
          <span className="text-sm text-muted-foreground" role="status">
            Saved.
          </span>
        )}
      </div>
    </form>
  )
}

function Toggle({
  id,
  label,
  hint,
  checked,
  onChange,
}: {
  id: string
  label: string
  hint: string
  checked: boolean
  onChange: (next: boolean) => void
}) {
  return (
    <label htmlFor={id} className="flex cursor-pointer items-start gap-3">
      <input
        id={id}
        name={id}
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 size-4 shrink-0 rounded border-border accent-primary"
      />
      <span className="min-w-0">
        <span className="block text-sm font-medium">{label}</span>
        <span className="block text-xs text-muted-foreground">{hint}</span>
      </span>
    </label>
  )
}
