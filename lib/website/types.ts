import { z } from 'zod'
import { extractYoutubeVideoId } from './youtube'

/**
 * Shape of a published website — read-only contract for the public homepage
 * (TenantHome). The draft-side editor (AROS-C/D) will reuse these schemas for
 * validating writes to website_sections/website_settings.
 */

const youtubeUrlSchema = z
  .string()
  .url()
  .refine((url) => extractYoutubeVideoId(url) !== null, 'must be a youtube.com or youtu.be video URL')

export const textContentSchema = z.object({
  body: z.string(),
})

export const imageContentSchema = z.object({
  imageUrl: z.string().url(),
  alt: z.string().optional(),
  /** Visible text under the image — distinct from `alt`, which is screen-reader only. */
  caption: z.string().optional(),
})

export const imageTextContentSchema = z.object({
  imageUrl: z.string().url(),
  alt: z.string().optional(),
  body: z.string(),
  style: z.enum(['overlay', 'stacked']),
})

export const videoContentSchema = z.object({
  youtubeUrl: youtubeUrlSchema,
})

export const videoTextContentSchema = z.object({
  youtubeUrl: youtubeUrlSchema,
  body: z.string(),
})

/** "Show up to N" — shared by the two catalogue-backed sections below. */
const dynamicLimitSchema = z.object({ limit: z.number().int().min(1).max(12) })
export const resourcesContentSchema = dynamicLimitSchema
export const menuContentSchema = dynamicLimitSchema

/** No editor-owned fields — these render entirely from the branch record
 *  (working hours / address) resolved at render time. */
export const hoursContentSchema = z.object({})
export const mapContentSchema = z.object({})

export const websiteSectionTypeSchema = z.enum([
  'text',
  'image',
  'image_text',
  'video',
  'video_text',
  'resources',
  'menu',
  'hours',
  'map',
])
export type WebsiteSectionType = z.infer<typeof websiteSectionTypeSchema>

/** Content schema for a given section type — the draft-side write path picks
 *  the right one dynamically rather than building a full discriminated union
 *  for input (the type is already known before content is parsed). */
export const sectionContentSchemas = {
  text: textContentSchema,
  image: imageContentSchema,
  image_text: imageTextContentSchema,
  video: videoContentSchema,
  video_text: videoTextContentSchema,
  resources: resourcesContentSchema,
  menu: menuContentSchema,
  hours: hoursContentSchema,
  map: mapContentSchema,
} satisfies Record<WebsiteSectionType, z.ZodTypeAny>

export const websiteSectionSchema = z.discriminatedUnion('type', [
  z.object({ id: z.string(), type: z.literal('text'), heading: z.string().nullable(), position: z.number(), content: textContentSchema }),
  z.object({ id: z.string(), type: z.literal('image'), heading: z.string().nullable(), position: z.number(), content: imageContentSchema }),
  z.object({ id: z.string(), type: z.literal('image_text'), heading: z.string().nullable(), position: z.number(), content: imageTextContentSchema }),
  z.object({ id: z.string(), type: z.literal('video'), heading: z.string().nullable(), position: z.number(), content: videoContentSchema }),
  z.object({ id: z.string(), type: z.literal('video_text'), heading: z.string().nullable(), position: z.number(), content: videoTextContentSchema }),
  z.object({ id: z.string(), type: z.literal('resources'), heading: z.string().nullable(), position: z.number(), content: resourcesContentSchema }),
  z.object({ id: z.string(), type: z.literal('menu'), heading: z.string().nullable(), position: z.number(), content: menuContentSchema }),
  z.object({ id: z.string(), type: z.literal('hours'), heading: z.string().nullable(), position: z.number(), content: hoursContentSchema }),
  z.object({ id: z.string(), type: z.literal('map'), heading: z.string().nullable(), position: z.number(), content: mapContentSchema }),
])

export type WebsiteSection = z.infer<typeof websiteSectionSchema>

export const websiteBrandingSchema = z.object({
  logoUrl: z.string().url().nullable(),
  accentColor: z.string().nullable(),
  heroImageUrl: z.string().url().nullable(),
})

export type WebsiteBranding = z.infer<typeof websiteBrandingSchema>

/** Branding form input — accentColor is constrained to a plain hex value here
 *  (the published/stored schema above stays looser in case that ever needs
 *  to accept a CSS color keyword read from an older row). */
export const websiteBrandingInputSchema = z.object({
  logoUrl: z.string().url().nullable(),
  accentColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Must be a hex colour like #7c3aed')
    .nullable(),
  heroImageUrl: z.string().url().nullable(),
})

export const websiteSnapshotSchema = z.object({
  sections: z.array(z.unknown()),
  settings: z.unknown(),
})
