import { Building2, Gamepad2, Glasses, Music4, Mic2, Radio, UtensilsCrossed, type LucideIcon } from 'lucide-react'
import type { PublicTenant } from '@/lib/tenant/public'
import { getPublicBranch, getPublicResourceTypes } from '@/lib/booking/public-availability'
import { getPublicMenu } from '@/lib/menu/public'
import { getPublicActiveHappyHourRules } from '@/lib/happy-hours/public'
import { applyHappyHour } from '@/lib/happy-hours/apply'
import { getPublishedWebsite, getPublishedBranding } from '@/lib/website/public'
import { accentColorStyle } from '@/lib/website/color'
import { publicSiteFont } from '@/lib/fonts'
import { WebsitePage } from '@/components/public-booking/website/WebsitePage'
import { PublicNavbar } from '@/components/public-booking/PublicNavbar'
import { PublicFooter } from '@/components/public-booking/PublicFooter'
import { OrderCartProvider } from '@/components/public-booking/OrderCartProvider'
import { OrderNavbar } from '@/components/public-booking/OrderNavbar'
import { MenuHighlightsClient } from '@/components/public-booking/MenuHighlightsClient'

const MENU_HIGHLIGHT_LIMIT = 8

export const INDUSTRY_LABELS: Record<string, string> = {
  gaming_cafe: 'Gaming Cafe',
  recording_studio: 'Recording Studio',
  podcast_studio: 'Podcast Studio',
  dance_studio: 'Dance Studio',
  vr_centre: 'VR Centre',
  restaurant: 'Restaurant',
  other: 'Business',
}

export const INDUSTRY_ICONS: Record<string, LucideIcon> = {
  gaming_cafe: Gamepad2,
  recording_studio: Mic2,
  podcast_studio: Radio,
  dance_studio: Music4,
  vr_centre: Glasses,
  restaurant: UtensilsCrossed,
  other: Building2,
}

/**
 * The tenant's public-facing homepage — served at "/" on a tenant subdomain
 * (and, via a redirect, at the legacy /book path). No session required.
 */
export async function TenantHome({ tenant }: { tenant: PublicTenant }) {
  const branch = await getPublicBranch(tenant.id)
  const resourceTypes = branch ? await getPublicResourceTypes(tenant.id, branch.id) : []
  const open = branch !== null && resourceTypes.length > 0

  const industryLabel = INDUSTRY_LABELS[tenant.industry] ?? 'Business'
  const Icon = INDUSTRY_ICONS[tenant.industry] ?? Building2
  // Restaurant tenants order dine-in via the table QR flow, not a
  // "browse the menu" entry point off the public homepage — the homepage
  // itself is enough for them, so neither the navbar's Menu link nor a
  // Menu Highlights section belongs here. Every other industry keeps both.
  const isRestaurant = tenant.industry === 'restaurant'

  // A business that has published its own homepage (M13) gets that instead of
  // the default below. Every tenant that hasn't touched the builder yet — i.e.
  // everyone, until AROS-C/E ship — falls straight through unchanged.
  const website = await getPublishedWebsite(tenant.id)
  if (website) {
    return (
      <WebsitePage
        tenantName={tenant.name}
        icon={<Icon size={18} />}
        sections={website.sections}
        settings={website.settings}
        tenantId={tenant.id}
        branch={branch}
        currency={tenant.currency}
        timezone={tenant.timezone}
        isRestaurant={isRestaurant}
        footer={
          <PublicFooter
            tenantName={tenant.name}
            industryLabel={industryLabel}
            icon={Icon}
            address={branch?.address ?? null}
            phone={branch?.phone ?? null}
          />
        }
      />
    )
  }

  const branding = await getPublishedBranding(tenant.id)

  const [menu, happyHourRules] = await Promise.all([getPublicMenu(tenant.id), getPublicActiveHappyHourRules(tenant.id)])
  const now = new Date()
  const menuHighlights = menu
    .flatMap((c) => c.items)
    .slice(0, MENU_HIGHLIGHT_LIMIT)
    .map((item) => {
      const applied = item.available ? applyHappyHour(Number(item.price), happyHourRules, now, tenant.timezone) : null
      return { ...item, discountedPrice: applied ? applied.unitPrice.toFixed(2) : null }
    })
  const hasMenu = menuHighlights.length > 0 && !isRestaurant

  return (
    <div className={`flex min-h-screen flex-col ${publicSiteFont.className}`} style={accentColorStyle(branding.accentColor)}>
      <OrderCartProvider>
        {hasMenu ? (
          <OrderNavbar tenantName={tenant.name} icon={<Icon size={18} />} logoUrl={branding.logoUrl} showMenuLink={!isRestaurant} />
        ) : (
          <PublicNavbar tenantName={tenant.name} icon={<Icon size={18} />} logoUrl={branding.logoUrl} showMenuLink={!isRestaurant} />
        )}

        <main className="flex-1">
          <section id="home" className="scroll-mt-16 bg-gradient-to-b from-primary/5 to-transparent">
            <div className="mx-auto max-w-5xl px-4 py-14 text-center sm:px-6 sm:py-20">
              <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3.5 py-1.5 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                <Icon size={13} className="text-primary" /> {industryLabel}
              </span>
              <h1 className="mt-5 text-4xl font-extrabold tracking-tight sm:text-6xl">{tenant.name}</h1>
              <p className="mx-auto mt-4 max-w-2xl text-lg text-muted-foreground sm:text-xl leading-relaxed">
                Reserve your spot in seconds — pick what you want, find a time, and you&apos;re in.
              </p>
              {open && (
                <div className="mt-8 flex flex-wrap items-center justify-center gap-4">
                  <a
                    href="/resources"
                    className="inline-flex items-center justify-center rounded-xl bg-primary px-7 py-3.5 text-base font-bold text-primary-foreground shadow-lg shadow-primary/20 transition hover:-translate-y-0.5 active:translate-y-0 hover:shadow-primary/30"
                  >
                    Book Now
                  </a>
                </div>
              )}
            </div>
          </section>

          <section id="about" className="scroll-mt-16 bg-card/40">
            <div className="mx-auto max-w-3xl px-4 py-14 text-center sm:px-6">
              <h2 className="text-3xl font-extrabold tracking-tight sm:text-4xl">About {tenant.name}</h2>
              <p className="mx-auto mt-4 max-w-2xl text-base text-muted-foreground sm:text-lg leading-relaxed">
                We&apos;re a {industryLabel.toLowerCase()} open for walk-ins and online bookings alike. Reserve ahead
                so your spot is guaranteed when you arrive.
              </p>
              {branch?.address && <p className="mt-4 text-sm font-medium text-muted-foreground/80">{branch.address}</p>}
            </div>
          </section>

          {hasMenu && (
            <section id="menu" className="scroll-mt-16 bg-card/40">
              <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
                <div className="mx-auto max-w-2xl text-center">
                  <h2 className="text-3xl font-extrabold tracking-tight sm:text-4xl">From the Menu</h2>
                  <p className="mx-auto mt-3 max-w-xl text-base text-muted-foreground sm:text-lg leading-relaxed">
                    Add what you like and check out — no table needed.
                  </p>
                </div>
                <div className="mt-10">
                  <MenuHighlightsClient items={menuHighlights} currency={tenant.currency} />
                </div>
                <p className="mt-8 text-center">
                  <a href="/food-menu" className="text-sm font-medium text-primary hover:underline">
                    View full menu &rarr;
                  </a>
                </p>
              </div>
            </section>
          )}
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
