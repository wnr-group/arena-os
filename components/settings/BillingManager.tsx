'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  AlertTriangle,
  ArrowRight,
  CreditCard,
  ExternalLink,
  Gauge,
  Info,
  Layers,
  ShieldAlert,
} from 'lucide-react'
import {
  changeSubscriptionPlan,
  previewPlanChange,
  cancelSubscription,
  createPaymentMethodUpdateFlow,
} from '@/lib/actions/subscription'
import { useConfirm } from '@/components/ui/ConfirmDialog'
import { PlatformInvoiceList } from './PlatformInvoiceList'
import { money } from '@/lib/format'

/**
 * The owner billing portal (M16 #5).
 *
 * ── Nothing here is a security boundary, and nothing here decides money ─────
 *
 * Every action it calls guards itself with requireOwner(); every figure it
 * shows was computed on the server. In particular the CONFIRMATION panel is
 * filled from previewPlanChange(), a server action that runs the same proration
 * arithmetic the mutation will — so the sentence shown before the click is the
 * sentence the charge honours. The preview is never sent back: changeSubscriptionPlan()
 * takes a plan id and a period and recomputes everything from the database, so
 * a tampered preview cannot influence what is billed.
 *
 * Limits and module flags arrive already interpreted by the entitlement guard's
 * own functions (see lib/platform/billing/portal.ts). This file does not know
 * what `max_branches` means, does not know that a missing key is a denial, and
 * must not learn — that rule lives in one place and is the same one that blocks
 * the create.
 */

type Limit = {
  key: string
  label: string
  used: number
  limit: number | null
  denied: boolean
  deniedReason: 'no_plan' | 'missing' | 'malformed' | null
}
type ModuleFlag = { key: string; label: string; enabled: boolean }
type Plan = {
  id: string
  name: string
  monthlyPrice: string
  annualPrice: string
  currency: string
  monthlyAvailable: boolean
  annualAvailable: boolean
  entitlements: Record<string, number | boolean | string | null>
  isCurrent: boolean
}
type Subscription = {
  planName: string
  billingPeriod: string
  status: string
  currentPeriodStart: string
  currentPeriodEnd: string
  cancelAtPeriodEnd: boolean
  gatewaySubscriptionId: string | null
  lapsed: boolean
} | null

/** The arrears state (AROS-113). Dates are ISO strings across the client boundary. */
type Dunning = {
  state: 'grace' | 'suspended' | 'cancelled'
  graceEndsAt: string
  cancelsAt: string | null
  reason: string | null
} | null

type Invoice = {
  id: string
  kind: 'subscription' | 'credit_note'
  invoiceNumber: string
  invoiceDate: string
  planName: string
  billingPeriodStart: string
  billingPeriodEnd: string
  billingPeriodType: string
  taxTotal: string
  total: string
  currency: string
  status: string
  documentUrl: string | null
}

type Preview = {
  current: {
    planName: string
    billingPeriod: string
    price: string
    currentPeriodEnd: string
    adminAssigned: boolean
  } | null
  target: { planId: string; planName: string; billingPeriod: string; price: string; currency: string }
  direction: 'upgrade' | 'downgrade' | 'same'
  credit: { amount: string; unusedDays: number; periodDays: number } | null
  firstChargeAmount: string
  firstInvoiceTotal: string
  effective: string
}


const day = (iso: string) => new Date(iso).toLocaleDateString('en-IN', { dateStyle: 'medium' })

const STATUS_STYLE: Record<string, string> = {
  active: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  trialing: 'bg-blue-500/15 text-blue-600 dark:text-blue-400',
  past_due: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
}

const card = 'rounded-lg border'
const cardHead = 'flex items-center gap-2 border-b px-4 py-3 text-sm font-semibold'

