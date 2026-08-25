import { notFound } from 'next/navigation'
import { Building2, Gamepad2, Glasses, Music4, Mic2, Radio, UtensilsCrossed, type LucideIcon, MapPin } from 'lucide-react'
import { currentTenantSlug } from '@/lib/tenant/context'
import { getPublicTenantBySlug } from '@/lib/tenant/public'
import { getPublicBranch, getPublicStation } from '@/lib/booking/public-availability'
import { getPublicMenu } from '@/lib/menu/public'
import { getPublishedBranding } from '@/lib/website/public'
import { accentColorStyle } from '@/lib/website/color'
import { PublicNavbar } from '@/components/public-booking/PublicNavbar'
import { PublicFooter } from '@/components/public-booking/PublicFooter'
import { FoodMenuClient } from '@/components/public-booking/FoodMenuClient'

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
 * The QR-at-station entry point (M14 #2) — scanning a resource's printed QR
 * lands here. Resolves the station token to its resource + active booking
 * (getPublicStation), then renders the same read-only menu as /food-menu,
 * scoped with a station banner. Reuses FoodMenuClient as-is: an actual
 * cart/place-order flow is a later story, this is only the entry point that
 * proves token -> station (+ booking) attribution resolves correctly.
 */
export default async function StationOrderPage({ params }: { params: Promise<{ stationToken: string }> }) {
  const { stationToken } = await params
  const slug = await currentTenantSlug()
  if (!slug) notFound()
  const tenant = await getPublicTenantBySlug(slug)
  if (!tenant) notFound()

  const station = await getPublicStation(tenant.id, stationToken)
  if (!station) notFound()

  const [branch, categories, branding] = await Promise.all([
    getPublicBranch(tenant.id),
    getPublicMenu(tenant.id),
    getPublishedBranding(tenant.id),
  ])

  const industryLabel = INDUSTRY_LABELS[tenant.industry] ?? 'Business'
  const Icon = INDUSTRY_ICONS[tenant.industry] ?? Building2

  return (
    <div
      className="flex min-h-screen flex-col bg-background/50 selection:bg-primary/20 selection:text-primary"
      style={accentColorStyle(branding.accentColor)}
    >
      <PublicNavbar tenantName={tenant.name} icon={<Icon size={18} />} logoUrl={branding.logoUrl} />

      <main className="flex-1 bg-background relative">
        <section className="relative overflow-hidden bg-gradient-to-b from-primary/5 via-transparent to-transparent">
          <div className="relative mx-auto max-w-4xl px-4 py-14 text-center sm:px-6 sm:py-20">
            <span className="inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/5 px-4 py-2 text-xs font-bold uppercase tracking-wider text-primary shadow-sm shadow-primary/10 backdrop-blur-md">
              <MapPin size={12} /> Ordering for {station.resource.name}
            </span>
            <h1 className="mt-8 text-3xl font-black tracking-tight sm:text-5xl">
              <span className="bg-gradient-to-r from-foreground via-foreground to-muted-foreground/70 bg-clip-text text-transparent">
                What would you like<br />from {tenant.name}?
              </span>
            </h1>
            {station.bookingId && (
              <p className="mx-auto mt-6 max-w-xl text-sm leading-relaxed text-muted-foreground">
                This order will be linked to your current booking at this station.
              </p>
            )}
          </div>
        </section>

        <div className="relative z-10 mx-auto max-w-6xl px-4 py-12 sm:px-6 lg:py-16">
          {categories.length === 0 ? (
            <div className="py-20 text-center rounded-3xl border border-dashed border-border bg-card/40 backdrop-blur-sm shadow-inner max-w-xl mx-auto">
              <UtensilsCrossed className="mx-auto h-16 w-16 text-muted-foreground/30" />
              <h3 className="mt-4 text-xl font-bold text-foreground">Menu is Offline</h3>
              <p className="mt-2 text-sm text-muted-foreground max-w-xs mx-auto">
                We are currently updating our offerings. Check back soon to explore our delicious options!
              </p>
            </div>
          ) : (
            <FoodMenuClient categories={categories} tenant={tenant} />
          )}
        </div>
      </main>

      <PublicFooter
        tenantName={tenant.name}
        industryLabel={industryLabel}
        icon={Icon}
        address={branch?.address ?? null}
        phone={branch?.phone ?? null}
      />
    </div>
  )
}
