'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { BadgeCheck, Clock3, Plus, X } from 'lucide-react'
import {
  purchaseCustomerMembership,
  cancelCustomerMembership,
} from '@/lib/actions/customer-memberships'
import { formatMoney } from '@/lib/format'

/**
 * A customer's memberships, and the sell-a-plan dialog.
 *
 * ── What this component decides ─────────────────────────────────────────────
 * Nothing financial. It sends a customer id and a plan id; the server reads the
 * price, the duration and every benefit off the plan row and snapshots them.
 * The prices shown here are labels — tampering with them changes the label and
 * nothing that gets charged.
 *
 * ── Eligibility is the server's answer ──────────────────────────────────────
 * `isEligible` arrives already computed (status === 'active' AND now <
 * expires_at). The component never re-derives it from `status` alone, which
 * would show a lapsed membership as live until a sweep happened to run.
 */

export type MembershipRow = {
  id: string
  planName: string
  /** Rupees, 2dp string. */
  pricePaid: string
  discountPercent: string
  freeHours: string
  freeHoursUsed: string
  walletCredit: string
  status: 'active' | 'expired' | 'cancelled'
  startsAt: string
  expiresAt: string
  /** Computed server-side: status active AND not past expiry. */
  isEligible: boolean
}

export type PlanOption = {
  id: string
  name: string
  price: string
  durationMonths: number
  discountPercent: string
  freeHours: string
  walletCredit: string
}

const btn = 'rounded-md px-3 py-2 text-sm font-medium transition disabled:opacity-50'
const trimZeros = (v: string) => String(Number(v))
const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })

const STATUS_STYLE: Record<string, string> = {
  active: 'bg-emerald-500/10 text-emerald-600',
  expired: 'bg-muted text-muted-foreground',
  cancelled: 'bg-destructive/10 text-destructive',
}

