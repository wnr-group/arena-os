'use client'

import { useEffect, useMemo, useState, useTransition } from 'react'
import { Check, Loader2, X } from 'lucide-react'
import { getAvailableStartsForType } from '@/lib/actions/availability'
import { createBooking, lookupCustomerByPhone } from '@/lib/actions/bookings'
import { isValidPhone } from '@/lib/customers/phone'
import { zonedTimeToUtc } from '@/lib/booking/time'
import { timeInZone } from '@/lib/format'

type Resource = { id: string; name: string; resourceTypeId: string; typeName: string; imageUrl: string | null }
type ResourceTypeOption = { id: string; name: string; imageUrl: string | null }
type TimeSlot = { startsAt: string; resourceId: string }

const input = 'w-full rounded-md border bg-background px-3 py-2 text-base outline-none focus:ring-2 focus:ring-ring'
const label = 'text-sm font-medium text-muted-foreground'
const errorText = 'mt-1 text-sm text-destructive'

function minutesToHHMM(min: number): string {
  const h = Math.floor(min / 60) % 24
  const m = min % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

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
  openMin,
  closeMin,
  resources,
  presetResourceTypeId,
  onClose,
  onCreated,
}: {
  branchId: string
  date: string
  timeZone: string
  /** Branch operating hours for `date`, in minutes since midnight — used to
   * lay out a fixed, always-aligned time grid (see candidateTimes below). */
  openMin: number
  closeMin: number
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
  const [nameTouched, setNameTouched] = useState(false)
  const [phoneTouched, setPhoneTouched] = useState(false)
  const [attemptedSubmit, setAttemptedSubmit] = useState(false)
  const [resourceTypeId, setResourceTypeId] = useState(presetResourceTypeId ?? resourceTypes[0]?.id ?? '')
  const [duration, setDuration] = useState(60)
  const [slots, setSlots] = useState<TimeSlot[] | null>(null)
  const [selectedSlot, setSelectedSlot] = useState<TimeSlot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()
  const selectedType = resourceTypes.find((t) => t.id === resourceTypeId)

  // `slots` (from the server) only lists times that are actually bookable, so
  // rendering it directly as a grid means any filtered-out time shifts every
  // later button's row/column — a start near the end of its row can leave its
  // "covered" neighbour wrapped onto the next row, looking disconnected even
  // though it's the correct time. Lay out every 30-min mark of the working
  // day instead (same grid the server iterated to build `slots`) so position
  // in the grid always matches clock time, and mark whichever ones aren't in
  // `slots` as unavailable rather than omitting them.
  const candidateTimes = useMemo(() => {
    if (slots === null) return []
    const byStart = new Map(slots.map((s) => [s.startsAt, s.resourceId]))
    const out: { startsAt: string; resourceId: string | null }[] = []
    for (let m = openMin; m + duration <= closeMin; m += 30) {
      const startsAt = zonedTimeToUtc(date, minutesToHHMM(m), timeZone).toISOString()
      out.push({ startsAt, resourceId: byStart.get(startsAt) ?? null })
    }
    return out
  }, [slots, openMin, closeMin, duration, date, timeZone])

  // Phone-first walk-in flow: as soon as a full 10-digit number is entered,
  // check whether it already has a customer profile. If it does, that
  // customer's name is used and we never show a name field at all; if not,
  // the name field appears so staff can enter it.
  const [checkingPhone, setCheckingPhone] = useState(false)
  const [phoneChecked, setPhoneChecked] = useState(false)
  const [existingCustomerName, setExistingCustomerName] = useState<string | null>(null)
  const isNewCustomer = phoneChecked && !checkingPhone && !existingCustomerName

  useEffect(() => {
    setPhoneChecked(false)
    setExistingCustomerName(null)
    if (!isValidPhone(customerPhone)) return
    let cancelled = false
    setCheckingPhone(true)
    lookupCustomerByPhone(customerPhone).then((r) => {
      if (cancelled) return
      setCheckingPhone(false)
      setPhoneChecked(true)
      if (r.found) {
        setExistingCustomerName(r.name || 'Existing customer')
        setCustomerName(r.name || '')
      } else {
        setCustomerName('')
      }
    })
    return () => {
      cancelled = true
    }
  }, [customerPhone])

  // Field-level messages shown right under each input, once the visitor has
  // left the field (or tried to submit) rather than the moment it's empty.
  const nameError =
    isNewCustomer && (nameTouched || attemptedSubmit) && !customerName.trim() ? 'Customer name is required.' : null
  const phoneError =
    (phoneTouched || attemptedSubmit) && !customerPhone.trim()
      ? 'Phone number is required.'
      : customerPhone.trim() && !isValidPhone(customerPhone)
        ? 'Enter a valid 10-digit phone number.'
        : null

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
    setAttemptedSubmit(true)
    if (!customerPhone.trim() || !isValidPhone(customerPhone)) return
    if (!phoneChecked || checkingPhone) return
    if (!customerName.trim()) return
    const endsAt = new Date(new Date(selectedSlot.startsAt).getTime() + duration * 60_000).toISOString()
    start(async () => {
      const r = await createBooking({
        branchId,
        source: 'walk_in',
        customerName,
        customerPhone,
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
          <h2 className="text-xl font-semibold">New booking</h2>
          <button onClick={onClose} aria-label="Close" className="text-muted-foreground hover:text-foreground">
            <X size={18} />
          </button>
        </div>

        <div className="mt-4 space-y-3">
          <div>
            <label className={label}>
              Phone <span className="text-destructive">*</span>
            </label>
            <div className="relative">
              <input
                className={input}
                value={customerPhone}
                inputMode="tel"
                required
                autoFocus
                onChange={(e) => setCustomerPhone(e.target.value.replace(/[^\d+\s-]/g, ''))}
                onBlur={() => setPhoneTouched(true)}
              />
              {checkingPhone && (
                <Loader2 size={16} className="absolute right-3 top-1/2 -translate-y-1/2 animate-spin text-muted-foreground" />
              )}
            </div>
            {phoneError ? (
              <p className={errorText}>{phoneError}</p>
            ) : (
              phoneChecked &&
              existingCustomerName && (
                <p className="mt-1 flex items-center gap-1 text-sm text-emerald-600">
                  <Check size={14} /> {existingCustomerName}
                </p>
              )
            )}
          </div>

          {isNewCustomer && (
            <div>
              <label className={label}>
                Customer name <span className="text-destructive">*</span>
              </label>
              <input
                className={input}
                value={customerName}
                required
                autoFocus
                onChange={(e) => setCustomerName(e.target.value)}
                onBlur={() => setNameTouched(true)}
              />
              {nameError && <p className={errorText}>{nameError}</p>}
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={label}>Resource type</label>
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
              <label className={label}>Duration</label>
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
              <label className={label}>Available start times ({date})</label>
              {slots.length === 0 ? (
                <p className="mt-1 text-sm text-muted-foreground">
                  No free times for this resource type and duration. Try a shorter duration or another day.
                </p>
              ) : (
                <div className="mt-2 grid grid-cols-4 gap-2">
                  {candidateTimes.map((c) => {
                    const isBookable = c.resourceId !== null
                    // A start time that's already gone by can't be booked —
                    // disable it rather than hiding it, so the grid still
                    // reads as "here's the whole day" for a date in progress.
                    const isPast = new Date(c.startsAt).getTime() <= Date.now()
                    const isSelected = selectedSlot?.startsAt === c.startsAt
                    // Slots that fall inside the selected start's duration window
                    // aren't separately bookable once that start is picked — shade
                    // them so the full span of the booking reads as one block.
                    const isCovered =
                      isBookable &&
                      !isSelected &&
                      selectedSlot !== null &&
                      new Date(c.startsAt).getTime() > new Date(selectedSlot.startsAt).getTime() &&
                      new Date(c.startsAt).getTime() < new Date(selectedSlot.startsAt).getTime() + duration * 60_000
                    return (
                      <button
                        key={c.startsAt}
                        onClick={() => isBookable && setSelectedSlot({ startsAt: c.startsAt, resourceId: c.resourceId! })}
                        disabled={isPast || !isBookable}
                        title={isPast ? 'This time has already passed.' : !isBookable ? 'Not available.' : undefined}
                        className={`rounded-md border px-2 py-1.5 text-sm transition disabled:cursor-not-allowed disabled:border-dashed disabled:text-muted-foreground/50 disabled:hover:bg-transparent ${
                          isSelected
                            ? 'border-primary bg-primary text-primary-foreground'
                            : isCovered
                              ? 'border-primary bg-primary/25 font-medium text-primary'
                              : 'hover:bg-muted'
                        }`}
                      >
                        {timeInZone(c.startsAt, timeZone)}
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}

          <button
            onClick={submit}
            disabled={pending || !selectedSlot || checkingPhone}
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
