import 'server-only'
import { cache } from 'react'
import { eq } from 'drizzle-orm'
import { withPublicTenant } from '@/db'
import { websitePages } from '@/db/schema'
import {
  websiteSectionSchema,
  websiteSnapshotSchema,
  websiteBrandingSchema,
  type WebsiteSection,
  type WebsiteBranding,
} from './types'

const EMPTY_BRANDING: WebsiteBranding = {
  logoUrl: null,
  accentColor: null,
  heroImageUrl: null,
  heroHeading: null,
  heroSubheading: null,
  heroCtaText: null,
  heroCtaUrl: null,
}

export type PublishedWebsite = {
  sections: WebsiteSection[]
  settings: WebsiteBranding
}

/**
 * The public homepage's only read of the website builder's data. Returns
 * null whenever there is nothing safe to render — no row, no snapshot yet,
 * or a snapshot that doesn't even have the right top-level shape — which
 * tells TenantHome to fall back to the default homepage. Any individual
 * section that fails validation (corrupt data, a type this build doesn't
 * know about) is silently dropped rather than failing the whole page.
 */
export const getPublishedWebsite = cache(async function getPublishedWebsite(
  tenantId: string,
): Promise<PublishedWebsite | null> {
  const [row] = await withPublicTenant(tenantId, (tx) =>
    tx.select({ publishedSnapshot: websitePages.publishedSnapshot }).from(websitePages).where(eq(websitePages.tenantId, tenantId)).limit(1),
  )
  if (!row?.publishedSnapshot) return null

  const shape = websiteSnapshotSchema.safeParse(row.publishedSnapshot)
  if (!shape.success) {
    console.error(`website_pages: malformed published_snapshot for tenant ${tenantId}`, shape.error)
    return null
  }

  const sections: WebsiteSection[] = []
  for (const raw of shape.data.sections) {
    const parsed = websiteSectionSchema.safeParse(raw)
    if (parsed.success) {
      sections.push(parsed.data)
    } else {
      console.error(`website_pages: dropping invalid section for tenant ${tenantId}`, parsed.error)
    }
  }
  const brandingParsed = websiteBrandingSchema.safeParse(shape.data.settings)
  if (!brandingParsed.success) {
    console.error(`website_pages: malformed settings for tenant ${tenantId}`, brandingParsed.error)
  }
  const settings = brandingParsed.success ? brandingParsed.data : EMPTY_BRANDING

  // A tenant with a configured hero image but zero sections still has a real
  // homepage to show (the hero itself) — only fall back to the default
  // homepage when there is truly nothing published.
  if (sections.length === 0 && !settings.heroImageUrl) return null

  return {
    sections: sections.sort((a, b) => a.position - b.position),
    settings,
  }
})
