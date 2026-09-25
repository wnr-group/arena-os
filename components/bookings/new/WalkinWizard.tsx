'use client'

import { useEffect, useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Check, Loader2, Timer, Zap } from 'lucide-react'
import { toast } from 'sonner'
import { startWalkin, listWalkinResources, lookupCustomerByPhone } from '@/lib/actions/bookings'
import { isWeekendDay } from '@/lib/booking/rate'
import { isValidPhone } from '@/lib/customers/phone'
import { formatMoney, timeInZone } from '@/lib/format'
import { StepProgress } from './StepProgress'
import { WalkInAvailabilityCalendar } from './WalkInAvailabilityCalendar'
import {
  WizardCard,
  WizardFooter,
  SelectableTile,
  ChipRow,
  wizardInput,
  wizardLabel,
  wizardHint,
  wizardError,
} from './wizard-ui'

const STEPS = ['Availability', 'Customer', 'Billing']

/** Mirrors lib/booking/walkin.ts's WALKIN_START_WINDOW_MINUTES (5-min steps within it). */
const START_OFFSET_STEP_MIN = 5
const START_OFFSET_MAX_MIN = 30

/** Mirrors lib/booking/walkin.ts's WALKIN_MIN/MAX/STEP_DURATION_MINUTES. */
const DURATIONS = Array.from({ length: 10 }, (_, i) => (i + 1) * 30).map((min) => ({
  value: min,
  label: min < 60 ? `${min} min` : `${min / 60} hr`,
}))

type ResourceOption = {
  id: string
  name: string
  resourceTypeId: string
  typeName: string
  hourlyRate: string
  typeHourlyRate: string
  /** M22 bugfix: the type's weekend rate (null = no weekend pricing). Always
   *  the TYPE's own rate, never a per-station override — combine with
   *  weekendDays (below) via isWeekendDay/effectiveRate so the estimate
   *  tracks the chosen start time the same way startWalkinCore prices it. */
  weekendRate: string | null
  capacity: number | null
  isFree: boolean
  hasUpcomingBooking: boolean
  /** M23: this resource's own next active booking, if any — what the "check
   *  availability" calendar (WalkInAvailabilityCalendar) uses to compute how
   *  long a walk-in could run here before it. */
  nextBooking: {
    startsAt: string
    endsAt: string | null
    bookingNumber: string
    customerName: string | null
  } | null
  /** M21 per-head #4: 'per_resource' (default) or 'per_head' — gates the
   *  Start & billing step's Players field. */
  pricingMode: string
  minPlayers: number
}

/** M22 bugfix: the rate a station actually bills at `startAt` — weekday or
 *  weekend, resolved with the SAME pure functions (lib/booking/rate.ts)
 *  startWalkinCore itself uses server-side, so this estimate can never
 *  drift from what actually gets charged. A per-station override (baked
 *  into `weekdayRate` by the server) only ever applies on a weekday — see
 *  WalkinResourceOption's own doc comment. */
function effectiveRate(
  weekdayRate: string,
  weekendRate: string | null,
  startAt: Date,
  timeZone: string,
  weekendDays: number[],
): number {
  if (weekendRate !== null && isWeekendDay(startAt, timeZone, weekendDays)) return Number(weekendRate)
  return Number(weekdayRate)
}

/**
 * M22 follow-up (cosmetic, no money impact — adversarial review of PR #29):
 * true when the resolved rate at `startAt` is <= 0 — the EXACT condition
 * startWalkinCore's own guard rejects on server-side (lib/booking/walkin.ts:
 * `if (rate <= 0) throw new BookingError(...)`), most commonly a
 * free-on-weekends config (weekend_rate = 0 with a positive weekday rate).
 * Without this, the wizard showed "₹0.00 / hr" — reading as a legitimate
 * free promotion — and only surfaced the rejection after the operator
 * already tried to submit. Checked purely to warn/disable early; the server
 * re-checks this itself regardless, so nothing here can let a bad booking
 * through even if this client-side copy ever drifted.
 */
