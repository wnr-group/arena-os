'use client'

import { useEffect, useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Check, Gamepad2, Loader2, Timer, Users, Zap } from 'lucide-react'
import { toast } from 'sonner'
import { startWalkin, listWalkinResources, lookupCustomerByPhone } from '@/lib/actions/bookings'
import { isValidPhone } from '@/lib/customers/phone'
import { formatMoney, timeInZone } from '@/lib/format'
import { useConfirm } from '@/components/ui/ConfirmDialog'
import { StepProgress } from './StepProgress'
import {
  WizardCard,
  WizardFooter,
  SelectableTile,
  SelectableTileSkeleton,
  ChipRow,
  wizardInput,
  wizardLabel,
  wizardHint,
  wizardError,
} from './wizard-ui'

const STEPS = ['Station', 'Customer', 'Start & billing']

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
  capacity: number | null
  isFree: boolean
  hasUpcomingBooking: boolean
}
/** One tile per device type — same card (icon, price/hr subtitle, capacity
 *  badge) as the future-booking wizard's Devices step, and the same
 *  auto-assign-a-free-unit rule: staff pick "PS5 Station", not a specific
 *  numbered unit. */
type ResourceTypeGroup = {
  id: string
  name: string
  hourlyRate: string
  capacity: number | null
  resources: ResourceOption[]
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
  const confirm = useConfirm()
  const [step, setStep] = useState(0)

  // Fixed at mount so the stepper's "now" doesn't visibly creep while the
  // form is open — the actual instant sent to the server is re-derived from
  // this + offsetMin at submit time, same idea either way.
  const [baseNow] = useState(() => new Date())

  const [resources, setResources] = useState<ResourceOption[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    listWalkinResources(branchId).then((r) => {
      if (cancelled) return
      if (r.error) setLoadError(r.error)
      else setResources(r.resources ?? [])
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

  const startAtIso = useMemo(() => new Date(baseNow.getTime() + offsetMin * 60_000).toISOString(), [baseNow, offsetMin])
  const freeResources = resources?.filter((r) => r.isFree) ?? []
  const selectedResource = freeResources.find((r) => r.id === resourceId) ?? null

  // Grouped by type, same as the future-booking wizard's Devices step — only
  // types with at least one free unit right now show up at all.
  const resourceTypeGroups = useMemo(() => {
    const byType = new Map<string, ResourceTypeGroup>()
    for (const r of freeResources) {
      if (!byType.has(r.resourceTypeId))
        byType.set(r.resourceTypeId, {
          id: r.resourceTypeId,
          name: r.typeName,
          hourlyRate: r.typeHourlyRate,
          capacity: r.capacity,
          resources: [],
        })
      byType.get(r.resourceTypeId)!.resources.push(r)
    }
    return [...byType.values()]
  }, [freeResources])

  async function pickResourceType(group: ResourceTypeGroup) {
    const r = group.resources[0]
    if (r) await pickResource(r)
  }

  async function pickResource(r: ResourceOption) {
    if (r.hasUpcomingBooking) {
      const ok = await confirm({
        title: `${r.name} has a booking later today`,
        description: 'An open-ended walk-in here may still be running when that booking is due to start. Continue anyway?',
        confirmText: 'Start here anyway',
        variant: 'default',
      })
      if (!ok) return
    }
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
      const r = await startWalkin({
        branchId,
        resourceId,
        phone,
        name: name.trim() || undefined,
        startAt: new Date(baseNow.getTime() + offsetMin * 60_000).toISOString(),
        mode,
        durationMin: mode === 'timed' ? durationMin : undefined,
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
            <h2 className="text-lg font-semibold">Which device?</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              A free unit of this type is assigned automatically — only types with a free unit right now are shown.
            </p>

            <div className="mt-5">
              {resources === null ? (
                loadError ? (
                  <p className="py-8 text-center text-sm text-muted-foreground">{loadError}</p>
                ) : (
                  <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
                    {Array.from({ length: 8 }).map((_, i) => (
                      <SelectableTileSkeleton key={i} />
                    ))}
                  </div>
                )
              ) : resourceTypeGroups.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">No stations are free right now.</p>
              ) : (
                <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
                  {resourceTypeGroups.map((g) => {
                    const selected = g.resources.some((r) => r.id === resourceId)
                    return (
                      <SelectableTile
                        key={g.id}
                        selected={selected}
                        onClick={() => pickResourceType(g)}
                        icon={<Gamepad2 size={18} />}
                        title={g.name}
                        subtitle={`${formatMoney(Number(g.hourlyRate), currency)} / hr`}
                        badge={
                          g.capacity != null ? (
                            <span className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground">
                              <Users size={12} /> Up to {g.capacity}
                            </span>
                          ) : undefined
                        }
                      />
                    )
                  })}
                </div>
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
                <label className={wizardLabel}>
                  Phone <span className="text-destructive">*</span>
                </label>
                <div className="relative mt-1">
                  <input
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
                <label className={wizardLabel}>Name (optional)</label>
                <input className={`${wizardInput} mt-1`} value={name} onChange={(e) => setName(e.target.value)} />
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
            <h2 className="text-lg font-semibold">Start time & billing</h2>

            <div className="mt-5 space-y-5">
              <div>
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

              <div className="rounded-lg border border-border bg-muted/40 p-4 text-sm">
                <dl className="space-y-1.5">
                  <SummaryRow k="Station" v={selectedResource?.name ?? '—'} />
                  <SummaryRow k="Customer" v={name.trim() || phone} />
                  <SummaryRow k="Billing" v={mode === 'open_tab' ? 'Open tab' : `Timed · ${durationMin} min`} />
                  <SummaryRow
                    k={mode === 'timed' ? 'Estimated total' : 'Rate'}
                    v={
                      selectedResource
                        ? mode === 'timed'
                          ? formatMoney((Number(selectedResource.hourlyRate) * durationMin) / 60, currency)
                          : `${formatMoney(Number(selectedResource.hourlyRate), currency)} / hr`
                        : '—'
                    }
                  />
                </dl>
              </div>
            </div>

            {error && step === 2 && <p className={wizardError}>{error}</p>}
            <WizardFooter onBack={() => setStep(1)} onNext={submit} nextLabel="Start walk-in" pending={pending} />
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
