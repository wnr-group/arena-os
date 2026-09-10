'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { CreditCard } from 'lucide-react'
import { assignPlan } from '@/lib/actions/plans'

/**
 * Which plan a company is on, and the control to change it (M16).
 *
 * NOT the subscription lifecycle. There is no checkout, no gateway object, no
 * renewal and no proration here — assignPlan() closes the current live row and
 * opens a new one, which is what lets an operator put a business on a plan
 * today. Everything about actually CHARGING for it belongs to the billing
 * story.
 *
 * Nothing on this panel enforces anything either: the plan shown here does not
 * yet gate a single feature anywhere in the app.
 */

type Subscription = {
  planName: string
  billingPeriod: string
  status: string
  currentPeriodEnd: Date
} | null

const STATUS_STYLE: Record<string, string> = {
  active: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  trialing: 'bg-blue-500/15 text-blue-600 dark:text-blue-400',
  past_due: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
}

const select =
  'rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring'

export function SubscriptionPanel({
  tenantId,
  subscription,
  plans,
}: {
  tenantId: string
  subscription: Subscription
  plans: { id: string; name: string }[]
}) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [planId, setPlanId] = useState(plans[0]?.id ?? '')
  const [billingPeriod, setBillingPeriod] = useState<'monthly' | 'annual'>('monthly')

  const lapsed = subscription !== null && subscription.currentPeriodEnd.getTime() <= Date.now()

  return (
    <section className="mt-8 rounded-lg border">
      <h2 className="flex items-center gap-2 border-b px-4 py-3 text-sm font-semibold">
        <CreditCard size={15} className="text-primary" />
        Subscription
      </h2>

      <div className="p-4">
        {subscription === null ? (
          <p className="text-sm text-muted-foreground">
            No subscription. This company is not on a plan.
          </p>
        ) : (
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
            <span className="text-muted-foreground">
              {lapsed ? 'ended' : 'renews'} {subscription.currentPeriodEnd.toLocaleDateString()}
            </span>
            {/* Stated plainly because the status alone does not say it: past the
                period end, getEntitlements() grants nothing regardless of what
                the status column still reads. */}
            {lapsed && (
              <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-[11px] font-medium text-destructive">
                lapsed — grants nothing
              </span>
            )}
          </div>
        )}

        {plans.length === 0 ? (
          <p className="mt-4 text-sm text-muted-foreground">
            No active plans in the catalogue yet.
          </p>
        ) : (
          <div className="mt-4 flex flex-wrap items-end gap-2">
            <select
              className={select}
              value={planId}
              onChange={(e) => setPlanId(e.target.value)}
              aria-label="Plan"
            >
              {plans.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <select
              className={select}
              value={billingPeriod}
              onChange={(e) => setBillingPeriod(e.target.value as 'monthly' | 'annual')}
              aria-label="Billing period"
            >
              <option value="monthly">Monthly</option>
              <option value="annual">Annual</option>
            </select>
            <button
              type="button"
              disabled={pending || !planId}
              onClick={() => {
                setError(null)
                start(async () => {
                  const r = await assignPlan({ tenantId, planId, billingPeriod })
                  if (r.error) setError(r.error)
                  else router.refresh()
                })
              }}
              className="rounded-md border px-3 py-2 text-sm font-medium transition hover:bg-muted disabled:opacity-40"
            >
              {pending ? 'Assigning…' : subscription ? 'Change plan' : 'Assign plan'}
            </button>
          </div>
        )}

        {error && (
          <p className="mt-3 text-sm text-destructive" role="alert">
            {error}
          </p>
        )}

        <p className="mt-3 text-xs text-muted-foreground">
          Assigns the plan directly — no payment is taken and nothing is enforced yet.
        </p>
      </div>
    </section>
  )
}
