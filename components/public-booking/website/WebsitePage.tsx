import type { ReactNode } from 'react'
import type { WebsiteSection, WebsiteBranding } from '@/lib/website/types'
import type { PublicBranch } from '@/lib/booking/public-availability'
import { getContrastText } from '@/lib/website/color'
import { PublicNavbar } from '@/components/public-booking/PublicNavbar'
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
}) {
  return (
    <div
      className="flex min-h-screen flex-col"
      style={
        settings.accentColor
          ? ({
              '--primary': settings.accentColor,
              '--primary-foreground': getContrastText(settings.accentColor),
            } as React.CSSProperties)
          : undefined
      }
    >
      <PublicNavbar tenantName={tenantName} icon={icon} logoUrl={settings.logoUrl} topOffset={navTopOffset} />
      {settings.heroImageUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={settings.heroImageUrl} alt="" className="h-64 w-full object-cover sm:h-80" />
      )}
      <WebsiteSections sections={sections} tenantId={tenantId} branch={branch} currency={currency} />
      {footer}
    </div>
  )
}
