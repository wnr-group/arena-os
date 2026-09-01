import Link from 'next/link'
import { getCurrentUser } from '@/lib/auth/session'
import { requirePlatformAdmin } from '@/lib/platform/guard'
import {
  defaultBucketFor,
  getPlatformBillingDashboard,
  type RevenueBucket,
} from '@/lib/platform/billing/metrics'
import { PLATFORM_TIMEZONE } from '@/lib/platform/billing/invoices'
import { daysInRange, resolveDateRange } from '@/lib/reports/date-range'
import { BillingDashboard } from '@/components/platform/BillingDashboard'

/**
 * THE PLATFORM BILLING DASHBOARD (AROS-114 §2).
 *
 * ── Why /admin/revenue and not /admin/billing ───────────────────────────────
 *
 * `/admin/billing` already exists and is the platform's own Razorpay ACCOUNT
 * SETTINGS — the gateway keys and the GST letterhead (M16 #3, #4). Two pages
 * called "billing" in one admin, one of which is a config form and one a
 * revenue report, is a navigation problem an operator would hit on their first
 * day. This is the money, so it is "Revenue".
 *
 * ── Authorization, in the two places that matter ────────────────────────────
 *
 * The `(platform)/admin` layout renders the "platform administrators only"
 * screen for a signed-in non-admin, and the early return below stops their
 * request fetching anything into its RSC payload. Neither is the boundary:
 * requirePlatformAdmin() inside getPlatformBillingDashboard() is, and it runs
 * on every call regardless of what any page does — the rule every reader in
 * lib/platform/ follows. A page-only guard would leak the platform's entire
 * revenue picture to anyone who guessed the URL.
 *
 * ── The range is EXPLICIT ───────────────────────────────────────────────────
 *
 * `?from=&to=&bucket=` on the URL, resolved by the SAME lib/reports/date-range
 * helper the tenant reports use — so a platform range behaves exactly like a
 * venue's (inclusive both ends, reversed ranges collapse, over-long ranges
 * clamp) and there is one date contract in this codebase, not two.
 *
 * Resolved in the SUPPLIER's timezone (Asia/Kolkata, PLATFORM_TIMEZONE), not
 * the server's and not a tenant's: Arena OS is the supplier for every figure on
 * this page, and its financial year is what the invoice numbering already runs
 * on.
 */
export default async function PlatformRevenuePage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; bucket?: string }>
}) {
  const user = await getCurrentUser()
  if (!user?.isPlatformAdmin) return null

  await requirePlatformAdmin()

  const params = await searchParams
  const range = resolveDateRange(
    { start: params.from, end: params.to },
    { timeZone: PLATFORM_TIMEZONE, defaultDays: 90 },
  )

  const days = daysInRange(range)
  // An explicit ?bucket= always wins; otherwise the default keeps a chart
  // readable — 366 daily bars is not a chart, it is a texture.
  const requested = params.bucket
  const bucket: RevenueBucket =
    requested === 'day' || requested === 'week' || requested === 'month'
      ? requested
      : defaultBucketFor(range, days)

  const data = await getPlatformBillingDashboard({ range, bucket })

  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold">Platform billing</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            What every business pays Arena OS — recurring revenue, subscription mix, churn and
            collections. Figures are in the supplier&rsquo;s timezone ({PLATFORM_TIMEZONE}).
          </p>
        </div>
        <Link
          href="/admin/billing"
          className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
        >
          Gateway settings
        </Link>
      </div>

      <BillingDashboard
        basePath="/admin/revenue"
        range={range}
        bucket={bucket}
        headline={data.headline}
        mrr={data.mrr}
        mix={data.mix}
        churn={data.churn}
        revenue={data.revenue}
        revenueTotals={data.revenueTotals}
        tenants={data.tenants.map((t) => ({
          ...t,
          // Serialised for the client boundary; the component formats them.
          currentPeriodEnd: t.currentPeriodEnd?.toISOString() ?? null,
        }))}
      />
    </div>
  )
}
