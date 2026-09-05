'use client'

import { useState, useTransition } from 'react'
import { Loader2, X } from 'lucide-react'
import { transferTable } from '@/lib/actions/bookings'

export function TransferTableDialog({
  bookingId,
  sourceTableName,
  freeTables,
  onClose,
  onTransferred,
}: {
  bookingId: string
  sourceTableName: string
  freeTables: { id: string; name: string }[]
  onClose: () => void
  onTransferred: (targetName: string) => void
}) {
  const [targetId, setTargetId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()

  function submit() {
    if (!targetId) {
      setError('Pick a table to move to.')
      return
    }
    setError(null)
    start(async () => {
      const r = await transferTable({ bookingId, targetResourceId: targetId })
      if (r.error) setError(r.error)
      else onTransferred(freeTables.find((t) => t.id === targetId)?.name ?? 'the new table')
    })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-sm rounded-lg border bg-card p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold">Transfer {sourceTableName}</h2>
          <button onClick={onClose} aria-label="Close" className="text-muted-foreground hover:text-foreground">
            <X size={18} />
          </button>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">Move this session — and its orders — to a free table.</p>

        <div className="mt-4 space-y-3">
          {freeTables.length === 0 ? (
            <p className="text-sm text-muted-foreground">No free tables right now.</p>
          ) : (
            <div className="max-h-64 space-y-1.5 overflow-y-auto">
              {freeTables.map((t) => (
                <button
                  key={t.id}
                  onClick={() => setTargetId(t.id)}
                  className={`w-full rounded-md border px-3 py-2 text-left text-sm transition ${
                    targetId === t.id ? 'border-primary bg-primary/10 font-medium' : 'hover:bg-muted'
                  }`}
                >
                  {t.name}
                </button>
              ))}
            </div>
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}

          <button
            onClick={submit}
            disabled={pending || !targetId}
            className="flex w-full items-center justify-center gap-2 rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
          >
            {pending && <Loader2 size={15} className="animate-spin" />}
            Transfer
          </button>
        </div>
      </div>
    </div>
  )
}
