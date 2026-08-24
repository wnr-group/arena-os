'use server'

import { revalidatePath } from 'next/cache'
import { and, asc, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { withUser } from '@/db'
import { websiteSections, websiteSettings, websitePages } from '@/db/schema'
import { requireManager, AuthError } from '@/lib/auth/guard'
import { uploadImage } from '@/lib/storage/s3'
import { zodErrorMessage, pgError } from '@/lib/utils/errors'
import {
  websiteSectionTypeSchema,
  sectionContentSchemas,
  websiteSectionSchema,
  websiteBrandingSchema,
  websiteBrandingInputSchema,
} from '@/lib/website/types'

type Result = { error?: string }

function fail(e: unknown): Result {
  if (e instanceof AuthError) return { error: e.message }
  if (e instanceof z.ZodError) return { error: zodErrorMessage(e) }
  const { code } = pgError(e)
  if (code === '23503' || code === '23001') return { error: 'This is still in use elsewhere and cannot be deleted.' }
  console.error('[website] action failed:', e)
  return { error: 'Something went wrong. Please try again.' }
}

function revalidateWebsitePaths() {
  revalidatePath('/settings/website')
  revalidatePath('/settings/website/preview')
}

// ── sections ────────────────────────────────────────────────────────────────
const sectionInput = z.object({
  id: z.string().uuid().optional(),
  type: websiteSectionTypeSchema,
  heading: z
    .string()
    .trim()
    .max(200)
    .nullable()
    .transform((v) => (v === '' ? null : v)),
  content: z.unknown(),
})

export async function upsertWebsiteSection(input: z.input<typeof sectionInput>): Promise<Result> {
  try {
    const ctx = await requireManager()
    const v = sectionInput.parse(input)
    const content = sectionContentSchemas[v.type].parse(v.content)

    await withUser(ctx.user.id, async (tx) => {
      if (v.id) {
        await tx
          .update(websiteSections)
          .set({ type: v.type, heading: v.heading, content })
          .where(and(eq(websiteSections.id, v.id), eq(websiteSections.tenantId, ctx.tenant.id)))
      } else {
        // New sections always go to the end of the list, same reasoning as
        // menu categories (lib/actions/menu.ts): the client has no meaningful
        // position to send for a create.
        const [{ next }] = await tx
          .select({ next: sql<number>`coalesce(max(${websiteSections.position}), -1) + 1` })
          .from(websiteSections)
          .where(eq(websiteSections.tenantId, ctx.tenant.id))
        await tx.insert(websiteSections).values({
          tenantId: ctx.tenant.id,
          type: v.type,
          heading: v.heading,
          content,
          position: next,
        })
      }
    })
    revalidateWebsitePaths()
    return {}
  } catch (e) {
    return fail(e)
  }
}

export async function deleteWebsiteSection(id: string): Promise<Result> {
  try {
    const ctx = await requireManager()
    await withUser(ctx.user.id, (tx) =>
      tx.delete(websiteSections).where(and(eq(websiteSections.id, id), eq(websiteSections.tenantId, ctx.tenant.id))),
    )
    revalidateWebsitePaths()
    return {}
  } catch (e) {
    return fail(e)
  }
}

const reorderInput = z.array(z.string().uuid()).min(1)

/**
 * `orderedIds` is the full section list in its new order — position becomes
 * each id's index. Every update is still scoped to `tenant_id = ctx.tenant.id`,
 * so an id that isn't (or is no longer) this tenant's simply matches no rows;
 * there is no way to reorder — or discover — another tenant's sections.
 */
export async function reorderWebsiteSections(orderedIds: string[]): Promise<Result> {
  try {
    const ctx = await requireManager()
    const ids = reorderInput.parse(orderedIds)
    await withUser(ctx.user.id, (tx) =>
      Promise.all(
        ids.map((id, index) =>
          tx
            .update(websiteSections)
            .set({ position: index })
            .where(and(eq(websiteSections.id, id), eq(websiteSections.tenantId, ctx.tenant.id))),
        ),
      ),
    )
    revalidateWebsitePaths()
    return {}
  } catch (e) {
    return fail(e)
  }
}

// ── branding ────────────────────────────────────────────────────────────────
export async function updateWebsiteBranding(input: z.input<typeof websiteBrandingInputSchema>): Promise<Result> {
  try {
    const ctx = await requireManager()
    const v = websiteBrandingInputSchema.parse(input)
    await withUser(ctx.user.id, (tx) =>
      tx
        .insert(websiteSettings)
        .values({ tenantId: ctx.tenant.id, ...v })
        .onConflictDoUpdate({ target: websiteSettings.tenantId, set: v }),
    )
    revalidateWebsitePaths()
    return {}
  } catch (e) {
    return fail(e)
  }
}

// ── image upload ────────────────────────────────────────────────────────────
/** Shared by section images, logo, and hero image — all land in the same
 *  tenant-scoped folder, same as uploadMenuItemImage (lib/actions/menu.ts). */
export async function uploadWebsiteImage(formData: FormData): Promise<{ url?: string; error?: string }> {
  try {
    const ctx = await requireManager()
    const file = formData.get('file')
    if (!(file instanceof File)) return { error: 'No file provided.' }
    const url = await uploadImage(file, `tenants/${ctx.tenant.id}/website`)
    return { url }
  } catch (e) {
    return fail(e)
  }
}

// ── publish ─────────────────────────────────────────────────────────────────
/**
 * Freezes the current draft (website_sections + website_settings) into one
 * website_pages row — the only thing the public homepage ever reads
 * (lib/website/public.ts). Re-validates every row through the exact schemas
 * the public reader uses: defense in depth, so a row that somehow slipped
 * past upsertWebsiteSection's own validation can still never reach a
 * customer — publishing fails loudly here instead.
 */
export async function publishWebsite(): Promise<Result> {
  try {
    const ctx = await requireManager()
    await withUser(ctx.user.id, async (tx) => {
      const rows = await tx
        .select()
        .from(websiteSections)
        .where(eq(websiteSections.tenantId, ctx.tenant.id))
        .orderBy(asc(websiteSections.position))
      const [settingsRow] = await tx
        .select()
        .from(websiteSettings)
        .where(eq(websiteSettings.tenantId, ctx.tenant.id))
        .limit(1)

      const sections = rows.map((r) =>
        websiteSectionSchema.parse({
          id: r.id,
          type: r.type,
          heading: r.heading,
          position: r.position,
          content: r.content,
        }),
      )
      const settings = websiteBrandingSchema.parse({
        logoUrl: settingsRow?.logoUrl ?? null,
        accentColor: settingsRow?.accentColor ?? null,
        heroImageUrl: settingsRow?.heroImageUrl ?? null,
      })

      const publishedSnapshot = { sections, settings }
      await tx
        .insert(websitePages)
        .values({ tenantId: ctx.tenant.id, publishedSnapshot, publishedAt: new Date() })
        .onConflictDoUpdate({
          target: websitePages.tenantId,
          set: { publishedSnapshot, publishedAt: new Date() },
        })
    })
    revalidateWebsitePaths()
    return {}
  } catch (e) {
    return fail(e)
  }
}
