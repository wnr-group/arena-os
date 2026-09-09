'use client'

import { useEffect, useMemo, useState, useTransition } from 'react'
import { AlertTriangle, ArrowLeft, ArrowRight, Check, ExternalLink, Loader2 } from 'lucide-react'
import { checkSlugAvailability, submitSignup } from '@/lib/actions/signup'
import type { PublicPlan } from '@/lib/platform/plans/public'
import { normalizeSlug, slugProblem, slugProblemMessage, suggestSlug } from '@/lib/platform/slug'
import { formatMoney } from '@/lib/format'
import { cn } from '@/lib/utils/cn'

/**
 * The signup wizard (M16 #6).
 *
 * Four steps in ONE component, because the later steps are meaningless without
 * the earlier ones: the slug is derived from the business name, and the plan
 * price depends on the billing period. Navigating between separate pages would
 * mean trusting the browser to carry that state across, and would let someone
 * land on "choose a plan" having never entered a business.
 *
 * ── Nothing here is a security control ──────────────────────────────────────
 *
 * Every check in this file exists to give a person a fast answer. The server
 * action re-validates all of it — slug shape, reserved names, plan existence,
 * plan activity, price, password length — and the database has the last word on
 * whether a slug is free. Deleting this whole file would change the experience
 * and not the guarantees.
 *
 * The plan list arrives as a prop from the server, already filtered to active
 * plans by RLS. What goes back is a plan ID and a billing period; no price, no
 * entitlement and no tenant id is ever sent.
 */

const INDUSTRIES = [
  { value: 'gaming_cafe', label: 'Gaming cafe' },
  { value: 'recording_studio', label: 'Recording studio' },
  { value: 'podcast_studio', label: 'Podcast studio' },
  { value: 'dance_studio', label: 'Dance studio' },
  { value: 'vr_centre', label: 'VR centre' },
  { value: 'restaurant', label: 'Restaurant' },
  { value: 'other', label: 'Something else' },
] as const

type Industry = (typeof INDUSTRIES)[number]['value']
type Period = 'monthly' | 'annual'
type Step = 'business' | 'address' | 'plan' | 'account'

const input =
  'w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring disabled:opacity-60'
const label = 'text-sm font-medium'

/** `max_branches: 3` → "3 branches"; `module.kitchen: true` → "Kitchen". */
function entitlementLabel(key: string, value: unknown): string | null {
  if (value === false || value === null) return null
  const pretty = key
    .replace(/^module\./, '')
    .replace(/^max_/, '')
    .replace(/[._]/g, ' ')
  if (value === true) return pretty.charAt(0).toUpperCase() + pretty.slice(1)
  return `${value} ${pretty}`
}

