'use client'

import { useMemo, useState, useTransition } from 'react'
import { ChevronLeft, Loader2, CheckCircle2, Users } from 'lucide-react'
import { getPublicAvailability, createPublicBooking, type PublicSlotOption } from '@/lib/actions/public-booking'
import { timeInZone, prettyDate } from '@/lib/format'

export type WizardResourceType = {
  id: string
  name: string
  description: string | null
  capacity: number | null
}

const DURATIONS = [30, 60, 90, 120]

type Step = 1 | 2 | 3 | 4 | 5

/**
 * The public booking flow: resource type → date + duration → start time →
 * name + phone → confirm. One screen at a time, sticky bottom action button —
 * mobile-first, since the ticket is explicit that customers book on phones.
 */
export function BookingWizard({
  resourceTypes,
  timeZone,
  today,
}: {
  resourceTypes: WizardResourceType[]
  timeZone: string
  today: string
}) {
  const [step, setStep] = useState<Step>(1)
  const [typeId, setTypeId] = useState<string | null>(null)
  const [date, setDate] = useState(today)
  const [duration, setDuration] = useState(60)
  const [slots, setSlots] = useState<PublicSlotOption[] | null>(null)
  const [slot, setSlot] = useState<PublicSlotOption | null>(null)
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [bookingNumber, setBookingNumber] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const selectedType = useMemo(() => resourceTypes.find((t) => t.id === typeId) ?? null, [resourceTypes, typeId])

  function back() {
    setError(null)
    if (step === 3) setSlots(null)
    setStep((s) => (s > 1 ? ((s - 1) as Step) : s))
  }

  function pickType(id: string) {
    setTypeId(id)
    setStep(2)
  }

  function findTimes() {
    if (!typeId) return
    setError(null)
    startTransition(async () => {
      const r = await getPublicAvailability({ resourceTypeId: typeId, date, durationMinutes: duration })
      if (r.error) {
        setError(r.error)
        return
      }
      setSlots(r.starts ?? [])
      setStep(3)
    })
  }

  function pickSlot(s: PublicSlotOption) {
    setSlot(s)
    setStep(4)
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
      setStep(5)
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
      {step < 5 && (
        <div className="mb-4 flex items-center gap-3">
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
            {[1, 2, 3, 4].map((n) => (
              <div
                key={n}
                className={`h-1.5 flex-1 rounded-full transition ${n <= step ? 'bg-primary' : 'bg-muted'}`}
              />
            ))}
          </div>
        </div>
      )}

      {error && (
        <p className="mb-4 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      {step === 1 && (
        <div>
          <h2 className="text-lg font-semibold">What would you like to book?</h2>
          <div className="mt-4 space-y-2.5">
            {resourceTypes.map((t) => (
              <button
                key={t.id}
                onClick={() => pickType(t.id)}
                className="w-full rounded-xl border border-border bg-card p-4 text-left transition hover:border-primary/50 active:scale-[0.99]"
              >
                <p className="text-base font-semibold">{t.name}</p>
                {t.description && <p className="mt-0.5 text-sm text-muted-foreground">{t.description}</p>}
                {t.capacity && (
                  <p className="mt-1.5 inline-flex items-center gap-1 text-xs text-muted-foreground">
                    <Users size={12} /> Up to {t.capacity}
                  </p>
                )}
              </button>
            ))}
          </div>
        </div>
      )}

      {step === 2 && selectedType && (
        <div>
          <h2 className="text-lg font-semibold">{selectedType.name}</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">Pick a date and how long you&apos;d like.</p>

          <label className="mt-5 block text-sm font-medium">
            Date
            <input
              type="date"
              value={date}
              min={today}
              onChange={(e) => setDate(e.target.value)}
              className="mt-1.5 w-full rounded-lg border border-border bg-background px-3 py-2.5 text-base outline-none focus:border-primary focus:ring-2 focus:ring-ring/30"
            />
          </label>

          <p className="mt-5 text-sm font-medium">Duration</p>
          <div className="mt-1.5 grid grid-cols-4 gap-2">
            {DURATIONS.map((m) => (
              <button
                key={m}
                onClick={() => setDuration(m)}
                className={`rounded-lg border px-2 py-2.5 text-sm font-medium transition ${
                  duration === m
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-border text-muted-foreground hover:border-foreground/30'
                }`}
              >
                {m}m
              </button>
            ))}
          </div>

          <BottomBar>
            <PrimaryButton onClick={findTimes} pending={pending}>
              Find times
            </PrimaryButton>
          </BottomBar>
        </div>
      )}

      {step === 3 && selectedType && (
        <div>
          <h2 className="text-lg font-semibold">Pick a time</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {selectedType.name} · {prettyDate(date, timeZone)} · {duration} min
          </p>

          {!slots || slots.length === 0 ? (
            <p className="mt-6 rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
              No open times this day. Go back and try another date.
            </p>
          ) : (
            <div className="mt-4 grid grid-cols-3 gap-2">
              {slots.map((s) => (
                <button
                  key={s.startsAt}
                  onClick={() => pickSlot(s)}
                  className="rounded-lg border border-border bg-card px-2 py-2.5 text-sm font-medium tabular-nums transition hover:border-primary/50 active:scale-[0.97]"
                >
                  {timeInZone(s.startsAt, timeZone)}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {step === 4 && selectedType && slot && (
        <div>
          <h2 className="text-lg font-semibold">Your details</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {selectedType.name} · {prettyDate(date, timeZone)} · {timeInZone(slot.startsAt, timeZone)} · {duration}{' '}
            min
          </p>

          <label className="mt-5 block text-sm font-medium">
            Name
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="name"
              placeholder="Your name"
              className="mt-1.5 w-full rounded-lg border border-border bg-background px-3 py-2.5 text-base outline-none focus:border-primary focus:ring-2 focus:ring-ring/30"
            />
          </label>

          <label className="mt-4 block text-sm font-medium">
            Phone
            <input
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              autoComplete="tel"
              placeholder="Your phone number"
              className="mt-1.5 w-full rounded-lg border border-border bg-background px-3 py-2.5 text-base outline-none focus:border-primary focus:ring-2 focus:ring-ring/30"
            />
          </label>

          <BottomBar>
            <PrimaryButton onClick={confirm} pending={pending} disabled={!name.trim() || !phone.trim()}>
              Confirm booking
            </PrimaryButton>
          </BottomBar>
        </div>
      )}

      {step === 5 && selectedType && slot && (
        <div className="flex flex-1 flex-col items-center justify-center py-10 text-center">
          <div className="flex size-14 items-center justify-center rounded-full bg-primary/10 text-primary">
            <CheckCircle2 size={28} />
          </div>
          <h2 className="mt-4 text-lg font-semibold">You&apos;re booked!</h2>
          {bookingNumber && <p className="mt-1 text-sm text-muted-foreground">Booking {bookingNumber}</p>}
          <p className="mt-3 text-sm">
            {selectedType.name} · {prettyDate(date, timeZone)} · {timeInZone(slot.startsAt, timeZone)}
          </p>
          <button
            onClick={bookAnother}
            className="mt-6 rounded-lg border border-border px-4 py-2.5 text-sm font-medium transition hover:bg-muted"
          >
            Book another
          </button>
        </div>
      )}
    </div>
  )
}

function BottomBar({ children }: { children: React.ReactNode }) {
  return (
    <div className="fixed inset-x-0 bottom-0 border-t border-border bg-background/95 p-4 backdrop-blur-sm">
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
      className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-3 text-base font-medium text-primary-foreground shadow-sm transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
    >
      {pending && <Loader2 size={18} className="animate-spin" />}
      {children}
    </button>
  )
}
