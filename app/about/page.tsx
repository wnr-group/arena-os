import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { currentTenantSlug } from '@/lib/tenant/context'
import { MarketingShell } from '@/components/marketing/MarketingShell'
import { PageHero } from '@/components/marketing/sections/PageHero'
import {
  BehindSection,
  StorySection,
  ValuesSection,
  VisionMissionSection,
} from '@/components/marketing/sections/AboutSections'

const TITLE = 'About — Arena OS'
const DESCRIPTION =
  'Arena OS is one platform for bookings, walk-ins, POS, kitchen and reports — built for gaming cafés, studios, VR centres and restaurants in India.'

/** Same rule as the homepage: tenant subdomains keep the app-wide default metadata. */
export async function generateMetadata(): Promise<Metadata> {
  if (await currentTenantSlug()) return {}
  return { title: TITLE, description: DESCRIPTION, openGraph: { title: TITLE, description: DESCRIPTION, type: 'website' } }
}

/**
 * Platform "About" page — root domain only. A tenant subdomain has its own public site, so About on a venue's
 * address would be a platform page under a venue's name; it 404s there, exactly like /signup.
 */
export default async function AboutPage() {
  if (await currentTenantSlug()) notFound()

  return (
    <MarketingShell>
      <PageHero
        eyebrow="About Arena OS"
        title={
          <>
            Built for the venues that <span className="mk-gradient-text">keep the lights on.</span>
          </>
        }
        subtitle="Arena OS brings bookings, walk-ins, billing, food and reporting together, so running a venue feels lighter."
      />
      <StorySection />
      <VisionMissionSection />
      <ValuesSection />
      <BehindSection />
    </MarketingShell>
  )
}
