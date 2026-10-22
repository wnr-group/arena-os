import { notFound } from 'next/navigation'
import { UtensilsCrossed } from 'lucide-react'
import { withPublicTenant } from '@/db'
import { currentTenantSlug } from '@/lib/tenant/context'
import { getPublicTenantBySlug } from '@/lib/tenant/public'
import { getPublicBranch } from '@/lib/booking/public-availability'
import { publicMaxAdvanceDaysOrDefault } from '@/lib/booking/settings-server'
import { todayInZone } from '@/lib/booking/time'
import { getPublishedBranding } from '@/lib/website/public'
import { accentColorStyle } from '@/lib/website/color'
import { getReservationSettingsCore } from '@/lib/reservations/settings'
import { SitePageShell } from '@/components/public-booking/SitePageShell'
import { PublicFooter } from '@/components/public-booking/PublicFooter'
import { ReserveTableClient } from '@/components/public-booking/ReserveTableClient'

/**
 * "Book a table" — the storefront's restaurant reservation page (M20). 404s for
 * any other industry, and for a restaurant that hasn't opened reservations to
 * the public (the setting is re-checked by the action as well).
 */
export default async function ReserveTablePage() {
  const slug = await currentTenantSlug()
  if (!slug) notFound()
  const tenant = await getPublicTenantBySlug(slug)
  if (!tenant || tenant.industry !== 'restaurant') notFound()

  const settings = await withPublicTenant(tenant.id, (tx) => getReservationSettingsCore(tx, tenant.id))
  if (!settings.enabled || !settings.publicEnabled) notFound()

  const [branch, branding, maxDays] = await Promise.all([
    getPublicBranch(tenant.id),
    getPublishedBranding(tenant.id),
    publicMaxAdvanceDaysOrDefault(tenant.id),
  ])

  return (
    <div className="flex min-h-screen flex-col" style={accentColorStyle(branding.accentColor)}>
      <SitePageShell tenantName={tenant.name} icon={<UtensilsCrossed size={18} />} logoUrl={branding.logoUrl} hasMenu={false}>
        <main className="flex-1 bg-gradient-to-b from-accent/60 via-background to-background">
          <ReserveTableClient
            tenantName={tenant.name}
            timezone={tenant.timezone}
            today={todayInZone(tenant.timezone)}
            maxAdvanceDays={maxDays}
            maxPartySize={settings.maxPartySize}
            phone={branch?.phone ?? null}
          />
        </main>
        <PublicFooter
          tenantName={tenant.name}
          industryLabel="Restaurant"
          icon={UtensilsCrossed}
          address={branch?.address ?? null}
          phone={branch?.phone ?? null}
        />
      </SitePageShell>
    </div>
  )
}
