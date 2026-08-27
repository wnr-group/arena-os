import { notFound } from 'next/navigation'
import { Building2, Gamepad2, Glasses, Music4, Mic2, Radio, type LucideIcon } from 'lucide-react'
import { currentTenantSlug } from '@/lib/tenant/context'
import { getPublicTenantBySlug } from '@/lib/tenant/public'
import { getPublicBranch } from '@/lib/booking/public-availability'
import { getPublicMenu } from '@/lib/menu/public'
import { getPublishedBranding } from '@/lib/website/public'
import { accentColorStyle } from '@/lib/website/color'
import { SitePageShell } from '@/components/public-booking/SitePageShell'
import { PublicFooter } from '@/components/public-booking/PublicFooter'
import { MyBookingsClient } from '@/components/public-booking/MyBookingsClient'

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
 * "My Booking" — the site header's phone-lookup hub (M14 #7, v2 follow-up,
 * extended to also surface device bookings). Reached from PublicNavbar's
 * "My Booking" button. See MyBookingsClient and lookupMyBookings for what
 * this deliberately does and doesn't reveal.
 */
export default async function MyBookingsPage() {
  const slug = await currentTenantSlug()
  if (!slug) notFound()
  const tenant = await getPublicTenantBySlug(slug)
  if (!tenant) notFound()

  const branch = await getPublicBranch(tenant.id)
  const branding = await getPublishedBranding(tenant.id)
  const hasMenu = (await getPublicMenu(tenant.id)).some((c) => c.items.length > 0)

  const industryLabel = INDUSTRY_LABELS[tenant.industry] ?? 'Business'
  const Icon = INDUSTRY_ICONS[tenant.industry] ?? Building2

  return (
    <div className="flex min-h-screen flex-col" style={accentColorStyle(branding.accentColor)}>
      <SitePageShell tenantName={tenant.name} icon={<Icon size={18} />} logoUrl={branding.logoUrl} hasMenu={hasMenu}>
        <main className="flex-1 bg-background">
          <MyBookingsClient timezone={tenant.timezone} />
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
