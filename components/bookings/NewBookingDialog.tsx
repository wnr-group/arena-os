'use client'

import { useMemo, useState, useTransition } from 'react'
import { X } from 'lucide-react'
import { getAvailableStartsForType } from '@/lib/actions/availability'
import { createBooking } from '@/lib/actions/bookings'
import { isValidPhone } from '@/lib/customers/phone'
import { timeInZone } from '@/lib/format'

type Resource = { id: string; name: string; resourceTypeId: string; typeName: string; imageUrl: string | null }
type ResourceTypeOption = { id: string; name: string; imageUrl: string | null }
type TimeSlot = { startsAt: string; resourceId: string }

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
  presetResourceTypeId,
  onClose,
  onCreated,
}: {
  branchId: string
  date: string
  timeZone: string
  resources: Resource[]
  presetResourceTypeId?: string
  onClose: () => void
  onCreated: (bookingNumber: string) => void
}) {
  // Book by resource type — an available unit of that type is assigned
  // automatically for whichever start time gets picked, no manual unit pick.
  const resourceTypes = useMemo(() => {
    const byType = new Map<string, ResourceTypeOption>()
    for (const r of resources) {
      if (!byType.has(r.resourceTypeId)) {
        byType.set(r.resourceTypeId, { id: r.resourceTypeId, name: r.typeName, imageUrl: r.imageUrl })
      }
    }
    return [...byType.values()]
  }, [resources])

  const [customerName, setCustomerName] = useState('')
  const [customerPhone, setCustomerPhone] = useState('')
  const [resourceTypeId, setResourceTypeId] = useState(presetResourceTypeId ?? resourceTypes[0]?.id ?? '')
  const [duration, setDuration] = useState(60)
  const [slots, setSlots] = useState<TimeSlot[] | null>(null)
  const [selectedSlot, setSelectedSlot] = useState<TimeSlot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()
  const selectedType = resourceTypes.find((t) => t.id === resourceTypeId)

  function findTimes() {
    setError(null)
    setSlots(null)
    setSelectedSlot(null)
    start(async () => {
      const r = await getAvailableStartsForType({ branchId, resourceTypeId, date, durationMinutes: duration })
      if (r.error) setError(r.error)
      else setSlots(r.starts ?? [])
    })
  }

  function submit() {
    if (!selectedSlot) return
    setError(null)
    if (customerPhone && !isValidPhone(customerPhone)) {
      setError('Enter a valid 10-digit phone number.')
      return
    }
    const endsAt = new Date(new Date(selectedSlot.startsAt).getTime() + duration * 60_000).toISOString()
    start(async () => {
      const r = await createBooking({
        branchId,
        source: 'walk_in',
        customerName: customerName || undefined,
        customerPhone: customerPhone || undefined,
        slots: [{ resourceId: selectedSlot.resourceId, startsAt: selectedSlot.startsAt, endsAt }],
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
              <input
                className={input}
                value={customerPhone}
                inputMode="tel"
                onChange={(e) => setCustomerPhone(e.target.value.replace(/[^\d+\s-]/g, ''))}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground">Resource type</label>
              <div className="flex items-center gap-2">
                {selectedType?.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={selectedType.imageUrl}
                    alt=""
                    className="size-9 shrink-0 rounded-md border border-border object-cover"
                  />
                ) : (
                  <div className="size-9 shrink-0 rounded-md border border-dashed border-border bg-muted/40" />
                )}
                <select
                  className={input}
                  value={resourceTypeId}
                  onChange={(e) => {
                    setResourceTypeId(e.target.value)
                    setSlots(null)
                    setSelectedSlot(null)
                  }}
                >
                  {resourceTypes.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">Duration</label>
              <select
                className={input}
                value={duration}
                onChange={(e) => {
                  setDuration(Number(e.target.value))
                  setSlots(null)
                  setSelectedSlot(null)
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
            disabled={pending || !resourceTypeId}
            className="w-full rounded-md border px-3 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
          >
            {pending && slots === null ? 'Checking…' : 'Find available times'}
          </button>

          {slots !== null && (
            <div>
              <label className="text-xs font-medium text-muted-foreground">
                Available start times ({date})
              </label>
              {slots.length === 0 ? (
                <p className="mt-1 text-sm text-muted-foreground">
                  No free times for this resource type and duration. Try a shorter duration or another day.
                </p>
              ) : (
                <div className="mt-2 grid grid-cols-4 gap-2">
                  {slots.map((s) => (
                    <button
                      key={s.startsAt}
                      onClick={() => setSelectedSlot(s)}
                      className={`rounded-md border px-2 py-1.5 text-sm transition ${
                        selectedSlot?.startsAt === s.startsAt
                          ? 'border-primary bg-primary text-primary-foreground'
                          : 'hover:bg-muted'
                      }`}
                    >
                      {timeInZone(s.startsAt, timeZone)}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}

          <button
            onClick={submit}
            disabled={pending || !selectedSlot}
            className="w-full rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
          >
            {selectedSlot
              ? `Book ${timeInZone(selectedSlot.startsAt, timeZone)}–${timeInZone(
                  new Date(new Date(selectedSlot.startsAt).getTime() + duration * 60_000).toISOString(),
                  timeZone,
                )}`
              : 'Select a time'}
          </button>
        </div>
      </div>
    </div>
  )
}
