import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { currentTenantSlug } from '@/lib/tenant/context'
import { getMarketingViewer } from '@/components/marketing/viewer'
import { getPublicTenantBySlug } from '@/lib/tenant/public'
import { getLiveHappyHourBanner } from '@/lib/happy-hours/public'
import { listPublicPlans, type PublicPlan } from '@/lib/platform/plans/public'
import { publicSiteFont } from '@/lib/fonts'
import { TenantHome } from '@/components/public-booking/TenantHome'
import { HappyHourFloatingWidget } from '@/components/public-booking/HappyHourFloatingWidget'
import { MarketingNavbar } from '@/components/marketing/MarketingNavbar'
import { MarketingFooter } from '@/components/marketing/MarketingFooter'
import { Hero } from '@/components/marketing/sections/Hero'
import { IndustriesStrip } from '@/components/marketing/sections/IndustriesStrip'
import { FeatureShowcase } from '@/components/marketing/sections/FeatureShowcase'
import { BentoGrid } from '@/components/marketing/sections/BentoGrid'
import { WhyBand } from '@/components/marketing/sections/WhyBand'
import { HowItWorks } from '@/components/marketing/sections/HowItWorks'
import { PricingSection } from '@/components/marketing/sections/PricingSection'
import { Faq } from '@/components/marketing/sections/Faq'
import { FinalCta } from '@/components/marketing/sections/FinalCta'

const MARKETING_TITLE = 'Arena OS — Booking, POS & operations for venues'
const MARKETING_DESCRIPTION =
  'Run bookings, walk-ins, POS, kitchen, staff and revenue from one platform — built for gaming cafés, studios, VR centres and restaurants in India.'

/**
 * "/" is shared by the platform marketing page and every tenant's homepage, so the
 * marketing metadata applies on the root domain only; a tenant subdomain keeps the
 * app-wide default exactly as before.
 */
export async function generateMetadata(): Promise<Metadata> {
  if (await currentTenantSlug()) return {}
  return {
    title: MARKETING_TITLE,
    description: MARKETING_DESCRIPTION,
    openGraph: { title: MARKETING_TITLE, description: MARKETING_DESCRIPTION, type: 'website' },
  }
}

/**
 * Root route — served on both the platform root domain and every tenant
 * subdomain (Next.js route groups don't change the URL, so there is exactly
 * one "/" for the whole app). On a tenant subdomain this renders that
 * tenant's public homepage (no session required, same as the old /book
 * route); on the root domain it renders the platform marketing page.
 */
export default async function RootPage() {
  const slug = await currentTenantSlug()
  if (slug) {
    const tenant = await getPublicTenantBySlug(slug)
    if (!tenant) notFound()
    const happyHour = await getLiveHappyHourBanner(tenant.id, tenant.timezone)
    return (
      <>
        <TenantHome tenant={tenant} />
        <HappyHourFloatingWidget happyHour={happyHour} currency={tenant.currency} />
      </>
    )
  }

  return <PlatformHome />
}

async function PlatformHome() {

  // Pricing is a display nicety on a marketing page — if the catalogue can't be
  // read, the page must still render (the section falls back to a sign-up prompt).
  let plans: PublicPlan[] = []
  try {
    plans = await listPublicPlans()
  } catch {
    plans = []
  }

  // Who is looking, for the Sign in / Admin panel buttons (real session lookup; degrades to signed out).
  const viewer = await getMarketingViewer()

  return (
    <div className={`marketing-root flex min-h-screen flex-col overflow-x-clip bg-background ${publicSiteFont.className}`}>
      <MarketingNavbar viewer={viewer} />

      <main className="flex-1">
        <Hero />
        <IndustriesStrip />
        <FeatureShowcase />
        <BentoGrid />
        <WhyBand />
        <HowItWorks />
        <PricingSection plans={plans} />
        <Faq />
        <FinalCta viewer={viewer} />
      </main>

      <MarketingFooter viewer={viewer} />
    </div>
  )
}