export function SignupWizard({ plans, domain }: { plans: PublicPlan[]; domain: string }) {
  const [step, setStep] = useState<Step>('business')

  const [companyName, setCompanyName] = useState('')
  const [industry, setIndustry] = useState<Industry>('gaming_cafe')
  const [slug, setSlug] = useState('')
  const [slugTouched, setSlugTouched] = useState(false)
  const [availability, setAvailability] = useState<'idle' | 'checking' | 'free' | 'taken' | 'error'>(
    'idle',
  )
  const [availabilityError, setAvailabilityError] = useState<string | null>(null)

  const [period, setPeriod] = useState<Period>('monthly')
  const [planId, setPlanId] = useState<string>(plans[0]?.id ?? '')
  const [intent, setIntent] = useState<'trial' | 'paid'>('trial')

  const [ownerName, setOwnerName] = useState('')
  const [ownerEmail, setOwnerEmail] = useState('')
  const [ownerPassword, setOwnerPassword] = useState('')

  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<{
    loginUrl: string
    checkoutUrl?: string
    planWarning?: string
  } | null>(null)
  const [pending, start] = useTransition()

  // The slug follows the business name until the moment the user edits it
  // themselves, after which it is theirs and is never overwritten.
  useEffect(() => {
    if (!slugTouched) setSlug(suggestSlug(companyName))
  }, [companyName, slugTouched])

  const localSlugProblem = slug ? slugProblem(slug) : null

  // Debounced availability. Only fires for a slug that already passes the shape
  // rules, so a half-typed name never hits the endpoint.
  useEffect(() => {
    if (!slug || localSlugProblem) {
      setAvailability('idle')
      return
    }
    let cancelled = false
    setAvailability('checking')
    const t = setTimeout(async () => {
      const r = await checkSlugAvailability({ slug })
      if (cancelled) return
      if (r.error) {
        setAvailability('error')
        setAvailabilityError(r.error)
      } else {
        setAvailability(r.available ? 'free' : 'taken')
        setAvailabilityError(null)
      }
    }, 400)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [slug, localSlugProblem])

  const selectedPlan = useMemo(() => plans.find((p) => p.id === planId) ?? null, [plans, planId])
  const price = selectedPlan
    ? Number(period === 'monthly' ? selectedPlan.monthlyPrice : selectedPlan.annualPrice)
    : 0

  function submit() {
    setError(null)
    start(async () => {
      const r = await submitSignup({
        companyName,
        slug: normalizeSlug(slug),
        industry,
        ownerName,
        ownerEmail,
        ownerPassword,
        planId,
        billingPeriod: period,
        intent,
      })
      if (r.error) {
        setError(r.error)
        // Send them back to the step that owns the bad field.
        if (r.field === 'slug') setStep('address')
        if (r.field === 'planId') setStep('plan')
        return
      }
      setDone({
        loginUrl: r.loginUrl!,
        checkoutUrl: r.checkoutUrl,
        planWarning: r.planWarning,
      })
    })
  }

  // ── done ──────────────────────────────────────────────────────────────────
  if (done) {
    return (
      <div className="mt-10 rounded-2xl border border-border bg-card p-6 text-center sm:p-8">
        <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-600">
          <Check size={24} strokeWidth={3} aria-hidden />
        </div>
        <h2 className="mt-4 text-xl font-semibold">Your workspace is ready</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          {companyName} is set up at <span className="font-medium text-foreground">{slug}</span>.
        </p>

        {done.planWarning && (
          <p className="mx-auto mt-4 flex max-w-md gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-left text-sm text-amber-700 dark:text-amber-400">
            <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden />
            <span>{done.planWarning}</span>
          </p>
        )}

        {done.checkoutUrl && !done.planWarning && (
          <div className="mt-6">
            <a
              href={done.checkoutUrl}
              className="inline-flex items-center gap-2 rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition hover:opacity-90"
            >
              Complete payment
              <ExternalLink size={14} aria-hidden />
            </a>
            <p className="mt-2 text-xs text-muted-foreground">
              You can sign in and start setting up straight away — your plan activates once the
              payment is confirmed.
            </p>
          </div>
        )}

        <div className="mt-6">
          <a
            href={done.loginUrl}
            className={cn(
              'inline-flex items-center gap-2 rounded-md px-5 py-2.5 text-sm font-medium transition',
              done.checkoutUrl && !done.planWarning
                ? 'border border-border hover:bg-muted'
                : 'bg-primary text-primary-foreground hover:opacity-90',
            )}
          >
            Sign in to your workspace
            <ArrowRight size={14} aria-hidden />
          </a>
          <p className="mt-2 text-xs text-muted-foreground">
            Use {ownerEmail} and the password you just chose.
          </p>
        </div>
      </div>
    )
  }

  const steps: Step[] = ['business', 'address', 'plan', 'account']
  const stepIndex = steps.indexOf(step)

  const canLeaveBusiness = companyName.trim().length > 0
  const canLeaveAddress = !!slug && !localSlugProblem && availability !== 'taken'
  const canLeavePlan = !!planId
  const canSubmit =
    canLeaveBusiness &&
    canLeaveAddress &&
    canLeavePlan &&
    ownerName.trim().length > 0 &&
    /.+@.+\..+/.test(ownerEmail) &&
    ownerPassword.length >= 8

  return (
    <div className="mt-10">
      {/* progress */}
      <ol className="mb-6 flex items-center gap-2" aria-label="Signup progress">
        {steps.map((s, i) => (
          <li key={s} className="flex flex-1 items-center gap-2">
            <span
              className={cn(
                'h-1.5 w-full rounded-full',
                i <= stepIndex ? 'bg-primary' : 'bg-muted',
              )}
            />
          </li>
        ))}
      </ol>

      <div className="rounded-2xl border border-border bg-card p-5 sm:p-6">
        {/* ── 1. business ───────────────────────────────────────────────── */}
        {step === 'business' && (
          <div className="space-y-4">
            <h2 className="text-lg font-semibold">About your business</h2>

            <div className="space-y-1.5">
              <label htmlFor="companyName" className={label}>
                Business name
              </label>
              <input
                id="companyName"
                value={companyName}
                onChange={(e) => setCompanyName(e.target.value)}
                maxLength={120}
                autoFocus
                className={input}
                placeholder="Neon Arena Gaming"
              />
            </div>

            <div className="space-y-1.5">
              <label htmlFor="industry" className={label}>
                What do you run?
              </label>
              <select
                id="industry"
                value={industry}
                onChange={(e) => setIndustry(e.target.value as Industry)}
                className={input}
              >
                {INDUSTRIES.map((i) => (
                  <option key={i.value} value={i.value}>
                    {i.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}

        {/* ── 2. address ────────────────────────────────────────────────── */}
        {step === 'address' && (
          <div className="space-y-4">
            <h2 className="text-lg font-semibold">Choose your address</h2>
            <p className="text-sm text-muted-foreground">
              This is where you and your customers will find your workspace. It cannot be changed
              later without help from support.
            </p>

            <div className="space-y-1.5">
              <label htmlFor="slug" className={label}>
                Workspace address
              </label>
              <div className="flex items-center gap-1.5">
                <input
                  id="slug"
                  value={slug}
                  onChange={(e) => {
                    setSlugTouched(true)
                    setSlug(normalizeSlug(e.target.value))
                  }}
                  maxLength={50}
                  autoFocus
                  className={cn(input, 'font-mono')}
                  placeholder="neon-arena"
                  aria-describedby="slug-status"
                />
                <span className="shrink-0 text-sm text-muted-foreground">.{domain}</span>
              </div>

              <p id="slug-status" className="min-h-5 text-xs" aria-live="polite">
                {localSlugProblem && (
                  <span className="text-destructive">{slugProblemMessage(localSlugProblem)}</span>
                )}
                {!localSlugProblem && availability === 'checking' && (
                  <span className="text-muted-foreground">Checking…</span>
                )}
                {!localSlugProblem && availability === 'free' && (
                  <span className="text-emerald-600">{slug} is available.</span>
                )}
                {!localSlugProblem && availability === 'taken' && (
                  <span className="text-destructive">That address is already taken.</span>
                )}
                {!localSlugProblem && availability === 'error' && (
                  <span className="text-muted-foreground">{availabilityError}</span>
                )}
              </p>
            </div>
          </div>
        )}

        {/* ── 3. plan ───────────────────────────────────────────────────── */}
        {step === 'plan' && (
          <div className="space-y-4">
            <h2 className="text-lg font-semibold">Choose a plan</h2>

            {plans.length === 0 ? (
              <p className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-400">
                No plans are available right now. Please contact Arena OS support.
              </p>
            ) : (
              <>
                <div className="inline-flex rounded-md border border-border p-0.5 text-sm">
                  {(['monthly', 'annual'] as Period[]).map((p) => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => setPeriod(p)}
                      className={cn(
                        'rounded px-3 py-1.5 font-medium transition',
                        period === p ? 'bg-primary text-primary-foreground' : 'hover:bg-muted',
                      )}
                    >
                      {p === 'monthly' ? 'Monthly' : 'Annual'}
                    </button>
                  ))}
                </div>

                <ul className="grid gap-3">
                  {plans.map((p) => {
                    const amount = Number(p.monthlyPrice)
                    const annual = Number(p.annualPrice)
                    const shown = period === 'monthly' ? amount : annual
                    const selected = p.id === planId
                    const perks = Object.entries(p.entitlements)
                      .map(([k, v]) => entitlementLabel(k, v))
                      .filter((x): x is string => !!x)
                      .slice(0, 5)

                    return (
                      <li key={p.id}>
                        <button
                          type="button"
                          onClick={() => setPlanId(p.id)}
                          aria-pressed={selected}
                          className={cn(
                            'w-full rounded-xl border p-4 text-left transition',
                            selected
                              ? 'border-primary bg-primary/5 ring-1 ring-primary'
                              : 'border-border hover:border-primary/40',
                          )}
                        >
                          <div className="flex flex-wrap items-baseline justify-between gap-2">
                            <span className="text-base font-semibold">{p.name}</span>
                            <span className="tabular-nums">
                              <span className="text-lg font-semibold">
                                {formatMoney(shown, p.currency)}
                              </span>
                              <span className="text-xs text-muted-foreground">
                                {' '}
                                / {period === 'monthly' ? 'month' : 'year'}
                              </span>
                            </span>
                          </div>
                          {perks.length > 0 && (
                            <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                              {perks.map((perk) => (
                                <li key={perk} className="flex items-center gap-1">
                                  <Check size={11} className="text-emerald-600" aria-hidden />
                                  {perk}
                                </li>
                              ))}
                            </ul>
                          )}
                        </button>
                      </li>
                    )
                  })}
                </ul>

                <fieldset className="rounded-xl border border-border p-4">
                  <legend className="px-1 text-sm font-medium">How would you like to start?</legend>
                  <div className="mt-1 space-y-2">
                    <label className="flex cursor-pointer items-start gap-2 text-sm">
                      <input
                        type="radio"
                        name="intent"
                        checked={intent === 'trial'}
                        onChange={() => setIntent('trial')}
                        className="mt-1"
                      />
                      <span>
                        <span className="font-medium">Start a free trial</span>
                        <span className="block text-xs text-muted-foreground">
                          Full access for 14 days. No card needed — add one whenever you are ready.
                        </span>
                      </span>
                    </label>
                    <label className="flex cursor-pointer items-start gap-2 text-sm">
                      <input
                        type="radio"
                        name="intent"
                        checked={intent === 'paid'}
                        onChange={() => setIntent('paid')}
                        disabled={price <= 0}
                        className="mt-1"
                      />
                      <span>
                        <span className="font-medium">Subscribe now</span>
                        <span className="block text-xs text-muted-foreground">
                          {price > 0
                            ? `You will be taken to Razorpay to set up payment${
                                selectedPlan
                                  ? ` of ${formatMoney(price, selectedPlan.currency)} / ${
                                      period === 'monthly' ? 'month' : 'year'
                                    }`
                                  : ''
                              }.`
                            : 'This plan has no price for the selected period.'}
                        </span>
                      </span>
                    </label>
                  </div>
                </fieldset>
              </>
            )}
          </div>
        )}

        {/* ── 4. account ────────────────────────────────────────────────── */}
        {step === 'account' && (
          <div className="space-y-4">
            <h2 className="text-lg font-semibold">Create your owner account</h2>
            <p className="text-sm text-muted-foreground">
              This account owns the workspace. You can invite your team once you are in.
            </p>

            <div className="space-y-1.5">
              <label htmlFor="ownerName" className={label}>
                Your name
              </label>
              <input
                id="ownerName"
                value={ownerName}
                onChange={(e) => setOwnerName(e.target.value)}
                maxLength={120}
                autoComplete="name"
                autoFocus
                className={input}
              />
            </div>

            <div className="space-y-1.5">
              <label htmlFor="ownerEmail" className={label}>
                Email
              </label>
              <input
                id="ownerEmail"
                type="email"
                value={ownerEmail}
                onChange={(e) => setOwnerEmail(e.target.value)}
                maxLength={255}
                autoComplete="email"
                className={input}
              />
            </div>

            <div className="space-y-1.5">
              <label htmlFor="ownerPassword" className={label}>
                Password
              </label>
              <input
                id="ownerPassword"
                type="password"
                value={ownerPassword}
                onChange={(e) => setOwnerPassword(e.target.value)}
                minLength={8}
                autoComplete="new-password"
                className={input}
              />
              <p className="text-xs text-muted-foreground">At least 8 characters.</p>
            </div>

            {selectedPlan && (
              <p className="rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
                {intent === 'trial' ? (
                  <>
                    Starting a <strong className="text-foreground">14-day free trial</strong> of{' '}
                    {selectedPlan.name}. Nothing is charged.
                  </>
                ) : (
                  <>
                    Subscribing to <strong className="text-foreground">{selectedPlan.name}</strong>{' '}
                    at {formatMoney(price, selectedPlan.currency)} /{' '}
                    {period === 'monthly' ? 'month' : 'year'}. You will complete payment with
                    Razorpay after your workspace is created.
                  </>
                )}
              </p>
            )}
          </div>
        )}

        {error && (
          <p className="mt-4 text-sm text-destructive" role="alert">
            {error}
          </p>
        )}

        {/* ── navigation ────────────────────────────────────────────────── */}
        <div className="mt-6 flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={() => setStep(steps[Math.max(0, stepIndex - 1)])}
            disabled={stepIndex === 0 || pending}
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-2 text-sm font-medium transition hover:bg-muted disabled:opacity-40"
          >
            <ArrowLeft size={14} aria-hidden />
            Back
          </button>

          {step !== 'account' ? (
            <button
              type="button"
              onClick={() => setStep(steps[stepIndex + 1])}
              disabled={
                (step === 'business' && !canLeaveBusiness) ||
                (step === 'address' && !canLeaveAddress) ||
                (step === 'plan' && !canLeavePlan)
              }
              className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-40"
            >
              Continue
              <ArrowRight size={14} aria-hidden />
            </button>
          ) : (
            <button
              type="button"
              onClick={submit}
              disabled={!canSubmit || pending}
              className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-40"
            >
              {pending && <Loader2 size={14} className="animate-spin" aria-hidden />}
              {pending ? 'Creating…' : intent === 'trial' ? 'Start free trial' : 'Create and pay'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
