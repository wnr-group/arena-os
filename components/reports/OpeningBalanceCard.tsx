'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Landmark, Pencil } from 'lucide-react'
import { saveOpeningBalance } from '@/lib/actions/financial-settings'
import { formatMoney, prettyDate } from '@/lib/format'

const input = 'w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring'
const btn = 'rounded-md px-3 py-2 text-sm font-medium transition disabled:opacity-50'

/**
 * The opening-balance REFERENCE, shown above the P&L statement (M40 / AROS-359).
 *
 * Deliberately styled apart from the statement's line stack (dashed border, no
 * +/− figures) and says in words that it is context only: it never changes the
 * Net Profit below. `amount` is a numeric string and is sent back as one.
 */
export function OpeningBalanceCard({
  amount,
  asOf,
  currency,
  timeZone,
  canEdit,
}: {
  amount: string | null
  asOf: string | null
  currency: string
  timeZone: string
  canEdit: boolean
}) {
  const router = useRouter()
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(amount ?? '')
  const [date, setDate] = useState(asOf ?? '')
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()

  const invalid = value.trim() === '' || !Number.isFinite(Number(value)) || !date

  function save(next: { amount: string; asOf: string } | null) {
    setError(null)
    start(async () => {
      const r = await saveOpeningBalance(next)
      if (r.error) setError(r.error)
      else {
        setEditing(false)
        router.refresh()
      }
    })
  }

  return (
    <section className="mt-6 rounded-xl border border-dashed border-border bg-muted/20 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            <Landmark size={18} aria-hidden />
          </span>
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Opening balance · reference
            </p>
            {amount !== null ? (
              <p className="mt-0.5 text-xl font-semibold tabular-nums">
                {formatMoney(amount, currency)}
                {asOf && (
                  <span className="ml-2 text-sm font-normal text-muted-foreground">
                    as of {prettyDate(asOf, timeZone)}
                  </span>
                )}
              </p>
            ) : (
              <p className="mt-0.5 text-sm text-muted-foreground">Not set.</p>
            )}
          </div>
        </div>
        {canEdit && !editing && (
          <button
            className={`${btn} inline-flex items-center gap-1.5 border`}
            onClick={() => {
              setValue(amount ?? '')
              setDate(asOf ?? '')
              setEditing(true)
            }}
          >
            <Pencil size={14} /> {amount !== null ? 'Edit' : 'Set'}
          </button>
        )}
      </div>

      {editing && (
        <div className="mt-4 space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="text-xs font-medium text-muted-foreground">Balance</label>
              <input
                className={input}
                type="number"
                inputMode="decimal"
                step="0.01"
                placeholder="0.00"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                autoFocus
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">As of</label>
              <input className={input} type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex flex-wrap gap-2">
            <button
              className={`${btn} bg-primary text-primary-foreground`}
              disabled={pending || invalid}
              onClick={() => save({ amount: value.trim(), asOf: date })}
            >
              {pending ? 'Saving…' : 'Save'}
            </button>
            <button className={`${btn} border`} disabled={pending} onClick={() => setEditing(false)}>
              Cancel
            </button>
            {amount !== null && (
              <button className={`${btn} ml-auto text-destructive`} disabled={pending} onClick={() => save(null)}>
                Clear
              </button>
            )}
          </div>
        </div>
      )}

      <p className="mt-3 text-xs text-muted-foreground">
        A reference number only — it does not change the Net profit below.
      </p>
    </section>
  )
}
