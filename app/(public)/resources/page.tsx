import { notFound } from 'next/navigation'
import { Building2, Boxes, Gamepad2, Glasses, Music4, Mic2, Radio, UtensilsCrossed, type LucideIcon } from 'lucide-react'
import { currentTenantSlug } from '@/lib/tenant/context'
import { getPublicTenantBySlug } from '@/lib/tenant/public'
import { getPublicBranch, getPublicResourceTypes } from '@/lib/booking/public-availability'
import { getPublicMenu } from '@/lib/menu/public'
import { getPublishedBranding } from '@/lib/website/public'
import { accentColorStyle } from '@/lib/website/color'
import { SitePageShell } from '@/components/public-booking/SitePageShell'
import { PublicFooter } from '@/components/public-booking/PublicFooter'
import { ResourceTypeCard } from '@/components/public-booking/ResourceTypeCard'

const INDUSTRY_LABELS: Record<string, string> = {
  gaming_cafe: 'Gaming Cafe',
  recording_studio: 'Recording Studio',
  podcast_studio: 'Podcast Studio',
  dance_studio: 'Dance Studio',
  vr_centre: 'VR Centre',
  restaurant: 'Restaurant',
  other: 'Business',
}

const INDUSTRY_ICONS: Record<string, LucideIcon> = {
  gaming_cafe: Gamepad2,
  recording_studio: Mic2,
  podcast_studio: Radio,
  dance_studio: Music4,
  vr_centre: Glasses,
  restaurant: UtensilsCrossed,
  other: Building2,
}

/**
 * The tenant's public, no-login "what we offer" page — every bookable
 * resource type at its primary branch, laid out as a browsable card grid.
 * Tenant is resolved from the subdomain the same way app/page.tsx does,
 * since app/(public)/layout.tsx can't hand computed props down to a page.
 */
export default async function ResourcesPage() {
  const slug = await currentTenantSlug()
  if (!slug) notFound()
  const tenant = await getPublicTenantBySlug(slug)
  if (!tenant) notFound()

  const branch = await getPublicBranch(tenant.id)
  const resourceTypes = branch ? await getPublicResourceTypes(tenant.id, branch.id) : []
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
        hasMenu={hasMenu}
      >
        <main className="flex-1 bg-background">
          <section className="relative overflow-hidden border-b border-border bg-gradient-to-b from-primary/5 to-transparent">
            <div
              aria-hidden
              className="pointer-events-none absolute left-1/2 top-0 h-72 w-[640px] -translate-x-1/2 -translate-y-1/3 rounded-full bg-primary/10 blur-[110px]"
            />
            <div className="relative mx-auto max-w-3xl px-4 py-16 text-center sm:px-6 sm:py-24">
              <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3.5 py-1.5 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                <Boxes size={13} className="text-primary" /> What we offer
              </span>
              <h1 className="mt-6 text-4xl font-extrabold tracking-tight sm:text-5xl">
                <span className="bg-gradient-to-r from-foreground to-muted-foreground/80 bg-clip-text text-transparent">
                  Explore our{' '}
                </span>
                <span className="bg-gradient-to-r from-primary to-primary-hover bg-clip-text text-transparent">spaces</span>
              </h1>
              <p className="mx-auto mt-4 max-w-xl text-lg leading-relaxed text-muted-foreground sm:text-xl">
                Browse everything <span className="font-semibold text-foreground">{tenant.name}</span> has to book —
                pick one to reserve your slot.
              </p>
            </div>
          </section>

          <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
            {resourceTypes.length === 0 ? (
              <div className="py-16 text-center">
                <p className="text-lg text-muted-foreground">Online booking isn&apos;t set up for this venue yet.</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {resourceTypes.map((type) => (
                  <ResourceTypeCard key={type.id} type={type} currency={tenant.currency} />
                ))}
              </div>
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
      </SitePageShell>
    </div>
  )
}
