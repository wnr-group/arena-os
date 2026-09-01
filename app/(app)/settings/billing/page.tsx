import { redirect } from 'next/navigation'
import { getActiveContext } from '@/lib/tenant/context'
import { isOwner } from '@/lib/auth/roles'
import { getBillingPortal } from '@/lib/platform/billing/portal'
import { BillingManager } from '@/components/settings/BillingManager'

/**
 * The owner billing portal (M16 #5) — plan, usage, invoices, upgrade/downgrade,
 * payment method, cancellation.
 *
 * ── This REPLACES /settings/subscription ────────────────────────────────────
 *
 * M16 #3 shipped a minimal /settings/subscription page (plan + buy buttons) and
 * M16 #4 hung the invoice list off it. This page is the full portal that ticket
 * described, so the old route now redirects here rather than existing as a
 * second, poorer billing surface. Two pages that both change a subscription is
 * exactly the duplication this ticket forbids.
 *
 * ── Owner-only, at three layers ─────────────────────────────────────────────
 *
 *   1. the Sidebar entry is gated on isOwner (convenience only);
 *   2. this redirect (presentation — it stops a manager RENDERING the page);
 *   3. requireOwner() inside every action in lib/actions/subscription.ts, and
 *      `platform_invoices_owner_select` / `tenant_subscriptions_select` in RLS.
 *
 * Only (3) is the boundary. A manager who POSTs directly to changeSubscriptionPlan()
 * is refused by the action, and getBillingPortal() runs through withUser() on
 * the restricted role, so even a bypassed redirect renders nothing it should not.
 */
export default async function BillingSettingsPage() {
  const ctx = await getActiveContext()
  if (!ctx) return null
  if (!isOwner(ctx.role)) redirect('/dashboard')

  const portal = await getBillingPortal(ctx)

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <h1 className="text-2xl font-semibold">Billing</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        What {ctx.tenant.name} pays Arena OS — your plan, what it includes, and your invoices.
      </p>

      <BillingManager
        subscription={
          portal.subscription && {
            planName: portal.subscription.planName,
            billingPeriod: portal.subscription.billingPeriod,
            status: portal.subscription.status,
            // Serialised for the client boundary; the component formats them.
            currentPeriodStart: portal.subscription.currentPeriodStart.toISOString(),
            currentPeriodEnd: portal.subscription.currentPeriodEnd.toISOString(),
            cancelAtPeriodEnd: portal.subscription.cancelAtPeriodEnd,
            gatewaySubscriptionId: portal.subscription.gatewaySubscriptionId,
            lapsed: portal.subscription.lapsed,
          }
        }
        // The arrears state (AROS-113). Separate from `subscription` because a
        // suspended or cancelled subscription is not live, so that prop is null
        // exactly when the owner most needs to be told what happened.
        dunning={
          portal.dunning && {
            state: portal.dunning.state,
            graceEndsAt: portal.dunning.graceEndsAt.toISOString(),
            cancelsAt: portal.dunning.cancelsAt?.toISOString() ?? null,
            reason: portal.dunning.reason,
          }
        }
        // From readEntitlements(), so it is null exactly when the app treats the
        // tenant as unentitled — which is what lets the UI say "lapsed" instead
        // of showing a plan that grants nothing.
        planName={portal.planName}
        currentPrice={portal.currentPrice}
        currency={portal.currency}
        limits={portal.limits}
        modules={portal.modules}
        plans={portal.plans}
        invoices={portal.invoices.map((i) => ({
          ...i,
          billingPeriodStart: i.billingPeriodStart.toISOString(),
          billingPeriodEnd: i.billingPeriodEnd.toISOString(),
        }))}
      />
    </div>
  )
}
