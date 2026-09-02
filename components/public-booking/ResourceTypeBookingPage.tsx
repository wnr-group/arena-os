'use client'

import { useEffect, useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { toast } from 'sonner'
import {
  ArrowLeft,
  Boxes,
  CalendarDays,
  Clock,
  CreditCard,
  ImageOff,
  Loader2,
  Mail,
  Minus,
  Phone,
  Plus,
  Sparkles,
  User,
  Users,
  Wallet,
} from 'lucide-react'
import type { PublicTenant } from '@/lib/tenant/public'
import type { PublicResourceTypeDetail } from '@/lib/booking/public-availability'
import {
  getPublicAvailability,
  createPublicBooking,
  createBookingPaymentIntent,
  lookupPublicCustomerByPhone,
  type PublicSlotOption,
} from '@/lib/actions/public-booking'
import { formatMoney } from '@/lib/format'
import { loadCheckoutScript, type RazorpayCtor } from '@/lib/payments/checkout-script'
import { HoneypotField } from './HoneypotField'
import {
  DURATIONS,
  DATE_WINDOW_DAYS,
  SLOT_MINUTES,
  addDays,
  dateCardParts,
  prettyDateLong,
  durationLabel,
  time12,
  SectionLabel,
  EmptyNotice,
  SummaryRow,
} from './ResourceBookingPage'

type Step = 'select' | 'details'

/**
 * The public checkout for a resource TYPE rather than one specific unit —
 * the customer picks "PS5 Station", not "PS5 #3". Whichever start time they
 * pick already carries the first-free unit for it (getPublicAvailability →
 * getPublicAvailableStartsForType), so there's no separate "choose a unit"
 * step; createPublicBooking re-validates that exact resource+slot at submit
 * time, so a stale read here can only ever fail closed, never double-book.
 * Same two-step shape as ResourceBookingPage, whose date/duration/summary
 * building blocks this reuses directly.
 */
export function ResourceTypeBookingPage({
  tenant,
  resourceType,
  today,
  razorpayConfigured,
  initialDuration = 60,
  initialPlayers = 1,
}: {
  tenant: PublicTenant
  resourceType: PublicResourceTypeDetail
  today: string
  /** Gates the "pay online now" choice — read server-side from the same
   *  credential loader createBookingPaymentIntent uses, so the choice is
   *  hidden rather than offered and then failing (M14 #8). */
  razorpayConfigured: boolean
  /**
   * Prefill from the portal's rebook redirect (AROS-90). Both default to the
   * values this wizard has always used, so the ordinary public entry point is
   * completely unchanged. They only seed the starting duration and party size;
   * the customer still picks a new date and slot through the normal flow, and
   * availability is still checked the same way.
   */
  initialDuration?: number
  initialPlayers?: number
}) {
  const router = useRouter()
  const dates = useMemo(() => Array.from({ length: DATE_WINDOW_DAYS }, (_, i) => addDays(today, i)), [today])

  const [step, setStep] = useState<Step>('select')
  const [date, setDate] = useState(today)
  const [duration, setDuration] = useState(initialDuration)
  const [slots, setSlots] = useState<PublicSlotOption[] | null>(null)
  const [slotsLoading, setSlotsLoading] = useState(false)
  const [slotsError, setSlotsError] = useState<string | null>(null)
  const [selectedSlot, setSelectedSlot] = useState<PublicSlotOption | null>(null)
  const [players, setPlayers] = useState(initialPlayers)
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')
  const [website, setWebsite] = useState('')
  const [phoneLookup, setPhoneLookup] = useState<{ checking: boolean; checked: boolean; found: boolean }>({
    checking: false,
    checked: false,
    found: false,
  })
  const [confirmError, setConfirmError] = useState<string | null>(null)
  const [payOnline, setPayOnline] = useState(false)
  const [pending, startTransition] = useTransition()

  const hourlyRate = Number(resourceType.hourlyRate)
  const priceFor = (minutes: number) => (hourlyRate * minutes) / 60
  const total = priceFor(duration)
  const endsAt = selectedSlot
    ? new Date(new Date(selectedSlot.startsAt).getTime() + duration * 60_000).toISOString()
    : null
  // Slots already in the past (only relevant for today) are dropped rather
  // than shown disabled — there's nothing useful for the customer to do with
  // a start time that's already gone.
  const visibleSlots = slots ? slots.filter((s) => new Date(s.startsAt).getTime() >= Date.now()) : null

  // Times reload for whichever date/duration is current; a fresh fetch
  // invalidates any previously picked slot (its assigned unit may change).
  useEffect(() => {
    let cancelled = false
    setSelectedSlot(null)
    setSlotsError(null)
    setSlots(null)
    setSlotsLoading(true)
    getPublicAvailability({ resourceTypeId: resourceType.id, date, durationMinutes: duration }).then((r) => {
      if (cancelled) return
      setSlotsLoading(false)
      if (r.error) {
        setSlotsError(r.error)
        setSlots([])
        return
      }
      setSlots(r.starts ?? [])
    })
    return () => {
      cancelled = true
    }
  }, [resourceType.id, date, duration])

  // Look the phone up (debounced) once a full 10-digit number is entered —
  // phone is already digits-only (see the input's onChange below), so the
  // name field only appears once we know whether to ask for it.
  useEffect(() => {
    setName('')
    if (phone.length !== 10) {
      setPhoneLookup({ checking: false, checked: false, found: false })
      return
    }
    let cancelled = false
    setPhoneLookup({ checking: true, checked: false, found: false })
    const timer = setTimeout(() => {
      lookupPublicCustomerByPhone({ phone }).then((r) => {
        if (cancelled) return
        const found = 'error' in r ? false : r.found
        setPhoneLookup({ checking: false, checked: true, found })
      })
    }, 500)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [phone])

  /**
   * Open Razorpay Checkout for a booking just placed with payNow=true. Same
   * honesty rule as CheckoutClient's payForOrder: the browser's success
   * callback is unauthenticated client input, never proof of payment — the
   * webhook (lib/payments/webhook.ts) is what actually settles the deposit.
   * The booking itself is already confirmed regardless of how this resolves —
   * every exit routes to the confirmation page.
   */
  async function payForBooking(bookingId: string, token: string, bookingNumberValue: string) {
    const res = await createBookingPaymentIntent({ bookingId })
    if (res.error || !res.checkout) {
      toast.error(`Booking #${bookingNumberValue} is confirmed, but online payment could not be started.`, {
        description: res.error ?? 'Please contact the venue to arrange payment.',
      })
      router.push(`/b/${token}`)
      return
    }
    const { orderId: gatewayOrderId, amount, currency, keyId } = res.checkout

    let Razorpay: RazorpayCtor
    try {
      Razorpay = await loadCheckoutScript()
    } catch {
      toast.error(`Booking #${bookingNumberValue} is confirmed, but the payment window could not load.`, {
        description: 'Please contact the venue to arrange payment.',
      })
      router.push(`/b/${token}`)
      return
    }

    const checkout = new Razorpay({
      key: keyId,
      order_id: gatewayOrderId,
      amount,
      currency,
      name: tenant.name,
      description: `Booking #${bookingNumberValue}`,
      prefill: {
        ...(name ? { name } : {}),
        ...(phone ? { contact: phone } : {}),
      },
      handler: () => {
        toast.success('Payment submitted — confirming with the venue.', {
          description: "We'll have everything ready for your visit.",
        })
        router.push(`/b/${token}`)
      },
      modal: {
        ondismiss: () => {
          toast(`Booking #${bookingNumberValue} is confirmed but not yet paid.`, {
            description: 'Contact the venue if you’d like to complete payment another way.',
          })
          router.push(`/b/${token}`)
        },
      },
    })
    checkout.open()
  }

  function confirm() {
    if (!selectedSlot || !endsAt) return
    setConfirmError(null)
    startTransition(async () => {
      const r = await createPublicBooking({
        resourceId: selectedSlot.resourceId,
        startsAt: selectedSlot.startsAt,
        endsAt,
        customerName: name,
        customerPhone: phone,
        customerEmail: email,
        players: resourceType.capacity != null ? players : undefined,
        payNow: razorpayConfigured && payOnline && total > 0,
        website,
      })
      if (r.error || !r.confirmationToken) {
        setConfirmError(r.error ?? 'Something went wrong. Please try again.')
        return
      }
      if (r.awaitingOnlinePayment && r.bookingId) {
        await payForBooking(r.bookingId, r.confirmationToken, r.bookingNumber ?? '')
        return
      }
      router.push(`/b/${r.confirmationToken}`)
    })
  }

  return (
    <div className="bg-background text-foreground">
      <div className="mx-auto max-w-6xl px-4 pb-12 pt-8 sm:px-6">
        <div className="mb-6">
          {step === 'details' ? (
            <button
              onClick={() => setStep('select')}
              className="inline-flex items-center gap-1.5 text-sm font-semibold text-muted-foreground transition hover:text-primary"
            >
              <ArrowLeft size={16} /> Back
            </button>
          ) : (
            <Link
              href="/resources"
              className="inline-flex items-center gap-1.5 text-sm font-semibold text-muted-foreground transition hover:text-primary"
            >
              <ArrowLeft size={16} /> Back to resources
            </Link>
          )}
        </div>

        {step === 'select' && (
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_380px] lg:items-start lg:gap-8">
            <div className="min-w-0 space-y-6">
              <ResourceTypeCard resourceType={resourceType} currency={tenant.currency} />

              <div className="flex items-start gap-3 rounded-2xl border border-primary/20 bg-primary/5 p-4">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary">
                  <Sparkles size={18} />
                </span>
                <div>
                  <p className="text-sm font-bold text-foreground">Instant Booking</p>
                  <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                    Pick any duration and your preferred start time — we&apos;ll automatically hold whichever{' '}
                    {resourceType.name.toLowerCase()} is free for exactly that slot.
                  </p>
                </div>
              </div>

              <section>
                <SectionLabel icon={CalendarDays}>Date</SectionLabel>
                <div className="mt-3 grid grid-cols-7 gap-2">
                  {dates.map((d) => {
                    const parts = dateCardParts(d)
                    const isSelected = d === date
                    return (
                      <button
                        key={d}
                        onClick={() => setDate(d)}
                        className={`flex flex-col items-center gap-0.5 rounded-2xl border px-2 py-3 transition-all duration-200 active:scale-95 ${
                          isSelected
                            ? 'border-primary bg-primary text-primary-foreground shadow-md shadow-primary/20'
                            : 'border-border bg-card text-foreground hover:border-primary/40'
                        }`}
                      >
                        <span
                          className={`text-[11px] font-semibold uppercase tracking-wide ${
                            isSelected ? 'text-primary-foreground/80' : 'text-muted-foreground'
                          }`}
                        >
                          {parts.weekday}
                        </span>
                        <span className="text-lg font-bold tabular-nums">{parts.day}</span>
                        <span
                          className={`text-[11px] font-semibold uppercase tracking-wide ${
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

              <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
                <section>
                  <SectionLabel icon={Clock}>Duration</SectionLabel>
                  <div className="mt-3 max-h-80 space-y-2 overflow-y-auto pr-1">
                    {DURATIONS.map((m) => {
                      const isSelected = duration === m
                      return (
                        <button
                          key={m}
                          onClick={() => setDuration(m)}
                          className={`flex w-full items-center justify-between rounded-xl border px-4 py-3 text-left transition-all duration-200 active:scale-[0.99] ${
                            isSelected
                              ? 'border-primary bg-primary/10 shadow-sm'
                              : 'border-border bg-card hover:border-primary/30'
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
                            {formatMoney(priceFor(m), tenant.currency)}
                          </span>
                        </button>
                      )
                    })}
                  </div>
                </section>

                <section>
                  <SectionLabel icon={Clock}>Available start times</SectionLabel>
                  <div className="mt-3">
                    {slotsLoading ? (
                      <div className="max-h-80 space-y-2 overflow-y-auto pr-1">
                        {Array.from({ length: 6 }).map((_, i) => (
                          <div key={i} className="h-12 animate-pulse rounded-xl bg-muted" />
                        ))}
                      </div>
                    ) : slotsError ? (
                      <EmptyNotice>{slotsError}</EmptyNotice>
                    ) : !visibleSlots || visibleSlots.length === 0 ? (
                      <EmptyNotice>No slots fit this duration today. Try a shorter duration or another day.</EmptyNotice>
                    ) : (
                      <div className="max-h-80 space-y-2 overflow-y-auto pr-1">
                        {visibleSlots.map((s) => {
                          const isSelected = selectedSlot?.startsAt === s.startsAt
                          const startsAt = selectedSlot?.startsAt ?? null
                          const inRange =
                            !isSelected && startsAt && endsAt && s.startsAt >= startsAt && s.startsAt < endsAt
                          const rangeEnd = new Date(new Date(s.startsAt).getTime() + SLOT_MINUTES * 60_000).toISOString()
                          return (
                            <button
                              key={s.startsAt}
                              onClick={() => setSelectedSlot(s)}
                              className={`flex w-full items-center justify-between rounded-xl border px-4 py-3 text-left text-sm font-semibold tabular-nums transition-all duration-200 active:scale-[0.99] ${
                                isSelected
                                  ? 'border-primary bg-primary text-primary-foreground shadow-md shadow-primary/20'
                                  : inRange
                                    ? 'border-primary/50 bg-primary/10 text-primary'
                                    : 'border-border bg-card text-foreground hover:border-primary/40'
                              }`}
                            >
                              {time12(s.startsAt, tenant.timezone)} – {time12(rangeEnd, tenant.timezone)}
                            </button>
                          )
                        })}
                      </div>
                    )}
                  </div>
                </section>
              </div>
            </div>

            <SummaryPanel
              resourceType={resourceType}
              currency={tenant.currency}
              timeZone={tenant.timezone}
              date={date}
              duration={duration}
              startsAt={selectedSlot?.startsAt ?? null}
              endsAt={endsAt}
              players={players}
              setPlayers={setPlayers}
              total={total}
              hourlyRate={hourlyRate}
              onContinue={() => setStep('details')}
            />
          </div>
        )}

        {step === 'details' && selectedSlot && (
          <div className="mx-auto max-w-lg">
            <div className="rounded-2xl border border-border bg-card p-6 shadow-sm sm:p-8">
              <div className="flex items-center gap-3">
                <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                  <User size={20} />
                </span>
                <div className="min-w-0">
                  <h1 className="text-lg font-bold leading-tight text-foreground">Your details</h1>
                  <p className="truncate text-sm text-muted-foreground">
                    {resourceType.name} · {prettyDateLong(date)} · {time12(selectedSlot.startsAt, tenant.timezone)}
                  </p>
                </div>
              </div>

              {confirmError && (
                <p className="mt-4 rounded-xl border border-destructive/40 bg-destructive/10 px-3.5 py-2.5 text-sm text-destructive">
                  {confirmError}
                </p>
              )}

              <label className="mt-6 block">
                <span className="mb-1.5 flex items-center gap-1.5 text-sm font-semibold text-muted-foreground">
                  <Phone size={14} /> Phone
                </span>
                <div className="relative">
                  <input
                    type="tel"
                    inputMode="numeric"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value.replace(/\D/g, '').slice(0, 10))}
                    readOnly={phoneLookup.checked}
                    autoComplete="tel"
                    maxLength={10}
                    placeholder="10-digit phone number"
                    className="w-full rounded-xl border border-border bg-background px-3.5 py-3 text-base outline-none transition focus:border-primary focus:ring-2 focus:ring-ring/30 read-only:bg-muted read-only:text-muted-foreground"
                  />
                  {phoneLookup.checked && (
                    <button
                      type="button"
                      onClick={() => {
                        setPhone('')
                        setPhoneLookup({ checking: false, checked: false, found: false })
                      }}
                      className="absolute right-3.5 top-1/2 -translate-y-1/2 text-xs font-semibold text-primary transition hover:underline"
                    >
                      Change
                    </button>
                  )}
                </div>
              </label>

              {phoneLookup.checking ? (
                <p className="mt-3 flex items-center gap-1.5 text-sm text-muted-foreground">
                  <Loader2 size={14} className="animate-spin" /> Checking for an existing profile…
                </p>
              ) : phoneLookup.checked && phoneLookup.found ? (
                <p className="mt-3 text-sm text-foreground">
                  <span className="font-semibold">Welcome back!</span> We found a profile for this number — you&rsquo;re all set to book.
                </p>
              ) : phoneLookup.checked ? (
                <>
                  <label className="mt-4 block">
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
                      <Mail size={14} /> Email <span className="font-normal text-muted-foreground/70">(optional)</span>
                    </span>
                    <input
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      autoComplete="email"
                      placeholder="you@example.com"
                      className="w-full rounded-xl border border-border bg-background px-3.5 py-3 text-base outline-none transition focus:border-primary focus:ring-2 focus:ring-ring/30"
                    />
                  </label>
                </>
              ) : null}

              <HoneypotField value={website} onChange={setWebsite} />

              <div className="mt-6 space-y-2 rounded-xl border border-border bg-background p-4">
                <SummaryRow icon={Boxes} label="Resource" value={resourceType.name} />
                <SummaryRow icon={CalendarDays} label="Date" value={prettyDateLong(date)} />
                <SummaryRow icon={Clock} label="Duration" value={durationLabel(duration)} />
                <div className="flex items-center justify-between border-t border-border pt-2 text-base font-extrabold text-foreground">
                  <span>Total</span>
                  <span className="tabular-nums text-primary">{formatMoney(total, tenant.currency)}</span>
                </div>
              </div>

              {razorpayConfigured && total > 0 && (
                <div className="mt-6">
                  <span className="mb-2 block text-sm font-semibold text-muted-foreground">How would you like to pay?</span>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => setPayOnline(false)}
                      className={`flex items-center justify-center gap-1.5 rounded-xl border px-3 py-2.5 text-sm font-bold transition ${
                        !payOnline
                          ? 'border-primary bg-primary/10 text-primary'
                          : 'border-border text-muted-foreground hover:border-primary/40'
                      }`}
                    >
                      <Wallet size={15} /> Pay at venue
                    </button>
                    <button
                      type="button"
                      onClick={() => setPayOnline(true)}
                      className={`flex items-center justify-center gap-1.5 rounded-xl border px-3 py-2.5 text-sm font-bold transition ${
                        payOnline
                          ? 'border-primary bg-primary/10 text-primary'
                          : 'border-border text-muted-foreground hover:border-primary/40'
                      }`}
                    >
                      <CreditCard size={15} /> Pay online now
                    </button>
                  </div>
                </div>
              )}

              <button
                onClick={confirm}
                disabled={
                  pending ||
                  !phoneLookup.checked ||
                  (!phoneLookup.found && !name.trim())
                }
                className="mt-6 flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-3.5 text-sm font-extrabold uppercase tracking-wide text-primary-foreground shadow-md shadow-primary/20 transition-all duration-300 hover:bg-primary-hover hover:shadow-lg hover:shadow-primary/30 hover:-translate-y-0.5 active:translate-y-0 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0 disabled:hover:shadow-md"
              >
                {pending && <Loader2 size={16} className="animate-spin" />}
                {razorpayConfigured && payOnline ? 'Confirm & pay' : 'Confirm booking'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function ResourceTypeCard({ resourceType, currency }: { resourceType: PublicResourceTypeDetail; currency: string }) {
  return (
    <div className="flex items-center gap-4 rounded-2xl border border-border bg-card p-4 shadow-sm">
      <div className="relative size-16 shrink-0 overflow-hidden rounded-xl bg-primary/10">
        {resourceType.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={resourceType.imageUrl} alt="" className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-primary/40">
            <ImageOff size={22} />
          </div>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-base font-extrabold uppercase tracking-wide text-foreground">{resourceType.name}</p>
        {resourceType.description && (
          <p className="mt-0.5 line-clamp-1 text-sm text-muted-foreground">{resourceType.description}</p>
        )}
        <p className="mt-1.5 text-sm font-bold text-primary">{formatMoney(resourceType.hourlyRate, currency)} / hr</p>
      </div>
      <Link
        href="/resources"
        className="shrink-0 rounded-lg border border-border px-3 py-2 text-xs font-bold uppercase tracking-wide text-muted-foreground transition hover:border-primary/40 hover:text-primary"
      >
        Change
      </Link>
    </div>
  )
}

function SummaryPanel({
  resourceType,
  currency,
  timeZone,
  date,
  duration,
  startsAt,
  endsAt,
  players,
  setPlayers,
  total,
  hourlyRate,
  onContinue,
}: {
  resourceType: PublicResourceTypeDetail
  currency: string
  timeZone: string
  date: string
  duration: number
  startsAt: string | null
  endsAt: string | null
  players: number
  setPlayers: (n: number) => void
  total: number
  hourlyRate: number
  onContinue: () => void
}) {
  const canContinue = Boolean(startsAt)

  return (
    <aside className="rounded-2xl border border-border bg-card p-5 shadow-sm lg:sticky lg:top-20">
      <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground">Booking Summary</p>

      <div className="mt-4 space-y-3">
        <SummaryRow icon={Boxes} label="Resource" value={resourceType.name} />
        <SummaryRow icon={CalendarDays} label="Date" value={prettyDateLong(date)} />
        <SummaryRow icon={Clock} label="Duration" value={durationLabel(duration)} />
        <SummaryRow icon={Clock} label="Start" value={startsAt ? time12(startsAt, timeZone) : '—'} />
        <SummaryRow icon={Clock} label="End" value={endsAt ? time12(endsAt, timeZone) : '—'} />
      </div>

      {resourceType.capacity != null && (
        <div className="mt-5 flex items-center justify-between rounded-xl border border-border bg-background p-3">
          <div>
            <p className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
              <Users size={14} className="text-primary" /> Players
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">Max {resourceType.capacity} players</p>
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setPlayers(Math.max(1, players - 1))}
              disabled={players <= 1}
              aria-label="Fewer players"
              className="flex size-8 items-center justify-center rounded-full border border-border text-foreground transition hover:border-primary/40 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Minus size={14} />
            </button>
            <span className="w-4 text-center text-sm font-bold tabular-nums">{players}</span>
            <button
              type="button"
              onClick={() => setPlayers(Math.min(resourceType.capacity ?? players, players + 1))}
              disabled={players >= (resourceType.capacity ?? players)}
              aria-label="More players"
              className="flex size-8 items-center justify-center rounded-full border border-border text-foreground transition hover:border-primary/40 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Plus size={14} />
            </button>
          </div>
        </div>
      )}

      <div className="mt-5 space-y-2 border-t border-border pt-4">
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>Base rate</span>
          <span className="tabular-nums">{formatMoney(hourlyRate, currency)} / hr</span>
        </div>
        <div className="flex items-center justify-between text-base font-extrabold text-foreground">
          <span>Total payable</span>
          <span className="tabular-nums text-primary">{formatMoney(total, currency)}</span>
        </div>
      </div>

      {!canContinue && (
        <p className="mt-4 rounded-lg bg-muted px-3 py-2 text-xs font-medium text-muted-foreground">
          Select a date, duration and start time to continue.
        </p>
      )}

      <button
        onClick={onContinue}
        disabled={!canContinue}
        className="mt-5 flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-3.5 text-sm font-extrabold uppercase tracking-wide text-primary-foreground shadow-md shadow-primary/20 transition-all duration-300 hover:bg-primary-hover hover:shadow-lg hover:shadow-primary/30 hover:-translate-y-0.5 active:translate-y-0 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0 disabled:hover:shadow-md"
      >
        Continue to your details
      </button>
    </aside>
  )
}
