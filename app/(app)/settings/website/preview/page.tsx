import { redirect } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { getActiveContext } from '@/lib/tenant/context'
import { isManager } from '@/lib/auth/roles'
import { getPublicBranch } from '@/lib/booking/public-availability'
import { listWebsiteSections, getWebsiteSettings } from '@/lib/website/data'
import { websiteSectionSchema, websiteBrandingSchema, type WebsiteSection, type WebsiteBranding } from '@/lib/website/types'
import { WebsitePage } from '@/components/public-booking/website/WebsitePage'
import { INDUSTRY_ICONS } from '@/components/public-booking/TenantHome'

const EMPTY_BRANDING: WebsiteBranding = {
  logoUrl: null,
  accentColor: null,
  heroImageUrl: null,
  heroHeading: null,
  heroSubheading: null,
  heroCtaText: null,
  heroCtaUrl: null,
}

// Fixed so the sticky navbar below can stick at exactly this many pixels —
// keep in sync with the h-11 on the banner below.
const PREVIEW_BANNER_HEIGHT = 44

/**
 * Staff-only preview — renders the current DRAFT through the exact same
 * WebsitePage/WebsiteSections components the public homepage uses
 * (lib/website/public.ts's getPublishedWebsite reads the published snapshot;
 * this reads the live draft rows instead), so what's shown here is
 * structurally what Publish will make live, not a separate reimplementation.
 */
export default async function WebsitePreviewPage() {
  const ctx = await getActiveContext()
  if (!ctx) return null
  if (!isManager(ctx.role)) redirect('/dashboard')

  const [rows, settingsRow, branch] = await Promise.all([
    listWebsiteSections(ctx),
    getWebsiteSettings(ctx),
    getPublicBranch(ctx.tenant.id),
  ])

  const sections: WebsiteSection[] = []
  for (const r of rows) {
    const parsed = websiteSectionSchema.safeParse({
      id: r.id,
      type: r.type,
      heading: r.heading,
      position: r.position,
      content: r.content,
    })
    if (parsed.success) sections.push(parsed.data)
  }

  const brandingParsed = websiteBrandingSchema.safeParse(
    settingsRow
      ? {
          logoUrl: settingsRow.logoUrl,
          accentColor: settingsRow.accentColor,
          heroImageUrl: settingsRow.heroImageUrl,
          heroHeading: settingsRow.heroHeading,
          heroSubheading: settingsRow.heroSubheading,
          heroCtaText: settingsRow.heroCtaText,
          heroCtaUrl: settingsRow.heroCtaUrl,
        }
      : EMPTY_BRANDING,
  )
  const settings = brandingParsed.success ? brandingParsed.data : EMPTY_BRANDING

  const Icon = INDUSTRY_ICONS[ctx.tenant.industry] ?? INDUSTRY_ICONS.other

  return (
    <div>
      <div className="sticky top-0 z-50 flex h-11 items-center justify-center gap-3 border-b border-amber-500/40 bg-amber-500/10 px-4 text-center text-sm font-medium text-amber-700">
        <span>Preview — this is not live yet.</span>
        <Link href="/settings/website" className="inline-flex items-center gap-1 underline underline-offset-2 hover:text-amber-800">
          <ArrowLeft size={14} /> Back to editor
        </Link>
      </div>
      {sections.length === 0 && !settings.heroImageUrl ? (
        <div className="px-4 py-20 text-center text-muted-foreground">No sections yet — add some in the editor to see a preview.</div>
      ) : (
        <WebsitePage
          tenantName={ctx.tenant.name}
          icon={<Icon size={18} />}
          sections={sections}
          settings={settings}
          navTopOffset={PREVIEW_BANNER_HEIGHT}
          tenantId={ctx.tenant.id}
          branch={branch}
          currency={ctx.tenant.currency}
          timezone={ctx.tenant.timezone}
        />
      )}
    </div>
  )
}
