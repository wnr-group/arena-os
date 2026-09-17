import { notFound } from 'next/navigation'
import { Building2, Gamepad2, Glasses, Music4, Mic2, Radio, type LucideIcon } from 'lucide-react'
import { currentTenantSlug } from '@/lib/tenant/context'
import { getPublicTenantBySlug } from '@/lib/tenant/public'
import { getPublicBranch } from '@/lib/booking/public-availability'
import { getPublishedBranding } from '@/lib/website/public'
import { accentColorStyle } from '@/lib/website/color'
import { loadRazorpayCredentialsForTenant } from '@/lib/settings/razorpay-credentials'
import { OrderCartProvider } from '@/components/public-booking/OrderCartProvider'
import { OrderNavbar } from '@/components/public-booking/OrderNavbar'
import { PublicFooter } from '@/components/public-booking/PublicFooter'
import { CheckoutClient } from '@/components/public-booking/CheckoutClient'

const INDUSTRY_LABELS: Record<string, string> = {
  gaming_cafe: 'Gaming Cafe',
  recording_studio: 'Recording Studio',
  podcast_studio: 'Podcast Studio',
  dance_studio: 'Dance Studio',
  vr_centre: 'VR Centre',
  other: 'Business',
}

const INDUSTRY_ICONS: Record<string, LucideIcon> = {
  gaming_cafe: Gamepad2,
  recording_studio: Mic2,
  podcast_studio: Radio,
  dance_studio: Music4,
  vr_centre: Glasses,
  other: Building2,
}

/**
 * The standalone checkout page — replaces the old slide-in cart drawer with
 * a dedicated route so reviewing and placing an order gets a full page
 * instead of a cramped overlay. Deliberately carries no station param of its
 * own: the cart AND the "which table/pickup" context both live in
 * OrderCartProvider, hydrated from localStorage on mount, so this page shows
 * the same order regardless of which page (home, /food-menu, /order/[token])
 * the customer built the cart on.
 */
export default async function CheckoutPage() {
  const slug = await currentTenantSlug()
  if (!slug) notFound()
  const tenant = await getPublicTenantBySlug(slug)
  if (!tenant) notFound()

  // Proactive disable, not "attempt then show an error": whether pay-now is
  // even offered on this page is decided here, server-side, from the SAME
  // owner-connection credential loader createOrderPaymentIntent uses to
  // actually call the gateway (lib/settings/razorpay-credentials.ts) — never
  // just the publishable key id, since a configured-but-secretless tenant
  // could still not take a payment.
  //
  // A decryption fault here degrades to "pay-now unavailable", not a broken
  // checkout page — a customer must still be able to place a pay-at-pickup
  // order even if this tenant's stored secret is unusable.
  const [branch, branding, razorpayCredentials] = await Promise.all([
    getPublicBranch(tenant.id),
    getPublishedBranding(tenant.id),
    loadRazorpayCredentialsForTenant(tenant.id).catch((e) => {
      console.error('[checkout] loadRazorpayCredentialsForTenant failed:', e instanceof Error ? e.name : 'unknown')
      return null
    }),
  ])

  const industryLabel = INDUSTRY_LABELS[tenant.industry] ?? 'Business'
  const Icon = INDUSTRY_ICONS[tenant.industry] ?? Building2

  return (
    <div
      className="flex min-h-screen flex-col bg-gradient-to-b from-accent/30 via-background/50 to-background/50 selection:bg-primary/20 selection:text-primary"
      style={accentColorStyle(branding.accentColor)}
    >
      <OrderCartProvider>
        <OrderNavbar tenantName={tenant.name} icon={<Icon size={18} />} logoUrl={branding.logoUrl} />

        <main className="flex-1 bg-gradient-to-b from-accent/40 via-background to-background">
          <CheckoutClient
            currency={tenant.currency}
            venueName={tenant.name}
            razorpayConfigured={razorpayCredentials !== null}
          />
        </main>

        <PublicFooter
          tenantName={tenant.name}
          industryLabel={industryLabel}
          icon={Icon}
          address={branch?.address ?? null}
          phone={branch?.phone ?? null}
        />
      </OrderCartProvider>
    </div>
  )
}
