'use client'

import { useState, useTransition } from 'react'
import { Loader2, X } from 'lucide-react'
import { seatReservation } from '@/lib/actions/reservations'

const input = 'w-full rounded-md border bg-background px-3 py-2 text-base outline-none focus:ring-2 focus:ring-ring'
const label = 'text-sm font-medium text-muted-foreground'

export type SeatableTable = { id: string; name: string; occupied: boolean }

/** Confirm arrival: adjust the head-count or move to another table, then seat. */
export function SeatReservationDialog({
  bookingId,
  guestName,
  reservedTableId,
  partySize,
  tables,
  onClose,
  onSeated,
}: {
  bookingId: string
  guestName: string
  reservedTableId: string | null
  partySize: number
  tables: SeatableTable[]
  onClose: () => void
  onSeated: (tableName: string) => void
}) {
  const [covers, setCovers] = useState(String(partySize))
  const [tableId, setTableId] = useState(reservedTableId ?? tables.find((t) => !t.occupied)?.id ?? '')
  const [error, setError] = useState<string | null>(null)
  const [conflict, setConflict] = useState(false)
  const [pending, start] = useTransition()

  const n = Number(covers)
  const valid = Number.isInteger(n) && n > 0 && tableId

  function submit(override = false) {
    setError(null)
    start(async () => {
      const r = await seatReservation({
        bookingId,
        resourceId: tableId,
        coverCount: n,
        overrideReservation: override || undefined,
      })
      if (r.error) {
        setError(r.error)
        setConflict(Boolean(r.reservationConflict))
      } else onSeated(r.tableName ?? '')
    })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-sm rounded-lg border bg-card p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold">Seat {guestName}</h2>
          <button onClick={onClose} aria-label="Close" className="text-muted-foreground hover:text-foreground">
            <X size={18} />
          </button>
        </div>

        <div className="mt-4 space-y-3">
          <div>
            <label className={label}>Guests</label>
            <input className={input} type="number" min={1} inputMode="numeric" value={covers} onChange={(e) => setCovers(e.target.value)} />
          </div>
          <div>
            <label className={label}>Table</label>
            <select className={input} value={tableId} onChange={(e) => setTableId(e.target.value)}>
              {tables.map((t) => (
                <option key={t.id} value={t.id} disabled={t.occupied}>
                  {t.name}
                  {t.id === reservedTableId ? ' (reserved)' : ''}
                  {t.occupied ? ' — occupied' : ''}
                </option>
              ))}
            </select>
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <button
            onClick={() => submit(false)}
            disabled={pending || !valid}
            className="flex w-full items-center justify-center gap-2 rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
          >
            {pending && <Loader2 size={15} className="animate-spin" />}
            Seat party
          </button>
          {conflict && (
            <button
              onClick={() => submit(true)}
              disabled={pending}
              className="w-full rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
            >
              Seat anyway
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
