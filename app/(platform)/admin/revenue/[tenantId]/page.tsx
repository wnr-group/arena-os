import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { getCurrentUser } from '@/lib/auth/session'
import { getTenantBillingDetail } from '@/lib/platform/billing/tenant-detail'
import { TenantBillingPanel } from '@/components/platform/TenantBillingPanel'

/**
 * THE TENANT BILLING DRILL-DOWN (AROS-114 §7).
 *
 * Everything about one business's billing, plus the five manual overrides.
 *
 * ── Authorization ──────────────────────────────────────────────────────────
 *
 * The early return keeps a non-admin's request from fetching anything into its
 * RSC payload; getTenantBillingDetail() enforces requirePlatformAdmin() itself
 * and is the actual boundary; and every override the panel below can invoke
 * re-checks it a third time inside the server action, because a server action
 * is a public endpoint and a page guard does not protect it.
 *
 * ── Why this is not folded into /admin/companies/[id] ──────────────────────
 *
 * That page is the COMPANY record — identity, members, status — and already
 * carries a SubscriptionPanel for assigning a plan. This one is the money:
 * invoices, refunds, credits, arrears clocks and the billing audit trail. They
 * are linked in both directions rather than merged, so neither becomes a page
 * an operator has to scroll past to reach the other.
 */
export default async function TenantBillingPage({
  params,
}: {
  params: Promise<{ tenantId: string }>
}) {
  const user = await getCurrentUser()
  if (!user?.isPlatformAdmin) return null

  const { tenantId } = await params
  const detail = await getTenantBillingDetail(tenantId)
  if (!detail) notFound()

  return (
    <div>
      <Link
        href="/admin/revenue"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft size={14} /> Platform billing
      </Link>

      <div className="mt-3 flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold">{detail.tenant.name}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {detail.tenant.slug} · account {detail.tenant.status}
          </p>
        </div>
        <Link
          href={`/admin/companies/${detail.tenant.id}`}
          className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
        >
          Company record
        </Link>
      </div>

      <TenantBillingPanel
        tenantId={detail.tenant.id}
        subscription={
          detail.subscription && {
            ...detail.subscription,
            // Serialised across the client boundary; the component formats them.
            currentPeriodStart: detail.subscription.currentPeriodStart.toISOString(),
            currentPeriodEnd: detail.subscription.currentPeriodEnd.toISOString(),
            pastDueSince: detail.subscription.pastDueSince?.toISOString() ?? null,
            suspendedAt: detail.subscription.suspendedAt?.toISOString() ?? null,
            lastPaymentFailureAt:
              detail.subscription.lastPaymentFailureAt?.toISOString() ?? null,
            graceEndsAt: detail.subscription.graceEndsAt?.toISOString() ?? null,
            cancelsAt: detail.subscription.cancelsAt?.toISOString() ?? null,
          }
        }
        invoices={detail.invoices.map((i) => ({
          ...i,
          billingPeriodStart: i.billingPeriodStart.toISOString(),
          billingPeriodEnd: i.billingPeriodEnd.toISOString(),
        }))}
        refunds={detail.refunds.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }))}
        history={detail.history.map((h) => ({
          id: h.id,
          action: h.action,
          createdAt: h.createdAt.toISOString(),
          actorEmail: h.actorEmail,
          // Only a summary line reaches the browser, not the whole payload —
          // an audit entry's `before`/`after` can name plans, prices and
          // reasons, and there is no need to ship all of it to render a row.
          summary: summarise(h.action, h.after),
        }))}
        catalogue={detail.catalogue}
      />
    </div>
  )
}

/** One readable line per audit entry. Server-side, so the payload stays small. */
function summarise(action: string, after: Record<string, unknown> | null): string {
  if (!after) return ''
  const s = (k: string) => (typeof after[k] === 'string' ? (after[k] as string) : null)
  const n = (k: string) => (typeof after[k] === 'number' ? (after[k] as number) : null)

  switch (action) {
    case 'change_plan':
      return `→ ${s('planName') ?? 'plan'} (${s('billingPeriod') ?? ''} ${s('status') ?? ''})`.trim()
    case 'extend_trial':
      return `+${n('days') ?? '?'} days`
    case 'comp_or_discount':
      return `${s('creditNoteNumber') ?? 'credit note'} · ${n('amount') ?? ''} · applies to next invoice`
    case 'refund':
      return `${n('amount') ?? ''} · ${s('status') ?? 'pending'}`
    case 'force_cancel':
      return after.atPeriodEnd ? 'at period end' : 'immediate'
    default:
      // The AROS-113 lifecycle entries: subscription.<status>.
      return s('source') ? `via ${s('source')}` : ''
  }
}
