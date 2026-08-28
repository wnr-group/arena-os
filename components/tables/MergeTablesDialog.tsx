'use client'

import { useState, useTransition } from 'react'
import { Loader2, X } from 'lucide-react'
import { mergeTables } from '@/lib/actions/bookings'

export function MergeTablesDialog({
  bookingId,
  sourceTableName,
  otherOccupiedTables,
  onClose,
  onMerged,
}: {
  bookingId: string
  sourceTableName: string
  otherOccupiedTables: { bookingId: string; name: string; coverCount: number | null }[]
  onClose: () => void
  onMerged: (intoTableName: string) => void
}) {
  const [intoBookingId, setIntoBookingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()

  function submit() {
    if (!intoBookingId) {
      setError('Pick a table to merge into.')
      return
    }
    setError(null)
    start(async () => {
      const r = await mergeTables({ intoBookingId, fromBookingId: bookingId })
      if (r.error) setError(r.error)
      else onMerged(otherOccupiedTables.find((t) => t.bookingId === intoBookingId)?.name ?? 'the other table')
    })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-sm rounded-lg border bg-card p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold">Merge {sourceTableName}</h2>
          <button onClick={onClose} aria-label="Close" className="text-muted-foreground hover:text-foreground">
            <X size={18} />
          </button>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          All open orders from {sourceTableName} move onto the table you pick, cover counts add up, and{' '}
          {sourceTableName} frees up.
        </p>

        <div className="mt-4 space-y-3">
          {otherOccupiedTables.length === 0 ? (
            <p className="text-sm text-muted-foreground">No other occupied tables to merge into.</p>
          ) : (
            <div className="max-h-64 space-y-1.5 overflow-y-auto">
              {otherOccupiedTables.map((t) => (
                <button
                  key={t.bookingId}
                  onClick={() => setIntoBookingId(t.bookingId)}
                  className={`w-full rounded-md border px-3 py-2 text-left text-sm transition ${
                    intoBookingId === t.bookingId ? 'border-primary bg-primary/10 font-medium' : 'hover:bg-muted'
                  }`}
                >
                  {t.name}
                  {t.coverCount ? <span className="text-muted-foreground"> · {t.coverCount} guests</span> : null}
                </button>
              ))}
            </div>
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}

          <button
            onClick={submit}
            disabled={pending || !intoBookingId}
            className="flex w-full items-center justify-center gap-2 rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
          >
            {pending && <Loader2 size={15} className="animate-spin" />}
            Merge
          </button>
        </div>
      </div>
    </div>
  )
}
