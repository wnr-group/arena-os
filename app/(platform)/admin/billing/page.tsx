import { getCurrentUser } from '@/lib/auth/session'
import { requirePlatformAdmin } from '@/lib/platform/guard'
import { getPlatformGatewayView } from '@/lib/platform/billing/credentials'
import { rootDomain } from '@/lib/tenant/subdomain'
import { readPlatformBillingProfile } from '@/lib/actions/platform-gateway'
import { PlatformGatewayForm } from '@/components/platform/PlatformGatewayForm'
import { PlatformBillingProfileForm } from '@/components/platform/PlatformBillingProfileForm'

/**
 * The platform's own Razorpay account (M16 #3).
 *
 * Same guard shape as AdminPlansPage: the layout renders the "platform admins
 * only" screen, and the early return keeps a non-admin's request from fetching
 * anything into its RSC payload. requirePlatformAdmin() below is the ACTUAL
 * boundary — a page-only check would leak into the payload of any signed-in
 * user who guessed the URL.
 *
 * getPlatformGatewayView() returns a key id and two booleans. No ciphertext is
 * selected out of Postgres at all, so no secret can reach this render even in
 * principle.
 */
export default async function PlatformBillingPage() {
  const user = await getCurrentUser()
  if (!user?.isPlatformAdmin) return null

  await requirePlatformAdmin()
  const settings = await getPlatformGatewayView()
  // The GST letterhead (M16 #4). Nothing secret in it — it is printed on every
  // invoice — so unlike the gateway view above it is returned in full.
  const profile = await readPlatformBillingProfile()

  const protocol = process.env.NODE_ENV === 'production' ? 'https' : 'http'

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-2xl font-semibold">Subscription billing</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Arena OS&rsquo;s own Razorpay account — the one that charges businesses for their
        subscription. This is <strong>not</strong> a venue&rsquo;s gateway: each business
        configures its own keys under Settings → Payments to collect booking deposits from its
        customers, and those keys are never used here.
      </p>

      <PlatformGatewayForm
        razorpayKeyId={settings.razorpayKeyId ?? ''}
        hasSecret={settings.hasSecret}
        hasWebhookSecret={settings.hasWebhookSecret}
        // The root domain, deliberately — there is no tenant subdomain on this
        // webhook, because there is one platform account for every tenant.
        webhookUrl={`${protocol}://${rootDomain()}/api/webhooks/platform-razorpay`}
      />

      <PlatformBillingProfileForm
        profile={{
          sellerLegalName: profile?.sellerLegalName ?? '',
          sellerGstin: profile?.sellerGstin ?? '',
          sellerAddress: profile?.sellerAddress ?? '',
          sellerStateCode: profile?.sellerStateCode ?? '',
          // The column defaults, so an unconfigured install shows the values it
          // would actually bill with rather than empty boxes.
          gstRate: profile?.gstRate ?? '18.00',
          invoicePrefix: profile?.invoicePrefix ?? 'AOS',
          creditNotePrefix: profile?.creditNotePrefix ?? 'AOC',
        }}
      />
    </div>
  )
}
