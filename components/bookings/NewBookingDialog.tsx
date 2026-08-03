'use client'

import { useState, useTransition } from 'react'
import { X } from 'lucide-react'
import { getAvailableStarts } from '@/lib/actions/availability'
import { createBooking } from '@/lib/actions/bookings'
import { timeInZone } from '@/lib/format'

type Resource = { id: string; name: string; typeName: string }
const input = 'w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring'

const DURATIONS = [
  { label: '30 min', value: 30 },
  { label: '1 hour', value: 60 },
  { label: '1.5 hours', value: 90 },
  { label: '2 hours', value: 120 },
  { label: '3 hours', value: 180 },
]

export function NewBookingDialog({
  branchId,
  date,
  timeZone,
  resources,
  presetResourceId,
  onClose,
  onCreated,
}: {
  branchId: string
  date: string
  timeZone: string
  resources: Resource[]
  presetResourceId?: string
  onClose: () => void
  onCreated: (bookingNumber: string) => void
}) {
  const [customerName, setCustomerName] = useState('')
  const [customerPhone, setCustomerPhone] = useState('')
  const [resourceId, setResourceId] = useState(presetResourceId ?? resources[0]?.id ?? '')
  const [duration, setDuration] = useState(60)
  const [starts, setStarts] = useState<string[] | null>(null)
  const [selectedStart, setSelectedStart] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()

  function findTimes() {
    setError(null)
    setStarts(null)
    setSelectedStart(null)
    start(async () => {
      const r = await getAvailableStarts({ branchId, resourceId, date, durationMinutes: duration })
      if (r.error) setError(r.error)
      else setStarts(r.starts ?? [])
    })
  }

  function submit() {
    if (!selectedStart) return
    setError(null)
    const endsAt = new Date(new Date(selectedStart).getTime() + duration * 60_000).toISOString()
    start(async () => {
      const r = await createBooking({
        branchId,
        source: 'walk_in',
        customerName: customerName || undefined,
        customerPhone: customerPhone || undefined,
        slots: [{ resourceId, startsAt: selectedStart, endsAt }],
      })
      if (r.error) setError(r.error)
      else onCreated(r.bookingNumber ?? '')
    })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-lg border bg-card p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">New booking</h2>
          <button onClick={onClose} aria-label="Close" className="text-muted-foreground hover:text-foreground">
            <X size={18} />
          </button>
        </div>

        <div className="mt-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground">Customer name</label>
              <input className={input} value={customerName} onChange={(e) => setCustomerName(e.target.value)} />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">Phone</label>
              <input className={input} value={customerPhone} onChange={(e) => setCustomerPhone(e.target.value)} />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground">Resource</label>
              <select
                className={input}
                value={resourceId}
                onChange={(e) => {
                  setResourceId(e.target.value)
                  setStarts(null)
                  setSelectedStart(null)
                }}
              >
                {resources.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name} · {r.typeName}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">Duration</label>
              <select
                className={input}
                value={duration}
                onChange={(e) => {
                  setDuration(Number(e.target.value))
                  setStarts(null)
                  setSelectedStart(null)
                }}
              >
                {DURATIONS.map((d) => (
                  <option key={d.value} value={d.value}>
                    {d.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <button
            onClick={findTimes}
            disabled={pending || !resourceId}
            className="w-full rounded-md border px-3 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
          >
            {pending && starts === null ? 'Checking…' : 'Find available times'}
          </button>

          {starts !== null && (
            <div>
              <label className="text-xs font-medium text-muted-foreground">
                Available start times ({date})
              </label>
              {starts.length === 0 ? (
                <p className="mt-1 text-sm text-muted-foreground">
                  No free times for this resource and duration. Try a shorter duration or another day.
                </p>
              ) : (
                <div className="mt-2 grid grid-cols-4 gap-2">
                  {starts.map((s) => (
                    <button
                      key={s}
                      onClick={() => setSelectedStart(s)}
                      className={`rounded-md border px-2 py-1.5 text-sm transition ${
                        selectedStart === s
                          ? 'border-primary bg-primary text-primary-foreground'
                          : 'hover:bg-muted'
                      }`}
                    >
                      {timeInZone(s, timeZone)}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}

          <button
            onClick={submit}
            disabled={pending || !selectedStart}
            className="w-full rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
          >
            {selectedStart
              ? `Book ${timeInZone(selectedStart, timeZone)}–${timeInZone(
                  new Date(new Date(selectedStart).getTime() + duration * 60_000).toISOString(),
                  timeZone,
                )}`
              : 'Select a time'}
          </button>
        </div>
      </div>
    </div>
  )
}
