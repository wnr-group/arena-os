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

/** Shared by getPublishedWebsite and getPublishedBranding — the one raw read
 *  of website_pages, parsed down to its typed top-level shape (or null when
 *  there's nothing published, or the snapshot doesn't even parse). */
async function getPublishedSnapshot(tenantId: string) {
  const [row] = await withPublicTenant(tenantId, (tx) =>
    tx.select({ publishedSnapshot: websitePages.publishedSnapshot }).from(websitePages).where(eq(websitePages.tenantId, tenantId)).limit(1),
  )
  if (!row?.publishedSnapshot) return null

  const shape = websiteSnapshotSchema.safeParse(row.publishedSnapshot)
  if (!shape.success) {
    console.error(`website_pages: malformed published_snapshot for tenant ${tenantId}`, shape.error)
    return null
  }
  return shape.data
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
  const shape = await getPublishedSnapshot(tenantId)
  if (!shape) return null

  const sections: WebsiteSection[] = []
  for (const raw of shape.sections) {
    const parsed = websiteSectionSchema.safeParse(raw)
    if (parsed.success) {
      sections.push(parsed.data)
    } else {
      console.error(`website_pages: dropping invalid section for tenant ${tenantId}`, parsed.error)
    }
  }
  const brandingParsed = websiteBrandingSchema.safeParse(shape.settings)
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

/**
 * Just the published logo/accent-colour branding — every public page (not
 * only the website-builder homepage) reads this so the tenant's uploaded
 * logo and brand colour show up consistently on booking, menu, resources,
 * and confirmation pages too, not only when a homepage has been built.
 * Draft branding never reaches here — same publish/draft split as sections.
 */
export const getPublishedBranding = cache(async function getPublishedBranding(tenantId: string): Promise<WebsiteBranding> {
  const shape = await getPublishedSnapshot(tenantId)
  if (!shape) return EMPTY_BRANDING

  const brandingParsed = websiteBrandingSchema.safeParse(shape.settings)
  return brandingParsed.success ? brandingParsed.data : EMPTY_BRANDING
})
