import { notFound } from 'next/navigation'
import { Building2, Gamepad2, Glasses, Music4, Mic2, Radio, type LucideIcon } from 'lucide-react'
import { currentTenantSlug } from '@/lib/tenant/context'
import { getPublicTenantBySlug } from '@/lib/tenant/public'
import { getPublicBranch } from '@/lib/booking/public-availability'
import { getPublicBookingByToken } from '@/lib/booking/public-confirmation'
import { publicTenantUrl } from '@/lib/tenant/subdomain'
import { generateQrSvg } from '@/lib/utils/qr'
import { getPublicMenu } from '@/lib/menu/public'
import { getPublishedBranding } from '@/lib/website/public'
import { accentColorStyle } from '@/lib/website/color'
import { SitePageShell } from '@/components/public-booking/SitePageShell'
import { PublicFooter } from '@/components/public-booking/PublicFooter'
import { BookingConfirmation } from '@/components/public-booking/BookingConfirmation'

/** Matches a UUID, so a junk token 404s instead of erroring in the query. */
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
 * The public, no-login booking confirmation page — where a customer lands
 * right after booking (and would land again from an SMS link later). Keyed
 * by confirmation_token, NOT bookingNumber: see
 * 0026_booking_confirmation_token.sql for why the sequential number can
 * never be this page's URL. Also the page staff scan the QR code to reach
 * for check-in, though the scan itself posts to a staff-only action
 * (checkInBookingByToken) rather than this page doing anything on load.
 */
export default async function BookingConfirmationPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  if (!UUID.test(token)) notFound()

  const slug = await currentTenantSlug()
  if (!slug) notFound()
  const tenant = await getPublicTenantBySlug(slug)
  if (!tenant) notFound()

  const booking = await getPublicBookingByToken(tenant.id, token)
  if (!booking) notFound()

  const branch = await getPublicBranch(tenant.id)
  const confirmationUrl = publicTenantUrl(tenant.slug, `/b/${token}`)
  const qrSvg = await generateQrSvg(confirmationUrl)
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
          <BookingConfirmation booking={booking} tenant={tenant} qrSvg={qrSvg} hasMenu={hasMenu} />
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
