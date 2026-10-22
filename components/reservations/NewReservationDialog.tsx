'use client'

import { useEffect, useState, useTransition } from 'react'
import { Loader2, X } from 'lucide-react'
import { createReservation, getFreeReservationTables, getReservationTimes } from '@/lib/actions/reservations'
import { isValidPhone } from '@/lib/customers/phone'
import type { FreeTable, StartOption } from '@/lib/reservations/service'

const input = 'w-full rounded-md border bg-background px-3 py-2 text-base outline-none focus:ring-2 focus:ring-ring'
const label = 'text-sm font-medium text-muted-foreground'

/** Staff form: date → time (only slots with a free table) → table → guest. */
export function NewReservationDialog({
  branchId,
  initialDate,
  minDate,
  onClose,
  onCreated,
}: {
  branchId: string
  initialDate: string
  minDate: string
  onClose: () => void
  onCreated: (bookingNumber: string) => void
}) {
  const [date, setDate] = useState(initialDate)
  const [partySize, setPartySize] = useState('2')
  const [options, setOptions] = useState<StartOption[] | null>(null)
  const [startsAt, setStartsAt] = useState('')
  const [tables, setTables] = useState<FreeTable[]>([])
  const [tableId, setTableId] = useState('')
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [notes, setNotes] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loadingTimes, setLoadingTimes] = useState(false)
  const [pending, start] = useTransition()

  useEffect(() => {
    let cancelled = false
    setOptions(null)
    setStartsAt('')
    setTables([])
    setTableId('')
    setLoadingTimes(true)
    getReservationTimes({ branchId, date }).then((r) => {
      if (cancelled) return
      setLoadingTimes(false)
      if (r.error) setError(r.error)
      else {
        setError(null)
        setOptions(r.options ?? [])
      }
    })
    return () => {
      cancelled = true
    }
  }, [branchId, date])

  useEffect(() => {
    if (!startsAt) return
    let cancelled = false
    getFreeReservationTables({ branchId, startsAt }).then((r) => {
      if (cancelled) return
      if (r.error) setError(r.error)
      else {
        const list = r.tables ?? []
        setTables(list)
        setTableId(list[0]?.id ?? '')
      }
    })
    return () => {
      cancelled = true
    }
  }, [branchId, startsAt])

  const party = Number(partySize)
  const partyValid = Number.isInteger(party) && party > 0
  const phoneError = phone.trim() && !isValidPhone(phone) ? 'Enter a valid 10-digit phone number.' : null
  const ready = partyValid && startsAt && tableId && name.trim() && !phoneError

  function submit() {
    setError(null)
    start(async () => {
      const r = await createReservation({
        branchId,
        resourceId: tableId,
        startsAt,
        partySize: party,
        customerName: name.trim(),
        customerPhone: phone.trim() || undefined,
        notes: notes.trim() || undefined,
      })
      if (r.error) setError(r.error)
      else onCreated(r.bookingNumber ?? '')
    })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="max-h-[92vh] w-full max-w-md overflow-y-auto rounded-lg border bg-card p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold">New reservation</h2>
          <button onClick={onClose} aria-label="Close" className="text-muted-foreground hover:text-foreground">
            <X size={18} />
          </button>
        </div>

        <div className="mt-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={label}>Date</label>
              <input className={input} type="date" min={minDate} value={date} onChange={(e) => e.target.value && setDate(e.target.value)} />
            </div>
            <div>
              <label className={label}>
                Guests <span className="text-destructive">*</span>
              </label>
              <input className={input} type="number" min={1} inputMode="numeric" value={partySize} onChange={(e) => setPartySize(e.target.value)} />
            </div>
          </div>

          <div>
            <label className={label}>Time</label>
            {loadingTimes ? (
              <p className="mt-1 flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 size={14} className="animate-spin" /> Checking availability…
              </p>
            ) : options && options.length === 0 ? (
              <p className="mt-1 text-sm text-muted-foreground">No tables free on this date (or the venue is closed).</p>
            ) : (
              <div className="mt-1 flex flex-wrap gap-1.5">
                {(options ?? []).map((o) => (
                  <button
                    key={o.startsAt}
                    type="button"
                    onClick={() => setStartsAt(o.startsAt)}
                    className={`rounded-md border px-2.5 py-1 text-sm font-medium tabular-nums transition ${
                      startsAt === o.startsAt ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-background hover:bg-muted'
                    }`}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          {startsAt && (
            <div>
              <label className={label}>Table</label>
              <select className={input} value={tableId} onChange={(e) => setTableId(e.target.value)}>
                {tables.length === 0 && <option value="">No table free</option>}
                {tables.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div>
            <label className={label}>
              Guest name <span className="text-destructive">*</span>
            </label>
            <input className={input} value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <label className={label}>Phone</label>
            <input className={input} value={phone} inputMode="tel" onChange={(e) => setPhone(e.target.value.replace(/[^\d+\s-]/g, ''))} />
            {phoneError && <p className="mt-1 text-sm text-destructive">{phoneError}</p>}
          </div>
          <div>
            <label className={label}>Notes</label>
            <input className={input} value={notes} maxLength={500} placeholder="Birthday, high chair, window seat…" onChange={(e) => setNotes(e.target.value)} />
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <button
            onClick={submit}
            disabled={pending || !ready}
            className="flex w-full items-center justify-center gap-2 rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
          >
            {pending && <Loader2 size={15} className="animate-spin" />}
            Reserve table
          </button>
        </div>
      </div>
    </div>
  )
}
