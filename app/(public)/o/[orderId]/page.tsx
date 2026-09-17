import { notFound } from 'next/navigation'
import { Building2, Gamepad2, Glasses, Music4, Mic2, Radio, type LucideIcon } from 'lucide-react'
import { currentTenantSlug } from '@/lib/tenant/context'
import { getPublicTenantBySlug } from '@/lib/tenant/public'
import { getPublicBranch } from '@/lib/booking/public-availability'
import { getPublicOrderStatus } from '@/lib/orders/public-status'
import { getPublicMenu } from '@/lib/menu/public'
import { getPublishedBranding } from '@/lib/website/public'
import { accentColorStyle } from '@/lib/website/color'
import { SitePageShell } from '@/components/public-booking/SitePageShell'
import { PublicFooter } from '@/components/public-booking/PublicFooter'
import { OrderStatusTracker } from '@/components/public-booking/OrderStatusTracker'

/** Matches a UUID, so a junk id 404s instead of erroring in the query. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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
 * The public, no-login order status page (M14 #7, v2) — where a customer
 * lands right after placing (or paying for) an online order, and can come
 * back to at any time. Keyed by orders.id, NOT orderNumber: same reason as
 * /b/[token] (see 0026_booking_confirmation_token.sql) — a sequential number
 * is guessable, this id isn't. No dedicated confirmation-token column was
 * added for orders — orders.id is already the same entropy class, and is
 * exactly what order_items_public_select's own trust model already assumes
 * callers use (see lib/orders/public-status.ts's doc comment).
 */
export default async function OrderStatusPage({ params }: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await params
  if (!UUID.test(orderId)) notFound()

  const slug = await currentTenantSlug()
  if (!slug) notFound()
  const tenant = await getPublicTenantBySlug(slug)
  if (!tenant) notFound()

  const order = await getPublicOrderStatus(tenant.id, orderId)
  if (!order) notFound()

  const branch = await getPublicBranch(tenant.id)
  const branding = await getPublishedBranding(tenant.id)
  const hasMenu = (await getPublicMenu(tenant.id)).some((c) => c.items.length > 0)

  const industryLabel = INDUSTRY_LABELS[tenant.industry] ?? 'Business'
  const Icon = INDUSTRY_ICONS[tenant.industry] ?? Building2

  return (
    <div className="flex min-h-screen flex-col" style={accentColorStyle(branding.accentColor)}>
      <SitePageShell tenantName={tenant.name} icon={<Icon size={18} />} logoUrl={branding.logoUrl} hasMenu={hasMenu}>
        <main className="flex-1 bg-gradient-to-b from-accent/60 via-background to-background">
          <OrderStatusTracker order={order} currency={tenant.currency} />
        </main>

        <PublicFooter
          tenantName={tenant.name}
          industryLabel={industryLabel}
          icon={Icon}
          address={branch?.address ?? null}
          phone={branch?.phone ?? null}
        />
      </SitePageShell>
    </div>
  )
}
