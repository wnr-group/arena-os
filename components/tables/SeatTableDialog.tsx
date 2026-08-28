'use client'

import { useState, useTransition } from 'react'
import { Loader2, X } from 'lucide-react'
import { seatTable } from '@/lib/actions/bookings'
import { isValidPhone } from '@/lib/customers/phone'

const input = 'w-full rounded-md border bg-background px-3 py-2 text-base outline-none focus:ring-2 focus:ring-ring'
const label = 'text-sm font-medium text-muted-foreground'
const errorText = 'mt-1 text-sm text-destructive'

export function SeatTableDialog({
  branchId,
  tableId,
  tableName,
  onClose,
  onSeated,
}: {
  branchId: string
  tableId: string
  tableName: string
  onClose: () => void
  onSeated: (bookingId: string) => void
}) {
  const [coverCount, setCoverCount] = useState('2')
  const [customerName, setCustomerName] = useState('')
  const [customerPhone, setCustomerPhone] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()

  const covers = Number(coverCount)
  const coversValid = Number.isInteger(covers) && covers > 0
  const phoneError = customerPhone.trim() && !isValidPhone(customerPhone) ? 'Enter a valid 10-digit phone number.' : null

  function submit() {
    setError(null)
    if (!coversValid) {
      setError('Guest count must be at least 1.')
      return
    }
    if (phoneError) return
    start(async () => {
      const r = await seatTable({
        branchId,
        resourceId: tableId,
        coverCount: covers,
        customerName: customerName.trim() || undefined,
        customerPhone: customerPhone.trim() || undefined,
      })
      if (r.error) setError(r.error)
      else if (r.bookingId) onSeated(r.bookingId)
    })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="w-full max-w-sm rounded-lg border bg-card p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold">Seat {tableName}</h2>
          <button onClick={onClose} aria-label="Close" className="text-muted-foreground hover:text-foreground">
            <X size={18} />
          </button>
        </div>

        <div className="mt-4 space-y-3">
          <div>
            <label className={label}>
              Guests <span className="text-destructive">*</span>
            </label>
            <input
              className={input}
              type="number"
              min={1}
              inputMode="numeric"
              value={coverCount}
              autoFocus
              onChange={(e) => setCoverCount(e.target.value)}
            />
          </div>

          <div>
            <label className={label}>Customer name</label>
            <input className={input} value={customerName} onChange={(e) => setCustomerName(e.target.value)} />
          </div>

          <div>
            <label className={label}>Phone</label>
            <input
              className={input}
              value={customerPhone}
              inputMode="tel"
              onChange={(e) => setCustomerPhone(e.target.value.replace(/[^\d+\s-]/g, ''))}
            />
            {phoneError && <p className={errorText}>{phoneError}</p>}
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <button
            onClick={submit}
            disabled={pending || !coversValid}
            className="flex w-full items-center justify-center gap-2 rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
          >
            {pending && <Loader2 size={15} className="animate-spin" />}
            Seat party
          </button>
        </div>
      </div>
    </div>
  )
}