export function MembershipPanel({
  customerId,
  memberships,
  plans,
  currency,
  canSell,
}: {
  customerId: string
  memberships: MembershipRow[]
  plans: PlanOption[]
  currency: string
  /** Cashier and up. Hiding the button is convenience — the action re-checks. */
  canSell: boolean
}) {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [showDialog, setShowDialog] = useState(false)
  // A membership sale is a tender like any other, so the cashier picks how it
  // was paid. The server refuses a priced sale with no method.
  const [method, setMethod] = useState<'cash' | 'card' | 'upi'>('cash')
  const [pending, start] = useTransition()

  const money = (v: string | number) => formatMoney(v, currency)
  const live = memberships.find((m) => m.isEligible) ?? null
  // The most recent membership that is NOT eligible — shown when there is no
  // live one, so an expired member reads as "Gold, expired on <date>" rather
  // than as someone who never had a membership. `memberships` arrives newest
  // first from the server.
  const lapsed = live ? null : (memberships.find((m) => !m.isEligible) ?? null)

  function sell(planId: string) {
    setError(null)
    setNotice(null)
    start(async () => {
      const r = await purchaseCustomerMembership({ customerId, planId, paymentMethod: method })
      if (r.error) {
        setError(r.error)
        return
      }
      setShowDialog(false)
      if (r.membership) {
        setNotice(
          `${r.membership.planName} active until ${shortDate(r.membership.expiresAt)}.` +
            (r.membership.invoiceNumber ? ` Invoice ${r.membership.invoiceNumber}.` : '') +
            (r.membership.walletCredited > 0
              ? ` ${money(r.membership.walletCredited)} wallet credit added.`
              : ''),
        )
      }
      router.refresh()
    })
  }

  function cancel(m: MembershipRow) {
    if (
      !window.confirm(
        `Cancel this ${m.planName} membership? Benefits stop immediately. Wallet credit already granted is not reversed.`,
      )
    )
      return
    setError(null)
    setNotice(null)
    start(async () => {
      const r = await cancelCustomerMembership(m.id, customerId)
      if (r.error) setError(r.error)
      else router.refresh()
    })
  }

  return (
    <section className="mt-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Membership
        </h2>
        {canSell && !live && plans.length > 0 && (
          <button
            onClick={() => setShowDialog(true)}
            disabled={pending}
            className={`${btn} inline-flex items-center gap-1.5 bg-primary text-primary-foreground`}
          >
            <Plus size={15} /> Sell membership
          </button>
        )}
      </div>

      {error && (
        <p className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}
      {notice && (
        <p className="mt-3 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-sm text-emerald-700">
          {notice}
        </p>
      )}

      {/* ── the live membership, and its benefits ── */}
      {live ? (
        <div className="mt-3 rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="inline-flex items-center gap-1.5 font-semibold text-emerald-700">
                <BadgeCheck size={16} /> {live.planName}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {shortDate(live.startsAt)} – {shortDate(live.expiresAt)} · paid{' '}
                {money(live.pricePaid)}
              </p>
            </div>
            {canSell && (
              <button
                onClick={() => cancel(live)}
                disabled={pending}
                className="text-xs font-medium text-destructive hover:underline disabled:opacity-50"
              >
                Cancel membership
              </button>
            )}
          </div>

          <dl className="mt-3 grid grid-cols-3 gap-3 border-t border-emerald-500/20 pt-3 text-sm">
            <Benefit label="Discount" value={`${trimZeros(live.discountPercent)}%`} />
            <Benefit
              label="Free hours left"
              value={`${trimZeros(String(Number(live.freeHours) - Number(live.freeHoursUsed)))} / ${trimZeros(live.freeHours)}`}
            />
            <Benefit label="Wallet credit" value={money(live.walletCredit)} />
          </dl>

          <p className="mt-2 text-xs text-muted-foreground">
            These benefits were fixed when the membership was bought — later changes to the{' '}
            {live.planName} plan do not affect them.
          </p>
        </div>
      ) : lapsed ? (
        /* No live membership, but the customer has held one. Show the most
           recent by name and state — "Expired on 31 Dec 2026" is far more use
           at the counter than a bare "no membership". The benefits are shown
           struck through: they are what was PURCHASED, and they no longer
           apply, which is exactly the distinction the eligibility rule draws. */
        <div className="mt-3 rounded-xl border border-border bg-muted/30 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="font-semibold">{lapsed.planName}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {lapsed.status === 'cancelled'
                  ? `Cancelled · ran ${shortDate(lapsed.startsAt)} – ${shortDate(lapsed.expiresAt)}`
                  : `Expired on ${shortDate(lapsed.expiresAt)}`}
              </p>
            </div>
            <span
              className={`rounded-full px-2 py-1 text-xs font-medium ${STATUS_STYLE[lapsed.status]}`}
            >
              {lapsed.status === 'cancelled' ? 'Cancelled' : 'Expired'}
            </span>
          </div>

          <dl className="mt-3 grid grid-cols-3 gap-3 border-t pt-3 text-sm text-muted-foreground line-through">
            <Benefit label="Discount" value={`${trimZeros(lapsed.discountPercent)}%`} />
            <Benefit label="Free hours" value={trimZeros(lapsed.freeHours)} />
            <Benefit label="Wallet credit" value={money(lapsed.walletCredit)} />
          </dl>

          <p className="mt-2 text-xs text-muted-foreground">
            No benefits apply. Sell a plan to start a new membership.
          </p>
        </div>
      ) : (
        <p className="mt-3 rounded-md border border-dashed px-3 py-4 text-sm text-muted-foreground">
          No membership. Sell a plan to start one.
        </p>
      )}

      {/* ── history ── */}
      {memberships.filter((m) => !m.isEligible && m.id !== lapsed?.id).length > 0 && (
        <div className="mt-3 overflow-hidden rounded-xl border border-border">
          <table className="w-full min-w-[520px] text-left text-sm">
            <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-2.5 font-medium">Plan</th>
                <th className="px-4 py-2.5 font-medium">Period</th>
                <th className="px-4 py-2.5 font-medium">Paid</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {memberships
                .filter((m) => !m.isEligible && m.id !== lapsed?.id)
                .map((m) => (
                  <tr key={m.id}>
                    <td className="px-4 py-2.5">{m.planName}</td>
                    <td className="px-4 py-2.5 text-muted-foreground">
                      {shortDate(m.startsAt)} – {shortDate(m.expiresAt)}
                    </td>
                    <td className="px-4 py-2.5 tabular-nums">{money(m.pricePaid)}</td>
                    <td className="px-4 py-2.5">
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[m.status]}`}
                      >
                        {m.status}
                      </span>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}

      {showDialog && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => !pending && setShowDialog(false)}
        >
          <div
            className="max-h-[80vh] w-full max-w-md overflow-y-auto rounded-lg border bg-card p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h2 className="font-semibold">Sell a membership</h2>
              <button
                onClick={() => setShowDialog(false)}
                disabled={pending}
                aria-label="Close"
                className="text-muted-foreground hover:text-foreground disabled:opacity-50"
              >
                <X size={18} />
              </button>
            </div>

            <ul className="mt-4 space-y-2">
              {plans.map((p) => (
                <li key={p.id}>
                  <button
                    onClick={() => sell(p.id)}
                    disabled={pending}
                    className="w-full rounded-lg border p-3 text-left transition hover:border-primary/50 hover:bg-muted/40 disabled:opacity-50"
                  >
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="font-medium">{p.name}</span>
                      <span className="tabular-nums">
                        {money(p.price)}{' '}
                        <span className="text-xs text-muted-foreground">
                          / {p.durationMonths} month{p.durationMonths === 1 ? '' : 's'}
                        </span>
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {trimZeros(p.discountPercent)}% discount · {trimZeros(p.freeHours)} free
                      hours · {money(p.walletCredit)} wallet credit
                    </p>
                  </button>
                </li>
              ))}
            </ul>

            <div className="mt-4 border-t pt-3">
              <label htmlFor="membership-method" className="text-sm font-medium">
                Payment method
              </label>
              <select
                id="membership-method"
                value={method}
                onChange={(e) => setMethod(e.target.value as typeof method)}
                disabled={pending}
                className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring disabled:opacity-60"
              >
                <option value="cash">Cash</option>
                <option value="card">Card</option>
                <option value="upi">UPI</option>
              </select>
            </div>

            <p className="mt-3 inline-flex items-start gap-1.5 text-xs text-muted-foreground">
              <Clock3 size={12} className="mt-0.5 shrink-0" /> The period runs from today. Benefits
              are locked in at purchase, and a GST invoice is raised for the sale.
            </p>
          </div>
        </div>
      )}
    </section>
  )
}

function Benefit({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 font-medium tabular-nums">{value}</dd>
    </div>
  )
}