function isUnbillable(
  weekdayRate: string,
  weekendRate: string | null,
  startAt: Date,
  timeZone: string,
  weekendDays: number[],
): boolean {
  return effectiveRate(weekdayRate, weekendRate, startAt, timeZone, weekendDays) <= 0
}

/**
 * Walk-in wizard (M21 #3) — Station → Customer → Start & billing. Same
 * startWalkin/listWalkinResources/lookupCustomerByPhone logic as the modal
 * this replaced; only the presentation changed (one step at a time instead
 * of one long form, premium tiles instead of plain buttons).
 */
export function WalkinWizard({
  branchId,
  timeZone,
  currency,
}: {
  branchId: string
  timeZone: string
  currency: string
}) {
  const router = useRouter()
  const [step, setStep] = useState(0)

  // Fixed at mount so the stepper's "now" doesn't visibly creep while the
  // form is open — the actual instant sent to the server is re-derived from
  // this + offsetMin at submit time, same idea either way.
  const [baseNow] = useState(() => new Date())

  const [resources, setResources] = useState<ResourceOption[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  // M22 bugfix: arrives in the SAME response as `resources`, so there's no
  // "flat rate, then updates" transition to handle — by the time resources
  // is non-null this is already set too. Defaults to [] (no day is weekend)
  // purely so effectiveRate has something to read before that first load.
  const [weekendDays, setWeekendDays] = useState<number[]>([])
  useEffect(() => {
    let cancelled = false
    listWalkinResources(branchId).then((r) => {
      if (cancelled) return
      if (r.error) setLoadError(r.error)
      else {
        setResources(r.resources ?? [])
        setWeekendDays(r.weekendDays ?? [])
      }
    })
    return () => {
      cancelled = true
    }
  }, [branchId])

  const [resourceId, setResourceId] = useState<string | null>(null)
  const [phone, setPhone] = useState('')
  const [name, setName] = useState('')
  const [phoneTouched, setPhoneTouched] = useState(false)
  const [checkingPhone, setCheckingPhone] = useState(false)
  const [phoneChecked, setPhoneChecked] = useState(false)
  const [existingCustomerName, setExistingCustomerName] = useState<string | null>(null)
  const [offsetMin, setOffsetMin] = useState(0)
  const [mode, setMode] = useState<'open_tab' | 'timed'>('open_tab')
  const [durationMin, setDurationMin] = useState(60)
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()

  // M21 per-head #4: player count for a per_head station — defaults to the
  // type's min_players, reset whenever a different station is picked. No
  // max cap, per the design doc.
  const [headCount, setHeadCount] = useState(1)

  // Same phone-first lookup as the old dialog — name stays optional either
  // way, so this only ever pre-fills it, never gates the form.
  useEffect(() => {
    setPhoneChecked(false)
    setExistingCustomerName(null)
    setCheckingPhone(false)
    if (!isValidPhone(phone)) return
    let cancelled = false
    setCheckingPhone(true)
    lookupCustomerByPhone(phone)
      .then((r) => {
        if (cancelled) return
        setCheckingPhone(false)
        setPhoneChecked(true)
        const known = r.found ? (r.name ?? '').trim() : ''
        setExistingCustomerName(known || null)
        if (known) setName(known)
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
  }, [phone])

  const phoneError = phoneTouched && !phone.trim()
    ? 'Phone number is required.'
    : phone.trim() && !isValidPhone(phone)
      ? 'Enter a valid 10-digit phone number.'
      : null

  const startAt = useMemo(() => new Date(baseNow.getTime() + offsetMin * 60_000), [baseNow, offsetMin])
  const startAtIso = useMemo(() => startAt.toISOString(), [startAt])
  const freeResources = resources?.filter((r) => r.isFree) ?? []
  const selectedResource = freeResources.find((r) => r.id === resourceId) ?? null
  const isPerHead = selectedResource?.pricingMode === 'per_head'
  // M22 follow-up: see isUnbillable's own doc comment. Recomputed against
  // the ACTUAL chosen start time (startAt, nudged by offsetMin) — same
  // reasoning the Rate/Estimated-total row below already applies.
  const unbillable = selectedResource
    ? isUnbillable(selectedResource.hourlyRate, selectedResource.weekendRate, startAt, timeZone, weekendDays)
    : false

  useEffect(() => {
    setHeadCount(selectedResource?.minPlayers ?? 1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resourceId])

  // M23: picking a device now happens inside WalkInAvailabilityCalendar,
  // which shows the actual next-booking time (or "open-ended") before staff
  // ever click — the old confirm-before-picking popup this replaced was the
  // only way to surface that same fact when the picker was a plain tile
  // grid with no time information on it at all. The calendar itself already
  // refuses a click on an occupied-right-now resource or one whose window
  // has closed at the currently-selected start time (see its own disabled
  // logic), so nothing further needs checking here.
  function pickResource(r: { id: string }) {
    setResourceId(r.id)
  }

  function submit() {
    setError(null)
    if (!resourceId) {
      setError('Pick a station first.')
      setStep(0)
      return
    }
    if (!phone.trim() || !isValidPhone(phone)) {
      setError('Enter a valid 10-digit phone number.')
      setStep(1)
      return
    }
    if (checkingPhone) {
      setError('Still checking that phone number — try again in a moment.')
      return
    }
    start(async () => {
      // Derived fresh here, NOT from baseNow (which only exists to keep the
      // stepper's displayed "now" from visibly creeping while the form sits
      // open) — a wizard left open for a while must still submit a start
      // time close to the actual moment of submission, both so the booking's
      // own duration/pricing is right and so startWalkinCore's ±30-min
      // window (lib/booking/walkin.ts) doesn't reject a perfectly good
      // zero-offset walk-in just because the form was open too long.
      const r = await startWalkin({
        branchId,
        resourceId,
        phone,
        name: name.trim() || undefined,
        startAt: new Date(Date.now() + offsetMin * 60_000).toISOString(),
        mode,
        durationMin: mode === 'timed' ? durationMin : undefined,
        headCount: isPerHead ? headCount : undefined,
      })
      if (r.error) setError(r.error)
      else {
        toast.success(`Walk-in ${r.bookingNumber} started.`)
        router.push('/bookings')
      }
    })
  }

  return (
    <div className="space-y-6">
      <div className="mx-auto max-w-xl">
        <StepProgress steps={STEPS} current={step} />
      </div>

      <WizardCard>
        {step === 0 && (
          <div>
            <h2 className="text-lg font-semibold">Check availability</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              First, tell us when the customer is starting. Then pick a device that&rsquo;s free — we&rsquo;ll show how
              long it&rsquo;s open for, just so you know if another booking is coming up. It&rsquo;s not a time limit;
              the customer can stay until you check them out.
            </p>

            <div className="mt-5 max-w-sm">
              <label className={wizardLabel}>Start time</label>
              <div className="mt-2 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setOffsetMin((m) => Math.max(-START_OFFSET_MAX_MIN, m - START_OFFSET_STEP_MIN))}
                  disabled={offsetMin <= -START_OFFSET_MAX_MIN}
                  className="rounded-lg border border-border px-3 py-2 text-sm font-medium transition hover:bg-muted disabled:opacity-40"
                >
                  − {START_OFFSET_STEP_MIN} min
                </button>
                <span className="flex-1 rounded-lg border border-border bg-accent/40 px-3 py-2 text-center text-base font-semibold text-foreground">
                  {timeInZone(startAtIso, timeZone)}
                  {offsetMin !== 0 && (
                    <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                      ({offsetMin > 0 ? `+${offsetMin}` : offsetMin} min)
                    </span>
                  )}
                </span>
                <button
                  type="button"
                  onClick={() => setOffsetMin((m) => Math.min(START_OFFSET_MAX_MIN, m + START_OFFSET_STEP_MIN))}
                  disabled={offsetMin >= START_OFFSET_MAX_MIN}
                  className="rounded-lg border border-border px-3 py-2 text-sm font-medium transition hover:bg-muted disabled:opacity-40"
                >
                  + {START_OFFSET_STEP_MIN} min
                </button>
              </div>
              <p className={wizardHint}>Up to {START_OFFSET_MAX_MIN} minutes either side of now.</p>
            </div>

            <div className="mt-6">
              {resources === null ? (
                loadError ? (
                  <p className="py-8 text-center text-sm text-muted-foreground">{loadError}</p>
                ) : (
                  <div className="flex flex-col items-center justify-center gap-3 py-14">
                    <span className="relative flex size-10 items-center justify-center">
                      <span className="absolute inset-0 animate-ping rounded-full bg-primary/20" />
                      <span className="relative flex size-10 items-center justify-center rounded-full bg-primary/10">
                        <Loader2 size={20} className="animate-spin text-primary" />
                      </span>
                    </span>
                    <p className="text-sm font-medium text-muted-foreground">Checking which devices are free…</p>
                  </div>
                )
              ) : (
                <WalkInAvailabilityCalendar
                  resources={resources}
                  timeZone={timeZone}
                  currency={currency}
                  startAtIso={startAtIso}
                  selectedResourceId={resourceId}
                  onSelect={pickResource}
                />
              )}
            </div>

            {error && step === 0 && <p className={wizardError}>{error}</p>}
            <WizardFooter onNext={() => setStep(1)} nextLabel="Continue" nextDisabled={!resourceId} />
          </div>
        )}

        {step === 1 && (
          <div className="mx-auto max-w-xl rounded-2xl border border-border bg-card p-6 shadow-sm sm:p-8">
            <h2 className="text-lg font-semibold">Who&apos;s this for?</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Starting a walk-in on <span className="font-medium text-foreground">{selectedResource?.name}</span>.
            </p>

            <div className="mt-5 space-y-4">
              <div>
                <label htmlFor="walkin-customer-phone" className={wizardLabel}>
                  Phone <span className="text-destructive">*</span>
                </label>
                <div className="relative mt-1">
                  <input
                    id="walkin-customer-phone"
                    className={wizardInput}
                    value={phone}
                    inputMode="tel"
                    required
                    autoFocus
                    onChange={(e) => setPhone(e.target.value.replace(/[^\d+\s-]/g, ''))}
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

              <div>
                <label htmlFor="walkin-customer-name" className={wizardLabel}>Name (optional)</label>
                <input
                  id="walkin-customer-name"
                  className={`${wizardInput} mt-1`}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
            </div>

            {error && step === 1 && <p className={wizardError}>{error}</p>}
            <WizardFooter
              onBack={() => setStep(0)}
              onNext={() => {
                if (!phone.trim() || !isValidPhone(phone)) {
                  setPhoneTouched(true)
                  return
                }
                setStep(2)
              }}
              nextLabel="Continue"
              nextDisabled={!phone.trim() || !isValidPhone(phone) || checkingPhone}
            />
          </div>
        )}

        {step === 2 && (
          <div className="mx-auto max-w-xl rounded-2xl border border-border bg-card p-6 shadow-sm sm:p-8">
            <h2 className="text-lg font-semibold">Billing</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Starting at <span className="font-medium text-foreground">{timeInZone(startAtIso, timeZone)}</span> on{' '}
              <span className="font-medium text-foreground">{selectedResource?.name}</span>.
            </p>

            <div className="mt-5 space-y-5">
              <div>
                <label className={wizardLabel}>Billing</label>
                <div className="mt-2 grid grid-cols-2 gap-3">
                  <SelectableTile
                    selected={mode === 'open_tab'}
                    onClick={() => setMode('open_tab')}
                    icon={<Zap size={18} />}
                    title="Open tab"
                    subtitle="Bill by elapsed time at checkout"
                  />
                  <SelectableTile
                    selected={mode === 'timed'}
                    onClick={() => setMode('timed')}
                    icon={<Timer size={18} />}
                    title="Timed"
                    subtitle="Fixed, extendable duration"
                  />
                </div>
              </div>

              {mode === 'timed' && (
                <div>
                  <label className={wizardLabel}>Duration</label>
                  <div className="mt-2">
                    <ChipRow options={DURATIONS} value={durationMin} onChange={setDurationMin} />
                  </div>
                </div>
              )}

              {isPerHead && selectedResource && (
                <div>
                  <label className={wizardLabel}>Players</label>
                  <div className="mt-2 flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setHeadCount((h) => Math.max(selectedResource.minPlayers, h - 1))}
                      disabled={headCount <= selectedResource.minPlayers}
                      className="rounded-lg border border-border px-3 py-2 text-sm font-medium transition hover:bg-muted disabled:opacity-40"
                    >
                      −
                    </button>
                    <span className="flex-1 rounded-lg border border-border bg-accent/40 px-3 py-2 text-center text-base font-semibold text-foreground">
                      {headCount}
                    </span>
                    <button
                      type="button"
                      onClick={() => setHeadCount((h) => h + 1)}
                      className="rounded-lg border border-border px-3 py-2 text-sm font-medium transition hover:bg-muted"
                    >
                      +
                    </button>
                  </div>
                  <p className={wizardHint}>
                    {selectedResource.typeName} is priced per player — minimum {selectedResource.minPlayers}.
                  </p>
                </div>
              )}

              <div className="rounded-lg border border-border bg-muted/40 p-4 text-sm">
                <dl className="space-y-1.5">
                  <SummaryRow k="Station" v={selectedResource?.name ?? '—'} />
                  <SummaryRow k="Customer" v={name.trim() || phone} />
                  <SummaryRow k="Billing" v={mode === 'open_tab' ? 'Open tab' : `Timed · ${durationMin} min`} />
                  {isPerHead && <SummaryRow k="Players" v={String(headCount)} />}
                  <SummaryRow
                    k={mode === 'timed' ? 'Estimated total' : 'Rate'}
                    v={
                      selectedResource
                        ? (() => {
                            // M22 bugfix: resolved against the ACTUAL chosen
                            // start time (startAt, nudged by offsetMin), not
                            // just "now" — a nudge can push the session onto
                            // the other side of a weekday/weekend boundary.
                            const rate = effectiveRate(
                              selectedResource.hourlyRate,
                              selectedResource.weekendRate,
                              startAt,
                              timeZone,
                              weekendDays,
                            )
                            return mode === 'timed'
                              ? formatMoney((rate * durationMin * (isPerHead ? headCount : 1)) / 60, currency)
                              : `${formatMoney(rate, currency)} / ${isPerHead ? 'player / hr' : 'hr'}`
                          })()
                        : '—'
                    }
                  />
                </dl>
              </div>

              {unbillable && (
                <p className="rounded-lg border border-destructive/30 bg-destructive/5 px-3.5 py-2.5 text-sm text-destructive">
                  {selectedResource?.typeName} isn&rsquo;t set up for{' '}
                  {isWeekendDay(startAt, timeZone, weekendDays) ? 'weekend' : 'weekday'} bookings — starting now will
                  be rejected. Pick a different station, or ask an owner to set a rate for this one.
                </p>
              )}
            </div>

            {error && step === 2 && <p className={wizardError}>{error}</p>}
            <WizardFooter
              onBack={() => setStep(1)}
              onNext={submit}
              nextLabel="Start walk-in"
              pending={pending}
              nextDisabled={unbillable}
            />
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
