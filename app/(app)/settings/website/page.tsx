import { redirect } from 'next/navigation'
import { getActiveContext } from '@/lib/tenant/context'
import { isManager } from '@/lib/auth/roles'
import { listWebsiteSections, getWebsiteSettings, getWebsitePublishedAt } from '@/lib/website/data'
import { WebsiteEditor } from '@/components/settings/website/WebsiteEditor'

export default async function WebsiteSettingsPage() {
  const ctx = await getActiveContext()
  if (!ctx) return null
  if (!isManager(ctx.role)) redirect('/dashboard')

  const [sections, settings, publishedAt] = await Promise.all([
    listWebsiteSections(ctx),
    getWebsiteSettings(ctx),
    getWebsitePublishedAt(ctx),
  ])

  // "Live" vs "unpublished changes": whether any draft row has moved since
  // the last publish. Deleting every section without adding anything else
  // won't flip this — a rare enough edge case not worth tracking separately;
  // Publish always operates on the true current draft regardless.
  const latestDraftChange = Math.max(
    0,
    ...sections.map((s) => s.updatedAt.getTime()),
    settings ? settings.updatedAt.getTime() : 0,
  )
  const publishStatus = !publishedAt ? 'unpublished' : latestDraftChange > publishedAt.getTime() ? 'changed' : 'live'

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6 lg:px-8">
      <h1 className="text-2xl font-semibold">Website</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Build your public homepage from ready-made sections — drag to reorder, brand it, preview, then publish.
      </p>
      <WebsiteEditor
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
        publishedAt={publishedAt ? publishedAt.toISOString() : null}
      />
    </div>
  )
}
