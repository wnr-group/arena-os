'use client'

import { useEffect, useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, Boxes, CalendarDays, Clock, ImageOff, Loader2, Mail, Minus, Phone, Plus, Sparkles, User, Users } from 'lucide-react'
import type { PublicTenant } from '@/lib/tenant/public'
import type { PublicResourceTypeDetail } from '@/lib/booking/public-availability'
import { getPublicAvailability, createPublicBooking, lookupPublicCustomerByPhone, type PublicSlotOption } from '@/lib/actions/public-booking'
import { formatMoney } from '@/lib/format'
import {
  DURATIONS,
  DATE_WINDOW_DAYS,
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
}: {
  tenant: PublicTenant
  resourceType: PublicResourceTypeDetail
  today: string
}) {
  const router = useRouter()
  const dates = useMemo(() => Array.from({ length: DATE_WINDOW_DAYS }, (_, i) => addDays(today, i)), [today])

  const [step, setStep] = useState<Step>('select')
  const [date, setDate] = useState(today)
  const [duration, setDuration] = useState(60)
  const [slots, setSlots] = useState<PublicSlotOption[] | null>(null)
  const [slotsLoading, setSlotsLoading] = useState(false)
  const [slotsError, setSlotsError] = useState<string | null>(null)
  const [selectedSlot, setSelectedSlot] = useState<PublicSlotOption | null>(null)
  const [players, setPlayers] = useState(1)
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')
  const [phoneLookup, setPhoneLookup] = useState<{ checking: boolean; checked: boolean; knownName: string | null }>({
    checking: false,
    checked: false,
    knownName: null,
  })
  const [editingKnownName, setEditingKnownName] = useState(false)
  const [confirmError, setConfirmError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const hourlyRate = Number(resourceType.hourlyRate)
  const priceFor = (minutes: number) => (hourlyRate * minutes) / 60
  const total = priceFor(duration)
  const endsAt = selectedSlot
    ? new Date(new Date(selectedSlot.startsAt).getTime() + duration * 60_000).toISOString()
    : null

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

  // Look the phone up (debounced) as soon as it looks complete enough to
  // match — same minimum length the booking submission itself requires — so
  // the name field only appears once we know whether to ask for it.
  useEffect(() => {
    setEditingKnownName(false)
    setName('')
    const digits = phone.replace(/\D/g, '')
    if (digits.length < 6) {
      setPhoneLookup({ checking: false, checked: false, knownName: null })
      return
    }
    let cancelled = false
    setPhoneLookup({ checking: true, checked: false, knownName: null })
    const timer = setTimeout(() => {
      lookupPublicCustomerByPhone({ phone }).then((r) => {
        if (cancelled) return
        const knownName = 'error' in r ? null : r.found ? r.name : null
        setPhoneLookup({ checking: false, checked: true, knownName })
        if (knownName) setName(knownName)
      })
    }, 500)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [phone])

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
      })
      if (r.error || !r.confirmationToken) {
        setConfirmError(r.error ?? 'Something went wrong. Please try again.')
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
                    ) : !slots || slots.length === 0 ? (
                      <EmptyNotice>No slots fit this duration today. Try a shorter duration or another day.</EmptyNotice>
                    ) : (
                      <div className="max-h-80 space-y-2 overflow-y-auto pr-1">
                        {slots.map((s) => {
                          const isSelected = selectedSlot?.startsAt === s.startsAt
                          const rangeEnd = new Date(new Date(s.startsAt).getTime() + duration * 60_000).toISOString()
                          return (
                            <button
                              key={s.startsAt}
                              onClick={() => setSelectedSlot(s)}
                              className={`flex w-full items-center justify-between rounded-xl border px-4 py-3 text-left text-sm font-semibold tabular-nums transition-all duration-200 active:scale-[0.99] ${
                                isSelected
                                  ? 'border-primary bg-primary text-primary-foreground shadow-md shadow-primary/20'
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
                <input
                  type="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  autoComplete="tel"
                  placeholder="Your phone number"
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

              {phoneLookup.checking ? (
                <p className="mt-3 flex items-center gap-1.5 text-sm text-muted-foreground">
                  <Loader2 size={14} className="animate-spin" /> Checking for an existing profile…
                </p>
              ) : phoneLookup.checked && phoneLookup.knownName && !editingKnownName ? (
                <div className="mt-4 flex items-center justify-between gap-3 rounded-xl border border-primary/20 bg-primary/5 px-4 py-3">
                  <p className="text-sm text-foreground">
                    Welcome back, <span className="font-bold">{phoneLookup.knownName}</span>
                  </p>
                  <button
                    type="button"
                    onClick={() => setEditingKnownName(true)}
                    className="shrink-0 text-xs font-semibold text-primary transition hover:underline"
                  >
                    Not you?
                  </button>
                </div>
              ) : phoneLookup.checked ? (
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
              ) : null}

              <div className="mt-6 space-y-2 rounded-xl border border-border bg-background p-4">
                <SummaryRow icon={Boxes} label="Resource" value={resourceType.name} />
                <SummaryRow icon={CalendarDays} label="Date" value={prettyDateLong(date)} />
                <SummaryRow icon={Clock} label="Duration" value={durationLabel(duration)} />
                <div className="flex items-center justify-between border-t border-border pt-2 text-base font-extrabold text-foreground">
                  <span>Total</span>
                  <span className="tabular-nums text-primary">{formatMoney(total, tenant.currency)}</span>
                </div>
              </div>

              <button
                onClick={confirm}
                disabled={pending || !(name.trim() && phone.trim())}
                className="mt-6 flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-3.5 text-sm font-extrabold uppercase tracking-wide text-primary-foreground shadow-md shadow-primary/20 transition-all duration-300 hover:bg-primary-hover hover:shadow-lg hover:shadow-primary/30 hover:-translate-y-0.5 active:translate-y-0 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0 disabled:hover:shadow-md"
              >
                {pending && <Loader2 size={16} className="animate-spin" />}
                Confirm booking
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
