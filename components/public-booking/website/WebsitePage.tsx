import type { ReactNode } from 'react'
import type { WebsiteSection, WebsiteBranding } from '@/lib/website/types'
import type { PublicBranch } from '@/lib/booking/public-availability'
import { accentColorStyle } from '@/lib/website/color'
import { publicSiteFont } from '@/lib/fonts'
import { PublicNavbar } from '@/components/public-booking/PublicNavbar'
import { OrderCartProvider } from '@/components/public-booking/OrderCartProvider'
import { OrderNavbar } from '@/components/public-booking/OrderNavbar'
import { WebsiteSections } from './WebsiteSections'

/**
 * The branding + section-stack shell shared by the live public homepage
 * (TenantHome) and the staff-only preview page — so "preview" is structurally
 * the same render path a customer gets, not just a promise.
 */
export function WebsitePage({
  tenantName,
  icon,
  sections,
  settings,
  footer,
  navTopOffset,
  tenantId,
  branch,
  currency,
  timezone,
  isRestaurant = false,
}: {
  tenantName: string
  icon: ReactNode
  sections: WebsiteSection[]
  settings: WebsiteBranding
  footer?: ReactNode
  /** Pixels to stick the navbar below instead of the viewport top — e.g. the staff preview banner above it. */
  navTopOffset?: number
  /** Needed by the dynamic sections (resources/menu/hours/map) to fetch their own live data. */
  tenantId: string
  branch: PublicBranch | null
  currency: string
  timezone: string
  /** A restaurant tenant orders dine-in via the table QR flow, not a 'menu'
   *  website-builder section — hides that section and the navbar's Menu
   *  link even if the operator added one, same as TenantHome's default
   *  (non-website-builder) homepage. */
  isRestaurant?: boolean
}) {
  // Only a 'menu' section makes ordering meaningful here — other industries
  // (gaming cafes, studios, ...) never see a cart button. A restaurant tenant
  // never gets the cart-aware navbar either, whatever sections it added.
  const hasMenu = !isRestaurant && sections.some((s) => s.type === 'menu')

  return (
    <div
      className={`flex min-h-screen flex-col ${publicSiteFont.className}`}
      style={accentColorStyle(settings.accentColor)}
    >
      <OrderCartProvider>
        {hasMenu ? (
          <OrderNavbar tenantName={tenantName} icon={icon} logoUrl={settings.logoUrl} topOffset={navTopOffset} showMenuLink={!isRestaurant} />
        ) : (
          <PublicNavbar tenantName={tenantName} icon={icon} logoUrl={settings.logoUrl} topOffset={navTopOffset} showMenuLink={!isRestaurant} />
        )}
        {settings.heroImageUrl && (
          <section className="relative flex min-h-screen items-center justify-center overflow-hidden bg-black">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={settings.heroImageUrl} alt="" className="absolute inset-0 h-full w-full object-cover" />
            <div className="absolute inset-0 bg-gradient-to-b from-black/65 via-black/30 to-black/70" />
            <div className="relative z-10 mx-auto max-w-4xl px-4 py-24 text-center sm:px-6">
              {settings.heroHeading && (
                <h1 className="text-4xl font-extrabold tracking-tight text-white [text-shadow:0_2px_24px_rgba(0,0,0,0.4)] sm:text-6xl lg:text-7xl">
                  {settings.heroHeading}
                </h1>
              )}
              {settings.heroSubheading && (
                <p className="mx-auto mt-5 max-w-2xl text-lg leading-relaxed text-white/90 [text-shadow:0_1px_12px_rgba(0,0,0,0.3)] sm:text-xl">
                  {settings.heroSubheading}
                </p>
              )}
              {settings.heroCtaText && settings.heroCtaUrl && (
                <div className="mt-9">
                  <a
                    href={settings.heroCtaUrl}
                    className="inline-flex items-center justify-center rounded-xl bg-primary px-8 py-4 text-base font-bold text-primary-foreground shadow-lg shadow-black/30 transition hover:-translate-y-0.5 hover:shadow-xl hover:shadow-black/40 active:translate-y-0 sm:text-lg"
                  >
                    {settings.heroCtaText}
                  </a>
                </div>
              )}
            </div>
          </section>
        )}
        <WebsiteSections
          sections={sections}
          tenantId={tenantId}
          branch={branch}
          currency={currency}
          timezone={timezone}
          isRestaurant={isRestaurant}
        />
        {footer}
      </OrderCartProvider>
    </div>
  )
}
