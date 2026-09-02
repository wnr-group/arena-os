import 'server-only'
import {
  websiteSnapshotSchema,
  websiteSectionSchema,
  websiteBrandingSchema,
  brandingSnapshotFromRow,
  type WebsiteSectionType,
} from './types'

export type PublishStatus = 'unpublished' | 'live' | 'changed'

export type DraftSectionRow = {
  type: WebsiteSectionType
  heading: string | null
  position: number
  content: Record<string, unknown>
}

export type DraftSettingsRow = Parameters<typeof brandingSnapshotFromRow>[0]

/** Recursively sorts object keys so two structurally-identical values compare
 *  equal regardless of insertion order or jsonb round-trip key order. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`
  }
  return value === undefined ? 'null' : JSON.stringify(value)
}

function sectionSignature(sections: { type: unknown; heading: unknown; position: unknown; content: unknown }[]): string {
  return stableStringify(
    [...sections]
      .sort((a, b) => (Number(a.position) || 0) - (Number(b.position) || 0))
      .map((s) => ({ type: s.type, heading: s.heading, content: s.content })),
  )
}

/**
 * Whether the live draft (website_sections/website_settings) differs from
 * what's actually published — compared structurally, not by each row's
 * updated_at. A timestamp heuristic (latest updated_at vs published_at)
 * misses deletes: the deleted row's updated_at disappears along with it, so
 * removing the last-changed (or only) section can leave the badge reading
 * "Live" even though the draft has in fact diverged from what's published.
 */
export function computePublishStatus(
  draftSections: DraftSectionRow[],
  draftSettingsRow: DraftSettingsRow,
  publishedSnapshot: unknown,
): PublishStatus {
  if (!publishedSnapshot) return 'unpublished'
  const shape = websiteSnapshotSchema.safeParse(publishedSnapshot)
  if (!shape.success) return 'unpublished'

  const publishedSections = shape.data.sections
    .map((s) => websiteSectionSchema.safeParse(s))
    .filter((r): r is { success: true; data: ReturnType<typeof websiteSectionSchema.parse> } => r.success)
    .map((r) => r.data)

  if (sectionSignature(draftSections) !== sectionSignature(publishedSections)) return 'changed'

  const draftBranding = brandingSnapshotFromRow(draftSettingsRow)
  const publishedBrandingParsed = websiteBrandingSchema.safeParse(shape.data.settings)
  const publishedBranding = publishedBrandingParsed.success ? publishedBrandingParsed.data : null

  return stableStringify(draftBranding) === stableStringify(publishedBranding) ? 'live' : 'changed'
}
