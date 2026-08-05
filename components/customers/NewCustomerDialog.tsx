'use client'

import { useState, useTransition } from 'react'
import { X } from 'lucide-react'
import { createCustomer } from '@/lib/actions/customers'

const input = 'w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring'

export function NewCustomerDialog({
  onClose,
  onSaved,
}: {
  onClose: () => void
  /** `created` is false when the phone was already on file. */
  onSaved: (result: { customerId: string; created: boolean; label: string }) => void
}) {
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()

  function submit() {
    setError(null)
    start(async () => {
      const r = await createCustomer({ phone, name, email })
      if (r.error || !r.customerId) {
        setError(r.error ?? 'Could not save the customer.')
        return
      }
      onSaved({
        customerId: r.customerId,
        created: r.created ?? true,
        label: r.name || name.trim() || phone.trim(),
      })
    })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-lg border bg-card p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Add customer</h2>
          <button onClick={onClose} aria-label="Close" className="text-muted-foreground hover:text-foreground">
            <X size={18} />
          </button>
        </div>

        <form
          className="mt-4 space-y-3"
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
        >
          <div>
            <label htmlFor="cust-phone" className="text-xs font-medium text-muted-foreground">
              Phone <span className="text-destructive">*</span>
            </label>
            <input
              id="cust-phone"
              className={input}
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="98765 43210"
              inputMode="tel"
              autoFocus
              required
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Any format works — it&apos;s the customer&apos;s unique ID here, so we tidy it up for you.
            </p>
          </div>

          <div>
            <label htmlFor="cust-name" className="text-xs font-medium text-muted-foreground">
              Name
            </label>
            <input
              id="cust-name"
              className={input}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Optional"
            />
          </div>

          <div>
            <label htmlFor="cust-email" className="text-xs font-medium text-muted-foreground">
              Email
            </label>
            <input
              id="cust-email"
              className={input}
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Optional"
            />
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border px-3 py-2 text-sm hover:bg-muted"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={pending || !phone.trim()}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
            >
              {pending ? 'Saving…' : 'Add customer'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
