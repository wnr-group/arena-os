'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { CreditCard, Gift, History, Receipt, ShieldAlert, XCircle } from 'lucide-react'
import { assignPlan } from '@/lib/actions/plans'
import {
  compTenantAction,
  extendTrialAction,
  forceCancelAction,
  refundInvoiceAction,
} from '@/lib/actions/platform-billing'
import { newIdempotencyKey } from '@/lib/utils/idempotency-key'
import { money } from '@/lib/format'

/**
 * The tenant billing drill-down and its five manual overrides (AROS-114 §§7–8).
 *
 * ── NOTHING HERE IS A SECURITY CONTROL ──────────────────────────────────────
 *
 * Every button below is convenience. The refusals that matter live in
 * lib/actions/platform-billing.ts (requirePlatformAdmin, on every action, before
 * anything else) and in the domain modules behind them, which validate against
 * LOCKED database rows rather than against what this form sent. A control this
 * component hides — "extend trial" on a gateway-backed subscription, "refund"
 * on a fully-refunded invoice — is refused just as firmly by a hand-crafted
 * POST. Hiding it only spares the operator a pointless click.
 *
 * ── The refund's retry token ────────────────────────────────────────────────
 *
 * Generated ONCE per refund dialog and re-sent on every attempt, exactly as
 * components/pos/PaymentPanel.tsx does for a tender. A double-clicked button or
 * a re-submitted form therefore reaches the server with the SAME key, and the
 * unique index on (tenant_id, request_key) turns the second one into a no-op
 * instead of a second refund. See lib/utils/idempotency-key.ts.
 */

type Subscription = {
  id: string
  planId: string
  planName: string
  billingPeriod: 'monthly' | 'annual'
  status: string
  currentPeriodStart: string
  currentPeriodEnd: string
  cancelAtPeriodEnd: boolean
  gatewaySubscriptionId: string | null
  gatewayBacked: boolean
  currency: string
  price: string
  mrr: number
  isTrial: boolean
  lapsed: boolean
  pastDueSince: string | null
  suspendedAt: string | null
  lastPaymentFailureAt: string | null
  lastPaymentFailureReason: string | null
  graceEndsAt: string | null
  cancelsAt: string | null
} | null

type Invoice = {
  id: string
  kind: 'subscription' | 'credit_note'
  invoiceNumber: string
  invoiceDate: string
  planName: string
  billingPeriodStart: string
  billingPeriodEnd: string
  total: number
  currency: string
  status: string
  gatewayPaymentId: string | null
  refunded: number
  refundable: number
  notes: string | null
}

type Refund = {
  id: string
  invoiceId: string
  amount: number
  currency: string
  reason: string
  status: string
  gatewayRefundId: string | null
  createdAt: string
  processedAt: string | null
}

type HistoryEntry = {
  id: string
  action: string
  createdAt: string
  actorEmail: string | null
  summary: string
}

type Plan = {
  id: string
  name: string
  monthlyPrice: string
  annualPrice: string
  currency: string
}

const STATUS_STYLE: Record<string, string> = {
  active: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  trialing: 'bg-blue-500/15 text-blue-600 dark:text-blue-400',
  past_due: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
}

const day = (iso: string) => new Date(iso).toLocaleDateString('en-IN', { dateStyle: 'medium' })

const field = 'rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring'
const btn = 'rounded-md border px-3 py-2 text-sm font-medium transition hover:bg-muted disabled:opacity-40'
const card = 'mt-8 rounded-lg border'
const cardHead = 'flex items-center gap-2 border-b px-4 py-3 text-sm font-semibold'

