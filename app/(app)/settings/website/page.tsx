import { redirect } from 'next/navigation'
import { getActiveContext } from '@/lib/tenant/context'
import { isManager } from '@/lib/auth/roles'
import { listWebsiteSections, getWebsiteSettings, getWebsitePublishedSnapshot } from '@/lib/website/data'
import { computePublishStatus } from '@/lib/website/status'
import { WebsiteEditor } from '@/components/settings/website/WebsiteEditor'

export default async function WebsiteSettingsPage() {
  const ctx = await getActiveContext()
  if (!ctx) return null
  if (!isManager(ctx.role)) redirect('/dashboard')

  const [sections, settings, published] = await Promise.all([
    listWebsiteSections(ctx),
    getWebsiteSettings(ctx),
    getWebsitePublishedSnapshot(ctx),
  ])

  // Compared structurally against the published snapshot, not by
  // timestamp — a deleted section leaves no updated_at behind to compare,
  // so a timestamp-only check can miss it.
  const publishStatus = computePublishStatus(sections, settings, published.publishedSnapshot)

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6 lg:px-8">
      <h1 className="text-2xl font-semibold">Website</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Build your public homepage from ready-made sections — drag to reorder, brand it, preview, then publish.
      </p>
      <WebsiteEditor
        timeZone={ctx.tenant.timezone}
        sections={sections.map((s) => ({ id: s.id, type: s.type, heading: s.heading, content: s.content }))}
        settings={
          settings
            ? {
                logoUrl: settings.logoUrl,
                accentColor: settings.accentColor,
                heroImageUrl: settings.heroImageUrl,
                heroHeading: settings.heroHeading,
                heroSubheading: settings.heroSubheading,
                heroCtaText: settings.heroCtaText,
                heroCtaUrl: settings.heroCtaUrl,
              }
            : null
        }
        publishStatus={publishStatus}
        publishedAt={published.publishedAt ? published.publishedAt.toISOString() : null}
      />
    </div>
  )
}