export function BillingManager({
  subscription,
  dunning,
  planName,
  currentPrice,
  currency,
  limits,
  modules,
  plans,
  invoices,
}: {
  subscription: Subscription
  dunning: Dunning
  planName: string | null
  currentPrice: string | null
  currency: string
  limits: Limit[]
  modules: ModuleFlag[]
  plans: Plan[]
  invoices: Invoice[]
}) {
  const router = useRouter()
  const confirm = useConfirm()
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [period, setPeriod] = useState<'monthly' | 'annual'>(
    subscription?.billingPeriod === 'annual' ? 'annual' : 'monthly',
  )
  const [preview, setPreview] = useState<Preview | null>(null)

  function reset() {
    setError(null)
    setNotice(null)
  }

  /** Step 1 of a plan change: ask the server what would happen. */
  function askPreview(planId: string) {
    if (pending) return
    reset()
    start(async () => {
      const r = await previewPlanChange({ planId, billingPeriod: period })
      if (r.error || !r.preview) {
        setError(r.error ?? 'Could not price that change.')
        return
      }
      setPreview(r.preview as unknown as Preview)
    })
  }

  /** Step 2: the owner confirmed the panel they were just shown. */
  function commitChange() {
    if (pending || !preview) return
    reset()
    const planId = preview.target.planId
    start(async () => {
      const r = await changeSubscriptionPlan({ planId, billingPeriod: period })
      if (r.error) {
        setError(r.error)
        return
      }
      setPreview(null)
      router.refresh()
      if (r.checkoutUrl) {
        setNotice(
          'Complete the payment on the Razorpay page that just opened. Your new plan shows as active here once the payment clears.',
        )
        window.open(r.checkoutUrl, '_blank', 'noopener,noreferrer')
      } else {
        setNotice('Subscription updated. Check your email for the payment link.')
      }
    })
  }

  function stop() {
    if (pending) return
    start(async () => {
      const ok = await confirm({
        title: 'Cancel your Arena OS subscription?',
        description: subscription
          ? `Your workspace keeps working until ${day(subscription.currentPeriodEnd)} and is not billed again. Nothing is deleted.`
          : 'Nothing is deleted.',
        confirmText: 'Cancel subscription',
        variant: 'destructive',
      })
      if (!ok) return
      reset()
      const r = await cancelSubscription()
      if (r.error) {
        setError(r.error)
        return
      }
      setNotice(
        r.atPeriodEnd && r.endsAt
          ? `Cancelled. Your workspace stays active until ${day(r.endsAt)}.`
          : 'Cancelled.',
      )
      router.refresh()
    })
  }

  function updatePaymentMethod() {
    if (pending) return
    reset()
    start(async () => {
      const r = await createPaymentMethodUpdateFlow()
      if (r.error || !r.url) {
        setError(r.error ?? 'Could not open the payment page.')
        return
      }
      setNotice(
        'Razorpay has opened in a new tab. Re-authorise the mandate there; this page updates once the gateway confirms.',
      )
      window.open(r.url, '_blank', 'noopener,noreferrer')
    })
  }

  return (
    <div className="mt-6 space-y-6">
      {/* ── payment-failure / cancellation banner ─────────────────────────── */}
      <StatusBanner
        subscription={subscription}
        dunning={dunning}
        onFix={updatePaymentMethod}
        pending={pending}
      />

      {error && (
        <p
          className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          role="alert"
        >
          {error}
        </p>
      )}
      {notice && !error && (
        <p className="rounded-md border border-primary/30 bg-primary/10 px-3 py-2 text-sm">
          {notice}
        </p>
      )}

      {/* ── current plan ──────────────────────────────────────────────────── */}
      <section className={card}>
        <h2 className={cardHead}>
          <CreditCard size={15} className="text-primary" />
          Current plan
        </h2>
        <div className="p-4">
          {subscription === null ? (
            <p className="text-sm text-muted-foreground">
              No active plan. Choose one below to get started — until then, plan-gated features
              stay unavailable.
            </p>
          ) : (
            <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
              <Field k="Plan">
                <span className="font-medium">{subscription.planName}</span>
                {planName === null && (
                  <span className="ml-2 text-xs text-amber-600 dark:text-amber-400">
                    (lapsed — features are unavailable)
                  </span>
                )}
              </Field>
              <Field k="Status">
                <span
                  className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                    STATUS_STYLE[subscription.status] ?? 'bg-muted text-muted-foreground'
                  }`}
                >
                  {subscription.status.replace('_', ' ')}
                </span>
              </Field>
              <Field k="Billing period">{subscription.billingPeriod}</Field>
              <Field k="Price">
                {currentPrice ? money(currency, currentPrice) : '—'}
                <span className="text-muted-foreground">
                  {' '}
                  / {subscription.billingPeriod === 'monthly' ? 'month' : 'year'}
                </span>
              </Field>
              <Field k="Current period">
                {day(subscription.currentPeriodStart)} – {day(subscription.currentPeriodEnd)}
              </Field>
              <Field k={subscription.cancelAtPeriodEnd ? 'Ends' : 'Renews'}>
                {day(subscription.currentPeriodEnd)}
              </Field>
            </dl>
          )}

          {subscription?.gatewaySubscriptionId && (
            <div className="mt-4 flex flex-wrap gap-2">
              <button
                type="button"
                disabled={pending}
                onClick={updatePaymentMethod}
                className="rounded-md border px-3 py-1.5 text-xs transition hover:bg-muted disabled:opacity-50"
              >
                Update payment method
              </button>
              {!subscription.cancelAtPeriodEnd && (
                <button
                  type="button"
                  disabled={pending}
                  onClick={stop}
                  className="rounded-md border px-3 py-1.5 text-xs transition hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
                >
                  Cancel subscription
                </button>
              )}
            </div>
          )}
          {subscription && !subscription.gatewaySubscriptionId && (
            <p className="mt-4 flex items-start gap-1.5 text-xs text-muted-foreground">
              <Info size={13} className="mt-0.5 shrink-0" />
              This plan was assigned by Arena OS, so there is no payment mandate to manage here.
              Contact support to change it.
            </p>
          )}
        </div>
      </section>

      {/* ── usage vs entitlements ─────────────────────────────────────────── */}
      <section className={card}>
        <h2 className={cardHead}>
          <Gauge size={15} className="text-primary" />
          Usage &amp; entitlements
        </h2>
        <div className="space-y-4 p-4">
          {limits.map((l) => (
            <LimitBar key={l.key} limit={l} />
          ))}

          {modules.length > 0 && (
            <div className="border-t pt-4">
              <p className="text-xs font-medium text-muted-foreground">Modules</p>
              <ul className="mt-2 grid gap-1.5 sm:grid-cols-2">
                {modules.map((m) => (
                  <li key={m.key} className="flex items-center justify-between text-sm">
                    <span>{m.label}</span>
                    <span
                      className={
                        m.enabled
                          ? 'text-xs font-medium text-emerald-600 dark:text-emerald-400'
                          : 'text-xs text-muted-foreground'
                      }
                    >
                      {m.enabled ? 'Enabled' : 'Disabled'}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {modules.length === 0 && limits.every((l) => l.denied) && (
            <p className="text-sm text-muted-foreground">
              No active plan, so nothing is entitled. Existing data is untouched — choose a plan
              to restore access.
            </p>
          )}
        </div>
      </section>

      {/* ── the confirmation panel, or the plan grid ──────────────────────── */}
      {preview ? (
        <ChangeConfirmation
          preview={preview}
          currency={currency}
          pending={pending}
          onBack={() => setPreview(null)}
          onConfirm={commitChange}
        />
      ) : (
        <section className={card}>
          <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
            <h2 className="flex items-center gap-2 text-sm font-semibold">
              <Layers size={15} className="text-primary" />
              Available plans
            </h2>
            <div className="inline-flex rounded-md border p-0.5 text-xs">
              {(['monthly', 'annual'] as const).map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setPeriod(p)}
                  className={`rounded px-3 py-1.5 font-medium transition ${
                    period === p ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'
                  }`}
                >
                  {p === 'monthly' ? 'Monthly' : 'Annual'}
                </button>
              ))}
            </div>
          </div>

          <div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-3">
            {plans.map((plan) => (
              <PlanCard
                key={plan.id}
                plan={plan}
                period={period}
                currentPrice={currentPrice}
                pending={pending}
                onChoose={() => askPreview(plan.id)}
              />
            ))}
          </div>
        </section>
      )}

      {/* ── invoices ──────────────────────────────────────────────────────── */}
      <PlatformInvoiceList invoices={invoices} />

      <p className="text-xs text-muted-foreground">
        Payments here are collected by Arena OS through its own Razorpay account. This is
        separate from your Razorpay account under Settings → Payments, which you use to take
        deposits from your own customers — those keys are never used for this.
      </p>
    </div>
  )
}

function Field({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{k}</dt>
      <dd className="mt-0.5">{children}</dd>
    </div>
  )
}

/**
 * One limit, with the usage bar.
 *
 * `limit === null` is UNLIMITED — a distinct fact from a large number, and
 * shown as such rather than as a full bar. `denied` covers every fail-closed
 * case the guard produces (no plan, key missing from the plan, malformed
 * value); each gets copy that says what to do about it, because "0 / 0" alone
 * would read as a bug.
 */
function LimitBar({ limit }: { limit: Limit }) {
  const unlimited = limit.limit === null && !limit.denied
  const cap = limit.limit ?? 0
  const pct = unlimited ? 0 : cap > 0 ? Math.min(100, Math.round((limit.used / cap) * 100)) : 100
  const atCap = !unlimited && !limit.denied && limit.used >= cap

  return (
    <div>
      <div className="flex items-baseline justify-between text-sm">
        <span>{limit.label}</span>
        <span className="tabular-nums text-muted-foreground">
          {unlimited ? `${limit.used} used · unlimited` : `${limit.used} / ${cap} used`}
        </span>
      </div>
      {!unlimited && (
        <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted">
          <div
            className={`h-full rounded-full transition-all ${
              limit.denied || atCap ? 'bg-amber-500' : 'bg-primary'
            }`}
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
      {limit.denied && (
        <p className="mt-1 text-xs text-muted-foreground">
          {limit.deniedReason === 'no_plan'
            ? `No active plan, so no ${limit.label.toLowerCase()} can be added.`
            : limit.deniedReason === 'malformed'
              ? `The ${limit.label.toLowerCase()} limit on your plan is misconfigured. Contact Arena OS support.`
              : `Your plan does not include ${limit.label.toLowerCase()}. Upgrade to add them.`}
        </p>
      )}
      {atCap && (
        <p className="mt-1 text-xs text-muted-foreground">
          You are at your plan&rsquo;s limit. Upgrade to add more {limit.label.toLowerCase()}.
        </p>
      )}
    </div>
  )
}

/** A plan in the grid, with the headline entitlements that justify its price. */
function PlanCard({
  plan,
  period,
  currentPrice,
  pending,
  onChoose,
}: {
  plan: Plan
  period: 'monthly' | 'annual'
  currentPrice: string | null
  pending: boolean
  onChoose: () => void
}) {
  const available = period === 'monthly' ? plan.monthlyAvailable : plan.annualAvailable
  const price = period === 'monthly' ? plan.monthlyPrice : plan.annualPrice

  // Direction is a PRESENTATION hint only. The server decides it again in
  // previewPlanChange(), and nothing is charged on the strength of this label.
  const delta =
    currentPrice === null
      ? null
      : Number(price) > Number(currentPrice)
        ? 'Upgrade'
        : Number(price) < Number(currentPrice)
          ? 'Downgrade'
          : null

  const limitKeys = Object.keys(plan.entitlements)
    .filter((k) => k.startsWith('max_'))
    .sort()
  const moduleKeys = Object.keys(plan.entitlements)
    .filter((k) => k.startsWith('module.') && plan.entitlements[k] === true)
    .sort()

  return (
    <div className={`rounded-lg border p-4 ${plan.isCurrent ? 'border-primary' : ''}`}>
      <div className="flex items-center justify-between">
        <p className="font-medium">{plan.name}</p>
        {plan.isCurrent && (
          <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[11px] font-medium text-primary">
            Current
          </span>
        )}
      </div>

      <p className="mt-1 text-2xl font-semibold tabular-nums">
        {money(plan.currency, price)}
        <span className="ml-1 text-xs font-normal text-muted-foreground">
          /{period === 'monthly' ? 'month' : 'year'}
        </span>
      </p>

      <ul className="mt-3 space-y-1 text-xs text-muted-foreground">
        {limitKeys.map((k) => {
          const v = plan.entitlements[k]
          const noun = k.replace(/^max_/, '').replace(/_/g, ' ')
          return (
            <li key={k}>
              {v === null ? `Unlimited ${noun}` : `${String(v)} ${noun}`}
            </li>
          )
        })}
        {moduleKeys.map((k) => (
          <li key={k}>{k.replace(/^module\./, '').replace(/_/g, ' ')} included</li>
        ))}
      </ul>

      <button
        type="button"
        disabled={pending || !available || plan.isCurrent}
        onClick={onChoose}
        className="mt-4 inline-flex w-full items-center justify-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-40"
      >
        {plan.isCurrent ? 'Current plan' : (delta ?? 'Choose plan')}
        {!plan.isCurrent && <ArrowRight size={14} />}
      </button>

      {!available && (
        <p className="mt-2 text-xs text-muted-foreground">
          {period === 'monthly' ? 'Monthly' : 'Annual'} billing is not available for this plan
          yet.
        </p>
      )}
    </div>
  )
}

/**
 * The confirmation the ticket requires: nothing changes until this is accepted.
 *
 * Every figure comes from the server's own quote. The wording describes what
 * ACTUALLY happens under M16 #3/#4 — Razorpay captures the full new-plan price
 * because a plan change is cancel-and-recreate, and the proration credit appears
 * on the resulting invoice — rather than implying a prorated card charge that
 * the gateway never performs.
 */
function ChangeConfirmation({
  preview,
  currency,
  pending,
  onBack,
  onConfirm,
}: {
  preview: Preview
  currency: string
  pending: boolean
  onBack: () => void
  onConfirm: () => void
}) {
  const verb =
    preview.direction === 'upgrade'
      ? 'Upgrade'
      : preview.direction === 'downgrade'
        ? 'Downgrade'
        : 'Change'

  return (
    <section className="rounded-lg border border-primary">
      <h2 className={cardHead}>
        <AlertTriangle size={15} className="text-primary" />
        Confirm {verb.toLowerCase()}
      </h2>

      <div className="space-y-4 p-4 text-sm">
        <div className="flex flex-wrap items-center gap-3">
          <div className="rounded-md border px-3 py-2">
            <p className="text-xs text-muted-foreground">Current</p>
            <p className="font-medium">{preview.current?.planName ?? 'No plan'}</p>
            {preview.current && (
              <p className="text-xs text-muted-foreground">
                {money(currency, preview.current.price)} / {preview.current.billingPeriod}
              </p>
            )}
          </div>
          <ArrowRight size={16} className="text-muted-foreground" />
          <div className="rounded-md border border-primary px-3 py-2">
            <p className="text-xs text-muted-foreground">New</p>
            <p className="font-medium">{preview.target.planName}</p>
            <p className="text-xs text-muted-foreground">
              {money(preview.target.currency, preview.target.price)} /{' '}
              {preview.target.billingPeriod}
            </p>
          </div>
        </div>

        <dl className="space-y-1.5 border-t pt-3">
          <Line k="Takes effect" v="Immediately, once payment is authorised" />
          <Line
            k="Razorpay will charge"
            v={money(preview.target.currency, preview.firstChargeAmount)}
          />
          <Line
            k="Invoice total"
            v={money(preview.target.currency, preview.firstInvoiceTotal)}
          />
          {preview.credit ? (
            <>
              {/* NOT subtracted, and the copy must not imply it is. The new
                  subscription is charged its plan's full price and the invoice
                  totals exactly that; the credit note is raised as a separate
                  document that stays OUTSTANDING until Arena OS settles it.
                  An earlier version showed "− credit" above a reduced "Invoice
                  total", which quoted a figure the business was never billed. */}
              <Line
                k="Credit note issued"
                v={money(currency, preview.credit.amount)}
                muted
              />
              <p className="text-xs text-muted-foreground">
                For {preview.credit.unusedDays} unused day
                {preview.credit.unusedDays === 1 ? '' : 's'} of {preview.credit.periodDays} on{' '}
                {preview.current?.planName}. This is issued as a separate credit note and stays
                outstanding on your account — it does <strong>not</strong> reduce the payment
                above. Contact Arena OS support to have it refunded.
              </p>
            </>
          ) : (
            <p className="text-xs text-muted-foreground">
              No proration credit applies — there is no paid period left to credit.
            </p>
          )}
          {preview.current && (
            <Line
              k="Current period would have ended"
              v={day(preview.current.currentPeriodEnd)}
              muted
            />
          )}
          <Line
            k="Then renews"
            v={preview.target.billingPeriod === 'monthly' ? 'Every month' : 'Every year'}
            muted
          />
        </dl>

        <p className="flex items-start gap-1.5 rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
          <Info size={13} className="mt-0.5 shrink-0" />
          Your existing subscription is cancelled and a new one is created, so you will be asked
          to authorise payment again on Razorpay. Nothing is charged until you do.
        </p>

        <div className="flex gap-2">
          <button
            type="button"
            disabled={pending}
            onClick={onConfirm}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
          >
            {pending ? 'Working…' : `Confirm ${verb.toLowerCase()}`}
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={onBack}
            className="rounded-md border px-4 py-2 text-sm font-medium transition hover:bg-muted disabled:opacity-50"
          >
            Back
          </button>
        </div>
      </div>
    </section>
  )
}

function Line({ k, v, muted }: { k: string; v: string; muted?: boolean }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-muted-foreground">{k}</dt>
      <dd className={muted ? 'text-muted-foreground' : 'font-medium'}>{v}</dd>
    </div>
  )
}

/**
 * The payment-failure / suspension / cancellation banner.
 *
 * Reads the EXISTING lifecycle state (M16 #3) plus the arrears state added by
 * AROS-113 — there is no second status system here. Each message says what has
 * happened, WHEN the next consequence lands, and what the owner can do about
 * it.
 *
 * ── Every date comes from the server ────────────────────────────────────────
 *
 * `dunning.graceEndsAt` and `dunning.cancelsAt` are computed in
 * lib/platform/billing/dunning-policy.ts, the same module the scheduled
 * processor uses to decide when to act. Nothing here adds days to a date, so
 * this banner cannot promise a suspension date the job does not honour.
 *
 * ── Why `dunning` and not `subscription` for the last two states ────────────
 *
 * A suspended or cancelled subscription is not LIVE, so `subscription` is null
 * for exactly the two cases where the owner most needs an explanation. The
 * `dunning` prop is read first for that reason, and it is the only branch that
 * renders without a subscription.
 */
function StatusBanner({
  subscription,
  dunning,
  onFix,
  pending,
}: {
  subscription: Subscription
  dunning: Dunning
  onFix: () => void
  pending: boolean
}) {
  let tone: 'warn' | 'danger' | null = null
  let message: string | null = null
  let action = false

  const because = dunning?.reason ? ` The gateway said: “${dunning.reason}”.` : ''

  if (dunning?.state === 'suspended') {
    // Restricted, NOT closed, and reversible — say both plainly. Access is cut
    // by the entitlement layer (the subscription has left LIVE_STATUSES), and a
    // successful charge reverses all of it on the next webhook.
    tone = 'danger'
    action = true
    message =
      `Your workspace is suspended for non-payment.${because}` +
      ` Your data is intact and nothing has been deleted — re-authorise your payment method to restore access` +
      (dunning.cancelsAt
        ? `. If payment is not received by ${day(dunning.cancelsAt)} the subscription will be closed.`
        : '.')
    return renderBanner(tone, message, action, onFix, pending)
  }

  if (dunning?.state === 'cancelled') {
    // Terminal. Recovery is a NEW subscription, not a payment on this one —
    // `cancelled` never moves back in lib/platform/billing/lifecycle.ts, so
    // offering "update payment method" here would be a button that cannot work.
    tone = 'danger'
    message =
      'Your subscription was closed after a long period without payment. Your invoices and records are all still here.' +
      ' Choose a plan below to start again.'
    return renderBanner(tone, message, false, onFix, pending)
  }

  if (!subscription) return null

  if (dunning?.state === 'grace') {
    // In arrears and STILL FULLY WORKING. Naming the date is the whole point:
    // "avoid suspension" without a deadline is a warning nobody can plan around.
    tone = 'warn'
    action = true
    message =
      `A payment did not go through and Razorpay is retrying.${because}` +
      ` Your workspace keeps working normally until ${day(dunning.graceEndsAt)} —` +
      ' re-authorise your payment method before then to avoid suspension.'
  } else if (subscription.status === 'past_due') {
    // past_due with no clock: a row from before migration 0053, or an arrears
    // state this build cannot date. Warn without inventing a deadline.
    tone = 'warn'
    action = true
    message =
      'A payment did not go through and Razorpay is retrying. Your workspace keeps working for now — re-authorise your payment method to avoid suspension.'
  } else if (subscription.lapsed) {
    tone = 'danger'
    action = true
    message = `Your subscription lapsed on ${day(subscription.currentPeriodEnd)}. Plan features are unavailable until a payment clears.`
  } else if (subscription.cancelAtPeriodEnd) {
    tone = 'warn'
    message = `Cancellation scheduled. Your workspace stays active until ${day(
      subscription.currentPeriodEnd,
    )} and will not be billed again. After that date you can choose a plan again below to restart.`
  }

  if (!message || !tone) return null
  return renderBanner(tone, message, action, onFix, pending)
}

/** The banner's markup, shared by every branch above so they cannot drift. */
function renderBanner(
  tone: 'warn' | 'danger',
  message: string,
  action: boolean,
  onFix: () => void,
  pending: boolean,
) {
  const cls =
    tone === 'danger'
      ? 'border-destructive/30 bg-destructive/10 text-destructive'
      : 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400'

  return (
    <div className={`flex flex-wrap items-start gap-2 rounded-md border px-3 py-2 text-sm ${cls}`}>
      <ShieldAlert size={15} className="mt-0.5 shrink-0" />
      <span className="flex-1">{message}</span>
      {action && (
        <button
          type="button"
          disabled={pending}
          onClick={onFix}
          className="inline-flex items-center gap-1 rounded-md border border-current px-2 py-1 text-xs font-medium disabled:opacity-50"
        >
          Update payment method <ExternalLink size={11} />
        </button>
      )}
    </div>
  )
}