export function TenantBillingPanel({
  tenantId,
  subscription,
  invoices,
  refunds,
  history,
  catalogue,
}: {
  tenantId: string
  subscription: Subscription
  invoices: Invoice[]
  refunds: Refund[]
  history: HistoryEntry[]
  catalogue: Plan[]
}) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  /** Run one override and refresh. Every action returns `{ error? }`. */
  function run(fn: () => Promise<{ error?: string } & Record<string, unknown>>, ok?: (r: Record<string, unknown>) => string) {
    setError(null)
    setNotice(null)
    start(async () => {
      const r = await fn()
      if (r.error) {
        setError(r.error)
        return
      }
      if (ok) setNotice(ok(r))
      router.refresh()
    })
  }

  const currency = subscription?.currency ?? catalogue[0]?.currency ?? 'INR'

  return (
    <>
      {(error || notice) && (
        <p
          role="alert"
          className={`mt-4 rounded-md border px-3 py-2 text-sm ${
            error ? 'border-destructive/30 bg-destructive/10 text-destructive' : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
          }`}
        >
          {error ?? notice}
        </p>
      )}

      {/* ── current state ─────────────────────────────────────────────── */}
      <section className={card}>
        <h2 className={cardHead}>
          <CreditCard size={15} className="text-primary" /> Subscription
        </h2>
        <div className="p-4">
          {!subscription ? (
            <p className="text-sm text-muted-foreground">
              No live subscription. Assign a plan below to start one.
            </p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-medium">{subscription.planName}</span>
                <span className="text-muted-foreground">· {subscription.billingPeriod}</span>
                <span
                  className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                    STATUS_STYLE[subscription.status] ?? 'bg-muted text-muted-foreground'
                  }`}
                >
                  {subscription.status.replace('_', ' ')}
                </span>
                {subscription.gatewayBacked ? (
                  <span className="rounded-full bg-muted px-2 py-0.5 text-[11px]">
                    Razorpay {subscription.gatewaySubscriptionId}
                  </span>
                ) : (
                  <span className="rounded-full bg-muted px-2 py-0.5 text-[11px]">
                    Admin-assigned · no mandate
                  </span>
                )}
                {subscription.cancelAtPeriodEnd && (
                  <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] text-amber-700 dark:text-amber-400">
                    cancelling at period end
                  </span>
                )}
              </div>

              <dl className="mt-4 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
                <Row label="Price" value={`${money(subscription.currency, Number(subscription.price))} / ${subscription.billingPeriod === 'monthly' ? 'month' : 'year'}`} />
                <Row label="MRR contribution" value={subscription.mrr > 0 ? money(subscription.currency, subscription.mrr) : '— (not counted)'} />
                <Row label="Period" value={`${day(subscription.currentPeriodStart)} → ${day(subscription.currentPeriodEnd)}`} />
                {subscription.isTrial && (
                  <Row label="Trial ends" value={day(subscription.currentPeriodEnd)} />
                )}
                {subscription.lapsed && (
                  <Row label="Lapsed" value="Grants nothing — the period end has passed" />
                )}
              </dl>

              {/* Arrears, from AROS-113's clocks — the same deadlines the
                  dunning job acts on and the owner's own banner shows. */}
              {subscription.pastDueSince && (
                <div className="mt-4 flex flex-wrap items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
                  <ShieldAlert size={15} className="mt-0.5 shrink-0" />
                  <span>
                    In arrears since {day(subscription.pastDueSince)}.
                    {subscription.lastPaymentFailureReason && ` Gateway: “${subscription.lastPaymentFailureReason}”.`}
                    {subscription.suspendedAt
                      ? ` Suspended ${day(subscription.suspendedAt)}${subscription.cancelsAt ? `; cancels ${day(subscription.cancelsAt)}` : ''}.`
                      : subscription.graceEndsAt
                        ? ` Suspends ${day(subscription.graceEndsAt)}.`
                        : ''}
                  </span>
                </div>
              )}
            </>
          )}
        </div>
      </section>

      {/* ── overrides ─────────────────────────────────────────────────── */}
      <section className={card}>
        <h2 className={cardHead}>
          <Gift size={15} className="text-primary" /> Manual overrides
        </h2>

        <div className="divide-y">
          <ChangePlan
            tenantId={tenantId}
            catalogue={catalogue}
            pending={pending}
            gatewayBacked={subscription?.gatewayBacked ?? false}
            run={run}
          />
          <ExtendTrial
            tenantId={tenantId}
            pending={pending}
            subscription={subscription}
            run={run}
          />
          <Comp tenantId={tenantId} currency={currency} pending={pending} disabled={!subscription} run={run} />
          <ForceCancel tenantId={tenantId} pending={pending} subscription={subscription} run={run} />
        </div>
      </section>

      {/* ── invoices + refunds ────────────────────────────────────────── */}
      <section className={card}>
        <h2 className={cardHead}>
          <Receipt size={15} className="text-primary" /> Invoices
        </h2>
        {invoices.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">No invoices yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-medium">Number</th>
                  <th className="px-4 py-2 font-medium">Date</th>
                  <th className="px-4 py-2 font-medium">Period</th>
                  <th className="px-4 py-2 text-right font-medium">Total</th>
                  <th className="px-4 py-2 text-right font-medium">Refunded</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 font-medium" />
                </tr>
              </thead>
              <tbody className="divide-y">
                {invoices.map((i) => (
                  <tr key={i.id}>
                    <td className="px-4 py-2">
                      {i.invoiceNumber}
                      {i.kind === 'credit_note' && (
                        <span className="ml-2 rounded-full bg-muted px-2 py-0.5 text-[11px]">credit</span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-muted-foreground">{i.invoiceDate}</td>
                    <td className="px-4 py-2 text-muted-foreground">
                      {day(i.billingPeriodStart)} → {day(i.billingPeriodEnd)}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">{money(i.currency, i.total)}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">
                      {i.refunded > 0 ? money(i.currency, i.refunded) : '—'}
                    </td>
                    <td className="px-4 py-2 text-muted-foreground">{i.status}</td>
                    <td className="px-4 py-2 text-right">
                      {i.refundable > 0 && (
                        <RefundControl invoice={i} pending={pending} run={run} />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {refunds.length > 0 && (
        <section className={card}>
          <h2 className={cardHead}>Refunds</h2>
          <div className="divide-y">
            {refunds.map((r) => (
              <div key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-sm">
                <span>
                  {money(r.currency, r.amount)} · {r.reason}
                </span>
                <span className="text-xs text-muted-foreground">
                  {r.status}
                  {r.gatewayRefundId ? ` · ${r.gatewayRefundId}` : ''}
                  {/* The date the REVENUE CHART uses for a processed refund is
                      when it settled (0076), not when it was raised. Showing the
                      raised date alone made the two disagree across a month
                      boundary. Both are shown when they differ. */}
                  {' · '}
                  {r.processedAt ? `settled ${day(r.processedAt)}` : `raised ${day(r.createdAt)}`}
                  {r.processedAt && day(r.processedAt) !== day(r.createdAt)
                    ? ` · raised ${day(r.createdAt)}`
                    : ''}
                </span>
              </div>
            ))}
          </div>
          <p className="border-t px-4 py-2 text-xs text-muted-foreground">
            A refund is <strong>pending</strong> until Razorpay confirms it by webhook. Only
            processed refunds are deducted from platform revenue; a failed one releases its
            amount back to the invoice.
          </p>
        </section>
      )}

      {/* ── billing history ───────────────────────────────────────────── */}
      <section className={card}>
        <h2 className={cardHead}>
          <History size={15} className="text-primary" /> Billing history
        </h2>
        {history.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">Nothing recorded yet.</p>
        ) : (
          <div className="divide-y">
            {history.map((h) => (
              <div key={h.id} className="flex flex-wrap items-baseline justify-between gap-2 px-4 py-2 text-sm">
                <span>
                  <span className="font-medium">{h.action.replace(/_/g, ' ')}</span>
                  {h.summary && <span className="ml-2 text-muted-foreground">{h.summary}</span>}
                </span>
                <span className="text-xs text-muted-foreground">
                  {h.actorEmail ?? 'system'} · {day(h.createdAt)}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  )
}

type Runner = (
  fn: () => Promise<{ error?: string } & Record<string, unknown>>,
  ok?: (r: Record<string, unknown>) => string,
) => void

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4 border-b border-dashed py-1 last:border-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right font-medium">{value}</dd>
    </div>
  )
}

function Section({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) {
  return (
    <div className="p-4">
      <p className="text-sm font-medium">{title}</p>
      <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>
      <div className="mt-3 flex flex-wrap items-end gap-2">{children}</div>
    </div>
  )
}

function ChangePlan({
  tenantId,
  catalogue,
  pending,
  gatewayBacked,
  run,
}: {
  tenantId: string
  catalogue: Plan[]
  pending: boolean
  gatewayBacked: boolean
  run: Runner
}) {
  const [planId, setPlanId] = useState(catalogue[0]?.id ?? '')
  const [billingPeriod, setBillingPeriod] = useState<'monthly' | 'annual'>('monthly')

  return (
    <Section
      title="Change plan"
      hint={
        gatewayBacked
          ? 'Refused while a live Razorpay mandate exists — cancel the subscription first, or the gateway would keep charging for the old plan.'
          : 'Closes the current subscription and opens a new one. No payment is taken.'
      }
    >
      <select className={field} value={planId} onChange={(e) => setPlanId(e.target.value)} aria-label="Plan">
        {catalogue.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      <select
        className={field}
        value={billingPeriod}
        onChange={(e) => setBillingPeriod(e.target.value as 'monthly' | 'annual')}
        aria-label="Billing period"
      >
        <option value="monthly">Monthly</option>
        <option value="annual">Annual</option>
      </select>
      <button
        type="button"
        className={btn}
        disabled={pending || !planId}
        onClick={() => run(() => assignPlan({ tenantId, planId, billingPeriod }))}
      >
        Change plan
      </button>
    </Section>
  )
}

function ExtendTrial({
  tenantId,
  pending,
  subscription,
  run,
}: {
  tenantId: string
  pending: boolean
  subscription: Subscription
  run: Runner
}) {
  const [days, setDays] = useState('14')
  const [reason, setReason] = useState('')
  const eligible = subscription?.isTrial === true && !subscription.gatewayBacked

  return (
    <Section
      title="Extend trial"
      hint={
        !subscription
          ? 'No live subscription.'
          : !subscription.isTrial
            ? `This subscription is ${subscription.status.replace('_', ' ')}, not a trial. Issue a comp instead.`
            : subscription.gatewayBacked
              ? 'Razorpay owns this period — the next webhook would overwrite a local extension. Issue a comp against the first invoice instead.'
              : 'Moves the subscription period end, which is what the entitlement reader tests.'
      }
    >
      <input
        className={`${field} w-24`}
        type="number"
        min={1}
        max={365}
        value={days}
        onChange={(e) => setDays(e.target.value)}
        aria-label="Days"
      />
      <input
        className={`${field} min-w-48 flex-1`}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Reason (optional)"
        aria-label="Reason"
      />
      <button
        type="button"
        className={btn}
        disabled={pending || !eligible}
        onClick={() =>
          run(
            () => extendTrialAction({ tenantId, days: Number(days), reason }),
            (r) => `Trial extended to ${day(String(r.newEnd))}.`,
          )
        }
      >
        Extend
      </button>
    </Section>
  )
}

function Comp({
  tenantId,
  currency,
  pending,
  disabled,
  run,
}: {
  tenantId: string
  currency: string
  pending: boolean
  disabled: boolean
  run: Runner
}) {
  const [amount, setAmount] = useState('')
  const [reason, setReason] = useState('')

  return (
    <Section
      title="Comp / discount"
      hint={
        disabled
          ? 'No live subscription to credit against. Assign a plan first.'
          : `Raises a credit note in ${currency}, applied in full against the next invoice. Whole notes only — a credit larger than the next bill waits for one it fits.`
      }
    >
      <input
        className={`${field} w-32`}
        type="number"
        min="0.01"
        step="0.01"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        placeholder="Amount"
        aria-label="Comp amount"
      />
      <input
        className={`${field} min-w-48 flex-1`}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Reason (required)"
        aria-label="Reason"
      />
      <button
        type="button"
        className={btn}
        disabled={pending || disabled || !amount || !reason.trim()}
        onClick={() =>
          run(
            () => compTenantAction({ tenantId, amount: Number(amount), reason }),
            (r) => `Credit note ${String(r.creditNoteNumber)} issued.`,
          )
        }
      >
        Issue comp
      </button>
    </Section>
  )
}

function ForceCancel({
  tenantId,
  pending,
  subscription,
  run,
}: {
  tenantId: string
  pending: boolean
  subscription: Subscription
  run: Runner
}) {
  const [immediate, setImmediate] = useState(false)
  const [reason, setReason] = useState('')

  return (
    <Section
      title="Force cancel"
      hint={
        !subscription
          ? 'No live subscription to cancel.'
          : 'Ends the subscription at the end of the paid period — the business paid for the month it is in. Tick “immediately” only when service must stop today. The company account is NOT closed; that is a separate action on the company record.'
      }
    >
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={immediate} onChange={(e) => setImmediate(e.target.checked)} />
        Immediately
      </label>
      <input
        className={`${field} min-w-48 flex-1`}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Reason (optional)"
        aria-label="Reason"
      />
      <button
        type="button"
        className={`${btn} border-destructive/40 text-destructive`}
        disabled={pending || !subscription}
        onClick={() =>
          run(
            () => forceCancelAction({ tenantId, immediate, reason }),
            (r) =>
              r.atPeriodEnd
                ? `Cancelling at the end of the period (${day(String(r.effectiveAt))}).`
                : 'Subscription cancelled.',
          )
        }
      >
        <XCircle size={13} className="mr-1 inline" />
        Force cancel
      </button>
    </Section>
  )
}

function RefundControl({
  invoice,
  pending,
  run,
}: {
  invoice: Invoice
  pending: boolean
  run: Runner
}) {
  const [open, setOpen] = useState(false)
  const [amount, setAmount] = useState(invoice.refundable.toFixed(2))
  const [reason, setReason] = useState('')
  // ONE key per dialog, re-sent on every attempt — see the header. Regenerated
  // only when a new dialog is opened, which is a new refund.
  const [requestKey, setRequestKey] = useState(() => newIdempotencyKey())

  if (!open) {
    return (
      <button
        type="button"
        className="rounded-md border px-2 py-1 text-xs hover:bg-muted"
        onClick={() => {
          setRequestKey(newIdempotencyKey())
          setAmount(invoice.refundable.toFixed(2))
          setOpen(true)
        }}
      >
        Refund
      </button>
    )
  }

  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <input
        className={`${field} w-28`}
        type="number"
        min="0.01"
        step="0.01"
        max={invoice.refundable}
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        aria-label="Refund amount"
      />
      <input
        className={`${field} w-40`}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Reason"
        aria-label="Refund reason"
      />
      <button
        type="button"
        className="rounded-md border border-destructive/40 px-2 py-1 text-xs font-medium text-destructive disabled:opacity-40"
        disabled={pending || !amount || !reason.trim()}
        onClick={() =>
          run(
            () =>
              refundInvoiceAction({
                invoiceId: invoice.id,
                amount: Number(amount),
                reason,
                requestKey,
              }),
            (r) => {
              setOpen(false)
              if (r.deduplicated) return 'That refund had already been submitted — nothing was repeated.'
              if (r.note) return String(r.note)
              return `Refund ${String(r.status)}.`
            },
          )
        }
      >
        Confirm
      </button>
      <button type="button" className="text-xs text-muted-foreground" onClick={() => setOpen(false)}>
        Cancel
      </button>
      <span className="w-full text-right text-[11px] text-muted-foreground">
        Up to {money(invoice.currency, invoice.refundable)} remains refundable.
      </span>
    </div>
  )
}
