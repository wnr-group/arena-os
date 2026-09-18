'use client'

import { useEffect, useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { CalendarDays, Check, Clock, Gamepad2, Loader2, Users } from 'lucide-react'
import { toast } from 'sonner'
import { getAvailableStartsForType } from '@/lib/actions/availability'
import { createBooking, lookupCustomerByPhone } from '@/lib/actions/bookings'
import { isValidPhone } from '@/lib/customers/phone'
import { formatMoney, prettyDate } from '@/lib/format'
import { addDays } from '@/lib/booking/time'
import {
  dateCardParts,
  durationLabel,
  time12,
  SectionLabel,
  EmptyNotice,
  DURATIONS,
  SLOT_MINUTES,
} from '@/components/public-booking/ResourceBookingPage'
import { StepProgress } from './StepProgress'
import { WizardCard, WizardFooter, SelectableTile, wizardInput, wizardLabel, wizardError } from './wizard-ui'
import type { WizardResource } from './BookingWizard'

const STEPS = ['Devices', 'Slot', 'Customer', 'Confirm']

/** Same window and duration set the public booking site uses — this step's
 *  layout mirrors that page exactly (see components/public-booking/ResourceBookingPage.tsx). */
const DATE_WINDOW_DAYS = 7

type ResourceTypeOption = { id: string; name: string; hourlyRate: string; capacity: number | null }
type TimeSlot = { startsAt: string; resourceId: string }
/** The whole working-day grid, taken slots included — mirrors the public
 *  resource booking page's Slot type, but carries the assigned resourceId
 *  (null when nothing of this type is free at that time). */
type GridSlot = { startsAt: string; resourceId: string | null; available: boolean }

/**
 * Future-booking wizard (M21 #3) — Devices → Slot → Customer → Confirm. Same
 * createBooking/getAvailableStartsForType/lookupCustomerByPhone logic as the
 * modal this replaces (source stays 'walk_in', matching every existing
 * staff-taken booking); only the presentation changed. The Slot step's
 * date-strip + duration/time-columns layout deliberately mirrors the public
 * booking site's ResourceTypeBookingPage (same date-card and slot-row
 * shapes), reusing its pure date helpers directly rather than a second copy.
 */
export function FutureWizard({
  branchId,
  timeZone,
  currency,
  today,
  initialDate,
  initialResourceTypeId,
  resources,
}: {
  branchId: string
  timeZone: string
  currency: string
  today: string
  initialDate: string
  initialResourceTypeId?: string
  resources: WizardResource[]
}) {
  const router = useRouter()
  const [step, setStep] = useState(0)

  const resourceTypes = useMemo(() => {
    const byType = new Map<string, ResourceTypeOption>()
    for (const r of resources) {
      if (!byType.has(r.resourceTypeId)) {
        byType.set(r.resourceTypeId, {
          id: r.resourceTypeId,
          name: r.typeName,
          hourlyRate: r.hourlyRate,
          capacity: r.capacity,
        })
      }
    }
    return [...byType.values()]
  }, [resources])

  const [resourceTypeId, setResourceTypeId] = useState(
    initialResourceTypeId && resourceTypes.some((t) => t.id === initialResourceTypeId)
      ? initialResourceTypeId
      : (resourceTypes[0]?.id ?? ''),
  )
  const selectedType = resourceTypes.find((t) => t.id === resourceTypeId)
  const hourlyRate = Number(selectedType?.hourlyRate ?? 0)
  const priceFor = (minutes: number) => (hourlyRate * minutes) / 60

  const dateOptions = useMemo(() => Array.from({ length: DATE_WINDOW_DAYS }, (_, i) => addDays(today, i)), [today])
  const [date, setDate] = useState(initialDate)
  const [duration, setDuration] = useState(60)
  const [slots, setSlots] = useState<GridSlot[] | null>(null)
  const [slotsLoading, setSlotsLoading] = useState(false)
  const [slotsError, setSlotsError] = useState<string | null>(null)
  const [isClosed, setIsClosed] = useState(false)
  const [selectedSlot, setSelectedSlot] = useState<TimeSlot | null>(null)
  // Slots already in the past (only relevant for today) are dropped rather
  // than shown disabled — same rule the public resource booking page uses.
  const visibleSlots = slots ? slots.filter((s) => new Date(s.startsAt).getTime() >= Date.now()) : null

  // Times reload automatically for whichever type/date/duration is current —
  // same auto-refetch the public booking page uses, no explicit "find times"
  // click. A fresh fetch invalidates any previously picked slot.
  useEffect(() => {
    if (!resourceTypeId) return
    let cancelled = false
    setSelectedSlot(null)
    setSlotsError(null)
    setSlots(null)
    setIsClosed(false)
    setSlotsLoading(true)
    getAvailableStartsForType({ branchId, resourceTypeId, date, durationMinutes: duration }).then((r) => {
      if (cancelled) return
      setSlotsLoading(false)
      if (r.error) {
        setSlotsError(r.error)
        setSlots([])
        setIsClosed(false)
        return
      }
      // The whole working day, taken times included — shown disabled rather
      // than dropped, same as the public resource booking page.
      const availableByStart = new Map((r.starts ?? []).map((s) => [s.startsAt, s.resourceId]))
      const grid = (r.allStarts ?? []).map((startsAt) => ({
        startsAt,
        resourceId: availableByStart.get(startsAt) ?? null,
        available: availableByStart.has(startsAt),
      }))
      setSlots(grid)
      setIsClosed(Boolean(r.isClosed))
    })
    return () => {
      cancelled = true
    }
  }, [branchId, resourceTypeId, date, duration])

  const [customerName, setCustomerName] = useState('')
  const [customerPhone, setCustomerPhone] = useState('')
  const [nameTouched, setNameTouched] = useState(false)
  const [phoneTouched, setPhoneTouched] = useState(false)
  const [checkingPhone, setCheckingPhone] = useState(false)
  const [phoneChecked, setPhoneChecked] = useState(false)
  const [existingCustomerName, setExistingCustomerName] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()

  // Keyed on whether a NAME is known, not on whether a customer row exists —
  // customers.name is nullable, so a returning customer can be found with no
  // name at all (see scripts/test-walkin-booking.ts for the regression this
  // guards against).
  const needsName = phoneChecked && !checkingPhone && !existingCustomerName

  useEffect(() => {
    setPhoneChecked(false)
    setExistingCustomerName(null)
    setCheckingPhone(false)
    if (!isValidPhone(customerPhone)) return
    let cancelled = false
    setCheckingPhone(true)
    lookupCustomerByPhone(customerPhone)
      .then((r) => {
        if (cancelled) return
        setCheckingPhone(false)
        setPhoneChecked(true)
        const known = r.found ? (r.name ?? '').trim() : ''
        setExistingCustomerName(known || null)
        setCustomerName(known)
      })
      .catch(() => {
        if (cancelled) return
        setCheckingPhone(false)
        setPhoneChecked(true)
        setExistingCustomerName(null)
      })
    return () => {
      cancelled = true
    }
  }, [customerPhone])

  const nameError = needsName && nameTouched && !customerName.trim() ? 'Customer name is required.' : null
  const phoneError =
    phoneTouched && !customerPhone.trim()
      ? 'Phone number is required.'
      : customerPhone.trim() && !isValidPhone(customerPhone)
        ? 'Enter a valid 10-digit phone number.'
        : null

  const endsAtIso = selectedSlot ? new Date(new Date(selectedSlot.startsAt).getTime() + duration * 60_000).toISOString() : null

/** Validates the customer fields and advances to the Confirm step, without
   *  creating anything yet — the actual createBooking call only happens from
   *  Confirm's own button. */
  function continueFromCustomer() {
    setError(null)
    setPhoneTouched(true)
    setNameTouched(true)
    if (!customerPhone.trim() || !isValidPhone(customerPhone)) {
      setError('Enter a valid 10-digit phone number.')
      return
    }
    if (checkingPhone) {
      setError('Still checking that phone number — try again in a moment.')
      return
    }
    if (needsName && !customerName.trim()) {
      setError('Customer name is required.')
      return
    }
    setStep(3)
  }

  function submit() {
    setError(null)
    if (!selectedSlot) {
      setError('Pick a start time first.')
      setStep(1)
      return
    }
    if (!customerPhone.trim() || !isValidPhone(customerPhone)) {
      setError('Enter a valid 10-digit phone number.')
      setStep(2)
      return
    }
    if (needsName && !customerName.trim()) {
      setError('Customer name is required.')
      setStep(2)
      return
    }
    start(async () => {
      const r = await createBooking({
        branchId,
        source: 'walk_in',
        customerName,
        customerPhone,
        slots: [{ resourceId: selectedSlot.resourceId, startsAt: selectedSlot.startsAt, endsAt: endsAtIso! }],
      })
      if (r.error) setError(r.error)
      else {
        toast.success(`Booking ${r.bookingNumber} created.`)
        router.push('/bookings')
      }
    })
  }

  return (
    <div className="space-y-6">
      <div className="mx-auto max-w-2xl">
        <StepProgress steps={STEPS} current={step} />
      </div>

      <WizardCard>
        {step === 0 && (
          <div>
            <h2 className="text-lg font-semibold">Which device?</h2>
            <p className="mt-1 text-sm text-muted-foreground">A free unit of this type is assigned automatically.</p>

            {resourceTypes.length === 0 ? (
              <p className="mt-5 py-8 text-center text-sm text-muted-foreground">No resource types configured yet.</p>
            ) : (
              <div className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
                {resourceTypes.map((t) => (
                  <SelectableTile
                    key={t.id}
                    selected={resourceTypeId === t.id}
                    onClick={() => setResourceTypeId(t.id)}
                    icon={<Gamepad2 size={18} />}
                    title={t.name}
                    subtitle={`${formatMoney(Number(t.hourlyRate), currency)} / hr`}
                    badge={
                      t.capacity != null ? (
                        <span className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground">
                          <Users size={12} /> Up to {t.capacity}
                        </span>
                      ) : undefined
                    }
                  />
                ))}
              </div>
            )}

            <WizardFooter onNext={() => setStep(1)} nextLabel="Continue" nextDisabled={!resourceTypeId} />
          </div>
        )}

        {step === 1 && (
          <div>
            <h2 className="text-lg font-semibold">Pick a date & time</h2>
            <p className="mt-1 text-sm text-muted-foreground">{selectedType?.name}</p>

            <section className="mt-5">
              <SectionLabel icon={CalendarDays}>Date</SectionLabel>
              <div className="mt-3 grid grid-cols-7 gap-1.5 sm:gap-2">
                {dateOptions.map((d) => {
                  const parts = dateCardParts(d)
                  const isSelected = d === date
                  return (
                    <button
                      key={d}
                      type="button"
                      onClick={() => setDate(d)}
                      className={`flex flex-col items-center gap-0.5 rounded-xl border px-1 py-2.5 transition-all duration-200 active:scale-95 ${
                        isSelected
                          ? 'border-primary bg-primary text-primary-foreground shadow-sm'
                          : 'border-border bg-card text-foreground hover:border-primary/40'
                      }`}
                    >
                      <span
                        className={`text-[10px] font-semibold uppercase tracking-wide ${
                          isSelected ? 'text-primary-foreground/80' : 'text-muted-foreground'
                        }`}
                      >
                        {parts.weekday}
                      </span>
                      <span className="text-base font-bold tabular-nums">{parts.day}</span>
                      <span
                        className={`text-[10px] font-semibold uppercase tracking-wide ${
                          isSelected ? 'text-primary-foreground/80' : 'text-muted-foreground'
                        }`}
                      >
                        {parts.month}
                      </span>
                    </button>
                  )
                })}
              </div>
            </section>

            <div className="mt-6 grid grid-cols-1 gap-6 sm:grid-cols-2">
              <section>
                <SectionLabel icon={Clock}>Duration</SectionLabel>
                <div className="mt-3 max-h-80 space-y-2 overflow-y-auto pr-1">
                  {DURATIONS.map((m) => {
                    const isSelected = duration === m
                    return (
                      <button
                        key={m}
                        type="button"
                        onClick={() => setDuration(m)}
                        className={`flex w-full items-center justify-between rounded-xl border px-4 py-3 text-left transition-all duration-200 active:scale-[0.99] ${
                          isSelected ? 'border-primary bg-primary/10 shadow-sm' : 'border-border bg-card hover:border-primary/30'
                        }`}
                      >
                        <span className="flex items-center gap-2.5">
                          <span
                            className={`flex size-5 shrink-0 items-center justify-center rounded-full border-2 transition ${
                              isSelected ? 'border-primary bg-primary' : 'border-border'
                            }`}
                          >
                            {isSelected && <span className="size-2 rounded-full bg-primary-foreground" />}
                          </span>
                          <span className={`text-sm font-semibold ${isSelected ? 'text-primary' : 'text-foreground'}`}>
                            {durationLabel(m)}
                          </span>
                        </span>
                        <span className="text-sm font-bold tabular-nums text-foreground">
                          {formatMoney(priceFor(m), currency)}
                        </span>
                      </button>
                    )
                  })}
                </div>
              </section>

              <section>
                <SectionLabel icon={Clock}>Start times</SectionLabel>
                <div className="mt-3">
                  {isClosed ? (
                    <EmptyNotice>This venue is closed on the selected date. Try another day.</EmptyNotice>
                  ) : slotsLoading ? (
                    <div className="max-h-80 space-y-2 overflow-y-auto pr-1">
                      {Array.from({ length: 6 }).map((_, i) => (
                        <div key={i} className="h-12 animate-pulse rounded-xl bg-muted" />
                      ))}
                    </div>
                  ) : slotsError ? (
                    <EmptyNotice>{slotsError}</EmptyNotice>
                  ) : !visibleSlots || visibleSlots.length === 0 ? (
                    <EmptyNotice>Nothing free for this duration on this day. Try a shorter duration or another date.</EmptyNotice>
                  ) : (
                    <>
                      <div className="max-h-80 space-y-2 overflow-y-auto pr-1">
                        {visibleSlots.map((s) => {
                          const isSelected = selectedSlot?.startsAt === s.startsAt
                          const inRange =
                            !isSelected &&
                            s.available &&
                            selectedSlot &&
                            endsAtIso &&
                            s.startsAt >= selectedSlot.startsAt &&
                            s.startsAt < endsAtIso
                          const rangeEnd = new Date(new Date(s.startsAt).getTime() + SLOT_MINUTES * 60_000).toISOString()
                          return (
                            <button
                              key={s.startsAt}
                              type="button"
                              disabled={!s.available}
                              onClick={() => s.available && s.resourceId && setSelectedSlot({ startsAt: s.startsAt, resourceId: s.resourceId })}
                              className={`flex w-full items-center justify-center rounded-xl border px-4 py-3 text-sm font-semibold tabular-nums transition-all duration-200 active:scale-[0.99] ${
                                isSelected
                                  ? 'border-primary bg-primary text-primary-foreground shadow-md shadow-primary/20'
                                  : !s.available
                                    ? 'cursor-not-allowed border-border/40 bg-muted/40 text-muted-foreground/40 line-through'
                                    : inRange
                                      ? 'border-primary/50 bg-primary/10 text-primary'
                                      : 'border-border bg-card text-foreground hover:border-primary/40'
                              }`}
                            >
                              {time12(s.startsAt, timeZone)} – {time12(rangeEnd, timeZone)}
                            </button>
                          )
                        })}
                      </div>
                      {visibleSlots.every((s) => !s.available) && (
                        <p className="mt-3 text-sm text-muted-foreground">
                          Every slot on this date is taken for this duration — try another date.
                        </p>
                      )}
                    </>
                  )}
                </div>
              </section>
            </div>

            {selectedSlot && (
              <div className="mt-6 rounded-xl border border-primary/20 bg-accent/40 p-4 text-sm">
                <dl className="space-y-1.5">
                  <SummaryRow k="Device" v={selectedType?.name ?? '—'} />
                  <SummaryRow k="Date" v={prettyDate(date, timeZone)} />
                  <SummaryRow k="Duration" v={durationLabel(duration)} />
                  <SummaryRow
                    k="Time"
                    v={endsAtIso ? `${time12(selectedSlot.startsAt, timeZone)}–${time12(endsAtIso, timeZone)}` : '—'}
                  />
                  <SummaryRow k="Price" v={formatMoney(priceFor(duration), currency)} />
                </dl>
              </div>
            )}

            <WizardFooter onBack={() => setStep(0)} onNext={() => setStep(2)} nextLabel="Continue" nextDisabled={!selectedSlot} />
          </div>
        )}

        {step === 2 && (
          <div className="mx-auto max-w-xl rounded-2xl border border-border bg-card p-6 shadow-sm sm:p-8">
            <h2 className="text-lg font-semibold">Who&apos;s this for?</h2>

            <div className="mt-5 space-y-4">
              <div>
                <label htmlFor="future-customer-phone" className={wizardLabel}>
                  Phone <span className="text-destructive">*</span>
                </label>
                <div className="relative mt-1">
                  <input
                    id="future-customer-phone"
                    className={wizardInput}
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
                  <p className={wizardError}>{phoneError}</p>
                ) : (
                  phoneChecked &&
                  existingCustomerName && (
                    <p className="mt-1 flex items-center gap-1 text-sm text-success">
                      <Check size={14} /> {existingCustomerName}
                    </p>
                  )
                )}
              </div>

              {needsName && (
                <div>
                  <label htmlFor="future-customer-name" className={wizardLabel}>
                    Customer name <span className="text-destructive">*</span>
                  </label>
                  <input
                    id="future-customer-name"
                    className={`${wizardInput} mt-1`}
                    value={customerName}
                    required
                    onChange={(e) => setCustomerName(e.target.value)}
                    onBlur={() => setNameTouched(true)}
                  />
                  {nameError && <p className={wizardError}>{nameError}</p>}
                </div>
              )}
            </div>

            {error && <p className={wizardError}>{error}</p>}
            <WizardFooter
              onBack={() => setStep(1)}
              onNext={continueFromCustomer}
              nextLabel="Continue"
              nextDisabled={checkingPhone}
            />
          </div>
        )}

        {step === 3 && (
          <div className="mx-auto max-w-xl rounded-2xl border border-border bg-card p-6 shadow-sm sm:p-8">
            <h2 className="text-lg font-semibold">Confirm booking</h2>
            <p className="mt-1 text-sm text-muted-foreground">Check the details before booking.</p>

            <div className="mt-5 rounded-lg border border-border bg-muted/40 p-4 text-sm">
              <dl className="space-y-1.5">
                <SummaryRow k="Device" v={selectedType?.name ?? '—'} />
                <SummaryRow k="Date" v={prettyDate(date, timeZone)} />
                <SummaryRow
                  k="Time"
                  v={
                    selectedSlot && endsAtIso
                      ? `${time12(selectedSlot.startsAt, timeZone)}–${time12(endsAtIso, timeZone)}`
                      : '—'
                  }
                />
                <SummaryRow k="Customer" v={customerName.trim() || customerPhone} />
                <SummaryRow k="Phone" v={customerPhone} />
                <div className="flex items-center justify-between border-t border-border pt-2 text-base font-bold text-foreground">
                  <span>Total</span>
                  <span className="tabular-nums">{formatMoney(priceFor(duration), currency)}</span>
                </div>
              </dl>
            </div>

            {error && <p className={wizardError}>{error}</p>}
            <WizardFooter onBack={() => setStep(2)} onNext={submit} nextLabel="Confirm booking" pending={pending} />
          </div>
        )}
      </WizardCard>
    </div>
  )
}

function SummaryRow({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-muted-foreground">{k}</dt>
      <dd className="font-medium text-foreground">{v}</dd>
    </div>
  )
}
