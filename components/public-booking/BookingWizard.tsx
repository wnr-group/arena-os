'use client'

import { useEffect, useMemo, useState, useTransition } from 'react'
import {
  Boxes,
  CalendarDays,
  ChevronLeft,
  Clock,
  Loader2,
  CheckCircle2,
  ImageOff,
  Phone,
  User,
  Users,
  type LucideIcon,
} from 'lucide-react'
import { getPublicAvailability, createPublicBooking, type PublicSlotOption } from '@/lib/actions/public-booking'
import { timeInZone, prettyDate } from '@/lib/format'

export type WizardResourceType = {
  id: string
  name: string
  description: string | null
  capacity: number | null
  imageUrl: string | null
}

const DURATIONS = [30, 60, 90, 120]

type Step = 1 | 2 | 3 | 4

/**
 * The public booking flow: resource type → date + duration + time + summary
 * → name + phone → confirm. One screen at a time, sticky bottom action
 * button — mobile-first, since the ticket is explicit that customers book
 * on phones. Times refetch automatically whenever the date or duration
 * changes, so step 2 never needs an explicit "find times" click.
 */
export function BookingWizard({
  resourceTypes,
  timeZone,
  today,
  initialTypeId = null,
}: {
  resourceTypes: WizardResourceType[]
  timeZone: string
  today: string
  /** Skips straight to step 2 for this type, e.g. when arriving from a
   * resource card picked on the standalone /resources page. Falls back to
   * the normal picker if the id doesn't match a bookable type. */
  initialTypeId?: string | null
}) {
  const validInitialTypeId =
    initialTypeId && resourceTypes.some((t) => t.id === initialTypeId) ? initialTypeId : null
  const [step, setStep] = useState<Step>(validInitialTypeId ? 2 : 1)
  const [typeId, setTypeId] = useState<string | null>(validInitialTypeId)
  const [date, setDate] = useState(today)
  const [duration, setDuration] = useState(60)
  const [slots, setSlots] = useState<PublicSlotOption[] | null>(null)
  const [slotsLoading, setSlotsLoading] = useState(false)
  const [slot, setSlot] = useState<PublicSlotOption | null>(null)
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [bookingNumber, setBookingNumber] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const selectedType = useMemo(() => resourceTypes.find((t) => t.id === typeId) ?? null, [resourceTypes, typeId])

  // Times load for whichever type/date/duration is current — a fresh
  // fetch invalidates any previously picked slot, so it's cleared here too.
  useEffect(() => {
    if (!typeId) return
    let cancelled = false
    setSlot(null)
    setError(null)
    setSlots(null)
    setSlotsLoading(true)
    getPublicAvailability({ resourceTypeId: typeId, date, durationMinutes: duration }).then((r) => {
      if (cancelled) return
      setSlotsLoading(false)
      if (r.error) {
        setError(r.error)
        setSlots([])
        return
      }
      setSlots(r.starts ?? [])
    })
    return () => {
      cancelled = true
    }
  }, [typeId, date, duration])

  function back() {
    setError(null)
    setStep((s) => (s > 1 ? ((s - 1) as Step) : s))
  }

  function pickType(id: string) {
    setTypeId(id)
    setStep(2)
  }

  function confirm() {
    if (!slot) return
    setError(null)
    const endsAt = new Date(new Date(slot.startsAt).getTime() + duration * 60_000).toISOString()
    startTransition(async () => {
      const r = await createPublicBooking({
        resourceId: slot.resourceId,
        startsAt: slot.startsAt,
        endsAt,
        customerName: name,
        customerPhone: phone,
      })
      if (r.error) {
        setError(r.error)
        return
      }
      setBookingNumber(r.bookingNumber ?? null)
      setStep(4)
    })
  }

  function bookAnother() {
    setStep(1)
    setTypeId(null)
    setSlots(null)
    setSlot(null)
    setName('')
    setPhone('')
    setBookingNumber(null)
    setError(null)
  }

  return (
    <div className="mx-auto flex min-h-[420px] max-w-md flex-col px-4 pb-28 pt-4 sm:px-0">
      {step < 4 && (
        <div className="mb-5 flex items-center gap-3">
          {step > 1 ? (
            <button
              onClick={back}
              aria-label="Back"
              className="rounded-full p-1.5 text-muted-foreground transition hover:bg-muted hover:text-foreground"
            >
              <ChevronLeft size={20} />
            </button>
          ) : (
            <div className="w-7" />
          )}
          <div className="flex flex-1 gap-1.5">
            {[1, 2, 3].map((n) => (
              <div
                key={n}
                className={`h-1.5 flex-1 rounded-full transition-colors duration-300 ${
                  n <= step ? 'bg-primary' : 'bg-muted'
                }`}
              />
            ))}
          </div>
        </div>
      )}

      {error && (
        <p className="mb-4 rounded-xl border border-destructive/40 bg-destructive/10 px-3.5 py-2.5 text-sm text-destructive">
          {error}
        </p>
      )}

      {step === 1 && (
        <div>
          <div className="flex items-center gap-3">
            <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <Boxes size={20} />
            </span>
            <div>
              <h2 className="text-lg font-bold leading-tight text-foreground">What would you like to book?</h2>
              <p className="text-sm text-muted-foreground">Pick a space to get started</p>
            </div>
          </div>

          <div className="mt-5 grid grid-cols-2 gap-3">
            {resourceTypes.map((t) => (
              <button
                key={t.id}
                onClick={() => pickType(t.id)}
                className="group overflow-hidden rounded-2xl border border-border bg-card text-left shadow-sm transition duration-300 hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-lg active:scale-[0.98]"
              >
                <div className="relative aspect-[4/3] w-full overflow-hidden bg-gradient-to-br from-primary/15 to-primary/5">
                  {t.imageUrl ? (
                    <img
                      src={t.imageUrl}
                      alt=""
                      className="h-full w-full object-cover transition duration-300 group-hover:scale-105"
                    />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center text-primary/40">
                      <ImageOff size={24} />
                    </div>
                  )}
                  {t.capacity && (
                    <span className="absolute bottom-2 right-2 inline-flex items-center gap-1 rounded-full bg-background/90 px-2 py-1 text-[11px] font-semibold text-foreground shadow-sm backdrop-blur-sm">
                      <Users size={11} /> {t.capacity}
                    </span>
                  )}
                </div>
                <div className="p-3">
                  <p className="text-sm font-semibold leading-tight transition group-hover:text-primary">{t.name}</p>
                  {t.description && <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{t.description}</p>}
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {step === 2 && selectedType && (
        <div>
          <div className="flex items-center gap-3">
            <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <CalendarDays size={20} />
            </span>
            <div className="min-w-0">
              <h2 className="truncate text-lg font-bold leading-tight text-foreground">{selectedType.name}</h2>
              <p className="text-sm text-muted-foreground">Choose when you&apos;d like to come in</p>
            </div>
          </div>

          <label className="mt-6 block">
            <span className="mb-1.5 flex items-center gap-1.5 text-sm font-semibold text-muted-foreground">
              <CalendarDays size={14} /> Date
            </span>
            <input
              type="date"
              value={date}
              min={today}
              onChange={(e) => setDate(e.target.value)}
              className="w-full rounded-xl border border-border bg-background px-3.5 py-3 text-base outline-none transition focus:border-primary focus:ring-2 focus:ring-ring/30"
            />
          </label>

          <div className="mt-5">
            <span className="mb-1.5 flex items-center gap-1.5 text-sm font-semibold text-muted-foreground">
              <Clock size={14} /> Duration
            </span>
            <div className="grid grid-cols-4 gap-2">
              {DURATIONS.map((m) => (
                <button
                  key={m}
                  onClick={() => setDuration(m)}
                  className={`rounded-xl border px-2 py-3 text-sm font-semibold transition-all duration-200 active:scale-95 ${
                    duration === m
                      ? 'border-primary bg-primary text-primary-foreground shadow-md shadow-primary/20'
                      : 'border-border bg-card text-muted-foreground hover:border-primary/40 hover:text-foreground'
                  }`}
                >
                  {m}m
                </button>
              ))}
            </div>
          </div>

          <div className="mt-6">
            <span className="mb-1.5 flex items-center gap-1.5 text-sm font-semibold text-muted-foreground">
              <Clock size={14} /> Available times
            </span>
            {slotsLoading ? (
              <div className="grid grid-cols-3 gap-2">
                {Array.from({ length: 6 }).map((_, i) => (
                  <div key={i} className="h-11 animate-pulse rounded-xl bg-muted" />
                ))}
              </div>
            ) : !slots || slots.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border p-6 text-center">
                <p className="text-sm text-muted-foreground">No open times this day. Try another date.</p>
              </div>
            ) : (
              <div className="grid grid-cols-3 gap-2">
                {slots.map((s) => {
                  const isSelected = slot?.startsAt === s.startsAt
                  return (
                    <button
                      key={s.startsAt}
                      onClick={() => setSlot(s)}
                      className={`rounded-xl border px-2 py-3 text-sm font-semibold tabular-nums transition-all duration-200 active:scale-95 ${
                        isSelected
                          ? 'border-primary bg-primary text-primary-foreground shadow-md shadow-primary/20'
                          : 'border-border bg-card text-foreground hover:border-primary/40'
                      }`}
                    >
                      {timeInZone(s.startsAt, timeZone)}
                    </button>
                  )
                })}
              </div>
            )}
          </div>

          {slot && (
            <div className="mt-6 rounded-2xl border border-primary/20 bg-gradient-to-br from-primary/5 to-transparent p-4">
              <p className="text-xs font-bold uppercase tracking-wide text-primary">Booking summary</p>
              <div className="mt-3 space-y-2.5">
                <SummaryRow icon={Boxes} label="Resource" value={selectedType.name} />
                <SummaryRow icon={CalendarDays} label="Date" value={prettyDate(date, timeZone)} />
                <SummaryRow icon={Clock} label="Time" value={`${timeInZone(slot.startsAt, timeZone)} · ${duration} min`} />
              </div>
            </div>
          )}

          <BottomBar>
            <PrimaryButton onClick={() => setStep(3)} pending={false} disabled={!slot || slotsLoading}>
              Continue
            </PrimaryButton>
          </BottomBar>
        </div>
      )}

      {step === 3 && selectedType && slot && (
        <div>
          <div className="flex items-center gap-3">
            <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <User size={20} />
            </span>
            <div className="min-w-0">
              <h2 className="text-lg font-bold leading-tight text-foreground">Your details</h2>
              <p className="truncate text-sm text-muted-foreground">
                {selectedType.name} · {prettyDate(date, timeZone)} · {timeInZone(slot.startsAt, timeZone)}
              </p>
            </div>
          </div>

          <label className="mt-6 block">
            <span className="mb-1.5 flex items-center gap-1.5 text-sm font-semibold text-muted-foreground">
              <User size={14} /> Name
            </span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="name"
              placeholder="Your full name"
              className="w-full rounded-xl border border-border bg-background px-3.5 py-3 text-base outline-none transition focus:border-primary focus:ring-2 focus:ring-ring/30"
            />
          </label>

          <label className="mt-4 block">
            <span className="mb-1.5 flex items-center gap-1.5 text-sm font-semibold text-muted-foreground">
              <Phone size={14} /> Phone
            </span>
            <input
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              autoComplete="tel"
              placeholder="Your phone number"
              className="w-full rounded-xl border border-border bg-background px-3.5 py-3 text-base outline-none transition focus:border-primary focus:ring-2 focus:ring-ring/30"
            />
          </label>

          <BottomBar>
            <PrimaryButton onClick={confirm} pending={pending} disabled={!name.trim() || !phone.trim()}>
              Confirm booking
            </PrimaryButton>
          </BottomBar>
        </div>
      )}

      {step === 4 && selectedType && slot && (
        <div className="flex flex-1 flex-col items-center justify-center py-10 text-center">
          <div className="flex size-16 items-center justify-center rounded-full bg-gradient-to-tr from-primary to-violet-500 text-primary-foreground shadow-lg shadow-primary/25">
            <CheckCircle2 size={30} />
          </div>
          <h2 className="mt-5 text-xl font-bold tracking-tight text-foreground">You&apos;re booked!</h2>
          {bookingNumber && (
            <p className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1 text-xs font-semibold text-muted-foreground">
              Booking #{bookingNumber}
            </p>
          )}
          <div className="mt-6 w-full max-w-xs space-y-2.5 rounded-2xl border border-border bg-card p-4 text-left shadow-sm">
            <SummaryRow icon={Boxes} label="Resource" value={selectedType.name} />
            <SummaryRow icon={CalendarDays} label="Date" value={prettyDate(date, timeZone)} />
            <SummaryRow icon={Clock} label="Time" value={timeInZone(slot.startsAt, timeZone)} />
          </div>
          <button
            onClick={bookAnother}
            className="mt-8 rounded-xl border border-border px-5 py-3 text-sm font-semibold transition hover:bg-muted active:scale-95"
          >
            Book another
          </button>
        </div>
      )}
    </div>
  )
}

function SummaryRow({ icon: Icon, label, value }: { icon: LucideIcon; label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <span className="flex items-center gap-2 text-muted-foreground">
        <Icon size={14} className="text-primary" /> {label}
      </span>
      <span className="truncate font-semibold text-foreground">{value}</span>
    </div>
  )
}

function BottomBar({ children }: { children: React.ReactNode }) {
  return (
    <div className="fixed inset-x-0 bottom-0 z-50 border-t border-border bg-background/95 p-4 backdrop-blur-sm">
      <div className="mx-auto max-w-md">{children}</div>
    </div>
  )
}

function PrimaryButton({
  onClick,
  pending,
  disabled,
  children,
}: {
  onClick: () => void
  pending: boolean
  disabled?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      disabled={pending || disabled}
      className="flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-3.5 text-base font-bold text-primary-foreground shadow-md shadow-primary/20 transition-all duration-300 hover:bg-primary-hover hover:shadow-lg hover:shadow-primary/30 hover:-translate-y-0.5 active:translate-y-0 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0 disabled:hover:shadow-md"
    >
      {pending && <Loader2 size={18} className="animate-spin" />}
      {children}
    </button>
  )
}
