import { notFound } from 'next/navigation'
import { Building2, Gamepad2, Glasses, Music4, Mic2, Radio, type LucideIcon } from 'lucide-react'
import { currentTenantSlug } from '@/lib/tenant/context'
import { getPublicTenantBySlug } from '@/lib/tenant/public'
import { getPublicBranch, getPublicResourceType } from '@/lib/booking/public-availability'
import { todayInZone } from '@/lib/booking/time'
import { getPublicMenu } from '@/lib/menu/public'
import { getPublishedBranding } from '@/lib/website/public'
import { accentColorStyle } from '@/lib/website/color'
import { ResourceTypeBookingPage } from '@/components/public-booking/ResourceTypeBookingPage'
import { SitePageShell } from '@/components/public-booking/SitePageShell'
import { PublicFooter } from '@/components/public-booking/PublicFooter'

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
 * The public, no-login checkout for a resource TYPE ("PS5 Station") rather
 * than one specific unit — whichever unit is free for the picked slot gets
 * assigned automatically, so the customer never has to choose between
 * identical-looking units themselves. Tenant is resolved from the subdomain
 * the same way app/(public)/book/[resourceId]/page.tsx does.
 */
export default async function ResourceTypeBookPage({
  params,
}: {
  params: Promise<{ resourceTypeId: string }>
}) {
  const { resourceTypeId } = await params
  if (!UUID.test(resourceTypeId)) notFound()

  const slug = await currentTenantSlug()
  if (!slug) notFound()
  const tenant = await getPublicTenantBySlug(slug)
  if (!tenant) notFound()

  const resourceType = await getPublicResourceType(tenant.id, resourceTypeId)
  if (!resourceType) notFound()

  const branch = await getPublicBranch(tenant.id)
  const branding = await getPublishedBranding(tenant.id)
  const hasMenu = (await getPublicMenu(tenant.id)).some((c) => c.items.length > 0)
  const industryLabel = INDUSTRY_LABELS[tenant.industry] ?? 'Business'
  const Icon = INDUSTRY_ICONS[tenant.industry] ?? Building2

  return (
    <div className="flex min-h-screen flex-col" style={accentColorStyle(branding.accentColor)}>
      <SitePageShell
        tenantName={tenant.name}
        icon={<Icon size={18} />}
        logoUrl={branding.logoUrl}
        currency={tenant.currency}
        hasMenu={hasMenu}
      >
        <main className="flex-1 bg-background">
          <ResourceTypeBookingPage tenant={tenant} resourceType={resourceType} today={todayInZone(tenant.timezone)} />
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
